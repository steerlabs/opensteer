import { RawCdpChunks, RawCdpWriter } from "@opensteer/protocol/raw-cdp-relay";
import {
  StandardCdpChunkSchema,
  type StandardCdpAttemptReconciliation,
  type StandardCdpLeaseReconciliation,
  type StandardCdpMode,
} from "@opensteer/protocol/standard-cdp";
import { OpensteerError, type RunnerId } from "@opensteer/core";
import { sameProfileBinding } from "@opensteer/database";
import type { RunnerAuxiliaryStream, RunnerStreamLossReason } from "@opensteer/orchestration";
import {
  RunnerAuxiliaryFrameFenceSchema,
  RunnerAuxiliaryRequestIdSchema,
  sameRunnerAuxiliaryFence,
  type BrowserPlacementSelector,
  type InitialPageReady,
  type LocalProfileBinding,
  type RunnerAuxiliaryFrameFence,
  type RunnerAuxiliaryRequestId,
} from "@opensteer/protocol";
import { readBrowserFrameHeader } from "@opensteer/protocol/browser";
import {
  BrowserCapabilityLeaseIdSchema,
  BrowserCapabilityReferenceSchema,
  BrowserChannelIdSchema,
  createBrowserRelayToHostMessageSchema,
  createHostToBrowserRelayMessageSchema,
  sameBrowserCapability,
  type BrowserCapabilityLease,
  type BrowserCapabilityReference,
  type BrowserChannelId,
  type BrowserRelayFrameHeader,
} from "@opensteer/protocol/browser-relay";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import WebSocket, { type RawData } from "ws";
import { z } from "zod";
import type { BrowserLocalProfiles } from "./browser-local-profiles.js";
import { browserRuntimeCompatibilityReason } from "./browser-runtime-compatibility.js";
import type {
  BrowserRuntimeConnection,
  PersonBrowserReconnect,
  BrowserRuntimePlacement,
  BrowserRuntimeTarget,
  BrowserRuntimeTargetResolver,
} from "./browser-service.js";
import type {
  BrowserRelayEvent,
  RunnerBrowserHooks,
  RunnerBrowserRegistry,
} from "./runner-browser-hub.js";

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
  createHostToBrowserRelayMessageSchema({}),
]);
export const BrowserRuntimeRelayToHostMessageSchema = z.union([
  z.strictObject({ ...browserChannelEnvelope, type: z.literal("browser.server-message") }),
  createBrowserRelayToHostMessageSchema({}),
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
const erasureTimeoutMs = 120_000;
const maxPendingRequests = 64;
const maxQueuedControlBytes = 2 * 1_024 * 1_024;
const maxQueuedControlItems = 256;
const maxQueuedFrameBytes = 32 * 1_024 * 1_024;
const maxQueuedFrameSurfaces = 128;
/**
 * How long a person's own tab keeps reconnecting after its Runner restarts:
 * once, from the first loss, however many restarts follow inside it.
 *
 * It is the browser runtime's promise that bounds it. When the old Runner's
 * bridge closes during a restart, the runtime keeps the person's detached tab
 * for 20 s and then ends it (`reattachUntil`,
 * `packages/browser-runtime-core/src/runtime.ts`). A reattach that lands
 * earlier finds the tab, and a later one is told it has ended. The Runner
 * sends its restart close to the Host before it closes that bridge
 * (`opened.close` before `handler.detach`,
 * `apps/runner/src/host/host-connection.ts`), and the runtime arms its timer
 * only after the tab's teardown. So the runtime's 20 s cannot start more than
 * one Runner-to-Host hop before this Host sees the loss. At 15 s the router
 * gives the reconnect up, even with an attach sent and not yet answered. So
 * every reattach it sends leaves within 15 s of the loss and reaches the
 * runtime within 20 s, provided the hop there and back takes under 5 s. A
 * restart whose reattach had already reached the runtime arms a new 20 s at the
 * next detach, so later restarts only add time.
 */
const personReconnectDeadlineMs = 15_000;

interface PendingRequest {
  readonly erasure?: { binding: LocalProfileBinding; deletionId: string };
  readonly capability: BrowserCapabilityReference | undefined;
  readonly channelId: BrowserChannelId | undefined;
  readonly fence: RunnerAuxiliaryFrameFence;
  readonly runnerId: RunnerId;
  readonly expectedType:
    | "browser.attached"
    | "browser.closed"
    | "capability.accepted"
    | "capability.revoked"
    | "browser.profile.delete.result"
    | "browser.standard-cdp.reconciled";
  readonly reject: (error: unknown) => void;
  readonly resolve: (message: BrowserRelayEvent) => void;
  readonly timer: NodeJS.Timeout | undefined;
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
  readonly channelId: BrowserChannelId;
  readonly connection: RunnerBrowserConnection;
  lastSequence: number;
  readonly placementLease: PlacementCapabilityLease;
  reconnecting: boolean;
}

interface RestartWatch {
  readonly fence: RunnerAuxiliaryFrameFence;
  restarted: boolean;
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
  readonly onPlacementChanged?: (runnerId: RunnerId) => void;
  readonly onStandardCdpReconnect?: (
    runnerId: RunnerId,
    relayId: string,
    reconcile: (lease: StandardCdpLeaseReconciliation) => Promise<string>,
  ) => Promise<void>;
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
  readonly #admissionWaiters = new Set<() => void>();
  readonly #channels = new Map<BrowserChannelId, RoutedChannel>();
  readonly #generationByPlacement = new Map<string, number>();
  readonly #leaseByPlacement = new Map<string, PlacementCapabilityLease>();
  readonly #leaseAcquisitions = new Map<string, Promise<PlacementCapabilityLease>>();
  readonly #erasures = new Map<RunnerId, { pending: boolean; operation: Promise<void> }>();
  readonly #now: () => number;
  readonly #pending = new Map<RunnerAuxiliaryRequestId, PendingRequest>();
  readonly #lateErasures = new Map<RunnerAuxiliaryRequestId, PendingRequest>();
  readonly #registry: RunnerBrowserRegistry;
  readonly #requestTimeoutMs: number;
  readonly #unsubscribe: () => void;
  #closed = false;
  readonly #inventory = new Map<
    RunnerId,
    { fence: RunnerAuxiliaryFrameFence; complete: boolean; failed: boolean; profiles: Set<string> }
  >();
  /**
   * The streams a person's reconnect is using right now, by fence value, and
   * whether each ended in a restart. A reconnect adds its watch in the same turn
   * as it admits the stream, and removes it only once the open waiting on that
   * stream has settled. The registry hands out a new object for the same stream
   * on every heartbeat, and the next boot may attach before a failed open is
   * handled, so a restart is never read from a stream object or from whichever
   * stream is newest. Nothing is kept once no reconnect holds it.
   */
  readonly #restartWatches = new Set<RestartWatch>();
  readonly #localProfiles: RunnerBrowserRuntimeRouterOptions["localProfiles"];
  readonly #onDeletionsChanged: RunnerBrowserRuntimeRouterOptions["onDeletionsChanged"];
  readonly #onPlacementChanged: RunnerBrowserRuntimeRouterOptions["onPlacementChanged"];
  readonly #onStandardCdpReconnect: RunnerBrowserRuntimeRouterOptions["onStandardCdpReconnect"];

  constructor(options: RunnerBrowserRuntimeRouterOptions) {
    this.#localProfiles = options.localProfiles;
    this.#onDeletionsChanged = options.onDeletionsChanged;
    this.#onPlacementChanged = options.onPlacementChanged;
    this.#onStandardCdpReconnect = options.onStandardCdpReconnect;
    this.#now = options.now ?? Date.now;
    this.#registry = options.registry;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? requestTimeoutMs;
    const hooks: RunnerBrowserHooks = {
      onAttached: (stream) => this.#notifyAdmission(stream.identity.runnerId),
      onFrame: (stream, frame) => this.#handleFrame(stream, frame.header, frame.frame),
      onLost: (stream, reason) => this.#handleDisconnect(stream, reason),
      onMessage: (stream, message) => this.#handleMessage(stream, message),
    };
    this.#unsubscribe = this.#registry.subscribe(hooks);
  }

  placements(runnerIds?: readonly RunnerId[]): readonly BrowserRuntimePlacement[] {
    if (this.#closed) return [];
    const streams = runnerIds
      ? runnerIds.flatMap((id) => {
          const stream = this.#registry.stream(id);
          return stream ? [stream] : [];
        })
      : this.#registry.browserStreams();
    return streams.flatMap((stream): BrowserRuntimePlacement[] => {
      const browser = stream.identity.modules.browser;
      if (!browser) return [];
      const incompatibility = this.#admissionReason(stream);
      return [
        {
          available: incompatibility === null,
          agents: stream.identity.modules.agents !== undefined,
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

  pendingAdmission(runnerId: RunnerId): boolean {
    const stream = this.#registry.stream(runnerId);
    return Boolean(
      stream &&
      !browserRuntimeCompatibilityReason(stream.identity.modules.browser?.wireVersion) &&
      stream.identity.modules.browser?.localProfileStorage &&
      this.#localProfiles &&
      !(
        this.#inventory.get(runnerId)?.failed &&
        sameRunnerAuxiliaryFence(this.#inventory.get(runnerId)!.fence, stream.fence)
      ) &&
      this.#admissionReason(stream),
    );
  }

  waitForTarget(runnerId: RunnerId, signal: AbortSignal, oldBootId?: string): Promise<void> {
    return this.#waitForAdmission(runnerId, signal, oldBootId, () => undefined);
  }

  /** Waits as `waitForTarget` does; `admitted` runs in the same turn the stream is admitted. */
  #waitForAdmission<T>(
    runnerId: RunnerId,
    signal: AbortSignal,
    oldBootId: string | undefined,
    admitted: (stream: RunnerAuxiliaryStream) => T,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown, value?: T) => {
        this.#admissionWaiters.delete(check);
        signal.removeEventListener("abort", abort);
        if (error !== undefined) reject(error);
        else resolve(value as T);
      };
      const abort = () => finish(signal.reason);
      const check = () => {
        if (signal.aborted) return abort();
        if (this.#closed) return finish(relayError("The browser relay router is closed."));
        const stream = this.#registry.stream(runnerId);
        if (!stream || (oldBootId !== undefined && stream.identity.bootId === oldBootId)) return;
        const reason = this.#admissionReason(stream);
        if (!reason) finish(undefined, admitted(stream));
        else if (!this.pendingAdmission(runnerId)) finish(relayError(reason));
      };
      this.#admissionWaiters.add(check);
      signal.addEventListener("abort", abort, { once: true });
      check();
    });
  }

  #notifyAdmission(runnerId?: RunnerId): void {
    if (runnerId) this.#onPlacementChanged?.(runnerId);
    for (const check of this.#admissionWaiters) check();
  }

  resolve(placement: BrowserPlacementSelector): BrowserRuntimeTarget | undefined {
    if (this.#closed) return undefined;
    const stream = this.#registry.stream(placement.runnerId);
    const browser = stream?.identity.modules.browser;
    if (!stream || !browser) return undefined;
    const incompatibility = this.#admissionReason(stream);
    if (incompatibility !== null) {
      throw new OpensteerError({
        code: "runner_offline",
        message: incompatibility,
      });
    }
    const expectedFence = stream.fence;
    const placementKey = runnerPlacementKey(placement.runnerId, browser.runtimeId);
    return {
      placementKey,
      main: stream.identity.runnerKind === "main",
      ...(browser.localProfileStorage ? { localProfileStorage: browser.localProfileStorage } : {}),
      runtimeId: browser.runtimeId,
      stateImport: browser.stateImport === true,
      fileStaging: browser.fileStaging === true,
      cardFill: browser.cardFill === 1,
      personFill: browser.personFill,
      signIn: browser.signIn?.version === 3,
      cdpBoundary: browser.cdpBoundary === 1,
      agentActions: browser.agentActions === 1,
      basicInput: browser.basicInput,
      surfaceState: browser.surfaceState,
      sharedControl: browser.sharedControl === 1,
      passkeys: browser.passkeys === 1,
      editing: browser.editing,
      clipboard: browser.editing === 1 || browser.clipboard === true,
      targetControl: browser.targetControl === 1,
      navigationVersion: browser.navigationVersion === 1,
      navigationAttributionVersion: browser.navigationAttributionVersion === 1,
      tabRestoreVersion: browser.tabRestoreVersion === 1,
      popupFollowVersion: browser.popupFollowVersion === 1,
      actorClaim: browser.actorClaim === 1,
      captureRegion: browser.captureRegion === 1,
      rasterDemand: browser.rasterDemand === 1,
      computer: { name: stream.identity.name, runnerId: placement.runnerId },
      wholeContextCdp: browser.wholeContextCdp === 1 && browser.standardCdpLeaseRecovery === 1,
      standardCdpLineage: browser.standardCdpLineage === 1,
      ...(browser.standardCdpLeaseRecovery === 1
        ? {
            standardCdpRecovery: {
              relayId: expectedFence.auxiliaryStreamId,
              boot: () => this.#reconcileStandardCdpLease(expectedFence),
              assertCurrent: () => {
                this.#requireExpectedStream(placement.runnerId, expectedFence);
              },
            },
          }
        : {}),
      ...(browser.standardCdpAttemptRecovery === 1
        ? {
            reconcileStandardCdpAttempt: (attempt: StandardCdpAttemptReconciliation) =>
              this.#reconcileStandardCdpLease(expectedFence, attempt),
          }
        : {}),
      ...(browser.standardCdp === 1
        ? {
            connectStandard: (ticket: string, signal: AbortSignal) =>
              this.#connectStandard(
                placement.runnerId,
                browser.runtimeId,
                expectedFence,
                ticket,
                signal,
              ),
          }
        : {}),
      connect: (ticket, reconnect) => {
        const connection = new RunnerBrowserConnection(this, false, reconnect);
        queueMicrotask(() => {
          void this.#open(connection, placement.runnerId, browser.runtimeId, expectedFence, ticket);
        });
        return connection;
      },
    };
  }

  async #reconcileStandardCdpLease(
    fence: RunnerAuxiliaryFrameFence,
    reconciliation?: StandardCdpAttemptReconciliation | StandardCdpLeaseReconciliation,
  ): Promise<string> {
    const attempt = reconciliation && "attachmentId" in reconciliation ? reconciliation : undefined;
    const lease = reconciliation && "profileId" in reconciliation ? reconciliation : undefined;
    this.#requireExpectedStream(fence.runnerId, fence);
    const result = await this.#request(fence.runnerId, fence, {
      expectedType: "browser.standard-cdp.reconciled",
      ...(reconciliation ? { timeoutMs: null } : {}),
      message: {
        ...fence,
        type: "browser.standard-cdp.reconcile",
        ...(lease ? { lease } : {}),
        ...(attempt ? { attempt } : {}),
      },
    });
    if (
      result.type !== "browser.standard-cdp.reconciled" ||
      (attempt && result.attachmentId !== attempt.attachmentId)
    )
      throw relayError("The browser did not acknowledge CDP settlement.");
    this.#requireExpectedStream(fence.runnerId, fence);
    return result.runtimeBootId;
  }

  async #connectStandard(
    runnerId: RunnerId,
    runtimeId: string,
    fence: RunnerAuxiliaryFrameFence,
    ticket: string,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const connection = new RunnerBrowserConnection(this, true);
    const abort = () => connection.terminate();
    signal.addEventListener("abort", abort, { once: true });
    const ready = Promise.withResolvers<void>();
    const failure = () =>
      ready.reject(relayError("The runtime refused the standard CDP attachment."));
    connection.once("open", ready.resolve);
    connection.on("error", failure);
    connection.once("close", failure);
    void this.#open(connection, runnerId, runtimeId, fence, ticket);
    try {
      await ready.promise;
      signal.throwIfAborted();
      if (!connection.standardCdpMode)
        throw relayError("The runtime did not confirm standard CDP.");
      return { connection, mode: connection.standardCdpMode };
    } catch (error) {
      connection.terminate();
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#notifyAdmission();
    this.#unsubscribe();
    const error = new Error("The browser relay router is closed.");
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#lateErasures.clear();
    this.#restartWatches.clear();
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
    restart?: RestartWatch,
  ): Promise<"opened" | "restarting" | "closed"> {
    let placementLease: PlacementCapabilityLease | undefined;
    let channel: RoutedChannel | undefined;
    try {
      if (this.#closed) throw new Error("The browser relay router is closed.");
      const stream = this.#requireExpectedStream(runnerId, expectedFence);
      const reason = this.#admissionReason(stream);
      if (reason) throw relayError(reason);
      placementLease = await this.#acquirePlacementLease(stream, runtimeId);
      if (placementLease.renewal) await placementLease.renewal;
      this.#assertCurrentPlacementLease(placementLease);
      this.#requireExpectedStream(runnerId, expectedFence);
      const activePlacementLease = placementLease;
      if (!activePlacementLease) {
        throw relayError("The browser capability lease is unavailable.");
      }
      if (connection.readyState !== WebSocket.CONNECTING) {
        await this.#releasePlacementLease(activePlacementLease).catch(() => undefined);
        connection.acceptClose(1000, "Browser attach cancelled");
        return "closed";
      }
      const channelId = BrowserChannelIdSchema.parse(`bch_${randomUUID()}`);
      const routedChannel: RoutedChannel = {
        channelId,
        connection,
        lastSequence: -1,
        placementLease: activePlacementLease,
        reconnecting: restart !== undefined,
      };
      channel = routedChannel;
      this.#channels.set(channelId, routedChannel);
      activePlacementLease.channels.add(channelId);
      const attached = await this.#request(runnerId, stream.fence, {
        capability: activePlacementLease.capability,
        channelId,
        expectedType: "browser.attached",
        // Initial page readiness shares the Host opening budget.
        timeoutMs: 20_000,
        message: {
          ...stream.fence,
          attachTicket: ticket,
          ...(connection.raw ? { standardCdp: 1 } : {}),
          capability: activePlacementLease.capability,
          channelId,
          type: "browser.attach",
        },
      });
      if (connection.readyState !== WebSocket.CONNECTING) {
        await this.#bestEffortCloseAndRevoke(routedChannel);
        this.#dropChannel(routedChannel, 1000, "Browser attach cancelled");
        return "closed";
      }
      if (attached.type !== "browser.attached")
        throw relayError("The browser did not acknowledge attachment.");
      const initialPage = attached.initialPage;
      connection.initialPage = initialPage;
      connection.standardCdpMode = attached.standardCdpMode;
      routedChannel.reconnecting = false;
      connection.acceptOpen();
      if (!activePlacementLease.renewalTimer && !activePlacementLease.renewal) {
        this.#scheduleRenewal(activePlacementLease, activePlacementLease.expiresAt);
      }
      return "opened";
    } catch (error) {
      const normalized = normalizeError(error);
      if (
        restart?.restarted === true &&
        !protocolRejection.has(normalized) &&
        connection.readyState === WebSocket.CONNECTING
      ) {
        // #handleDisconnect already forgot the channel and dropped what it queued.
        if (channel) this.#forgetChannel(channel);
        if (placementLease)
          await this.#releasePlacementLease(placementLease).catch(() => undefined);
        return "restarting";
      }
      connection.acceptError(normalized);
      if (channel) {
        this.#dropChannel(channel, 1011, "Browser Runtime attach failed");
        await this.#bestEffortCloseAndRevoke(channel);
      }
      if (placementLease) await this.#releasePlacementLease(placementLease).catch(() => undefined);
      connection.acceptClose(1011, "Browser Runtime attach failed");
      return "closed";
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
    const compatibility = browserRuntimeCompatibilityReason(browser?.wireVersion);
    if (compatibility) return compatibility;
    if (browser?.localProfileStorage !== undefined) {
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
    return null;
  }

  requirePersonalProfileInventory(runnerId: RunnerId): void {
    const stream = this.#registry.stream(runnerId);
    if (
      !stream ||
      (stream.identity.modules.browser?.localProfileStorage !== undefined &&
        this.#admissionReason(stream))
    )
      throw relayError(
        "Waiting for this profile's home computer to reconcile its browser profile storage.",
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
    if (!browser?.localProfileStorage) return;
    let failure: { error: unknown } | undefined;
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
      try {
        if (placementLease.renewal) await placementLease.renewal;
        this.#assertCurrentPlacementLease(placementLease);
        const capability = placementLease.capability;
        const result = await this.#request(runnerId, stream.fence, {
          capability,
          expectedType: "browser.profile.delete.result",
          timeoutMs: erasureTimeoutMs,
          erasure: { binding: job.binding, deletionId: job.deletionId },
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
      } catch (error) {
        failure = { error };
      } finally {
        placementLease.maintenanceCount--;
        await this.#releasePlacementLease(placementLease).catch(() => undefined);
      }
    }
    if (failure) throw failure.error;
  }

  async #handleMessage(stream: RunnerAuxiliaryStream, message: BrowserRelayEvent): Promise<void> {
    if (message.type === "browser.profile.inventory") {
      if (!this.#localProfiles || !stream.identity.modules.browser?.localProfileStorage)
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
        this.#notifyAdmission(stream.identity.runnerId);
        throw relayError("Browser profile inventory is duplicated or already complete.");
      }
      try {
        await this.#localProfiles.reconcileInventory(stream, message);
      } catch (error) {
        inventory.failed = true;
        this.#notifyAdmission(stream.identity.runnerId);
        throw error;
      }
      for (const claim of message.profiles) inventory.profiles.add(claim.binding.profileId);
      inventory.complete = message.complete;
      this.#notifyAdmission(message.complete ? stream.identity.runnerId : undefined);
      if (message.complete) {
        void this.resumeDeletions(stream.identity.runnerId).catch(() => undefined);
        if (stream.identity.modules.browser?.standardCdpLeaseRecovery === 1)
          void this.#onStandardCdpReconnect?.(
            stream.identity.runnerId,
            stream.fence.auxiliaryStreamId,
            (lease) => this.#reconcileStandardCdpLease(stream.fence, lease),
          );
      }
      return;
    }
    if (
      message.type === "browser.profile.delete.result" &&
      !stream.identity.modules.browser?.localProfileStorage
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
      const late = this.#lateErasures.get(message.requestId);
      if (late) {
        this.#assertPendingResponse(late, stream, message.channelId ?? undefined, late.capability);
        this.#lateErasures.delete(message.requestId);
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
      message.type === "browser.standard-cdp.reconciled" ||
      message.type === "browser.attached" ||
      message.type === "capability.accepted" ||
      message.type === "capability.revoked"
    ) {
      const pending = this.#takePending(message.requestId);
      if (!pending) {
        if (message.type === "browser.profile.delete.result") {
          const late = this.#lateErasures.get(message.requestId);
          if (late) {
            this.#assertPendingResponse(late, stream, undefined, message.capability);
            if (
              !late.erasure ||
              late.erasure.deletionId !== message.deletionId ||
              !sameProfileBinding(late.erasure.binding, message.binding)
            )
              throw relayError("The browser returned mismatched late profile erasure readiness.");
            this.#lateErasures.delete(message.requestId);
            await this.#localProfiles!.acknowledgeDeletion({
              binding: message.binding,
              deletionId: message.deletionId,
              state: message.state,
            });
            await this.#onDeletionsChanged?.(stream.identity.runnerId);
            return;
          }
        }
        if (message.type === "browser.attached" && !this.#channels.has(message.channelId)) return;
        throw relayError("The browser relay response is not correlated.");
      }
      this.#assertPendingResponse(
        pending,
        stream,
        "channelId" in message ? message.channelId : undefined,
        "capability" in message ? message.capability : undefined,
      );
      if (pending.expectedType !== message.type) {
        pending.reject(new Error("The browser relay returned the wrong correlated response."));
        throw relayError("The browser relay returned the wrong correlated response.");
      }
      pending.resolve(message);
      return;
    }

    if (message.type === "browser.server-message") {
      if (
        !this.#channels.has(message.channelId) &&
        StandardCdpChunkSchema.safeParse(message.message).success
      )
        return;
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
      if (!pending) this.#requireChannel(stream, message.channelId, message.capability);
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

  #handleDisconnect(stream: RunnerAuxiliaryStream, reason: RunnerStreamLossReason): void {
    if (reason === "device-restarting")
      for (const watch of this.#restartWatches)
        if (sameRunnerAuxiliaryFence(watch.fence, stream.fence)) watch.restarted = true;
    for (const [id, late] of this.#lateErasures)
      if (sameRunnerAuxiliaryFence(late.fence, stream.fence)) this.#lateErasures.delete(id);
    if (
      this.#inventory.get(stream.identity.runnerId) &&
      sameRunnerAuxiliaryFence(this.#inventory.get(stream.identity.runnerId)!.fence, stream.fence)
    )
      this.#inventory.delete(stream.identity.runnerId);
    for (const [key, lease] of this.#leaseByPlacement) {
      if (!sameRunnerAuxiliaryFence(lease.fence, stream.fence)) continue;
      lease.released = true;
      if (lease.renewalTimer) clearTimeout(lease.renewalTimer);
      lease.renewalTimer = undefined;
      this.#leaseByPlacement.delete(key);
    }
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
      const reconnect = channel.connection.reconnect;
      if (
        reason === "device-restarting" &&
        channel.reconnecting &&
        channel.connection.readyState === WebSocket.CONNECTING
      ) {
        // #reconnectPerson owns this connection and will retry on the next boot.
        // Nothing this boot sent may reach the person once a later boot opens.
        channel.connection.discardQueued();
        this.#forgetChannel(channel);
      } else if (
        reason === "device-restarting" &&
        reconnect &&
        channel.connection.prepareForRestart()
      ) {
        this.#forgetChannel(channel);
        void this.#reconnectPerson(channel.connection, reconnect, channel.placementLease, stream);
      } else {
        channel.connection.acceptError(error);
        this.#dropChannel(channel, 1011, "Browser stream lost");
      }
      channel.placementLease.released = true;
    }
    this.#notifyAdmission(stream.identity.runnerId);
  }

  async #reconnectPerson(
    connection: RunnerBrowserConnection,
    reconnect: PersonBrowserReconnect,
    lease: PlacementCapabilityLease,
    oldStream: RunnerAuxiliaryStream,
  ): Promise<void> {
    // One deadline from the first loss, for every boot that follows it.
    const expired = new AbortController();
    const timer = setTimeout(() => expired.abort(), personReconnectDeadlineMs);
    timer.unref();
    // Registered before the deadline signal below, so the person is told why
    // before anything waiting on that signal gives up.
    const expire = () =>
      this.#failReconnect(
        connection,
        relayError("The browser computer could not reconnect the page."),
      );
    expired.signal.addEventListener("abort", expire, { once: true });
    const deadline = AbortSignal.any([connection.lifetime, expired.signal]);
    let previousBootId = oldStream.identity.bootId;
    try {
      await reconnect.prepare();
      while (true) {
        deadline.throwIfAborted();
        let watch = await this.#waitForAdmission(
          lease.runnerId,
          deadline,
          previousBootId,
          (stream) => this.#watchRestart(stream.fence),
        );
        try {
          const stream = this.#registry.stream(lease.runnerId);
          if (!stream || !sameRunnerAuxiliaryFence(stream.fence, watch.fence)) {
            // The boot that ended the wait is already gone again.
            if (watch.restarted) {
              previousBootId = watch.fence.bootId;
              continue;
            }
            if (!stream) throw relayError("The browser computer could not reconnect the page.");
            this.#restartWatches.delete(watch);
            watch = this.#watchRestart(stream.fence);
          }
          if (
            stream.identity.modules.browser?.runtimeId !== lease.runtimeId ||
            stream.identity.bootId === previousBootId
          )
            throw relayError("The browser computer could not reconnect the page.");
          const outcome = await this.#open(
            connection,
            lease.runnerId,
            lease.runtimeId,
            stream.fence,
            reconnect.ticket(),
            watch,
          );
          if (outcome !== "restarting") return;
          previousBootId = stream.identity.bootId;
        } finally {
          this.#restartWatches.delete(watch);
        }
      }
    } catch (error) {
      this.#failReconnect(connection, normalizeError(error));
    } finally {
      clearTimeout(timer);
      expired.signal.removeEventListener("abort", expire);
    }
  }

  /** Ends a person's reconnect with its reason; an attach still in flight cleans up after itself. */
  #failReconnect(connection: RunnerBrowserConnection, error: Error): void {
    connection.acceptError(error);
    const channel = [...this.#channels.values()].find((entry) => entry.connection === connection);
    if (channel) this.#dropChannel(channel, 1011, "Browser stream could not reconnect");
    else connection.acceptClose(1011, "Browser stream could not reconnect");
  }

  #watchRestart(fence: RunnerAuxiliaryFrameFence): RestartWatch {
    const watch: RestartWatch = { fence, restarted: false };
    this.#restartWatches.add(watch);
    return watch;
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
      readonly timeoutMs?: number | null | undefined;
      readonly erasure?: { binding: LocalProfileBinding; deletionId: string };
    },
  ): Promise<BrowserRelayEvent> {
    if (
      options.timeoutMs !== null &&
      [...this.#pending.values()].filter((request) => request.timer).length >= maxPendingRequests
    ) {
      return Promise.reject(relayError("Too many browser relay requests are pending.", true));
    }
    // Never forget an admitted erasure while its stream can still reply. Bound
    // outstanding maintenance with backpressure, rather than expiring correlation
    // and letting a slow valid result disconnect unrelated channels.
    if (
      options.erasure &&
      this.#lateErasures.size +
        [...this.#pending.values()].filter((pending) => pending.erasure).length >=
        maxPendingRequests
    )
      return Promise.reject(
        relayError("Too many browser profile erasures are awaiting completion.", true),
      );
    const id = requestId(options.expectedType);
    return new Promise((resolve, reject) => {
      const timer =
        options.timeoutMs === null
          ? undefined
          : setTimeout(() => {
              const pending = this.#pending.get(id);
              if (!pending) return;
              this.#pending.delete(id);
              if (pending.erasure) this.#lateErasures.set(id, pending);
              reject(relayError("The browser relay request timed out.", true));
            }, options.timeoutMs ?? this.#requestTimeoutMs);
      timer?.unref();
      this.#pending.set(id, {
        ...(options.erasure ? { erasure: options.erasure } : {}),
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
    if (!this.#forgetChannel(channel)) return;
    channel.connection.acceptClose(code, reason);
  }

  #forgetChannel(channel: RoutedChannel): boolean {
    if (this.#channels.get(channel.channelId) !== channel) return false;
    this.#channels.delete(channel.channelId);
    const placementLease = channel.placementLease;
    placementLease.channels.delete(channel.channelId);
    if (placementLease.channels.size === 0 && placementLease.maintenanceCount === 0) {
      if (placementLease.renewalTimer) clearTimeout(placementLease.renewalTimer);
      placementLease.renewalTimer = undefined;
      this.#leaseByPlacement.delete(placementLease.placementKey);
    }
    return true;
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
  readonly #lifetime = new AbortController();
  readonly reconnect: PersonBrowserReconnect | undefined;
  #controlBytes = 0;
  readonly #controls: Buffer[] = [];
  readonly #frames = new Map<string, Buffer>();
  #frameBytes = 0;
  #pumpScheduled = false;
  readonly #router: RunnerBrowserRuntimeRouter;
  initialPage: InitialPageReady | undefined;
  standardCdpMode: StandardCdpMode | undefined;
  readonly raw: { reader: RawCdpChunks; writer: RawCdpWriter } | undefined;
  readyState: number = WebSocket.CONNECTING;

  constructor(
    router: RunnerBrowserRuntimeRouter,
    standard = false,
    reconnect?: PersonBrowserReconnect,
  ) {
    super();
    this.#router = router;
    this.reconnect = reconnect;
    this.raw = standard
      ? {
          reader: new RawCdpChunks(),
          writer: new RawCdpWriter((chunk) => router.send(this, chunk)),
        }
      : undefined;
  }

  send(data: string, options: { readonly binary: false }, callback: (error?: Error) => void): void {
    if (options.binary !== false) {
      callback(new Error("Binary browser commands are not supported."));
      return;
    }
    if (this.raw) {
      if (this.readyState !== WebSocket.OPEN) {
        callback(new Error("The raw CDP relay is not open."));
        return;
      }
      void this.raw.writer.send(Buffer.from(data, "utf8")).then(
        () => callback(),
        (error: unknown) => callback(normalizeError(error)),
      );
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

  get lifetime(): AbortSignal {
    return this.#lifetime.signal;
  }

  prepareForRestart(): boolean {
    if (this.readyState !== WebSocket.OPEN) return false;
    this.readyState = WebSocket.CONNECTING;
    this.#clearQueues();
    return true;
  }

  /** Drops what a boot that has since restarted queued before this connection opened. */
  discardQueued(): void {
    if (this.readyState === WebSocket.CONNECTING) this.#clearQueues();
  }

  acceptOpen(): void {
    if (this.readyState !== WebSocket.CONNECTING) return;
    this.readyState = WebSocket.OPEN;
    this.emit("open");
    this.#schedulePump();
  }

  acceptServerMessage(message: unknown): void {
    if (this.#closed) return;
    if (this.raw) {
      try {
        const frame = this.raw.reader.read(StandardCdpChunkSchema.parse(message));
        if (frame) this.emit("message", frame, false);
      } catch (error) {
        this.acceptError(normalizeError(error));
        this.terminate();
      }
      return;
    }
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
    this.#lifetime.abort();
    this.raw?.writer.close();
    this.readyState = WebSocket.CLOSED;
    this.#clearQueues();
    this.emit("close", code, Buffer.from(reason.slice(0, 1_000), "utf8"));
  }

  #clearQueues(): void {
    this.#controls.length = 0;
    this.#controlBytes = 0;
    this.#frames.clear();
    this.#frameBytes = 0;
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

const protocolRejection = new WeakSet<Error>();

function protocolFailure(error: { readonly message: string; readonly retryable: boolean }): Error {
  const failure = relayError(error.message, error.retryable);
  protocolRejection.add(failure);
  return failure;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error("The browser relay operation failed.");
}
