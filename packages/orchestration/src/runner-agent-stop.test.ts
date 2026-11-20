import { createId, type EnvironmentId, type RunnerId } from "@opensteer/core";
import {
  runnerAgentStopCapability,
  type HostToRunnerMessage,
  type RunnerConnectionFence,
} from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  RunnerRegistry,
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
  options: { readonly capable?: boolean; readonly environmentId?: EnvironmentId } = {},
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
    capabilities: options.capable === false ? [] : [runnerAgentStopCapability],
    connectionGeneration: generation,
    connectionId,
    connectionLeaseId,
    device: { app: "opensteer", form: "laptop", platform: "macos" },
    environmentIds: options.environmentId ? [options.environmentId] : [],
    fence,
    modules: {},
    name: "Studio MacBook",
    personalRemoteAccessGeneration: null,
    runnerId,
    runnerKind: "local",
    runtimeVersion: "0.0.0",
  };
}

function registry(clock: () => number) {
  const onAgentWork = vi.fn();
  const onRunDispatchAvailable = vi.fn();
  return {
    onAgentWork,
    onRunDispatchAvailable,
    registry: new RunnerRegistry({
      hooks: {
        authorize: async () => undefined,
        onEvent: async (_identity, event) => event.ordinal,
        onAgentWork,
        onRunDispatchAvailable,
      },
      now: clock,
    }),
  };
}

describe("RunnerRegistry agents-stopped state", () => {
  it("accepts the notice only from a capable Runner, and says so in its welcome", async () => {
    const { registry: runners } = registry(() => Date.now());
    const capable = new MemoryPeer("capable");
    const legacy = new MemoryPeer("legacy");
    const capableIdentity = makeIdentity(createId("runner"), 1);
    const legacyIdentity = makeIdentity(createId("runner"), 1, { capable: false });
    try {
      await runners.register(capableIdentity, capable);
      await runners.register(legacyIdentity, legacy);
      expect(capable.sent.find((message) => message.type === "host.welcome")).toMatchObject({
        acceptsAgentStop: true,
      });
      expect(legacy.sent.find((message) => message.type === "host.welcome")).not.toHaveProperty(
        "acceptsAgentStop",
      );
      await runners.handle(legacy, {
        ...legacyIdentity.fence,
        stoppedAt: new Date().toISOString(),
        type: "runner.agents.stopped",
      });
      expect(runners.agentsStoppedSince(legacyIdentity.runnerId)).toBeNull();
    } finally {
      await runners.close();
    }
  });

  it("holds work while stopped, wakes dispatch on resume, and keeps the Stop through a disconnect until reconnect", async () => {
    const clock = Date.parse("2026-11-20T10:45:00.000Z");
    const { onAgentWork, onRunDispatchAvailable, registry: runners } = registry(() => clock);
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const peer = new MemoryPeer("peer-1");
    const identity = makeIdentity(runnerId, 1, { environmentId });
    try {
      await runners.register(identity, peer);
      expect(runners.agentsStoppedSince(runnerId)).toBeNull();
      await runners.handle(peer, {
        ...identity.fence,
        stoppedAt: "2026-11-20T10:42:00.000Z",
        type: "runner.agents.stopped",
      });
      expect(runners.agentsStoppedSince(runnerId)?.toISOString()).toBe(
        "2026-11-20T10:42:00.000Z",
      );
      expect(runners.agentsStoppedSince(runnerId, 2)).toBeNull();
      expect(runners.areAgentsStopped(environmentId)).toBe(true);
      expect(onAgentWork).toHaveBeenLastCalledWith(
        expect.objectContaining({ runnerId }),
        new Date("2026-11-20T10:42:00.000Z"),
      );

      await runners.handle(peer, { ...identity.fence, type: "runner.agents.resumed" });
      expect(runners.agentsStoppedSince(runnerId)).toBeNull();
      expect(runners.areAgentsStopped(environmentId)).toBe(false);
      expect(onAgentWork).toHaveBeenLastCalledWith(expect.objectContaining({ runnerId }), null);
      expect(onRunDispatchAvailable).toHaveBeenCalled();

      // A Device Runner says it just before it is stopped: the Stop outlives the connection.
      await runners.handle(peer, {
        ...identity.fence,
        stoppedAt: "2026-11-20T10:44:00.000Z",
        type: "runner.agents.stopped",
      });
      runners.disconnect(peer);
      expect(runners.agentsStoppedSince(runnerId, 1)?.toISOString()).toBe(
        "2026-11-20T10:44:00.000Z",
      );
      expect(runners.agentsStoppedSince(runnerId, 2)).toBeNull();

      // Reconnecting forgets it: a Runner still stopped says so again.
      const peer2 = new MemoryPeer("peer-2");
      await runners.register(makeIdentity(runnerId, 2, { environmentId }), peer2);
      expect(runners.agentsStoppedSince(runnerId)).toBeNull();
    } finally {
      await runners.close();
    }
  });

  it("forgets a removed Runner's Stop", async () => {
    const { registry: runners } = registry(() => Date.now());
    const runnerId = createId("runner");
    const peer = new MemoryPeer("peer");
    const identity = makeIdentity(runnerId, 1);
    try {
      await runners.register(identity, peer);
      await runners.handle(peer, {
        ...identity.fence,
        stoppedAt: new Date().toISOString(),
        type: "runner.agents.stopped",
      });
      runners.disconnect(peer);
      expect(runners.agentsStoppedSince(runnerId)).not.toBeNull();
      await runners.revoke(runnerId);
      expect(runners.agentsStoppedSince(runnerId)).toBeNull();
    } finally {
      await runners.close();
    }
  });
});
