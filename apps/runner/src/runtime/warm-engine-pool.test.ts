import { expect, it } from "vitest";
import { runnerMemoryBytes, WarmEnginePool, warmEngineIdleCap } from "./warm-engine-pool.js";

const mib = 1024 ** 2;
const gib = 1024 ** 3;

it("keeps one or two idle engines on an 8 GB computer or smaller", () => {
  expect([4, 8, 16, 32].map((size) => warmEngineIdleCap(size * gib))).toEqual([1, 2, 8, 8]);
});

it("sizes the warm cap from the memory limit the Runner runs under, not the whole machine's", () => {
  // A Cloud Computer's Runner: a 16 GiB machine, a container limited to 1280 MiB.
  expect(runnerMemoryBytes(1280 * 1024 ** 2, 16 * gib)).toBe(1280 * 1024 ** 2);
  // Its limit, not the machine's, decides: under 2 GiB it keeps none (review S7).
  expect(warmEngineIdleCap(runnerMemoryBytes(1280 * 1024 ** 2, 16 * gib))).toBe(0);
  // A self-hosted Home's Runner, limited to its default 8 GiB, keeps two (it kept eight when the
  // cap read a 16 GiB machine).
  expect(warmEngineIdleCap(runnerMemoryBytes(8 * gib, 16 * gib))).toBe(2);
  // No limit (0), or one larger than the machine: the machine's memory.
  expect(runnerMemoryBytes(0, 16 * gib)).toBe(16 * gib);
  expect(runnerMemoryBytes(undefined, 16 * gib)).toBe(16 * gib);
  expect(runnerMemoryBytes(2 ** 64, 16 * gib)).toBe(16 * gib);
  expect(warmEngineIdleCap(runnerMemoryBytes(0, 16 * gib))).toBe(8);
});

it("keeps no warm engine when the Runner has less than 2 GiB (review S7)", async () => {
  // A Cloud Computer's e2-medium gives its Runner about 1.1 to 1.3 GiB, with no swap: a warm
  // engine beside the one Run would invite an out-of-memory kill.
  expect([1, 1.25, 1.99].map((size) => warmEngineIdleCap(size * gib))).toEqual([0, 0, 0]);
  // At 2 GiB one Run and one warm engine need more than the Runner has (one allowance each).
  expect(warmEngineIdleCap(2 * gib)).toBe(0);
  const retired: unknown[] = [];
  const pool = new WarmEnginePool({
    maxIdle: warmEngineIdleCap(1.25 * gib),
    retire: async (engine) => void retired.push(engine),
  });
  const engine = { threadId: "thr_1" } as never;
  await pool.put(engine);
  expect(retired).toEqual([engine]);
  expect(await pool.take("thr_1" as never)).toBeUndefined();
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
