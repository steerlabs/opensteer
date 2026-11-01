import { generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { gate } from "@opensteer/shared/test-support/observation";
import { withTimeout } from "@opensteer/shared/withTimeout";
import {
  LocalProfileBindingSchema,
  RunnerAuxiliaryFrameFenceSchema,
  type HeldLocalProfile,
} from "@opensteer/protocol";
import {
  BrowserCapabilityLeaseSchema,
  BrowserChannelIdSchema,
  createBrowserRelayToHostMessageSchema,
} from "@opensteer/protocol/browser-relay";
import { LocalBrowserRuntimeBridge } from "./browser-bridge.js";
import { BrowserModuleRelay } from "./browser-relay.js";
import type { RunnerModuleStream } from "./module-connection.js";

const storage = { storageInstanceId: randomUUID(), engine: "chromium" as const };
const binding = LocalProfileBindingSchema.parse({
  version: 1,
  engine: storage.engine,
  storageInstanceId: storage.storageInstanceId,
  bindingId: randomUUID(),
  deploymentId: `dep_${randomUUID()}`,
  runnerId: `rnr_${randomUUID()}`,
  profileId: `bpr_${randomUUID()}`,
});
function fixture(negotiated = true) {
  const bridge = new LocalBrowserRuntimeBridge({
    bridgeToken: "x".repeat(64),
    runtimeId: "runtime_test",
    url: new URL("http://127.0.0.1:4312"),
  });
  const relay = new BrowserModuleRelay(bridge);
  const messages: Record<string, unknown>[] = [];
  const notices = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const fence = RunnerAuxiliaryFrameFenceSchema.parse({
    auxiliaryStreamId: `rax_${randomUUID()}`,
    bootId: `rbt_${randomUUID()}`,
    connectionId: `rcn_${randomUUID()}`,
    connectionGeneration: 1,
    connectionLeaseId: `rls_${randomUUID()}`,
    module: "browser",
    runnerId: binding.runnerId,
  });
  const keys = generateKeyPairSync("ed25519");
  const stream: RunnerModuleStream = {
    ...(negotiated ? { localProfiles: 1, initialNavigationVersion: 1 } : {}),
    fence,
    browserAttachPublicKeys: [
      {
        keyId: "test",
        publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      },
    ],
    send: async (frame) => {
      const message = createBrowserRelayToHostMessageSchema(stream).parse(
        JSON.parse(String(frame)),
      );
      messages.push(message);
      notices.get(message.type)?.resolve();
    },
  };
  const inventory = vi
    .spyOn(bridge, "localProfileInventory")
    .mockResolvedValue({ storage, profiles: [] });
  const lease = BrowserCapabilityLeaseSchema.parse({
    capabilityGeneration: 1,
    capabilityLeaseId: `bcl_${randomUUID()}`,
    runtimeId: "runtime_test",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const capability = {
    capabilityGeneration: lease.capabilityGeneration,
    capabilityLeaseId: lease.capabilityLeaseId,
    runtimeId: lease.runtimeId,
  };
  const send = (message: object) =>
    relay.handleFrame(
      Buffer.from(JSON.stringify({ ...fence, requestId: "test-request", ...message })),
      false,
    );
  const wait = (type: string) => {
    const pending = Promise.withResolvers<void>();
    notices.set(type, pending);
    return withTimeout(pending.promise, 2000, {
      timeoutError: () => new Error(`${type} never arrived`),
    });
  };
  return { bridge, relay, stream, inventory, messages, lease, capability, send, wait };
}

describe("BrowserModuleRelay native profiles", () => {
  it("sends every inventory claim in bounded batches before execution admission", async () => {
    const f = fixture();
    const profiles: HeldLocalProfile[] = Array.from({ length: 257 }, () => ({
      phase: "ready",
      binding: {
        ...binding,
        profileId: LocalProfileBindingSchema.shape.profileId.parse(`bpr_${randomUUID()}`),
      },
      seed: { revision: 0, digest: "a".repeat(64) },
    }));
    f.inventory.mockResolvedValue({ storage, profiles });
    try {
      await f.relay.attach(f.stream);
      expect(f.messages.map((m) => [(m.profiles as unknown[])?.length, m.complete])).toEqual([
        [128, false],
        [128, false],
        [1, true],
      ]);
      expect(f.messages.flatMap((m) => m.profiles)).toEqual(profiles);
    } finally {
      f.relay.detach();
    }
  });
  it("never marks an interrupted multi-batch inventory complete", async () => {
    const f = fixture();
    const claim: HeldLocalProfile = {
      phase: "ready",
      binding,
      seed: { revision: 0, digest: "a".repeat(64) },
    };
    f.inventory.mockResolvedValue({ storage, profiles: Array.from({ length: 129 }, () => claim) });
    let batches = 0;
    const stream: RunnerModuleStream = {
      ...f.stream,
      send: async (frame, binary) => {
        if (++batches === 2) throw new Error("inventory transport interrupted");
        await f.stream.send(frame, binary);
      },
    };
    try {
      await expect(f.relay.attach(stream)).rejects.toThrow(/interrupted/);
      expect(f.messages).toHaveLength(1);
      expect(f.messages[0]).toMatchObject({ complete: false });
    } finally {
      f.relay.detach();
    }
  });

  it("does not claim an unreadable inventory is complete and refuses execution", async () => {
    const f = fixture();
    f.inventory.mockRejectedValue(new Error("unreadable marker"));
    try {
      await expect(f.relay.attach(f.stream)).rejects.toThrow("unreadable");
      expect(f.messages).toHaveLength(0);
      await f.send({ type: "capability.grant", lease: f.lease });
      const failed = f.wait("browser.command-error");
      await f.send({
        type: "browser.attach",
        capability: f.capability,
        channelId: `bch_${randomUUID()}`,
        attachTicket: "abc.def.ghi",
      });
      await failed;
      expect(f.messages.at(-1)).toMatchObject({
        error: { message: expect.stringContaining("inventory") },
      });
    } finally {
      f.relay.detach();
    }
  });
  it("emits no new frames to a previous Host", async () => {
    const f = fixture(false);
    try {
      await f.relay.attach(f.stream);
      expect(f.inventory).not.toHaveBeenCalled();
      expect(f.messages).toHaveLength(0);
    } finally {
      f.relay.detach();
    }
  });
  it("does not serialize unrelated attaches behind an engine start and forwards readiness", async () => {
    const f = fixture();
    const held = gate({ label: "first browser attachment", deadlineMs: 2000 });
    const firstId = BrowserChannelIdSchema.parse(`bch_${randomUUID()}`);
    const secondId = BrowserChannelIdSchema.parse(`bch_${randomUUID()}`);
    vi.spyOn(f.bridge, "attach").mockImplementation(async (channelId) => {
      if (channelId === firstId) await held.enter();
      return {
        type: "browser.attached",
        initialPage: {
          operationKey: channelId,
          surfaceId: `bsf_${randomUUID()}` as import("@opensteer/protocol").BrowserSurfaceId,
          navigation: "submitted",
        },
      };
    });
    try {
      await f.relay.attach(f.stream);
      await f.send({ type: "capability.grant", lease: f.lease });
      await f.send({
        type: "browser.attach",
        capability: f.capability,
        channelId: firstId,
        attachTicket: "abc.def.ghi",
      });
      await held.entered;
      const ready = f.wait("browser.attached");
      await f.send({
        type: "browser.attach",
        capability: f.capability,
        channelId: secondId,
        attachTicket: "abc.def.ghi",
      });
      await ready;
      expect(f.messages.at(-1)).toMatchObject({
        channelId: secondId,
        initialPage: { operationKey: secondId },
      });
    } finally {
      held.release();
      f.relay.detach();
    }
  });
  it.each(["attach", "delete"] as const)(
    "keeps an admitted %s correlated across capability renewal",
    async (operation) => {
      const f = fixture();
      const held = gate({ label: "admitted operation", deadlineMs: 2000 });
      const channelId = BrowserChannelIdSchema.parse(`bch_${randomUUID()}`);
      vi.spyOn(f.bridge, "attach").mockImplementation(async () => {
        await held.enter();
        return { type: "browser.attached", retained: true };
      });
      vi.spyOn(f.bridge, "deleteLocalProfile").mockImplementation(async () => {
        await held.enter();
        return "deleted";
      });
      try {
        await f.relay.attach(f.stream);
        await f.send({ type: "capability.grant", lease: f.lease });
        await f.send(
          operation === "attach"
            ? {
                type: "browser.attach",
                channelId,
                capability: f.capability,
                attachTicket: "abc.def.ghi",
              }
            : {
                type: "browser.profile.delete",
                capability: f.capability,
                binding,
                deletionId: randomUUID(),
              },
        );
        await held.entered;
        await f.send({
          type: "capability.grant",
          lease: { ...f.lease, capabilityGeneration: 2, capabilityLeaseId: `bcl_${randomUUID()}` },
        });
        const done = f.wait(
          operation === "attach" ? "browser.attached" : "browser.profile.delete.result",
        );
        held.release();
        await done;
        expect(f.messages.at(-1)).toMatchObject({
          capability: f.capability,
          requestId: "test-request",
        });
        expect(f.messages.some((message) => message.type === "browser.command-error")).toBe(false);
      } finally {
        held.release();
        f.relay.detach();
      }
    },
  );
  it("closes the exact attachment when revoked during readiness", async () => {
    const f = fixture();
    const held = gate({ label: "revoked attach", deadlineMs: 2000 });
    const channelId = BrowserChannelIdSchema.parse(`bch_${randomUUID()}`);
    const close = vi.spyOn(f.bridge, "close");
    vi.spyOn(f.bridge, "attach").mockImplementation(async () => {
      await held.enter();
      return { type: "browser.attached", retained: true };
    });
    try {
      await f.relay.attach(f.stream);
      await f.send({ type: "capability.grant", lease: f.lease });
      await f.send({
        type: "browser.attach",
        channelId,
        capability: f.capability,
        attachTicket: "abc.def.ghi",
      });
      await held.entered;
      await f.send({ type: "capability.revoke", capability: f.capability });
      close.mockClear();
      const done = f.wait("browser.command-error");
      held.release();
      await done;
      expect(close).toHaveBeenCalledWith(channelId, 4003, expect.any(String));
      expect(f.messages.some((message) => message.type === "browser.attached")).toBe(false);
    } finally {
      held.release();
      f.relay.detach();
    }
  });
  it("routes deletion without a live channel", async () => {
    const f = fixture();
    const deletionId = randomUUID();
    const remove = vi.spyOn(f.bridge, "deleteLocalProfile").mockResolvedValue("pending-restart");
    try {
      await f.relay.attach(f.stream);
      await f.send({ type: "capability.grant", lease: f.lease });
      const done = f.wait("browser.profile.delete.result");
      await f.send({
        type: "browser.profile.delete",
        capability: f.capability,
        binding,
        deletionId,
      });
      await done;
      expect(remove).toHaveBeenCalledWith(binding, deletionId);
      expect(f.messages.at(-1)).toMatchObject({ binding, deletionId, state: "pending-restart" });
    } finally {
      f.relay.detach();
    }
  });
});
