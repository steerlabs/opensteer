/**
 * Round H: a slot's upstream credentials on a host that pulls them (`driver.requireEgressUpstream`).
 *
 * Their paths are derived from the slot id under the credentials root, as the profile's is, so a
 * delete finds them even for a slot the agent no longer knows. They are written under temporary
 * names and renamed into place in the same directory, root-owned (the agent is root), 0600, in a
 * root-only directory. They count as present only when all three are there: a crash between the
 * renames leaves a set that is fetched again whole, and a temporary file is never read.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDirectory, syncDirectory } from "@opensteer/shared/privateFiles";
import type { SlotEgress } from "./driver.js";
import type { SlotEgressAnswer } from "./slot-egress-fetch.js";

export function credentialFiles(
  root: string,
  slotId: string,
): { readonly url: string; readonly username: string; readonly password: string } {
  const base = `slot-${createHash("sha256").update(slotId).digest("hex")}`;
  return {
    url: join(root, `${base}.url`),
    username: join(root, `${base}.username`),
    password: join(root, `${base}.password`),
  };
}

/** The slot's credentials as its proxy is defined with them, or nothing unless all three are there. */
export async function readPulledEgress(
  root: string,
  slotId: string,
): Promise<SlotEgress | undefined> {
  const files = credentialFiles(root, slotId);
  for (const file of [files.url, files.username, files.password]) {
    const info = await lstat(file).catch(() => undefined);
    if (!info?.isFile()) return undefined;
  }
  return {
    upstreamUrl: (await readFile(files.url, "utf8")).trim(),
    usernameFile: files.username,
    passwordFile: files.password,
  };
}

/** The credentials root, made root-only; a symlink in its place is refused (round I, U8). */
export async function secureCredentialsRoot(root: string): Promise<void> {
  await ensurePrivateDirectory(root, "The credentials root must be a real directory.");
}

/**
 * Writes the slot's credentials as the account service gave them, unless they are already
 * there exactly (round I, U1: the host's are a copy, replaced when the answer changes).
 * True if anything was written.
 */
export async function writePulledEgress(
  root: string,
  slotId: string,
  egress: SlotEgressAnswer,
): Promise<boolean> {
  const files = credentialFiles(root, slotId);
  const read = (file: string) => readFile(file, "utf8").catch(() => undefined);
  if (
    (await read(files.url)) === egress.upstreamUrl &&
    (await read(files.username)) === egress.username &&
    (await read(files.password)) === egress.password
  )
    return false;
  await secureCredentialsRoot(root);
  // A replaced set stops counting as present first, so a crash mid-way never leaves an old
  // address with new credentials; the URL goes back last.
  await rm(files.url, { force: true });
  // The URL last: until it is in place the set does not count as present.
  for (const [file, text] of [
    [files.username, egress.username],
    [files.password, egress.password],
    [files.url, egress.upstreamUrl],
  ] as const) {
    const making = join(root, `.making-${randomBytes(8).toString("hex")}`);
    try {
      const handle = await open(making, "wx", 0o600);
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(making, file);
    } finally {
      await rm(making, { force: true });
    }
  }
  await syncDirectory(root);
  return true;
}
