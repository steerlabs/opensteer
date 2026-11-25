import { expect, it } from "vitest";
import { runnerMemoryBytes, warmEngineIdleCap } from "./warm-engine-pool.js";

const mib = 1024 ** 2;
const gib = 1024 ** 3;

it("keeps one or two idle engines on an 8 GB computer or smaller", () => {
  expect([4, 8, 16, 32].map((size) => warmEngineIdleCap(size * gib))).toEqual([1, 2, 8, 8]);
});

it("keeps warm engines only in the room the Runner's Runs leave, at one allowance each", () => {
  // A Cloud Computer's Runner, as its Home sizes it (Runner memory, Runs at once): no warm
  // engine on 4, 8 or 16 GB, where three Runs and two warm engines once shared 5,329 MiB.
  expect(warmEngineIdleCap(2020 * mib, 1)).toBe(0);
  expect(warmEngineIdleCap(5329 * mib, 3)).toBe(0);
  expect(warmEngineIdleCap(10_714 * mib, 6)).toBe(0);
  // A self-hosted Linux Home's Runner: limited to 8 GiB, four Runs at once by default.
  expect(warmEngineIdleCap(8 * gib, 4)).toBe(1);
  expect(warmEngineIdleCap(8 * gib, 3)).toBe(2);
  // A Mac's desktop Runner (two Runs at once, the computer's memory).
  expect(warmEngineIdleCap(16 * gib, 2)).toBe(8);
  expect(warmEngineIdleCap(8 * gib, 2)).toBe(2);
  // Runs and warm engines together never take more than the Runner has.
  for (const [memory, runs] of [
    [2020 * mib, 1],
    [5329 * mib, 3],
    [8 * gib, 4],
    [16 * gib, 4],
    [64 * gib, 4],
  ] as const) {
    const held = (runs + warmEngineIdleCap(memory, runs)) * 1536 * mib + 192 * mib;
    expect(held, `${memory / mib} MiB, ${runs} Runs`).toBeLessThanOrEqual(memory);
  }
});

it("reads the Runner's container limit, not the computer's memory", () => {
  expect(runnerMemoryBytes(8 * gib, 16 * gib)).toBe(8 * gib);
  // No limit (0 or none), or one above the computer (a Mac's constrainedMemory): the computer's.
  expect(runnerMemoryBytes(0, 16 * gib)).toBe(16 * gib);
  expect(runnerMemoryBytes(undefined, 16 * gib)).toBe(16 * gib);
  expect(runnerMemoryBytes(2 ** 62, 16 * gib)).toBe(16 * gib);
});
