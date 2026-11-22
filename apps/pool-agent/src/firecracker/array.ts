/**
 * Saved guest memory may be written only to the encrypted saved-state array (review G3). The
 * agent refuses to start unless the array's id file, the jail root and the saved-state root are
 * on one filesystem, that filesystem's device is a dm-crypt mapping, and both roots are
 * root-only. A missing array id is a start failure, never a default.
 */
import { readFile, stat } from "node:fs/promises";

export interface ArrayPaths {
  readonly arrayIdFile: string;
  readonly jailRoot: string;
  readonly savedRoot: string;
}

export interface ArrayIo {
  stat(path: string): Promise<{ dev: number; mode: number; uid: number; isDirectory(): boolean }>;
  /** The dm uuid of a block device `major:minor`, or undefined if it is not a dm device. */
  dmUuid(device: string): Promise<string | undefined>;
  readArrayId(path: string): Promise<string | undefined>;
}

export const hostArrayIo: ArrayIo = {
  stat: (path) => stat(path),
  dmUuid: (device) =>
    readFile(`/sys/dev/block/${device}/dm/uuid`, "utf8").then(
      (text) => text.trim(),
      () => undefined,
    ),
  readArrayId: (path) =>
    readFile(path, "utf8").then(
      (text) => text.trim() || undefined,
      () => undefined,
    ),
};

/** Linux `st_dev` as `major:minor` (glibc's `gnu_dev_major` and `gnu_dev_minor`). */
export function deviceName(dev: number): string {
  const value = BigInt(dev);
  const major = ((value >> 8n) & 0xfffn) | ((value >> 32n) & ~0xfffn);
  const minor = (value & 0xffn) | ((value >> 12n) & ~0xffn);
  return `${major}:${minor}`;
}

export class UnencryptedArray extends Error {
  override readonly name = "UnencryptedArray";
}

/** The array's id, after proving every condition above; throws on any one missing. */
export async function requireEncryptedArray(
  paths: ArrayPaths,
  io: ArrayIo = hostArrayIo,
): Promise<string> {
  const id = await io.readArrayId(paths.arrayIdFile);
  if (!id)
    throw new UnencryptedArray(
      `The saved-state array is not prepared (no array id at ${paths.arrayIdFile}).`,
    );
  const array = await io.stat(paths.arrayIdFile);
  for (const root of [paths.jailRoot, paths.savedRoot]) {
    const info = await io.stat(root).catch(() => undefined);
    if (!info?.isDirectory()) throw new UnencryptedArray(`${root} is not a directory.`);
    if (info.dev !== array.dev)
      throw new UnencryptedArray(`${root} is not on the saved-state array.`);
    if (info.uid !== 0 || (info.mode & 0o077) !== 0)
      throw new UnencryptedArray(`${root} must be owned by root and closed to everyone else.`);
  }
  const uuid = await io.dmUuid(deviceName(array.dev));
  if (!uuid?.startsWith("CRYPT-"))
    throw new UnencryptedArray("The saved-state array is not on a dm-crypt device.");
  return id;
}
