import { afterEach, describe, expect, it, vi } from "vitest";
import { RestartPolicy, type RestartPolicyOptions } from "./restartPolicy.js";

afterEach(() => {
  vi.useRealTimers();
});

function policy(overrides: Partial<RestartPolicyOptions> = {}): RestartPolicy {
  return new RestartPolicy({
    baseMs: 1_000,
    maximumAttempts: null,
    maximumMs: 8_000,
    resetAfterMs: 300_000,
    ...overrides,
  });
}

describe("RestartPolicy", () => {
  it("doubles the delay per attempt and caps it at the maximum", () => {
    const restarts = policy();

    expect(restarts.attempt).toBe(0);
    expect(restarts.nextDelayMs()).toBe(1_000);
    expect(restarts.nextDelayMs()).toBe(2_000);
    expect(restarts.nextDelayMs()).toBe(4_000);
    expect(restarts.nextDelayMs()).toBe(8_000);
    expect(restarts.nextDelayMs()).toBe(8_000);
    expect(restarts.attempt).toBe(5);

    restarts.dispose();
  });

  it("returns null once the attempt budget is spent", () => {
    const restarts = policy({ maximumAttempts: 3 });

    expect([restarts.nextDelayMs(), restarts.nextDelayMs(), restarts.nextDelayMs()]).toEqual([
      1_000, 2_000, 4_000,
    ]);
    expect(restarts.nextDelayMs()).toBeNull();
    expect(restarts.nextDelayMs()).toBeNull();

    restarts.reset();
    expect(restarts.attempt).toBe(0);
    expect(restarts.nextDelayMs()).toBe(1_000);

    restarts.dispose();
  });

  it("clears the attempt count after a run that stays up", () => {
    vi.useFakeTimers();
    const restarts = policy();

    expect(restarts.nextDelayMs()).toBe(1_000);
    restarts.markStarted();

    vi.advanceTimersByTime(299_999);
    expect(restarts.attempt).toBe(1);

    vi.advanceTimersByTime(1);
    expect(restarts.attempt).toBe(0);
    expect(restarts.nextDelayMs()).toBe(1_000);

    restarts.dispose();
  });

  it("does not reset when the next crash arrives before the run is stable", () => {
    vi.useFakeTimers();
    const restarts = policy();

    expect(restarts.nextDelayMs()).toBe(1_000);
    restarts.markStarted();
    vi.advanceTimersByTime(100_000);
    expect(restarts.nextDelayMs()).toBe(2_000);

    // The disarmed timer must not fire behind the second attempt.
    vi.advanceTimersByTime(300_000);
    expect(restarts.attempt).toBe(2);

    restarts.dispose();
  });

  it("stops the reset timer on dispose", () => {
    vi.useFakeTimers();
    const restarts = policy();

    expect(restarts.nextDelayMs()).toBe(1_000);
    restarts.markStarted();
    expect(vi.getTimerCount()).toBe(1);

    restarts.dispose();
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(300_000);
    expect(restarts.attempt).toBe(1);
  });

  it("rejects options that cannot describe a backoff", () => {
    expect(() => policy({ baseMs: 0 })).toThrow(TypeError);
    expect(() => policy({ resetAfterMs: Number.NaN })).toThrow(TypeError);
    expect(() => policy({ maximumMs: 500 })).toThrow(/at least baseMs/u);
    expect(() => policy({ maximumAttempts: 0 })).toThrow(/positive integer/u);
    expect(() => policy({ maximumAttempts: 1.5 })).toThrow(/positive integer/u);
  });
});
