import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestDeadlines } from "../agents/request-deadlines.js";
import { executionLeaseDrain } from "./execution-leases.js";
import type { DeadlineDrain } from "./deadline-drain.js";

/*
 * Every exit of a pass for the deadline owners that read their next durable
 * deadline: armed at that deadline, disarmed with none, backing off after an
 * error or a pass that could not make progress, and nothing after close.
 */
beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
afterEach(() => vi.useRealTimers());

type Exit =
  | "future"
  | "none"
  | "due-then-done"
  | "due-stuck"
  | "settle-throws"
  | "next-throws"
  | "capped-progress";

function owner(kind: "requests" | "leases", exit: Exit) {
  let due = exit.startsWith("due") || exit === "settle-throws" || exit === "capped-progress";
  // A capped sweep: each pass settles one page and commits, the next page is still due.
  let pages = exit === "capped-progress" ? 2 : 0;
  let head = 0;
  const settle = vi.fn(async () => {
    if (exit === "settle-throws") throw new Error("database down");
    if (exit === "due-then-done") due = false;
    if (exit === "capped-progress") {
      head++;
      if (--pages < 0) due = false;
    }
  });
  const next = vi.fn(async () => {
    if (exit === "next-throws") throw new Error("database down");
    if (exit === "none") return null;
    if (exit === "future") return new Date(Date.now() + 60_000);
    return due ? new Date(Date.now() - 1) : null;
  });
  const drain: DeadlineDrain =
    kind === "requests"
      ? new RequestDeadlines({ next, settle, onError: () => undefined, progressMark: () => head })
      : executionLeaseDrain(
          {
            nextExecutionDeadline: next,
            recoverRunsWithExpiredExecutionBindings: settle,
            stopRunsPastBackgroundDeadline: async () => undefined,
          } as never,
          () => undefined,
          () => undefined,
        );
  return { drain, settle, next };
}

describe.each(["requests", "leases"] as const)("%s deadline owner", (kind) => {
  it.each([
    ["nothing due yet: armed at the deadline", "future", [60_000]],
    ["nothing durable: disarmed", "none", []],
    ["due and settled: disarmed", "due-then-done", []],
    ["due but kept: backs off, no spin", "due-stuck", [5_000]],
    ["settling throws: backs off", "settle-throws", [5_000]],
    ["reading throws: backs off", "next-throws", [5_000]],
  ] as const)("%s", async (_, exit, armed) => {
    const { drain, next } = owner(kind, exit);
    drain.start();
    await drain.settled();
    expect(vi.getTimerCount()).toBe(armed.length);
    const passes = next.mock.calls.length;
    if (armed.length) {
      // Nothing runs before the deadline or backoff: no spin.
      await vi.advanceTimersByTimeAsync(armed[0]! - 1);
      expect(next.mock.calls.length).toBe(passes);
      await vi.advanceTimersByTimeAsync(1);
      expect(next.mock.calls.length).toBeGreaterThan(passes);
    }
    await drain.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("drains every capped page of due Requests at once while each pass makes progress", async () => {
  const { drain, settle } = owner("requests", "capped-progress");
  drain.start();
  await drain.settled();
  // Well inside the first backoff (5 s): only immediate reruns can reach page three.
  await vi.advanceTimersByTimeAsync(100);
  // Three pages settled without waiting for a backoff, then nothing armed.
  expect(settle).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
  await drain.close();
});
