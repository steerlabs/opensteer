import { createId } from "@opensteer/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assignmentReturnPass } from "./assignment-return-pass.js";
import { DeadlineDrain } from "./deadline-drain.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("drains a full batch again at once, so the 101st return is not stranded", async () => {
  let pending = 101;
  const drained = vi.fn(async (limit = 100) => {
    const batch = Math.min(pending, limit);
    pending -= batch;
    return { failures: [], waiting: 0, more: batch === limit };
  });
  const drain = new DeadlineDrain({ drain: () => assignmentReturnPass(drained, vi.fn()) });
  drain.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(pending).toBe(0);
  expect(drained).toHaveBeenCalledTimes(2);
  // Exhausted and clean: nothing armed.
  expect(vi.getTimerCount()).toBe(0);
  await drain.close();
});

it("backs off a full batch that only failed instead of spinning on it", async () => {
  const assignmentId = createId("delegation");
  const drained = vi.fn(async () => ({
    failures: [{ assignmentId, error: new Error("down") }],
    waiting: 0,
    more: true,
  }));
  const drain = new DeadlineDrain({ drain: () => assignmentReturnPass(drained, vi.fn()) });
  drain.start();
  await vi.advanceTimersByTimeAsync(4_999);
  expect(drained).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(drained).toHaveBeenCalledTimes(2);
  await drain.close();
});
