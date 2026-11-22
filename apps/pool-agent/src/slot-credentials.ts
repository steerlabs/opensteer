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
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { setFileMode, syncDirectory } from "@opensteer/shared/privateFiles";
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

/** The credentials root, made root-only. */
export async function secureCredentialsRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await setFileMode(root, 0o700);
}

export async function writePulledEgress(
  root: string,
  slotId: string,
  egress: SlotEgressAnswer,
): Promise<void> {
  await secureCredentialsRoot(root);
  const files = credentialFiles(root, slotId);
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
}
