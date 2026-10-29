import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * The executable a person's shell would run for `command`: the first regular
 * file on `path` this process may execute. A relative PATH entry is skipped,
 * because it resolves against whatever directory the Runner runs in rather
 * than anything the person chose.
 */
export function findExecutableOnPath(
  command: string,
  path: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!path) return undefined;
  const names =
    platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((extension) => command + extension)
      : [command];
  for (const directory of path.split(platform === "win32" ? ";" : delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (platform !== "win32") accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Absent, unreadable or not executable: the shell would keep looking.
      }
    }
  }
  return undefined;
}

/**
 * Whether `version` is at least `minimum`, compared as dotted numbers. A build
 * suffix (`2026.09.15-d2fe57e`, `0.162.0-alpha.1`) says nothing about age, and
 * a version that does not parse is never accepted.
 */
export function meetsMinimumVersion(version: string, minimum: string): boolean {
  const parse = (value: string) =>
    (value.trim().split("-")[0] ?? "").split(".").map((part) => Number.parseInt(part, 10));
  const found = parse(version);
  const required = parse(minimum);
  if (found.length === 0 || found.some((part) => !Number.isFinite(part))) return false;
  for (const [index, expected] of required.entries()) {
    const actual = found[index];
    if (actual === undefined || !Number.isFinite(actual)) return false;
    if (actual !== expected) return actual > expected;
  }
  return true;
}
