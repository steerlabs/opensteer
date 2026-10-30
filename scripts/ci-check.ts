import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { darwinTask } from "../.github/scripts/ci-changes.mjs";
import { validateResults } from "../.github/scripts/ci-check.mjs";
import { checkInventories } from "../.github/scripts/ci-inventories.mjs";
import { darwinOnlyTests } from "../.github/scripts/ci-test-files.mjs";
import { mergeLockGraphs } from "./ci-lock-merge.js";
const directory = process.argv[2]!;
const read = (name: string) => JSON.parse(readFileSync(join(directory, name), "utf8"));
const plan = read("ci-plan.json");
const shards = JSON.parse(
  readFileSync(new URL("../.github/scripts/ci-shards.json", import.meta.url), "utf8"),
) as { tests: number; integration: number };
validateResults(
  plan,
  JSON.parse(process.env.CI_NEEDS!),
  process.env.CI_EVENT,
  process.env.GITHUB_SHA,
);
for (const [lane, count] of [
  ["tests", shards.tests],
  ["integration", shards.integration],
] as const) {
  if (!plan.lanes[lane]) continue;
  checkInventories(
    Array.from({ length: count }, (_, i) => read(`${lane}-${i + 1}.inventory.json`)),
    count,
    lane,
  );
}
// One task runs the Darwin-only files; Swift-only tasks upload no inventory.
if (plan.nativeMac?.includes(darwinTask)) {
  const inventory = read("darwin-1.inventory.json");
  checkInventories([inventory], 1, "darwin");
  if (
    JSON.stringify([...inventory.discovered].sort()) !== JSON.stringify([...darwinOnlyTests].sort())
  )
    throw new Error("Darwin discovery differs from the required files");
}
if (plan.lanes.integration) {
  const merged = mergeLockGraphs(
    Array.from({ length: shards.integration }, (_, i) =>
      join(directory, `integration-${i + 1}.jsonl.graph.json`),
    ),
  );
  writeFileSync(
    join(directory, "combined-lock-graph.json"),
    JSON.stringify(merged, null, 2) + "\n",
  );
}
