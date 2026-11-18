import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assignShards, unknownDuration } from "./ci-sharding.mjs";

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

void test("the full integration matrix balances the recorded duration without empty shards", () => {
  const durations = JSON.parse(
    readFileSync(new URL("./ci-durations.json", import.meta.url)),
  ).integration;
  const count = JSON.parse(readFileSync(new URL("./ci-shards.json", import.meta.url))).integration;
  const files = Object.keys(durations);
  const shards = assignShards(files, durations, count, unknownDuration.integration);
  assert.deepEqual(
    shards,
    assignShards([...files].reverse(), durations, count, unknownDuration.integration),
  );
  assert.deepEqual(shards.flat().sort(), files.sort());
  assert.ok(shards.every((shard) => shard.length > 0));
  const totals = shards.map((files) => files.reduce((sum, file) => sum + durations[file], 0));
  assert.ok(Math.max(...totals) < (totals.reduce((sum, total) => sum + total, 0) / count) * 1.03);
});
