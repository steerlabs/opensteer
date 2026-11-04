import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopUpdateOperation, DesktopUpdateStatus } from "@opensteer/protocol/maintenance";
import {
  DesktopUpdatesError,
  type DesktopUpdates,
} from "../connections/desktop-updates-contract.js";
import { DesktopUpdateController } from "./desktop-update-controller.js";

const stamp = "2026-11-04T12:00:00.000Z";
const operation = (
  id: string,
  state: DesktopUpdateOperation["state"] = "pending",
): DesktopUpdateOperation => ({
  id,
  intent: { action: "update" },
  state,
  fromVersion: "0.1.400",
  targetVersion: null,
  incarnationId: null,
  detail: null,
  createdAt: stamp,
  updatedAt: stamp,
});
const status = (current: DesktopUpdateOperation | null = null): DesktopUpdateStatus => ({
  supported: true,
  state: null,
  operation: current,
  revision: "host:1",
});

function fakeUpdates() {
  const follows: {
    listener: (status: DesktopUpdateStatus) => void;
    onError: (error: unknown) => void;
    signal: AbortSignal;
  }[] = [];
  const request = vi.fn<DesktopUpdates["request"]>();
  const updates: DesktopUpdates = {
    status: () => Promise.reject(new Error("Unused.")),
    request,
    subscribeWhileVisible(listener, { onError, signal }) {
      follows.push({ listener, onError, signal });
      return () => undefined;
    },
  };
  return { updates, follows, request };
}

describe("DesktopUpdateController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function shown() {
    const fake = fakeUpdates();
    let key = 0;
    const controller = new DesktopUpdateController(fake.updates, {
      idempotencyKey: () => `key-${++key}`,
    });
    const hide = controller.show();
    return { ...fake, controller, hide };
  }

  it("reads nothing until shown and aborts its read when hidden", () => {
    const fake = fakeUpdates();
    const controller = new DesktopUpdateController(fake.updates);
    expect(fake.follows).toHaveLength(0);
    const hide = controller.show();
    expect(fake.follows).toHaveLength(1);
    hide();
    expect(fake.follows[0]!.signal.aborted).toBe(true);
  });

  it("repeats the idempotency key after a lost response", async () => {
    const { controller, follows, request } = shown();
    follows[0]!.listener(status());
    request.mockRejectedValueOnce(new DesktopUpdatesError("offline"));
    controller.request({ action: "update" });
    await vi.waitFor(() => expect(controller.getSnapshot().failure).toBe("offline"));
    request.mockResolvedValueOnce(operation("a"));
    controller.retry();
    await vi.waitFor(() => expect(controller.getSnapshot().status?.operation?.id).toBe("a"));
    expect(request.mock.calls.map(([sent]) => sent.idempotencyKey)).toEqual(["key-1", "key-1"]);
  });

  it("starts a new request once a lost response turns out to have landed", async () => {
    const { controller, follows, request } = shown();
    follows[0]!.listener(status(operation("old", "failed")));
    request.mockRejectedValueOnce(new DesktopUpdatesError("offline"));
    controller.request({ action: "update" });
    await vi.waitFor(() => expect(controller.getSnapshot().requesting).toBe(false));
    follows[0]!.listener(status(operation("landed", "failed")));
    request.mockResolvedValueOnce(operation("again"));
    controller.request({ action: "update" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]![0].idempotencyKey).toBe("key-2");
  });

  it("does not repeat a request the Host refused", async () => {
    const { controller, follows, request } = shown();
    follows[0]!.listener(status());
    request.mockRejectedValueOnce(new DesktopUpdatesError("conflict"));
    controller.request({ action: "update" });
    await vi.waitFor(() => expect(controller.getSnapshot().failure).toBe("conflict"));
    controller.retry();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("follows again through a restart until the operation settles", () => {
    const { controller, follows } = shown();
    follows[0]!.listener(status(operation("a", "installing")));
    follows[0]!.onError(new DesktopUpdatesError("offline"));
    expect(controller.getSnapshot().failure).toBe("offline");
    vi.advanceTimersByTime(3_000);
    expect(follows).toHaveLength(2);
    follows[1]!.onError(new DesktopUpdatesError("offline"));
    vi.advanceTimersByTime(3_000);
    expect(follows).toHaveLength(3);
    follows[2]!.listener(status(operation("a", "succeeded")));
    expect(controller.getSnapshot()).toMatchObject({ failure: null, stalled: false });
  });

  it("calls a restart stalled only after it has been silent for minutes", () => {
    const { controller, follows } = shown();
    follows[0]!.listener(status(operation("a", "installing")));
    follows[0]!.onError(new DesktopUpdatesError("offline"));
    expect(controller.getSnapshot().stalled).toBe(false);
    vi.advanceTimersByTime(5 * 60_000);
    follows.at(-1)!.onError(new DesktopUpdatesError("offline"));
    expect(controller.getSnapshot().stalled).toBe(true);
  });

  it("stays down when nothing is running, until asked to try again", () => {
    const { controller, follows } = shown();
    follows[0]!.listener(status());
    follows[0]!.onError(new DesktopUpdatesError("offline"));
    vi.advanceTimersByTime(60_000);
    expect(follows).toHaveLength(1);
    controller.retry();
    expect(follows).toHaveLength(2);
  });

  it("stops reconnecting when hidden mid-restart", () => {
    const { follows, hide } = shown();
    follows[0]!.listener(status(operation("a", "installing")));
    follows[0]!.onError(new DesktopUpdatesError("offline"));
    hide();
    vi.advanceTimersByTime(60_000);
    expect(follows).toHaveLength(1);
  });
});
