import { expect, test, vi } from "vitest";
import { PersonalRetentionDeadline } from "./personal-state-retention.js";

test("rearms due pruning after a failed deadline and stops on an empty tail", async () => {
  vi.useFakeTimers();
  const failure = new Error("database unavailable");
  const onFailure = vi.fn();
  let attempts = 0;
  const deadline = new PersonalRetentionDeadline(async () => {
    if (++attempts === 1) throw failure;
    deadline.update({ head: "2", floor: "2", nextExpiryAt: null });
  }, onFailure);
  try {
    deadline.update({ head: "2", floor: "1", nextExpiryAt: Date.now() });
    await vi.advanceTimersToNextTimerAsync();
    expect(onFailure).toHaveBeenCalledWith(failure);
    await vi.advanceTimersToNextTimerAsync();
    expect(attempts).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    deadline.close();
    vi.useRealTimers();
  }
});
