import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectionController, type ConnectionLease } from "./connection-controller.js";
import { classifyClientFailure } from "./operation-error.js";
import { HostTransportError } from "./host-transport-error.js";
import type {
  ClientLifecycle,
  ClientLifecycleSnapshot,
  ClientNetworkPath,
  ClientNetworkState,
} from "../host/lifecycle.js";

function lifecycle() {
  let state: ClientLifecycleSnapshot = { network: "online", visibility: "foreground" };
  const foreground = new Set<() => void>(),
    background = new Set<() => void>();
  const network = new Set<(state: ClientNetworkState, path: ClientNetworkPath) => void>();
  const port: ClientLifecycle = {
    getSnapshot: () => state,
    onForeground: (fn) => {
      foreground.add(fn);
      return () => foreground.delete(fn);
    },
    onBackground: (fn) => {
      background.add(fn);
      return () => background.delete(fn);
    },
    onNetworkChange: (fn) => {
      network.add(fn);
      return () => network.delete(fn);
    },
  };
  return {
    port,
    background() {
      state = { ...state, visibility: "background" };
      background.forEach((fn) => fn());
    },
    foreground() {
      state = { ...state, visibility: "foreground" };
      foreground.forEach((fn) => fn());
    },
    network(value: ClientNetworkState) {
      state = { ...state, network: value };
      network.forEach((fn) => fn(value, "changed"));
    },
  };
}
function lease(): ConnectionLease {
  return { closed: new Promise(() => {}), probe: async () => {}, close: () => {} };
}
afterEach(() => vi.useRealTimers());
describe("session recovery owner", () => {
  it.each(["network", "foreground"] as const)(
    "recovers a failed first attachment on %s",
    async (wake) => {
      vi.useFakeTimers();
      const life = lifecycle();
      let available = false;
      const connection = createConnectionController({
        lifecycle: life.port,
        driver: {
          async connect() {
            if (!available) throw new HostTransportError("unreachable");
            return lease();
          },
        },
      });
      connection.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(connection.getSnapshot().phase).toBe("recovering");
      available = true;
      if (wake === "network") {
        life.network("offline");
        life.network("online");
      } else {
        life.background();
        life.foreground();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(connection.getSnapshot()).toMatchObject({
        phase: "ready",
        readyRevision: 1,
        showInterruption: false,
      });
      connection.dispose();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("has one automatic 5 s clock, resets in background, and exposes explicit failure immediately", async () => {
    vi.useFakeTimers();
    const life = lifecycle();
    const connection = createConnectionController({
      lifecycle: life.port,
      random: () => 0,
      driver: {
        connect: async () => {
          throw new HostTransportError("unreachable");
        },
      },
    });
    connection.start();
    await vi.advanceTimersByTimeAsync(4999);
    expect(connection.getSnapshot().showInterruption).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(connection.getSnapshot().showInterruption).toBe(true);
    life.background();
    await vi.advanceTimersByTimeAsync(60_000);
    life.foreground();
    await vi.advanceTimersByTimeAsync(4999);
    expect(connection.getSnapshot().showInterruption).toBe(false);
    connection.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getSnapshot()).toMatchObject({ showInterruption: true, trying: false });
    connection.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not bypass the hold for OS offline, but blocks immediately on a real refusal", async () => {
    vi.useFakeTimers();
    const life = lifecycle();
    life.network("offline");
    const connection = createConnectionController({
      lifecycle: life.port,
      driver: { connect: async () => lease() },
    });
    connection.start();
    await vi.advanceTimersByTimeAsync(4999);
    expect(connection.getSnapshot().showInterruption).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(connection.getSnapshot().showInterruption).toBe(true);
    connection.dispose();
    const blocked = createConnectionController({
      driver: {
        connect: async () => {
          throw Object.assign(new Error(), { code: "unauthorized", retryable: false });
        },
      },
    });
    blocked.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(blocked.getSnapshot()).toMatchObject({
      phase: "blocked",
      showInterruption: true,
      issue: { code: "sign-in" },
    });
    blocked.dispose();
  });
  it("closes a late lease instead of publishing a superseded attachment", async () => {
    vi.useFakeTimers();
    let finish!: (value: ConnectionLease) => void;
    const connection = createConnectionController({
      driver: {
        connect: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    });
    connection.start();
    connection.stop();
    let closed = false;
    finish({
      ...lease(),
      close() {
        closed = true;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(true);
    expect(connection.getSnapshot().phase).toBe("idle");
    connection.dispose();
  });
  it("fences work when the lease ends and increments readyRevision only after sync", async () => {
    vi.useFakeTimers();
    let close!: (failure: ReturnType<typeof classifyClientFailure>) => void;
    const connection = createConnectionController({
      driver: {
        connect: async () => ({
          ...lease(),
          closed: new Promise((resolve) => {
            close = resolve;
          }),
        }),
      },
    });
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    const before = connection.getSnapshot();
    close(classifyClientFailure(new HostTransportError("unreachable")));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getSnapshot().epoch).toBeGreaterThan(before.epoch);
    expect(connection.getSnapshot().readyRevision).toBe(before.readyRevision);
    connection.dispose();
  });
});
