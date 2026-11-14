import { describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import { IdleCompactionService } from "./idle-compaction-service.js";

describe("IdleCompactionService", () => {
  it("rebuilds, replaces timers, rereads policy, and closes outstanding work", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(100_000);
      const threadId = createId("thread");
      const snapshot = {
        usedTokens: 200_000,
        measuredAt: 0,
        requestStartedAt: 0,
        promptCacheTtlMs: 300_000 as const,
        sourceRunId: createId("run"),
        bindingGeneration: 1,
        ordinal: 0,
      };
      const candidate = {
        threadId,
        requestedBy: createId("user"),
        providerSessionId: createId("providerSession"),
        environmentId: createId("environment"),
        contextSnapshot: snapshot,
      };
      let enabled = true;
      const list = vi.fn(async () => (enabled ? [candidate] : []));
      const admit = vi.fn(async () => {});
      const onError = vi.fn();
      const service = new IdleCompactionService({ list, admit, onError });
      await service.start();
      await service.arm(threadId);
      expect(vi.getTimerCount()).toBe(1);
      enabled = false;
      await vi.advanceTimersByTimeAsync(80_000);
      expect(admit).not.toHaveBeenCalled();
      enabled = true;
      await service.arm(threadId);
      await vi.advanceTimersByTimeAsync(0);
      expect(admit).toHaveBeenCalledTimes(1);
      await service.close();
      expect(vi.getTimerCount()).toBe(0);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
