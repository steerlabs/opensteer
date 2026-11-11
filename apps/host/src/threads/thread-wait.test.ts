import { createId } from "@opensteer/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadWaitService, type ThreadWaitSnapshot } from "./thread-wait.js";
const runId = createId("run");
function fixture() {
  const listeners = new Set<() => void>();
  let state: ThreadWaitSnapshot = {
    connected: true,
    run: {
      id: runId,
      status: "running",
    },
    messages: [],
  };
  const read = vi.fn(async () => state);
  const service = new ThreadWaitService({
    subscribe: (wake) => {
      listeners.add(wake);
      return () => {
        listeners.delete(wake);
      };
    },
    read,
  });
  const controller = new AbortController();
  const wait = () =>
    service.wait({
      timeoutMs: 1000,
      signal: controller.signal,
    });
  return {
    service,
    read,
    listeners,
    controller,
    wait,
    change(next: Partial<ThreadWaitSnapshot>) {
      state = {
        ...state,
        ...next,
      };
      for (const wake of listeners) wake();
    },
  };
}
afterEach(() => vi.useRealTimers());
describe("bounded Thread waits", () => {
  it("returns settled on a Run completion event and releases its listener", async () => {
    const f = fixture();
    const pending = f.wait();
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
    f.change({
      run: {
        id: runId,
        status: "completed",
      },
    });
    expect(await pending).toMatchObject({
      status: "settled",
      run: {
        id: runId,
        status: "completed",
      },
    });
    expect(f.listeners.size).toBe(0);
  });
  it("uses one deadline and performs no periodic reads", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = f.wait();
    await vi.advanceTimersByTimeAsync(999);
    expect(f.read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({
      status: "timed_out",
    });
    expect(f.listeners.size).toBe(0);
  });
  it("returns timed_out even when the initial snapshot exceeds the wait budget", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finish!: (snapshot: ThreadWaitSnapshot) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.wait();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({
      status: "timed_out",
      messages: [],
    });
    expect(f.listeners.size).toBe(0);
    finish({
      connected: true,
      messages: [],
    });
  });
  it("reports offline when presence is lost", async () => {
    const f = fixture();
    const pending = f.wait();
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
    f.change({
      connected: false,
    });
    expect(await pending).toMatchObject({
      status: "offline",
    });
  });
  it("aborts on disconnect without mutating work", async () => {
    const f = fixture();
    const pending = f.wait();
    const rejected = expect(pending).rejects.toThrow("Disconnected");
    f.controller.abort(new Error("Disconnected"));
    await rejected;
    expect(f.listeners.size).toBe(0);
  });
  it("closes the subscribe/read race and coalesces events during an in-flight read", async () => {
    const f = fixture();
    let finish!: (snapshot: ThreadWaitSnapshot) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.wait();
    expect(f.listeners.size).toBe(1);
    f.change({
      run: {
        id: runId,
        status: "completed",
      },
    });
    finish({
      connected: true,
      run: {
        id: runId,
        status: "running",
      },
      messages: [],
    });
    expect(await pending).toMatchObject({
      status: "settled",
    });
    expect(f.read).toHaveBeenCalledTimes(2);
  });
  it("returns a new message while work is running", async () => {
    const f = fixture();
    const pending = f.wait();
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
    f.change({
      messages: [
        {
          id: createId("message"),
        } as never,
      ],
    });
    expect(await pending).toMatchObject({
      status: "running",
      messages: [expect.anything()],
    });
  });
  it("rechecks an event received during a terminal read before returning its result", async () => {
    const f = fixture();
    let finish!: (snapshot: ThreadWaitSnapshot) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.wait();
    const rejected = expect(pending).rejects.toThrow("Revoked");
    f.read.mockRejectedValueOnce(new Error("Revoked"));
    f.change({});
    finish({
      connected: true,
      run: {
        id: runId,
        status: "completed",
      },
      messages: [],
    });
    await rejected;
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.listeners.size).toBe(0);
  });
  it("keeps a real 30-day connection alive for the bounded wait", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.change({
      authorityExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });
    const pending = f.wait();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({
      status: "timed_out",
    });
    expect(f.read).toHaveBeenCalledOnce();
  });
  it("returns when the Thread needs the person", async () => {
    const f = fixture();
    const pending = f.wait();
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
    const pendingRequest = {
      id: createId("request"),
      kind: "approval",
    };
    f.change({
      pendingRequest,
    });
    expect(await pending).toMatchObject({
      status: "running",
      pendingRequest,
    });
    expect(f.listeners.size).toBe(0);
  });
  it("expires caller authority at its own deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.change({
      authorityExpiresAt: Date.now() + 100,
    });
    const pending = f.wait();
    const rejected = expect(pending).rejects.toThrow("MCP caller authority expired");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(0);
  });
  it("stops when live authority is revoked", async () => {
    const f = fixture();
    const pending = f.wait();
    const rejected = expect(pending).rejects.toThrow("Revoked");
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
    f.read.mockRejectedValueOnce(new Error("Revoked"));
    f.change({});
    await rejected;
    expect(f.listeners.size).toBe(0);
  });
});
