import { describe, expect, it, vi } from "vitest";
import {
  ChannelDeliveryError,
  createChannelId,
  slackChannelProviderManifest,
  type ChannelAdapter,
} from "@opensteer/channel-core";
import type { ClaimedChannelDelivery } from "@opensteer/channel-protocol";
import { ChannelAdapterRegistry } from "./adapter-registry.js";
import type { ChannelHostClient } from "./host-client.js";
import { ChannelDeliveryWorker } from "./delivery-worker.js";

describe("ChannelDeliveryWorker", () => {
  it("claims work only while a fenced messaging stream is authoritative", async () => {
    const claimDelivery = vi.fn(async () => null);
    const worker = new ChannelDeliveryWorker(host({ claimDelivery }), registry(adapter()));
    worker.start();
    worker.wake();
    expect(claimDelivery).not.toHaveBeenCalled();

    worker.resume();
    await vi.waitFor(() => expect(claimDelivery).toHaveBeenCalledOnce());
    await worker.pause();
    worker.wake();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(claimDelivery).toHaveBeenCalledOnce();
    await worker.close();
  });

  it("sends when reconciliation cannot find the message", async () => {
    const outbound = adapter({ reconcile: vi.fn(async () => ({ kind: "unknown" as const })) });
    const client = host({ claim: claimed({ mayHaveBeenSent: true }) });

    await run(client, outbound);

    expect(outbound.outbound.reconcile).toHaveBeenCalledOnce();
    expect(outbound.outbound.send).toHaveBeenCalledOnce();
    expect(client.finishDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "sent", receipt: { ts: "2.2" } }),
    );
  });

  it("clamps a provider's retry delay to what the wire accepts", async () => {
    const outbound = adapter({
      send: vi.fn(async () => {
        throw new ChannelDeliveryError("slow down", "retryable", { retryAfterSeconds: 1_000_000 });
      }),
    });
    const client = host({ claim: claimed() });

    await run(client, outbound);

    expect(client.finishDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "retryable-failed", retryAfterSeconds: 86_400 }),
    );
  });

  it("separates a refusal from a lost answer", async () => {
    const dead = adapter({
      send: vi.fn(async () => {
        throw new ChannelDeliveryError("the bot is not in that channel", "dead");
      }),
    });
    const deadClient = host({ claim: claimed() });
    await run(deadClient, dead);
    expect(deadClient.finishDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "dead" }),
    );

    const lost = adapter({
      send: vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    });
    const lostClient = host({ claim: claimed() });
    await run(lostClient, lost);
    expect(lostClient.finishDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unknown" }),
    );
  });

  it("kills a delivery no installed adapter can carry", async () => {
    const client = host({ claim: claimed({ provider: "unknown-provider" }) });
    await run(client, adapter());
    expect(client.finishDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "dead", error: expect.stringContaining("adapter") }),
    );
  });
});

async function run(client: ChannelHostClient, installed: ChannelAdapter): Promise<void> {
  const worker = new ChannelDeliveryWorker(client, registry(installed));
  worker.resume();
  worker.wake();
  await vi.waitFor(() => expect(client.finishDelivery).toHaveBeenCalled());
  await worker.close();
}

function registry(installed: ChannelAdapter): ChannelAdapterRegistry {
  return new ChannelAdapterRegistry([installed]);
}

function adapter(outbound: Partial<ChannelAdapter["outbound"]> = {}): ChannelAdapter {
  return {
    connection: { inspect: vi.fn(), run: vi.fn() },
    manifest: slackChannelProviderManifest,
    outbound: {
      reconcile: vi.fn(async () => ({ kind: "unknown" as const })),
      send: vi.fn(async () => ({ receipt: { ts: "2.2" } })),
      ...outbound,
    },
  };
}

function claimed(overrides: Partial<ClaimedChannelDelivery> = {}): ClaimedChannelDelivery {
  return {
    claimToken: "t".repeat(40),
    delivery: {
      accountId: createChannelId("account"),
      attempts: 1,
      audience: "conversation",
      content: [{ text: "hello", type: "text" }],
      conversationId: createChannelId("conversation"),
      createdAt: "2026-08-10T00:00:00.000Z",
      id: createChannelId("delivery"),
      kind: "reply",
      lastError: null,
      messageId: null,
      receipt: null,
      status: "leased",
      updatedAt: "2026-08-10T00:00:00.000Z",
    },
    destination: {
      externalConversationId: "C1",
      externalScopeId: "T1",
      externalThreadId: "1786320000.000100",
      externalUserId: null,
    },
    lease: {
      accountId: createChannelId("account"),
      externalAccountId: "T1",
      purpose: "delivery",
      secrets: { botToken: "xoxb-test" },
    },
    mayHaveBeenSent: false,
    provider: "slack",
    ...overrides,
  };
}

function host(
  options: {
    readonly claim?: ClaimedChannelDelivery;
    readonly claimDelivery?: ChannelHostClient["claimDelivery"];
  } = {},
): ChannelHostClient {
  const remaining = options.claim ? [options.claim] : [];
  return {
    claimDelivery: options.claimDelivery ?? vi.fn(async () => remaining.shift() ?? null),
    commitIngress: vi.fn(async () => undefined),
    finishDelivery: vi.fn(async () => undefined),
    reportConnectionHealth: vi.fn(async () => undefined),
    resolveCredential: vi.fn(),
    startDelivery: vi.fn(async () => undefined),
  };
}
