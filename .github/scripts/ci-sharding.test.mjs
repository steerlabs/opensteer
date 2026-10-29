import { test } from "node:test";
import assert from "node:assert/strict";
import { assignShards } from "./ci-sharding.mjs";

test("duration balancing is deterministic, exhaustive and disjoint for new files", () => {
  const files = ["a", "b", "c", "d", "new"];
  const durations = { a: 100, b: 60, c: 40, d: 20 };
  const shards = assignShards(files, durations, 2, 10);
  assert.deepEqual(shards, assignShards([...files].reverse(), durations, 2, 10));
  assert.deepEqual(shards.flat().sort(), files.sort());
  assert.deepEqual(shards, [
    ["a", "d"],
    ["b", "c", "new"],
  ]);
});

test("invalid shard configuration and duplicate files fail", () => {
  assert.throws(() => assignShards(["a", "a"], {}, 2, 1));
  assert.throws(() => assignShards(["a"], {}, 0, 1));
  assert.throws(() => assignShards(["a"], { a: -1 }, 1, 1));
});
