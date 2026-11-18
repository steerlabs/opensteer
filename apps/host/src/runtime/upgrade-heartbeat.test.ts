import { expect, it, vi } from "vitest";
import { withUpgradeHeartbeat } from "./upgrade-heartbeat.js";

it.each(["success", "failure"])(
  "emits liveness during an upgrade statement until %s",
  async (outcome) => {
    vi.useFakeTimers();
    const statement = Promise.withResolvers<void>();
    const heartbeat = vi.fn();
    try {
      const work = withUpgradeHeartbeat(() => statement.promise, heartbeat);
      const settled =
        outcome === "success"
          ? expect(work).resolves.toBeUndefined()
          : expect(work).rejects.toThrow("Statement failed");
      await vi.advanceTimersByTimeAsync(61_000);
      expect(heartbeat).toHaveBeenCalledTimes(4);
      if (outcome === "success") statement.resolve();
      else statement.reject(new Error("Statement failed"));
      await settled;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(heartbeat).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  },
);
