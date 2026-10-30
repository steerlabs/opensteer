import { createId } from "@opensteer/core";
import { HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  runnerCatalogReadiness,
  runnerReady,
  type RunnerReadinessSnapshot,
} from "./runner-readiness.test-support.js";

// Isolated failure schedules: wrong boot/environment; preparing; partial captures;
// a new connection combining old readiness; reconnecting back to an earlier ID.
const environment = createId("environment");
const accounts = [createId("harnessInstance"), createId("harnessInstance")];
const catalogs = accounts.map((harnessInstanceId) =>
  HarnessInstanceCatalogSchema.parse({
    driverKind: "codex",
    harnessInstanceId,
    status: "ready",
    models: [
      { displayName: "Test", isDefault: true, modelId: "test", options: [], providerId: "openai" },
    ],
    continuationIdentity: {
      driverKind: "codex",
      continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
    },
  }),
);
function readiness(requireReady = true) {
  const ready = vi.fn();
  return {
    ready,
    observe: runnerCatalogReadiness({
      bootId: "new-boot",
      environmentId: environment,
      harnessInstanceIds: accounts,
      requireReady,
      onReady: ready,
    }),
  };
}

describe("Runner catalog readiness connection fencing", () => {
  it("ignores other boots and environments, and never treats preparing as ready", () => {
    const { observe, ready } = readiness();
    observe("old-boot", "connection-a", environment, catalogs);
    observe("new-boot", "connection-a", createId("environment"), catalogs);
    observe(
      "new-boot",
      "connection-a",
      environment,
      catalogs.map((catalog) => ({
        ...catalog,
        status: "preparing",
        detail: "Preparing",
        models: [],
      })),
    );
    expect(ready).not.toHaveBeenCalled();
  });
  it("joins partial captures only on the same connection", () => {
    const { observe, ready } = readiness();
    observe("new-boot", "connection-a", environment, [catalogs[0]!]);
    expect(ready).not.toHaveBeenCalled();
    observe("new-boot", "connection-b", environment, [catalogs[1]!]);
    expect(ready).not.toHaveBeenCalled();
    observe("new-boot", "connection-a", environment, [catalogs[0]!]);
    expect(ready).not.toHaveBeenCalled();
    observe("new-boot", "connection-a", environment, [catalogs[1]!]);
    expect(ready).toHaveBeenCalledOnce();
  });
  it("allows first-boot sign-in-required only after every account settles", () => {
    const { observe, ready } = readiness(false);
    observe("new-boot", "connection-a", environment, [
      {
        ...catalogs[0]!,
        status: "authentication-required",
        detail: "Sign in",
        models: [],
      },
    ]);
    expect(ready).not.toHaveBeenCalled();
    observe("new-boot", "connection-a", environment, [catalogs[1]!]);
    expect(ready).toHaveBeenCalledOnce();
  });
});

describe("boot-specific observation", () => {
  it("rejects stale incarnation data until the expected current connection commits", async () => {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    let snapshot: RunnerReadinessSnapshot = {
      bootId: "old",
      environmentId: environment,
      connectionId: "old-connection",
      currentConnectionId: "new-connection",
      connected: true,
      catalogs,
    };
    const pending = runnerReady({
      bootId: "new",
      environmentId: environment,
      harnessInstanceIds: accounts,
      deadlineMs: 10,
      read: () => snapshot,
      subscribe: (notify) => {
        listeners.add(notify);
        return () => {
          listeners.delete(notify);
        };
      },
    });
    let settled = false;
    void pending.promise.then(() => {
      settled = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(false);
      snapshot = { ...snapshot, bootId: "new" };
      for (const notify of listeners) notify();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(false);
      snapshot = {
        ...snapshot,
        connectionId: "new-connection",
        environmentId: createId("environment"),
      };
      for (const notify of listeners) notify();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(false);
      snapshot = { ...snapshot, environmentId: environment };
      for (const notify of listeners) notify();
      await pending.promise;
      expect(listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      pending.dispose();
      vi.useRealTimers();
    }
  });
  it("fails on an unexpected disconnect", async () => {
    const unsubscribe = vi.fn();
    const pending = runnerReady({
      bootId: "new",
      environmentId: environment,
      harnessInstanceIds: accounts,
      deadlineMs: 10,
      read: () => ({
        bootId: "new",
        environmentId: environment,
        connectionId: "a",
        currentConnectionId: undefined,
        connected: false,
        catalogs,
      }),
      subscribe: () => unsubscribe,
    });
    await expect(pending.promise).rejects.toThrow("disconnected");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
