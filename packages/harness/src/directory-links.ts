import { constants } from "node:fs";
import { copyFile, readlink, realpath, stat, symlink } from "node:fs/promises";
import path from "node:path";

/**
 * Links `linkPath` to the directory `target`. Windows gets a junction, which a
 * standard user may create without Developer Mode; it names an absolute local
 * target, and removing it removes the junction, never what it points at.
 */
export async function linkDirectory(
  target: string,
  linkPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === "win32") await symlink(path.win32.resolve(target), linkPath, "junction");
  else await symlink(target, linkPath, "dir");
}

/**
 * Places an immutable resource at `destination`. POSIX links it whatever it
 * is. Windows links a directory and copies a file, because a file link needs a
 * privilege a standard user does not hold.
 */
export async function materializeResource(
  source: string,
  destination: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== "win32") {
    await symlink(source, destination);
    return;
  }
  const resolved = await realpath(source);
  const details = await stat(resolved);
  if (details.isDirectory()) await linkDirectory(resolved, destination, platform);
  else if (details.isFile()) await copyFile(resolved, destination, constants.COPYFILE_EXCL);
  else throw new Error(`${source} is neither a file nor a directory`);
}

/** Whether the link at `linkPath` itself names `target`, without following any further link. */
export async function linkNames(
  linkPath: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const value = await readlink(linkPath);
  const named = (platform === "win32" ? path.win32 : path.posix).resolve(
    path.dirname(linkPath),
    value,
  );
  return sameLocalPath(named, target, platform);
}

/**
 * Whether two absolute paths name the same place. Windows compares drive paths
 * case-insensitively and reads a junction's `\\?\` or `\??\` form as the plain
 * drive path; any other form must match exactly.
 */
export function sameLocalPath(left: string, right: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return left === right;
  const [normalLeft, normalRight] = [windowsDrivePath(left), windowsDrivePath(right)];
  if (normalLeft === undefined || normalRight === undefined) return left === right;
  return normalLeft === normalRight;
}

function windowsDrivePath(value: string): string | undefined {
  const local = value.replace(/^(?:\\\\\?\\|\\\?\?\\)(?=[a-z]:[\\/])/iu, "");
  if (!/^[a-z]:[\\/]/iu.test(local)) return undefined;
  return path.win32.resolve(local).toUpperCase();
}
