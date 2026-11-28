import { createId } from "@opensteer/core";
import { triggerStopGenerationCapability } from "@opensteer/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FiringInterruptLoop } from "./firing-interrupt-loop.js";

describe("FiringInterruptLoop (AA10)", () => {
  afterEach(() => vi.useRealTimers());

  it("retries trigger.interrupt after dispatch failure until terminal evidence settles the firing", async () => {
    vi.useFakeTimers();
    const environmentId = createId("environment");
    const runnerId = createId("runner");
    const occurrenceId = createId("triggerOccurrence");
    const firing = {
      commandId: createId("command"),
      environmentId,
      executionGeneration: 3,
      occurrenceId,
      runnerBootId: "boot-1",
      runnerId,
    };
    let stillRunning = true;
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient timeout"))
      .mockImplementationOnce(async () => {
        stillRunning = false;
        return { kind: "accepted" };
      });
    const onWarn = vi.fn();
    const loop = new FiringInterruptLoop({
      onWarn,
      runners: {
        dispatch,
        identityForEnvironment: () => ({
          bootId: "boot-1",
          capabilities: [triggerStopGenerationCapability],
          connectionGeneration: 7,
          runnerId,
        }),
      } as never,
      store: {
        isFiringStillRunning: vi.fn(async () => stillRunning),
        listPausedRunningFirings: vi.fn(async () => (stillRunning ? [firing] : [])),
      },
    });

    try {
      loop.interrupt(firing);
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(onWarn).toHaveBeenCalledTimes(1);
      expect(loop.pendingCount()).toBe(1);

      // Backoff retry delivers the interrupt; next verification sees terminal evidence and stops.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(dispatch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(loop.pendingCount()).toBe(0);
      expect(dispatch).toHaveBeenCalledTimes(2);
    } finally {
      loop.close();
    }
  });

  it("runs zero queries and schedules no timer while the Runner is offline, and relies on attach revocation on reconnect (AB4)", async () => {
    vi.useFakeTimers();
    const environmentId = createId("environment");
    const runnerId = createId("runner");
    const occurrenceId = createId("triggerOccurrence");
    const firing = {
      commandId: createId("command"),
      environmentId,
      executionGeneration: 1,
      occurrenceId,
      runnerBootId: "boot-reconnect",
      runnerId,
    };
    const dispatch = vi.fn(async () => ({ kind: "accepted" }));
    const isFiringStillRunning = vi.fn(async () => true);
    const loop = new FiringInterruptLoop({
      runners: {
        dispatch,
        identityForEnvironment: () => undefined,
      } as never,
      store: {
        isFiringStillRunning,
        listPausedRunningFirings: vi.fn(async () => [firing]),
      },
    });

    try {
      loop.interrupt(firing);
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatch).toHaveBeenCalledTimes(0);
      expect(isFiringStillRunning).toHaveBeenCalledTimes(0);
      expect(vi.getTimerCount()).toBe(0);

      // Advance 10 minutes while Runner stays offline: zero queries, zero dispatches, zero timers.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(isFiringStillRunning).toHaveBeenCalledTimes(0);
      expect(dispatch).toHaveBeenCalledTimes(0);
      expect(vi.getTimerCount()).toBe(0);

      // When the Runner reattaches, attachRunnerFirings already answers `revoked` (or settles
      // unknown on a new boot), so FiringInterruptLoop drops the pending entry without a duplicate
      // trigger.interrupt.
      loop.runnerAttached(runnerId, "boot-reconnect");
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatch).toHaveBeenCalledTimes(0);
      expect(loop.pendingCount()).toBe(0);
    } finally {
      loop.close();
    }
  });
});
