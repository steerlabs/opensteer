import { createId, type RunnerId } from "@opensteer/core";
import {
  runnerPowerStateCapability,
  type HostToRunnerMessage,
  type RunnerConnectionFence,
} from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RunnerRegistry,
  runnerMaxAsleepDurationMs,
  type RunnerIdentity,
  type RunnerPeer,
} from "./index.js";

class MemoryPeer implements RunnerPeer {
  readonly id: string;
  readonly sent: HostToRunnerMessage[] = [];
  closed: { readonly code: number; readonly reason: string } | undefined;

  constructor(id: string) {
    this.id = id;
  }

  async send(message: HostToRunnerMessage): Promise<void> {
    this.sent.push(message);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
}

function makeIdentity(
  runnerId: RunnerId,
  generation: number,
  options: { readonly powerCapable?: boolean } = {},
): RunnerIdentity {
  const connectionId = `rcn_${randomUUID()}` as RunnerConnectionFence["connectionId"];
  const connectionLeaseId = `rls_${randomUUID()}` as RunnerConnectionFence["connectionLeaseId"];
  const bootId = `rbt_${randomUUID()}` as RunnerConnectionFence["bootId"];
  const fence: RunnerConnectionFence = {
    bootId,
    connectionGeneration: generation,
    connectionId,
    connectionLeaseId,
    runnerId,
  };
  return {
    allowedModules: ["browser", "integrations"],
    bootId,
    capabilities: options.powerCapable === false ? [] : [runnerPowerStateCapability],
    connectionGeneration: generation,
    connectionId,
    connectionLeaseId,
    device: { app: "opensteer", form: "laptop", platform: "macos" },
    environmentIds: [],
    fence,
    modules: {},
    name: "Studio MacBook",
    personalRemoteAccessGeneration: null,
    runnerId,
    runnerKind: "local",
    runtimeVersion: "0.0.0",
  };
}

describe("RunnerRegistry asleep state machine", () => {
  it("marks a disconnected Runner asleep after runner.power.sleeping, clears on reconnect, and enforces the bound", async () => {
    let clock = Date.parse("2026-04-12T10:00:00.000Z");
    const registry = new RunnerRegistry({
      hooks: {
        authorize: async () => undefined,
        onEvent: async (_identity, event) => event.ordinal,
      },
      now: () => clock,
    });
    const runnerId = createId("runner");
    const peer1 = new MemoryPeer("peer-1");
    const identity1 = makeIdentity(runnerId, 1);

    try {
      await registry.register(identity1, peer1);
      expect(registry.isRunnerConnected(runnerId)).toBe(true);
      expect(registry.asleepSince(runnerId)).toBeNull();

      clock += 60_000;
      const sleepAt = clock;
      await registry.handle(peer1, {
        ...identity1.fence,
        type: "runner.power.sleeping",
      });
      // Still online until the connection actually drops.
      expect(registry.isRunnerConnected(runnerId)).toBe(true);
      expect(registry.asleepSince(runnerId)).toBeNull();

      clock += 1_000;
      registry.disconnect(peer1);
      expect(registry.isRunnerConnected(runnerId)).toBe(false);
      expect(registry.asleepSince(runnerId)?.toISOString()).toBe(new Date(sleepAt).toISOString());
      expect(registry.isRunnerAsleep(runnerId)).toBe(true);
      expect(registry.asleepSince(runnerId, 1)).not.toBeNull();
      expect(registry.asleepSince(runnerId, 2)).toBeNull();

      // Stays asleep right up to the bound, then falls back to offline.
      clock = sleepAt + runnerMaxAsleepDurationMs - 1;
      expect(registry.isRunnerAsleep(runnerId)).toBe(true);
      clock = sleepAt + runnerMaxAsleepDurationMs;
      expect(registry.asleepSince(runnerId)).toBeNull();
      expect(registry.isRunnerAsleep(runnerId)).toBe(false);

      // Reconnecting clears asleep immediately.
      const peer2 = new MemoryPeer("peer-2");
      const identity2 = makeIdentity(runnerId, 2);
      await registry.register(identity2, peer2);
      await registry.handle(peer2, {
        ...identity2.fence,
        type: "runner.power.sleeping",
      });
      registry.disconnect(peer2);
      expect(registry.isRunnerAsleep(runnerId)).toBe(true);

      const peer3 = new MemoryPeer("peer-3");
      const identity3 = makeIdentity(runnerId, 3);
      await registry.register(identity3, peer3);
      expect(registry.isRunnerConnected(runnerId)).toBe(true);
      expect(registry.asleepSince(runnerId)).toBeNull();
    } finally {
      await registry.close();
    }
  });

  it("does not carry a notice onto a replacement or a Host-directed disconnect", async () => {
    const registry = new RunnerRegistry({
      hooks: {
        authorize: async () => undefined,
        onEvent: async (_identity, event) => event.ordinal,
      },
    });
    const id = createId("runner");
    const first = new MemoryPeer("first");
    const replacement = new MemoryPeer("replacement");
    const firstIdentity = makeIdentity(id, 1);
    const replacementIdentity = makeIdentity(id, 2);
    try {
      await registry.register(firstIdentity, first);
      await registry.handle(first, { ...firstIdentity.fence, type: "runner.power.sleeping" });
      await registry.register(replacementIdentity, replacement);
      registry.disconnect(first);
      expect(registry.isRunnerConnected(id)).toBe(true);
      registry.disconnect(replacement);
      expect(registry.asleepSince(id)).toBeNull();

      const forced = new MemoryPeer("forced");
      const forcedIdentity = makeIdentity(id, 3);
      await registry.register(forcedIdentity, forced);
      await registry.handle(forced, { ...forcedIdentity.fence, type: "runner.power.sleeping" });
      await registry.disconnectConnection(forcedIdentity, {
        code: 1001,
        reason: "Remote access ended",
      });
      expect(registry.asleepSince(id)).toBeNull();
    } finally {
      await registry.close();
    }
  });

  it("stops reporting sleep when the Home starts shutting down", async () => {
    const registry = new RunnerRegistry({
      hooks: {
        authorize: async () => undefined,
        onEvent: async (_identity, event) => event.ordinal,
      },
    });
    const id = createId("runner");
    const peer = new MemoryPeer("sleeping");
    const identity = makeIdentity(id, 1);
    try {
      await registry.register(identity, peer);
      await registry.handle(peer, { ...identity.fence, type: "runner.power.sleeping" });
      registry.disconnect(peer);
      expect(registry.isRunnerAsleep(id)).toBe(true);
      const closing = registry.close();
      expect(registry.isRunnerAsleep(id)).toBe(false);
      await closing;
    } finally {
      await registry.close();
    }
  });

  it("treats unexpected disconnects and non-capable Runners as offline, clears on revoke, and cancels on later heartbeats", async () => {
    let clock = Date.parse("2026-04-12T10:00:00.000Z");
    const registry = new RunnerRegistry({
      hooks: {
        authorize: async () => undefined,
        onEvent: async (_identity, event) => event.ordinal,
      },
      now: () => clock,
    });

    try {
      // 1. Disconnect without sleep signal -> offline, not asleep.
      const unexpectedId = createId("runner");
      const unexpectedPeer = new MemoryPeer("unexpected");
      await registry.register(makeIdentity(unexpectedId, 1), unexpectedPeer);
      registry.disconnect(unexpectedPeer);
      expect(registry.asleepSince(unexpectedId)).toBeNull();

      // 2. Older / Linux Runner without capability -> sleep frame ignored -> offline.
      const legacyId = createId("runner");
      const legacyPeer = new MemoryPeer("legacy");
      const legacyIdentity = makeIdentity(legacyId, 1, { powerCapable: false });
      await registry.register(legacyIdentity, legacyPeer);
      await registry.handle(legacyPeer, {
        ...legacyIdentity.fence,
        type: "runner.power.sleeping",
      });
      registry.disconnect(legacyPeer);
      expect(registry.asleepSince(legacyId)).toBeNull();

      // 3. Sleep signal followed by a later heartbeat (>5s) cancels sleep so a later drop is offline.
      const stayedAwakeId = createId("runner");
      const stayedAwakePeer = new MemoryPeer("stayed-awake");
      const stayedAwakeIdentity = makeIdentity(stayedAwakeId, 1);
      await registry.register(stayedAwakeIdentity, stayedAwakePeer);
      await registry.handle(stayedAwakePeer, {
        ...stayedAwakeIdentity.fence,
        type: "runner.power.sleeping",
      });
      clock += 10_000;
      await registry.handle(stayedAwakePeer, {
        ...stayedAwakeIdentity.fence,
        activeRunIds: [],
        activeTriggerOccurrenceIds: [],
        activeWatchActivationIds: [],
        sentAt: new Date(clock).toISOString(),
        type: "runner.heartbeat",
      });
      registry.disconnect(stayedAwakePeer);
      expect(registry.asleepSince(stayedAwakeId)).toBeNull();

      // 4. Removal clears asleep even when already disconnected.
      const removedId = createId("runner");
      const removedPeer = new MemoryPeer("removed");
      const removedIdentity = makeIdentity(removedId, 1);
      await registry.register(removedIdentity, removedPeer);
      await registry.handle(removedPeer, {
        ...removedIdentity.fence,
        type: "runner.power.sleeping",
      });
      registry.disconnect(removedPeer);
      expect(registry.isRunnerAsleep(removedId)).toBe(true);
      await registry.revoke(removedId);
      expect(registry.isRunnerAsleep(removedId)).toBe(false);
    } finally {
      await registry.close();
    }
  });
});
