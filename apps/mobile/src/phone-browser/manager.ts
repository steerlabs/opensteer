import {
  transitionReplayLedger,
  validateAttachTicketClaims,
} from "@opensteer/browser-core/attach-ticket-policy";
import { SessionCdpRouterError } from "@opensteer/browser-core/session-cdp-router";
import { BrowserSurfaceIdSchema } from "@opensteer/core";
import {
  BrowserActionResultSchema,
  BrowserAttachTicketClaimsSchema,
  BrowserClientMessageSchema,
  BrowserContextCandidateSchema,
  BrowserServerMessageSchema,
  BrowserSessionTabOpenCommandSchema,
  browserBasicInputAllows,
  browserHostMethods,
  type BrowserActionBindingSchema,
  type BrowserActionResult,
  type BrowserClientMessage,
  type BrowserServerMessage,
  type BrowserSurface,
  type HeldLocalProfile,
  type LocalProfileBinding,
} from "@opensteer/protocol/browser";
import {
  BrowserRelayToHostMessageSchema,
  HostToBrowserRelayMessageSchema,
  type BrowserCapabilityLease,
  type BrowserCapabilityReference,
  type BrowserRelayToHostMessage,
} from "@opensteer/protocol/browser-relay";
import {
  sameRunnerAuxiliaryFence,
  type RunnerAuxiliaryFrameFence,
} from "@opensteer/protocol/runner-auxiliary";
import { z } from "zod";
import type { ProtocolError } from "@opensteer/protocol";
import { PhoneCdpSession } from "./cdp.js";
import { phoneBrowserDescriptor } from "./descriptor.js";
import {
  PhoneBrowserError,
  type NativeDocumentRef,
  type NativeQualification,
  type NativeTabMetadata,
  type PhoneBrowserNativeEvent,
  type PhoneBrowserNativePort,
  type PhoneRelayCommand,
} from "./native-port.js";
import { isLive, type PhoneChannel, type PhoneSession, type PhoneTab } from "./state.js";

export interface PhoneBrowserClock {
  readonly now: () => number;
  readonly schedule: (deadline: number, callback: () => void) => () => void;
}
const systemClock: PhoneBrowserClock = {
  now: Date.now,
  schedule: (deadline, callback) => {
    const timer = setTimeout(callback, Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  },
};
export interface PhoneTabPresentation {
  readonly surfaceId: string;
  readonly nativeGeneration: number;
  readonly state: PhoneTab["state"];
  readonly live: boolean;
  readonly mount: boolean;
  readonly title: string;
  readonly url: string;
  readonly loading: boolean;
  readonly navigationFailed: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly documentId: string;
  readonly geometryRevision: number;
  readonly dialog: PhoneTab["dialog"];
}
export interface PhonePresentationAdmission {
  readonly sessionId: string;
  readonly surfaceId: string;
  readonly runtimeId: string;
  readonly bindingId: string | null;
  readonly targetControl: 1;
}
type AgentAction = Extract<BrowserClientMessage, { type: "agent.action" }>;
type AgentAttachment = {
  channel: PhoneChannel;
  actorToken: string;
  backend: "actions" | "cdp";
};

const sanitizedAttachSchema = HostToBrowserRelayMessageSchema.options
  .find(
    (option): option is Extract<typeof option, { shape: { attachTicket: unknown } }> =>
      "attachTicket" in option.shape,
  )!
  .omit({ attachTicket: true })
  .extend({ attachHandle: z.string().min(1) });
const openParametersSchema = BrowserSessionTabOpenCommandSchema.omit({
  type: true,
  sessionId: true,
}).extend({ surfaceId: BrowserSurfaceIdSchema.optional() });
const closeParametersSchema = z.strictObject({
  surfaceId: BrowserSurfaceIdSchema,
  inventoryRevision: z.number().int().nonnegative(),
  durable: z.boolean().optional(),
});

export class PhoneBrowserManager {
  readonly #native: PhoneBrowserNativePort;
  readonly #clock: PhoneBrowserClock;
  readonly #uuid: () => string;
  readonly #deploymentId: string;
  readonly #runnerId: string;
  readonly #sessions = new Map<string, PhoneSession>();
  readonly #sessionStarts = new Map<string, Promise<PhoneSession>>();
  readonly #initialOperations = new Map<string, string>();
  readonly #channels = new Map<string, PhoneChannel>();
  readonly #tabs = new Map<string, PhoneTab>();
  readonly #profiles = new Map<string, HeldLocalProfile>();
  readonly #attachments = new Map<string, AgentAttachment>();
  readonly #cdp = new Map<string, Promise<PhoneCdpSession>>();
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #presentations = new Map<string, PhoneTabPresentation>();
  readonly #lanes = new Map<string, Promise<unknown>>();
  readonly #inputSequences = new Map<string, { generation: number; sequence: number }>();
  readonly #answeredDialogs = new Set<string>();
  readonly #actionRequests = new Map<string, Promise<void>>();
  readonly #opening = new Set<string>();
  readonly #clipboard = new Map<string, { tab: PhoneTab; documentId: string }>();
  readonly #retiredConnections = new Set<string>();
  readonly #unsubscribe: () => void;
  #qualification: NativeQualification | null = null;
  #capability: BrowserCapabilityLease | null = null;
  #capabilityHighWater = 0;
  #connection: { fence: RunnerAuxiliaryFrameFence; deadline: number } | null = null;
  #epoch: number;
  #abort = new AbortController();
  #cancelLease: (() => void) | null = null;
  #foreground = false;
  #disposed = false;
  #visible: string | null = null;
  #covered: string | null = null;
  #selected: { admission: PhonePresentationAdmission; hostId: string } | null = null;
  #lru = 0;
  #presentationTurn: Promise<unknown> = Promise.resolve();

  constructor(input: {
    native: PhoneBrowserNativePort;
    deploymentId: string;
    runnerId: string;
    clock?: PhoneBrowserClock;
    uuid: () => string;
  }) {
    this.#native = input.native;
    this.#deploymentId = input.deploymentId;
    this.#runnerId = input.runnerId;
    this.#clock = input.clock ?? systemClock;
    this.#uuid = input.uuid;
    this.#epoch = this.#native.fence("initialize");
    this.#unsubscribe = this.#native.onEvent((event) => this.handleEvent(event));
  }

  async initialize(): Promise<void> {
    const epoch = this.#epoch;
    this.#qualification = await this.#bounded(epoch, () =>
      this.#native.initialize({
        epoch,
        deploymentId: this.#deploymentId,
        runnerId: this.#runnerId,
      }),
    );
    await this.#readProfiles(epoch);
  }

  get descriptor() {
    return this.#qualification ? phoneBrowserDescriptor(this.#qualification) : undefined;
  }

  getTabPresentation = (surfaceId: string): PhoneTabPresentation | null =>
    this.#presentations.get(surfaceId) ?? null;

  subscribeTab = (surfaceId: string, listener: () => void): (() => void) => {
    let listeners = this.#listeners.get(surfaceId);
    if (!listeners) this.#listeners.set(surfaceId, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(surfaceId);
    };
  };

  async setForeground(active: boolean): Promise<void> {
    if (this.#disposed || this.#foreground === active) return;
    this.#foreground = active;
    if (!active) {
      if (this.#connection) this.#retiredConnections.add(connectionKey(this.#connection.fence));
      this.#invalidate("inactive");
      this.#connection = null;
    }
    await this.#native.setForeground({ epoch: this.#epoch, active });
  }

  async presentTab(admission: PhonePresentationAdmission, hostId: string): Promise<void> {
    const epoch = this.#epoch;
    const session = this.#sessions.get(admission.sessionId);
    const binding = session?.claims.identity;
    if (
      !session?.channels.size ||
      ![...session.channels].some((id) => this.#channels.get(id)?.claims.access === "read-write") ||
      admission.runtimeId !== this.#qualification?.runtimeId ||
      admission.targetControl !== 1 ||
      admission.bindingId !== (binding?.kind === "profile-local" ? binding.binding.bindingId : null)
    )
      throw new PhoneBrowserError("forbidden", "A Host-admitted local presentation is required.");
    const tab = this.#requireTab(session, admission.surfaceId);
    this.#selected = { admission, hostId };
    const turn = this.#presentationTurn
      .catch(() => undefined)
      .then(async () => {
        this.#assertEpoch(epoch);
        const previous = this.#visible ? this.#tabs.get(this.#visible) : undefined;
        if (previous && previous !== tab) await this.#retain(previous);
        if (this.#covered === tab.id) this.#covered = null;
        this.#visible = tab.id;
        try {
          await this.#makeLive(tab, "live-visible");
          const metadata = await this.#native.mountTab({
            ...this.#ref(tab),
            hostId,
            presentationGeneration: ++tab.presentationGeneration,
            interactive: true,
          });
          this.#acceptMetadata(tab, metadata);
          this.#publishTab(tab);
          await this.#publish(session);
        } catch (error) {
          if (epoch === this.#epoch) this.#invalidate("presentation-failed", error);
          throw error;
        }
      });
    this.#presentationTurn = turn;
    await this.#bounded(epoch, () => turn);
  }

  async hideTab(surfaceId: string): Promise<void> {
    const tab = this.#tabs.get(surfaceId);
    if (!tab || this.#visible !== surfaceId) return;
    this.#selected = null;
    await this.#retain(tab);
    await this.#publish(this.#requireSession(tab.sessionId));
  }

  async eraseDeployment(): Promise<readonly HeldLocalProfile[]> {
    this.#invalidate("deployment-removed");
    this.#connection = null;
    this.#foreground = false;
    await this.#native.setForeground({ epoch: this.#epoch, active: false });
    const entries = await this.#native.eraseDeployment({
      epoch: this.#epoch,
      deploymentId: this.#deploymentId,
    });
    this.#profiles.clear();
    for (const entry of entries) this.#profiles.set(entry.binding.bindingId, entry);
    for (const tab of this.#tabs.values()) {
      tab.state = "closed";
      this.#publishTab(tab);
    }
    this.#sessions.clear();
    this.#selected = null;
    // The caller may forget enrollment only after this resolves; pending-restart remains explicit.
    return entries;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#invalidate("disposed");
    this.#disposed = true;
    this.#unsubscribe();
    await this.#native.setForeground({ epoch: this.#epoch, active: false });
  }

  async handleEvent(event: PhoneBrowserNativeEvent): Promise<void> {
    if (this.#disposed) return;
    if (event.type === "connection") {
      if (event.state === "offline") {
        if (!this.#connection || !sameRunnerAuxiliaryFence(this.#connection.fence, event.fence))
          return;
        if (this.#connection) this.#retiredConnections.add(connectionKey(this.#connection.fence));
        this.#invalidate("connection-lost");
        this.#connection = null;
        return;
      }
      if (
        !this.#foreground ||
        event.fence.runnerId !== this.#runnerId ||
        event.fence.module !== "browser"
      )
        return;
      if (this.#retiredConnections.has(connectionKey(event.fence))) return;
      if (event.leaseDeadline <= this.#clock.now()) return;
      if (this.#connection && sameRunnerAuxiliaryFence(this.#connection.fence, event.fence)) {
        this.#connection.deadline = event.leaseDeadline;
      } else {
        if (this.#connection) this.#retiredConnections.add(connectionKey(this.#connection.fence));
        this.#invalidate("connection-replaced");
        this.#capabilityHighWater = 0;
        this.#connection = { fence: { ...event.fence }, deadline: event.leaseDeadline };
      }
      this.#armLease();
      await this.#inventory();
      return;
    }
    if (event.type === "relayCommand") {
      await this.#relay(event.message, event.authorityHandle);
      return;
    }
    if (event.epoch !== this.#epoch || !this.#foreground) return;
    if (event.type === "memoryPressure") {
      const retained = [...this.#tabs.values()]
        .filter((tab) => tab.state === "retained")
        .sort((left, right) => left.lastUsed - right.lastUsed);
      for (const tab of retained) await this.#discard(tab);
      if (event.level === "critical" && this.#covered) {
        const covered = this.#tabs.get(this.#covered);
        if (covered) await this.#discard(covered);
      }
      for (const session of this.#sessions.values()) await this.#publish(session);
      return;
    }
    if (event.type === "rendererGone") {
      for (const reference of event.tabs) {
        const tab = this.#tabs.get(reference.tabId);
        if (
          !tab ||
          tab.sessionId !== reference.sessionId ||
          tab.state === "closed" ||
          tab.metadata.generation !== reference.generation
        )
          continue;
        tab.state = "discarded";
        tab.dialog = null;
        if (this.#covered === tab.id) this.#covered = null;
        if (this.#visible === tab.id) this.#visible = null;
        this.#publishTab(tab);
        await this.#publish(this.#requireSession(tab.sessionId));
      }
      return;
    }
    if (event.type === "cdpEvent") {
      for (const pending of this.#cdp.values())
        void pending
          .then((cdp) => cdp.nativeEvent(event.pipeHandle, event.method, event.params))
          .catch(() => undefined);
      return;
    }
    if (event.type === "agentEvent") {
      const attachment = this.#attachments.get(event.attachmentId);
      const id =
        event.event.type === "surface.changed"
          ? event.event.binding.surfaceId
          : event.event.surfaceId;
      if (
        attachment &&
        (attachment.channel.session.tabs.has(id) || attachment.channel.session.closed.has(id))
      )
        await this.#send(attachment.channel, {
          type: "agent.event",
          attachmentId: event.attachmentId,
          event: event.event,
        });
      return;
    }
    const session = this.#sessions.get(event.sessionId);
    if (!session || session.closed.has(event.tabId)) return;
    if (event.type === "popup") {
      const opener = session.tabs.get(event.openerId);
      if (!opener || session.tabs.has(event.tabId) || this.#tabs.has(event.tabId)) return;
      const tab = this.#newTab(session, event.tabId, event.metadata, event.openerId);
      await this.#native.suspendTab({ ...this.#ref(tab), state: "retained" });
      await this.#trimRetained();
      await this.#publish(session);
      if (event.consumerToken && session.claims.popupFollowVersion === 1)
        await this.#broadcast(session, {
          type: "browser.popup.opened",
          surfaceId: BrowserSurfaceIdSchema.parse(tab.id),
          consumerToken: event.consumerToken,
        });
      return;
    }
    const tab = session.tabs.get(event.tabId);
    if (!tab || tab.state === "closed" || event.generation !== tab.metadata.generation) return;
    if (
      event.type === "tabChanged" ||
      event.type === "documentChanged" ||
      event.type === "geometry" ||
      event.type === "navigationCommitted"
    ) {
      if (!this.#acceptMetadata(tab, event.metadata)) return;
      this.#publishTab(tab);
      await this.#publish(session);
      if (event.type === "navigationCommitted" && session.claims.navigationAttributionVersion === 1)
        await this.#broadcast(session, {
          type: "navigation.committed",
          navigationId: event.navigationId,
          surfaceId: BrowserSurfaceIdSchema.parse(tab.id),
          documentId: tab.metadata.documentId,
          url: tab.metadata.url,
        });
      return;
    }
    if ("documentId" in event && event.documentId !== tab.metadata.documentId) return;
    if (event.type === "dialog") {
      if (
        event.dialog &&
        this.#answeredDialogs.has(`${tab.id}:${event.documentId}:${event.dialog.id}`)
      )
        return;
      if (!event.dialog && tab.dialog?.id !== event.dialogId) return;
      tab.dialog = event.dialog;
      this.#publishTab(tab);
      this.#dialogEvents(tab);
      await this.#broadcast(session, {
        type: "browser.dialog.changed",
        surfaceId: BrowserSurfaceIdSchema.parse(tab.id),
        dialog: tab.dialog,
      });
    } else if (event.type === "activity" || event.type === "editing") {
      const channel = this.#channels.get(event.channelId);
      if (channel?.session !== session || !isLive(tab)) return;
      if (event.type === "activity") {
        if (
          event.report.surfaceId !== tab.id ||
          event.report.geometryRevision !== tab.metadata.geometryRevision
        )
          return;
        await this.#send(channel, event.report);
      } else {
        tab.editingContextId = event.context.contextId;
        await this.#send(channel, {
          type: "browser.editing",
          surfaceId: BrowserSurfaceIdSchema.parse(tab.id),
          geometryRevision: tab.metadata.geometryRevision,
          context: event.context,
        });
      }
    } else if (event.type === "serverMessage") {
      const channel = this.#channels.get(event.channelId);
      if (channel?.session === session && isLive(tab)) {
        if (event.message.type === "browser.editing")
          tab.editingContextId = event.message.context.contextId;
        await this.#send(channel, event.message);
      }
    }
  }

  async #relay(unparsed: PhoneRelayCommand, authorityHandle?: string): Promise<void> {
    const message = (
      unparsed.type === "browser.attach"
        ? sanitizedAttachSchema.parse(unparsed)
        : HostToBrowserRelayMessageSchema.parse(unparsed)
    ) as PhoneRelayCommand;
    const connection = this.#connection;
    if (!connection || !sameRunnerAuxiliaryFence(connection.fence, message)) return;
    const epoch = this.#epoch;
    try {
      if (!this.#foreground || connection.deadline <= this.#clock.now())
        throw new PhoneBrowserError("forbidden", "The browser connection expired.");
      if (message.type === "browser.health.request") {
        await this.#sendRelay({
          ...connection.fence,
          requestId: message.requestId,
          type: "browser.health",
          browserRuntime: {
            checkedAt: new Date(this.#clock.now()).toISOString(),
            detail: null,
            runtimeId: this.#qualification?.runtimeId ?? "unavailable",
            sessionId: null,
            state: this.descriptor && this.#capability ? "ready" : "unavailable",
          },
        });
      } else if (message.type === "capability.grant") {
        const lease = message.lease;
        if (
          !this.descriptor ||
          lease.runtimeId !== this.#qualification?.runtimeId ||
          Date.parse(lease.expiresAt) <= this.#clock.now() ||
          lease.capabilityGeneration < this.#capabilityHighWater
        )
          throw new PhoneBrowserError("forbidden", "The capability grant is stale.");
        if (!this.#sameCapability(lease, this.#capability)) {
          if (lease.capabilityGeneration <= this.#capabilityHighWater)
            throw new PhoneBrowserError("forbidden", "The capability grant is retired.");
          this.#invalidate("capability-replaced");
        }
        this.#capability = lease;
        this.#capabilityHighWater = lease.capabilityGeneration;
        this.#armLease();
        await this.#sendRelay({
          ...connection.fence,
          requestId: message.requestId,
          type: "capability.accepted",
          capability: capabilityReference(lease),
        });
      } else {
        this.#assertCapability(message.capability);
        if (message.type === "capability.revoke") {
          this.#invalidate("capability-revoked");
          await this.#sendRelay({
            ...connection.fence,
            requestId: message.requestId,
            type: "capability.revoked",
            capability: message.capability,
          });
        } else if (message.type === "browser.attach") {
          await this.#attach(message);
        } else if (message.type === "browser.profile.delete") {
          this.#assertBinding(message.binding);
          for (const session of this.#sessions.values())
            if (
              session.claims.identity.kind === "profile-local" &&
              session.claims.identity.binding.bindingId === message.binding.bindingId
            )
              await this.#endSession(session);
          const state = await this.#bounded(epoch, () =>
            this.#native.eraseProfile({
              epoch,
              binding: message.binding,
              deletionId: message.deletionId,
            }),
          );
          await this.#sendRelay({ ...message, type: "browser.profile.delete.result", state });
          await this.#inventory();
        } else if (message.type === "browser.close") {
          const channel = this.#requireChannel(message.channelId);
          await this.#closeChannel(channel);
          await this.#sendRelay({
            ...message,
            type: "browser.closed",
            code: 1000,
            reason: "Host closed the browser relay.",
          });
        } else {
          const channel = this.#requireChannel(message.channelId);
          await this.#client(
            channel,
            BrowserClientMessageSchema.parse(message.message),
            authorityHandle,
          );
        }
      }
    } catch (error) {
      if (this.#connection !== connection || !this.#foreground) return;
      if (message.type === "browser.client-message") {
        const channel = this.#channels.get(message.channelId);
        if (channel)
          await this.#send(channel, { type: "browser.error", error: protocolError(error) });
      } else if ("requestId" in message) {
        await this.#sendRelay({
          ...connection.fence,
          type: "browser.command-error",
          requestId: message.requestId,
          channelId: "channelId" in message ? message.channelId : null,
          error: protocolError(error),
        });
      }
    }
  }

  async #verified(handle: string, epoch: number) {
    const verified = await this.#bounded(epoch, () =>
      this.#native.verifyAttach({ epoch, attachHandle: handle }),
    );
    const claims = BrowserAttachTicketClaimsSchema.parse(verified.claims);
    const now = this.#clock.now();
    validateAttachTicketClaims(claims, this.#qualification!.runtimeId, now);
    if (Date.parse(claims.operationExpiresAt) <= now)
      throw new PhoneBrowserError("timeout", "The browser operation expired.");
    if (claims.editingVersion || claims.clipboard !== undefined || claims.passkeys)
      throw new PhoneBrowserError(
        "unsupported-operation",
        "The phone does not offer this ability.",
      );
    const replayTransition = transitionReplayLedger(
      verified.replayState,
      claims.nonce,
      Date.parse(claims.expiresAt),
      now,
      verified.maxReplayEntries,
    );
    const permit = await this.#bounded(epoch, () =>
      this.#native.commitAttach({
        epoch,
        attachHandle: handle,
        claimsDigest: verified.claimsDigest,
        replayTransition,
      }),
    );
    return { claims, permit };
  }

  async #attach(message: Extract<PhoneRelayCommand, { type: "browser.attach" }>): Promise<void> {
    const epoch = this.#epoch;
    if (this.#channels.has(message.channelId))
      throw new PhoneBrowserError("forbidden", "The channel already exists.");
    const { claims, permit } = await this.#verified(message.attachHandle, epoch);
    if (claims.identity.kind === "profile-local") this.#assertBinding(claims.identity.binding);
    let session = this.#sessions.get(claims.sessionId);
    const starting = this.#sessionStarts.get(claims.sessionId);
    if (starting) session = await starting;
    if (
      session &&
      (session.claims.subject !== claims.subject ||
        session.claims.identity.kind !== claims.identity.kind ||
        (session.claims.identity.kind === "profile-local" &&
          claims.identity.kind === "profile-local" &&
          JSON.stringify(session.claims.identity.binding) !==
            JSON.stringify(claims.identity.binding)))
    )
      throw new PhoneBrowserError("forbidden", "The session binding changed.");
    if (session?.closing)
      throw new PhoneBrowserError("target-closed", "The browser session is closing.");
    if (claims.initialNavigation) {
      const key = JSON.stringify([claims.subject, claims.initialNavigation.operationKey]);
      const fingerprint = JSON.stringify({
        sessionId: claims.sessionId,
        identity: claims.identity.kind === "profile-local" ? claims.identity.binding : "fresh",
        navigation: claims.initialNavigation,
      });
      const previous = this.#initialOperations.get(key);
      if (
        (previous !== undefined && (previous !== fingerprint || !session)) ||
        (session &&
          (JSON.stringify(session.claims.initialNavigation) !==
            JSON.stringify(claims.initialNavigation) ||
            (claims.initialSurfaceId !== undefined &&
              claims.initialSurfaceId !== session.initialId)))
      )
        throw new PhoneBrowserError("forbidden", "The initial opening already has an outcome.");
      if (session && !session.tabs.has(session.initialId))
        throw new PhoneBrowserError("target-closed", "The initial tab has closed.");
      if (!previous && this.#initialOperations.size >= 1000)
        throw new PhoneBrowserError("too-large", "The initial opening budget is exhausted.");
      this.#initialOperations.set(key, fingerprint);
    }
    if (!session) {
      const pending = this.#startSession(claims, permit, epoch);
      this.#sessionStarts.set(claims.sessionId, pending);
      try {
        session = await pending;
      } finally {
        if (this.#sessionStarts.get(claims.sessionId) === pending)
          this.#sessionStarts.delete(claims.sessionId);
      }
    }
    session.allocationPermit = permit;
    const channel: PhoneChannel = {
      id: message.channelId,
      capability: message.capability,
      session,
      epoch,
      claims,
      subscriptions: new Map(),
    };
    this.#channels.set(channel.id, channel);
    session.channels.add(channel.id);
    const first = session.activeId ? session.tabs.get(session.activeId) : undefined;
    await this.#sendRelay({
      ...this.#connection!.fence,
      type: "browser.attached",
      requestId: message.requestId,
      capability: message.capability,
      channelId: message.channelId,
      ...(claims.initialNavigation && first
        ? {
            initialPage: {
              operationKey: claims.initialNavigation.operationKey,
              surfaceId: BrowserSurfaceIdSchema.parse(session.initialId),
              navigation: claims.initialNavigation.url ? "submitted" : "blank",
            },
          }
        : {}),
    });
    await this.#send(channel, {
      type: "browser.snapshot",
      sessionId: claims.sessionId,
      access: claims.access,
      state: "ready",
      dialog: first?.dialog ?? null,
      surfaces: this.#surfaces(session),
      inventoryRevision: session.revision,
      targetedStreamingVersion: 1,
      inputLanesVersion: 1,
      ...(claims.navigationAttributionVersion ? { navigationAttributionVersion: 1 } : {}),
      ...(claims.basicInput ? { basicInput: 1 } : {}),
      ...(claims.surfaceState ? { surfaceState: 1 } : {}),
    });
    await this.#publish(session);
    await this.#inventory();
    const selected = this.#selected;
    if (
      claims.access === "read-write" &&
      selected?.admission.sessionId === claims.sessionId &&
      (claims.initialSurfaceId === selected.admission.surfaceId ||
        claims.dormantSurfaceIds?.includes(
          BrowserSurfaceIdSchema.parse(selected.admission.surfaceId),
        ))
    )
      await this.presentTab(selected.admission, selected.hostId);
  }

  async #startSession(
    claims: z.infer<typeof BrowserAttachTicketClaimsSchema>,
    permit: string,
    epoch: number,
  ): Promise<PhoneSession> {
    const identity = claims.identity;
    if (identity.kind === "profile-local") this.#assertBinding(identity.binding);
    const storeHandle =
      identity.kind === "profile-local"
        ? await this.#bounded(epoch, () =>
            this.#native.ensureProfile({
              epoch,
              binding: identity.binding,
              initialized: identity.initialized,
              allocationPermit: permit,
            }),
          )
        : null;
    const session: PhoneSession = {
      claims,
      initialId: claims.initialSurfaceId ?? `bsf_${this.#uuid()}`,
      storeHandle,
      allocationPermit: permit,
      tabs: new Map(),
      channels: new Set(),
      opened: new Map(),
      closed: new Set(),
      activeId: null,
      revision: 0,
      closing: false,
    };
    const deadline = Math.min(
      this.#clock.now() + claims.remainingBudgetMs,
      Date.parse(claims.operationExpiresAt),
    );
    await this.#bounded(
      epoch,
      () =>
        this.#createTab(
          session,
          session.initialId,
          claims.initialNavigation?.url ??
            (identity.kind === "profile-local" ? identity.readyUrl : "about:blank"),
          claims.viewport,
          claims.initialNavigation?.navigationId,
        ),
      Math.max(0, deadline - this.#clock.now()),
    );
    this.#sessions.set(claims.sessionId, session);
    return session;
  }

  async #client(
    channel: PhoneChannel,
    message: BrowserClientMessage,
    authorityHandle?: string,
  ): Promise<void> {
    const session = channel.session;
    if (session.closing)
      throw new PhoneBrowserError("target-closed", "The browser session is closing.");
    if (message.type === "agent.attach") {
      if (
        message.sessionId !== session.claims.sessionId ||
        (message.backend === "actions"
          ? !this.descriptor?.agentActions
          : !this.descriptor?.cdpBoundary)
      )
        throw new PhoneBrowserError("unsupported-operation", "The agent backend is unavailable.");
      const previous = this.#attachments.get(message.attachmentId);
      if (previous && (previous.channel !== channel || previous.actorToken !== message.actorToken))
        throw new PhoneBrowserError("forbidden", "The attachment was already bound.");
      this.#attachments.set(message.attachmentId, {
        channel,
        actorToken: message.actorToken,
        backend: message.backend,
      });
      await this.#bounded(channel.epoch, () =>
        this.#native.attachAgent({
          epoch: channel.epoch,
          channelId: channel.id,
          sessionId: message.sessionId,
          attachmentId: message.attachmentId,
          actorToken: message.actorToken,
          backend: message.backend,
        }),
      );
      return;
    }
    if (message.type === "agent.detach") {
      const attachment = this.#attachments.get(message.attachmentId);
      if (attachment?.channel !== channel || message.sessionId !== session.claims.sessionId) return;
      this.#attachments.delete(message.attachmentId);
      await this.#native.detachAgent({ epoch: channel.epoch, attachmentId: message.attachmentId });
      if (
        ![...this.#attachments.values()].some((entry) => entry.channel.session === session) &&
        this.#covered
      ) {
        const covered = session.tabs.get(this.#covered);
        if (covered) await this.#retain(covered);
      }
      return;
    }
    if (message.type === "agent.action") {
      const key = `${message.attachmentId}:${message.requestId}`;
      if (this.#actionRequests.has(key)) return;
      if (this.#actionRequests.size >= 4096)
        throw new PhoneBrowserError("too-large", "The attachment request budget is exhausted.");
      const operation = this.#action(channel, message);
      this.#actionRequests.set(key, operation);
      await operation;
      return;
    }
    if (message.type === "cdp.command") {
      await this.#command(channel, message, authorityHandle);
      return;
    }
    const id = "surfaceId" in message ? message.surfaceId : undefined;
    const clipboard =
      message.type === "clipboard.part"
        ? this.#clipboard.get(`${channel.id}:${message.part.operationId}`)
        : undefined;
    if (
      message.type === "clipboard.part" &&
      (!clipboard || clipboard.documentId !== clipboard.tab.metadata.documentId)
    )
      throw new PhoneBrowserError(
        "stale-document",
        "The clipboard operation is no longer bound to this document.",
      );
    const tab = clipboard?.tab ?? this.#requireTab(session, id ?? session.activeId);
    if (
      message.type === "stream.subscribe" ||
      message.type === "stream.demand" ||
      message.type === "stream.unsubscribe" ||
      message.type === "stream.ack"
    ) {
      if (message.type === "stream.ack") {
        if (channel.subscriptions.has(tab.id) && isLive(tab))
          await this.#native.ackFrame({
            ...this.#ref(tab),
            channelId: channel.id,
            token: message.token,
          });
        return;
      }
      if (message.type === "stream.unsubscribe") channel.subscriptions.delete(tab.id);
      else {
        const previous = channel.subscriptions.get(tab.id);
        channel.subscriptions.set(tab.id, {
          density: message.type === "stream.demand" ? message.density : (previous?.density ?? 1),
          frames:
            message.type === "stream.subscribe"
              ? message.frames !== false
              : (previous?.frames ?? false),
          ...(message.type === "stream.subscribe" && message.frameWindow
            ? { frameWindow: message.frameWindow }
            : {}),
        });
      }
      await this.#capture(channel, tab);
      return;
    }
    if (message.type === "surface.close")
      throw new PhoneBrowserError("unsupported-operation", "Close tabs through the Host.");
    if (message.type === "surface.activate") {
      this.#assertLive(tab);
      session.activeId = tab.id;
      await this.#publish(session);
      return;
    }
    if (message.type === "surface.open") {
      if (channel.claims.access !== "read-write")
        throw new PhoneBrowserError("forbidden", "Control access is required.");
      await this.#createTab(session, `bsf_${this.#uuid()}`, message.url ?? "about:blank");
      await this.#publish(session);
      return;
    }
    if (channel.claims.access !== "read-write")
      throw new PhoneBrowserError("forbidden", "Control access is required.");
    this.#assertLive(tab);
    this.#admitInput(tab, message);
    if (message.type === "dialog.respond") {
      await this.#dialog(tab, message.dialogId, message.accept, message.promptText);
      return;
    }
    if (message.type === "cursor.query" || message.type === "cursor.reset") {
      await this.#native.applyViewerInput({ ...this.#ref(tab), channelId: channel.id, message });
      return;
    }
    if (message.type.startsWith("navigation.")) {
      const navigation = message as Extract<BrowserClientMessage, { type: `navigation.${string}` }>;
      await this.#tabOperation(tab, () =>
        this.#native.navigate({
          ...this.#ref(tab),
          kind: navigation.type.slice(11) as "go" | "back" | "forward" | "reload" | "stop",
          ...("url" in navigation ? { url: phoneNavigationUrl(navigation.url) } : {}),
          ...("ignoreCache" in navigation && navigation.ignoreCache !== undefined
            ? { ignoreCache: navigation.ignoreCache }
            : {}),
          ...("navigationId" in navigation && navigation.navigationId
            ? { navigationId: navigation.navigationId }
            : {}),
        }),
      );
      return;
    }
    if (message.type === "viewport.set" || message.type === "viewport.follow") {
      await this.#tabOperation(tab, async () => {
        const metadata = await this.#native.resizeTab({
          ...this.#ref(tab),
          width: message.width,
          height: message.height,
        });
        this.#acceptMetadata(tab, metadata);
        this.#publishTab(tab);
      });
      return;
    }
    if (message.type.startsWith("input.") || message.type.startsWith("clipboard.")) {
      if (!channel.claims.basicInput || !browserBasicInputAllows(message))
        throw new PhoneBrowserError(
          "unsupported-operation",
          "Only basic phone input is available.",
        );
      if (message.type === "clipboard.paste-data") {
        if (this.#clipboard.size >= 32)
          throw new PhoneBrowserError("too-large", "Too many clipboard operations are pending.");
        this.#clipboard.set(`${channel.id}:${message.operationId}`, {
          tab,
          documentId: tab.metadata.documentId,
        });
      }
      await this.#tabOperation(tab, () =>
        this.#native.applyViewerInput({ ...this.#ref(tab), channelId: channel.id, message }),
      );
      return;
    }
    throw new PhoneBrowserError("unsupported-operation", "The phone does not offer this ability.");
  }

  async #command(
    channel: PhoneChannel,
    message: Extract<BrowserClientMessage, { type: "cdp.command" }>,
    authorityHandle?: string,
  ): Promise<void> {
    try {
      const session = channel.session;
      const { method, parameters } = message.command;
      let result: Record<string, unknown>;
      if (Object.values(browserHostMethods).includes(method as typeof browserHostMethods.openTab)) {
        if (message.actorToken)
          throw new PhoneBrowserError("forbidden", "This is a Host-only operation.");
        if (method === browserHostMethods.openTab) {
          const parsed = openParametersSchema.parse(parameters);
          if (parsed.surfaceId && session.claims.workspaceTabRestoreVersion !== 1)
            throw new PhoneBrowserError("forbidden", "Tab restore was not negotiated.");
          if (authorityHandle) {
            const { claims } = await this.#verified(authorityHandle, channel.epoch);
            if (
              claims.sessionId !== session.claims.sessionId ||
              claims.initialNavigation?.operationKey !== parsed.idempotencyKey ||
              claims.initialNavigation.url !== parsed.url
            )
              throw new PhoneBrowserError("forbidden", "Opening authority does not match.");
          }
          const fingerprint = JSON.stringify({
            url: parsed.url,
            viewport: parsed.viewport,
            surfaceId: parsed.surfaceId,
          });
          const previous = session.opened.get(parsed.idempotencyKey);
          if (previous && previous.fingerprint !== fingerprint)
            throw new PhoneBrowserError("forbidden", "The idempotency key was already used.");
          if (!previous && session.opened.size >= 1000)
            throw new PhoneBrowserError("too-large", "The session's opening budget is exhausted.");
          const outcome =
            previous?.outcome ??
            this.#createTab(
              session,
              parsed.surfaceId ?? `bsf_${this.#uuid()}`,
              parsed.url ?? "about:blank",
              parsed.viewport,
              message.navigationId,
            ).then((tab) => tab.id);
          if (!previous) session.opened.set(parsed.idempotencyKey, { fingerprint, outcome });
          result = { tabId: await outcome };
          await this.#publish(session);
        } else if (method === browserHostMethods.closeTab) {
          const parsed = closeParametersSchema.parse(parameters);
          const durable = parsed.durable && session.claims.workspaceTabRestoreVersion === 1;
          if (!durable && parsed.inventoryRevision !== session.revision)
            throw new PhoneBrowserError("stale-document", "The browser inventory changed.");
          const tab = session.tabs.get(parsed.surfaceId);
          if (tab) await this.#closeTab(session, tab);
          else if (!durable) throw new PhoneBrowserError("target-closed", "The tab is closed.");
          else session.closed.add(parsed.surfaceId);
          result = { outcome: session.tabs.size ? "tab-closed" : "session-closed" };
          await this.#publish(session);
        } else {
          const tab = this.#requireTab(session, parameters?.surfaceId);
          if (tab.metadata.navigationFailed)
            throw new PhoneBrowserError("not-actionable", "The page navigation failed.");
          result = BrowserContextCandidateSchema.parse({
            sessionId: session.claims.sessionId,
            tabId: tab.id,
            documentId: tab.metadata.documentId,
            title: tab.metadata.title.slice(0, 256),
            url: tab.metadata.url.length <= 2048 ? tab.metadata.url : "",
          });
        }
      } else {
        if (!message.actorToken || !this.descriptor?.cdpBoundary)
          throw new PhoneBrowserError("unsupported-operation", "CDP is unavailable.");
        const cdp = await this.#cdpSession(channel, message.actorToken);
        const command = {
          method: message.command.method,
          ...(message.command.parameters ? { parameters: message.command.parameters } : {}),
          ...(message.command.sessionId ? { sessionId: message.command.sessionId } : {}),
        };
        if (
          await this.#bounded(channel.epoch, () =>
            cdp.capture(command, channel.id, message.requestId),
          )
        )
          return;
        const value = await this.#bounded(channel.epoch, () => cdp.send(command));
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new PhoneBrowserError("unsupported-operation", "Invalid CDP result.");
        result = value as Record<string, unknown>;
      }
      await this.#send(channel, { type: "cdp.result", requestId: message.requestId, result });
      if (message.command.method === browserHostMethods.closeTab && !channel.session.tabs.size)
        await this.#endSession(channel.session);
    } catch (error) {
      await this.#send(channel, {
        type: "cdp.error",
        requestId: message.requestId,
        error: protocolError(error),
      });
    }
  }

  async #action(channel: PhoneChannel, message: AgentAction): Promise<void> {
    try {
      const attachment = this.#attachments.get(message.attachmentId);
      if (
        attachment?.channel !== channel ||
        attachment.actorToken !== message.actorToken ||
        attachment.backend !== "actions"
      )
        throw new PhoneBrowserError("forbidden", "The attachment is not authorized.");
      const request = message.request;
      const session = channel.session;
      if (request.sessionId !== session.claims.sessionId)
        throw new PhoneBrowserError("forbidden", "The session changed.");
      const action = request.action;
      if (
        channel.claims.access !== "read-write" &&
        ![
          "session.tabs",
          "page.info",
          "dom.snapshot",
          "dom.query",
          "dom.wait",
          "page.wait",
          "page.capture",
        ].includes(action.type)
      )
        throw new PhoneBrowserError("forbidden", "Control access is required.");
      let result: BrowserActionResult;
      if (action.type === "session.tabs")
        result = { type: "session.tabs", tabs: [...session.tabs.values()].map(actionBinding) };
      else {
        const tab = this.#requireTab(session, request.surfaceId);
        if (request.documentId && request.documentId !== tab.metadata.documentId)
          throw new PhoneBrowserError("stale-document", "The document changed.");
        if (
          request.geometryRevision !== undefined &&
          request.geometryRevision !== tab.metadata.geometryRevision
        )
          throw new PhoneBrowserError("stale-geometry", "The page geometry changed.");
        if (action.type === "surface.resume" || action.type === "surface.attach") {
          await this.#resumeAgent(tab);
          result = { type: action.type, binding: actionBinding(tab) };
        } else if (action.type === "surface.close") {
          await this.#closeTab(session, tab);
          result = { type: "surface.close", outcome: "closed" };
        } else if (action.type === "surface.open") {
          this.#assertLive(tab);
          const opened = await this.#createTab(
            session,
            `bsf_${this.#uuid()}`,
            action.url ?? "about:blank",
            action.viewport,
          );
          result = { type: "surface.open", binding: actionBinding(opened) };
        } else {
          this.#assertLive(tab);
          if (action.type === "page.info")
            result = {
              type: "page.info",
              binding: actionBinding(tab),
              loading: tab.metadata.loading,
              navigationFailed: tab.metadata.navigationFailed,
              sizedByAgent: false,
              dialog: tab.dialog,
            };
          else if (action.type === "dialog.respond") {
            await this.#dialog(tab, action.dialogId, action.accept, action.promptText);
            result = { type: "dialog.respond" };
          } else {
            if (tab.dialog) {
              await this.#send(channel, {
                type: "agent.error",
                attachmentId: message.attachmentId,
                requestId: message.requestId,
                error: {
                  code: "dialog-open",
                  message: "The page has an open dialog.",
                  dialog: tab.dialog,
                },
              });
              return;
            }
            if (
              (action.type === "file.stage" || action.type === "file.choose") &&
              !this.descriptor?.fileStaging
            )
              throw new PhoneBrowserError("unsupported-operation", "File staging is unavailable.");
            const independent =
              action.type === "dom.snapshot" ||
              action.type === "dom.query" ||
              action.type === "dom.wait" ||
              action.type === "page.wait" ||
              action.type === "page.capture";
            const captured = this.#ref(tab);
            const deadline = this.#clock.now() + request.timeoutMs;
            const nativeResult = await this.#tabOperation(
              tab,
              () =>
                this.#native.performAction({
                  ...captured,
                  channelId: channel.id,
                  attachmentId: message.attachmentId,
                  actorToken: message.actorToken,
                  requestId: message.requestId,
                  request,
                  deadline,
                }),
              { independent, timeout: request.timeoutMs },
            );
            if (nativeResult.type === "delivered") {
              if (action.type !== "page.capture")
                throw new PhoneBrowserError(
                  "unsupported-operation",
                  "Invalid native action result.",
                );
              return;
            }
            if (nativeResult.type !== action.type)
              throw new PhoneBrowserError(
                "unsupported-operation",
                "The native action result mismatched.",
              );
            result = BrowserActionResultSchema.parse(nativeResult);
          }
        }
      }
      await this.#publish(channel.session);
      await this.#send(channel, {
        type: "agent.result",
        attachmentId: message.attachmentId,
        requestId: message.requestId,
        result,
      });
      if (!channel.session.tabs.size) await this.#endSession(channel.session);
    } catch (error) {
      await this.#send(channel, {
        type: "agent.error",
        attachmentId: message.attachmentId,
        requestId: message.requestId,
        error: {
          code: error instanceof PhoneBrowserError ? error.code : "forbidden",
          message: safeMessage(error),
        },
      });
    }
  }

  async #cdpSession(channel: PhoneChannel, actorToken: string): Promise<PhoneCdpSession> {
    const key = `${channel.id}:${actorToken}`;
    let pending = this.#cdp.get(key);
    if (!pending) {
      pending = this.#bounded(channel.epoch, async () => {
        const permit = await this.#native.authorizeCdp({
          epoch: channel.epoch,
          channelId: channel.id,
          actorToken,
        });
        this.#assertEpoch(channel.epoch);
        return new PhoneCdpSession(this.#native, {
          sessionId: channel.session.claims.sessionId,
          epoch: channel.epoch,
          ...permit,
          uuid: this.#uuid,
          tabs: () => [...channel.session.tabs.values()],
          ref: (tab) => this.#ref(tab),
          resume: (tab) => this.#resumeAgent(tab),
          create: (url) => this.#createTab(channel.session, `bsf_${this.#uuid()}`, url),
          close: (tab) => this.#closeTab(channel.session, tab),
          event: (event) => {
            void this.#send(channel, { type: "cdp.event", event }).catch(() => undefined);
          },
          execute: (tab, work, independent) => this.#tabOperation(tab, work, { independent }),
          dialog: (tab, accept, promptText) => {
            if (!tab.dialog) throw new PhoneBrowserError("stale-dialog", "No dialog is open.");
            return this.#dialog(tab, tab.dialog.id, accept, promptText);
          },
        });
      });
      this.#cdp.set(key, pending);
    }
    return pending;
  }

  async #dialog(
    tab: PhoneTab,
    dialogId: string,
    accept: boolean,
    promptText?: string,
  ): Promise<void> {
    const key = `${tab.id}:${tab.metadata.documentId}:${dialogId}`;
    if (tab.dialog?.id !== dialogId || this.#answeredDialogs.has(key))
      throw new PhoneBrowserError("stale-dialog", "The dialog was already answered.");
    this.#answeredDialogs.add(key);
    await this.#bounded(this.#epoch, () =>
      this.#native.respondDialog({
        ...this.#ref(tab),
        dialogId,
        accept,
        ...(promptText === undefined ? {} : { promptText }),
      }),
    );
    tab.dialog = null;
    this.#publishTab(tab);
    this.#dialogEvents(tab);
    await this.#broadcast(this.#requireSession(tab.sessionId), {
      type: "browser.dialog.changed",
      surfaceId: BrowserSurfaceIdSchema.parse(tab.id),
      dialog: null,
    });
  }

  #admitInput(tab: PhoneTab, message: BrowserClientMessage): void {
    if (
      "geometryRevision" in message &&
      message.geometryRevision !== undefined &&
      message.geometryRevision !== tab.metadata.geometryRevision
    )
      throw new PhoneBrowserError("stale-geometry", "The drawn page geometry changed.");
    const contextId =
      "edit" in message
        ? message.edit.contextId
        : "composition" in message
          ? message.composition.contextId
          : undefined;
    if (contextId && contextId !== tab.editingContextId)
      throw new PhoneBrowserError("stale-document", "The editing context changed.");
    if (
      message.producerId &&
      message.inputSequence !== undefined &&
      message.inputGeneration !== undefined
    ) {
      const key = `${tab.id}:${message.producerId}`;
      const previous = this.#inputSequences.get(key);
      if (
        previous &&
        (message.inputGeneration < previous.generation ||
          (message.inputGeneration === previous.generation &&
            (message.inputSequenceStart ?? message.inputSequence) <= previous.sequence))
      )
        throw new PhoneBrowserError("forbidden", "The input lane is retired.");
      this.#inputSequences.set(key, {
        generation: message.inputGeneration,
        sequence: message.inputSequence,
      });
    }
  }

  async #createTab(
    session: PhoneSession,
    id: string,
    url: string,
    viewport = { width: 390, height: 760 },
    navigationId?: string,
  ): Promise<PhoneTab> {
    BrowserSurfaceIdSchema.parse(id);
    if (session.closing)
      throw new PhoneBrowserError("target-closed", "The browser session is closing.");
    if (url !== "about:blank") phoneNavigationUrl(url);
    if (session.closed.has(id) || this.#tabs.has(id) || this.#opening.has(id))
      throw new PhoneBrowserError("target-closed", "The surface ID was already used.");
    if (session.tabs.size >= 64)
      throw new PhoneBrowserError("too-large", "The session has too many tabs.");
    const epoch = this.#epoch;
    this.#opening.add(id);
    const metadata = await this.#bounded(epoch, () =>
      this.#native.createTab({
        epoch,
        tabId: id,
        sessionId: session.claims.sessionId,
        allocationPermit: session.allocationPermit,
        storeHandle: session.storeHandle,
        state: "retained",
        viewport,
        url,
        ...(navigationId ? { navigationId } : {}),
      }),
    ).finally(() => this.#opening.delete(id));
    if (session.closed.has(id) || session.closing) {
      session.closed.add(id);
      await this.#native.destroyTab({
        epoch,
        sessionId: session.claims.sessionId,
        tabId: id,
        generation: metadata.generation,
      });
      throw new PhoneBrowserError("target-closed", "The tab closed while opening.");
    }
    const tab = this.#newTab(session, id, metadata, null);
    await this.#trimRetained();
    return tab;
  }

  #newTab(
    session: PhoneSession,
    id: string,
    metadata: NativeTabMetadata,
    openerId: string | null,
  ): PhoneTab {
    if (!metadata.documentId)
      throw new PhoneBrowserError("stale-document", "A committed document is required.");
    const tab: PhoneTab = {
      id,
      sessionId: session.claims.sessionId,
      order: session.revision,
      openerId,
      metadata,
      state: "retained",
      dialog: null,
      lastUsed: ++this.#lru,
      presentationGeneration: 0,
      editingContextId: null,
    };
    this.#tabs.set(id, tab);
    session.tabs.set(id, tab);
    session.activeId ??= id;
    session.revision++;
    this.#publishTab(tab);
    return tab;
  }

  async #resumeAgent(tab: PhoneTab): Promise<void> {
    if (isLive(tab)) return;
    if (this.#covered && this.#covered !== tab.id)
      throw new PhoneBrowserError("target-suspended", "Another tab owns the covered live slot.");
    this.#covered = tab.id;
    try {
      await this.#makeLive(tab, "live-covered");
    } catch (error) {
      if (isLive(tab)) this.#invalidate("resume-failed");
      else if (this.#covered === tab.id) this.#covered = null;
      throw error;
    }
  }

  async #makeLive(tab: PhoneTab, state: "live-visible" | "live-covered"): Promise<void> {
    const epoch = this.#epoch;
    const metadata = isLive(tab)
      ? tab.metadata
      : await this.#bounded(epoch, () => this.#native.resumeTab(this.#ref(tab)));
    this.#assertEpoch(epoch);
    if (tab.state === "closed")
      throw new PhoneBrowserError("target-closed", "The tab closed while resuming.");
    this.#acceptMetadata(tab, metadata);
    tab.state = state;
    tab.lastUsed = ++this.#lru;
    this.#publishTab(tab);
    const session = this.#requireSession(tab.sessionId);
    for (const channelId of session.channels) {
      const channel = this.#channels.get(channelId);
      if (channel) await this.#capture(channel, tab);
    }
  }

  async #retain(tab: PhoneTab): Promise<void> {
    if (!isLive(tab)) return;
    const reference = this.#ref(tab);
    await this.#native.unmountTab({
      ...reference,
      presentationGeneration: tab.presentationGeneration,
    });
    this.#assertEpoch(reference.epoch);
    await this.#native.suspendTab({ ...reference, state: "retained" });
    this.#assertEpoch(reference.epoch);
    if (this.#sessions.get(tab.sessionId)?.closed.has(tab.id)) return;
    if (this.#visible === tab.id) this.#visible = null;
    if (this.#covered === tab.id) this.#covered = null;
    tab.state = "retained";
    tab.dialog = null;
    tab.lastUsed = ++this.#lru;
    this.#publishTab(tab);
    await this.#trimRetained();
  }

  async #discard(tab: PhoneTab): Promise<void> {
    if (tab.state === "closed" || tab.state === "discarded") return;
    const reference = this.#ref(tab);
    await this.#native.suspendTab({ ...reference, state: "discarded" });
    this.#assertEpoch(reference.epoch);
    if (this.#sessions.get(tab.sessionId)?.closed.has(tab.id)) return;
    tab.state = "discarded";
    tab.dialog = null;
    if (this.#covered === tab.id) this.#covered = null;
    this.#publishTab(tab);
  }

  async #trimRetained(): Promise<void> {
    const retained = [...this.#tabs.values()]
      .filter((tab) => tab.state === "retained")
      .sort((left, right) => left.lastUsed - right.lastUsed);
    for (const tab of retained.slice(0, Math.max(0, retained.length - 4))) await this.#discard(tab);
  }

  async #closeTab(session: PhoneSession, tab: PhoneTab): Promise<void> {
    if (session.closed.has(tab.id)) return;
    session.closed.add(tab.id);
    session.tabs.delete(tab.id);
    session.revision++;
    tab.state = "closed";
    tab.dialog = null;
    if (this.#visible === tab.id) this.#visible = null;
    if (this.#covered === tab.id) this.#covered = null;
    if (session.activeId === tab.id) session.activeId = session.tabs.keys().next().value ?? null;
    if (this.#selected?.admission.surfaceId === tab.id) this.#selected = null;
    this.#publishTab(tab);
    await this.#native.destroyTab(this.#ref(tab));
    await this.#publish(session);
  }

  async #closeChannel(channel: PhoneChannel): Promise<void> {
    this.#channels.delete(channel.id);
    channel.session.channels.delete(channel.id);
    for (const [id, attachment] of this.#attachments)
      if (attachment.channel === channel) this.#attachments.delete(id);
    for (const [key, pending] of this.#cdp)
      if (key.startsWith(`${channel.id}:`)) {
        this.#cdp.delete(key);
        await pending.then((cdp) => cdp.close()).catch(() => undefined);
      }
    await this.#native.closeChannel({ epoch: this.#epoch, channelId: channel.id, code: 1000 });
    if (!channel.session.channels.size) {
      for (const tab of channel.session.tabs.values()) await this.#retain(tab);
      if (channel.session.claims.identity.kind === "fresh") {
        for (const tab of channel.session.tabs.values()) await this.#closeTab(channel.session, tab);
        await this.#native.finishSessionFiles({
          epoch: this.#epoch,
          sessionId: channel.session.claims.sessionId,
        });
        this.#sessions.delete(channel.session.claims.sessionId);
      }
    }
  }

  async #endSession(session: PhoneSession): Promise<void> {
    if (session.closing) return;
    session.closing = true;
    await this.#broadcast(session, { type: "browser.status", state: "closing" });
    for (const tab of session.tabs.values()) await this.#closeTab(session, tab);
    await this.#broadcast(session, { type: "browser.status", state: "closed" });
    for (const id of session.channels) {
      const channel = this.#channels.get(id);
      if (channel) await this.#closeChannel(channel);
    }
    await this.#native.finishSessionFiles({
      epoch: this.#epoch,
      sessionId: session.claims.sessionId,
    });
    this.#sessions.delete(session.claims.sessionId);
  }

  async #capture(channel: PhoneChannel, tab: PhoneTab): Promise<void> {
    const demand = channel.subscriptions.get(tab.id);
    await this.#native.setCaptureDemand({
      ...this.#ref(tab),
      channelId: channel.id,
      density: demand?.density ?? 1,
      frames: Boolean(demand?.frames && isLive(tab)),
      maxFps: 8,
      ...(demand?.frameWindow ? { frameWindow: demand.frameWindow } : {}),
    });
  }

  #acceptMetadata(tab: PhoneTab, metadata: NativeTabMetadata): boolean {
    if (tab.state === "closed") return false;
    if (
      metadata.generation < tab.metadata.generation ||
      (metadata.generation === tab.metadata.generation &&
        (metadata.revision < tab.metadata.revision ||
          metadata.geometryRevision < tab.metadata.geometryRevision))
    )
      return false;
    if (metadata.documentId !== tab.metadata.documentId) {
      tab.dialog = null;
      tab.editingContextId = null;
    }
    tab.metadata = metadata;
    return true;
  }

  #publishTab(tab: PhoneTab): void {
    this.#presentations.set(tab.id, {
      surfaceId: tab.id,
      nativeGeneration: tab.metadata.generation,
      state: tab.state,
      live: isLive(tab),
      mount: tab.state === "live-visible",
      title: tab.metadata.title,
      url: tab.metadata.url,
      loading: tab.metadata.loading,
      navigationFailed: tab.metadata.navigationFailed,
      canGoBack: tab.metadata.canGoBack,
      canGoForward: tab.metadata.canGoForward,
      documentId: tab.metadata.documentId,
      geometryRevision: tab.metadata.geometryRevision,
      dialog: tab.dialog,
    });
    for (const listener of this.#listeners.get(tab.id) ?? []) listener();
    for (const [attachmentId, attachment] of this.#attachments) {
      if (attachment.channel.session.claims.sessionId !== tab.sessionId) continue;
      void this.#send(attachment.channel, {
        type: "agent.event",
        attachmentId,
        event:
          tab.state === "closed"
            ? { type: "surface.closed", surfaceId: BrowserSurfaceIdSchema.parse(tab.id) }
            : { type: "surface.changed", binding: actionBinding(tab) },
      }).catch(() => undefined);
    }
    for (const pending of this.#cdp.values())
      void pending.then((cdp) => cdp.surfaceChanged(tab)).catch(() => undefined);
  }

  #dialogEvents(tab: PhoneTab): void {
    for (const [attachmentId, attachment] of this.#attachments) {
      if (attachment.channel.session.claims.sessionId !== tab.sessionId) continue;
      void this.#send(attachment.channel, {
        type: "agent.event",
        attachmentId,
        event: {
          type: "dialog.changed",
          surfaceId: BrowserSurfaceIdSchema.parse(tab.id),
          dialog: tab.dialog,
        },
      }).catch(() => undefined);
    }
  }

  #surfaces(session: PhoneSession): BrowserSurface[] {
    return [...session.tabs.values()].map((tab) => ({
      id: BrowserSurfaceIdSchema.parse(tab.id),
      active: session.activeId === tab.id,
      title: tab.metadata.title,
      url: tab.metadata.url,
      documentId: tab.metadata.documentId,
      geometryRevision: tab.metadata.geometryRevision,
      loading: tab.metadata.loading,
      navigationFailed: tab.metadata.navigationFailed,
      canGoBack: tab.metadata.canGoBack,
      canGoForward: tab.metadata.canGoForward,
      order: tab.order,
      openerId: tab.openerId ? BrowserSurfaceIdSchema.parse(tab.openerId) : null,
      state: isLive(tab) ? "live" : "suspended",
    }));
  }

  async #publish(session: PhoneSession): Promise<void> {
    await this.#broadcast(session, {
      type: "browser.surfaces.changed",
      surfaces: this.#surfaces(session),
      inventoryRevision: session.revision,
    });
    await this.#broadcast(session, {
      type: "browser.workspace-tabs",
      tabs: [...session.tabs.values()].map((tab) => ({
        id: BrowserSurfaceIdSchema.parse(tab.id),
        title: tab.metadata.title.slice(0, 256),
        url: tab.metadata.url,
        order: tab.order,
        openerId: tab.openerId ? BrowserSurfaceIdSchema.parse(tab.openerId) : null,
      })),
      closed: [...session.closed].slice(-64).map((id) => BrowserSurfaceIdSchema.parse(id)),
    });
  }

  async #broadcast(session: PhoneSession, message: BrowserServerMessage): Promise<void> {
    for (const id of session.channels) {
      const channel = this.#channels.get(id);
      if (channel) await this.#send(channel, message);
    }
  }

  async #send(channel: PhoneChannel, message: BrowserServerMessage): Promise<void> {
    if (message.type === "browser.workspace-tabs" && !channel.claims.workspaceTabRestoreVersion)
      return;
    if (message.type === "browser.editing" && !channel.claims.basicInput) return;
    if (
      channel.epoch !== this.#epoch ||
      this.#channels.get(channel.id) !== channel ||
      !this.#connection
    )
      return;
    if (message.type === "browser.snapshot" || message.type === "browser.surfaces.changed") {
      message = {
        ...message,
        surfaces: message.surfaces.map((surface) => {
          const { state, ...baseline } = surface;
          return channel.claims.surfaceState
            ? { ...baseline, ...(state ? { state } : {}) }
            : baseline;
        }),
      };
    }
    if (message.type === "clipboard.result")
      this.#clipboard.delete(`${channel.id}:${message.operationId}`);
    await this.#sendRelay({
      ...this.#connection.fence,
      type: "browser.server-message",
      channelId: channel.id,
      capability: channel.capability,
      message: BrowserServerMessageSchema.parse(message),
    });
  }

  async #sendRelay(message: BrowserRelayToHostMessage): Promise<void> {
    await this.#native.sendRelay({
      epoch: this.#epoch,
      message: BrowserRelayToHostMessageSchema.parse(message),
    });
  }

  async #readProfiles(epoch: number): Promise<void> {
    const profiles = await this.#bounded(epoch, () =>
      this.#native.listProfiles({ epoch, deploymentId: this.#deploymentId }),
    );
    this.#profiles.clear();
    for (const profile of profiles) {
      this.#assertBinding(profile.binding);
      this.#profiles.set(profile.binding.bindingId, profile);
    }
  }

  async #inventory(): Promise<void> {
    if (!this.#connection || !this.#qualification || !this.descriptor) return;
    await this.#readProfiles(this.#epoch);
    await this.#sendRelay({
      ...this.#connection.fence,
      module: "browser",
      type: "browser.profile.inventory",
      storageInstanceId: this.#qualification.storageInstanceId,
      engine: this.#qualification.platform === "ios" ? "wkwebview" : "android-webview",
      complete: true,
      profiles: [...this.#profiles.values()],
    });
  }

  #assertBinding(binding: LocalProfileBinding): void {
    if (
      binding.deploymentId !== this.#deploymentId ||
      binding.runnerId !== this.#runnerId ||
      binding.storageInstanceId !== this.#qualification?.storageInstanceId ||
      binding.engine !== (this.#qualification.platform === "ios" ? "wkwebview" : "android-webview")
    )
      throw new PhoneBrowserError("forbidden", "The profile belongs to another device.");
  }

  #sameCapability(
    left: BrowserCapabilityReference,
    right: BrowserCapabilityReference | null,
  ): boolean {
    return (
      right !== null &&
      left.runtimeId === right.runtimeId &&
      left.capabilityLeaseId === right.capabilityLeaseId &&
      left.capabilityGeneration === right.capabilityGeneration
    );
  }

  #assertCapability(capability: BrowserCapabilityReference): void {
    if (
      !this.#sameCapability(capability, this.#capability) ||
      Date.parse(this.#capability!.expiresAt) <= this.#clock.now()
    )
      throw new PhoneBrowserError("forbidden", "The capability lease expired or was replaced.");
  }

  #requireSession(id: string): PhoneSession {
    const session = this.#sessions.get(id);
    if (!session) throw new PhoneBrowserError("target-closed", "The browser session is closed.");
    return session;
  }

  #requireChannel(id: string): PhoneChannel {
    const channel = this.#channels.get(id);
    if (!channel) throw new PhoneBrowserError("forbidden", "The browser channel is closed.");
    return channel;
  }

  #requireTab(session: PhoneSession, id: unknown): PhoneTab {
    const tab = typeof id === "string" ? session.tabs.get(id) : undefined;
    if (!tab || tab.state === "closed")
      throw new PhoneBrowserError("target-closed", "The browser tab is closed.");
    return tab;
  }

  #ref(tab: PhoneTab): NativeDocumentRef {
    return {
      epoch: this.#epoch,
      sessionId: tab.sessionId,
      tabId: tab.id,
      generation: tab.metadata.generation,
      documentId: tab.metadata.documentId,
      geometryRevision: tab.metadata.geometryRevision,
    };
  }

  #assertLive(tab: PhoneTab): void {
    if (!isLive(tab))
      throw new PhoneBrowserError("target-suspended", "The browser tab is suspended.");
  }

  #assertEpoch(epoch: number): void {
    if (epoch !== this.#epoch || this.#disposed)
      throw new PhoneBrowserError("forbidden", "The native epoch was retired.");
  }

  async #tabOperation<Result>(
    tab: PhoneTab,
    operation: () => Promise<Result>,
    options: { independent?: boolean; timeout?: number } = {},
  ): Promise<Result> {
    const epoch = this.#epoch;
    const ref = this.#ref(tab);
    let admitted = true;
    let submitted = false;
    const execute = () => {
      if (!admitted) throw new PhoneBrowserError("timeout", "The queued operation expired.");
      this.#assertEpoch(epoch);
      this.#assertLive(tab);
      if (tab.metadata.documentId !== ref.documentId)
        throw new PhoneBrowserError("stale-document", "The document changed in the input lane.");
      if (tab.metadata.geometryRevision !== ref.geometryRevision)
        throw new PhoneBrowserError("stale-geometry", "The geometry changed in the input lane.");
      submitted = true;
      return operation();
    };
    const work = options.independent
      ? Promise.resolve().then(execute)
      : (this.#lanes.get(tab.id) ?? Promise.resolve()).catch(() => undefined).then(execute);
    if (!options.independent) this.#lanes.set(tab.id, work);
    try {
      return await this.#bounded(
        epoch,
        () => work,
        options.timeout,
        () => submitted && !options.independent,
      );
    } finally {
      admitted = false;
    }
  }

  async #bounded<Result>(
    epoch: number,
    work: () => Promise<Result>,
    timeout = 20_000,
    write: boolean | (() => boolean) = false,
  ): Promise<Result> {
    this.#assertEpoch(epoch);
    const signal = this.#abort.signal;
    let cancelTimer = () => {};
    let abort = () => {};
    const unknownOutcome = () => (typeof write === "function" ? write() : write);
    const interruption = new Promise<never>((_resolve, reject) => {
      abort = () =>
        reject(
          !unknownOutcome() && signal.reason instanceof PhoneBrowserError
            ? signal.reason
            : new PhoneBrowserError(
                unknownOutcome() ? "outcome-unknown" : "forbidden",
                "The browser operation was fenced.",
              ),
        );
      signal.addEventListener("abort", abort, { once: true });
      cancelTimer = this.#clock.schedule(this.#clock.now() + timeout, () =>
        reject(
          new PhoneBrowserError(
            unknownOutcome() ? "outcome-unknown" : "timeout",
            "The browser operation exceeded its deadline.",
          ),
        ),
      );
    });
    try {
      const result = await Promise.race([Promise.resolve().then(work), interruption]);
      this.#assertEpoch(epoch);
      return result;
    } finally {
      cancelTimer();
      signal.removeEventListener("abort", abort);
    }
  }

  #armLease(): void {
    this.#cancelLease?.();
    const deadline = Math.min(
      this.#connection?.deadline ?? Infinity,
      this.#capability ? Date.parse(this.#capability.expiresAt) : Infinity,
    );
    if (Number.isFinite(deadline))
      this.#cancelLease = this.#clock.schedule(deadline, () => {
        if (this.#connection) this.#retiredConnections.add(connectionKey(this.#connection.fence));
        this.#invalidate("lease-expired");
        this.#connection = null;
      });
  }

  #invalidate(reason: string, cause?: unknown): void {
    this.#epoch = this.#native.fence(reason);
    this.#abort.abort(cause);
    this.#abort = new AbortController();
    this.#cancelLease?.();
    this.#cancelLease = null;
    this.#capability = null;
    this.#channels.clear();
    this.#sessionStarts.clear();
    this.#attachments.clear();
    this.#actionRequests.clear();
    this.#opening.clear();
    this.#clipboard.clear();
    this.#inputSequences.clear();
    this.#lanes.clear();
    this.#cdp.clear();
    this.#visible = null;
    this.#covered = null;
    for (const session of this.#sessions.values()) session.channels.clear();
    for (const tab of this.#tabs.values()) {
      if (isLive(tab)) tab.state = "retained";
      tab.dialog = null;
      this.#publishTab(tab);
    }
  }
}

function capabilityReference(lease: BrowserCapabilityLease): BrowserCapabilityReference {
  return {
    runtimeId: lease.runtimeId,
    capabilityLeaseId: lease.capabilityLeaseId,
    capabilityGeneration: lease.capabilityGeneration,
  };
}

function connectionKey(fence: RunnerAuxiliaryFrameFence): string {
  return [
    fence.runnerId,
    fence.bootId,
    fence.connectionId,
    fence.connectionGeneration,
    fence.connectionLeaseId,
    fence.auxiliaryStreamId,
    fence.module,
  ].join(":");
}

function actionBinding(tab: PhoneTab): z.infer<typeof BrowserActionBindingSchema> {
  return {
    surfaceId: BrowserSurfaceIdSchema.parse(tab.id),
    documentId: tab.metadata.documentId,
    geometryRevision: tab.metadata.geometryRevision,
    state: isLive(tab) ? "live" : "suspended",
    title: tab.metadata.title,
    url: tab.metadata.url,
  };
}

function safeMessage(error: unknown): string {
  return error instanceof PhoneBrowserError
    ? error.message.slice(0, 1000)
    : "The browser operation was refused.";
}

function phoneNavigationUrl(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password)
    throw new PhoneBrowserError(
      "unsupported-operation",
      "Navigation requires HTTP(S) without credentials.",
    );
  return value;
}

function protocolError(error: unknown): ProtocolError {
  const code =
    error instanceof SessionCdpRouterError
      ? error.code === "bad_command" || error.code === "too_large"
        ? "bad_message"
        : error.code
      : error instanceof PhoneBrowserError && error.code === "forbidden"
        ? "forbidden"
        : error instanceof PhoneBrowserError && error.code === "target-closed"
          ? "not_found"
          : "conflict";
  return {
    code,
    reason: error instanceof PhoneBrowserError ? error.code : "unsupported-operation",
    message: safeMessage(error),
    retryable: false,
  };
}
