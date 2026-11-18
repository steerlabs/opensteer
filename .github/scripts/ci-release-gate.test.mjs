import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { lanes } from "./ci-changes.mjs";
import { notReleaseGating, releaseGateStep, releaseGating } from "./ci-release-gate.mjs";

const ci = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const release = readFileSync(".github/workflows/release.yml", "utf8");
const gating = Object.keys(releaseGating);
const notGating = Object.keys(notReleaseGating);

test("every CI job is classified as release-gating or not, exactly once", () => {
  const jobs = Object.keys(ci.jobs).filter((name) => name !== "Check");
  assert.deepEqual([...gating, ...notGating].sort(), jobs.sort());
  assert.equal(new Set([...gating, ...notGating]).size, gating.length + notGating.length);
  // Check aggregates them all, and verifies every lane the plan selects.
  assert.deepEqual([...ci.jobs.Check.needs].sort(), jobs.sort());
  for (const lane of lanes) assert.ok(jobs.includes(lane), lane);
  for (const reason of [...Object.values(releaseGating), ...Object.values(notReleaseGating)])
    assert.match(reason, /\S/);
});

test("a job for a platform no release publishes does not gate", () => {
  assert.deepEqual(notGating, ["native-windows"]);
  // Publishing a Windows artifact means moving native-windows to releaseGating.
  assert.doesNotMatch(release, /windows|win32|\.exe\b|\.msi\b|nsis|appx/i);
});

test("Check verifies the gating jobs in a named step, then every job", () => {
  const steps = ci.jobs.Check.steps;
  const gate = steps.findIndex((step) => step.name === releaseGateStep);
  const all = steps.findIndex((step) => /^pnpm exec tsx scripts\/ci-check\.ts \S+$/.test(step.run));
  assert.ok(gate >= 0 && all > gate);
  assert.match(
    steps[gate].run,
    /scripts\/ci-check\.ts "\$RUNNER_TEMP\/evidence" --release-gating$/,
  );
  assert.equal(steps[all].if, "always()");
  assert.deepEqual(steps[gate].env, steps[all].env);
});
