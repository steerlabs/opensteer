import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { OpensteerError, type RunnerId } from "@opensteer/core";
import type { RunnerAuxiliaryStream } from "@opensteer/orchestration";
import {
  RunnerAuxiliaryFrameFenceSchema,
  RunnerAuxiliaryRequestIdSchema,
  sameRunnerAuxiliaryFence,
  type BrowserPlacementSelector,
  type RunnerAuxiliaryFrameFence,
  type RunnerAuxiliaryRequestId,
} from "@opensteer/protocol";
import {
  BrowserCapabilityLeaseIdSchema,
  BrowserCapabilityReferenceSchema,
  createBrowserRelayToHostMessageSchema,
  createHostToBrowserRelayMessageSchema,
  BrowserChannelIdSchema,
  sameBrowserCapability,
  type BrowserCapabilityLease,
  type BrowserCapabilityReference,
  type BrowserChannelId,
  type BrowserRelayFrameHeader,
} from "@opensteer/protocol/browser-relay";
import { sameProfileBinding } from "@opensteer/database";
import type { BrowserLocalProfiles } from "./browser-local-profiles.js";
import { BrowserAttachTicketClaimsSchema, type InitialPageReady } from "@opensteer/protocol";
import { readBrowserFrameHeader } from "@opensteer/protocol/browser";
import WebSocket, { type RawData } from "ws";
import { z } from "zod";
import type {
  BrowserRuntimeConnection,
  BrowserRuntimePlacement,
  BrowserRuntimeTarget,
  BrowserRuntimeTargetResolver,
} from "./browser-service.js";
import type {
  BrowserRelayEvent,
  RunnerBrowserHooks,
  RunnerBrowserRegistry,
} from "./runner-browser-hub.js";
import { browserSnapshotCompatibilityReason } from "./browser-snapshot-compatibility.js";

// The broker validates browser payloads after capability-specific translation;
// the relay validates only the channel, capability and stream fences here.
const browserChannelEnvelope = {
  ...RunnerAuxiliaryFrameFenceSchema.shape,
  capability: BrowserCapabilityReferenceSchema,
  channelId: BrowserChannelIdSchema,
  message: z.unknown(),
};
export const HostToBrowserRuntimeRelayMessageSchema = z.union([
  z.strictObject({ ...browserChannelEnvelope, type: z.literal("browser.client-message") }),
  createHostToBrowserRelayMessageSchema({
    localProfiles: 1,
    profilePrepare: 1,
    initialNavigationVersion: 1,
  }),
]);
export const BrowserRuntimeRelayToHostMessageSchema = z.union([
  z.strictObject({ ...browserChannelEnvelope, type: z.literal("browser.server-message") }),
  createBrowserRelayToHostMessageSchema({
    localProfiles: 1,
    profilePrepare: 1,
    initialNavigationVersion: 1,
  }),
]);
export type BrowserRuntimeRelayRequest = Extract<
  z.infer<typeof HostToBrowserRuntimeRelayMessageSchema>,
  { readonly auxiliaryStreamId: unknown }
>;
export type BrowserRuntimeRelayEvent = Exclude<
  z.infer<typeof BrowserRuntimeRelayToHostMessageSchema>,
  { readonly type: "runner.auxiliary.heartbeat" }
>;

const requestTimeoutMs = 5_000;
const maxPendingRequests = 64;
const maxQueuedControlBytes = 2 * 1_024 * 1_024;
const maxQueuedControlItems = 256;
const maxChannelsPerRunnerRuntime = 32;
const maxQueuedFrameBytes = 32 * 1_024 * 1_024;
const maxQueuedFrameSurfaces = 128;

interface PendingRequest {
  readonly capability: BrowserCapabilityReference | undefined;
  readonly channelId: BrowserChannelId | undefined;
  readonly fence: RunnerAuxiliaryFrameFence;
  readonly runnerId: RunnerId;
  readonly expectedType:
    | "browser.profile.prepared"
    | "browser.attached"
    | "browser.closed"
    | "capability.accepted"
    | "capability.revoked"
    | "browser.profile.delete.result";
  readonly reject: (error: unknown) => void;
  readonly resolve: (message: BrowserRelayEvent) => void;
  readonly timer: NodeJS.Timeout;
}

interface PlacementCapabilityLease {
  capability: BrowserCapabilityReference;
  readonly channels: Set<BrowserChannelId>;
  maintenanceCount: number;
  readonly runnerId: RunnerId;
  expiresAt: string;
  readonly fence: RunnerAuxiliaryFrameFence;
  readonly placementKey: string;
  pendingCapability: BrowserCapabilityReference | undefined;
  released: boolean;
  renewal: Promise<void> | undefined;
  renewalTimer: NodeJS.Timeout | undefined;
  readonly runtimeId: string;
}

interface RoutedChannel {
  readonly preparation: boolean;
  readonly channelId: BrowserChannelId;
  readonly connection: RunnerBrowserConnection;
  lastSequence: number;
  readonly placementLease: PlacementCapabilityLease;
}

interface RunnerBrowserRuntimeRouterOptions {
  readonly now?: () => number;
  readonly registry: RunnerBrowserRegistry;
  readonly requestTimeoutMs?: number;
  readonly localProfiles?: Pick<
    BrowserLocalProfiles,
    "reconcileInventory" | "jobs" | "acknowledgeDeletion"
  >;
  readonly onDeletionsChanged?: (runnerId: RunnerId) => Promise<void>;
}

/**
 * Carries Browser Sessions over one Runner's browser-module stream.
 *
 * It is deliberately not a TCP or CDP tunnel: every attach, close, frame and
 * capability grant is a named message fenced to the exact auxiliary stream it
 * belongs to, so a Runner that reconnects cannot keep serving a session the
 * Host has already given up on.
 */
export class RunnerBrowserRuntimeRouter implements BrowserRuntimeTargetResolver {
  readonly #channels = new Map<BrowserChannelId, RoutedChannel>();
  readonly #generationByPlacement = new Map<string, number>();
  readonly #leaseByPlacement = new Map<string, PlacementCapabilityLease>();
  readonly #leaseAcquisitions = new Map<string, Promise<PlacementCapabilityLease>>();
  readonly #erasures = new Map<RunnerId, { pending: boolean; operation: Promise<void> }>();
  readonly #now: () => number;
  readonly #pending = new Map<RunnerAuxiliaryRequestId, PendingRequest>();
  readonly #registry: RunnerBrowserRegistry;
  readonly #requestTimeoutMs: number;
  readonly #unsubscribe: () => void;
  #closed = false;
  readonly #inventory = new Map<
    RunnerId,
    { fence: RunnerAuxiliaryFrameFence; complete: boolean; failed: boolean; profiles: Set<string> }
  >();
  readonly #localProfiles: RunnerBrowserRuntimeRouterOptions["localProfiles"];
  readonly #onDeletionsChanged: RunnerBrowserRuntimeRouterOptions["onDeletionsChanged"];

  constructor(options: RunnerBrowserRuntimeRouterOptions) {
    this.#localProfiles = options.localProfiles;
    this.#onDeletionsChanged = options.onDeletionsChanged;
    this.#now = options.now ?? Date.now;
    this.#registry = options.registry;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? requestTimeoutMs;
    const hooks: RunnerBrowserHooks = {
      onFrame: (stream, frame) => this.#handleFrame(stream, frame.header, frame.frame),
      onLost: (stream) => this.#handleDisconnect(stream),
      onMessage: (stream, message) => this.#handleMessage(stream, message),
    };
    this.#unsubscribe = this.#registry.subscribe(hooks);
  }

  placements(): readonly BrowserRuntimePlacement[] {
    if (this.#closed) return [];
    return this.#registry.browserStreams().flatMap((stream): BrowserRuntimePlacement[] => {
      const browser = stream.identity.modules.browser;
      if (!browser) return [];
      const incompatibility = this.#admissionReason(stream);
      return [
        {
          available: incompatibility === null,
          environmentIds: [...stream.identity.environmentIds],
          kind: "runner" as const,
          label: stream.identity.name,
          runnerId: stream.identity.runnerId,
          runtimeId: browser.runtimeId,
          ...(incompatibility === null ? {} : { unavailableReason: incompatibility }),
        },
      ];
    });
  }

  resolve(placement: BrowserPlacementSelector): BrowserRuntimeTarget | undefined {
    if (this.#closed) return undefined;
    const stream = this.#registry.stream(placement.runnerId);
    const browser = stream?.identity.modules.browser;
    if (!stream || !browser) return undefined;
    const incompatibility = this.#admissionReason(stream);
    if (incompatibility !== null) {
      throw new OpensteerError({
        code: "workspace_unavailable",
        message: incompatibility,
      });
    }
    const expectedFence = stream.fence;
    const placementKey = runnerPlacementKey(placement.runnerId, browser.runtimeId);
    return {
      placementKey,
      main: stream.identity.runnerKind === "main",
      ...(browser.localProfiles === 1 && browser.localProfileStorage
        ? { localProfileStorage: browser.localProfileStorage }
        : {}),
      initialNavigationVersion: browser.initialNavigationVersion === 1,
      ...(browser.localProfiles === 1 &&
      browser.profilePrepare === 1 &&
      browser.profilePrepareInstanceId
        ? {
            profilePrepare: true,
            incarnation: browser.profilePrepareInstanceId,
            prepareProfile: (ticket: string) => {
              const connection = new RunnerBrowserConnection(this);
              queueMicrotask(() => {
                void this.#open(
                  connection,
                  placement.runnerId,
                  browser.runtimeId,
                  expectedFence,
                  ticket,
                  true,
                );
              });
              return connection;
            },
          }
        : {}),
      runtimeId: browser.runtimeId,
      stateImport: browser.stateImport === true,
      fileStaging: browser.fileStaging === true,
      signIn: browser.signIn?.version === 3,
      cdpBoundary: browser.cdpBoundary === 1,
      sharedControl: browser.sharedControl === 1,
      passkeys: browser.passkeys === 1,
      editing: browser.editing,
      clipboard: browser.editing === 1 || browser.clipboard === true,
      targetControl: browser.targetControl === 1,
      navigationVersion: browser.navigationVersion === 1,
      workspaceTabRestoreVersion: browser.workspaceTabRestoreVersion === 1,
      captureRegion: browser.captureRegion === 1,
      rasterDemand: browser.rasterDemand === 1,
      computer: { name: stream.identity.name, runnerId: placement.runnerId },
      connect: (ticket) => {
        const connection = new RunnerBrowserConnection(this);
        queueMicrotask(() => {
          void this.#open(connection, placement.runnerId, browser.runtimeId, expectedFence, ticket);
        });
        return connection;
      },
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    const error = new Error("The browser relay router is closed.");
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const channel of this.#channels.values()) {
      this.#dropChannel(channel, 1001, "Host browser router shutting down");
    }
  }

  async send(connection: RunnerBrowserConnection, message: unknown): Promise<void> {
    const channel = this.#channelForConnection(connection);
    if (channel.placementLease.renewal) await channel.placementLease.renewal;
    this.#assertCurrentConnection(channel);
    await this.#registry.send(channel.placementLease.runnerId, {
      ...channel.placementLease.fence,
      capability: channel.placementLease.capability,
      channelId: channel.channelId,
      message,
      type: "browser.client-message",
    });
  }

  closeConnection(connection: RunnerBrowserConnection, code: number, reason: string): void {
    const channel = [...this.#channels.values()].find((entry) => entry.connection === connection);
    if (!channel) {
      connection.acceptClose(code, reason);
      return;
    }
    void this.#closeChannel(channel, code, reason).catch((error: unknown) => {
      connection.acceptError(normalizeError(error));
      this.#dropChannel(channel, 1011, "Browser relay close failed");
    });
  }

  terminateConnection(connection: RunnerBrowserConnection): void {
    const channel = [...this.#channels.values()].find((entry) => entry.connection === connection);
    if (!channel) {
      connection.acceptClose(1006, "Browser relay connection terminated");
      return;
    }
    this.#dropChannel(channel, 1006, "Browser relay connection terminated");
    void this.#bestEffortCloseAndRevoke(channel);
  }

  async #open(
    connection: RunnerBrowserConnection,
    runnerId: RunnerId,
    runtimeId: string,
    expectedFence: RunnerAuxiliaryFrameFence,
    ticket: string,
    preparation = false,
  ): Promise<void> {
    let placementLease: PlacementCapabilityLease | undefined;
    let channel: RoutedChannel | undefined;
    try {
      if (this.#closed) throw new Error("The browser relay router is closed.");
      const stream = this.#requireExpectedStream(runnerId, expectedFence);
      if (
        preparation &&
        (stream.identity.modules.browser?.profilePrepare !== 1 ||
          stream.identity.modules.browser?.localProfiles !== 1)
      )
        throw relayError("Profile preparation was not negotiated.");
      const reason = this.#admissionReason(stream);
      if (reason) throw relayError(reason);
      placementLease = await this.#acquirePlacementLease(stream, runtimeId);
      if (placementLease.channels.size >= maxChannelsPerRunnerRuntime)
        throw relayError("That computer's Browser Runtime session limit is full.");
      const activePlacementLease = placementLease;
      if (!activePlacementLease) {
        throw relayError("The browser capability lease is unavailable.");
      }
      if (connection.readyState !== WebSocket.CONNECTING) {
        await this.#releasePlacementLease(activePlacementLease).catch(() => undefined);
        connection.acceptClose(1000, "Browser attach cancelled");
        return;
      }
      const channelId = BrowserChannelIdSchema.parse(`bch_${randomUUID()}`);
      const routedChannel: RoutedChannel = {
        preparation,
        channelId,
        connection,
        lastSequence: -1,
        placementLease: activePlacementLease,
      };
      channel = routedChannel;
      this.#channels.set(channelId, routedChannel);
      activePlacementLease.channels.add(channelId);
      if (preparation) activePlacementLease.maintenanceCount++;
      const attached = await this.#request(runnerId, stream.fence, {
        capability: activePlacementLease.capability,
        channelId,
        expectedType: preparation ? "browser.profile.prepared" : "browser.attached",
        // Negotiated readiness includes conversion and engine startup, rather
        // than just the old loopback WebSocket upgrade. Use the broker's startup budget.
        timeoutMs:
          stream.identity.modules.browser?.localProfiles === 1 ||
          stream.identity.modules.browser?.initialNavigationVersion === 1
            ? 30_000
            : undefined,
        message: {
          ...stream.fence,
          ...(preparation ? { preparationTicket: ticket } : { attachTicket: ticket }),
          capability: activePlacementLease.capability,
          channelId,
          type: preparation ? "browser.profile.prepare" : "browser.attach",
        },
      });
      if (connection.readyState !== WebSocket.CONNECTING) {
        await this.#bestEffortCloseAndRevoke(routedChannel);
        this.#dropChannel(routedChannel, 1000, "Browser attach cancelled");
        return;
      }
      const browser = stream.identity.modules.browser;
      const claims =
        !preparation && browser?.initialNavigationVersion === 1
          ? BrowserAttachTicketClaimsSchema.parse(
              JSON.parse(Buffer.from(ticket.split(".")[1]!, "base64url").toString("utf8")),
            )
          : undefined;
      if (attached.type !== "browser.attached" && attached.type !== "browser.profile.prepared")
        throw relayError("The browser did not acknowledge attachment.");
      const initialPage = attached.type === "browser.attached" ? attached.initialPage : undefined;
      if (claims?.initialNavigationVersion === 1) {
        if (
          !initialPage ||
          initialPage.operationKey !== claims.initialNavigation?.operationKey ||
          initialPage.navigation !== (claims.initialNavigation?.url ? "submitted" : "blank")
        )
          throw relayError("The browser returned mismatched initial page readiness.");
      } else if (initialPage)
        throw relayError("The browser sent unnegotiated initial page readiness.");
      connection.initialPage = initialPage;
      connection.acceptOpen();
      if (attached.type === "browser.profile.prepared" && !attached.retained) {
        await this.#bestEffortCloseAndRevoke(routedChannel);
        this.#dropChannel(routedChannel, 1000, "Profile preparation skipped");
        return;
      }
      if (!activePlacementLease.renewalTimer && !activePlacementLease.renewal) {
        this.#scheduleRenewal(activePlacementLease, activePlacementLease.expiresAt);
      }
    } catch (error) {
      connection.acceptError(normalizeError(error));
      if (channel) {
        this.#dropChannel(channel, 1011, "Browser Runtime attach failed");
        await this.#bestEffortCloseAndRevoke(channel);
      }
      if (placementLease) await this.#releasePlacementLease(placementLease).catch(() => undefined);
      connection.acceptClose(1011, "Browser Runtime attach failed");
    } finally {
      if (placementLease) {
        placementLease.maintenanceCount--;
        await this.#releasePlacementLease(placementLease).catch(() => undefined);
      }
    }
  }

  async #acquirePlacementLease(
    stream: RunnerAuxiliaryStream,
    runtimeId: string,
  ): Promise<PlacementCapabilityLease> {
    const placementKey = runnerPlacementKey(stream.identity.runnerId, runtimeId);
    const current = this.#leaseByPlacement.get(placementKey);
    if (current && !current.released) {
      this.#assertCurrentPlacementLease(current);
      current.maintenanceCount++;
      return current;
    }
    const acquiring = this.#leaseAcquisitions.get(placementKey);
    if (acquiring) {
      const acquired = await acquiring;
      this.#assertCurrentPlacementLease(acquired);
      acquired.maintenanceCount++;
      return acquired;
    }
    const operation = (async () => {
      const lease = this.#newCapabilityLease(stream, runtimeId);
      const capability = capabilityReference(lease);
      await this.#request(stream.identity.runnerId, stream.fence, {
        capability,
        expectedType: "capability.accepted",
        message: { ...stream.fence, lease, type: "capability.grant" },
      });
      const placementLease: PlacementCapabilityLease = {
        capability,
        channels: new Set(),
        maintenanceCount: 0,
        runnerId: stream.identity.runnerId,
        expiresAt: lease.expiresAt,
        fence: stream.fence,
        pendingCapability: undefined,
        placementKey,
        released: false,
        renewal: undefined,
        renewalTimer: undefined,
        runtimeId,
      };
      this.#assertCurrentPlacementLease(placementLease);
      this.#leaseByPlacement.set(placementKey, placementLease);
      return placementLease;
    })();
    this.#leaseAcquisitions.set(placementKey, operation);
    try {
      const acquired = await operation;
      acquired.maintenanceCount++;
      return acquired;
    } finally {
      if (this.#leaseAcquisitions.get(placementKey) === operation)
        this.#leaseAcquisitions.delete(placementKey);
    }
  }

  #admissionReason(stream: RunnerAuxiliaryStream): string | null {
    const browser = stream.identity.modules.browser;
    if (browser?.localProfiles === 1) {
      const inventory = this.#inventory.get(stream.identity.runnerId);
      if (
        !this.#localProfiles ||
        !inventory ||
        !sameRunnerAuxiliaryFence(inventory.fence, stream.fence) ||
        !inventory.complete ||
        inventory.failed
      )
        return "Waiting for this computer to reconcile its browser profile storage.";
    }
    return browserSnapshotCompatibilityReason(browser?.profileSnapshotVersion);
  }

  requirePersonalProfileInventory(): void {
    const main = this.#registry
      .browserStreams()
      .find((stream) => stream.identity.runnerKind === "main");
    if (
      !main ||
      (main.identity.modules.browser?.localProfiles === 1 && this.#admissionReason(main))
    )
      throw relayError(
        "Waiting for this Main computer to reconcile its browser profile storage.",
        true,
      );
  }

  resumeDeletions(runnerId: RunnerId): Promise<void> {
    const active = this.#erasures.get(runnerId);
    if (active) {
      active.pending = true;
      return active.operation;
    }
    const lane = { pending: true, operation: Promise.resolve() };
    this.#erasures.set(runnerId, lane);
    lane.operation = Promise.resolve().then(async () => {
      let fence: RunnerAuxiliaryFrameFence | undefined;
      const attempted = new Set<string>();
      let failure: { error: unknown } | undefined;
      try {
        do {
          lane.pending = false;
          const stream = this.#registry.stream(runnerId);
          if (!stream || this.#closed) break;
          if (!fence || !sameRunnerAuxiliaryFence(fence, stream.fence)) attempted.clear();
          fence = stream.fence;
          try {
            await this.#eraseProfiles(stream, attempted);
          } catch (error) {
            failure = { error };
          }
        } while (lane.pending);
        if (failure) throw failure.error;
      } finally {
        this.#erasures.delete(runnerId);
      }
    });
    return lane.operation;
  }

  async #eraseProfiles(stream: RunnerAuxiliaryStream, attempted: Set<string>): Promise<void> {
    const runnerId = stream.identity.runnerId;
    if (!this.#localProfiles || this.#admissionReason(stream)) return;
    const browser = stream.identity.modules.browser;
    if (browser?.localProfiles !== 1 || !browser.localProfileStorage) return;
    for (const job of await this.#localProfiles.jobs(runnerId)) {
      if (
        attempted.has(job.deletionId) ||
        job.binding.storageInstanceId !== browser.localProfileStorage.storageInstanceId ||
        job.binding.engine !== browser.localProfileStorage.engine
      )
        continue;
      // A rerun picks up new jobs without retrying pending-restart acknowledgements.
      attempted.add(job.deletionId);
      const placementLease = await this.#acquirePlacementLease(stream, browser.runtimeId);
      if (placementLease.renewal) await placementLease.renewal;
      const capability = placementLease.capability;
      try {
        const result = await this.#request(runnerId, stream.fence, {
          capability,
          expectedType: "browser.profile.delete.result",
          message: {
            ...stream.fence,
            capability,
            binding: job.binding,
            deletionId: job.deletionId,
            type: "browser.profile.delete",
          },
        });
        if (
          result.type !== "browser.profile.delete.result" ||
          result.deletionId !== job.deletionId ||
          !sameProfileBinding(result.binding, job.binding)
        )
          throw relayError("The browser returned mismatched profile erasure readiness.");
        await this.#localProfiles.acknowledgeDeletion({
          binding: job.binding,
          deletionId: job.deletionId,
          state: result.state,
        });
        await this.#onDeletionsChanged?.(runnerId);
      } finally {
        placementLease.maintenanceCount--;
        await this.#releasePlacementLease(placementLease).catch(() => undefined);
      }
    }
  }

  async #handleMessage(stream: RunnerAuxiliaryStream, message: BrowserRelayEvent): Promise<void> {
    if (message.type === "browser.profile.inventory") {
      if (!this.#localProfiles || stream.identity.modules.browser?.localProfiles !== 1)
        throw relayError("Browser profile inventory was not negotiated.");
      let inventory = this.#inventory.get(stream.identity.runnerId);
      if (!inventory || !sameRunnerAuxiliaryFence(inventory.fence, stream.fence)) {
        inventory = {
          fence: stream.fence,
          complete: false,
          failed: false,
          profiles: new Set(),
        };
        this.#inventory.set(stream.identity.runnerId, inventory);
      }
      if (
        inventory.failed ||
        inventory.complete ||
        message.profiles.some((claim) => inventory.profiles.has(claim.binding.profileId))
      ) {
        inventory.failed = true;
        throw relayError("Browser profile inventory is duplicated or already complete.");
      }
      try {
        await this.#localProfiles.reconcileInventory(stream, message);
      } catch (error) {
        inventory.failed = true;
        throw error;
      }
      for (const claim of message.profiles) inventory.profiles.add(claim.binding.profileId);
      inventory.complete = message.complete;
      if (message.complete)
        void this.resumeDeletions(stream.identity.runnerId).catch(() => undefined);
      return;
    }
    if (
      message.type === "browser.profile.delete.result" &&
      stream.identity.modules.browser?.localProfiles !== 1
    )
      throw relayError("Browser profile erasure was not negotiated.");
    if (message.type === "browser.command-error") {
      const pending = this.#takePending(message.requestId);
      if (pending) {
        // Command errors have no capability field. Their authenticated stream,
        // request and channel identify the pending operation being refused.
        this.#assertPendingResponse(
          pending,
          stream,
          message.channelId ?? undefined,
          pending.capability,
        );
        pending.reject(protocolFailure(message.error));
        return;
      }
      if (message.channelId && !this.#channels.has(message.channelId)) return;
      throw relayError("The browser relay returned an unknown request error.");
    }

    if (message.type === "browser.channel-error") {
      const channel = this.#channels.get(message.channelId);
      if (!channel) return;
      this.#requireChannel(stream, message.channelId, message.capability);
      channel.connection.acceptError(protocolFailure(message.error));
      this.#dropChannel(channel, 1011, "Browser relay channel failed");
      return;
    }

    if (
      message.type === "browser.profile.delete.result" ||
      message.type === "browser.profile.prepared" ||
      message.type === "browser.attached" ||
      message.type === "capability.accepted" ||
      message.type === "capability.revoked"
    ) {
      const pending = this.#takePending(message.requestId);
      if (!pending) {
        if (
          (message.type === "browser.attached" || message.type === "browser.profile.prepared") &&
          !this.#channels.has(message.channelId)
        )
          return;
        throw relayError("The browser relay response is not correlated.");
      }
      this.#assertPendingResponse(
        pending,
        stream,
        "channelId" in message ? message.channelId : undefined,
        message.capability,
      );
      if (pending.expectedType !== message.type) {
        pending.reject(new Error("The browser relay returned the wrong correlated response."));
        throw relayError("The browser relay returned the wrong correlated response.");
      }
      pending.resolve(message);
      return;
    }

    if (message.type === "browser.server-message") {
      const channel = this.#requireChannel(stream, message.channelId, message.capability);
      channel.connection.acceptServerMessage(message.message);
      return;
    }

    if (message.type === "browser.closed") {
      const channel = this.#channels.get(message.channelId);
      const pending = message.requestId ? this.#takePending(message.requestId) : undefined;
      if (pending) {
        this.#assertPendingResponse(pending, stream, message.channelId, message.capability);
        if (pending.expectedType !== "browser.closed") {
          pending.reject(new Error("The browser relay returned the wrong correlated response."));
          throw relayError("The browser close response is unexpected.");
        }
        pending.resolve(message);
      } else if (channel && message.requestId) {
        throw relayError("The browser close is not correlated.");
      }
      if (!channel) return;
      this.#requireChannel(stream, message.channelId, message.capability);
      this.#dropChannel(channel, message.code, message.reason);
      void this.#releasePlacementLease(channel.placementLease).catch(() => undefined);
      return;
    }

    throw relayError("The browser relay sent an unsolicited health response.");
  }

  async #handleFrame(
    stream: RunnerAuxiliaryStream,
    header: BrowserRelayFrameHeader,
    frame: Buffer,
  ): Promise<void> {
    const channel = this.#requireChannel(stream, header.channelId, header.capability);
    if (header.sequence <= channel.lastSequence) {
      throw relayError("The browser frame sequence went backwards.");
    }
    channel.lastSequence = header.sequence;
    channel.connection.acceptFrame(frame);
  }

  #handleDisconnect(stream: RunnerAuxiliaryStream): void {
    if (
      this.#inventory.get(stream.identity.runnerId) &&
      sameRunnerAuxiliaryFence(this.#inventory.get(stream.identity.runnerId)!.fence, stream.fence)
    )
      this.#inventory.delete(stream.identity.runnerId);
    const error = relayError("The computer's browser stream went away.", true);
    for (const [requestId, pending] of this.#pending) {
      if (
        pending.runnerId !== stream.fence.runnerId ||
        !sameRunnerAuxiliaryFence(pending.fence, stream.fence)
      ) {
        continue;
      }
      this.#pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const channel of this.#channels.values()) {
      if (!sameRunnerAuxiliaryFence(channel.placementLease.fence, stream.fence)) continue;
      channel.connection.acceptError(error);
      this.#dropChannel(channel, 1011, "Browser stream lost");
      channel.placementLease.released = true;
    }
  }

  async #closeChannel(channel: RoutedChannel, code: number, reason: string): Promise<void> {
    const placementLease = channel.placementLease;
    if (placementLease.renewal) await placementLease.renewal.catch(() => undefined);
    if (!this.#channels.has(channel.channelId)) return;
    this.#assertCurrentConnection(channel);
    await this.#request(placementLease.runnerId, placementLease.fence, {
      capability: placementLease.capability,
      channelId: channel.channelId,
      expectedType: "browser.closed",
      message: {
        ...placementLease.fence,
        capability: placementLease.capability,
        channelId: channel.channelId,
        type: "browser.close",
      },
    });
    if (this.#channels.has(channel.channelId)) this.#dropChannel(channel, code, reason);
    await this.#releasePlacementLease(placementLease).catch(() => undefined);
  }

  async #bestEffortCloseAndRevoke(channel: RoutedChannel): Promise<void> {
    const placementLease = channel.placementLease;
    if (placementLease.renewal) await placementLease.renewal.catch(() => undefined);
    const stream = this.#registry.stream(placementLease.runnerId);
    if (!stream || !sameRunnerAuxiliaryFence(stream.fence, placementLease.fence)) return;
    await this.#request(placementLease.runnerId, placementLease.fence, {
      capability: placementLease.capability,
      channelId: channel.channelId,
      expectedType: "browser.closed",
      message: {
        ...placementLease.fence,
        capability: placementLease.capability,
        channelId: channel.channelId,
        type: "browser.close",
      },
    }).catch(() => undefined);
    await this.#releasePlacementLease(placementLease).catch(() => undefined);
  }

  async #revoke(
    runnerId: RunnerId,
    fence: RunnerAuxiliaryFrameFence,
    capability: BrowserCapabilityReference,
  ): Promise<void> {
    await this.#request(runnerId, fence, {
      capability,
      expectedType: "capability.revoked",
      message: {
        ...fence,
        capability,
        type: "capability.revoke",
      },
    });
  }

  #scheduleRenewal(placementLease: PlacementCapabilityLease, expiresAt: string): void {
    if (
      placementLease.released ||
      (placementLease.channels.size === 0 && placementLease.maintenanceCount === 0)
    )
      return;
    if (placementLease.renewalTimer) clearTimeout(placementLease.renewalTimer);
    const remaining = Date.parse(expiresAt) - this.#now();
    const delay = Math.max(250, Math.floor(remaining / 2));
    placementLease.renewalTimer = setTimeout(() => {
      placementLease.renewalTimer = undefined;
      const renewal = this.#renew(placementLease);
      placementLease.renewal = renewal;
      // #renew invalidates the placement and closes its channels on failure.
      // Observe the timer-owned rejection; callers awaiting renewal still see it.
      void renewal
        .catch(() => undefined)
        .finally(() => {
          if (placementLease.renewal === renewal) placementLease.renewal = undefined;
        });
    }, delay);
    placementLease.renewalTimer.unref();
  }

  async #renew(placementLease: PlacementCapabilityLease): Promise<void> {
    try {
      this.#assertCurrentPlacementLease(placementLease);
      const stream = this.#registry.stream(placementLease.runnerId);
      if (!stream) throw relayError("That computer's browser is not connected.");
      const lease = this.#newCapabilityLease(stream, placementLease.runtimeId);
      const next = capabilityReference(lease);
      placementLease.pendingCapability = next;
      await this.#request(placementLease.runnerId, placementLease.fence, {
        capability: next,
        expectedType: "capability.accepted",
        message: {
          ...placementLease.fence,
          lease,
          type: "capability.grant",
        },
      });
      placementLease.capability = next;
      placementLease.expiresAt = lease.expiresAt;
      placementLease.pendingCapability = undefined;
      this.#scheduleRenewal(placementLease, lease.expiresAt);
    } catch (error) {
      placementLease.pendingCapability = undefined;
      for (const channelId of placementLease.channels) {
        const channel = this.#channels.get(channelId);
        if (!channel) continue;
        channel.connection.acceptError(normalizeError(error));
        this.#dropChannel(channel, 1011, "Browser capability renewal failed");
      }
      placementLease.released = true;
      throw error;
    }
  }

  #newCapabilityLease(stream: RunnerAuxiliaryStream, runtimeId: string): BrowserCapabilityLease {
    const connectionExpiresAt = Date.parse(stream.streamLeaseExpiresAt);
    if (connectionExpiresAt <= this.#now() + 250) {
      throw relayError("The browser stream lease is too close to expiry.");
    }
    const placementKey = runnerPlacementKey(stream.fence.runnerId, runtimeId);
    const generation = (this.#generationByPlacement.get(placementKey) ?? 0) + 1;
    this.#generationByPlacement.set(placementKey, generation);
    return {
      capabilityGeneration: generation,
      capabilityLeaseId: BrowserCapabilityLeaseIdSchema.parse(`bcl_${randomUUID()}`),
      expiresAt: stream.streamLeaseExpiresAt,
      runtimeId,
    };
  }

  #request(
    runnerId: RunnerId,
    fence: RunnerAuxiliaryFrameFence,
    options: {
      readonly capability?: BrowserCapabilityReference;
      readonly channelId?: BrowserChannelId;
      readonly expectedType: PendingRequest["expectedType"];
      readonly message: Record<string, unknown>;
      readonly timeoutMs?: number | undefined;
    },
  ): Promise<BrowserRelayEvent> {
    if (this.#pending.size >= maxPendingRequests) {
      return Promise.reject(relayError("Too many browser relay requests are pending.", true));
    }
    const id = requestId(options.expectedType);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        reject(relayError("The browser relay request timed out.", true));
      }, options.timeoutMs ?? this.#requestTimeoutMs);
      timer.unref();
      this.#pending.set(id, {
        capability: options.capability,
        channelId: options.channelId,
        fence,
        runnerId,
        expectedType: options.expectedType,
        reject,
        resolve,
        timer,
      });
      void this.#registry
        .send(runnerId, { ...options.message, requestId: id } as BrowserRuntimeRelayRequest)
        .catch((error: unknown) => {
          const pending = this.#takePending(id);
          pending?.reject(error);
        });
    });
  }

  #assertPendingResponse(
    pending: PendingRequest,
    stream: RunnerAuxiliaryStream,
    channelId?: BrowserChannelId,
    capability?: BrowserCapabilityReference,
  ): void {
    if (
      pending.runnerId !== stream.fence.runnerId ||
      !sameRunnerAuxiliaryFence(pending.fence, stream.fence) ||
      pending.channelId !== channelId ||
      (pending.capability &&
        (!capability || !sameBrowserCapability(pending.capability, capability)))
    ) {
      pending.reject(new Error("The browser relay response fence is not correlated."));
      throw relayError("The browser relay response fence is not correlated.");
    }
  }

  #takePending(requestIdValue: RunnerAuxiliaryRequestId): PendingRequest | undefined {
    const pending = this.#pending.get(requestIdValue);
    if (!pending) return undefined;
    this.#pending.delete(requestIdValue);
    clearTimeout(pending.timer);
    return pending;
  }

  #requireChannel(
    stream: RunnerAuxiliaryStream,
    channelId: BrowserChannelId,
    capability: BrowserCapabilityReference,
  ): RoutedChannel {
    const channel = this.#channels.get(channelId);
    const placementLease = channel?.placementLease;
    if (
      !channel ||
      !placementLease ||
      !sameRunnerAuxiliaryFence(placementLease.fence, stream.fence) ||
      (!sameBrowserCapability(placementLease.capability, capability) &&
        (!placementLease.pendingCapability ||
          !sameBrowserCapability(placementLease.pendingCapability, capability)))
    ) {
      throw relayError("The browser relay channel is stale.");
    }
    return channel;
  }

  #channelForConnection(connection: RunnerBrowserConnection): RoutedChannel {
    const channel = [...this.#channels.values()].find((entry) => entry.connection === connection);
    if (!channel) throw relayError("The browser relay channel is not open.");
    return channel;
  }

  #assertCurrentConnection(channel: RoutedChannel): void {
    this.#assertCurrentPlacementLease(channel.placementLease);
  }

  #assertCurrentPlacementLease(placementLease: PlacementCapabilityLease): void {
    if (this.#closed || placementLease.released)
      throw relayError("The browser capability is no longer active.");
    const current = this.#registry.stream(placementLease.runnerId);
    if (!current || !sameRunnerAuxiliaryFence(current.fence, placementLease.fence)) {
      throw relayError("That computer's browser stream was replaced.");
    }
  }

  #requireExpectedStream(
    runnerId: RunnerId,
    expectedFence: RunnerAuxiliaryFrameFence,
  ): RunnerAuxiliaryStream {
    const stream = this.#registry.stream(runnerId);
    if (!stream) throw relayError("That computer's browser is not connected.");
    if (!sameRunnerAuxiliaryFence(stream.fence, expectedFence)) {
      throw relayError("That computer's browser stream was replaced.");
    }
    return stream;
  }

  #dropChannel(channel: RoutedChannel, code: number, reason: string): void {
    if (this.#channels.get(channel.channelId) !== channel) return;
    this.#channels.delete(channel.channelId);
    const placementLease = channel.placementLease;
    placementLease.channels.delete(channel.channelId);
    if (channel.preparation) placementLease.maintenanceCount--;
    if (placementLease.channels.size === 0 && placementLease.maintenanceCount === 0) {
      if (placementLease.renewalTimer) clearTimeout(placementLease.renewalTimer);
      placementLease.renewalTimer = undefined;
      this.#leaseByPlacement.delete(placementLease.placementKey);
    }
    channel.connection.acceptClose(code, reason);
  }

  async #releasePlacementLease(placementLease: PlacementCapabilityLease): Promise<void> {
    if (
      placementLease.channels.size > 0 ||
      placementLease.maintenanceCount > 0 ||
      placementLease.released
    )
      return;
    placementLease.released = true;
    if (placementLease.renewalTimer) clearTimeout(placementLease.renewalTimer);
    placementLease.renewalTimer = undefined;
    this.#leaseByPlacement.delete(placementLease.placementKey);
    const stream = this.#registry.stream(placementLease.runnerId);
    if (!stream || !sameRunnerAuxiliaryFence(stream.fence, placementLease.fence)) return;
    await this.#revoke(placementLease.runnerId, placementLease.fence, placementLease.capability);
  }
}

class RunnerBrowserConnection extends EventEmitter implements BrowserRuntimeConnection {
  #closed = false;
  #controlBytes = 0;
  readonly #controls: Buffer[] = [];
  readonly #frames = new Map<string, Buffer>();
  #frameBytes = 0;
  #pumpScheduled = false;
  readonly #router: RunnerBrowserRuntimeRouter;
  initialPage: InitialPageReady | undefined;
  readyState: number = WebSocket.CONNECTING;

  constructor(router: RunnerBrowserRuntimeRouter) {
    super();
    this.#router = router;
  }

  send(data: string, options: { readonly binary: false }, callback: (error?: Error) => void): void {
    if (options.binary !== false) {
      callback(new Error("Binary browser commands are not supported."));
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch (error) {
      callback(normalizeError(error));
      return;
    }
    if (this.readyState !== WebSocket.OPEN) {
      callback(new Error("The browser relay connection is not open."));
      return;
    }
    void this.#router.send(this, message).then(
      () => callback(),
      (error: unknown) => callback(normalizeError(error)),
    );
  }

  close(code = 1000, reason = "Browser connection closed"): void {
    if (this.readyState === WebSocket.CLOSED || this.readyState === WebSocket.CLOSING) return;
    this.readyState = WebSocket.CLOSING;
    this.#router.closeConnection(this, code, reason.slice(0, 1_000));
  }

  terminate(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSING;
    this.#router.terminateConnection(this);
  }

  acceptOpen(): void {
    if (this.readyState !== WebSocket.CONNECTING) return;
    this.readyState = WebSocket.OPEN;
    this.emit("open");
    this.#schedulePump();
  }

  acceptServerMessage(message: unknown): void {
    if (this.#closed) return;
    const data = Buffer.from(JSON.stringify(message), "utf8");
    if (
      this.#controls.length >= maxQueuedControlItems ||
      this.#controlBytes + data.byteLength > maxQueuedControlBytes
    ) {
      this.acceptError(new Error("The browser relay control queue is full."));
      this.terminate();
      return;
    }
    this.#controls.push(data);
    this.#controlBytes += data.byteLength;
    this.#schedulePump();
  }

  acceptFrame(frame: Buffer): void {
    if (this.#closed) return;
    let surfaceId: string;
    try {
      surfaceId = readBrowserFrameHeader(frame).surfaceId;
    } catch {
      return;
    }
    const previous = this.#frames.get(surfaceId);
    this.#frameBytes += frame.byteLength - (previous?.byteLength ?? 0);
    // Replacing a surface's pixels keeps its position, so a busy page cannot
    // move the other pages behind it on every picture.
    this.#frames.set(surfaceId, frame);
    for (const [id, queued] of this.#frames) {
      if (this.#frameBytes <= maxQueuedFrameBytes && this.#frames.size <= maxQueuedFrameSurfaces)
        break;
      this.#frames.delete(id);
      this.#frameBytes -= queued.byteLength;
    }
    this.#schedulePump();
  }

  acceptError(error: Error): void {
    if (this.#closed) return;
    this.emit("error", error);
  }

  acceptClose(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.readyState = WebSocket.CLOSED;
    this.#controls.length = 0;
    this.#controlBytes = 0;
    this.#frames.clear();
    this.#frameBytes = 0;
    this.emit("close", code, Buffer.from(reason.slice(0, 1_000), "utf8"));
  }

  #schedulePump(): void {
    if (this.#pumpScheduled || this.readyState !== WebSocket.OPEN) return;
    this.#pumpScheduled = true;
    setImmediate(() => {
      this.#pumpScheduled = false;
      if (this.readyState !== WebSocket.OPEN) return;
      const control = this.#controls.shift();
      if (control) {
        this.#controlBytes -= control.byteLength;
        this.emit("message", control as RawData, false);
      } else {
        const next = this.#frames.entries().next().value;
        if (next) {
          const [surfaceId, frame] = next;
          this.#frames.delete(surfaceId);
          this.#frameBytes -= frame.byteLength;
          this.emit("message", frame as RawData, true);
        }
      }
      if (this.#controls.length > 0 || this.#frames.size > 0) this.#schedulePump();
    });
  }
}

function runnerPlacementKey(runnerId: RunnerId, runtimeId: string): string {
  return `device:${runnerId}:${runtimeId}`;
}

/**
 * The relay's failures are all the same kind of thing to a caller: this Runner
 * cannot serve the session right now, and whether waiting helps is the only
 * distinction worth keeping.
 */
function relayError(message: string, retryable = false): OpensteerError {
  return new OpensteerError({ code: retryable ? "conflict" : "forbidden", message, retryable });
}

function requestId(prefix: string): RunnerAuxiliaryRequestId {
  return RunnerAuxiliaryRequestIdSchema.parse(`${prefix}:${randomUUID()}`);
}

function capabilityReference(lease: BrowserCapabilityLease): BrowserCapabilityReference {
  return {
    capabilityGeneration: lease.capabilityGeneration,
    capabilityLeaseId: lease.capabilityLeaseId,
    runtimeId: lease.runtimeId,
  };
}

function protocolFailure(error: { readonly message: string; readonly retryable: boolean }): Error {
  return relayError(error.message, error.retryable);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error("The browser relay operation failed.");
}
