/**
 * The disk side of the catalog tools: where they may write, reading a directory as plain files
 * only, replacing a snapshot only once its replacement is complete, and assembling a release.
 */
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { snapshotPathKind, snapshotProblems } from "./core.ts";

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

/** A new, empty directory of its own beside `target`, for building its replacement. */
export const stagingBeside = (target: string) =>
  mkdtemp(join(dirname(target), `.${basename(target)}.staging-`));

/**
 * Put `staged` at `target`. An earlier `target` is moved aside first and removed only once the
 * replacement is in place; if that fails, the earlier one is moved back.
 */
export async function replaceDirectory(target: string, staged: string) {
  let aside: string | undefined;
  try {
    await lstat(target);
    aside = join(
      await mkdtemp(join(dirname(target), `.${basename(target)}.previous-`)),
      "snapshot",
    );
    await rename(target, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await rename(staged, target);
  } catch (error) {
    if (aside !== undefined) {
      await rename(aside, target);
      await rm(dirname(aside), { recursive: true, force: true });
    }
    throw error;
  }
  if (aside !== undefined) await rm(dirname(aside), { recursive: true, force: true });
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

/** Cache lifetimes per path, as the Hosting configuration states them. */
export const cacheHeaders = [
  // The feed and its manifest change with every release: short, and revalidated.
  ["/index.json", "public, max-age=300, must-revalidate"],
  ["/manifest.json", "public, max-age=300, must-revalidate"],
  // Today's client reads `apps/<id>.json`, which changes with a release like the index.
  ["/apps/*.json", "public, max-age=300, must-revalidate"],
  // Content-addressed: a path's bytes never change.
  ["/apps/*/*.json", "public, max-age=31536000, immutable"],
  ["/icons/*", "public, max-age=31536000, immutable"],
] as const;

/**
 * Assemble a release in `staging`: the snapshot's files under `public/`, plus the
 * content-addressed documents and icons of each earlier snapshot, so an index cached from the
 * release before still resolves; then the Hosting configuration beside `public/`, never in a
 * snapshot. Every source is read as regular files only and checked against its own manifest.
 */
export async function stageRelease(input: {
  readonly snapshot: string;
  readonly previous: readonly string[];
  readonly staging: string;
  readonly site: string;
}) {
  const release = new Map(await readSnapshot(input.snapshot));
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
      headers: cacheHeaders.map(([source, value]) => ({
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
