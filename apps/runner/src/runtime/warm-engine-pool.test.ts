import { expect, it } from "vitest";
import { runnerMemoryBytes, WarmEnginePool, warmEngineIdleCap } from "./warm-engine-pool.js";

it("keeps one or two idle engines on an 8 GB computer or smaller", () => {
  const gib = 1024 ** 3;
  expect([4, 8, 16, 32].map((size) => warmEngineIdleCap(size * gib))).toEqual([1, 2, 8, 8]);
});

it("sizes the warm cap from the memory limit the Runner runs under, not the whole machine's", () => {
  const gib = 1024 ** 3;
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
  const gib = 1024 ** 3;
  // A Cloud Computer's e2-medium gives its Runner about 1.1 to 1.3 GiB, with no swap: a warm
  // engine beside the one Run would invite an out-of-memory kill.
  expect([1, 1.25, 1.99].map((size) => warmEngineIdleCap(size * gib))).toEqual([0, 0, 0]);
  expect(warmEngineIdleCap(2 * gib)).toBe(1);
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
