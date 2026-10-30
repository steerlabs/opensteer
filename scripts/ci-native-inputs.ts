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

async function imports(entry: string): Promise<string[]> {
  const result = await build({
    entryPoints: [path.join(root, entry)],
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
  return Object.keys(result.metafile.inputs).filter((file) => !file.includes("node_modules/"));
}

export async function nativeInputs(): Promise<Record<string, string[]>> {
  const config = configSchema.parse(
    JSON.parse(readFileSync(path.join(root, ".github/scripts/ci-native-mac.json"), "utf8")),
  );
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  // A directory names the Vitest files `vitest run <directory>` runs there.
  const testsIn = (entry: string) =>
    tracked.filter(
      (file) =>
        (file === entry || file.startsWith(`${entry}/`)) &&
        /\.test\.tsx?$/u.test(file) &&
        !defaultTestExclude.some((glob) => path.matchesGlob(file, glob)),
    );
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
    for (const script of entries)
      for (const file of await imports(script))
        files.add(/^packages\/[^/]+\//u.test(file) ? file.split("/").slice(0, 2).join("/") : file);
    inputs[task] = [...files].sort((left, right) => left.localeCompare(right, "en"));
  }
  return inputs;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  writeFileSync(nativeInputsPath, JSON.stringify(await nativeInputs(), null, 2) + "\n");
  console.info(`Wrote ${path.relative(root, nativeInputsPath)}`);
}
