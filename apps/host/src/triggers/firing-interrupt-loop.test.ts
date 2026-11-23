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

  it("reconciles paused-trigger running firings on wake and sends interrupt as soon as an offline Runner reconnects", async () => {
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
    let online = false;
    let stillRunning = true;
    const dispatch = vi.fn(async () => ({ kind: "accepted" }));
    const loop = new FiringInterruptLoop({
      runners: {
        dispatch,
        identityForEnvironment: () =>
          online
            ? {
                bootId: "boot-reconnect",
                capabilities: [triggerStopGenerationCapability],
                connectionGeneration: 2,
                runnerId,
              }
            : undefined,
      } as never,
      store: {
        isFiringStillRunning: vi.fn(async () => stillRunning),
        listPausedRunningFirings: vi.fn(async () => (stillRunning ? [firing] : [])),
      },
    });

    try {
      await loop.wake();
      expect(dispatch).toHaveBeenCalledTimes(0);
      expect(loop.pendingCount()).toBe(1);

      // Runner reconnects with the same boot: interrupt dispatches immediately without waiting.
      online = true;
      loop.runnerAttached(runnerId, "boot-reconnect");
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId,
          executionGeneration: 1,
          occurrenceId,
          type: "trigger.interrupt",
        }),
        expect.any(AbortSignal),
        { connectionGeneration: 2 },
      );

      stillRunning = false;
      loop.settled(occurrenceId);
      expect(loop.pendingCount()).toBe(0);
    } finally {
      loop.close();
    }
  });
});
