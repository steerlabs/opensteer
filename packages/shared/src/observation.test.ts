import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gate, observe } from "./observation.test-support.js";

describe("bounded observation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
  function source() {
    const listeners = new Set<() => void>();
    let value = 0;
    return {
      listeners,
      read: vi.fn(() => value),
      subscribe: (notify: () => void) => {
        listeners.add(notify);
        return () => {
          listeners.delete(notify);
        };
      },
      update: (next: number) => {
        value = next;
        for (const notify of listeners) notify();
      },
    };
  }
  it("registers before the initial read and sees an event before it", async () => {
    const state = source();
    const pending = observe({
      ...state,
      label: "before read",
      deadlineMs: 10,
      matches: (v) => v === 1,
    });
    expect(state.listeners.size).toBe(1);
    expect(state.read).not.toHaveBeenCalled();
    state.update(1);
    await expect(pending.promise).resolves.toBe(1);
    expect(state.listeners.size).toBe(0);
    expect(state.read).toHaveBeenCalledOnce();
  });
  it("coalesces events during a read into one serialized reread", async () => {
    const state = source();
    const held = Promise.withResolvers<number>();
    const read = vi
      .fn()
      .mockImplementationOnce(() => held.promise)
      .mockImplementation(state.read);
    const pending = observe({
      ...state,
      read,
      label: "during read",
      deadlineMs: 10,
      matches: (v: number) => v === 2,
    });
    await Promise.resolve();
    state.update(1);
    state.update(2);
    expect(read).toHaveBeenCalledOnce();
    held.resolve(0);
    await expect(pending.promise).resolves.toBe(2);
    expect(read).toHaveBeenCalledTimes(2);
    expect(state.listeners.size).toBe(0);
  });
  it.each([false, true])("bounds missing events and hung reads (hung=%s)", async (hung) => {
    const state = source();
    const pending = observe({
      ...state,
      read: hung ? () => new Promise<number>(() => {}) : state.read,
      label: "missing",
      deadlineMs: 10,
      matches: (v) => v === 1,
    });
    const rejected = expect(pending.promise).rejects.toThrow("missing timed out");
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(state.listeners.size).toBe(0);
  });
  it.each(["predicate", "read"])("propagates a failing %s and cleans up", async (failure) => {
    const state = source();
    const pending = observe({
      ...state,
      label: "failure",
      deadlineMs: 10,
      read: () => {
        if (failure === "read") throw new Error("broken");
        return 1;
      },
      matches: () => {
        throw new Error("broken");
      },
    });
    await expect(pending.promise).rejects.toThrow("broken");
    expect(state.listeners.size).toBe(0);
  });
  it.each(["abort", "dispose"])("rejects on %s and ignores late completion", async (action) => {
    const state = source();
    const held = Promise.withResolvers<number>();
    const controller = new AbortController();
    const matches = vi.fn(() => true);
    const pending = observe({
      ...state,
      read: () => held.promise,
      matches,
      label: "late",
      deadlineMs: 10,
      signal: controller.signal,
    });
    await Promise.resolve();
    if (action === "abort") controller.abort(new Error("aborted"));
    else pending.dispose();
    await expect(pending.promise).rejects.toThrow(action === "abort" ? "aborted" : "disposed");
    held.resolve(1);
    state.update(1);
    await Promise.resolve();
    pending.dispose();
    expect(matches).not.toHaveBeenCalled();
    expect(state.listeners.size).toBe(0);
  });
  it("does not subscribe when already aborted", async () => {
    const state = source();
    const pending = observe({
      ...state,
      signal: AbortSignal.abort(new Error("stopped")),
      label: "aborted",
      deadlineMs: 10,
      matches: () => true,
    });
    await expect(pending.promise).rejects.toThrow("stopped");
    expect(state.listeners.size).toBe(0);
    expect(state.read).not.toHaveBeenCalled();
  });
});

describe("one-shot gate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
  it("bounds a producer that never enters", async () => {
    const held = gate({ label: "never", deadlineMs: 10 });
    const rejected = expect(held.entered).rejects.toThrow("never entered");
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    await held.enter();
  });
  it("allows release before entry and repeated release", async () => {
    const held = gate({ label: "early", deadlineMs: 10 });
    held.release();
    held.release();
    await held.enter();
    await held.entered;
  });
  it("unblocks the producer on failure while held", async () => {
    const controller = new AbortController();
    const held = gate({ label: "held", deadlineMs: 10, signal: controller.signal });
    const producer = held.enter();
    await held.entered;
    controller.abort(new Error("failed assertion"));
    await producer;
  });
  it("aborts an entered wait even without entry", async () => {
    const held = gate({ label: "unused", deadlineMs: 10 });
    held.abort();
    await expect(held.entered).rejects.toThrow("aborted");
    await held.enter();
  });
});
