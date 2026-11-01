import type { BrowserTabOpenInput, BrowserTabOpenOptions } from "./client.js";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { PendingBrowserTabs } from "./pending-browser-tabs.js";

it("bounds completed results without evicting unfinished openings or their exact retry payload", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  try {
    const session = client.getSnapshot().browserSessions.find((row) => row.state === "ready")!;
    const opened = await client.openBrowserTab(session.id);
    const gate = Promise.withResolvers<typeof opened>();
    let lost = true;
    const open = vi.fn(async (_target: BrowserTabOpenInput, options: BrowserTabOpenOptions) => {
      if (options.idempotencyKey === "waiting")
        return withTimeout(gate.promise, 2_000, {
          timeoutError: () => new Error("The waiting browser opening was never released."),
        });
      if (options.idempotencyKey === "unknown" && lost) throw new TypeError("Response lost");
      return opened;
    });
    const pending = new PendingBrowserTabs({
      admitted: () => true,
      open,
      close: vi.fn(),
      changed: vi.fn(),
    });
    const target = { sessionId: session.id };
    const waiting = pending.begin(target, { idempotencyKey: "waiting" });
    try {
      const uncertainOptions = {
        idempotencyKey: "unknown",
        url: "https://pending.example/",
        viewport: { width: 700, height: 500 },
      };
      await expect(pending.begin(target, uncertainOptions).result).rejects.toThrow("Response lost");
      const first = pending.begin(target, { idempotencyKey: "completed-0" });
      await first.result;
      for (let index = 1; index < 100; index += 1)
        await pending.begin(target, { idempotencyKey: `completed-${index}` }).result;
      const newest = pending.begin(target, { idempotencyKey: "completed-100" });
      await newest.result;
      expect(pending.begin(target, { idempotencyKey: "completed-100" })).toBe(newest);
      expect(pending.begin(target, { idempotencyKey: "waiting" })).toBe(waiting);
      expect(pending.rows).toMatchObject([
        { idempotencyKey: "waiting", state: "opening" },
        { idempotencyKey: "unknown", state: "unknown" },
      ]);
      const replay = pending.begin(target, { idempotencyKey: "completed-0" });
      expect(replay.result).not.toBe(first.result);
      await replay.result;
      expect(
        open.mock.calls.filter(([, options]) => options.idempotencyKey === "completed-0"),
      ).toHaveLength(2);
      lost = false;
      await pending.begin(target, { idempotencyKey: "unknown", url: uncertainOptions.url }).result;
      expect(open).toHaveBeenLastCalledWith(target, uncertainOptions);
      gate.resolve(opened);
      await waiting.result;
      expect(pending.rows).toEqual([]);
    } finally {
      gate.resolve(opened);
      await waiting.result;
      pending.dispose();
    }
  } finally {
    client.dispose();
  }
});
