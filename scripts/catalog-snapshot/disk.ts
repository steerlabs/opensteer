/**
 * The disk side of the catalog tools: where they may write, reading a directory as plain files
 * only, replacing a snapshot only once its replacement is complete, and assembling a release.
 */
import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { cacheHeaders, publishedManifest, snapshotPathKind, snapshotProblems } from "./core.ts";

/** A path with every existing part resolved through symlinks, as a write to it would land. */
export async function realTarget(path: string): Promise<string> {
  const absolute = resolve(path);
  const rest: string[] = [];
  for (let current = absolute; ; current = dirname(current)) {
    try {
      return join(await realpath(current), ...rest.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(current) === current)
        throw error;
      rest.push(basename(current));
    }
  }
}

const inside = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * Resolve each named place and refuse any inside the repository (public; plugin source is not
 * ours to publish there) or overlapping another place.
 */
export async function separatePlaces<K extends string>(
  places: Record<K, string>,
  repository: string,
): Promise<Record<K, string>> {
  const root = await realpath(repository);
  const resolved = {} as Record<K, string>;
  for (const key of Object.keys(places) as K[]) {
    const real = await realTarget(places[key]);
    if (inside(real, root) || inside(root, real))
      throw new Error(`--${key} ${real} is inside the repository; keep catalog files outside it`);
    for (const other of Object.keys(resolved) as K[])
      if (inside(real, resolved[other]) || inside(resolved[other], real))
        throw new Error(`--${key} ${real} overlaps --${other} ${resolved[other]}`);
    resolved[key] = real;
  }
  return resolved;
}

/**
 * Write `path` whole: the bytes go to a new file with a unique name beside it, created
 * exclusively (an existing entry, a symlink included, fails it and is never followed), which is
 * then renamed over `path`. The directory is created if missing and must be its own real path, so
 * nothing on the way to it is a symlink.
 */
export async function writeFileAtomic(path: string, bytes: Uint8Array) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  if ((await realpath(directory)) !== directory)
    throw new Error(`${directory} is reached through a symlink; nothing is written there`);
  const part = join(directory, `.${basename(path)}.${randomUUID()}.part`);
  try {
    await writeFile(part, bytes, { flag: "wx" });
    await rename(part, path);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
}

/** Whether process `pid` is running (one owned by another user counts). */
function running(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Hold `path` as an exclusive lock for `what` until the returned release is called. The lock file
 * holds this process's PID, its start time and a token; it is written whole to a unique file and
 * then linked to `path`, which fails if `path` exists, so a reader never sees half of one. A lock
 * whose process is running is refused, naming it. One whose process has ended is taken over, and
 * `log` says so: it is renamed away, then checked to be the lock that was judged stale before it is
 * removed, so two runs taking over the same stale lock cannot both succeed.
 */
export async function holdLock(
  path: string,
  what: string,
  log: (line: string) => void,
): Promise<() => Promise<void>> {
  const mine = JSON.stringify({
    pid: process.pid,
    started: new Date().toISOString(),
    token: randomUUID(),
  });
  const part = `${path}.${randomUUID()}.part`;
  await writeFile(part, mine, { flag: "wx" });
  try {
    for (;;) {
      try {
        await link(part, path);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      let held: string;
      try {
        held = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // released meanwhile
        throw error;
      }
      let holder: { pid?: unknown; started?: unknown } = {};
      try {
        holder = JSON.parse(held) as typeof holder;
      } catch {
        // Not a lock this tool wrote.
      }
      if (typeof holder.pid !== "number" || running(holder.pid))
        throw new Error(
          `${what} is in use by process ${String(holder.pid)}, started ${String(holder.started)} (lock ${path}). ` +
            `Wait for it to finish; if no such run is going, remove ${path}.`,
        );
      const stale = `${path}.${randomUUID()}.stale`;
      try {
        await rename(path, stale);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if ((await readFile(stale, "utf8")) !== held) {
        // Another run took the lock over first; give its lock back and refuse.
        await link(stale, path).catch(() => {});
        await rm(stale, { force: true });
        throw new Error(`${what} is in use by another run (lock ${path})`);
      }
      await rm(stale, { force: true });
      log(
        `took over the lock ${path} from process ${holder.pid} (started ${String(holder.started)}), which is no longer running`,
      );
    }
  } finally {
    await rm(part, { force: true });
  }
  return async () => {
    if ((await readFile(path, "utf8").catch(() => undefined)) === mine) await rm(path);
  };
}

/** Refuse a directory that holds a symlink or anything else that is not a file or directory. */
export async function refuseLinks(directory: string) {
  const refused: string[] = [];
  const walk = async (folder: string) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (!entry.isFile()) refused.push(relative(directory, path));
    }
  };
  if (!(await lstat(directory)).isDirectory()) throw new Error(`${directory} is not a directory`);
  await walk(directory);
  if (refused.length > 0)
    throw new Error(
      `${directory} holds entries that are not regular files (symlinks are refused): ${refused.sort().join(", ")}`,
    );
}

/** Every file under a directory, by relative path. A symlink or any non-regular entry is refused. */
export async function readTree(directory: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const refused: string[] = [];
  const walk = async (folder: string) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      const name = relative(directory, path).split(sep).join("/");
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        // The entry was a regular file when listed; read it only if it still is.
        const before = await lstat(path);
        const bytes = await readFile(path);
        if (!before.isFile() || before.size !== bytes.byteLength) refused.push(name);
        else files.set(name, new Uint8Array(bytes));
      } else refused.push(name);
    }
  };
  if (!(await lstat(directory)).isDirectory()) throw new Error(`${directory} is not a directory`);
  await walk(directory);
  if (refused.length > 0)
    throw new Error(
      `${directory} holds entries that are not regular files (symlinks are refused): ${refused.sort().join(", ")}`,
    );
  return files;
}

/** Write files into a directory that must not hold any of them yet. */
export async function writeTree(directory: string, files: ReadonlyMap<string, Uint8Array>) {
  for (const [path, bytes] of files) {
    const target = join(directory, ...path.split("/"));
    if (!inside(target, directory)) throw new Error(`${path} would leave ${directory}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
  }
}

const stagingPrefix = (target: string) => `.${basename(target)}.staging-`;
/** Where an earlier `target` waits while its replacement is renamed into place. */
export const asideOf = (target: string) => join(dirname(target), `.${basename(target)}.previous`);
/** The lock a run writing `target` holds from before `recoverBeside` until after its swap. */
export const lockOf = (target: string) => join(dirname(target), `.${basename(target)}.lock`);

/** A new, empty directory of its own beside `target`, for building its replacement. */
export const stagingBeside = (target: string) =>
  mkdtemp(join(dirname(target), stagingPrefix(target)));

/**
 * Before writing `target`: create its parent, refuse a mount root (it cannot be renamed), and
 * finish an interrupted replacement. When `target` is missing and an earlier one waits aside, the
 * swap stopped between its two renames, so the earlier one is put back; one left aside beside a
 * present `target` is the end of a swap that completed. Staging directories from a stopped run are
 * removed. Returns what it did, to say. Call it only while holding `lockOf(target)`: otherwise the
 * staging directory and set-aside snapshot of a run still going would look like leftovers.
 */
export async function recoverBeside(target: string): Promise<string[]> {
  const done: string[] = [];
  const parent = dirname(target);
  if (parent === target) throw new Error(`${target} is a mount root; choose a directory inside it`);
  await mkdir(parent, { recursive: true });
  const present = await lstat(target).then(
    (entry) => entry,
    () => undefined,
  );
  if (present !== undefined && present.dev !== (await stat(parent)).dev)
    throw new Error(`${target} is a mount root; choose a directory inside it`);
  const aside = asideOf(target);
  if (
    await lstat(aside).then(
      () => true,
      () => false,
    )
  ) {
    if (present === undefined) {
      await rename(aside, target);
      done.push(
        `${target} was missing after an interrupted swap; the earlier snapshot was put back`,
      );
    } else {
      await rm(aside, { recursive: true, force: true });
      done.push(`removed ${aside}, left by a swap that completed`);
    }
  }
  for (const entry of await readdir(parent))
    if (entry.startsWith(stagingPrefix(target))) {
      await rm(join(parent, entry), { recursive: true, force: true });
      done.push(`removed ${join(parent, entry)}, left by an interrupted run`);
    }
  return done;
}

/**
 * Put `staged` at `target` with two renames: an earlier `target` aside, then `staged` into place.
 * If the second fails, the earlier one is moved back; a run stopped between them is put right by
 * `recoverBeside`. The earlier one is removed once the replacement is in place.
 */
export async function replaceDirectory(target: string, staged: string) {
  const aside = asideOf(target);
  let moved = false;
  try {
    await rename(target, aside);
    moved = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await rename(staged, target);
  } catch (error) {
    if (moved) await rename(aside, target);
    throw error;
  }
  if (moved) await rm(aside, { recursive: true, force: true });
}

/** Read and check one snapshot directory, or throw with every problem. */
export async function readSnapshot(directory: string) {
  const files = await readTree(directory);
  const problems = snapshotProblems(files);
  if (problems.length > 0)
    throw new Error(
      `${directory} is not the snapshot its manifest describes:\n${problems.join("\n")}`,
    );
  return files;
}

/**
 * Assemble a release in `staging`: the snapshot's files under `public/`, its manifest recording
 * the publish time, plus the content-addressed documents and icons of the live release's
 * snapshot, so an index cached from it still resolves; then the Hosting configuration beside
 * `public/`, never in a snapshot. Every source is read as regular files only and checked against
 * its own manifest.
 */
export async function stageRelease(input: {
  readonly snapshot: string;
  readonly previous: readonly string[];
  readonly staging: string;
  readonly site: string;
  /** When this release is published, as an ISO time. */
  readonly published: string;
}) {
  const release = new Map(await readSnapshot(input.snapshot));
  release.set("manifest.json", publishedManifest(release.get("manifest.json")!, input.published));
  let retained = 0;
  for (const earlier of input.previous)
    for (const [path, bytes] of await readSnapshot(earlier)) {
      const kind = snapshotPathKind(path);
      if (kind !== "document" && kind !== "icon") continue;
      const present = release.get(path);
      if (present !== undefined && !Buffer.from(present).equals(bytes))
        throw new Error(`${path} differs between ${earlier} and the release`);
      if (present === undefined) retained++;
      release.set(path, bytes);
    }
  await writeTree(join(input.staging, "public"), release);
  const configuration = {
    hosting: {
      site: input.site,
      public: "public",
      // Upload exactly what was staged and checked.
      ignore: [],
      headers: cacheHeaders.map(({ source, value }) => ({
        source,
        headers: [{ key: "Cache-Control", value }],
      })),
    },
  };
  await writeFile(
    join(input.staging, "firebase.json"),
    JSON.stringify(configuration, null, 2) + "\n",
    { flag: "wx" },
  );
  return { files: release.size, retained, configuration };
}
