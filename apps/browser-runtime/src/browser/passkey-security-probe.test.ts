import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import type { CdpSession } from "@opensteer/browser-runtime-core";
import { probePasskeySecurityState } from "./playwright-launcher.js";

it.each(["emits", "silent", "malformed", "error"])(
  "probes visible Security state with bounded cleanup: %s",
  async (mode) => {
    vi.useFakeTimers();
    const events = new EventEmitter();
    const session = {
      on: events.on.bind(events),
      off: events.off.bind(events),
      send: vi.fn(async () => {
        if (mode === "error") throw new Error("synthetic-sensitive-detail");
        if (mode === "emits")
          events.emit("Security.visibleSecurityStateChanged", {
            visibleSecurityState: { securityState: "neutral" },
          });
        if (mode === "malformed") events.emit("Security.visibleSecurityStateChanged", {});
        return {};
      }),
    } as unknown as CdpSession;
    try {
      const result = probePasskeySecurityState(session);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await result).toBe(mode === "emits");
      expect(events.listenerCount("Security.visibleSecurityStateChanged")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);
