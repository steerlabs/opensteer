/**
 * A copy of a Personal Deployment's stopped PostgreSQL cluster, taken on the
 * first start of a new app version, before its Host migrates. It is a safety
 * net, never a gate: the restore is manual (docs/releases.md#personal-database-snapshots),
 * and on APFS the copy is a clone, so it costs nearly no space until the live
 * database changes and guards against a bad migration, not a failing disk.
 */
import { constants } from "node:fs";
import { cp, lstat, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { replacePrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { ensurePrivateDirectory } from "@opensteer/shared/privateFiles";
import type { PersonalRuntimeIdentity } from "../secrets/personal-deployment-store.js";

export const retainedDatabaseSnapshots = 3;
const metadataName = "snapshot.json";

/**
 * Clones `dataDirectory` into `<deploymentRoot>/snapshots/<UTC>-<fromVersion>/postgres`
 * and commits it by writing `snapshot.json` last, then keeps the newest three.
 * The cluster must already be stopped; a running one is refused.
 */
export async function snapshotDatabase(input: {
  readonly deploymentRoot: string;
  readonly dataDirectory: string;
  readonly fromRelease: PersonalRuntimeIdentity;
  readonly toRelease: PersonalRuntimeIdentity;
  readonly createdAt: Date;
}): Promise<string> {
  const snapshots = path.join(input.deploymentRoot, "snapshots");
  await ensurePrivateDirectory(snapshots);
  await removeIncompleteSnapshots(snapshots);
  await assertStopped(input.dataDirectory);
  const name = `${input.createdAt.toISOString().replace(/[-:]|\.[0-9]+/gu, "")}-${input.fromRelease.hostVersion}`;
  const directory = path.join(snapshots, name);
  try {
    await cp(input.dataDirectory, path.join(directory, "postgres"), {
      errorOnExist: true,
      force: false,
      // Clones on APFS. Node has no forced clone on macOS (libuv answers ENOSYS);
      // elsewhere this is a plain copy, and a full disk fails it like any error.
      mode: constants.COPYFILE_FICLONE,
      recursive: true,
      verbatimSymlinks: true,
    });
    await replacePrivateFileAtomically(
      path.join(directory, metadataName),
      `${JSON.stringify(
        {
          createdAt: input.createdAt.toISOString(),
          fromRelease: input.fromRelease,
          toRelease: input.toRelease,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
  const complete = (await snapshotNames(snapshots)).filter((entry) => entry !== name);
  for (const stale of complete
    .sort()
    .toReversed()
    .slice(retainedDatabaseSnapshots - 1)) {
    await rm(path.join(snapshots, stale), { force: true, recursive: true });
  }
  return name;
}

/** A directory without `snapshot.json` is a copy that never finished. */
export async function removeIncompleteSnapshots(snapshots: string): Promise<void> {
  const complete = new Set(await snapshotNames(snapshots));
  for (const entry of await entries(snapshots)) {
    if (!complete.has(entry))
      await rm(path.join(snapshots, entry), { force: true, recursive: true });
  }
}

async function snapshotNames(snapshots: string): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await entries(snapshots)) {
    if (await isFile(path.join(snapshots, entry, metadataName))) names.push(entry);
  }
  return names;
}

async function entries(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return [];
    throw error;
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await lstat(file)).isFile();
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/** A postmaster that still runs would be copied mid-write; a stale pid file after a crash is fine. */
async function assertStopped(dataDirectory: string): Promise<void> {
  let pidFile: string;
  try {
    pidFile = await readFile(path.join(dataDirectory, "postmaster.pid"), "utf8");
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return;
    throw error;
  }
  const pid = Number(pidFile.split("\n", 1)[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (nodeErrorCode(error) === "ESRCH") return;
    throw error;
  }
  throw new Error("PostgreSQL is still running.");
}
