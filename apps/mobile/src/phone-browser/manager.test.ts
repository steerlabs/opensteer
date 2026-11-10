import { afterEach, describe, expect, test } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import {
  BrowserAttachTicketClaimsSchema,
  BrowserClientMessageSchema,
  BrowserDialogSchema,
  BrowserServerMessageSchema,
  LocalProfileBindingSchema,
  type BrowserClientMessage,
} from "@opensteer/protocol/browser";
import {
  BrowserChannelIdSchema,
  BrowserCapabilityLeaseSchema,
  HostToBrowserRelayMessageSchema,
  BrowserRelayToHostMessageSchema,
} from "@opensteer/protocol/browser-relay";
import {
  RunnerAuxiliaryFrameFenceSchema,
  RunnerAuxiliaryRequestIdSchema,
  sameRunnerAuxiliaryFence,
} from "@opensteer/protocol/runner-auxiliary";
import { RunnerBrowserModuleSchema, RunnerDescriptorSchema } from "@opensteer/protocol";
import {
  transitionReplayLedger,
  type ReplayLedgerState,
} from "@opensteer/browser-core/attach-ticket-policy";
import fences from "../../../../packages/browser-core/test-vectors/fences.v1.json";
import { FakeClock, FakePhoneBrowserNative } from "./fake-native.test-support.js";
import { PhoneBrowserManager } from "./manager.js";
import {
  PhoneBrowserError,
  type NativeDocumentRef,
  type PhoneRelayCommand,
} from "./native-port.js";
import { phoneBrowserDescriptor, phoneBrowserRunnerDescriptor } from "./descriptor.js";

let nextId = 1;
const uuid = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
const managers: PhoneBrowserManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
});

async function setup(
  platform: "ios" | "android" = "ios",
  initialClaims: Record<string, unknown> = {},
) {
  const native = new FakePhoneBrowserNative(platform);
  const clock = new FakeClock();
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
      wireVersion: 1,
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
      workspaceTabRestoreVersion: 1,
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
    await client({
      type: "cdp.command",
      requestId: uuid(),
      command: {
        method: "Opensteer.openTab",
        parameters: { surfaceId: id, idempotencyKey: key, url: "https://example.com/new" },
      },
    });
  };
  const revision = () => {
    const message = server().findLast((entry) => entry.type === "browser.surfaces.changed");
    return message?.type === "browser.surfaces.changed" ? message.inventoryRevision : undefined;
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

describe("phone browser manager", () => {
  test("a new Host session adopts the retained surface after foreground return without reloading", async () => {
    const fixture = await setup();
    await fixture.present();
    const original = fixture.native.tabs.get(fixture.surfaceId)!;
    original.form = "verification code";
    await fixture.open("discarded");
    await fixture.native.emit({
      type: "memoryPressure",
      epoch: fixture.reference().epoch,
      level: "critical",
    });
    const discarded = fixture.native.tabs.get("discarded")!;
    discarded.metadata = { ...discarded.metadata, documentId: "" };
    await fixture.native.emit({
      type: "documentChanged",
      ...fixture.reference("discarded"),
      metadata: discarded.metadata,
    });
    await fixture.open("dormant");
    fixture.native.tabs.get("dormant")!.form = "second form";
    const generation = original.metadata.generation;
    await fixture.manager.setForeground(false);
    await fixture.manager.setForeground(true);
    const sessionId = `bsn_${uuid()}`;
    await fixture.reconnect({ sessionId, dormantSurfaceIds: ["dormant", "discarded"] });
    expect(fixture.presentation("discarded").state).toBe("discarded");
    expect(fixture.native.tabs.get("discarded")!.loads).toBe(1);
    expect(fixture.native.tabs.get(fixture.surfaceId)).toMatchObject({
      sessionId,
      form: "verification code",
      loads: 1,
    });
    expect(fixture.native.tabs.get(fixture.surfaceId)!.metadata.generation).toBeGreaterThan(
      generation,
    );
    expect(
      fixture.manager.localPresentation(fixture.deploymentId, fixture.surfaceId)?.sessionId,
    ).toBe(sessionId);
    expect(fixture.manager.localPresentation(fixture.deploymentId, "dormant")?.sessionId).toBe(
      sessionId,
    );
    expect(fixture.native.tabs.get("dormant")).toMatchObject({
      sessionId,
      form: "second form",
      loads: 1,
    });
    expect(fixture.server()).toContainEqual(
      expect.objectContaining({
        type: "browser.snapshot",
        sessionId,
        surfaces: expect.arrayContaining([expect.objectContaining({ id: fixture.surfaceId })]),
      }),
    );
  });
  test("sends a completed profile inventory once per native connection, not after each attachment", async () => {
    const fixture = await setup();
    await fixture.attach();
    const inventories = () =>
      fixture.native.calls.filter(
        ({ method, input }) =>
          method === "sendRelay" &&
          (input as { message: { type: string } }).message.type === "browser.profile.inventory",
      );
    expect(inventories()).toHaveLength(1);
    await fixture.reconnect();
    await fixture.attach();
    expect(inventories()).toHaveLength(2);
  });
  test("an old host unmount cannot retain a tab moved to a second host", async () => {
    const fixture = await setup();
    await fixture.present();
    await fixture.manager.presentTab(
      {
        sessionId: fixture.sessionId,
        surfaceId: fixture.surfaceId,
        runtimeId: "phone-runtime",
        bindingId: fixture.binding.bindingId,
        targetControl: 1,
      },
      "native-host-2",
    );
    await fixture.manager.hideTab(fixture.surfaceId, "native-host-1");
    expect(fixture.presentation().state).toBe("live-visible");
    expect(fixture.native.tabs.get(fixture.surfaceId)?.loads).toBe(1);
    await fixture.manager.hideTab(fixture.surfaceId, "native-host-2");
    expect(fixture.presentation().state).toBe("retained");
  });

  test("a native dialog interruption includes its answer-once dialog in the typed error", async () => {
    const fixture = await setup();
    await fixture.present();
    await fixture.agentAttach();
    const dialog = BrowserDialogSchema.parse({
      id: uuid(),
      surfaceId: fixture.surfaceId,
      type: "confirm",
      message: "Continue?",
    });
    fixture.native.actionGate = async () => {
      await fixture.native.emit({ ...fixture.reference(), type: "dialog", dialog });
      throw new PhoneBrowserError("dialog-open", "The page opened a dialog.");
    };
    await fixture.action({
      type: "dom.act",
      kind: "click",
      locator: { by: "role", value: "button", name: "Go" },
    });
    expect(fixture.server().at(-1)).toMatchObject({
      type: "agent.error",
      error: { code: "dialog-open", dialog },
    });
    fixture.native.actionGate = null;
    await fixture.action({ type: "dialog.respond", dialogId: dialog.id, accept: false });
    expect(fixture.native.dialogsAnswered).toEqual([dialog.id]);
  });

  test("a dialog interruption waits for its separately delivered native event without replay", async () => {
    const fixture = await setup();
    await fixture.present();
    await fixture.agentAttach();
    const dialog = BrowserDialogSchema.parse({
      id: uuid(),
      surfaceId: fixture.surfaceId,
      type: "confirm",
      message: "Continue?",
    });
    const entered = Promise.withResolvers<void>();
    fixture.native.actionGate = async () => {
      entered.resolve();
      throw new PhoneBrowserError("dialog-open", "A dialog interrupted this action.");
    };
    const action = fixture.action({
      type: "dom.act",
      kind: "click",
      locator: { by: "css", value: "button" },
    });
    await entered.promise;
    await fixture.native.emit({ ...fixture.reference(), type: "dialog", dialog });
    await action;
    expect(fixture.server().at(-1)).toMatchObject({
      type: "agent.error",
      error: { code: "dialog-open", dialog },
    });
    expect(fixture.native.calls.filter(({ method }) => method === "performAction")).toHaveLength(1);
  });

  test("session actions need no surface or document, including opening the first tab after an empty inventory", async () => {
    const fixture = await setup();
    await fixture.agentAttach();
    await fixture.action({ type: "surface.close" });
    expect(fixture.presentation().state).toBe("closed");
    expect(fixture.manager.localPresentation(fixture.deploymentId, fixture.surfaceId)).toBeNull();
    expect(fixture.native.tabs.size).toBe(0);
    await fixture.sessionAction({ type: "session.tabs" });
    expect(fixture.server().at(-1)).toMatchObject({
      type: "agent.result",
      result: { type: "session.tabs", tabs: [] },
    });
    await fixture.sessionAction({ type: "surface.open", url: "https://first.example/" });
    const opened = fixture.server().at(-1);
    expect(opened).toMatchObject({
      type: "agent.result",
      result: {
        type: "surface.open",
        binding: { state: "live", url: "https://first.example/" },
      },
    });
    if (opened?.type !== "agent.result" || opened.result.type !== "surface.open")
      throw new Error("The session did not return its newly opened tab.");
    expect(fixture.native.tabs.has(opened.result.binding.surfaceId)).toBe(true);
    const legacy = {
      surfaceId: "unrelated-surface",
      documentId: "old-document",
      geometryRevision: 999,
    };
    await fixture.sessionAction({ type: "session.tabs" }, legacy);
    expect(fixture.server().at(-1)).toMatchObject({
      type: "agent.result",
      result: { type: "session.tabs", tabs: [opened.result.binding] },
    });
    await fixture.sessionAction({ type: "surface.open" }, legacy);
    expect(fixture.server().at(-1)).toMatchObject({
      type: "agent.result",
      result: { type: "surface.open", binding: { url: "about:blank" } },
    });
    expect(fixture.native.tabs.size).toBe(2);
  });

  test.each(["retained", "discarded"] as const)(
    "closing a %s tab checks its document and geometry without resuming or allocating a view",
    async (state) => {
      const fixture = await setup();
      await fixture.agentAttach();
      if (state === "discarded")
        await fixture.native.emit({
          type: "memoryPressure",
          epoch: fixture.native.epoch,
          level: "warning",
        });
      expect(fixture.presentation().state).toBe(state);
      const before = fixture.native.calls.length;
      for (const action of [
        { type: "page.info" },
        { type: "surface.attach" },
        { type: "dom.act", kind: "focus", locator: { by: "css", value: "input" } },
      ]) {
        await fixture.action(action);
        expect(fixture.server().at(-1)).toMatchObject({
          type: "agent.error",
          error: { code: "target-suspended" },
        });
      }
      await fixture.action({ type: "surface.close" }, fixture.surfaceId, {
        documentId: "old-document",
      });
      expect(fixture.server().at(-1)).toMatchObject({
        type: "agent.error",
        error: { code: "stale-document" },
      });
      await fixture.action({ type: "surface.close" }, fixture.surfaceId, { geometryRevision: 999 });
      expect(fixture.server().at(-1)).toMatchObject({
        type: "agent.error",
        error: { code: "stale-geometry" },
      });
      expect(fixture.native.tabs.has(fixture.surfaceId)).toBe(true);
      await fixture.action({ type: "surface.close" });
      expect(fixture.server().findLast((message) => message.type === "agent.result")).toMatchObject(
        {
          result: { type: "surface.close", outcome: "closed" },
        },
      );
      expect(fixture.presentation().state).toBe("closed");
      expect(fixture.native.tabs.has(fixture.surfaceId)).toBe(false);
      expect(
        fixture.native.calls
          .slice(before)
          .filter((call) =>
            ["resumeTab", "createTab", "mountTab", "performAction"].includes(call.method),
          ),
      ).toEqual([]);
    },
  );

  test("focus and focus-to-end reach the native primitive unchanged and report script-made results", async () => {
    const fixture = await setup();
    await fixture.present();
    await fixture.agentAttach();
    for (const action of [
      { type: "dom.act", kind: "focus", locator: { by: "label", value: "Search" } },
      {
        type: "dom.act",
        kind: "focus",
        selection: "end",
        locator: { by: "css", value: "#message" },
      },
    ]) {
      await fixture.action(action);
      expect(fixture.server().at(-1)).toMatchObject({
        type: "agent.result",
        result: { type: "dom.act", outcome: "acted", trusted: false },
      });
      expect(
        fixture.native.calls.findLast((call) => call.method === "performAction")?.input,
      ).toMatchObject({
        documentId: fixture.presentation().documentId,
        request: { action },
      });
    }
    expect(fixture.native.submitted).toEqual(["dom.act", "dom.act"]);
  });

  test("the manager rejects malformed actions before native even when the sender skips schema validation", async () => {
    const fixture = await setup();
    await fixture.present();
    await fixture.agentAttach();
    const base = {
      id: 1,
      sessionId: fixture.sessionId,
      surfaceId: fixture.surfaceId,
      documentId: fixture.presentation().documentId,
    };
    for (const request of [
      {
        ...base,
        action: {
          type: "dom.act",
          kind: "click",
          selection: "end",
          locator: { by: "css", value: "input" },
        },
      },
      {
        ...base,
        action: {
          type: "dom.act",
          kind: "focus",
          value: "replacement",
          locator: { by: "css", value: "input" },
        },
      },
      {
        ...base,
        documentId: undefined,
        action: { type: "dom.act", kind: "focus", locator: { by: "css", value: "input" } },
      },
      { ...base, surfaceId: undefined, action: { type: "page.info" } },
      { ...base, surfaceId: null, action: { type: "session.tabs" } },
      { ...base, action: { type: "pointer.tap", x: 1, y: 1, count: 1 } },
    ]) {
      await expect(
        fixture.native.emit({
          type: "relayCommand",
          message: {
            ...fixture.currentEnvelope(),
            type: "browser.client-message",
            message: {
              type: "agent.action",
              attachmentId: fixture.attachmentId,
              actorToken: fixture.actorToken,
              requestId: uuid(),
              request,
            },
          } as unknown as PhoneRelayCommand,
        }),
      ).rejects.toMatchObject({ name: "ZodError" });
    }
    expect(fixture.native.calls.filter((call) => call.method === "performAction")).toEqual([]);
    expect(fixture.native.submitted).toEqual([]);
  });

  test("parses actual Host/relay messages, admits opaque single-use attach before allocation, and returns exact initialPage", async () => {
    const fixture = await setup("ios", {
      initialNavigation: { operationKey: "first-navigation", url: "https://example.com" },
    });
    expect(fixture.native.output.some((entry) => entry.type === "browser.attached")).toBe(true);
    await fixture.open("another-tab");
    await fixture.present("another-tab");
    await fixture.attach();
    const attached = fixture.native.output.findLast((entry) => entry.type === "browser.attached");
    expect(attached?.type === "browser.attached" && attached.initialPage).toEqual({
      operationKey: "first-navigation",
      surfaceId: fixture.surfaceId,
      navigation: "submitted",
    });
    await fixture.attach({
      initialNavigation: { operationKey: "first-navigation", url: "https://different.example" },
    });
    expect(fixture.native.output.at(-1)).toMatchObject({
      type: "browser.command-error",
      error: { reason: "forbidden" },
    });
    await fixture.relay({ ...fixture.fence, requestId: uuid(), type: "browser.health.request" });
    expect(
      fixture.native.output.findLast((entry) => entry.type === "browser.health"),
    ).toMatchObject({ browserRuntime: { state: "ready" } });
    for (const entry of fixture.native.output)
      expect(BrowserRelayToHostMessageSchema.safeParse(entry).success).toBe(true);
    for (const entry of fixture.server())
      expect(BrowserServerMessageSchema.safeParse(entry).success).toBe(true);
    expect(fixture.native.calls.findIndex((entry) => entry.method === "commitAttach")).toBeLessThan(
      fixture.native.calls.findIndex((entry) => entry.method === "createTab"),
    );
  });

  test("watching suspended tabs never resumes, captures, or enables debugging", async () => {
    const fixture = await setup("android");
    await fixture.client({
      type: "stream.subscribe",
      surfaceId: fixture.surfaceId,
      frameWindow: 1,
    });
    await fixture.client({ type: "stream.demand", surfaceId: fixture.surfaceId, density: 1 });
    expect(fixture.presentation().state).toBe("retained");
    expect([...fixture.native.capture.values()]).toEqual([false]);
    expect(fixture.native.authorizations.size).toBe(0);
    await fixture.client({
      type: "input.key",
      surfaceId: fixture.surfaceId,
      action: "down",
      key: "Enter",
      code: "Enter",
      modifiers: [],
    });
    expect(fixture.server().at(-1)).toMatchObject({
      type: "browser.error",
      error: { reason: "target-suspended" },
    });
  });

  test("keeps at most two live tabs without taking the visible tab; refuses simultaneous covered claimants", async () => {
    const fixture = await setup();
    await fixture.open("agent-tab");
    await fixture.open("other-agent-tab");
    await fixture.present();
    await fixture.agentAttach();
    const other = { attachmentId: uuid(), actorToken: uuid() };
    await fixture.agentAttach(other.attachmentId, other.actorToken);
    await Promise.all([
      fixture.action({ type: "surface.resume" }, "agent-tab"),
      fixture.action({ type: "surface.resume" }, "other-agent-tab", {}, other),
    ]);
    expect(fixture.presentation().state).toBe("live-visible");
    expect(
      [
        fixture.presentation("agent-tab").state,
        fixture.presentation("other-agent-tab").state,
      ].sort(),
    ).toEqual(["live-covered", "retained"]);
    expect([...fixture.native.tabs.values()].filter((tab) => tab.state === "live")).toHaveLength(2);
    expect(fixture.server()).toContainEqual(
      expect.objectContaining({
        type: "agent.error",
        error: expect.objectContaining({ code: "target-suspended" }),
      }),
    );
  });

  test("one attachment switches retained tabs without losing forms or reloading", async () => {
    const fixture = await setup();
    await fixture.open("second");
    await fixture.agentAttach();
    await fixture.action({ type: "surface.resume" });
    fixture.native.tabs.get(fixture.surfaceId)!.form = "unsent form";
    await fixture.action({ type: "surface.resume" }, "second");
    expect(fixture.presentation().state).toBe("retained");
    await fixture.action({ type: "surface.resume" });
    expect(fixture.presentation("second").state).toBe("retained");
    expect(fixture.native.tabs.get(fixture.surfaceId)).toMatchObject({
      form: "unsent form",
      loads: 1,
    });
    expect(fixture.native.tabs.get("second")?.loads).toBe(1);
  });

  test("a native page close frees its place once and ignores stale native generations", async () => {
    const fixture = await setup();
    await fixture.open("second");
    await fixture.agentAttach();
    await fixture.action({ type: "surface.resume" });
    const event = { ...fixture.reference(), type: "closed" as const };
    await fixture.native.emit({ ...event, generation: event.generation - 1 });
    expect(fixture.presentation().state).toBe("live-covered");
    fixture.native.tabs.delete(fixture.surfaceId);
    await fixture.native.emit(event);
    await fixture.native.emit(event);
    expect(fixture.presentation().state).toBe("closed");
    expect(fixture.manager.localPresentation(fixture.deploymentId, fixture.surfaceId)).toBeNull();
    expect(fixture.native.calls.filter(({ method }) => method === "destroyTab")).toHaveLength(0);
    await fixture.action({ type: "session.tabs" }, "second");
    expect(fixture.server().at(-1)).toMatchObject({
      type: "agent.result",
      result: { tabs: [{ surfaceId: "second" }] },
    });
    await fixture.action({ type: "surface.resume" }, "second");
    expect(fixture.presentation("second").state).toBe("live-covered");
  });

  test("opening another agent tab releases its own covered view before native allocation", async () => {
    const fixture = await setup();
    await fixture.agentAttach();
    await fixture.action({ type: "surface.resume" });
    fixture.native.tabs.get(fixture.surfaceId)!.form = "unsent form";
    await fixture.sessionAction({ type: "surface.open", url: "https://second.example/" });
    expect(fixture.presentation().state).toBe("retained");
    const opened = fixture.server().at(-1);
    expect(opened).toMatchObject({
      type: "agent.result",
      result: { type: "surface.open", binding: { state: "live" } },
    });
    await fixture.action({ type: "surface.resume" });
    expect(fixture.native.tabs.get(fixture.surfaceId)).toMatchObject({
      form: "unsent form",
      loads: 1,
    });
  });

  test("people cannot displace a watched tab or an agent, and detach hands a watched tab to people", async () => {
    const fixture = await setup();
    await fixture.open("second");
    await fixture.open("visible");
    await fixture.present("visible");
    const resume = (surfaceId: string) =>
      fixture.client({
        type: "cdp.command",
        requestId: uuid(),
        command: { method: "Opensteer.resumeTab", parameters: { surfaceId } },
      });
    await resume(fixture.surfaceId);
    expect(fixture.presentation().state).toBe("live-covered");
    await resume("second");
    expect(fixture.presentation().state).toBe("retained");
    await fixture.client({ type: "stream.subscribe", surfaceId: "second" });
    await resume(fixture.surfaceId);
    expect(fixture.server().at(-1)).toMatchObject({
      type: "cdp.error",
      error: { reason: "target-suspended" },
    });
    await resume("second");
    await resume(fixture.surfaceId);
    expect(fixture.presentation("second").state).toBe("live-covered");
    await fixture.agentAttach();
    await fixture.action({ type: "surface.resume" });
    expect(fixture.presentation("second").state).toBe("retained");
    await resume("second");
    expect(fixture.server().at(-1)).toMatchObject({
      type: "cdp.error",
      error: { reason: "target-suspended" },
    });
    await fixture.client({ type: "stream.subscribe", surfaceId: fixture.surfaceId });
    const resumes = fixture.native.calls.filter((call) => call.method === "resumeTab").length;
    await fixture.action({ type: "surface.resume" });
    expect(fixture.native.calls.filter((call) => call.method === "resumeTab")).toHaveLength(
      resumes,
    );
    await fixture.client({
      type: "agent.detach",
      sessionId: fixture.sessionId,
      attachmentId: fixture.attachmentId,
    });
    expect(fixture.presentation().state).toBe("live-covered");
    await resume("second");
    expect(fixture.presentation().state).toBe("live-covered");
    await fixture.client({ type: "stream.unsubscribe", surfaceId: fixture.surfaceId });
    expect(fixture.presentation().state).toBe("retained");
    expect(fixture.presentation("visible").state).toBe("live-visible");
  });

  test("an agent takes ownership of the same people tab and releases an unwatched tab on detach", async () => {
    const fixture = await setup();
    await fixture.client({
      type: "cdp.command",
      requestId: uuid(),
      command: {
        method: "Opensteer.resumeTab",
        parameters: { surfaceId: fixture.surfaceId },
      },
    });
    await fixture.agentAttach();
    const resumes = fixture.native.calls.filter((call) => call.method === "resumeTab").length;
    await fixture.action({ type: "surface.resume" });
    expect(fixture.native.calls.filter((call) => call.method === "resumeTab")).toHaveLength(
      resumes,
    );
    await fixture.client({
      type: "agent.detach",
      sessionId: fixture.sessionId,
      attachmentId: fixture.attachmentId,
    });
    expect(fixture.presentation().state).toBe("retained");
  });

  test("an agent attaching to a tab a person woke owns it after that person leaves", async () => {
    const fixture = await setup();
    await fixture.client({
      type: "cdp.command",
      requestId: uuid(),
      command: {
        method: "Opensteer.resumeTab",
        parameters: { surfaceId: fixture.surfaceId },
      },
    });
    await fixture.client({ type: "stream.subscribe", surfaceId: fixture.surfaceId });
    await fixture.agentAttach();
    await fixture.action({ type: "surface.attach" });
    await fixture.client({ type: "stream.unsubscribe", surfaceId: fixture.surfaceId });
    expect(fixture.presentation().state).toBe("live-covered");
    await fixture.client({
      type: "agent.detach",
      sessionId: fixture.sessionId,
      attachmentId: fixture.attachmentId,
    });
    expect(fixture.presentation().state).toBe("retained");
  });

  test("releasing an old picture cannot retain a newly claimed tab, and every receiver must leave", async () => {
    const fixture = await setup();
    await fixture.open("second");
    const resume = (surfaceId: string) =>
      fixture.client({
        type: "cdp.command",
        requestId: uuid(),
        command: { method: "Opensteer.resumeTab", parameters: { surfaceId } },
      });
    await resume(fixture.surfaceId);
    await fixture.client({ type: "stream.subscribe", surfaceId: fixture.surfaceId });
    await Promise.all([
      resume("second"),
      fixture.client({ type: "stream.unsubscribe", surfaceId: fixture.surfaceId }),
    ]);
    expect(fixture.presentation("second").state).toBe("live-covered");
    await fixture.client({ type: "stream.subscribe", surfaceId: "second" });
    const firstChannel = fixture.channelId();
    await fixture.attach();
    await fixture.client({ type: "stream.subscribe", surfaceId: "second" });
    await fixture.client({ type: "stream.unsubscribe", surfaceId: "second" }, firstChannel);
    expect(fixture.presentation("second").state).toBe("live-covered");
    await fixture.client({ type: "stream.unsubscribe", surfaceId: "second" });
    expect(fixture.presentation("second").state).toBe("retained");
  });

  test("local presentation frees the covered place without letting an agent change the visible tab", async () => {
    const fixture = await setup();
    await fixture.open("second");
    await fixture.agentAttach();
    await fixture.action({ type: "surface.resume" });
    await fixture.present();
    const other = { attachmentId: uuid(), actorToken: uuid() };
    await fixture.agentAttach(other.attachmentId, other.actorToken);
    await fixture.action({ type: "surface.resume" }, "second", {}, other);
    expect(fixture.presentation().state).toBe("live-visible");
    expect(fixture.presentation("second").state).toBe("live-covered");
    await fixture.client({
      type: "agent.detach",
      sessionId: fixture.sessionId,
      attachmentId: fixture.attachmentId,
    });
    expect(fixture.presentation().state).toBe("live-visible");
    expect(fixture.presentation("second").state).toBe("live-covered");
  });

  test("local opening recognizes retained tabs without claiming the agent's covered place", async () => {
    const fixture = await setup();
    await fixture.present();
    await fixture.manager.hideTab(fixture.surfaceId);
    await fixture.open("second");
    await fixture.agentAttach();
    await fixture.action({ type: "surface.resume" }, "second");
    expect(
      fixture.manager.localPresentation(fixture.deploymentId, fixture.surfaceId),
    ).toMatchObject({ sessionId: fixture.sessionId, surfaceId: fixture.surfaceId });
    expect(fixture.manager.localPresentation("another-deployment", fixture.surfaceId)).toBeNull();
    expect(fixture.manager.localPresentation(fixture.deploymentId, "unheld-tab")).toBeNull();
    await fixture.present();
    expect(fixture.presentation().state).toBe("live-visible");
    expect(fixture.presentation("second").state).toBe("live-covered");
    expect(fixture.native.calls.filter(({ method }) => method === "createTab")).toHaveLength(2);
  });

  test("switching waits for submitted input and fences queued input even after switching back", async () => {
    const fixture = await setup();
    await fixture.open("second");
    await fixture.agentAttach();
    await fixture.action({ type: "surface.resume" });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.native.actionGate = async () => {
      entered.resolve();
      await release.promise;
    };
    const first = fixture.action({ type: "text.insert", text: "first" });
    await withTimeout(entered.promise, 1000, {
      timeoutError: () => new Error("First input never reached native"),
    });
    const queued = fixture.action({ type: "text.insert", text: "must not run" });
    const switched = fixture.action({ type: "surface.resume" }, "second");
    await Promise.resolve();
    expect(fixture.presentation("second").state).toBe("retained");
    release.resolve();
    await withTimeout(Promise.all([first, queued, switched]), 1000, {
      timeoutError: () => new Error("Tab switch never settled"),
    });
    await fixture.action({ type: "surface.resume" });
    expect(fixture.native.submitted.filter((type) => type === "text.insert")).toHaveLength(1);
    expect(fixture.presentation().state).toBe("live-covered");
  });

  test("switching retained tabs preserves forms; LRU and memory pressure discard before reload", async () => {
    const fixture = await setup();
    await fixture.present();
    fixture.native.tabs.get(fixture.surfaceId)!.form = "unsent form";
    await fixture.open("second");
    await fixture.present("second");
    await fixture.present();
    expect(fixture.native.tabs.get(fixture.surfaceId)).toMatchObject({
      form: "unsent form",
      loads: 1,
    });
    for (let index = 0; index < 5; index++) await fixture.open(`retained-${index}`);
    expect(
      [...fixture.native.tabs.values()].filter((tab) => tab.state === "retained"),
    ).toHaveLength(4);
    expect(fixture.presentation("second").state).toBe("discarded");
    await fixture.present("second");
    expect(fixture.native.tabs.get("second")?.loads).toBe(2);
    await fixture.native.emit({
      type: "memoryPressure",
      epoch: fixture.native.epoch,
      level: "warning",
    });
    expect(
      [...fixture.native.tabs.values()].filter((tab) => tab.state === "retained"),
    ).toHaveLength(0);
    expect(fixture.presentation("second").state).toBe("live-visible");
    for (let index = 0; index < 4; index++) await fixture.open(`background-${index}`);
    await fixture.manager.setForeground(false);
    expect(
      [...fixture.native.tabs.values()].filter((tab) => tab.state === "retained"),
    ).toHaveLength(4);
    expect(fixture.presentation("background-0").state).toBe("discarded");
  });

  test("renderer loss suspends only exact native generations; resume receives a fresh document", async () => {
    const fixture = await setup();
    await fixture.present();
    const before = fixture.presentation().documentId;
    fixture.native.tabs.get(fixture.surfaceId)!.state = "discarded";
    await fixture.native.emit({
      type: "rendererGone",
      epoch: fixture.native.epoch,
      tabs: [fixture.reference()],
    });
    expect(fixture.presentation().state).toBe("discarded");
    await fixture.present();
    expect(fixture.presentation().documentId).not.toBe(before);
  });

  test("rejects stale documents, geometry, input sequences and native epochs", async () => {
    const fixture = await setup();
    await fixture.present();
    await fixture.agentAttach();
    await fixture.action({ type: "text.insert", text: "wrong" }, fixture.surfaceId, {
      documentId: "old-document",
    });
    expect(fixture.server().at(-1)).toMatchObject({
      type: "agent.error",
      error: { code: "stale-document" },
    });
    await fixture.action({ type: "pointer.tap", x: 1, y: 1, count: 1 }, fixture.surfaceId, {
      geometryRevision: 900,
    });
    expect(fixture.server().at(-1)).toMatchObject({
      type: "agent.error",
      error: { code: "stale-geometry" },
    });
    const input: BrowserClientMessage = BrowserClientMessageSchema.parse({
      type: "input.key",
      surfaceId: fixture.surfaceId,
      action: "down",
      key: "Enter",
      code: "Enter",
      modifiers: [],
      producerId: uuid(),
      inputGeneration: 1,
      inputSequence: 2,
    });
    await fixture.client(input);
    await fixture.client(input);
    expect(fixture.server().at(-1)).toMatchObject({
      type: "browser.error",
      error: { reason: "forbidden" },
    });
    const old = fixture.reference();
    await fixture.manager.setForeground(false);
    await expect(fixture.native.navigate({ ...old, kind: "reload" })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(fixture.native.submitted).toEqual([]);
  });

  test("close tombstones and inventory fences defeat late native changes and popups", async () => {
    const fixture = await setup();
    await fixture.open("close-me");
    const reference = fixture.reference("close-me");
    const metadata = fixture.native.tabs.get("close-me")!.metadata;
    await fixture.client({
      type: "cdp.command",
      requestId: uuid(),
      command: {
        method: "Opensteer.closeTab",
        parameters: { surfaceId: "close-me", inventoryRevision: fixture.revision()! - 1 },
      },
    });
    expect(fixture.presentation("close-me").state).not.toBe("closed");
    await fixture.client({
      type: "cdp.command",
      requestId: uuid(),
      command: {
        method: "Opensteer.closeTab",
        parameters: { surfaceId: "close-me", inventoryRevision: fixture.revision() },
      },
    });
    await fixture.native.emit({
      ...reference,
      type: "tabChanged",
      metadata: { ...metadata, title: "late resurrection", revision: 100 },
    });
    await fixture.native.emit({
      ...reference,
      type: "popup",
      openerId: fixture.surfaceId,
      metadata,
    });
    expect(fixture.presentation("close-me").state).toBe("closed");
    expect(fixture.native.tabs.has("close-me")).toBe(false);
  });

  test("Host open is idempotent and context reads remain independent of a blocked action", async () => {
    const fixture = await setup();
    const key = uuid();
    await Promise.all([fixture.open("opened-once", key), fixture.open("opened-once", key)]);
    expect(fixture.native.calls.filter((entry) => entry.method === "createTab")).toHaveLength(2);
    await fixture.present();
    await fixture.agentAttach();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.native.actionGate = () => {
      entered.resolve();
      return withTimeout(release.promise, 1000, {
        timeoutError: () => new Error("The blocked action was not released."),
      });
    };
    const pending = fixture.action({ type: "text.insert", text: "held" });
    await withTimeout(entered.promise, 1000, {
      timeoutError: () => new Error("The native action did not start."),
    });
    await fixture.client({
      type: "cdp.command",
      requestId: uuid(),
      command: {
        method: "Opensteer.contextCandidate",
        parameters: { surfaceId: fixture.surfaceId },
      },
    });
    expect(fixture.server().at(-1)).toMatchObject({
      type: "cdp.result",
      result: { documentId: fixture.presentation().documentId },
    });
    release.resolve();
    await pending;
  });

  test("dialogs answer once outside a blocked mutation lane", async () => {
    const fixture = await setup();
    await fixture.present();
    await fixture.agentAttach();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.native.actionGate = () => {
      entered.resolve();
      return withTimeout(release.promise, 1000, {
        timeoutError: () => new Error("The dialog-blocked action was not released."),
      });
    };
    const blocked = fixture.action({ type: "text.insert", text: "pending" });
    await withTimeout(entered.promise, 1000, {
      timeoutError: () => new Error("The dialog-blocked native action did not start."),
    });
    const dialogId = uuid();
    await fixture.native.emit({
      ...fixture.reference(),
      type: "dialog",
      dialog: {
        id: dialogId,
        surfaceId: fixture.surfaceId as never,
        type: "confirm",
        message: "Continue?",
      },
    });
    await Promise.all([
      fixture.action({ type: "dialog.respond", dialogId, accept: true }),
      fixture.client({
        type: "dialog.respond",
        surfaceId: fixture.surfaceId,
        dialogId,
        accept: false,
      }),
    ]);
    expect(fixture.native.dialogsAnswered).toEqual([dialogId]);
    expect(fixture.presentation().dialog).toBeNull();
    await fixture.native.emit({
      ...fixture.reference(),
      type: "dialog",
      dialog: {
        id: dialogId,
        surfaceId: fixture.surfaceId as never,
        type: "confirm",
        message: "Late callback",
      },
    });
    expect(fixture.presentation().dialog).toBeNull();
    release.resolve();
    await blocked;
  });

  test("an expired queued mutation never executes after the earlier action finishes", async () => {
    const fixture = await setup();
    await fixture.present();
    await fixture.agentAttach();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.native.actionGate = () => {
      entered.resolve();
      return withTimeout(release.promise, 1000, {
        timeoutError: () => new Error("The first mutation was not released."),
      });
    };
    const first = fixture.action({ type: "text.insert", text: "first" });
    await withTimeout(entered.promise, 1000, {
      timeoutError: () => new Error("The first native mutation did not start."),
    });
    const expired = fixture.action({ type: "text.insert", text: "expired" }, fixture.surfaceId, {
      timeoutMs: 1,
    });
    fixture.clock.advance(2);
    await expired;
    expect(fixture.server().at(-1)).toMatchObject({
      type: "agent.error",
      error: { code: "timeout" },
    });
    release.resolve();
    await first;
    expect(fixture.native.tabs.get(fixture.surfaceId)!.form).toBe("first");
    expect(fixture.native.submitted).toEqual(["text.insert"]);
  });

  test("each signed channel keeps its own read authority instead of inheriting another viewer's control", async () => {
    const fixture = await setup();
    await fixture.present();
    await fixture.attach({ access: "read" });
    await fixture.client({
      type: "input.key",
      surfaceId: fixture.surfaceId,
      action: "down",
      key: "Enter",
      code: "Enter",
      modifiers: [],
    });
    expect(fixture.server().at(-1)).toMatchObject({
      type: "browser.error",
      error: { reason: "forbidden" },
    });
  });

  test("captures only admitted live subscriptions, keeps the 8fps bound and preserves Watch credit", async () => {
    const fixture = await setup();
    await fixture.client({
      type: "stream.subscribe",
      surfaceId: fixture.surfaceId,
      frameWindow: 1,
    });
    await fixture.client({ type: "stream.demand", surfaceId: fixture.surfaceId, density: 0.75 });
    await fixture.present();
    expect([...fixture.native.capture.values()]).toEqual([true]);
    const token = uuid();
    await fixture.client({ type: "stream.ack", surfaceId: fixture.surfaceId, token });
    expect(
      fixture.native.calls.findLast((entry) => entry.method === "ackFrame")?.input,
    ).toMatchObject({ token, epoch: fixture.native.epoch });
    expect(
      fixture.native.calls
        .filter((entry) => entry.method === "setCaptureDemand")
        .every((entry) => (entry.input as { maxFps: number }).maxFps === 8),
    ).toBe(true);
    await fixture.client({ type: "stream.unsubscribe", surfaceId: fixture.surfaceId });
    expect([...fixture.native.capture.values()]).toEqual([false]);
    expect(fixture.presentation().state).toBe("live-visible");
  });

  test("plain clipboard and editing contexts are scoped to the drawn document and requesting channel", async () => {
    const fixture = await setup();
    await fixture.present();
    const contextId = uuid();
    await fixture.native.emit({
      ...fixture.reference(),
      type: "editing",
      channelId: fixture.currentEnvelope().channelId,
      context: { contextId, field: null, caret: null },
    });
    await fixture.client({
      type: "input.text",
      surfaceId: fixture.surfaceId,
      edit: { contextId, text: "plain", before: "", after: "" },
    });
    const operationId = uuid();
    await fixture.client({
      type: "clipboard.paste-data",
      surfaceId: fixture.surfaceId,
      operationId,
      items: [{ type: "text/plain", size: 5 }],
    });
    await fixture.client({
      type: "clipboard.part",
      part: { operationId, index: 0, data: "cGxhaW4=" },
    });
    expect(fixture.server().at(-1)?.type).not.toBe("browser.error");
    await fixture.client({
      type: "clipboard.paste-data",
      surfaceId: fixture.surfaceId,
      operationId: uuid(),
      items: [{ type: "text/html", size: 5 }],
    });
    expect(fixture.server().at(-1)).toMatchObject({
      type: "browser.error",
      error: { reason: "unsupported-operation" },
    });
    const metadata = fixture.native.tabs.get(fixture.surfaceId)!.metadata;
    const next = {
      ...metadata,
      documentId: "new-committed-document",
      revision: metadata.revision + 1,
    };
    fixture.native.tabs.get(fixture.surfaceId)!.metadata = next;
    await fixture.native.emit({ ...fixture.reference(), type: "documentChanged", metadata: next });
    await fixture.client({
      type: "input.text",
      surfaceId: fixture.surfaceId,
      edit: { contextId, text: "stale", before: "", after: "" },
    });
    expect(fixture.server().at(-1)).toMatchObject({
      type: "browser.error",
      error: { reason: "stale-document" },
    });
    await fixture.client({
      type: "clipboard.part",
      part: { operationId, index: 0, data: "cGxhaW4=" },
    });
    expect(fixture.server().at(-1)).toMatchObject({
      type: "browser.error",
      error: { reason: "stale-document" },
    });
  });

  test("revocation fences before acknowledgement; old grants and old auxiliary streams cannot return", async () => {
    const fixture = await setup("android");
    await fixture.present();
    const { channelId: _channelId, ...envelope } = fixture.currentEnvelope();
    const epoch = fixture.native.epoch;
    await fixture.relay({ ...envelope, type: "capability.revoke", requestId: uuid() });
    expect(fixture.native.epoch).toBeGreaterThan(epoch);
    expect(fixture.presentation().state).toBe("retained");
    expect(fixture.native.output.at(-1)).toMatchObject({ type: "capability.revoked" });
    await fixture.relay({
      ...fixture.fence,
      type: "capability.grant",
      requestId: uuid(),
      lease: {
        ...envelope.capability,
        expiresAt: new Date(fixture.clock.now() + 60_000).toISOString(),
      },
    });
    expect(fixture.native.output.at(-1)).toMatchObject({
      type: "browser.command-error",
      error: { reason: "forbidden" },
    });
    const retired = { ...fixture.fence };
    await fixture.reconnect();
    const outputCount = fixture.native.output.length;
    await fixture.native.emit({
      type: "connection",
      state: "online",
      fence: retired,
      leaseDeadline: fixture.clock.now() + 60_000,
    });
    expect(fixture.native.output).toHaveLength(outputCount);
    const epochAfterReconnect = fixture.native.epoch;
    await fixture.native.emit({
      type: "connection",
      state: "offline",
      reason: "late-old-disconnect",
      fence: retired,
    });
    expect(fixture.native.epoch).toBe(epochAfterReconnect);
    await fixture.present();
    expect(fixture.presentation().live).toBe(true);
  });

  test("refuses omitted abilities and unsafe navigation with the existing typed Host error", async () => {
    const fixture = await setup();
    await fixture.present();
    for (const message of [
      { type: "input.command", surfaceId: fixture.surfaceId, command: "undo" },
      { type: "clipboard.cut", surfaceId: fixture.surfaceId, operationId: uuid() },
      { type: "state.import", operationId: uuid(), site: "https://example.com", cookies: [] },
      { type: "signin.probe", probeId: uuid(), site: "https://example.com" },
      { type: "navigation.go", surfaceId: fixture.surfaceId, url: "file:///private/file" },
    ]) {
      await fixture.client(message);
      expect(fixture.server().at(-1)).toMatchObject({
        type: "browser.error",
        error: { reason: "unsupported-operation", retryable: false },
      });
    }
  });

  test("retains popup metadata without silently selecting it and reports Host navigation attribution unchanged", async () => {
    const fixture = await setup();
    await fixture.present();
    const metadata = fixture.native.tabs.get(fixture.surfaceId)!.metadata;
    fixture.native.tabs.set("popup-tab", {
      sessionId: fixture.sessionId,
      metadata: { ...metadata, generation: 500 },
      state: "live",
      loads: 1,
      form: "",
    });
    const consumerToken = uuid();
    await fixture.native.emit({
      ...fixture.reference(),
      tabId: "popup-tab",
      generation: 500,
      type: "popup",
      openerId: fixture.surfaceId,
      consumerToken,
      metadata: { ...metadata, generation: 500 },
    });
    expect(fixture.presentation().state).toBe("live-visible");
    expect(fixture.presentation("popup-tab").state).toBe("retained");
    expect(fixture.server()).toContainEqual({
      type: "browser.popup.opened",
      surfaceId: "popup-tab",
      consumerToken,
    });
    const navigationId = uuid();
    const updated = {
      ...metadata,
      documentId: "redirect-document",
      revision: metadata.revision + 1,
      url: "https://example.com/redirect",
    };
    await fixture.native.emit({
      ...fixture.reference(),
      type: "navigationCommitted",
      navigationId,
      metadata: updated,
    });
    expect(fixture.server().at(-1)).toEqual({
      type: "navigation.committed",
      navigationId,
      surfaceId: fixture.surfaceId,
      documentId: updated.documentId,
      url: updated.url,
    });
  });

  test("a native mounting failure fences the live pool instead of leaking an untracked live view", async () => {
    const fixture = await setup();
    await fixture.open("next-tab");
    fixture.native.mountError = new PhoneBrowserError(
      "target-closed",
      "The native presentation host closed.",
    );
    await expect(fixture.present()).rejects.toMatchObject({ code: "target-closed" });
    expect([...fixture.native.tabs.values()].filter((tab) => tab.state === "live")).toEqual([]);
    expect(fixture.presentation().state).toBe("retained");
  });

  test("background mid-action fences synchronously, cancels pending work and never replays on reconnect", async () => {
    const fixture = await setup();
    await fixture.present();
    await fixture.agentAttach();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.native.actionGate = () => {
      entered.resolve();
      return withTimeout(release.promise, 1000, {
        timeoutError: () => new Error("The backgrounded action was not released."),
      });
    };
    const pending = fixture.action({ type: "text.insert", text: "must not arrive" });
    await withTimeout(entered.promise, 1000, {
      timeoutError: () => new Error("The native action did not start before backgrounding."),
    });
    const oldEpoch = fixture.native.epoch;
    const leaving = fixture.manager.setForeground(false);
    expect(fixture.native.epoch).toBeGreaterThan(oldEpoch);
    expect(fixture.native.pipes.size).toBe(0);
    expect(fixture.native.capture.size).toBe(0);
    await leaving;
    await pending;
    release.resolve();
    await fixture.manager.setForeground(true);
    await fixture.reconnect();
    expect(fixture.presentation().state).toBe("live-visible");
    expect(fixture.native.submitted).toEqual([]);
    expect(fixture.native.replay.entries).toHaveLength(2);
  });

  test("outcome-unknown is returned once and never retried, including a duplicate delivery", async () => {
    const fixture = await setup();
    await fixture.present();
    await fixture.agentAttach();
    fixture.native.actionError = new PhoneBrowserError(
      "outcome-unknown",
      "Input may have been submitted.",
    );
    const requestId = uuid();
    const message = {
      type: "agent.action",
      attachmentId: fixture.attachmentId,
      actorToken: fixture.actorToken,
      requestId,
      request: {
        id: 1,
        sessionId: fixture.sessionId,
        surfaceId: fixture.surfaceId,
        documentId: fixture.presentation().documentId,
        action: { type: "text.insert", text: "once" },
      },
    };
    await fixture.client(message);
    await fixture.client(message);
    expect(fixture.server().filter((entry) => entry.type === "agent.error")).toEqual([
      expect.objectContaining({
        error: { code: "outcome-unknown", message: "Input may have been submitted." },
      }),
    ]);
    expect(fixture.native.calls.filter((entry) => entry.method === "performAction")).toHaveLength(
      1,
    );
  });

  test("returns honest erasure results and fences before removal, including Android pending-restart", async () => {
    const fixture = await setup("android");
    fixture.native.erasure = "pending-restart";
    const { channelId: _channelId, ...envelope } = fixture.currentEnvelope();
    await fixture.relay({
      ...envelope,
      type: "browser.profile.delete",
      requestId: uuid(),
      binding: fixture.binding,
      deletionId: uuid(),
    });
    expect(
      fixture.native.output.findLast((entry) => entry.type === "browser.profile.delete.result"),
    ).toMatchObject({ state: "pending-restart" });
    const result = await fixture.manager.eraseDeployment();
    expect(result).toEqual([
      expect.objectContaining({ phase: "deleted", erasure: "pending-restart" }),
    ]);
    expect(fixture.presentation().state).toBe("closed");
  });

  test("expires leases immediately and consumes shared replay/fence vectors without relaxing their rules", async () => {
    const fixture = await setup();
    await fixture.present();
    fixture.clock.advance(60_000);
    expect(fixture.presentation().state).toBe("retained");
    expect(fixture.native.authorizations.size).toBe(0);
    for (const vector of fences.comparisons)
      expect(
        sameRunnerAuxiliaryFence(
          fences.fence as never,
          { ...fences.fence, ...vector.patch } as never,
        ),
      ).toBe(vector.accepted);
    let state: ReplayLedgerState = { ...fences.replay.initial, version: 1 };
    for (const vector of fences.replay.cases) {
      const transition = () =>
        transitionReplayLedger(
          state,
          vector.nonce,
          vector.expiresAt ?? fences.replay.expiresAt,
          vector.now,
          128,
        );
      if (vector.accepted) state = transition();
      else expect(transition).toThrow();
    }
  });
});

test("descriptors declare only the actually qualified platform abilities", () => {
  for (const platform of ["ios", "android"] as const) {
    const native = new FakePhoneBrowserNative(platform);
    const descriptor = phoneBrowserDescriptor(native.qualification)!;
    expect(RunnerBrowserModuleSchema.safeParse(descriptor).success).toBe(true);
    expect(descriptor).toMatchObject({
      wireVersion: 1,
      basicInput: 1,
      surfaceState: 1,
      localProfileStorage: { engine: platform === "ios" ? "wkwebview" : "android-webview" },
    });
    for (const omitted of [
      "editing",
      "clipboard",
      "passkeys",
      "stateImport",
      "cardFill",
      "signIn",
      "hostOperations",
    ])
      expect(descriptor).not.toHaveProperty(omitted);
    expect(descriptor.agentActions).toBe(platform === "ios" ? 1 : undefined);
    expect(descriptor.cdpBoundary).toBe(platform === "android" ? 1 : undefined);
    expect(
      phoneBrowserDescriptor({ ...native.qualification, cdpBoundary: false }),
    ).not.toHaveProperty("cdpBoundary");
    expect(phoneBrowserDescriptor({ ...native.qualification, browser: false })).toBeUndefined();
    const viewingOnly = phoneBrowserDescriptor({
      ...native.qualification,
      agentActions: false,
      fileStaging: true,
    });
    expect(viewingOnly).toMatchObject({ sharedControl: 1, basicInput: 1, fileStaging: true });
    expect(viewingOnly).not.toHaveProperty("agentActions");
    const runner = phoneBrowserRunnerDescriptor(native.qualification, {
      runnerId: fences.fence.runnerId as never,
      bootId: fences.fence.bootId as never,
      name: "Phone",
      runtimeVersion: "1.0.0",
    });
    expect(RunnerDescriptorSchema.safeParse(runner).success).toBe(true);
    expect(runner?.device).toEqual({ form: "phone", platform });
    expect(runner?.modules.integrations).toEqual(
      platform === "ios" ? { platform: "ios", protocolVersion: 2 } : undefined,
    );
  }
});

test("Android routes stable surface targets through the real CDP allowlist, with debugging only while attached", async () => {
  const fixture = await setup("android");
  const command = async (
    method: string,
    parameters?: Record<string, unknown>,
    sessionId?: string,
  ) => {
    const requestId = uuid();
    await fixture.client({
      type: "cdp.command",
      actorToken: fixture.actorToken,
      requestId,
      command: {
        method,
        ...(parameters ? { parameters } : {}),
        ...(sessionId ? { sessionId } : {}),
      },
    });
    return fixture
      .server()
      .findLast(
        (entry) =>
          (entry.type === "cdp.result" || entry.type === "cdp.error") &&
          entry.requestId === requestId,
      );
  };
  expect(fixture.native.authorizations.size).toBe(0);
  expect(await command("Target.getTargets")).toMatchObject({
    type: "cdp.result",
    result: { targetInfos: [expect.objectContaining({ targetId: fixture.surfaceId })] },
  });
  const attached = await command("Target.attachToTarget", {
    targetId: fixture.surfaceId,
    flatten: true,
  });
  expect(attached?.type).toBe("cdp.result");
  const cdpSessionId =
    attached?.type === "cdp.result" ? (attached.result.sessionId as string) : "missing";
  expect(fixture.native.pipes.size).toBe(1);
  expect(fixture.presentation().state).toBe("live-covered");
  const before = fixture.native.calls.filter((entry) => entry.method === "sendCdp").length;
  expect(
    await command("Browser.setPermission", { permission: { name: "clipboard-read" } }),
  ).toMatchObject({ type: "cdp.error" });
  expect(
    await command("Page.navigate", { url: "file:///private/passwords" }, cdpSessionId),
  ).toMatchObject({ type: "cdp.error" });
  expect(fixture.native.calls.filter((entry) => entry.method === "sendCdp")).toHaveLength(before);
  expect(await command("Page.startScreencast", {}, cdpSessionId)).toMatchObject({
    type: "cdp.error",
    error: { reason: "unsupported-operation" },
  });
  expect(fixture.native.calls.filter((entry) => entry.method === "sendCdp")).toHaveLength(before);
  expect(await command("Page.captureScreenshot", { format: "png" }, cdpSessionId)).toMatchObject({
    type: "cdp.result",
    result: { data: "AQ==" },
  });
  fixture.native.tabs.get(fixture.surfaceId)!.form = "Android form";
  await fixture.open("second");
  expect(
    await command("Target.attachToTarget", { targetId: "second", flatten: true }),
  ).toMatchObject({ type: "cdp.result" });
  expect(fixture.presentation().state).toBe("retained");
  expect(
    await command("Target.attachToTarget", { targetId: fixture.surfaceId, flatten: true }),
  ).toMatchObject({ type: "cdp.result" });
  expect(fixture.presentation("second").state).toBe("retained");
  expect(fixture.native.tabs.get(fixture.surfaceId)).toMatchObject({
    form: "Android form",
    loads: 1,
  });
  await fixture.relay({ ...fixture.currentEnvelope(), type: "browser.close", requestId: uuid() });
  expect(fixture.native.authorizations.size).toBe(0);
  expect(fixture.native.pipes.size).toBe(0);
});

test("native action captures deliver directly without returning pixels through the port", async () => {
  const fixture = await setup();
  await fixture.present();
  await fixture.agentAttach();
  await fixture.action({ type: "page.capture", format: "png" });
  expect(fixture.server().at(-1)).toMatchObject({
    type: "agent.result",
    result: { type: "page.capture", data: "AQ==" },
  });
  expect(fixture.server().filter((entry) => entry.type === "agent.result")).toHaveLength(1);
});

test("closing the last Host tab emits terminal status and releases its native session", async () => {
  const fixture = await setup();
  await fixture.client({
    type: "cdp.command",
    requestId: uuid(),
    command: {
      method: "Opensteer.closeTab",
      parameters: {
        surfaceId: fixture.surfaceId,
        inventoryRevision: fixture.revision(),
      },
    },
  });
  expect(fixture.server().filter((entry) => entry.type === "browser.status")).toEqual([
    { type: "browser.status", state: "closing" },
    { type: "browser.status", state: "closed" },
  ]);
  expect(fixture.native.tabs.size).toBe(0);
  expect(fixture.presentation().state).toBe("closed");
});

test("a CDP session never receives another Host session's targets or native metadata events", async () => {
  const fixture = await setup("android");
  const own = fixture.currentEnvelope();
  await fixture.client({
    type: "cdp.command",
    actorToken: fixture.actorToken,
    requestId: uuid(),
    command: { method: "Target.getTargets" },
  });
  await fixture.attach({ sessionId: `bsn_${uuid()}`, initialSurfaceId: "foreign-surface" });
  expect(
    fixture.native.output.filter(
      (entry) =>
        entry.type === "browser.server-message" &&
        entry.channelId === own.channelId &&
        entry.message.type === "cdp.event" &&
        JSON.stringify(entry.message.event).includes("foreign-surface"),
    ),
  ).toEqual([]);
  const requestId = uuid();
  await fixture.relay({
    ...own,
    type: "browser.client-message",
    message: {
      type: "cdp.command",
      actorToken: fixture.actorToken,
      requestId,
      command: {
        method: "Target.attachToTarget",
        parameters: { targetId: "foreign-surface", flatten: true },
      },
    },
  });
  expect(
    fixture
      .server()
      .findLast((entry) => entry.type === "cdp.error" && entry.requestId === requestId),
  ).toMatchObject({ type: "cdp.error" });
  expect(fixture.native.pipes.size).toBe(0);
});
