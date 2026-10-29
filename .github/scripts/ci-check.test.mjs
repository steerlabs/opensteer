import { test } from "node:test";
import assert from "node:assert/strict";
import { validateResults } from "./ci-check.mjs";
import { lanes } from "./ci-changes.mjs";
const plan = { version: 1, lanes: Object.fromEntries(lanes.map((k) => [k, k === "lint"])) };
const results = {
  changes: {
    result: "success",
    outputs: Object.fromEntries(lanes.map((k) => [k, String(plan.lanes[k])])),
  },
  ...Object.fromEntries(lanes.map((k) => [k, { result: k === "lint" ? "success" : "skipped" }])),
};
test("docs-only explicit skips green", () =>
  assert.doesNotThrow(() => validateResults(plan, results, "pull_request")));
test("forced selected skip red", () =>
  assert.throws(() =>
    validateResults({ ...plan, lanes: { ...plan.lanes, tests: true } }, results, "pull_request"),
  ));
test("missing output red", () => {
  const r = structuredClone(results);
  delete r.changes.outputs.tests;
  assert.throws(() => validateResults(plan, r, "pull_request"));
});
test("main forbids skips and detector failure is red", () => {
  assert.throws(() => validateResults(plan, results, "push"));
  assert.throws(() =>
    validateResults(plan, { ...results, changes: { result: "failure" } }, "pull_request"),
  );
});
