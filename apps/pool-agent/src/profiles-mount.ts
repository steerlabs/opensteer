/**
 * The profile disk must be the mount the agent was told to expect (`driver.profilesMount`). A
 * missing mount (never mounted, unmounted later, attached late) leaves `driver.profilesRoot` an
 * ordinary directory on the boot disk, where a create would make a fresh, empty profile under
 * the person's derived name and an erase would answer about the wrong file.
 *
 * The check makes no privileged call:
 * - the root is a directory on a different device than its parent (a mount point);
 * - with a label, `/dev/disk/by-label/<label>` is that device;
 * - the root is writable.
 */
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface ProfilesMountExpectation {
  /** The filesystem's label, as the enrolment gives it: `osp-` and 12 hex characters. */
  readonly label?: string | undefined;
}

/** What the check reads; a test replaces it to make a mount come and go. */
export interface ProfilesMountIo {
  stat(path: string): Promise<{
    readonly dev: number | bigint;
    readonly rdev: number | bigint;
    isDirectory(): boolean;
  }>;
  access(path: string): Promise<void>;
}

export const systemMountIo: ProfilesMountIo = {
  stat: (path) => stat(path),
  access: (path) => access(path, constants.W_OK),
};

/** What is wrong with the profile disk, or undefined when it is the mount expected. */
export async function checkProfilesMount(
  root: string,
  expected: ProfilesMountExpectation,
  io: ProfilesMountIo = systemMountIo,
): Promise<string | undefined> {
  const path = resolve(root);
  const own = await io.stat(path).catch(() => undefined);
  if (!own?.isDirectory()) return `${path} is not a directory`;
  const parent = await io.stat(dirname(path)).catch(() => undefined);
  if (!parent || parent.dev === own.dev) return `${path} is not a mount point`;
  if (expected.label !== undefined) {
    const device = await io.stat(`/dev/disk/by-label/${expected.label}`).catch(() => undefined);
    if (!device || device.rdev !== own.dev)
      return `${path} is not the filesystem labelled ${expected.label}`;
  }
  const writable = await io.access(path).then(
    () => true,
    () => false,
  );
  if (!writable) return `${path} is not writable`;
  return undefined;
}
