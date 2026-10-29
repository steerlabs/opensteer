import { setPrivateHandleMode } from "@opensteer/shared/privateFiles";
import { noFollowFlag, readBounded } from "@opensteer/shared/privateFiles";
import { setPrivateDirectoryMode } from "@opensteer/shared/privateFiles";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, type FileHandle, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AsyncMutex } from "../async.js";

const replayLedgerVersion = 1;
const defaultMaxEntries = 10_000;
const defaultMaxFileBytes = 4 * 1_024 * 1_024;
const maximumConfiguredFileBytes = 16 * 1_024 * 1_024;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;

const ReplayEntrySchema = z.strictObject({
  expiresAt: z.number().int().positive().max(8_640_000_000_000_000),
  nonce: z.string().min(16).max(255),
});
const ReplayLedgerFileSchema = z.strictObject({
  entries: z.array(ReplayEntrySchema),
  highWaterAt: z.number().int().nonnegative().max(8_640_000_000_000_000),
  version: z.literal(replayLedgerVersion),
});

type ReplayEntry = z.infer<typeof ReplayEntrySchema>;
type ReplayLedgerFile = z.infer<typeof ReplayLedgerFileSchema>;

export type AttachTicketReplayLedgerErrorCode = "already-used" | "full" | "unavailable";

export class AttachTicketReplayLedgerError extends Error {
  readonly code: AttachTicketReplayLedgerErrorCode;

  constructor(code: AttachTicketReplayLedgerErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
    this.name = "AttachTicketReplayLedgerError";
  }
}

export interface DurableAttachTicketReplayLedgerOptions {
  readonly filePath: string;
  readonly maxEntries?: number;
  readonly maxFileBytes?: number;
  readonly now?: Date;
}

// A profile root belongs to one authoritative Browser Runtime process. This
// map serializes every verifier in that process that opens the same ledger.
// It is not a substitute for sharing one profile root between processes.
const pathMutexes = new Map<string, AsyncMutex>();

export class DurableAttachTicketReplayLedger {
  readonly #filePath: string;
  readonly #maxEntries: number;
  readonly #maxFileBytes: number;
  readonly #mutex: AsyncMutex;

  private constructor(options: DurableAttachTicketReplayLedgerOptions) {
    if (!path.isAbsolute(options.filePath)) {
      throw new TypeError("Attach ticket replay ledger path must be absolute");
    }
    this.#filePath = path.resolve(options.filePath);
    this.#maxEntries = boundedInteger(
      options.maxEntries ?? defaultMaxEntries,
      1,
      defaultMaxEntries,
      "maxEntries",
    );
    this.#maxFileBytes = boundedInteger(
      options.maxFileBytes ?? defaultMaxFileBytes,
      64,
      maximumConfiguredFileBytes,
      "maxFileBytes",
    );
    this.#mutex = mutexForPath(this.#filePath);
  }

  static async open(
    options: DurableAttachTicketReplayLedgerOptions,
  ): Promise<DurableAttachTicketReplayLedger> {
    const ledger = new DurableAttachTicketReplayLedger(options);
    const now = (options.now ?? new Date()).getTime();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError("Attach ticket replay ledger initialization time is invalid");
    }
    await ledger.#mutex.run(() => ledger.#initialize(now));
    return ledger;
  }

  claim(nonce: string, expiresAt: number, now: number): Promise<void> {
    if (!ReplayEntrySchema.shape.nonce.safeParse(nonce).success) {
      return Promise.reject(
        new AttachTicketReplayLedgerError("unavailable", "Replay nonce is invalid"),
      );
    }
    if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(now) || expiresAt <= now) {
      return Promise.reject(
        new AttachTicketReplayLedgerError("unavailable", "Replay expiry is invalid"),
      );
    }
    return this.#mutex.run(() => this.#claim(nonce, expiresAt, now));
  }

  async #initialize(now: number): Promise<void> {
    try {
      const directoryExisted = await ensureReplayDirectory(path.dirname(this.#filePath));
      let state: ReplayLedgerFile;
      try {
        state = await this.#read();
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
        if (directoryExisted) {
          throw new Error("Replay ledger is missing from existing Runtime state", { cause: error });
        }
        await this.#write([], now);
        return;
      }
      assertClockDidNotRollBack(now, state.highWaterAt);
      const active = prune(state.entries, now);
      if (active.length !== state.entries.length || now > state.highWaterAt) {
        await this.#write(active, now);
      }
    } catch (error) {
      throw unavailable(error);
    }
  }

  async #claim(nonce: string, expiresAt: number, now: number): Promise<void> {
    try {
      await ensureReplayDirectory(path.dirname(this.#filePath));
      const state = await this.#read();
      assertClockDidNotRollBack(now, state.highWaterAt);
      const active = prune(state.entries, now);
      if (active.some((entry) => entry.nonce === nonce)) {
        throw new AttachTicketReplayLedgerError(
          "already-used",
          "Attach ticket nonce was already consumed",
        );
      }
      if (active.length >= this.#maxEntries) {
        throw new AttachTicketReplayLedgerError("full", "Attach ticket replay ledger is full");
      }
      await this.#write([...active, { expiresAt, nonce }], now);
    } catch (error) {
      if (error instanceof AttachTicketReplayLedgerError) throw error;
      throw unavailable(error);
    }
  }

  async #read(): Promise<ReplayLedgerFile> {
    const handle = await open(this.#filePath, constants.O_RDONLY | noFollowFlag());
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("Replay ledger is not a regular file");
      assertOwnedByRuntime(stat.uid, "file");
      await setPrivateHandleMode(handle, privateFileMode);
      const encoded = await readBounded(
        handle,
        this.#maxFileBytes,
        () => new Error("Replay ledger exceeds its byte limit"),
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(encoded.toString("utf8"));
      } catch (error) {
        throw new Error("Replay ledger is not valid JSON", { cause: error });
      }
      const envelope = ReplayLedgerFileSchema.parse(parsed);
      if (envelope.entries.length > this.#maxEntries) {
        throw new Error("Replay ledger exceeds its item limit");
      }
      const nonces = new Set<string>();
      for (const entry of envelope.entries) {
        if (nonces.has(entry.nonce)) throw new Error("Replay ledger contains duplicate nonces");
        nonces.add(entry.nonce);
      }
      return envelope;
    } finally {
      await handle.close();
    }
  }

  async #write(entries: readonly ReplayEntry[], highWaterAt: number): Promise<void> {
    const sorted = [...entries].sort((left, right) => left.nonce.localeCompare(right.nonce));
    const encoded = Buffer.from(
      `${JSON.stringify({ entries: sorted, highWaterAt, version: replayLedgerVersion })}\n`,
      "utf8",
    );
    if (sorted.length > this.#maxEntries || encoded.byteLength > this.#maxFileBytes) {
      throw new AttachTicketReplayLedgerError("full", "Attach ticket replay ledger is full");
    }
    await writeAtomic(this.#filePath, encoded);
  }
}

export function defaultAttachTicketReplayLedgerPath(profileRoot: string): string {
  if (!path.isAbsolute(profileRoot)) {
    throw new TypeError("Browser profile root must be absolute");
  }
  return path.join(path.resolve(profileRoot), ".opensteer-runtime", "attach-ticket-replay-v1.json");
}

function mutexForPath(filePath: string): AsyncMutex {
  let mutex = pathMutexes.get(filePath);
  if (!mutex) {
    mutex = new AsyncMutex();
    pathMutexes.set(filePath, mutex);
  }
  return mutex;
}

function prune(entries: readonly ReplayEntry[], now: number): readonly ReplayEntry[] {
  return entries.filter((entry) => entry.expiresAt > now);
}

function assertClockDidNotRollBack(now: number, highWaterAt: number): void {
  if (now < highWaterAt) {
    throw new Error("Runtime clock moved behind the replay ledger high-water mark");
  }
}

async function ensureReplayDirectory(directory: string): Promise<boolean> {
  let existed = true;
  try {
    await lstat(directory);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    existed = false;
    await mkdir(directory, { mode: privateDirectoryMode, recursive: true });
  }
  const before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error("Replay ledger directory is not a private directory");
  }
  assertOwnedByRuntime(before.uid, "directory");
  await setPrivateDirectoryMode(directory, privateDirectoryMode);
  const after = await lstat(directory);
  if (!after.isDirectory() || after.isSymbolicLink() || (after.mode & 0o077) !== 0) {
    throw new Error("Replay ledger directory permissions are unsafe");
  }
  return existed;
}

async function writeAtomic(filePath: string, content: Buffer): Promise<void> {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.attach-ticket-replay-${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      privateFileMode,
    );
    await setPrivateHandleMode(handle, privateFileMode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function unavailable(cause: unknown): AttachTicketReplayLedgerError {
  return cause instanceof AttachTicketReplayLedgerError
    ? cause
    : new AttachTicketReplayLedgerError(
        "unavailable",
        "Attach ticket replay ledger is unavailable",
        cause,
      );
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Attach ticket replay ledger ${name} is invalid`);
  }
  return value;
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function assertOwnedByRuntime(ownerId: number, kind: "directory" | "file"): void {
  const runtimeOwnerId = process.getuid?.();
  if (runtimeOwnerId !== undefined && ownerId !== runtimeOwnerId) {
    throw new Error(`Replay ledger ${kind} is not owned by the Browser Runtime user`);
  }
}
