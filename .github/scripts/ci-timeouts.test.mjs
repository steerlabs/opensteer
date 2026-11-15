import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

// A timeout catches a hang, not a slow runner: a job cut at 1.2 times its usual runtime
// once failed main CI and blocked a release. Refresh the recorded times with
// `pnpm exec tsx scripts/ci-timeouts.ts`; `runs: 0` marks a new job's estimate.
const recorded = JSON.parse(readFileSync(".github/scripts/ci-job-durations.json", "utf8"));
const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const native = JSON.parse(readFileSync(".github/scripts/ci-native-mac.json", "utf8"));
const limits = [
  ...Object.entries(workflow.jobs)
    .filter(([name]) => name !== "native-mac")
    .map(([name, job]) => [name, job["timeout-minutes"]]),
  ...native.tasks.map(({ task, timeout }) => [`native-mac (${task})`, timeout]),
];

test("every CI job's time limit is at least twice its recorded p95", () => {
  for (const [name, limit] of limits) {
    assert.ok(Number.isInteger(limit), `${name} needs a numeric timeout-minutes`);
    const entry = recorded[name];
    assert.ok(entry, `${name} has no recorded duration`);
    assert.ok(limit >= 2 * entry.p95, `${name}: ${limit} min < 2 × p95 ${entry.p95} min`);
  }
});
test("the native-mac job takes its time limit from its task", () => {
  assert.equal(workflow.jobs["native-mac"]["timeout-minutes"], "${{ matrix.timeout }}");
});
