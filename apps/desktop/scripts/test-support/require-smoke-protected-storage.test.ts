import { describe, expect, it, vi } from "vitest";
import {
  requireSmokeProtectedStorage,
  smokeProtectedStorageUnavailablePrefix,
} from "./require-smoke-protected-storage.js";

describe("requireSmokeProtectedStorage", () => {
  it("resolves when protected storage reports available", async () => {
    await expect(
      requireSmokeProtectedStorage({ check: async () => true, timeoutMs: 500 }),
    ).resolves.toBeUndefined();
  });

  it("fails immediately with a clear error when protected storage is unavailable", async () => {
    await expect(
      requireSmokeProtectedStorage({ check: async () => false, timeoutMs: 500 }),
    ).rejects.toThrow(smokeProtectedStorageUnavailablePrefix);
  });

  it("fails fast when protected storage stalls beyond timeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const pending = requireSmokeProtectedStorage({
        check: () => new Promise(() => undefined),
        timeoutMs: 250,
      });
      const assertion = expect(pending).rejects.toThrow(/did not answer within 250ms/u);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
