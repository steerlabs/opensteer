/**
 * The name guard. Upstream's identifying forms (its domains, package scope and author) and every
 * old string the rename rules replace are forbidden in the names and contents of all tracked
 * files. Its bare name, an ordinary English word elsewhere in Opensteer, and the other bare words
 * of `identity.pluginCode` are forbidden in the plugin engine's own code and the plugin Host code,
 * tests and docs. The forms come from packages/plugin-engine/upstream-names.json, the one file
 * besides THIRD_PARTY_NOTICES.md that may hold them.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dataFile = "packages/plugin-engine/upstream-names.json";
const exempt = new Set(["THIRD_PARTY_NOTICES.md", dataFile]);
const pluginPrefixes = [
  "packages/plugin-engine/",
  "packages/plugin-source/",
  "apps/host/src/plugins/",
  "scripts/plugin-engine/",
];

/** Plugin engine code, plugin Host code, and tests and docs about plugins. */
export const pluginScoped = (path) =>
  pluginPrefixes.some((prefix) => path.startsWith(prefix)) ||
  (basename(path).toLowerCase().includes("plugin") &&
    (path.startsWith("tests/") ||
      path.startsWith("docs/") ||
      /\.test(?:-support)?\.tsx?$/u.test(path)));

/** Any of `forms`, ignoring case, where it is not the start of a longer word (`.shutdown`). */
const pattern = (forms, whole = false) =>
  new RegExp(
    forms
      .map(
        (form) =>
          form.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") +
          (whole && /\w$/u.test(form) ? "(?!\\w)" : ""),
      )
      .join("|"),
    "iu",
  );

/** The forbidden patterns, from the data file at `root`. */
export function forbiddenNames(root) {
  const { identity, rules } = JSON.parse(readFileSync(join(root, dataFile), "utf8"));
  const bare = new Set(identity.pluginCode.map((word) => word.toLowerCase()));
  const old = rules.map((rule) => rule.from).filter((from) => !bare.has(from.toLowerCase()));
  return {
    everywhere: pattern([...identity.everywhere, ...new Set(old)], true),
    pluginCode: pattern(identity.pluginCode),
  };
}

/** Every violation in the tracked and unignored files at `root`, as `path` or `path:line`. */
export function nameViolations(root) {
  const { everywhere, pluginCode } = forbiddenNames(root);
  const listed = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (listed.error) throw listed.error;
  if (listed.status !== 0) throw new Error(listed.stderr || "Could not enumerate repository files");
  const violations = [];
  for (const path of new Set(listed.stdout.split("\0"))) {
    if (!path || exempt.has(path)) continue;
    if (!statSync(join(root, path), { throwIfNoEntry: false })?.isFile()) continue;
    const scoped = pluginScoped(path);
    const forbidden = (text) => everywhere.test(text) || (scoped && pluginCode.test(text));
    if (forbidden(path)) violations.push(path);
    const source = readFileSync(join(root, path), "utf8");
    if (source.includes("\0")) continue;
    source.split("\n").forEach((line, index) => {
      if (forbidden(line)) violations.push(`${path}:${index + 1}`);
    });
  }
  return violations;
}

export function checkNames(root) {
  const violations = nameViolations(root);
  if (violations.length > 0)
    throw new Error(`Upstream's names are forbidden here: ${violations.join(", ")}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  checkNames(resolve(import.meta.dirname, "../.."));
  console.log("Plugin engine naming check passed");
}
