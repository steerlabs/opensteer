import { createId } from "@opensteer/core";
import type { RunnerAuxiliaryStream } from "@opensteer/orchestration";
import type { RoutedHostToBrowserRelayMessage } from "@opensteer/protocol/browser-relay";
import { afterEach, expect, it, vi } from "vitest";
import type { RunnerBrowserHooks, RunnerBrowserRegistry } from "./runner-browser-hub.js";
import { RunnerBrowserRuntimeRouter } from "./runner-browser-runtime.js";

afterEach(() => vi.useRealTimers());

it.each([undefined, 1] as const)(
  "reads targetControl %s from the advertised browser module",
  (targetControl) => {
    const runnerId = createId("runner");
    const stream = {
      identity: {
        runnerId,
        modules: { browser: { profileSnapshotVersion: 2, runtimeId: "browser", targetControl } },
      },
    } as RunnerAuxiliaryStream;
    const registry: RunnerBrowserRegistry = {
      browserStreams: () => [stream],
      stream: () => stream,
      send: async () => undefined,
      subscribe: () => () => undefined,
    };
    const router = new RunnerBrowserRuntimeRouter({ registry });
    try {
      expect(router.resolve({ kind: "runner", runnerId })).toMatchObject({
        targetControl: targetControl === 1,
      });
    } finally {
      router.close();
    }
  },
);

it.each([
  [undefined, undefined],
  [1, undefined],
  [2, false],
  [2, true],
] as const)("keeps editing %s and explicit clipboard %s distinct", (editing, clipboard) => {
  const runnerId = createId("runner");
  const stream = {
    identity: {
      runnerId,
      modules: { browser: { profileSnapshotVersion: 2, runtimeId: "browser", editing, clipboard } },
    },
  } as RunnerAuxiliaryStream;
  const registry: RunnerBrowserRegistry = {
    browserStreams: () => [stream],
    stream: () => stream,
    send: async () => undefined,
    subscribe: () => () => undefined,
  };
  const router = new RunnerBrowserRuntimeRouter({ registry });
  try {
    expect(router.resolve({ kind: "runner", runnerId })).toMatchObject({
      editing,
      clipboard: editing === 1 || clipboard === true,
    });
  } finally {
    router.close();
  }
});

it("lists an older browser as update-required and refuses direct placement", () => {
  const runnerId = createId("runner");
  const stream = {
    identity: {
      environmentIds: [createId("environment")],
      modules: { browser: { runtimeId: "older-browser" } },
      name: "Older computer",
      runnerId,
    },
  } as unknown as RunnerAuxiliaryStream;
  const registry: RunnerBrowserRegistry = {
    browserStreams: () => [stream],
    stream: () => stream,
    send: async () => undefined,
    subscribe: () => () => undefined,
  };
  const router = new RunnerBrowserRuntimeRouter({ registry });
  try {
    expect(router.placements()).toEqual([
      expect.objectContaining({
        available: false,
        label: "Older computer",
        runnerId,
        unavailableReason: expect.stringMatching(/Update the Browser Runtime.*version 2/u),
      }),
    ]);
    expect(() => router.resolve({ kind: "runner", runnerId })).toThrow(/version 2/u);
  } finally {
    router.close();
  }
});

it("asks for a Host update when the connected browser advertises a newer snapshot", () => {
  const runnerId = createId("runner");
  const stream = {
    identity: {
      environmentIds: [],
      modules: { browser: { profileSnapshotVersion: 3, runtimeId: "newer-browser" } },
      name: "Newer computer",
      runnerId,
    },
  } as unknown as RunnerAuxiliaryStream;
  const registry: RunnerBrowserRegistry = {
    browserStreams: () => [stream],
    stream: () => stream,
    send: async () => undefined,
    subscribe: () => () => undefined,
  };
  const router = new RunnerBrowserRuntimeRouter({ registry });
  try {
    expect(router.placements()).toEqual([
      expect.objectContaining({
        available: false,
        unavailableReason: expect.stringMatching(/Update this Opensteer Host.*version 3/u),
      }),
    ]);
    expect(() => router.resolve({ kind: "runner", runnerId })).toThrow(
      /Update this Opensteer Host/u,
    );
  } finally {
    router.close();
  }
});

it("closes a browser whose background renewal times out without an unhandled rejection", async () => {
  vi.useFakeTimers();
  const runnerId = createId("runner");
  const stream = {
    fence: { runnerId, connectionId: "connection", connectionGeneration: 1 },
    identity: {
      runnerId,
      modules: { browser: { profileSnapshotVersion: 2, runtimeId: "browser" } },
    },
    streamLeaseExpiresAt: new Date(Date.now() + 10_000).toISOString(),
  } as RunnerAuxiliaryStream;
  let hooks: RunnerBrowserHooks = {};
  let grants = 0;
  const send = async (_runnerId: unknown, message: RoutedHostToBrowserRelayMessage) => {
    if (message.type === "capability.grant") {
      grants++;
      if (grants > 1) return; // Initial attach works; renewal receives no reply.
      await hooks.onMessage?.(stream, {
        ...stream.fence,
        type: "capability.accepted",
        requestId: message.requestId,
        capability: {
          capabilityGeneration: message.lease.capabilityGeneration,
          capabilityLeaseId: message.lease.capabilityLeaseId,
          runtimeId: message.lease.runtimeId,
        },
      });
    } else if (message.type === "browser.attach") {
      await hooks.onMessage?.(stream, {
        ...stream.fence,
        type: "browser.attached",
        requestId: message.requestId,
        channelId: message.channelId,
        capability: message.capability,
      });
    }
  };
  const registry: RunnerBrowserRegistry = {
    browserStreams: () => [stream],
    stream: () => stream,
    send,
    subscribe: (value) => {
      hooks = value;
      return () => undefined;
    },
  };
  const router = new RunnerBrowserRuntimeRouter({ registry, requestTimeoutMs: 100 });
  try {
    const connection = router.resolve({ kind: "runner", runnerId })!.connect("ticket");
    const onError = vi.fn();
    const onClose = vi.fn();
    connection.on("error", onError);
    connection.on("close", onClose);
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.readyState).toBe(1);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(grants).toBe(2);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "The browser relay request timed out." }),
    );
    expect(onClose).toHaveBeenCalledWith(1011, expect.any(Buffer));
    expect(connection.readyState).toBe(3);
    // Vitest fails this test run if the timer produces an unhandled rejection.
  } finally {
    router.close();
  }
});

it("keeps native execution unavailable until the exact stream completes reconciliation", async () => {
  const runnerId = createId("runner");
  const storageInstanceId = crypto.randomUUID();
  const stream = {
    fence: { runnerId, connectionId: "connection-native" },
    identity: {
      runnerId,
      name: "Native",
      environmentIds: [],
      modules: {
        browser: {
          runtimeId: "native",
          profileSnapshotVersion: 2,
          localProfiles: 1,
          localProfileStorage: { storageInstanceId, engine: "electron" },
        },
      },
    },
  } as unknown as RunnerAuxiliaryStream;
  let hooks!: RunnerBrowserHooks;
  const registry: RunnerBrowserRegistry = {
    browserStreams: () => [stream],
    stream: () => stream,
    send: async () => undefined,
    subscribe: (value) => {
      hooks = value;
      return () => undefined;
    },
  };
  const reconcile = vi.fn(async () => undefined);
  const router = new RunnerBrowserRuntimeRouter({
    registry,
    localProfiles: {
      reconcileInventory: reconcile,
      jobs: async () => [],
      acknowledgeDeletion: async () => undefined,
    },
  });
  try {
    expect(router.placements()[0]?.available).toBe(false);
    expect(() => router.resolve({ kind: "runner", runnerId })).toThrow("reconcil");
    await hooks.onMessage!(stream, {
      ...stream.fence,
      module: "browser" as const,
      type: "browser.profile.inventory",
      storageInstanceId,
      engine: "electron",
      profiles: [],
      complete: false,
    } as never);
    expect(router.placements()[0]?.available).toBe(false);
    await hooks.onMessage!(stream, {
      ...stream.fence,
      module: "browser" as const,
      type: "browser.profile.inventory",
      storageInstanceId,
      engine: "electron",
      profiles: [],
      complete: true,
    } as never);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(router.placements()[0]?.available).toBe(true);
    expect(router.resolve({ kind: "runner", runnerId })).toMatchObject({
      localProfileStorage: { storageInstanceId, engine: "electron" },
    });
    hooks.onLost!(stream, "host-shutdown");
    expect(router.placements()[0]?.available).toBe(false);
  } finally {
    router.close();
  }
});

it.each(["pending-restart", "deleted"] as const)(
  "resumes durable native erasure and accepts %s only for the correlated binding",
  async (state) => {
    const runnerId = createId("runner"),
      storageInstanceId = crypto.randomUUID();
    const binding = {
      version: 1 as const,
      deploymentId: createId("deployment"),
      profileId: createId("browserProfile"),
      runnerId,
      storageInstanceId,
      bindingId: crypto.randomUUID(),
      engine: "electron" as const,
    };
    const deletionId = crypto.randomUUID();
    const stream = {
      fence: { runnerId, connectionId: "native-erasure", connectionGeneration: 1 },
      identity: {
        runnerId,
        modules: {
          browser: {
            runtimeId: "browser",
            profileSnapshotVersion: 2,
            localProfiles: 1,
            localProfileStorage: { storageInstanceId, engine: "electron" },
          },
        },
      },
      streamLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as RunnerAuxiliaryStream;
    let hooks: RunnerBrowserHooks = {};
    const acknowledgeDeletion = vi.fn(async () => undefined);
    const sent: string[] = [];
    const registry: RunnerBrowserRegistry = {
      browserStreams: () => [stream],
      stream: () => stream,
      subscribe: (value) => {
        hooks = value;
        return () => undefined;
      },
      send: async (_id, message) => {
        sent.push(message.type);
        if (message.type === "capability.grant")
          await hooks.onMessage?.(stream, {
            ...stream.fence,
            type: "capability.accepted",
            requestId: message.requestId,
            capability: {
              capabilityGeneration: message.lease.capabilityGeneration,
              capabilityLeaseId: message.lease.capabilityLeaseId,
              runtimeId: message.lease.runtimeId,
            },
          });
        if (message.type === "browser.profile.delete")
          await hooks.onMessage?.(stream, {
            ...message,
            type: "browser.profile.delete.result",
            state,
          });
        if (message.type === "capability.revoke")
          await hooks.onMessage?.(stream, {
            ...stream.fence,
            requestId: message.requestId,
            capability: message.capability,
            type: "capability.revoked",
          });
      },
    };
    const router = new RunnerBrowserRuntimeRouter({
      registry,
      localProfiles: {
        reconcileInventory: async () => undefined,
        jobs: async () => [{ binding, deletionId, state: "pending-computer" }],
        acknowledgeDeletion,
      },
    });
    try {
      await router.resumeDeletions(runnerId);
      expect(sent).toEqual([]);
      await hooks.onMessage?.(stream, {
        ...stream.fence,
        module: "browser" as const,
        type: "browser.profile.inventory",
        storageInstanceId,
        engine: "electron",
        profiles: [],
        complete: true,
      });
      await router.resumeDeletions(runnerId);
      expect(acknowledgeDeletion).toHaveBeenCalledExactlyOnceWith({ binding, deletionId, state });
      expect(sent).toEqual(["capability.grant", "browser.profile.delete", "capability.revoke"]);
    } finally {
      router.close();
    }
  },
);

it("never admits a failed or truncated inventory as an empty complete inventory", async () => {
  const runnerId = createId("runner"),
    storageInstanceId = crypto.randomUUID();
  const stream = {
    fence: { runnerId, connectionId: "broken-inventory" },
    identity: {
      runnerId,
      environmentIds: [],
      name: "Broken",
      modules: {
        browser: {
          runtimeId: "browser",
          profileSnapshotVersion: 2,
          localProfiles: 1,
          localProfileStorage: { storageInstanceId, engine: "electron" },
        },
      },
    },
  } as unknown as RunnerAuxiliaryStream;
  let hooks: RunnerBrowserHooks = {};
  const router = new RunnerBrowserRuntimeRouter({
    registry: {
      browserStreams: () => [stream],
      stream: () => stream,
      send: async () => undefined,
      subscribe: (value) => {
        hooks = value;
        return () => undefined;
      },
    },
    localProfiles: {
      reconcileInventory: async () => {
        throw new Error("unreadable inventory");
      },
      jobs: async () => [],
      acknowledgeDeletion: async () => undefined,
    },
  });
  const inventory = {
    ...stream.fence,
    module: "browser" as const,
    type: "browser.profile.inventory" as const,
    storageInstanceId,
    engine: "electron" as const,
    profiles: [],
    complete: true,
  };
  try {
    await expect(hooks.onMessage!(stream, inventory)).rejects.toThrow("unreadable inventory");
    expect(router.placements()[0]?.available).toBe(false);
    await expect(hooks.onMessage!(stream, inventory)).rejects.toThrow("already complete");
    expect(router.placements()[0]?.available).toBe(false);
  } finally {
    router.close();
  }
});

it("retries the same erasure after a lost acknowledgement on a replacement auxiliary stream", async () => {
  vi.useFakeTimers();
  const runnerId = createId("runner"),
    storageInstanceId = crypto.randomUUID(),
    deletionId = crypto.randomUUID();
  const binding = {
    version: 1 as const,
    deploymentId: createId("deployment"),
    profileId: createId("browserProfile"),
    runnerId,
    storageInstanceId,
    bindingId: crypto.randomUUID(),
    engine: "electron" as const,
  };
  let stream = {
    fence: {
      runnerId,
      connectionId: "same-primary",
      auxiliaryStreamId: "first-stream",
      connectionGeneration: 1,
    },
    identity: {
      runnerId,
      environmentIds: [],
      name: "Owner",
      modules: {
        browser: {
          runtimeId: "browser",
          profileSnapshotVersion: 2,
          localProfiles: 1,
          localProfileStorage: { storageInstanceId, engine: "electron" },
        },
      },
    },
    streamLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  } as unknown as RunnerAuxiliaryStream;
  let hooks: RunnerBrowserHooks = {};
  let attempts = 0;
  const acknowledgeDeletion = vi.fn(async () => undefined);
  const registry: RunnerBrowserRegistry = {
    browserStreams: () => [stream],
    stream: () => stream,
    subscribe: (value) => {
      hooks = value;
      return () => undefined;
    },
    send: async (_runnerId, message) => {
      if (message.type === "capability.grant")
        await hooks.onMessage?.(stream, {
          ...stream.fence,
          type: "capability.accepted",
          requestId: message.requestId,
          capability: {
            capabilityGeneration: message.lease.capabilityGeneration,
            capabilityLeaseId: message.lease.capabilityLeaseId,
            runtimeId: message.lease.runtimeId,
          },
        });
      if (message.type === "browser.profile.delete") {
        expect(message).toMatchObject({ deletionId, binding });
        if (++attempts > 1)
          await hooks.onMessage?.(stream, {
            ...message,
            type: "browser.profile.delete.result",
            state: "deleted",
          });
      }
      if (message.type === "capability.revoke")
        await hooks.onMessage?.(stream, {
          ...stream.fence,
          type: "capability.revoked",
          requestId: message.requestId,
          capability: message.capability,
        });
    },
  };
  const router = new RunnerBrowserRuntimeRouter({
    registry,
    requestTimeoutMs: 100,
    localProfiles: {
      reconcileInventory: async () => undefined,
      jobs: async () => [{ binding, deletionId, state: "pending-computer" }],
      acknowledgeDeletion,
    },
  });
  const inventory = () => ({
    ...stream.fence,
    module: "browser" as const,
    type: "browser.profile.inventory" as const,
    storageInstanceId,
    engine: "electron" as const,
    profiles: [],
    complete: true,
  });
  try {
    await hooks.onMessage!(stream, inventory());
    const lostAck = expect(router.resumeDeletions(runnerId)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await lostAck;
    expect(acknowledgeDeletion).not.toHaveBeenCalled();
    hooks.onLost?.(stream, "host-shutdown");
    stream = {
      ...stream,
      fence: {
        ...stream.fence,
        auxiliaryStreamId: "second-stream" as RunnerAuxiliaryStream["fence"]["auxiliaryStreamId"],
      },
    };
    expect(router.placements()[0]?.available).toBe(false);
    await hooks.onMessage!(stream, inventory());
    await router.resumeDeletions(runnerId);
    expect(attempts).toBe(2);
    expect(acknowledgeDeletion).toHaveBeenCalledExactlyOnceWith({
      binding,
      deletionId,
      state: "deleted",
    });
  } finally {
    router.close();
  }
});

it("shares capability acquisition when one of two concurrent attachments is cancelled", async () => {
  const runnerId = createId("runner");
  const stream = {
    fence: { runnerId, connectionId: "concurrent", connectionGeneration: 1 },
    identity: {
      runnerId,
      modules: { browser: { runtimeId: "browser", profileSnapshotVersion: 2 } },
    },
    streamLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  } as RunnerAuxiliaryStream;
  let hooks: RunnerBrowserHooks = {};
  let grant: Extract<RoutedHostToBrowserRelayMessage, { type: "capability.grant" }> | undefined;
  let grants = 0,
    revokes = 0;
  const router = new RunnerBrowserRuntimeRouter({
    registry: {
      browserStreams: () => [stream],
      stream: () => stream,
      subscribe: (value) => {
        hooks = value;
        return () => undefined;
      },
      send: async (_runnerId, message) => {
        if (message.type === "capability.grant") {
          grants++;
          grant = message;
        }
        if (message.type === "browser.attach")
          await hooks.onMessage?.(stream, {
            ...stream.fence,
            type: "browser.attached",
            requestId: message.requestId,
            channelId: message.channelId,
            capability: message.capability,
          });
        if (message.type === "capability.revoke") {
          revokes++;
          await hooks.onMessage?.(stream, {
            ...stream.fence,
            type: "capability.revoked",
            requestId: message.requestId,
            capability: message.capability,
          });
        }
      },
    },
  });
  try {
    const target = router.resolve({ kind: "runner", runnerId })!;
    const first = target.connect("first"),
      second = target.connect("second");
    first.on("error", () => undefined);
    second.on("error", () => undefined);
    await vi.waitFor(() => expect(grants, "capability acquisition did not begin").toBe(1));
    first.close();
    await hooks.onMessage!(stream, {
      ...stream.fence,
      type: "capability.accepted",
      requestId: grant!.requestId,
      capability: {
        capabilityGeneration: grant!.lease.capabilityGeneration,
        capabilityLeaseId: grant!.lease.capabilityLeaseId,
        runtimeId: grant!.lease.runtimeId,
      },
    });
    await vi.waitFor(() =>
      expect(second.readyState, "remaining attachment lost its capability").toBe(1),
    );
    expect(grants).toBe(1);
    expect(revokes).toBe(0);
  } finally {
    router.close();
  }
});

it("requires Personal's Main inventory before named profiles can open on another computer", async () => {
  const mainRunnerId = createId("runner"),
    otherRunnerId = createId("runner");
  const makeStream = (runnerId: typeof mainRunnerId, runnerKind: "main" | "managed") =>
    ({
      fence: { runnerId, connectionId: runnerId },
      identity: {
        runnerId,
        runnerKind,
        modules: {
          browser: {
            runtimeId: "browser",
            profileSnapshotVersion: 2,
            localProfiles: 1,
            localProfileStorage: { storageInstanceId: crypto.randomUUID(), engine: "electron" },
          },
        },
      },
    }) as unknown as RunnerAuxiliaryStream;
  const main = makeStream(mainRunnerId, "main"),
    other = makeStream(otherRunnerId, "managed");
  let hooks: RunnerBrowserHooks = {};
  const streams = [main, other];
  const router = new RunnerBrowserRuntimeRouter({
    registry: {
      browserStreams: () => streams,
      stream: (id) => streams.find((stream) => stream.identity.runnerId === id) ?? null,
      send: async () => undefined,
      subscribe: (value) => {
        hooks = value;
        return () => undefined;
      },
    },
    localProfiles: {
      reconcileInventory: async () => undefined,
      jobs: async () => [],
      acknowledgeDeletion: async () => undefined,
    },
  });
  const inventory = (stream: RunnerAuxiliaryStream) => ({
    ...stream.fence,
    module: "browser" as const,
    type: "browser.profile.inventory" as const,
    ...stream.identity.modules.browser!.localProfileStorage!,
    profiles: [],
    complete: true,
  });
  try {
    await hooks.onMessage!(other, inventory(other));
    expect(() => router.requirePersonalProfileInventory()).toThrow("Main computer");
    await hooks.onMessage!(main, inventory(main));
    expect(() => router.requirePersonalProfileInventory()).not.toThrow();
    hooks.onLost?.(main, "host-shutdown");
    expect(() => router.requirePersonalProfileInventory()).toThrow("Main computer");
  } finally {
    router.close();
  }
});
