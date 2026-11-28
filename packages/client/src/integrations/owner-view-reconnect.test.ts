import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceIdSchema, WindowIdSchema } from "@opensteer/core";
import type { TabViewer } from "@opensteer/protocol";
import { HostClientRequestError } from "../host/client.js";
import { OwnerViewReconnect } from "./owner-view-reconnect.js";
import type { DisplaySnapshot } from "./phone-display-stream.js";

const source = (generation: number) => ({
  kind: "owner-view" as const,
  viewId: "view",
  generation,
});
const viewer = (generation: number): TabViewer => ({
  kind: "window",
  view: {
    viewId: source(generation).viewId,
    generation,
    state: "ready",
    connectionId: "approval",
    machineId: DeviceIdSchema.parse("rnr_00000000-0000-4000-8000-000000000001"),
    target: {
      kind: "app",
      app: { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null },
      windowId: WindowIdSchema.parse("win_00000000-0000-4000-8000-000000000001"),
    },
    expiresAt: "2026-11-02T13:00:00.000Z",
    openedAt: "2026-11-02T12:00:00.000Z",
    unavailableReason: null,
    window: null,
  },
});

function ended(reason: "device-restarting" | "window-closed"): DisplaySnapshot {
  return {
    closeCode: null,
    connection: "open",
    display: {
      type: "display.state",
      state: "stopped",
      generation: 1,
      width: 0,
      height: 0,
      reason,
    },
    input: "unavailable",
    power: "unavailable",
    keyframeFailed: false,
  };
}

afterEach(() => vi.useRealTimers());

describe("owner view reconnect", () => {
  it("backs off after a restart and waits for a fresh picture", async () => {
    vi.useFakeTimers();
    const open = vi
      .fn<(signal: AbortSignal) => Promise<TabViewer>>()
      .mockRejectedValueOnce(
        new HostClientRequestError({
          code: "conflict",
          reason: "computer-view-unavailable",
          status: 409,
          message: "Offline",
        }),
      )
      .mockResolvedValueOnce(viewer(1))
      .mockResolvedValueOnce(viewer(2));
    const opened = vi.fn();
    const reconnect = new OwnerViewReconnect(open, opened);
    reconnect.observe(source(1), ended("device-restarting"));
    reconnect.removed(source(1), "device-restarting");
    reconnect.picture(source(1));
    expect(reconnect.getSnapshot()).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(249);
    expect(open).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(open).toHaveBeenCalledTimes(2);
    expect(opened).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(opened).toHaveBeenCalledExactlyOnceWith(viewer(2));
    expect(reconnect.getSnapshot()).toBe("reconnecting");
    reconnect.picture(source(2));
    expect(reconnect.getSnapshot()).toBe("idle");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(open).toHaveBeenCalledTimes(3);
  });

  it("keeps the original deadline when a replacement also ends in a restart", async () => {
    vi.useFakeTimers();
    const open = vi
      .fn()
      .mockResolvedValueOnce(viewer(2))
      .mockReturnValue(new Promise(() => {}));
    const reconnect = new OwnerViewReconnect(open, vi.fn());
    reconnect.removed(source(1), "device-restarting");
    await vi.advanceTimersByTimeAsync(14_000);
    reconnect.picture(source(2));
    expect(reconnect.getSnapshot()).toBe("idle");
    reconnect.observe(source(2), ended("device-restarting"));
    expect(reconnect.getSnapshot()).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(999);
    expect(open).toHaveBeenCalledTimes(2);
    expect(reconnect.getSnapshot()).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1);
    expect(reconnect.getSnapshot()).toBe("timed-out");
    expect(open.mock.calls[1]?.[0].aborted).toBe(true);
  });

  it("never reopens for a different end and stops recovery if the replacement ends that way", async () => {
    vi.useFakeTimers();
    const open = vi.fn().mockResolvedValue(viewer(2));
    const reconnect = new OwnerViewReconnect(open, vi.fn());
    reconnect.observe(source(1), ended("window-closed"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reconnect.getSnapshot()).toBe("idle");
    expect(open).not.toHaveBeenCalled();

    reconnect.observe(source(1), ended("device-restarting"));
    await vi.advanceTimersByTimeAsync(250);
    reconnect.removed(source(1), undefined); // Invalidating the retired socket does not end recovery.
    expect(reconnect.getSnapshot()).toBe("reconnecting");
    reconnect.observe(source(2), ended("window-closed"));
    expect(reconnect.getSnapshot()).toBe("ended");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("gives up at fifteen seconds and ignores a late activation answer", async () => {
    vi.useFakeTimers();
    let reply!: (viewer: TabViewer) => void;
    const open = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<TabViewer>((resolve) => {
          reply = resolve;
        }),
    );
    const opened = vi.fn();
    const reconnect = new OwnerViewReconnect(open, opened);
    reconnect.observe(source(1), ended("device-restarting"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(reconnect.getSnapshot()).toBe("timed-out");
    expect(open.mock.calls[0]?.[0].aborted).toBe(true);
    reply(viewer(2));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(open).toHaveBeenCalledTimes(1);
    expect(opened).not.toHaveBeenCalled();
    expect(reconnect.getSnapshot()).toBe("timed-out");
  });

  it("stops immediately if the fresh activation is refused for access", async () => {
    vi.useFakeTimers();
    const open = vi.fn().mockRejectedValue(
      new HostClientRequestError({
        code: "forbidden",
        status: 403,
        message: "Access changed",
      }),
    );
    const reconnect = new OwnerViewReconnect(open, vi.fn());
    reconnect.removed(source(1), "device-restarting");
    await vi.advanceTimersByTimeAsync(250);
    expect(reconnect.getSnapshot()).toBe("ended");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
