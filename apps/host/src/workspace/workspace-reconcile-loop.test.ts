import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceReconcileLoop } from "./workspace-reconcile-loop.js";
import { ManualClock } from "@opensteer/shared/test-support/clock";

describe("WorkspaceReconcileLoop", () => {
  afterEach(() => vi.useRealTimers());

  it("uses its injected scheduler without overlapping async passes or leaving a canceled pass", async () => {
    const clock = new ManualClock();
    const pass = Promise.withResolvers<void>();
    const reconcile = vi.fn(async () => pass.promise);
    const loop = new WorkspaceReconcileLoop({
      clock,
      intervalMs: 100,
      random: () => 0.5,
      onError: vi.fn(),
      reconcile,
      sweep: vi.fn(),
    });
    try {
      loop.start();
      clock.advanceBy(100);
      expect(reconcile).toHaveBeenCalledTimes(1);
      clock.advanceBy(1_000);
      expect(reconcile).toHaveBeenCalledTimes(1);
      pass.resolve();
      expect(await loop.settled()).toBe(1);
      clock.advanceBy(99);
      expect(reconcile).toHaveBeenCalledTimes(1);
      clock.advanceBy(1);
      expect(await loop.settled()).toBe(2);
      await loop.close();
      clock.advanceBy(1_000);
      expect(reconcile).toHaveBeenCalledTimes(2);
    } finally {
      pass.resolve();
      await loop.close();
    }
  });

  it("never overlaps passes and waits for the active pass during shutdown", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reconcile = vi.fn(async () => blocked);
    const loop = new WorkspaceReconcileLoop({
      intervalMs: 10,
      onError: vi.fn(),
      random: () => 0.5,
      reconcile,
      sweep: vi.fn(),
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(reconcile).toHaveBeenCalledTimes(1);

    let closed = false;
    const closing = loop.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    await vi.advanceTimersByTimeAsync(100);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("reports a failed pass and schedules the next pass", async () => {
    vi.useFakeTimers();
    const failure = new Error("database unavailable");
    const onError = vi.fn();
    const reconcile = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    const loop = new WorkspaceReconcileLoop({
      intervalMs: 10,
      onError,
      random: () => 0.5,
      reconcile,
      sweep: vi.fn(),
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(onError).toHaveBeenCalledWith(failure);
    await vi.advanceTimersByTimeAsync(10);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await loop.close();
  });

  it("grows full-jitter backoff to ten intervals and resets after success", async () => {
    vi.useFakeTimers();
    const outcomes = [false, false, false, false, false, true, false];
    const reconcile = vi.fn(async () => {
      if (!outcomes.shift()) throw new Error("offline");
    });
    const loop = new WorkspaceReconcileLoop({
      intervalMs: 100,
      onError: vi.fn(),
      random: () => 0.5,
      reconcile,
      sweep: vi.fn(),
    });

    loop.start();
    for (const [pass, delay] of [100, 100, 200, 400, 500, 500, 100].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(reconcile).toHaveBeenCalledTimes(pass);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(reconcile).toHaveBeenCalledTimes(7);
    await loop.close();
  });

  it("spreads a healthy pass across a full interval centred on the configured cadence", async () => {
    vi.useFakeTimers();
    const random = vi.fn<() => number>().mockReturnValueOnce(0).mockReturnValue(0.999);
    const reconcile = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const loop = new WorkspaceReconcileLoop({
      intervalMs: 100,
      onError: vi.fn(),
      random,
      reconcile,
      sweep: vi.fn(),
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(148);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await loop.close();
  });

  it("uses the full jitter range", async () => {
    vi.useFakeTimers();
    const random = vi
      .fn<() => number>()
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999);
    const reconcile = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("offline"));
    const loop = new WorkspaceReconcileLoop({
      intervalMs: 100,
      onError: vi.fn(),
      random,
      reconcile,
      sweep: vi.fn(),
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(398);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(3);
    await loop.close();
  });
});
