/**
 * Writes .github/scripts/ci-native-inputs.json: for each native-mac task that runs
 * node, what its scripts and Vitest files statically import (the lane task also runs
 * the Darwin-only files, and Vitest loads its config). A workspace package counts
 * whole, manifest included, so a new module in it needs no regeneration. The
 * `changes` job stays dependency-free by reading this list;
 * tests/ci-native-inputs.test.ts fails when it is stale.
 *   pnpm exec tsx scripts/ci-native-inputs.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { z } from "zod";
import { darwinOnlyTests, defaultTestExclude } from "../.github/scripts/ci-test-files.mjs";

const root = path.resolve(import.meta.dirname, "..");
const configSchema = z.object({
  tasks: z.array(
    z.object({
      task: z.string(),
      scripts: z.array(z.string()).optional(),
      vitest: z.array(z.string()).optional(),
      lane: z.boolean().optional(),
    }),
  ),
});
export const nativeInputsPath = path.join(root, ".github/scripts/ci-native-inputs.json");

/** Everything `entries` statically import, from one build. */
async function bundled(entries: readonly string[]): Promise<string[]> {
  const result = await build({
    entryPoints: entries.map((entry) => path.join(root, entry)),
    // Several entries need an output directory; nothing is written.
    outdir: path.join(root, ".ci-native-inputs"),
    absWorkingDir: root,
    bundle: true,
    format: "esm",
    logLevel: "silent",
    metafile: true,
    platform: "node",
    write: false,
    plugins: [
      {
        // Workspace sources are inputs; installed packages are covered by the lockfile.
        name: "workspace-only",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, ({ path: specifier, kind }) =>
            kind === "entry-point" || /^(?:\.|\/|@opensteer\/)/u.test(specifier)
              ? undefined
              : { external: true },
          );
        },
      },
    ],
  });
  // A key can carry its import attributes: `data.json with { type: 'json' }`.
  return Object.keys(result.metafile.inputs)
    .map((file) => file.replace(/ with \{.*\}$/u, ""))
    .filter((file) => !file.includes("node_modules/"));
}

// Code that loads a file through createRequire names it only in a string, through a
// saved `require` or inline: `createRequire(import.meta.url)("./x.cjs")`.
const required =
  /(?:\brequire|\bcreateRequire\([^()]*\))\(\s*(["'])(\.{1,2}\/[^"']+)\1\s*,?\s*\)/gu;

/** Repository files `source`, at `file`, loads by a relative path through createRequire. */
export function requiredFiles(file: string, source: string): string[] {
  if (!source.includes("createRequire")) return [];
  return [...source.matchAll(required)].map(([, , specifier]) =>
    path.relative(root, path.resolve(root, path.dirname(file), specifier!)),
  );
}

/**
 * Everything `entries` import, statically or by a relative require through
 * createRequire, which a bundler cannot see; the required files' own requires follow.
 */
async function imports(entries: readonly string[]): Promise<string[]> {
  const pending = new Set(entries);
  let files: string[] = [];
  for (;;) {
    files = await bundled([...pending]);
    const more = files.flatMap((file) => {
      if (!/\.[cm]?[jt]sx?$/u.test(file)) return [];
      return requiredFiles(file, readFileSync(path.join(root, file), "utf8"));
    });
    const before = pending.size;
    for (const file of more) pending.add(file);
    if (pending.size === before) return files;
  }
}

export async function nativeInputs(): Promise<Record<string, string[]>> {
  const config = configSchema.parse(
    JSON.parse(readFileSync(path.join(root, ".github/scripts/ci-native-mac.json"), "utf8")),
  );
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  // An entry ending in "/" names the Vitest files `vitest run <directory>/` runs there.
  const testsIn = (entry: string) =>
    entry.endsWith("/")
      ? tracked.filter(
          (file) =>
            file.startsWith(entry) &&
            /\.test\.tsx?$/u.test(file) &&
            !defaultTestExclude.some((glob) => path.matchesGlob(file, glob)),
        )
      : [entry];
  // Vite and tsx compile each module with the tsconfig files above it, and what
  // those extend.
  const extended = (tsconfig: string): string[] => {
    const target = /"extends"\s*:\s*"([^"]+)"/u.exec(
      readFileSync(path.join(root, tsconfig), "utf8"),
    )?.[1];
    if (!target?.startsWith(".")) return [tsconfig];
    const file = path.join(path.dirname(tsconfig), target);
    return [tsconfig, ...(tracked.includes(file) ? extended(file) : [])];
  };
  const tsconfigs = (file: string) =>
    path
      .dirname(file)
      .split("/")
      .map((_, index, parts) => path.join(...parts.slice(0, index + 1), "tsconfig.json"))
      .concat("tsconfig.json")
      .filter((candidate) => tracked.includes(candidate))
      .flatMap(extended);
  const inputs: Record<string, string[]> = {};
  for (const { task, scripts = [], vitest = [], lane } of config.tasks) {
    const entries = [
      ...scripts,
      ...vitest.flatMap(testsIn),
      ...(lane ? darwinOnlyTests : []),
      ...(vitest.length || lane ? ["vitest.config.ts"] : []),
    ];
    if (!entries.length) continue;
    const files = new Set<string>();
    const collapse = (file: string) =>
      /^packages\/[^/]+\//u.test(file) ? file.split("/").slice(0, 2).join("/") : file;
    for (const file of await imports(entries)) {
      files.add(collapse(file));
      for (const tsconfig of tsconfigs(file)) files.add(collapse(tsconfig));
    }
    inputs[task] = [...files].sort((left, right) => left.localeCompare(right, "en"));
  }
  return inputs;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  writeFileSync(nativeInputsPath, JSON.stringify(await nativeInputs(), null, 2) + "\n");
  console.info(`Wrote ${path.relative(root, nativeInputsPath)}`);
}
