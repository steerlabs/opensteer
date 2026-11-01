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
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import { z } from "zod";
import {
  antigravityPlatform,
  antigravityReleaseManifest,
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
  readonly harness: string;
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
    executable: join(directory, "agy_acp_server.par"),
    harness: join(directory, "localharness_external"),
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
  const hash = createHash("sha256");
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
      hash.update(bytes);
      await file.write(bytes);
    }
  } finally {
    await file.close();
  }
  if (sizeBytes !== asset.archive.sizeBytes || hash.digest("hex") !== asset.archive.sha256) {
    throw new Error("The Antigravity download failed its size or SHA-256 check");
  }
}

/**
 * Streams the verified archive into `directory`, writing only the manifest's
 * members. Pure JavaScript, so the Runner bundle carries no native unzipper.
 */
async function extractReleaseMembers(
  archive: string,
  directory: string,
  asset: AntigravityReleaseAsset,
  signal: AbortSignal,
): Promise<void> {
  const expected = new Set<string>(asset.members.map((member) => member.name));
  const outputs: WriteStream[] = [];
  let failure: Error | undefined;
  const unzip = new Unzip((file) => {
    if (!expected.has(file.name)) {
      failure ??= new Error("The Antigravity archive contains unexpected members");
      return;
    }
    const output = createWriteStream(join(directory, file.name), { flags: "wx", mode: 0o700 });
    output.on("error", (error) => {
      failure ??= error;
    });
    outputs.push(output);
    file.ondata = (error, chunk, final) => {
      if (error) {
        failure ??= error;
        output.destroy();
        return;
      }
      output.write(chunk);
      if (final) output.end();
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  for await (const chunk of createReadStream(archive, { signal })) {
    unzip.push(chunk as Uint8Array);
    if (failure) throw failure;
    // Inflating is synchronous; let the disk catch up before reading more.
    for (const output of outputs) if (output.writableNeedDrain) await once(output, "drain");
  }
  unzip.push(new Uint8Array(0), true);
  await Promise.all(
    outputs.map((output) =>
      output.writableFinished || output.destroyed ? undefined : once(output, "finish"),
    ),
  );
  if (failure) throw failure;
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
    await setFileMode(join(directory, member.name), 0o755);
  }
}

/** Downloads, verifies, validates, and atomically publishes Google's pinned runtime. */
export async function prepareAntigravityRuntime(
  options: PrepareAntigravityRuntimeOptions,
): Promise<PreparedAntigravityRuntime> {
  const platform = options.platform ?? antigravityPlatform();
  if (!platform) {
    throw new Error(
      `Google does not publish Antigravity 1.4.1 for ${process.platform}-${process.arch}`,
    );
  }
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
  const archive = join(staging, "release.zip");
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
      { flag: "wx", mode: 0o600 },
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
    return assertReleaseDirectory(destination, asset, options.version);
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}
