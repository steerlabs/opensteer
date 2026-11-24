import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import { createHash, verify as verifySignature } from "node:crypto";
import { mkdir, open, readFile, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  RESTRICTED_WEB_STORE_EXCLUDE_MATCHES,
  assertExtensionId,
  isRecord,
  resolveExtensionFile,
} from "./permissions.js";

const CRX_MAGIC = "Cr24";
const CRX3_SIGNED_DATA_PREFIX = Buffer.from("CRX3 SignedData\x00", "binary");
export const MAX_CRX_BYTES = 100 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;
const MAX_UNPACKED_BYTES = 250 * 1024 * 1024;
const UNZIP_CHUNK_BYTES = 64 * 1024;

/**
 * SHA-256 of the DER SPKI for Google's official Chrome Web Store CRX3 publisher key
 * (`ecdsa_2017_public` — `kPublisherKeyHash` in Chromium's `components/crx_file/crx_verifier.cc`).
 */
export const CHROME_WEB_STORE_PUBLISHER_KEY_HASHES: ReadonlySet<string> = new Set([
  "61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf",
]);

export interface ParsedCrx3 {
  readonly extensionId: string;
  readonly publicKey: Buffer;
  readonly verifiedKeyHashes: readonly string[];
  readonly archive: Buffer;
}

interface AsymmetricKeyProof {
  publicKey?: Buffer;
  signature?: Buffer;
}

interface CrxFileHeader {
  readonly rsaProofs: AsymmetricKeyProof[];
  readonly ecdsaProofs: AsymmetricKeyProof[];
  signedHeaderData?: Buffer;
}

/** Converts a 16-byte SHA-256 prefix (32 hex chars) into Chrome's `a`–`p` extension ID alphabet. */
export function extensionIdFromPublicKey(publicKey: Buffer | string): string {
  const bytes = typeof publicKey === "string" ? Buffer.from(publicKey, "base64") : publicKey;
  const hex = createHash("sha256").update(bytes).digest().subarray(0, 16).toString("hex");
  let id = "";
  for (const ch of hex) {
    const nibble = Number.parseInt(ch, 16);
    id += String.fromCharCode(97 + nibble);
  }
  return id;
}

/** Minimal protobuf wire reader sufficient for CRX3 `CrxFileHeader` / `SignedData`. */
class ProtoReader {
  #pos = 0;
  readonly #buf: Buffer;
  readonly #end: number;

  constructor(buf: Buffer, start = 0, end = buf.length) {
    this.#buf = buf;
    this.#pos = start;
    this.#end = end;
  }

  get hasMore(): boolean {
    return this.#pos < this.#end;
  }

  readVarint(): number {
    let result = 0;
    let shift = 0;
    while (this.#pos < this.#end) {
      const byte = this.#buf[this.#pos++]!;
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      if (shift > 53) throw new Error("CRX3 protobuf varint overflow.");
    }
    throw new Error("Truncated CRX3 protobuf varint.");
  }

  readBytes(): Buffer {
    const length = this.readVarint();
    if (length < 0 || this.#pos + length > this.#end) {
      throw new Error("Truncated CRX3 protobuf field.");
    }
    const slice = this.#buf.subarray(this.#pos, this.#pos + length);
    this.#pos += length;
    return slice;
  }

  skip(wireType: number): void {
    switch (wireType) {
      case 0:
        this.readVarint();
        return;
      case 1:
        this.#pos += 8;
        break;
      case 2:
        this.readBytes();
        return;
      case 5:
        this.#pos += 4;
        break;
      default:
        throw new Error(`Unsupported CRX3 protobuf wire type ${wireType}.`);
    }
    if (this.#pos > this.#end) throw new Error("Truncated CRX3 protobuf skip.");
  }
}

function parseKeyProof(buffer: Buffer): AsymmetricKeyProof {
  const reader = new ProtoReader(buffer);
  const proof: AsymmetricKeyProof = {};
  while (reader.hasMore) {
    const tag = reader.readVarint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) proof.publicKey = reader.readBytes();
    else if (field === 2 && wire === 2) proof.signature = reader.readBytes();
    else reader.skip(wire);
  }
  return proof;
}

function parseCrxFileHeader(buffer: Buffer): CrxFileHeader {
  const reader = new ProtoReader(buffer);
  const header: CrxFileHeader = { rsaProofs: [], ecdsaProofs: [] };
  while (reader.hasMore) {
    const tag = reader.readVarint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 2 && wire === 2) header.rsaProofs.push(parseKeyProof(reader.readBytes()));
    else if (field === 3 && wire === 2) header.ecdsaProofs.push(parseKeyProof(reader.readBytes()));
    else if (field === 10_000 && wire === 2) header.signedHeaderData = reader.readBytes();
    else reader.skip(wire);
  }
  return header;
}

function parseCrxIdFromSignedData(buffer: Buffer): string | null {
  const reader = new ProtoReader(buffer);
  while (reader.hasMore) {
    const tag = reader.readVarint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) {
      const crxIdBytes = reader.readBytes();
      if (crxIdBytes.length !== 16) return null;
      let id = "";
      for (const ch of crxIdBytes.toString("hex")) {
        id += String.fromCharCode(97 + Number.parseInt(ch, 16));
      }
      return id;
    }
    reader.skip(wire);
  }
  return null;
}

/**
 * Parses and cryptographically verifies a CRX3 package.
 * Rejects CRX2, missing/mismatched key proofs, and invalid RSA/ECDSA-SHA256 signatures.
 */
export function parseAndVerifyCrx3(
  buffer: Buffer,
  expectedExtensionId?: string,
  options?: { readonly requiredKeyHashes?: ReadonlySet<string> },
): ParsedCrx3 {
  if (buffer.length < 12 || buffer.length > MAX_CRX_BYTES) {
    throw new Error("Invalid CRX3 package size.");
  }
  if (buffer.toString("ascii", 0, 4) !== CRX_MAGIC) {
    throw new Error("Invalid CRX magic header.");
  }
  const version = buffer.readUInt32LE(4);
  if (version !== 3) {
    throw new Error(`Unsupported CRX version ${version}; only CRX3 is accepted.`);
  }
  const headerSize = buffer.readUInt32LE(8);
  if (headerSize === 0 || 12 + headerSize > buffer.length) {
    throw new Error("Invalid CRX3 header size.");
  }
  const headerBytes = buffer.subarray(12, 12 + headerSize);
  const archive = buffer.subarray(12 + headerSize);
  const header = parseCrxFileHeader(headerBytes);
  if (!header.signedHeaderData) {
    throw new Error("CRX3 header is missing signed_header_data.");
  }
  const declaredId = parseCrxIdFromSignedData(header.signedHeaderData);
  if (!declaredId) {
    throw new Error("CRX3 signed_header_data is missing a valid crx_id.");
  }
  assertExtensionId(declaredId);
  if (expectedExtensionId && declaredId !== expectedExtensionId) {
    throw new Error(
      `CRX3 extension ID mismatch: expected ${expectedExtensionId}, got ${declaredId}.`,
    );
  }

  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeUInt32LE(header.signedHeaderData.length, 0);
  const signedPayload = Buffer.concat([
    CRX3_SIGNED_DATA_PREFIX,
    lengthPrefix,
    header.signedHeaderData,
    archive,
  ]);

  const candidates = [...header.rsaProofs, ...header.ecdsaProofs];
  let extensionPublicKey: Buffer | null = null;
  const verifiedKeyHashes: string[] = [];

  for (const proof of candidates) {
    if (!proof.publicKey || !proof.signature) continue;
    const ok = verifySignature(
      "sha256",
      signedPayload,
      { key: proof.publicKey, format: "der", type: "spki" },
      proof.signature,
    );
    if (!ok) {
      throw new Error("CRX3 signature verification failed.");
    }
    const keyHash = createHash("sha256").update(proof.publicKey).digest("hex");
    verifiedKeyHashes.push(keyHash);
    if (extensionIdFromPublicKey(proof.publicKey) === declaredId) {
      extensionPublicKey = proof.publicKey;
    }
  }

  if (!extensionPublicKey) {
    throw new Error("CRX3 package carries no verified key proof for its declared extension ID.");
  }
  if (
    options?.requiredKeyHashes &&
    !verifiedKeyHashes.some((hash) => options.requiredKeyHashes!.has(hash))
  ) {
    throw new Error("CRX3 package lacks a required publisher key proof.");
  }

  return {
    extensionId: declaredId,
    publicKey: extensionPublicKey,
    verifiedKeyHashes,
    archive,
  };
}

/**
 * Adds Chrome Web Store exclusions to every `content_scripts` entry so Electron's
 * native content-script loader cannot inject third-party Store extension scripts
 * into the Chrome Web Store origin.
 */
export function injectWebStoreContentScriptExclusions(manifest: Record<string, unknown>): boolean {
  if (!Array.isArray(manifest.content_scripts)) return false;
  let changed = false;
  for (const script of manifest.content_scripts) {
    if (!isRecord(script)) continue;
    const existing = Array.isArray(script.exclude_matches)
      ? script.exclude_matches.filter((item): item is string => typeof item === "string")
      : [];
    const merged = new Set(existing);
    for (const pattern of RESTRICTED_WEB_STORE_EXCLUDE_MATCHES) {
      if (!merged.has(pattern)) {
        merged.add(pattern);
        changed = true;
      }
    }
    script.exclude_matches = [...merged];
  }
  return changed;
}

/**
 * Streams a verified CRX3 ZIP archive into `destination` in bounded chunks with true
 * disk-write backpressure so the main process never freezes or buffers the entire
 * unpacked archive in memory. Uses promise-based `FileHandle` writes (no unhandled
 * WriteStream EventEmitter errors), enforces path safety, entry count, and real-time
 * inflated byte limits mid-stream, then writes `manifest.key` and Chrome Web Store
 * content-script exclusions.
 */
export async function unpackCrx3(
  crx: ParsedCrx3,
  destination: string,
): Promise<Record<string, unknown>> {
  const root = path.resolve(destination);
  await mkdir(root, { recursive: true });

  let entryCount = 0;
  let declaredBytes = 0;
  let actualBytes = 0;
  let streamError: Error | null = null;
  let ioChain: Promise<void> = Promise.resolve();
  const createdDirs = new Set<string>([root]);
  const openHandles = new Set<FileHandle>();

  const fail = (error: Error) => {
    streamError ??= error;
  };

  const enqueueIo = (task: () => Promise<void>) => {
    ioChain = ioChain.then(async () => {
      if (streamError) return;
      try {
        await task();
      } catch (error: unknown) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const unzip = new Unzip((file) => {
    if (streamError) return;
    if (file.name.endsWith("/")) return;
    entryCount++;
    if (entryCount > MAX_ZIP_ENTRIES) {
      fail(new Error("CRX3 archive exceeds maximum file count."));
      return;
    }
    const normalized = file.name.replace(/\\/gu, "/");
    const target = resolveExtensionFile(root, normalized);
    if (!target) {
      fail(new Error(`CRX3 archive contains an unsafe entry path: ${file.name}`));
      return;
    }
    declaredBytes += Math.max(file.originalSize ?? 0, file.size ?? 0);
    if (declaredBytes > MAX_UNPACKED_BYTES) {
      fail(new Error("CRX3 archive exceeds maximum unpacked size."));
      return;
    }

    const dir = path.dirname(target);
    let handle: FileHandle | null = null;

    const ensureOpen = async (): Promise<FileHandle> => {
      if (handle) return handle;
      if (!createdDirs.has(dir)) {
        await mkdir(dir, { recursive: true });
        createdDirs.add(dir);
      }
      handle = await open(target, "w");
      openHandles.add(handle);
      return handle;
    };

    file.ondata = (err, chunk, final) => {
      if (streamError) {
        file.terminate();
        return;
      }
      if (err) {
        fail(err);
        file.terminate();
        return;
      }
      if (chunk.byteLength > 0) {
        actualBytes += chunk.byteLength;
        if (actualBytes > MAX_UNPACKED_BYTES) {
          fail(new Error("CRX3 archive exceeds maximum unpacked size."));
          file.terminate();
          return;
        }
        const copy = Buffer.from(chunk);
        enqueueIo(async () => {
          const fh = await ensureOpen();
          let written = 0;
          while (written < copy.byteLength) {
            const { bytesWritten } = await fh.write(copy, written, copy.byteLength - written);
            if (bytesWritten <= 0) throw new Error("Short write extracting CRX3 archive.");
            written += bytesWritten;
          }
        });
      }
      if (final) {
        enqueueIo(async () => {
          const fh = await ensureOpen();
          openHandles.delete(fh);
          handle = null;
          await fh.close();
        });
      }
    };

    file.start();
  });
  unzip.register(UnzipPassThrough);
  unzip.register(UnzipInflate);

  try {
    const zipBytes = new Uint8Array(
      crx.archive.buffer,
      crx.archive.byteOffset,
      crx.archive.byteLength,
    );
    for (let offset = 0; offset < zipBytes.byteLength; offset += UNZIP_CHUNK_BYTES) {
      if (streamError) throw streamError;
      const end = Math.min(offset + UNZIP_CHUNK_BYTES, zipBytes.byteLength);
      const isFinal = end === zipBytes.byteLength;
      unzip.push(zipBytes.subarray(offset, end), isFinal);
      // Wait for this chunk's disk writes before inflating the next chunk (true backpressure).
      await ioChain;
      if (streamError) throw streamError;
      if (!isFinal) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    await ioChain;
    if (streamError) throw streamError;
  } finally {
    await ioChain.catch(() => undefined);
    for (const fh of openHandles) {
      await fh.close().catch(() => undefined);
    }
    openHandles.clear();
  }

  const manifestPath = path.join(root, "manifest.json");
  const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error("Extension manifest.json must be a JSON object.");
  }
  parsed.key = crx.publicKey.toString("base64");
  injectWebStoreContentScriptExclusions(parsed);
  await writeFile(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return parsed;
}
