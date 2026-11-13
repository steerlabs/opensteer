import { KeyedStreamReceiver } from "@opensteer/protocol/keyed-stream";
import type { BrowserTabRecord, BrowserTabStreamMeta } from "@opensteer/protocol/browser-tabs";
import { afterEach } from "vitest";
import {
  BrowserAttachTicketClaimsSchema,
  BrowserClientMessageSchema,
  LocalProfileBindingSchema,
} from "@opensteer/protocol/browser";
import {
  BrowserChannelIdSchema,
  BrowserCapabilityLeaseSchema,
  HostToBrowserRelayMessageSchema,
} from "@opensteer/protocol/browser-relay";
import {
  RunnerAuxiliaryFrameFenceSchema,
  RunnerAuxiliaryRequestIdSchema,
} from "@opensteer/protocol/runner-auxiliary";
import fences from "../../../../packages/browser-core/test-vectors/fences.v1.json";
import { FakeClock, FakePhoneBrowserNative } from "./fake-native.test-support.js";
import { PhoneBrowserManager } from "./manager.js";
import type { NativeDocumentRef, PhoneRelayCommand } from "./native-port.js";

let nextId = 1;
export const uuid = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
const managers: PhoneBrowserManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
});

export async function setup(
  platform: "ios" | "android" = "ios",
  initialClaims: Record<string, unknown> = {},
) {
  const clock = new FakeClock();
  const native = new FakePhoneBrowserNative(platform, clock.now);
  const fence = RunnerAuxiliaryFrameFenceSchema.parse(fences.fence);
  const deploymentId = `dep_${uuid()}`;
  const manager = new PhoneBrowserManager({
    native,
    clock,
    uuid,
    deploymentId,
    runnerId: fence.runnerId,
  });
  managers.push(manager);
  await manager.initialize();
  await manager.setForeground(true);
  await native.emit({
    type: "connection",
    state: "online",
    fence,
    leaseDeadline: clock.now() + 60_000,
  });
  let lease = BrowserCapabilityLeaseSchema.parse({
    runtimeId: "phone-runtime",
    capabilityGeneration: 1,
    capabilityLeaseId: `bcl_${uuid()}`,
    expiresAt: new Date(clock.now() + 60_000).toISOString(),
  });
  const capability = () => ({
    runtimeId: lease.runtimeId,
    capabilityGeneration: lease.capabilityGeneration,
    capabilityLeaseId: lease.capabilityLeaseId,
  });
  const relay = async (message: unknown, authorityHandle?: string) => {
    const parsed = HostToBrowserRelayMessageSchema.parse(message);
    await native.emit({
      type: "relayCommand",
      message: parsed as PhoneRelayCommand,
      ...(authorityHandle ? { authorityHandle } : {}),
    });
  };
  await relay({ ...fence, requestId: uuid(), type: "capability.grant", lease });
  const binding = LocalProfileBindingSchema.parse({
    version: 1,
    deploymentId,
    runnerId: fence.runnerId,
    storageInstanceId: native.qualification.storageInstanceId,
    profileId: `bpr_${uuid()}`,
    bindingId: uuid(),
    engine: platform === "ios" ? "wkwebview" : "android-webview",
  });
  const sessionId = `bsn_${uuid()}`;
  const surfaceId = "host-surface-1";
  let channelId = BrowserChannelIdSchema.parse(`bch_${uuid()}`);
  const makeClaims = (patch: Record<string, unknown> = {}) =>
    BrowserAttachTicketClaimsSchema.parse({
      access: "read-write",
      audience: "opensteer-browser-runtime",
      creationOrigin: "person",
      wireVersion: 2,
      issuedAt: new Date(clock.now()).toISOString(),
      expiresAt: new Date(clock.now() + 30_000).toISOString(),
      operationExpiresAt: new Date(clock.now() + 20_000).toISOString(),
      remainingBudgetMs: 20_000,
      nonce: `nonce-${uuid()}`,
      identity: {
        kind: "profile-local",
        binding,
        initialized: false,
        readyUrl: "https://example.com",
      },
      runtimeId: "phone-runtime",
      sessionId,
      subject: "host-person",
      initialSurfaceId: surfaceId,
      basicInput: 1,
      surfaceState: 1,
      tabRestoreVersion: 1,
      navigationAttributionVersion: 1,
      popupFollowVersion: 1,
      ...initialClaims,
      ...patch,
    });
  const attach = async (patch: Record<string, unknown> = {}, handle = `handle-${uuid()}`) => {
    channelId = BrowserChannelIdSchema.parse(`bch_${uuid()}`);
    native.tickets.set(handle, makeClaims(patch));
    await native.emit({
      type: "relayCommand",
      message: {
        ...fence,
        requestId: RunnerAuxiliaryRequestIdSchema.parse(uuid()),
        type: "browser.attach",
        capability: capability(),
        channelId,
        attachHandle: handle,
      },
    });
    return handle;
  };
  await attach();
  const client = async (message: unknown, targetChannelId = channelId) =>
    relay({
      ...fence,
      type: "browser.client-message",
      capability: capability(),
      channelId: targetChannelId,
      message: BrowserClientMessageSchema.parse(message),
    });
  const server = () =>
    native.output.flatMap((entry) =>
      entry.type === "browser.server-message" ? [entry.message] : [],
    );
  const presentation = (id = surfaceId) => manager.getTabPresentation(id)!;
  const present = (id = surfaceId) =>
    manager.presentTab(
      {
        sessionId,
        surfaceId: id,
        runtimeId: "phone-runtime",
        bindingId: binding.bindingId,
        targetControl: 1,
      },
      "native-host-1",
    );
  const reference = (id = surfaceId): NativeDocumentRef => ({
    epoch: native.epoch,
    sessionId,
    tabId: id,
    generation: presentation(id).nativeGeneration,
    documentId: presentation(id).documentId,
    geometryRevision: presentation(id).geometryRevision,
  });
  const open = async (id: string, key = uuid()) => {
    const handle = `operation-${uuid()}`;
    native.tickets.set(
      handle,
      makeClaims({
        identity: { kind: "fresh" },
        initialNavigation: { operationKey: key, url: "https://example.com/new" },
      }),
    );
    await relay(
      {
        ...fence,
        type: "browser.client-message",
        capability: capability(),
        channelId,
        message: {
          type: "cdp.command",
          requestId: uuid(),
          command: {
            method: "Opensteer.openTab",
            parameters: { surfaceId: id, idempotencyKey: key, url: "https://example.com/new" },
          },
        },
      },
      handle,
    );
  };
  const revision = () => {
    const receiver = new KeyedStreamReceiver<BrowserTabRecord, BrowserTabStreamMeta>();
    for (const entry of server()) if (entry.type === "browser.tabs") receiver.apply(entry.stream);
    return receiver.meta?.inventoryRevision;
  };
  const attachmentId = uuid();
  const actorToken = uuid();
  const agentAttach = (id = attachmentId, token = actorToken) =>
    client({
      type: "agent.attach",
      sessionId,
      attachmentId: id,
      actorToken: token,
      backend: "actions",
    });
  const sessionAction = (actionValue: unknown, patch: Record<string, unknown> = {}) =>
    client({
      type: "agent.action",
      attachmentId,
      actorToken,
      requestId: uuid(),
      request: { id: nextId++, sessionId, action: actionValue, ...patch },
    });
  const action = (
    actionValue: unknown,
    id = surfaceId,
    patch: Record<string, unknown> = {},
    agent = { attachmentId, actorToken },
  ) => {
    const state = presentation(id);
    return client({
      type: "agent.action",
      ...agent,
      requestId: uuid(),
      request: {
        id: nextId++,
        sessionId,
        surfaceId: id,
        documentId: state.documentId,
        geometryRevision: state.geometryRevision,
        action: actionValue,
        ...patch,
      },
    });
  };
  return {
    deploymentId,
    native,
    clock,
    manager,
    fence,
    binding,
    sessionId,
    surfaceId,
    client,
    channelId: () => channelId,
    server,
    reference,
    presentation,
    present,
    open,
    revision,
    agentAttach,
    sessionAction,
    action,
    actorToken,
    attachmentId,
    attach,
    relay,
    renew: async () => {
      lease = {
        ...lease,
        capabilityGeneration: lease.capabilityGeneration + 1,
        capabilityLeaseId: BrowserCapabilityLeaseSchema.parse({
          ...lease,
          capabilityLeaseId: `bcl_${uuid()}`,
        }).capabilityLeaseId,
      };
      await relay({ ...fence, type: "capability.grant", requestId: uuid(), lease });
    },
    reconnect: async (patch: Record<string, unknown> = {}) => {
      await native.emit({
        type: "connection",
        state: "offline",
        reason: "network-lost",
        fence: { ...fence },
      });
      fence.connectionGeneration++;
      await native.emit({
        type: "connection",
        state: "online",
        fence,
        leaseDeadline: clock.now() + 60_000,
      });
      lease = {
        ...lease,
        capabilityGeneration: lease.capabilityGeneration + 1,
        capabilityLeaseId: BrowserCapabilityLeaseSchema.parse({
          ...lease,
          capabilityLeaseId: `bcl_${uuid()}`,
        }).capabilityLeaseId,
      };
      await relay({ ...fence, requestId: uuid(), type: "capability.grant", lease });
      channelId = BrowserChannelIdSchema.parse(`bch_${uuid()}`);
      await attach(patch);
    },
    currentEnvelope: () => ({ ...fence, capability: capability(), channelId }),
  };
}
