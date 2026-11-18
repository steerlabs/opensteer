import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientRead } from "./client-read.js";
import { controlledClientSession } from "../test-support/client-connection.js";
import { HostTransportError } from "../connections/host-transport-error.js";
import { HostClientRequestError } from "../host/client.js";

afterEach(() => vi.useRealTimers());
describe("retained client reads", () => {
  it("keeps accepted data through an outage and replaces it on recovery", async () => {
    vi.useFakeTimers();
    const session = controlledClientSession();
    let value = "first";
    const read = createClientRead(session, {
      key: "items",
      label: "items",
      read: async () => value,
    });
    const release = read.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(read.getSnapshot()).toMatchObject({ status: "ready", data: "first", stale: false });
    session.change({ phase: "recovering", epoch: 2 });
    expect(read.getSnapshot()).toMatchObject({ status: "ready", data: "first", stale: true });
    value = "replacement";
    session.change({ phase: "ready", readyRevision: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(read.getSnapshot()).toMatchObject({
      status: "ready",
      data: "replacement",
      stale: false,
      issue: null,
    });
    release();
    read.dispose();
  });
  it("waits without cached data, then honestly exhausts an endpoint retry budget while connected", async () => {
    vi.useFakeTimers();
    const session = controlledClientSession();
    session.change({ phase: "recovering" });
    let attempts = 0,
      available = false;
    const read = createClientRead(session, {
      key: "items",
      label: "items",
      read: async () => {
        attempts++;
        if (available) return "recovered";
        throw new HostTransportError("timed-out");
      },
    });
    read.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(0);
    expect(read.getSnapshot().status).toBe("waiting");
    session.change({ phase: "ready", readyRevision: 2 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(attempts).toBe(3);
    expect(read.getSnapshot()).toMatchObject({ status: "failed", issue: { code: "read-failed" } });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(attempts).toBe(3);
    available = true;
    await read.refresh();
    expect(read.getSnapshot()).toMatchObject({ status: "ready", data: "recovered", issue: null });
    read.dispose();
  });
  it("shows an explicit unavailable refresh immediately while retaining data", async () => {
    vi.useFakeTimers();
    const session = controlledClientSession();
    const read = createClientRead(session, {
      key: "items",
      label: "items",
      read: async () => "accepted",
    });
    read.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    session.change({ phase: "recovering", epoch: 2, showInterruption: false });
    expect(read.getSnapshot()).toMatchObject({ data: "accepted", issue: null });
    await read.refresh();
    expect(read.getSnapshot()).toMatchObject({
      status: "ready",
      data: "accepted",
      stale: true,
      issue: { code: "refresh-failed" },
    });
    expect(session.connection.getSnapshot().showInterruption).toBe(false);
    session.change({ epoch: 3 });
    expect(read.getSnapshot().issue?.code).toBe("refresh-failed");
    session.change({ phase: "ready", readyRevision: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(read.getSnapshot()).toMatchObject({
      status: "ready",
      data: "accepted",
      stale: false,
      issue: null,
    });
    read.dispose();
  });
  it("coalesces a burst during an active read into exactly one trailing read", async () => {
    vi.useFakeTimers();
    const session = controlledClientSession();
    const finish: ((value: string) => void)[] = [];
    const read = createClientRead(session, {
      key: "items",
      label: "items",
      read: () =>
        new Promise((resolve) => {
          finish.push(resolve);
        }),
    });
    read.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    read.invalidate();
    read.invalidate();
    read.invalidate();
    finish[0]!("old");
    await vi.advanceTimersByTimeAsync(0);
    expect(finish).toHaveLength(2);
    finish[1]!("current");
    await vi.advanceTimersByTimeAsync(0);
    expect(read.getSnapshot()).toMatchObject({ status: "ready", data: "current" });
    expect(finish).toHaveLength(2);
    read.dispose();
  });
  it("fences an old viewer's result, including before React resubscribes, and evicts on access loss", async () => {
    vi.useFakeTimers();
    const session = controlledClientSession();
    let resolve!: (value: string) => void;
    let refusal = false;
    const read = createClientRead(session, {
      key: "items",
      label: "items",
      read: async () => {
        if (refusal)
          throw new HostClientRequestError({
            code: "forbidden",
            message: "secret",
            status: 403,
            retryable: false,
          });
        return new Promise<string>((done) => {
          resolve = done;
        });
      },
    });
    read.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const old = resolve;
    session.change({
      scope: { ...session.connection.getSnapshot().scope!, viewerId: "other", loginId: "other" },
      epoch: 2,
    });
    old("private old value");
    await vi.advanceTimersByTimeAsync(0);
    expect(read.getSnapshot().data).toBeNull();
    resolve("new viewer value");
    await vi.advanceTimersByTimeAsync(0);
    expect(read.getSnapshot().data).toBe("new viewer value");
    refusal = true;
    void read.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(read.getSnapshot()).toMatchObject({
      status: "failed",
      data: null,
      issue: { code: "access-lost" },
    });
    read.dispose();
  });
});

it.each(["first read", "current data", "scheduled retry"] as const)(
  "refreshes %s after a short background visit on the same lease",
  async (interrupted) => {
    vi.useFakeTimers();
    const session = controlledClientSession();
    const first = Promise.withResolvers<string>();
    const readOnce = vi
      .fn()
      .mockImplementationOnce(async (signal: AbortSignal) => {
        if (interrupted === "scheduled retry") throw new HostTransportError("timed-out");
        if (interrupted === "current data") return "cached";
        signal.addEventListener("abort", () => first.reject(signal.reason), { once: true });
        return first.promise;
      })
      .mockResolvedValue("fresh");
    const read = createClientRead(session, { key: "settings", label: "settings", read: readOnce });
    read.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    session.change({ visibility: "background" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(readOnce).toHaveBeenCalledTimes(1);
    session.change({ visibility: "foreground" });
    await vi.advanceTimersByTimeAsync(0);
    expect(read.getSnapshot()).toMatchObject({ status: "ready", data: "fresh", stale: false });
    read.dispose();
  },
);
