import { createId } from "@opensteer/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assignmentReturnPass } from "./assignment-return-pass.js";
import { DeadlineDrain } from "./deadline-drain.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const none = { failures: [], waiting: 0, held: 0, heldUntil: null, settled: 0, more: false };
const failure = { assignmentId: createId("delegation"), error: new Error("down") };

// Every exit of a pass, and whether the owner is armed after it.
it.each([
  ["a clean full batch", { ...none, settled: 100, more: true }, new Date(0)],
  [
    "a full batch that delivered nothing",
    { ...none, held: 100, heldUntil: new Date(9), more: true },
    { backoffNoLaterThan: new Date(9) },
  ],
  ["a short clean batch, nothing left", { ...none, settled: 3 }, null],
  [
    "a short batch of held returns",
    { ...none, held: 2, heldUntil: new Date(60_000) },
    new Date(60_000),
  ],
  ["a return behind a full parent inbox", { ...none, waiting: 1 }, "backoff"],
  ["a failed return after others settled", { ...none, settled: 4, failures: [failure] }, "backoff"],
  ["a failed full batch", { ...none, failures: [failure], more: true }, "backoff"],
  [
    "a failure beside a held return: backoff, but no later than the hold",
    { ...none, held: 1, heldUntil: new Date(2_000), failures: [failure] },
    { backoffNoLaterThan: new Date(2_000) },
  ],
  // The hold ended between the delivery decision and arming: still armed, due now.
  ["a hold that has already ended", { ...none, held: 1, heldUntil: new Date(1) }, new Date(1)],
] as const)("%s", async (_, drained, armed) => {
  const result = await assignmentReturnPass(async () => drained, vi.fn());
  expect(typeof result === "symbol" ? "backoff" : result).toEqual(armed);
});

it("drains a full batch again at once, so the 101st return is not stranded", async () => {
  let pending = 101;
  const drained = vi.fn(async (limit = 100) => {
    const batch = Math.min(pending, limit);
    pending -= batch;
    return { ...none, settled: batch, more: batch === limit };
  });
  const drain = new DeadlineDrain({ drain: () => assignmentReturnPass(drained, vi.fn()) });
  drain.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(pending).toBe(0);
  expect(drained).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
  await drain.close();
});

it("does not spin on a full batch held by synchronous readers", async () => {
  const drained = vi.fn(async () => ({
    ...none,
    held: 100,
    heldUntil: new Date(Date.now() + 60_000),
    more: true,
  }));
  const drain = new DeadlineDrain({ drain: () => assignmentReturnPass(drained, vi.fn()) });
  drain.start();
  await vi.advanceTimersByTimeAsync(4_999);
  expect(drained).toHaveBeenCalledTimes(1);
  await drain.close();
});
