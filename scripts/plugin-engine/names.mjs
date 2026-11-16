import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compatibility, forbidden } from "./renames.mjs";

export async function checkNames(root) {
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const [project, first, last] = forbidden.map(escape);
  const common = [
    "--hidden",
    "--line-number",
    "--ignore-case",
    "--glob",
    "!.git/**",
    "--glob",
    "!node_modules/**",
    "--glob",
    "!THIRD_PARTY_NOTICES.md",
    "--glob",
    "!scripts/plugin-engine/renames.mjs",
    "--glob",
    "!vendor/plugin-engine/apps/src/published-compat.ts",
    "--glob",
    "!vendor/plugin-engine/catalog/src/published-compat.ts",
  ];
  const scopes = [
    [`@${project}(?:-js|[.])|${project}[.](?:sh|community)(?:/|["'])|${first}[ -]${last}`, ["."]],
    [forbidden.map(escape).join("|"), ["vendor/plugin-engine", "scripts/plugin-engine", "patches"]],
  ];
  const violations = [];
  const allNames = new RegExp(forbidden.map(escape).join("|"), "i");
  for (const [file, values] of [
    [
      "vendor/plugin-engine/apps/src/published-compat.ts",
      { ...compatibility.apps, ...compatibility.sdk },
    ],
    ["vendor/plugin-engine/catalog/src/published-compat.ts", compatibility.catalog],
  ]) {
    const remaining = Object.values(values).reduce(
      (source, value) => source.replaceAll(JSON.stringify(value), '""'),
      readFileSync(join(root, file), "utf8"),
    );
    if (allNames.test(remaining)) violations.push(file);
  }
  const inventory = spawnSync(
    "rg",
    ["--files", "--hidden", "vendor/plugin-engine", "scripts/plugin-engine"],
    { cwd: root, encoding: "utf8" },
  );
  if (inventory.error) throw inventory.error;
  if (inventory.status !== 0)
    throw new Error(inventory.stderr || "Could not enumerate imported paths");
  violations.push(...inventory.stdout.split("\n").filter((path) => allNames.test(path)));
  for (const [pattern, paths] of scopes) {
    const result = spawnSync("rg", [...common, "--", pattern, ...paths], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1)
      throw new Error(result.stderr || `Naming search exited ${result.status}`);
    if (result.stdout)
      violations.push(
        ...result.stdout
          .trim()
          .split("\n")
          .map((line) => line.split(":").slice(0, 2).join(":")),
      );
  }
  if (violations.length)
    throw new Error("Forbidden imported identity: " + [...new Set(violations)].join(", "));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await checkNames(resolve(import.meta.dirname, "../.."));
  console.log("Plugin engine naming check passed");
}
