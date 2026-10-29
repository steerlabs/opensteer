import { describe, expect, it } from "vitest";
import { ManualClock } from "./clock.test-support.js";

describe("domain clock", () => {
  it("crosses the full interval, runs deadlines in order and cancels scheduled work", () => {
    const clock = new ManualClock(0);
    const observed: number[] = [];
    clock.schedule(() => {
      observed.push(clock.now());
      clock.schedule(() => observed.push(clock.now()), 100);
    }, 15_000);
    const cancel = clock.schedule(() => observed.push(-1), 300);
    cancel();
    clock.advanceBy(14_999);
    expect(observed).toEqual([]);
    clock.advanceBy(101);
    expect(observed).toEqual([15_000, 15_100]);
    expect(clock.now()).toBe(15_100);
  });

  it("drains concurrent waits with different deadlines", async () => {
    const clock = new ManualClock(0);
    const work = Promise.all([clock.wait(1_000), clock.wait(2_000)]);
    await expect(clock.runUntilSettled(work)).resolves.toEqual([undefined, undefined]);
    expect(clock.now()).toBe(2_000);
  });

  it("cancels an abortable wait without leaving a deadline", async () => {
    const clock = new ManualClock(0);
    const stop = new AbortController();
    const waiting = clock.wait(5_000, stop.signal);
    stop.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
    clock.advanceBy(5_100);
    expect(clock.now()).toBe(5_100);
    await expect(clock.wait(1, stop.signal)).rejects.toThrow("stopped");
  });

  it("drives newly scheduled waits while awaiting observed asynchronous work", async () => {
    const clock = new ManualClock(0);
    const work = (async () => {
      await clock.wait(5_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await clock.wait(1_000);
      return "done";
    })();
    await expect(clock.runUntilSettled(work)).resolves.toBe("done");
    expect(clock.now()).toBe(6_000);
  });
});
