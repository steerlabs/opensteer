import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeadlineDrain, retryWithBackoff } from "./deadline-drain.js";

describe("DeadlineDrain", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retries unfinished work with doubling backoff and resets after a clean pass", async () => {
    const passes: number[] = [];
    const outcomes: (Date | null | typeof retryWithBackoff | Error)[] = [
      new Error("unreachable"),
      retryWithBackoff,
      retryWithBackoff,
      null,
      retryWithBackoff,
    ];
    const errors: unknown[] = [];
    const drain = new DeadlineDrain({
      drain: async () => {
        passes.push(Date.now());
        const outcome = outcomes.shift() ?? null;
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
      onError: (error) => errors.push(error),
    });
    const start = Date.now();
    drain.start();
    await drain.settled();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(passes.map((at) => at - start)).toEqual([0, 5_000, 15_000, 35_000]);
    expect(errors).toHaveLength(1);
    // The clean pass armed nothing; a later wake starts the backoff over at 5 s.
    expect(vi.getTimerCount()).toBe(0);
    drain.wake();
    await drain.settled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(passes).toHaveLength(6);
    await drain.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps the backoff at five minutes", async () => {
    const passes: number[] = [];
    const drain = new DeadlineDrain({
      drain: async () => {
        passes.push(Date.now());
        return retryWithBackoff;
      },
    });
    drain.start();
    await drain.settled();
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(5 * 60_000);
    const gaps = passes.slice(1).map((at, index) => at - passes[index]!);
    expect(Math.max(...gaps)).toBe(5 * 60_000);
    await drain.close();
  });

  it("backs off no later than a deadline the pass already knows", async () => {
    const passes: number[] = [];
    let first = true;
    const drain = new DeadlineDrain({
      drain: async () => {
        passes.push(Date.now());
        if (!first) return null;
        first = false;
        return { backoffNoLaterThan: new Date(Date.now() + 2_000) };
      },
    });
    const start = Date.now();
    drain.start();
    await drain.settled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(passes.map((at) => at - start)).toEqual([0, 2_000]);
    await drain.close();
  });
});
