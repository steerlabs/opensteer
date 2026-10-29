/** Crash-safe creation and replacement of mode-0600 files in a private directory. */

import { randomUUID } from "node:crypto";
import { link, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { isNodeError } from "./nodeError.js";
import {
  readBoundedRegularFile,
  setPrivateDirectoryMode,
  setPrivateFileMode,
  syncDirectory,
} from "./privateFiles.js";

export interface PrivateFileErrors {
  /** The file is missing a regular-file shape, oversized, or changed under the read. */
  readonly invalid: () => Error;
  /** The file carries group or other permission bits. */
  readonly exposed: () => Error;
}

/**
 * Deliberately weaker than `ensurePrivateDirectory`: a runtime data directory
 * is routinely a symlink into a mounted volume, so the real-directory
 * assertion that guards read paths would refuse legitimate deployments here.
 */
export async function securePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive: true });
  await setPrivateDirectoryMode(path);
}

/**
 * Publishes content under `path` only if nothing claimed the name first. The
 * hard link is the primitive that makes first-writer-wins observable: a second
 * process racing the same creation loses the link and keeps the existing file.
 */
export async function createPrivateFileAtomically(path: string, content: string): Promise<void> {
  const temporary = await writePrivateTemporaryFile(path, content);
  try {
    await link(temporary, path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  await syncDirectory(dirname(path));
}

/**
 * Replaces `path` whole. A reader either sees the previous content or the new
 * content, never a partial write, and the directory sync makes the rename
 * survive a crash.
 */
export async function replacePrivateFileAtomically(path: string, content: string): Promise<void> {
  const temporary = await writePrivateTemporaryFile(path, content);
  try {
    await rename(temporary, path);
    await setPrivateFileMode(path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function readPrivateFileText(
  path: string,
  maximumBytes: number,
  errors: PrivateFileErrors,
): Promise<string | undefined> {
  const bytes = await readBoundedRegularFile(path, maximumBytes, {
    changedError: errors.invalid,
    invalidFileError: errors.invalid,
    missing: "null",
    sizeError: errors.invalid,
    validateMetadata: (metadata) => {
      if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) throw errors.exposed();
    },
  });
  return bytes?.toString("utf8");
}

async function writePrivateTemporaryFile(path: string, content: string): Promise<string> {
  await securePrivateDirectory(dirname(path));
  const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temporary;
}
