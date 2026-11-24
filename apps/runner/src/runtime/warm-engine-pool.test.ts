import { expect, it } from "vitest";
import { runnerMemoryBytes, warmEngineIdleCap } from "./warm-engine-pool.js";

it("keeps one or two idle engines on an 8 GB computer or smaller", () => {
  const gib = 1024 ** 3;
  expect([4, 8, 16, 32].map((size) => warmEngineIdleCap(size * gib))).toEqual([1, 2, 8, 8]);
});

it("sizes the warm cap from the memory limit the Runner runs under, not the whole machine's", () => {
  const gib = 1024 ** 3;
  // A Cloud Computer's Runner: a 16 GiB machine, a container limited to 1280 MiB.
  expect(runnerMemoryBytes(1280 * 1024 ** 2, 16 * gib)).toBe(1280 * 1024 ** 2);
  expect(warmEngineIdleCap(runnerMemoryBytes(1280 * 1024 ** 2, 16 * gib))).toBe(1);
  // No limit (0), or one larger than the machine: the machine's memory.
  expect(runnerMemoryBytes(0, 16 * gib)).toBe(16 * gib);
  expect(runnerMemoryBytes(undefined, 16 * gib)).toBe(16 * gib);
  expect(runnerMemoryBytes(2 ** 64, 16 * gib)).toBe(16 * gib);
  expect(warmEngineIdleCap(runnerMemoryBytes(0, 16 * gib))).toBe(8);
});
