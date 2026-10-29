import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateResults } from "../.github/scripts/ci-check.mjs";
import { checkInventories } from "../.github/scripts/ci-inventories.mjs";
import { mergeLockGraphs } from "./ci-lock-merge.js";
const directory = process.argv[2]!;
const read = (name: string) => JSON.parse(readFileSync(join(directory, name), "utf8"));
const plan = read("ci-plan.json");
validateResults(plan, JSON.parse(process.env.CI_NEEDS!), process.env.CI_EVENT);
for (const [lane, count] of [
  ["tests", 2],
  ["integration", 4],
] as const) {
  if (!plan.lanes[lane]) continue;
  checkInventories(
    Array.from({ length: count }, (_, i) => read(`${lane}-${i + 1}.inventory.json`)),
    count,
    lane,
  );
}
if (plan.lanes.integration) {
  const merged = mergeLockGraphs(
    Array.from({ length: 4 }, (_, i) => join(directory, `integration-${i + 1}.jsonl.graph.json`)),
  );
  writeFileSync(
    join(directory, "combined-lock-graph.json"),
    JSON.stringify(merged, null, 2) + "\n",
  );
}
