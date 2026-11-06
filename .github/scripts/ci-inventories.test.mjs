import { test } from "node:test";
import assert from "node:assert/strict";
import { checkInventories } from "./ci-inventories.mjs";
const a = {
  version: 1,
  lane: "tests",
  shard: 1,
  total: 2,
  discovered: ["a", "b"],
  executed: ["a"],
};
const b = { ...a, shard: 2, executed: ["b"] };
test("exact union and disjoint execution", () =>
  assert.doesNotThrow(() => checkInventories([a, b], 2, "tests")));
test("missing corrupt overlap omitted extra mismatched discovery fail", () => {
  for (const set of [
    [a],
    [a, {}],
    [a, { ...b, executed: ["a", "b"] }],
    [a, { ...b, executed: [] }],
    [a, { ...b, executed: ["c"] }],
    [a, { ...b, discovered: ["b"] }],
  ])
    assert.throws(() => checkInventories(set, 2, "tests"));
});

test("the unsharded browser inventory rejects missing, duplicate, omitted and extra execution", async () => {
  const { realBrowserTests } = await import("./ci-test-files.mjs");
  const record = {
    version: 1,
    lane: "browser",
    shard: 1,
    total: 1,
    discovered: realBrowserTests,
    executed: realBrowserTests,
  };
  assert.doesNotThrow(() => checkInventories([record], 1, "browser"));
  for (const executed of [
    [],
    realBrowserTests.slice(1),
    [...realBrowserTests, realBrowserTests[0]],
    [...realBrowserTests, "extra.test.ts"],
  ])
    assert.throws(() => checkInventories([{ ...record, executed }], 1, "browser"));
  assert.throws(() => checkInventories([], 1, "browser"));
});
