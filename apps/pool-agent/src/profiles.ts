/**
 * Round G: a slot's profile disk, made and erased by the agent, the only party on the host (the
 * provisioner reaches a pool host only through the administration interface).
 *
 * The path is derived from the slot id alone, never from a path the provisioner sends: a file
 * under the profiles root named by a digest of the id, so no slot id reaches a file elsewhere
 * or another slot's. A profile that is there is kept exactly as it is and never formatted, so a
 * slot made again (a replaced host instance, at a higher term) finds the person's profile. A new
 * one is made under a temporary name and linked into place only once its filesystem is written,
 * so a failed make leaves nothing under the slot's name.
 */
import { createHash, randomBytes } from "node:crypto";
import { link, lstat, open, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { syncDirectory } from "@opensteer/shared/privateFiles";

const mib = 1024 * 1024;
const makingPrefix = ".making-";

export function profileFileName(slotId: string): string {
  return `slot-${createHash("sha256").update(slotId).digest("hex")}.ext4`;
}

export function profilePathFor(root: string, slotId: string): string {
  return join(root, profileFileName(slotId));
}

/** Round H: a new profile would make the profiles exceed the filesystem they are on. */
export class ProfilesFull extends Error {
  override readonly name = "ProfilesFull";
}

/** Writes a filesystem onto a new, empty file (the driver's is `mkfs.ext4`). */
export type ProfileFormatter = (file: string) => Promise<void>;

/** The slot's profile, made now (sparse, `sizeMib`, formatted) unless one is there already. */
export async function ensureProfile(
  root: string,
  slotId: string,
  sizeMib: number,
  format: ProfileFormatter,
  filesystemBytes?: () => Promise<number>,
): Promise<{ readonly path: string; readonly made: boolean }> {
  const path = profilePathFor(root, slotId);
  if (await present(path)) return { path, made: false };
  // Round H: the profiles' sizes together, with this one, stay inside their filesystem (the
  // files are sparse, so a filled-in profile still has the room it was given).
  if (filesystemBytes) {
    let total = sizeMib * mib;
    for (const entry of await readdir(root))
      if (/^slot-[0-9a-f]{64}\.ext4$/u.test(entry)) total += (await lstat(join(root, entry))).size;
    if (total > (await filesystemBytes()))
      throw new ProfilesFull(
        `A ${sizeMib} MiB profile would make this host's profiles exceed their filesystem.`,
      );
  }
  const making = join(
    root,
    `${makingPrefix}${profileFileName(slotId)}-${randomBytes(6).toString("hex")}`,
  );
  try {
    const handle = await open(making, "wx", 0o600);
    try {
      await handle.truncate(sizeMib * mib);
    } finally {
      await handle.close();
    }
    await format(making);
    const written = await open(making, "r+");
    try {
      await written.sync();
    } finally {
      await written.close();
    }
    // `link` never replaces a file that appeared meanwhile; the temporary name goes after.
    await link(making, path);
  } finally {
    await rm(making, { force: true });
  }
  await syncDirectory(root);
  return { path, made: true };
}

/** Removes the profile at `path`, which must be directly under `root`; resolves once it is gone. */
export async function eraseProfile(root: string, path: string): Promise<void> {
  if (dirname(path) !== root) throw new Error(`${path} is not a profile under ${root}.`);
  // A link is removed as a link: nothing outside the root is followed.
  await rm(path, { force: true });
  await syncDirectory(root);
  if (await present(path)) throw new Error(`The profile ${path} is still there.`);
}

/**
 * Round G, B: removes files a slot named under `root` (its upstream credentials). Each must be
 * a plain file whose directory is inside `root`; one already gone counts as gone. Resolves once
 * every one is seen gone.
 */
export async function eraseFilesUnder(root: string, files: readonly string[]): Promise<void> {
  const base = await realpath(root);
  for (const file of files) {
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) continue;
    const directory = await realpath(dirname(file));
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      !`${directory}${sep}`.startsWith(`${base}${sep}`)
    )
      throw new Error(`${file} is not a plain file under ${root}.`);
    await rm(file, { force: true });
    await syncDirectory(directory);
    if (await present(file)) throw new Error(`${file} is still there.`);
  }
}

/** Temporary files a make that crashed left behind: never a profile, so always removed. */
export async function sweepUnfinishedProfiles(root: string): Promise<readonly string[]> {
  const entries = await readdir(root).catch(() => [] as string[]);
  const swept = entries.filter((entry) => entry.startsWith(makingPrefix));
  for (const entry of swept) await rm(join(root, entry), { force: true });
  return swept;
}

async function present(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}
