import { HostClientRequestError } from "./client.js";
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
      expect(open).toHaveBeenLastCalledWith(target, {
        ...uncertainOptions,
        signal: expect.any(AbortSignal),
      });
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

it("settles a never-answering buffered open at the deadline and supports Retry and Close", async () => {
  vi.useFakeTimers();
  const open = vi.fn(() => new Promise<never>(() => {}));
  const pending = new PendingBrowserTabs({
    admitted: () => true,
    open,
    close: vi.fn(),
    changed: vi.fn(),
  });
  try {
    const handle = pending.begin({ identity: { kind: "guest" } }, { idempotencyKey: "hung" });
    const settled = vi.fn();
    void handle.result.then(settled, settled);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(pending.rows).toMatchObject([{ state: "unknown" }]);
    expect(settled).toHaveBeenCalledOnce();
    const retry = pending.begin({ identity: { kind: "guest" } }, { idempotencyKey: "hung" });
    void retry.result.catch(() => {});
    expect(open).toHaveBeenCalledTimes(2);
    pending.dismiss("hung");
    expect(pending.rows).toEqual([]);
  } finally {
    pending.dispose();
    vi.useRealTimers();
  }
});

it("checks the action deadline on foregrounding and fences a late buffered answer", async () => {
  vi.useFakeTimers();
  const result = Promise.withResolvers<never>();
  const pending = new PendingBrowserTabs({
    admitted: () => true,
    open: () => result.promise,
    close: vi.fn(),
    changed: vi.fn(),
  });
  try {
    const handle = pending.begin({ identity: { kind: "guest" } });
    const refused = expect(handle.result).rejects.toMatchObject({
      reason: "browser-tab-open-outcome-unknown",
    });
    vi.setSystemTime(Date.now() + 25_000);
    pending.checkDeadlines();
    await refused;
    expect(pending.rows).toMatchObject([{ state: "unknown" }]);
    pending.dismiss(handle.idempotencyKey);
    expect(pending.rows).toEqual([]);
  } finally {
    pending.dispose();
    vi.useRealTimers();
  }
});

it("turns an uncertain retry into a confirmed failure when the Host replays terminal settlement", async () => {
  let confirmed = false;
  const open = vi.fn(async () => {
    if (!confirmed) throw new TypeError("Response lost");
    throw new HostClientRequestError({
      code: "conflict",
      status: 409,
      reason: "browser-tab-open-failed",
      message: "Opening failed",
    });
  });
  const pending = new PendingBrowserTabs({
    admitted: () => true,
    open,
    close: vi.fn(),
    changed: vi.fn(),
  });
  try {
    const target = { identity: { kind: "guest" as const } };
    await expect(pending.begin(target, { idempotencyKey: "lost" }).result).rejects.toThrow(
      "Response lost",
    );
    expect(pending.rows[0]?.state).toBe("unknown");
    confirmed = true;
    await expect(pending.begin(target, { idempotencyKey: "lost" }).result).rejects.toThrow(
      "Opening failed",
    );
    expect(pending.rows[0]?.state).toBe("failed");
  } finally {
    pending.dispose();
  }
});
