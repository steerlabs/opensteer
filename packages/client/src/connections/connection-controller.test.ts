import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectionController, type ConnectionLease } from "./connection-controller.js";
import { classifyClientFailure, ClientOperationError } from "./operation-error.js";
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
  it("never presents an old interruption after a network return during failure publication", async () => {
    vi.useFakeTimers();
    const life = lifecycle();
    const closed = Promise.withResolvers<ReturnType<typeof classifyClientFailure>>();
    let initial = true;
    const connection = createConnectionController({
      lifecycle: life.port,
      backoff: { baseMs: 20_000, maximumMs: 20_000 },
      driver: {
        async connect(attempt) {
          const live = initial ? { ...lease(), closed: closed.promise } : lease();
          initial = false;
          attempt.admit?.(live);
          return live;
        },
      },
    });
    try {
      connection.start();
      await vi.advanceTimersByTimeAsync(3500);
      let returned = false;
      const notices: boolean[] = [];
      connection.subscribe(() => {
        const state = connection.getSnapshot();
        notices.push(state.showInterruption);
        if (state.phase === "recovering" && !returned) {
          returned = true;
          life.network("online");
        }
      });
      closed.resolve(classifyClientFailure(new HostTransportError("unreachable")));
      await vi.advanceTimersByTimeAsync(1500);
      expect(returned).toBe(true);
      await vi.advanceTimersByTimeAsync(5000);
      expect(notices).not.toContain(true);
      expect(connection.getSnapshot().phase).toBe("ready");
    } finally {
      connection.dispose();
    }
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
  it.each(["unauthorized", "forbidden", "identity-mismatch"])(
    "evicts session scope atomically after %s",
    async (reason) => {
      vi.useFakeTimers();
      let fail!: (failure: ReturnType<typeof classifyClientFailure>) => void;
      const connection = createConnectionController({
        driver: {
          connect: async (attempt) => {
            attempt.acceptScope({
              authorityKey: "verified",
              deploymentId: "deployment",
              viewerId: "viewer",
              loginId: "login",
            });
            return {
              ...lease(),
              closed: new Promise((resolve) => {
                fail = resolve;
              }),
            };
          },
        },
      });
      connection.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(connection.getSnapshot().scope).not.toBeNull();
      const seen: unknown[] = [];
      connection.subscribe(() => seen.push(connection.getSnapshot().scope));
      fail(
        classifyClientFailure(
          new ClientOperationError("PRIVATE denial", "blocked", {
            code: reason === "identity-mismatch" ? "verification-failed" : reason,
            reason,
            provenance: reason === "identity-mismatch" ? "protocol" : "host",
            kind: "session",
            retryable: false,
          }),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(connection.getSnapshot()).toMatchObject({
        phase: "blocked",
        scope: null,
        showInterruption: true,
      });
      expect(seen.every((scope) => scope === null)).toBe(true);
      connection.dispose();
    },
  );
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

it("keeps a confirmed refusal visible after backgrounding and returning", async () => {
  vi.useFakeTimers();
  const life = lifecycle();
  const connection = createConnectionController({
    lifecycle: life.port,
    driver: {
      connect: async () => {
        throw new ClientOperationError("Sign in to continue.", "blocked", {
          code: "unauthorized",
          reason: "sign-in-required",
          provenance: "host",
          kind: "session",
          retryable: false,
        });
      },
    },
  });
  connection.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(connection.getSnapshot().showInterruption).toBe(true);
  life.background();
  life.foreground();
  expect(connection.getSnapshot()).toMatchObject({
    phase: "blocked",
    showInterruption: true,
    issue: { code: "sign-in" },
  });
  connection.dispose();
});
