import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compatibility, forbidden } from "./renames.mjs";

export async function checkNames(root) {
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const [project, first, last] = forbidden.map(escape);
  const excluded = new Set([
    "THIRD_PARTY_NOTICES.md",
    "scripts/plugin-engine/renames.mjs",
    "vendor/plugin-engine/apps/src/published-compat.ts",
    "vendor/plugin-engine/catalog/src/published-compat.ts",
  ]);
  const scopes = [
    [`@${project}(?:-js|[.])|${project}[.](?:sh|community)(?:/|["'])|${first}[ -]${last}`, [""]],
    [
      forbidden.map(escape).join("|"),
      ["vendor/plugin-engine/", "scripts/plugin-engine/", "patches/"],
    ],
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
  // Tracked and unignored files, the set a search honouring .gitignore would visit.
  const listed = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (listed.error) throw listed.error;
  if (listed.status !== 0) throw new Error(listed.stderr || "Could not enumerate repository files");
  const files = listed.stdout
    .split("\0")
    .filter((path) => path && statSync(join(root, path), { throwIfNoEntry: false })?.isFile());
  violations.push(
    ...files.filter(
      (path) =>
        (path.startsWith("vendor/plugin-engine/") || path.startsWith("scripts/plugin-engine/")) &&
        allNames.test(path),
    ),
  );
  const patterns = scopes.map(([pattern, prefixes]) => [new RegExp(pattern, "i"), prefixes]);
  for (const path of files) {
    if (excluded.has(path)) continue;
    const applicable = patterns.filter(([, prefixes]) =>
      prefixes.some((prefix) => path.startsWith(prefix)),
    );
    if (!applicable.length) continue;
    const source = readFileSync(join(root, path), "utf8");
    if (source.includes("\0")) continue;
    source.split("\n").forEach((line, index) => {
      if (applicable.some(([pattern]) => pattern.test(line)))
        violations.push(`${path}:${index + 1}`);
    });
  }
  if (violations.length)
    throw new Error("Forbidden imported identity: " + [...new Set(violations)].join(", "));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await checkNames(resolve(import.meta.dirname, "../.."));
  console.log("Plugin engine naming check passed");
}
