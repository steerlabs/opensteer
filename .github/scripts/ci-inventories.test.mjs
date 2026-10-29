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
