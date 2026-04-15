import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stableJsonString } from "../json.js";

const LOCK_RETRY_DELAYS_MS = [1, 2, 5, 10, 20, 50] as const;
const LOCK_METADATA_FILENAME = "owner.json";
const LOCK_METADATA_VERSION = 1;
const LOCK_HEARTBEAT_INTERVAL_MS = 1_000;
const LOCK_ORPHAN_GRACE_MS = 2_000;
const LOCK_METADATALESS_STALE_MS = 30_000;

interface FilesystemLockMetadata {
  readonly version: typeof LOCK_METADATA_VERSION;
  readonly ownerToken: string;
  readonly pid: number;
  readonly acquiredAt: number;
  readonly heartbeatAt: number;
}

export function normalizeNonEmptyString(name: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }

  return normalized;
}

export function normalizeTimestamp(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }

  return value;
}

export function encodePathSegment(value: string): string {
  return encodeURIComponent(normalizeNonEmptyString("path segment", value));
}

export function joinStoragePath(...segments: readonly string[]): string {
  return segments.join("/");
}

export function resolveStoragePath(rootPath: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new TypeError(`storage path ${relativePath} must be relative`);
  }

  const segments = relativePath.split("/");
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    throw new TypeError(`storage path ${relativePath} is invalid`);
  }

  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new TypeError(`storage path ${relativePath} must not contain path traversal`);
    }
  }

  return path.join(rootPath, ...segments);
}

export async function ensureDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true });
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await writeTextFileAtomic(filePath, stableJsonString(value));
}

async function writeTextFileAtomic(filePath: string, value: string): Promise<void> {
  await ensureDirectory(path.dirname(filePath));
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;

  await writeFile(temporaryPath, value, "utf8");
  await rename(temporaryPath, filePath);
}

export async function writeJsonFileExclusive(filePath: string, value: unknown): Promise<void> {
  await writeTextFileExclusive(filePath, stableJsonString(value));
}

async function writeTextFileExclusive(filePath: string, value: string): Promise<void> {
  await ensureDirectory(path.dirname(filePath));
  const handle = await open(filePath, "wx");

  try {
    await handle.writeFile(value, "utf8");
  } finally {
    await handle.close();
  }
}

export async function writeBufferIfMissing(filePath: string, value: Uint8Array): Promise<void> {
  await ensureDirectory(path.dirname(filePath));

  try {
    const handle = await open(filePath, "wx");
    try {
      await handle.writeFile(value);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      return;
    }

    throw error;
  }
}

export async function readBinaryFile(filePath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(filePath));
}

export async function listJsonFiles(directoryPath: string): Promise<readonly string[]> {
  if (!(await pathExists(directoryPath))) {
    return [];
  }

  return (await readdir(directoryPath))
    .filter((entry) => entry.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right));
}

export function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function filePathToUri(filePath: string): string {
  return pathToFileURL(filePath).toString();
}

export function fileUriToPath(uri: string): string {
  return fileURLToPath(uri);
}

export function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

export async function withFilesystemLock<T>(lockPath: string, task: () => Promise<T>): Promise<T> {
  await ensureDirectory(path.dirname(lockPath));

  const ownerToken = randomUUID();
  let attempt = 0;
  while (true) {
    try {
      await mkdir(lockPath);
      const acquiredAt = Date.now();
      await writeLockMetadata(lockPath, {
        version: LOCK_METADATA_VERSION,
        ownerToken,
        pid: process.pid,
        acquiredAt,
        heartbeatAt: acquiredAt,
      });
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      if (await tryRecoverFilesystemLock(lockPath)) {
        attempt = 0;
        continue;
      }

      const delayMs = LOCK_RETRY_DELAYS_MS[Math.min(attempt, LOCK_RETRY_DELAYS_MS.length - 1)];
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const heartbeatTimer = setInterval(() => {
    void touchLockMetadata(lockPath, ownerToken);
  }, LOCK_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  try {
    return await task();
  } finally {
    clearInterval(heartbeatTimer);
    const metadata = await readLockMetadata(lockPath);
    if (metadata?.ownerToken === ownerToken) {
      await rm(lockPath, { recursive: true, force: true });
    }
  }
}

async function tryRecoverFilesystemLock(lockPath: string): Promise<boolean> {
  if (!(await shouldRecoverFilesystemLock(lockPath))) {
    return false;
  }

  await rm(lockPath, { recursive: true, force: true });
  return true;
}

async function shouldRecoverFilesystemLock(lockPath: string): Promise<boolean> {
  const metadata = await readLockMetadata(lockPath);
  if (metadata !== undefined) {
    if (isProcessRunning(metadata.pid)) {
      return false;
    }
    return Date.now() - metadata.heartbeatAt >= LOCK_ORPHAN_GRACE_MS;
  }

  const lockStat = await stat(lockPath).catch(() => undefined);
  if (lockStat === undefined) {
    return false;
  }
  return Date.now() - lockStat.mtimeMs >= LOCK_METADATALESS_STALE_MS;
}

async function readLockMetadata(lockPath: string): Promise<FilesystemLockMetadata | undefined> {
  const metadataPath = path.join(lockPath, LOCK_METADATA_FILENAME);
  if (!(await pathExists(metadataPath))) {
    return undefined;
  }

  try {
    const parsed = await readJsonFile<Partial<FilesystemLockMetadata>>(metadataPath);
    const pid = parsed.pid;
    const acquiredAt = parsed.acquiredAt;
    const heartbeatAt = parsed.heartbeatAt;
    if (
      parsed.version !== LOCK_METADATA_VERSION ||
      typeof parsed.ownerToken !== "string" ||
      parsed.ownerToken.length === 0 ||
      typeof pid !== "number" ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      typeof acquiredAt !== "number" ||
      !Number.isFinite(acquiredAt) ||
      typeof heartbeatAt !== "number" ||
      !Number.isFinite(heartbeatAt)
    ) {
      return undefined;
    }
    return {
      version: LOCK_METADATA_VERSION,
      ownerToken: parsed.ownerToken,
      pid: pid,
      acquiredAt: acquiredAt,
      heartbeatAt: heartbeatAt,
    };
  } catch {
    return undefined;
  }
}

async function writeLockMetadata(
  lockPath: string,
  metadata: FilesystemLockMetadata,
): Promise<void> {
  try {
    await writeJsonFileAtomic(path.join(lockPath, LOCK_METADATA_FILENAME), metadata);
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function touchLockMetadata(lockPath: string, ownerToken: string): Promise<void> {
  const metadata = await readLockMetadata(lockPath);
  if (metadata === undefined || metadata.ownerToken !== ownerToken) {
    return;
  }

  await writeJsonFileAtomic(path.join(lockPath, LOCK_METADATA_FILENAME), {
    ...metadata,
    heartbeatAt: Date.now(),
  }).catch(() => undefined);
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}
