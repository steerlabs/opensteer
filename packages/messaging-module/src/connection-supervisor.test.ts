import {
  createChannelId,
  slackChannelProviderManifest,
  type ChannelAdapter,
  type ChannelConnectionInspection,
} from "@opensteer/channel-core";
import { describe, expect, it, vi } from "vitest";
import { RunnerAuxiliaryFrameFenceSchema } from "@opensteer/protocol";
import { ChannelAdapterRegistry } from "./adapter-registry.js";
import { ChannelConnectionSupervisor, reconnectDelayMs } from "./connection-supervisor.js";
import type { ChannelHostClient } from "./host-client.js";

describe("Channel connection supervisor", () => {
  it("aborts provider sessions on stream loss and recreates them only after a newer sync", async () => {
    const runs: AbortSignal[] = [];
    const adapter: ChannelAdapter = {
      connection: {
        inspect: vi.fn(async () => inspection),
        async run(input) {
          runs.push(input.signal);
          await input.onReady();
          await new Promise<void>((resolve) => {
            input.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
      manifest: slackChannelProviderManifest,
      outbound: { reconcile: vi.fn(), send: vi.fn() },
    };
    const supervisor = new ChannelConnectionSupervisor(
      host(),
      new ChannelAdapterRegistry([adapter]),
    );
    const request = syncRequest();
    await supervisor.opened(1);
    await supervisor.handle(request, context(1));
    await vi.waitFor(() => expect(runs).toHaveLength(1));

    await supervisor.disconnected(1);
    expect(runs[0]?.aborted).toBe(true);
    await supervisor.opened(2);
    expect(runs).toHaveLength(1);
    await expect(supervisor.handle(request, context(1))).rejects.toThrow(/superseded/);

    await supervisor.handle(request, context(2));
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    await supervisor.close();
  });
});

describe("reconnectDelayMs", () => {
  it("backs off exponentially up to half a minute", () => {
    expect(reconnectDelayMs(0, () => 0.5)).toBe(500);
    expect(reconnectDelayMs(1, () => 0.5)).toBe(1_000);
    expect(reconnectDelayMs(6, () => 0.5)).toBe(30_000);
    expect(reconnectDelayMs(20, () => 0.5)).toBe(30_000);
  });

  it("jitters by a fifth in each direction, so a provider outage does not stampede", () => {
    expect(reconnectDelayMs(1, () => 0)).toBe(800);
    expect(reconnectDelayMs(1, () => 1)).toBe(1_200);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const delay = reconnectDelayMs(attempt);
      const base = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
      expect(delay).toBeGreaterThanOrEqual(base * 0.8);
      expect(delay).toBeLessThanOrEqual(base * 1.2);
    }
  });
});

it("forgets earlier failures once a connection proves itself", async () => {
  const runs: number[] = [];
  const adapter: ChannelAdapter = {
    connection: {
      inspect: vi.fn(async () => inspection),
      async run(input) {
        runs.push(Date.now());
        // Two connections that never reach `hello`, then connections that do
        // and are then dropped. Each of those proved itself, so the wait after
        // it is the first step of the backoff and not the fourth.
        if (runs.length > 2) await input.onReady();
        throw new Error("Slack Socket Mode disconnected");
      },
    },
    manifest: slackChannelProviderManifest,
    outbound: { reconcile: vi.fn(), send: vi.fn() },
  };
  const supervisor = new ChannelConnectionSupervisor(host(), new ChannelAdapterRegistry([adapter]));
  await supervisor.opened(1);
  await supervisor.handle(syncRequest(), context(1));

  await vi.waitFor(() => expect(runs.length).toBeGreaterThanOrEqual(5), { timeout: 4_000 });
  await supervisor.close();
  // 500 + 1000 before readiness, then ~500 twice more; an un-reset backoff
  // would have spent 2000 + 4000 on those last two waits alone.
  expect(runs[4]! - runs[0]!).toBeLessThan(3_500);
});

/**
 * The fence every messaging-stream frame repeats. It names the Runner, its
 * boot, the primary connection this stream was granted beside, and the stream
 * itself, so a frame can never be replayed onto a later connection.
 */
const messagingFence = RunnerAuxiliaryFrameFenceSchema.parse({
  auxiliaryStreamId: "rax_11111111-1111-4111-8111-111111111111",
  bootId: "rbt_11111111-1111-4111-8111-111111111111",
  connectionGeneration: 1,
  connectionId: "rcn_11111111-1111-4111-8111-111111111111",
  connectionLeaseId: "rls_11111111-1111-4111-8111-111111111111",
  module: "messaging",
  runnerId: "rnr_11111111-1111-4111-8111-111111111111",
});

const inspection: ChannelConnectionInspection = {
  capabilities: ["messages.receive"],
  identity: {
    accountDisplayName: "Opensteer",
    connectionDisplayName: "Opensteer · Acme",
    externalAccountId: "T123",
    externalIdentityId: "U123",
    handle: "@opensteer",
    metadata: {},
  },
  issues: [],
  ready: true,
};

function host(): ChannelHostClient {
  return {
    claimDelivery: vi.fn(async () => null),
    commitIngress: vi.fn(async () => undefined),
    finishDelivery: vi.fn(async () => undefined),
    reportConnectionHealth: vi.fn(async () => undefined),
    resolveCredential: vi.fn(async () => ({
      accountId: createChannelId("account"),
      externalAccountId: "T123",
      purpose: "transport" as const,
      secrets: { token: "secret-value" },
    })),
    startDelivery: vi.fn(async () => undefined),
  };
}

function context(generation: number) {
  return { generation, signal: new AbortController().signal };
}

function syncRequest() {
  return {
    ...messagingFence,
    operation: "connections.sync" as const,
    payload: {
      connections: [
        {
          accountId: createChannelId("account"),
          connectionId: createChannelId("connection"),
          credentialGeneration: 1,
          externalAccountId: "T123",
          initialCursor: null,
          provider: "slack" as const,
          transportKind: "socket" as const,
        },
      ],
    },
    requestId: `crq_${"d".repeat(24)}`,
    type: "host.request" as const,
  };
}
