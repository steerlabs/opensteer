import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readGraph, parseDiff } from "../.github/scripts/ci-changes.mjs";
import { localPlan } from "../.github/scripts/local-check.mjs";

const root = resolve(import.meta.dirname, "..");
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
export function changedPlan(base: string) {
  try {
    const ancestor = git("merge-base", "HEAD", base).trim();
    const files = [
      ...new Set([
        ...parseDiff(git("diff", "--name-only", "--no-renames", "-z", ancestor)),
        ...parseDiff(git("ls-files", "--others", "--exclude-standard", "-z")),
      ]),
    ];
    const present = parseDiff(
      git("ls-files", "--cached", "--others", "--exclude-standard", "-z"),
    ).filter((file: string) => existsSync(resolve(root, file)));
    return localPlan(files, readGraph(root), present, readGraph(root, ancestor));
  } catch (error) {
    const plan = localPlan(["unknown"], [], []);
    plan.reasons.push(String(error));
    return plan;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({
    options: { base: { type: "string", default: "origin/main" }, "dry-run": { type: "boolean" } },
  });
  const plan = changedPlan(values.base!);
  console.log(JSON.stringify(plan, null, 2));
  if (!plan.tests.length)
    console.log(
      "No changed or sibling tests selected; provide a focused journey for behavior changes.",
    );
  if (!values["dry-run"])
    for (const args of plan.commands) {
      const result = spawnSync("pnpm", args, { cwd: root, stdio: "inherit" });
      if (result.status !== 0) {
        process.exitCode = result.status ?? 1;
        break;
      }
    }
}
