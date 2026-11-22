import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assignShards, integrationContention, unknownDuration } from "./ci-sharding.mjs";

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

test("integration bulk seed and partner setup stay apart from contention-heavy suites", () => {
  const durations = JSON.parse(
    readFileSync(new URL("./ci-durations.json", import.meta.url)),
  ).integration;
  const files = Object.keys(durations);
  const shards = assignShards(
    files,
    durations,
    6,
    unknownDuration.integration,
    integrationContention,
  );
  assert.deepEqual(
    shards,
    assignShards(
      [...files].reverse(),
      durations,
      6,
      unknownDuration.integration,
      integrationContention,
    ),
  );
  assert.deepEqual(shards.flat().sort(), files.sort());
  for (const file of integrationContention.files) {
    const shard = shards.find((files) => files.includes(file));
    assert.ok(shard, `Missing ${file}`);
    assert.ok(
      shard.every(
        (file) =>
          integrationContention.files.includes(file) ||
          durations[file] <= integrationContention.maxCompanionDuration,
      ),
    );
  }
  const totals = shards.map((files) => files.reduce((sum, file) => sum + durations[file], 0));
  assert.ok(Math.max(...totals) < (totals.reduce((sum, total) => sum + total, 0) / 6) * 1.03);
});

test("contention separation handles focused selections and a single runner without losing files", () => {
  // Two bulk suites that must not share a runner with long companions.
  const contention = { files: ["bulk-a", "bulk-b"], maxCompanionDuration: 30_000 };
  const files = [...contention.files, "browser", "migration", "new"];
  const durations = { browser: 60_000, migration: 40_000 };
  const shards = assignShards(files, durations, 2, 1, contention);
  assert.deepEqual(shards.flat().sort(), [...files].sort());
  assert.ok(shards[0].every((file) => !["browser", "migration"].includes(file)));
  assert.ok(!shards[0].includes("new"));
  assert.ok(shards[1].every((file) => !contention.files.includes(file)));
  assert.deepEqual(
    assignShards(files, durations, 1, 1, contention),
    assignShards(files, durations, 1, 1),
  );
  const ordinary = ["browser", "migration", "new"];
  assert.deepEqual(
    assignShards(ordinary, durations, 2, 1, contention),
    assignShards(ordinary, durations, 2, 1),
  );
});
