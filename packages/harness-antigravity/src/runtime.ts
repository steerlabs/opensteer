import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { once } from "node:events";
import { setFileMode } from "@opensteer/shared/privateFiles";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createGunzip } from "node:zlib";
import { z } from "zod";
import {
  antigravityPlatform,
  antigravityReleaseManifest,
  antigravityUnavailableReason,
  type AntigravityPlatform,
  type AntigravityReleaseAsset,
} from "./release.js";

const completeMarkerName = ".opensteer-antigravity-release.json";
const CompleteMarkerSchema = z.strictObject({
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  protocolVersion: z.union([z.literal(1), z.literal(2)]),
  version: z.string().min(1),
});

export interface PreparedAntigravityRuntime {
  readonly directory: string;
  readonly executable: string;
  readonly protocolVersion: 1 | 2;
  readonly version: string;
}

export interface AntigravityRuntimeIdentity {
  readonly protocolVersion: 1 | 2;
}

export interface PrepareAntigravityRuntimeOptions {
  readonly cacheDirectory: string;
  readonly fetch?: typeof fetch;
  readonly platform?: AntigravityPlatform;
  readonly signal: AbortSignal;
  /** The ACP initialize check that must pass before immutable publication. */
  readonly validate: (
    runtime: Omit<PreparedAntigravityRuntime, "protocolVersion">,
    signal: AbortSignal,
  ) => Promise<AntigravityRuntimeIdentity>;
}

export interface PrepareAntigravityRuntimeReleaseOptions extends PrepareAntigravityRuntimeOptions {
  readonly asset: AntigravityReleaseAsset;
  readonly version: string;
}

function releasePaths(
  directory: string,
  version: string,
): Omit<PreparedAntigravityRuntime, "protocolVersion"> {
  return {
    directory,
    executable: join(directory, "antigravity"),
    version,
  };
}

async function assertReleaseDirectory(
  directory: string,
  asset: AntigravityReleaseAsset,
  version: string,
): Promise<PreparedAntigravityRuntime> {
  const marker = CompleteMarkerSchema.parse(
    JSON.parse(await readFile(join(directory, completeMarkerName), "utf8")),
  );
  if (marker.archiveSha256 !== asset.archive.sha256 || marker.version !== version) {
    throw new Error("The cached Antigravity runtime does not match its release record");
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const expectedNames = new Set([
    completeMarkerName,
    ...asset.members.map((member) => member.name),
  ]);
  if (
    entries.length !== expectedNames.size ||
    entries.some((entry) => !expectedNames.has(entry.name))
  ) {
    throw new Error("The cached Antigravity runtime has unexpected members");
  }
  for (const member of asset.members) {
    const details = await lstat(join(directory, member.name));
    if (!details.isFile() || details.isSymbolicLink() || details.size !== member.sizeBytes) {
      throw new Error(`The cached Antigravity member ${member.name} is invalid`);
    }
  }
  return { ...releasePaths(directory, version), protocolVersion: marker.protocolVersion };
}

async function downloadArchive(
  asset: AntigravityReleaseAsset,
  destination: string,
  request: typeof fetch,
  signal: AbortSignal,
): Promise<void> {
  const response = await request(asset.archive.url, {
    headers: { "accept-encoding": "identity" },
    redirect: "error",
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Antigravity download failed with HTTP ${response.status}`);
  }
  const statedLength = response.headers.get("content-length");
  if (statedLength !== null && Number(statedLength) !== asset.archive.sizeBytes) {
    throw new Error("The Antigravity download size did not match the pinned release");
  }
  const sha256 = createHash("sha256");
  const sha512 = asset.archive.sha512 ? createHash("sha512") : undefined;
  const file = await open(destination, "wx", 0o600);
  let sizeBytes = 0;
  try {
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      const bytes = Buffer.from(chunk);
      sizeBytes += bytes.byteLength;
      if (sizeBytes > asset.archive.sizeBytes) {
        throw new Error("The Antigravity download exceeded the pinned release size");
      }
      sha256.update(bytes);
      sha512?.update(bytes);
      await file.write(bytes);
    }
  } finally {
    await file.close();
  }
  if (
    sizeBytes !== asset.archive.sizeBytes ||
    sha256.digest("hex") !== asset.archive.sha256 ||
    (asset.archive.sha512 && sha512?.digest("hex") !== asset.archive.sha512)
  ) {
    throw new Error("The Antigravity download failed its size or SHA-256 check");
  }
}

const tarBlockSize = 512;

function isZeroBlock(block: Buffer): boolean {
  for (let index = 0; index < block.byteLength; index += 1) {
    if (block[index] !== 0) return false;
  }
  return true;
}

function parseTarString(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const terminator = slice.indexOf(0);
  return slice.subarray(0, terminator >= 0 ? terminator : length).toString("utf8");
}

function parseTarOctal(block: Buffer, start: number, length: number): number {
  const raw = parseTarString(block, start, length).trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/u.test(raw)) {
    throw new Error("The Antigravity archive contains an invalid tar header");
  }
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("The Antigravity archive contains an invalid tar header");
  }
  return value;
}

function verifyTarChecksum(header: Buffer): void {
  const expected = parseTarOctal(header, 148, 8);
  let actual = 0;
  for (let index = 0; index < tarBlockSize; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index]!;
  }
  if (actual !== expected) {
    throw new Error("The Antigravity archive contains a corrupt tar header");
  }
}

function normalizeTarMemberName(header: Buffer): string {
  const name = parseTarString(header, 0, 100);
  const prefix = parseTarString(header, 345, 155);
  const combined = prefix ? `${prefix}/${name}` : name;
  return combined.startsWith("./") ? combined.slice(2) : combined;
}

const unsupportedPaxKeys = new Set(["linkpath", "path", "size"]);
const maxPaxRecordBytes = 64 * 1_024;

function assertSafePaxRecord(payload: Buffer): void {
  const text = payload.toString("utf8");
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space < 0) throw new Error("The Antigravity archive contains an invalid PAX header");
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isSafeInteger(length) || length <= space - offset + 1) {
      throw new Error("The Antigravity archive contains an invalid PAX header");
    }
    const end = offset + length;
    if (end > text.length) {
      throw new Error("The Antigravity archive contains an invalid PAX header");
    }
    const record = text.slice(space + 1, end).replace(/\n$/u, "");
    const equals = record.indexOf("=");
    if (equals > 0 && unsupportedPaxKeys.has(record.slice(0, equals))) {
      throw new Error("The Antigravity archive contains unsupported PAX overrides");
    }
    offset = end;
  }
}

/**
 * Streams the verified `.tar.gz` archive into `directory`, writing only the
 * manifest's regular file members. Built purely on Node's `node:zlib`, so the
 * Runner bundle carries no external archive binary or native unzipper.
 */
async function extractReleaseMembers(
  archive: string,
  directory: string,
  asset: AntigravityReleaseAsset,
  signal: AbortSignal,
): Promise<void> {
  const expected = new Map<string, number>(
    asset.members.map((member) => [member.name, member.sizeBytes]),
  );
  const seen = new Set<string>();
  const outputs: WriteStream[] = [];
  let activeOutput: WriteStream | undefined;
  let remainingFileBytes = 0;
  let remainingPaddingBytes = 0;
  let remainingPaxBytes = 0;
  let paxChunks: Buffer[] = [];
  let pending = Buffer.alloc(0);
  let eofZeroBlocks = 0;
  let writeError: Error | undefined;

  const input = createReadStream(archive, { signal });
  const gunzip = createGunzip();
  input.on("error", (error) => {
    gunzip.destroy(error);
  });
  input.pipe(gunzip);

  const consumeChunk = async (chunk: Buffer): Promise<void> => {
    signal.throwIfAborted();
    if (writeError) throw writeError;
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (remainingPaxBytes > 0) {
        const take = Math.min(remainingPaxBytes, chunk.byteLength - offset);
        paxChunks.push(Buffer.from(chunk.subarray(offset, offset + take)));
        remainingPaxBytes -= take;
        offset += take;
        if (remainingPaxBytes === 0) {
          assertSafePaxRecord(Buffer.concat(paxChunks));
          paxChunks = [];
        }
        continue;
      }
      if (remainingFileBytes > 0) {
        const take = Math.min(remainingFileBytes, chunk.byteLength - offset);
        const slice = chunk.subarray(offset, offset + take);
        offset += take;
        remainingFileBytes -= take;
        if (activeOutput) {
          const ok = activeOutput.write(slice);
          if (!ok) await once(activeOutput, "drain");
          if (writeError) throw writeError;
          if (remainingFileBytes === 0) {
            activeOutput.end();
            activeOutput = undefined;
          }
        }
        continue;
      }
      if (remainingPaddingBytes > 0) {
        const drop = Math.min(remainingPaddingBytes, chunk.byteLength - offset);
        remainingPaddingBytes -= drop;
        offset += drop;
        continue;
      }
      const need = tarBlockSize - pending.byteLength;
      const take = Math.min(need, chunk.byteLength - offset);
      const next = chunk.subarray(offset, offset + take);
      offset += take;
      pending = pending.byteLength === 0 ? Buffer.from(next) : Buffer.concat([pending, next]);
      if (pending.byteLength < tarBlockSize) break;
      const header = pending;
      pending = Buffer.alloc(0);
      if (isZeroBlock(header)) {
        eofZeroBlocks += 1;
        continue;
      }
      if (eofZeroBlocks > 0) {
        throw new Error("The Antigravity archive contains unexpected trailing data");
      }
      verifyTarChecksum(header);
      const typeFlag = header[156]!;
      const size = parseTarOctal(header, 124, 12);
      const paddedSize = Math.ceil(size / tarBlockSize) * tarBlockSize;
      // Validate PAX extended header records (macOS bsdtar/Go archives can emit `x`/`g`)
      // and reject any path/linkpath/size override.
      if (typeFlag === 0x78 || typeFlag === 0x67) {
        if (size > maxPaxRecordBytes) {
          throw new Error("The Antigravity archive contains an oversized PAX header");
        }
        remainingPaxBytes = size;
        remainingPaddingBytes = paddedSize - size;
        paxChunks = [];
        continue;
      }
      // Accept only regular files (`0` or `\0`).
      if (typeFlag !== 0x30 && typeFlag !== 0x00) {
        throw new Error("The Antigravity archive contains unexpected members");
      }
      const name = normalizeTarMemberName(header);
      const expectedSize = expected.get(name);
      if (expectedSize === undefined || seen.has(name)) {
        throw new Error("The Antigravity archive contains unexpected members");
      }
      if (size !== expectedSize) {
        throw new Error(`The Antigravity archive member ${name} is invalid`);
      }
      seen.add(name);
      const output = createWriteStream(join(directory, name), { flags: "wx", mode: 0o700 });
      output.on("error", (error) => {
        writeError ??= error;
      });
      outputs.push(output);
      if (size === 0) {
        output.end();
      } else {
        activeOutput = output;
        remainingFileBytes = size;
        remainingPaddingBytes = paddedSize - size;
      }
    }
  };

  try {
    for await (const raw of gunzip) {
      await consumeChunk(raw as Buffer);
    }
    if (
      pending.byteLength > 0 ||
      remainingFileBytes > 0 ||
      remainingPaddingBytes > 0 ||
      remainingPaxBytes > 0 ||
      eofZeroBlocks < 2
    ) {
      throw new Error("The Antigravity archive ended unexpectedly");
    }
    await Promise.all(
      outputs.map((output) =>
        output.writableFinished || output.destroyed ? undefined : once(output, "finish"),
      ),
    );
    if (writeError) throw writeError;
  } catch (error) {
    input.destroy();
    gunzip.destroy();
    await Promise.all(
      outputs.map(
        (output) =>
          new Promise<void>((resolveClose) => {
            if (output.closed) return resolveClose();
            output.once("close", resolveClose);
            output.destroy();
          }),
      ),
    );
    throw error;
  }
}

async function inspectExtractedRelease(
  directory: string,
  asset: AntigravityReleaseAsset,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (
    entries.length !== asset.members.length ||
    entries.some((entry) => !asset.members.some((member) => member.name === entry.name))
  ) {
    throw new Error("The Antigravity archive contains unexpected members");
  }
  for (const member of asset.members) {
    const details = await lstat(join(directory, member.name));
    if (!details.isFile() || details.isSymbolicLink() || details.size !== member.sizeBytes) {
      throw new Error(`The Antigravity archive member ${member.name} is invalid`);
    }
    // Read + execute only: prevents the CLI's built-in updater from replacing our pinned binary.
    await setFileMode(join(directory, member.name), 0o555);
  }
}

/** Downloads, verifies, validates, and atomically publishes Google's pinned runtime. */
export async function prepareAntigravityRuntime(
  options: PrepareAntigravityRuntimeOptions,
): Promise<PreparedAntigravityRuntime> {
  const platform = options.platform ?? antigravityPlatform();
  if (!platform) throw new Error(antigravityUnavailableReason());
  const asset = antigravityReleaseManifest.platforms[platform];
  return prepareAntigravityRuntimeRelease({
    ...options,
    asset,
    version: antigravityReleaseManifest.version,
  });
}

/** The release-parametric core is exported for small, deterministic archive tests. */
export async function prepareAntigravityRuntimeRelease(
  options: PrepareAntigravityRuntimeReleaseOptions,
): Promise<PreparedAntigravityRuntime> {
  const { asset } = options;
  const parent = resolve(options.cacheDirectory, "antigravity");
  const destination = join(parent, asset.archive.sha256);
  try {
    return await assertReleaseDirectory(destination, asset, options.version);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  options.signal.throwIfAborted();
  await mkdir(parent, { mode: 0o700, recursive: true });
  const staging = await mkdtemp(join(parent, `.install-${asset.archive.sha256.slice(0, 12)}-`));
  const archive = join(staging, "release.tar.gz");
  const extracted = join(staging, "runtime");
  try {
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(45 * 60_000)]);
    await downloadArchive(asset, archive, options.fetch ?? fetch, signal);
    await mkdir(extracted, { mode: 0o700 });
    await extractReleaseMembers(archive, extracted, asset, signal);
    await inspectExtractedRelease(extracted, asset);
    const runtime = releasePaths(extracted, options.version);
    const identity = await options.validate(runtime, signal);
    await writeFile(
      join(extracted, completeMarkerName),
      `${JSON.stringify({
        archiveSha256: asset.archive.sha256,
        protocolVersion: identity.protocolVersion,
        version: options.version,
      })}\n`,
      { flag: "wx", mode: 0o400 },
    );
    try {
      await rename(extracted, destination);
    } catch (error) {
      if (
        !(["EEXIST", "ENOTEMPTY"] as const).includes(
          (error as NodeJS.ErrnoException).code as "EEXIST" | "ENOTEMPTY",
        )
      ) {
        throw error;
      }
      return assertReleaseDirectory(destination, asset, options.version);
    }
    // Lock the published directory read-only after moving it into place (macOS requires write
    // permission on a directory while `rename` updates its `..` entry) so the Go CLI cannot
    // replace its binary in place.
    await setFileMode(destination, 0o500);
    return assertReleaseDirectory(destination, asset, options.version);
  } finally {
    await setFileMode(extracted, 0o700).catch(() => undefined);
    await rm(staging, { force: true, recursive: true });
  }
}
