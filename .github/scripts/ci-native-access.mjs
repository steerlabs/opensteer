/**
 * Fails when a native-mac task's tests read, list or launch a repository file its
 * inputs do not cover, so a change to that file could skip the task unseen.
 *   node .github/scripts/ci-native-access.mjs <trace.jsonl> <task>
 * The trace comes from ci-access-trace.mjs. Files no input can name do not count:
 * node_modules (the lockfile covers them), paths outside the checkout, and
 * untracked build output, which a step makes from tracked inputs.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { nativeMacInputs } from "./ci-changes.mjs";

const root = resolve(import.meta.dirname, "../..");
const kinds = new Set(["read", "list", "copy", "exec", "shell"]);
const under = (file, input) => file === input || file.startsWith(`${input}/`);

export function parseAccessTrace(file) {
  const records = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const record = JSON.parse(line);
      if (
        !kinds.has(record?.kind) ||
        typeof record.path !== "string" ||
        typeof record.cwd !== "string"
      )
        throw new Error(`Malformed access record: ${line}`);
      return record;
    });
  if (!records.length) throw new Error(`${file} recorded no access; the tracer did not load`);
  return records;
}

/** Repository paths `record` names, relative to `checkout`, with symlinks resolved. */
function named(record, checkout) {
  const words = record.kind === "shell" ? record.path.split(/\s+/u).filter(Boolean) : [record.path];
  return words.flatMap((word) => {
    let path = resolve(record.cwd, word);
    try {
      path = realpathSync(path);
    } catch {
      // Gone or never there: judged by name.
    }
    const file = relative(checkout, path);
    if (!file || file.startsWith("..") || isAbsolute(file)) return file === "" ? ["."] : [];
    if (file.split("/").includes("node_modules") || file.split("/")[0] === ".git") return [];
    return [file];
  });
}

export function uncoveredAccesses(records, { root: checkout = root, tracked, inputs }) {
  const covered = (file) => inputs.some((input) => under(file, input));
  const holdsTracked = (directory) => [...tracked].some((file) => file.startsWith(`${directory}/`));
  const uncovered = new Set();
  for (const record of records)
    for (const file of named(record, checkout)) {
      // A listing changes when any file under it does, so only a listed directory
      // inside an input is covered; a copied directory reads every file under it.
      const counts =
        record.kind === "list" ||
        tracked.has(file) ||
        (record.kind === "copy" && holdsTracked(file));
      if (counts && !covered(file)) uncovered.add(`${record.kind} ${file}`);
    }
  return [...uncovered].sort();
}

export function checkAccessTrace(file, task) {
  const records = parseAccessTrace(file);
  const tracked = new Set(
    execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0"),
  );
  return uncoveredAccesses(records, { tracked, inputs: nativeMacInputs(task) });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [file, task] = process.argv.slice(2);
  if (!file || !task) throw new Error("Usage: ci-native-access.mjs <trace.jsonl> <task>");
  const uncovered = checkAccessTrace(file, task);
  if (uncovered.length) {
    console.error(
      `${task} read or launched files its inputs do not cover; add them to its extra or ` +
        `scripts in .github/scripts/ci-native-mac.json:\n${uncovered.join("\n")}`,
    );
    process.exitCode = 1;
  } else console.info(`${task}: every file its tests read or launched is an input`);
}
