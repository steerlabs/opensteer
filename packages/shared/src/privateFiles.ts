/** Private-file identity, permissions, and bounded I/O. */

import { chmodSync, constants, lstatSync, mkdirSync, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { isNodeError } from "./nodeError.js";

export function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

export async function ensurePrivateDirectory(
  directory: string,
  invalidMessage = "Private data path must be a real directory.",
): Promise<void> {
  await mkdir(directory, { mode: 0o700, recursive: true });
  const metadata = await lstat(directory);
  assertRealDirectory(metadata, invalidMessage);
  if (process.platform !== "win32") await chmod(directory, 0o700);
}

export function ensurePrivateDirectorySync(
  directory: string,
  invalidMessage = "Private data path must be a real directory.",
): void {
  mkdirSync(directory, { mode: 0o700, recursive: true });
  assertRealDirectory(lstatSync(directory), invalidMessage);
  if (process.platform !== "win32") chmodSync(directory, 0o700);
}

export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function setPrivateDirectoryMode(directory: string, mode = 0o700): Promise<void> {
  if (process.platform !== "win32") await chmod(directory, mode);
}

export async function setPrivateFileMode(filePath: string, mode = 0o600): Promise<void> {
  if (process.platform !== "win32") await chmod(filePath, mode);
}

export async function setFileMode(filePath: string, mode: number): Promise<void> {
  await chmod(filePath, mode);
}

export async function setPrivateHandleMode(handle: FileHandle, mode: number): Promise<void> {
  if (process.platform !== "win32") await handle.chmod(mode);
}

export async function assertRegularFile(filePath: string, label: string): Promise<void> {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real regular file.`);
  }
}

export function assertRegularFileSync(filePath: string, label: string): void {
  const metadata = lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real regular file.`);
  }
}

export async function readBounded(
  handle: FileHandle,
  maximumBytes: number,
  sizeError: () => Error,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maximumBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1_024, maximumBytes + 1 - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, total);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > maximumBytes) throw sizeError();
  return Buffer.concat(chunks, total);
}

interface BoundedRegularFileOptions {
  readonly changedError: () => Error;
  readonly invalidFileError: () => Error;
  readonly minimumBytes?: number;
  readonly missing?: "null" | "throw";
  readonly sizeError: () => Error;
  readonly validateMetadata?: (metadata: Stats) => void;
}

export async function readBoundedRegularFile(
  filePath: string,
  maximumBytes: number,
  options: BoundedRegularFileOptions,
): Promise<Buffer | null> {
  let before: Stats;
  try {
    before = await lstat(filePath);
  } catch (error) {
    if (options.missing === "null" && isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || before.size < (options.minimumBytes ?? 0)) {
    throw options.invalidFileError();
  }
  if (before.size > maximumBytes) throw options.sizeError();
  options.validateMetadata?.(before);
  let handle: FileHandle;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if (options.missing === "null" && isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw options.changedError();
    }
    if (opened.size < (options.minimumBytes ?? 0)) throw options.invalidFileError();
    if (opened.size > maximumBytes) throw options.sizeError();
    options.validateMetadata?.(opened);
    return await readBounded(handle, maximumBytes, options.sizeError);
  } finally {
    await handle.close();
  }
}

function assertRealDirectory(metadata: Stats, message: string): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(message);
}
