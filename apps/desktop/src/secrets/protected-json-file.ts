import { serializePrivateFileCommit } from "@opensteer/shared/atomicPrivateFile";
import { readBoundedRegularFile as readPrivateFile } from "@opensteer/shared/privateFiles";
import { ensurePrivateDirectory } from "@opensteer/shared/privateFiles";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { syncDirectory } from "@opensteer/shared/privateFiles";
import { noFollowFlag } from "@opensteer/shared/privateFiles";
import { constants } from "node:fs";
import { lstat, open, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { DesktopPrivateFilesystem } from "./desktop-private-files.js";

export interface DesktopSecretCryptography {
  decryptStringAsync(
    encrypted: Buffer,
  ): Promise<{ readonly result: string; readonly shouldReEncrypt: boolean }>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  getSelectedStorageBackend(): string;
  isAsyncEncryptionAvailable(): Promise<boolean>;
}

interface ProtectedJsonMessages {
  readonly protectedStore: string;
  readonly protectedState: string;
}

/**
 * What content that no longer satisfies the schema means for this file.
 *
 * A `rebuildable` cache holds only state the Desktop can obtain again, so
 * unreadable content reads as absent and the owner starts over. `critical`
 * state cannot be recreated from anywhere else, so it refuses to be silently
 * discarded and its owner has to migrate or repair it.
 */
export type ProtectedJsonContent = "critical" | "rebuildable";

interface ProtectedJsonFileOptions<T> {
  readonly content: ProtectedJsonContent;
  readonly cryptography: DesktopSecretCryptography;
  readonly filePath: string;
  readonly maxFileBytes: number;
  readonly maxPlaintextBytes: number;
  readonly messages: ProtectedJsonMessages;
  readonly privateFiles?: DesktopPrivateFilesystem;
  readonly platform?: NodeJS.Platform;
  readonly schema: z.ZodType<T>;
  readonly assertCurrent?: () => void;
}

/**
 * The operating system's protected storage (the macOS Keychain) will not
 * protect or unprotect secrets for Opensteer. A file system failure reading or
 * writing the file is not this: it is thrown as it is.
 */
export class ProtectedStorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtectedStorageUnavailableError";
  }
}

/**
 * The protected file's content cannot be read: it is corrupt, or holds
 * critical state in a shape this release does not know. Reading it again
 * reads the same bytes, so it waits for the person; the file is kept.
 */
export class ProtectedStateUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtectedStateUnreadableError";
  }
}

const CiphertextEnvelopeSchema = z.strictObject({
  ciphertext: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  schemaVersion: z.literal(1),
});

/**
 * One OS-encrypted JSON file with strict parsing and symlink-safe atomic
 * replacement. Callers own their domain schema and mutation serialization.
 */
export class ProtectedJsonFile<T> {
  readonly #content: ProtectedJsonContent;
  readonly #cryptography: DesktopSecretCryptography;
  readonly #filePath: string;
  readonly #maxFileBytes: number;
  readonly #maxPlaintextBytes: number;
  readonly #messages: ProtectedJsonMessages;
  readonly #platform: NodeJS.Platform;
  readonly #privateFiles: DesktopPrivateFilesystem | undefined;
  readonly #schema: z.ZodType<T>;
  readonly #assertCurrent: (() => void) | undefined;

  constructor(options: ProtectedJsonFileOptions<T>) {
    if (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 1) {
      throw new TypeError("Protected JSON file size must be a positive bounded integer.");
    }
    if (!Number.isSafeInteger(options.maxPlaintextBytes) || options.maxPlaintextBytes < 1) {
      throw new TypeError("Protected JSON plaintext size must be a positive bounded integer.");
    }
    this.#content = options.content;
    this.#assertCurrent = options.assertCurrent;
    this.#cryptography = options.cryptography;
    this.#filePath = path.resolve(options.filePath);
    this.#maxFileBytes = options.maxFileBytes;
    this.#maxPlaintextBytes = options.maxPlaintextBytes;
    this.#messages = options.messages;
    this.#platform = options.platform ?? process.platform;
    this.#privateFiles = options.privateFiles;
    this.#schema = options.schema;
  }

  get filePath(): string {
    return this.#filePath;
  }

  async assertAvailable(): Promise<void> {
    if (!(await this.#cryptography.isAsyncEncryptionAvailable())) {
      throw new ProtectedStorageUnavailableError(
        protectedStorageUnavailableMessage(this.#platform),
      );
    }
    if (this.#platform === "linux") {
      const backend = this.#cryptography.getSelectedStorageBackend();
      if (backend === "basic_text" || backend === "unknown") {
        throw new ProtectedStorageUnavailableError(
          "Opensteer requires a Linux Secret Service or KWallet; basic-text credential storage is refused.",
        );
      }
    }
  }

  async read(): Promise<T | null> {
    await this.assertAvailable();
    const serialized = this.#privateFiles
      ? ((await this.#privateFiles.readFile(this.#filePath, this.#maxFileBytes))?.toString(
          "utf8",
        ) ?? null)
      : await readProtectedJsonFile(this.#filePath, this.#maxFileBytes, this.#messages);
    if (serialized === null) return null;
    let envelope: z.infer<typeof CiphertextEnvelopeSchema>;
    try {
      envelope = CiphertextEnvelopeSchema.parse(JSON.parse(serialized));
      if (envelope.ciphertext.length > this.#maxFileBytes) throw new Error("too large");
    } catch {
      throw new ProtectedStateUnreadableError(`${this.#messages.protectedStore} is corrupt.`);
    }
    const encrypted = Buffer.from(envelope.ciphertext, "base64");
    if (encrypted.byteLength === 0 || encrypted.byteLength > this.#maxFileBytes) {
      throw new ProtectedStateUnreadableError(`${this.#messages.protectedStore} is corrupt.`);
    }
    let decrypted: { readonly result: string; readonly shouldReEncrypt: boolean };
    try {
      decrypted = await this.#cryptography.decryptStringAsync(encrypted);
    } catch {
      throw new ProtectedStorageUnavailableError(
        `${this.#messages.protectedStore} cannot be decrypted.`,
      );
    }
    if (Buffer.byteLength(decrypted.result, "utf8") > this.#maxPlaintextBytes) {
      throw new ProtectedStateUnreadableError(`${this.#messages.protectedStore} is too large.`);
    }
    let state: T;
    try {
      state = this.#schema.parse(JSON.parse(decrypted.result));
    } catch {
      if (this.#content === "critical") {
        throw new ProtectedStateUnreadableError(
          `${this.#messages.protectedStore} is incompatible or corrupt.`,
        );
      }
      // Content this release cannot read is discarded whole, so the owner
      // rebuilds from absent instead of decoding a shape it no longer knows.
      await this.remove();
      return null;
    }
    if (decrypted.shouldReEncrypt) await this.write(state);
    return state;
  }

  async write(input: T): Promise<void> {
    await this.assertAvailable();
    const state = this.#schema.parse(input);
    const plaintext = JSON.stringify(state);
    if (Buffer.byteLength(plaintext, "utf8") > this.#maxPlaintextBytes) {
      throw new Error(`${this.#messages.protectedStore} is too large.`);
    }
    let encrypted: Buffer;
    try {
      encrypted = await this.#cryptography.encryptStringAsync(plaintext);
    } catch {
      throw new ProtectedStorageUnavailableError(
        `${this.#messages.protectedState} could not be protected.`,
      );
    }
    if (encrypted.byteLength === 0 || encrypted.byteLength > this.#maxFileBytes / 2) {
      throw new Error(`${this.#messages.protectedStore} is too large.`);
    }
    const serialized = `${JSON.stringify({ ciphertext: encrypted.toString("base64"), schemaVersion: 1 })}\n`;
    if (this.#privateFiles) {
      this.#assertCurrent?.();
      await this.#privateFiles.writeFileAtomic(this.#filePath, serialized);
    } else {
      await writeAtomicFile(
        this.#filePath,
        serialized,
        this.#maxFileBytes,
        this.#messages,
        this.#assertCurrent,
      );
    }
  }

  async remove(): Promise<void> {
    await this.assertAvailable();
    if (this.#privateFiles) {
      await this.#privateFiles.removeFile(this.#filePath);
    } else {
      if (!(await assertReplaceableFile(this.#filePath, this.#messages))) return;
      await rm(this.#filePath, { force: true });
      await syncDirectory(path.dirname(this.#filePath));
    }
  }
}

function protectedStorageUnavailableMessage(platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return "macOS Keychain is not accepting protected storage. In Keychain Access, lock and unlock the login keychain, then try again.";
  }
  return "Operating-system protected credential storage is unavailable.";
}

async function readProtectedJsonFile(
  filePath: string,
  maxBytes: number,
  messages: ProtectedJsonMessages,
): Promise<string | null> {
  const bytes = await readPrivateFile(filePath, maxBytes, {
    changedError: () => new Error(`${messages.protectedStore} changed while it was opened.`),
    invalidFileError: () => new Error(`${messages.protectedStore} must be a real regular file.`),
    missing: "null",
    sizeError: () => new Error(`${messages.protectedStore} is too large.`),
  });
  return bytes?.toString("utf8") ?? null;
}

async function writeAtomicFile(
  filePath: string,
  value: string,
  maxBytes: number,
  messages: ProtectedJsonMessages,
  assertCurrent?: () => void,
): Promise<void> {
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${messages.protectedStore} is too large.`);
  }
  const directory = path.dirname(filePath);
  await ensurePrivateDirectory(directory, "The Desktop data directory must be a real directory.");
  await assertReplaceableFile(filePath, messages);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${globalThis.crypto.randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
      0o600,
    );
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await serializePrivateFileCommit(filePath, async () => {
      assertCurrent?.();
      await rename(temporaryPath, filePath);
      await syncDirectory(directory);
    });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function assertReplaceableFile(
  filePath: string,
  messages: ProtectedJsonMessages,
): Promise<boolean> {
  try {
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`${messages.protectedStore} must be a real regular file.`);
    }
    return true;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}
