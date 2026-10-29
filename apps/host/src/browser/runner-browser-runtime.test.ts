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
