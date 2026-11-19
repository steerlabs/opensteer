/**
 * A copy of a Personal Deployment's stopped PostgreSQL cluster, taken on the
 * first start of a new app version, before its Host migrates. The restore is
 * manual (docs/releases.md), and on APFS the copy is a clone, so it costs
 * nearly no space until the live database changes and guards against a bad
 * migration, not a failing disk.
 *
 * Until this Deployment has once started healthy on an app that converts
 * Personal state (migration 0036), the copy is a gate and is pinned: no copy,
 * no update, and later updates do not age it out until that first healthy
 * start writes the converted marker.
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
const convertedMarker = "personal-state-converted";

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
  /** Kept past the newest three until the converted marker exists. */
  readonly pinned?: boolean;
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
          ...(input.pinned ? { pinned: true } : {}),
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
  const keepPinned = !(await personalStateConverted(input.deploymentRoot));
  const complete: string[] = [];
  for (const entry of await snapshotNames(snapshots)) {
    if (entry === name) continue;
    if (keepPinned && (await readMetadata(snapshots, entry))?.pinned === true) continue;
    complete.push(entry);
  }
  for (const stale of complete
    .sort()
    .toReversed()
    .slice(retainedDatabaseSnapshots - 1)) {
    await rm(path.join(snapshots, stale), { force: true, recursive: true });
  }
  return name;
}

/** Whether this Deployment has started healthy since Personal state was converted. */
export async function personalStateConverted(deploymentRoot: string): Promise<boolean> {
  return isFile(path.join(deploymentRoot, convertedMarker));
}

/** The first healthy start after conversion releases the pinned copy to normal retention. */
export async function markPersonalStateConverted(deploymentRoot: string): Promise<void> {
  if (await personalStateConverted(deploymentRoot)) return;
  await replacePrivateFileAtomically(path.join(deploymentRoot, convertedMarker), "converted\n");
}

/** The app version that wrote the newest pinned copy: the one that can open it. */
export async function pinnedSnapshotSourceVersion(deploymentRoot: string): Promise<string | null> {
  const snapshots = path.join(deploymentRoot, "snapshots");
  for (const entry of (await snapshotNames(snapshots)).sort().toReversed()) {
    const metadata = await readMetadata(snapshots, entry);
    if (metadata?.pinned === true) return metadata.fromRelease?.hostVersion ?? null;
  }
  return null;
}

async function readMetadata(
  snapshots: string,
  entry: string,
): Promise<{ pinned?: unknown; fromRelease?: { hostVersion?: string } } | null> {
  try {
    return JSON.parse(await readFile(path.join(snapshots, entry, metadataName), "utf8"));
  } catch {
    return null;
  }
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
