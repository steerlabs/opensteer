import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { parse } from "yaml";
import { darwinTask } from "../.github/scripts/ci-changes.mjs";
import { timedOutLanes, validateResults } from "../.github/scripts/ci-check.mjs";
import { checkInventories } from "../.github/scripts/ci-inventories.mjs";
import { verifyReuse } from "../.github/scripts/ci-reuse.mjs";
import {
  darwinOnlyTests,
  realBrowserTests,
  windowsTestInclude,
} from "../.github/scripts/ci-test-files.mjs";
import { mergeLockGraphs, writeLockGraph } from "./ci-lock-merge.js";
const directory = process.argv[2]!;
// Each artifact downloads into its own folder, and each file is read only from the job that
// owns it: test code writes into its own lane's evidence, so a merged folder would let it
// replace the plan or another lane's inventory.
const owned = (artifact: string, name: string) =>
  join(directory, `${artifact}-${process.env.GITHUB_SHA}`, name);
const read = (artifact: string, name: string) =>
  JSON.parse(readFileSync(owned(artifact, name), "utf8"));
const plan = read("plan", "ci-plan.json");
const needs = JSON.parse(process.env.CI_NEEDS!) as Record<string, { result?: string }>;
validateResults(plan, needs, process.env.CI_EVENT, process.env.GITHUB_SHA, {
  timedOut: Object.values(needs).some((job) => job.result === "cancelled")
    ? await timeouts()
    : new Map(),
});
// A reused pull request run must still be green and have tested this exact tree and parent.
if (plan.reused) {
  await verifyReuse(plan.reused, {
    sha: process.env.GITHUB_SHA,
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
  });
  console.log(
    `${plan.reused.lanes.join(", ")} passed in pull request #${plan.reused.pullRequest} run ${plan.reused.run} on this tree`,
  );
}
/** Lanes this run attempt cut at their time limit; an unreadable API only loses the detail. */
async function timeouts() {
  try {
    const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
      jobs: Record<string, { "timeout-minutes"?: unknown }>;
    };
    const limits: Record<string, number> = {};
    for (const [name, job] of Object.entries(workflow.jobs))
      if (typeof job["timeout-minutes"] === "number") limits[name] = job["timeout-minutes"];
    const native = JSON.parse(readFileSync(".github/scripts/ci-native-mac.json", "utf8")) as {
      tasks: { task: string; timeout: number }[];
    };
    for (const { task, timeout } of native.tasks) limits[`native-mac (${task})`] = timeout;
    const { GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } = process.env;
    const response = await fetch(
      `${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT}/jobs?per_page=100`,
      { headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { jobs } = (await response.json()) as { jobs: Parameters<typeof timedOutLanes>[0] };
    return timedOutLanes(jobs, limits);
  } catch (error) {
    console.warn(`Could not tell timeouts from cancellations: ${String(error)}`);
    return new Map<string, string>();
  }
}
// Every shard discovered exactly the files the plan selected, and together ran them all.
for (const lane of ["tests", "integration"] as const) {
  if (!plan.lanes[lane]) continue;
  const count: number = plan.shards[lane];
  const inventories = Array.from({ length: count }, (_, i) =>
    read(`${lane}-${i + 1}`, `${lane}-${i + 1}.inventory.json`),
  );
  checkInventories(inventories, count, lane);
  if (
    JSON.stringify([...inventories[0].discovered].sort()) !==
    JSON.stringify([...plan.files[lane]].sort())
  )
    throw new Error(`${lane} discovery differs from the planned files`);
}
if (plan.lanes["browser-journeys"]) {
  const inventory = read("browser-journeys", "browser-1.inventory.json");
  checkInventories([inventory], 1, "browser");
  if (
    JSON.stringify([...inventory.discovered].sort()) !==
    JSON.stringify([...realBrowserTests].sort())
  )
    throw new Error("Browser discovery differs from the required files");
}
// One task runs the Darwin-only files; Swift-only tasks upload no inventory.
if (plan.nativeMac?.includes(darwinTask)) {
  const inventory = read(`native-mac-${darwinTask}`, "darwin-1.inventory.json");
  checkInventories([inventory], 1, "darwin");
  if (
    JSON.stringify([...inventory.discovered].sort()) !== JSON.stringify([...darwinOnlyTests].sort())
  )
    throw new Error("Darwin discovery differs from the required files");
}
// The Windows lane must have run every tracked Windows-real file, and at least one.
if (plan.lanes["native-windows"]) {
  const inventory = read("native-windows", "windows-1.inventory.json");
  checkInventories([inventory], 1, "windows");
  const expected = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter((file) => windowsTestInclude.some((glob) => matchesGlob(file, glob)))
    .sort();
  if (
    !expected.length ||
    JSON.stringify([...inventory.discovered].sort()) !== JSON.stringify(expected)
  )
    throw new Error("Windows discovery differs from the tracked Windows-real files");
}
if (plan.lanes.integration) {
  writeLockGraph(
    join(directory, "combined-lock-graph.json"),
    mergeLockGraphs(
      Array.from({ length: plan.shards.integration }, (_, i) =>
        owned(`integration-${i + 1}`, `integration-${i + 1}.jsonl.graph.json`),
      ),
    ),
  );
}
