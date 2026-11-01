import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { throwIfAborted } from "@opensteer/shared/throwIfAborted";
import { delay } from "@opensteer/shared/delay";
import { randomUUID } from "node:crypto";
import type {
  ContentPart,
  EnvironmentId,
  HarnessId,
  HarnessInstanceId,
  ModelSelection,
  RunId,
  RunnerId,
  ThreadAccessMode,
  ThreadId,
  TriggerOccurrenceId,
  TriggerWatchActivationId,
  WorkspaceId,
  UserId,
} from "@opensteer/core";
import { createId, OpensteerError, placeInputFailure } from "@opensteer/core";
import {
  type RunnerVoiceCommand,
  type RunnerVoiceResult,
  CorrelationIdSchema,
  RunnerCommandSchema,
  sameRunnerConnectionFence,
  type HostToRunnerMessage,
  type RunnerAuxiliaryFrameFence,
  type RunnerAuxiliaryModule,
  type RunnerAuxiliaryStreamId,
  type RunnerAuxiliaryTicketClaims,
  type RunnerConnectionFence,
  type RunnerConnectionLeaseId,
  type RunnerModuleName,
  type RunnerModuleReadiness,
  type RunnerModuleReadinessReport,
  type HarnessAuthenticationState,
  type ModelServer,
  type HarnessInstanceCatalog,
  type PendingAgentEvent,
  type RunnerCommand,
  type RunnerCommandAccepted,
  type RunnerConnectionId,
  type HostWorkspaceLocalRequest,
  type RunnerDescriptor,
  type RunnerOperationalMessage,
  type RunnerWorkspaceLocalResult,
  type WatchReconcileActivation,
  type WorkspaceStorageFence,
} from "@opensteer/protocol";
import { CommandDispatchError } from "./execution-coordinator.js";

export interface RunnerPeer {
  readonly id: string;
  send(message: HostToRunnerMessage): Promise<void>;
  close(code: number, reason: string): void;
}

/**
 * The one close code that means "this identity is gone, do not come back".
 *
 * Every other refusal a Runner meets — a lease that ran out, a Deployment whose
 * remote access went away, an authentication that failed — is something it
 * should retry, and the computer that supervises it must not tear the slot down
 * over one. Only revocation is terminal, so only revocation gets its own code.
 */
export const runnerIdentityRevokedCloseCode = 4010;

/** The close reason that travels with it, so a log says why without a lookup. */
export const runnerIdentityRevokedMessage = "Runner identity was revoked";

/**
 * A stream beside the primary connection, already proved to belong to this
 * Runner. The registry owns its identity, fence and lease; the module that
 * asked for it owns the frames that travel on it, which is why nothing here
 * can send.
 */
export interface RunnerAuxiliaryPeer {
  readonly id: string;
  close(code: number, reason: string): void;
}

export interface RunnerIdentity extends RunnerDescriptor {
  /** The enrollment's grant, which the advertised modules never exceed. */
  readonly allowedModules: readonly RunnerModuleName[];
  readonly connectionGeneration: number;
  /**
   * The Personal route generation this computer was admitted under, or null
   * where the Personal rules do not apply to it. Admission commits before
   * registration, so `authorize` compares this against the generation now.
   */
  readonly personalRemoteAccessGeneration: number | null;
  readonly connectionId: RunnerConnectionId;
  readonly connectionLeaseId: RunnerConnectionLeaseId;
  /** Empty without an agents module: a browser-only Runner executes nothing. */
  readonly environmentIds: readonly EnvironmentId[];
  readonly fence: RunnerConnectionFence;
}

export interface RunnerAuxiliaryStream {
  readonly auxiliaryStreamId: RunnerAuxiliaryStreamId;
  readonly fence: RunnerAuxiliaryFrameFence;
  readonly identity: RunnerIdentity;
  readonly streamLeaseExpiresAt: string;
}

export type RunnerStreamLossReason =
  | "host-shutdown"
  | "lease-expired"
  | "revoked"
  | "superseded"
  | "transport-disconnected"
  | "primary-lost";

/**
 * What the caller of `dispatch` learns. The connection fence is absent because
 * an interrupt for an offline machine is acknowledged without any socket having
 * been involved, and inventing a fence for it would be a lie.
 */
export type RunnerCommandReceipt = Omit<RunnerCommandAccepted, keyof RunnerConnectionFence>;

/**
 * Why a connection ended. Only a revoked identity or a replaced boot proves
 * the Runner's Runs are gone; a lost or superseded connection, or a stopping
 * Host, leaves them to their leases and to reattachment.
 */
export type RunnerDisconnectReason = "lost" | "replaced" | "revoked" | "shutdown" | "superseded";

export interface RunnerDisconnectScope {
  readonly reason: RunnerDisconnectReason;
  readonly runIds: readonly RunId[];
  readonly triggerOccurrenceIds: readonly TriggerOccurrenceId[];
}

export type RunnerThreadTitle = Extract<
  RunnerOperationalMessage,
  { readonly type: "runner.thread-title" }
>;
export type RunnerLive = Extract<RunnerOperationalMessage, { readonly type: "runner.live" }>;
/** What a refused Runner report is answered for: one Run, under one binding. */
export type RefusedRunnerReport = Pick<PendingAgentEvent, "bindingGeneration" | "runId">;
export type RunnerAttach = Extract<
  RunnerOperationalMessage,
  { readonly type: "runner.executions.attach" }
>;
export type RunnerAttachResult = Extract<
  HostToRunnerMessage,
  { readonly type: "host.executions.attached" }
>["results"][number];

type RunnerSessionBound = Extract<
  RunnerOperationalMessage,
  { readonly type: "runner.session-bound" }
>;

type RunnerTriggerResult = Extract<
  RunnerOperationalMessage,
  { readonly type: "runner.trigger-result" }
>;
type RunnerWatchStatus = Extract<
  RunnerOperationalMessage,
  { readonly type: "runner.watch-status" }
>;

type RunnerHarnessCatalogInvalidated = Extract<
  RunnerOperationalMessage,
  { readonly type: "runner.harness-catalog-invalidated" }
>;
type RunnerHarnessInstallation = Extract<
  RunnerOperationalMessage,
  { readonly type: "runner.harness-installation" }
>;

export interface RunnerRegistryHooks {
  authorize(identity: RunnerIdentity): Promise<void>;
  /** Persist the Runner receipt before any causally later event is admitted. */
  onCommandAccepted?(identity: RunnerIdentity, receipt: RunnerCommandAccepted): Promise<void>;
  onEvent(identity: RunnerIdentity, event: PendingAgentEvent): Promise<void>;
  /**
   * The Host refused a durable event as invalid for its Run, not because the
   * store was unavailable. The hook settles the Run as its owner sees fit; the
   * registry then tells this Runner to stop the Run and ignores what it still
   * sends for it.
   */
  onEventRefused?(
    identity: RunnerIdentity,
    event: RefusedRunnerReport,
    refusal: Error,
  ): Promise<void>;
  /**
   * A Run's live progress from the connection that owns it. It is fast and
   * synchronous: progress is forwarded or dropped, never stored or awaited.
   */
  onLive?(identity: RunnerIdentity, live: RunnerLive): void;
  onThreadTitle?(identity: RunnerIdentity, report: RunnerThreadTitle): Promise<void>;
  /**
   * Fires once the connection is live and reachable, which `authorize` cannot
   * do: authorization runs before the connection is inserted, so nothing it
   * does can talk to the Runner. This is where the Host takes whatever durable
   * record of a connected Runner it wants; it is not an admission check, so it
   * neither delays nor can refuse the connection.
   */
  onRegistered?(identity: RunnerIdentity): Promise<void>;
  /**
   * Renews the leases of the Runs a heartbeat names and returns the ones it
   * renewed; the Runner is told only after the renewal is durable.
   */
  onHeartbeat?(
    identity: RunnerIdentity,
    activeRunIds: readonly RunId[],
    activeTriggerOccurrenceIds: readonly TriggerOccurrenceId[],
    activeWatchActivationIds: readonly TriggerWatchActivationId[],
  ): Promise<readonly RunId[] | void>;
  /**
   * Settles which of the Runs a new connection announces continue on it. A
   * Host without this hook resumes nothing: every announced Run is revoked.
   */
  onAttach?(
    identity: RunnerIdentity,
    executions: RunnerAttach["executions"],
  ): Promise<readonly RunnerAttachResult[]>;
  /** The Runner's Runs are settled and new work may be dispatched to it. */
  onAttached?(identity: RunnerIdentity): Promise<void>;
  onHarnessCatalogInvalidated?(
    identity: RunnerIdentity,
    invalidation: RunnerHarnessCatalogInvalidated,
  ): Promise<void>;
  onHarnessInstallation?(
    identity: RunnerIdentity,
    installation: RunnerHarnessInstallation,
  ): Promise<void>;
  onSessionBound?(identity: RunnerIdentity, binding: RunnerSessionBound): Promise<void>;
  onTriggerResult?(identity: RunnerIdentity, result: RunnerTriggerResult): Promise<void>;
  onWatchStatus?(identity: RunnerIdentity, status: RunnerWatchStatus): Promise<void>;
  onDisconnect?(identity: RunnerIdentity, scope: RunnerDisconnectScope): Promise<void>;
  /** Full Disk Access is the descriptor fact a person can change during a live connection. */
  onShellFullDiskAccess?(identity: RunnerIdentity, fullDiskAccess: boolean): Promise<void>;
  /**
   * A module said what it can actually do. Readiness never comes from a
   * heartbeat, so this is the only way a module becomes routable.
   */
  onModuleReadiness?(identity: RunnerIdentity, report: RunnerModuleReadinessReport): Promise<void>;
  /** An auxiliary stream went away. Whatever it was serving must stop. */
  onAuxiliaryLost?(stream: RunnerAuxiliaryStream, reason: RunnerStreamLossReason): void;
  /**
   * Mints the short-lived, one-use credential the Runner presents on a new
   * auxiliary socket. Only the Host holds the signing key, so the registry asks
   * rather than issues.
   */
  issueAuxiliaryTicket?(
    identity: RunnerIdentity,
    module: RunnerAuxiliaryModule,
  ): Promise<{ readonly expiresAt: string; readonly ticket: string }>;
  /**
   * Fresh capability tokens for a Run this Runner boot holds, or a refusal once
   * its grant has ended. A throw means the Host could not decide now. Only the
   * Host holds the signing key.
   */
  refreshRunCredentials?(
    identity: RunnerIdentity,
    runId: RunId,
  ): Promise<
    Exclude<
      Extract<HostToRunnerMessage, { type: "host.grants.credentials" }>["result"],
      { readonly status: "unavailable" }
    >
  >;
}

interface PendingAck {
  readonly beforeAck?: () => Promise<void>;
  readonly commandType: RunnerCommand["type"];
  readonly runId?: RunId;
  readonly triggerOccurrenceId?: TriggerOccurrenceId;
  readonly reject: (error: unknown) => void;
  readonly resolve: (result: RunnerCommandAccepted) => void;
}

interface PendingTriggerProgram {
  readonly reject: (error: unknown) => void;
  readonly resolve: () => void;
}

/**
 * The desired-profile list both catalog messages carry. They are the same
 * shape on purpose: a reconciliation and a read differ in authority, not in
 * what they describe, so one answer can serve either question.
 */
export type HarnessCatalogRequestDefinitions = Extract<
  HostToRunnerMessage,
  { readonly type: "host.reconcile-harnesses" }
>["harnesses"];

interface PendingCatalog {
  readonly expected: ReadonlyMap<string, string>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (catalogs: readonly HarnessInstanceCatalog[]) => void;
}

interface PendingHarnessAuthentication {
  readonly driverKind: HarnessId;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly reject: (error: unknown) => void;
  readonly resolve: (state: HarnessAuthenticationState) => void;
}

/**
 * What a caller asks the owning machine to do. The fence is absent because only
 * the registry knows which socket is current, and a request fenced to a stale
 * one must never be sent at all.
 */
export type WorkspaceLocalRequest = DistributiveOmit<HostWorkspaceLocalRequest, "fence">;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

interface PendingModelServers {
  readonly reject: (error: unknown) => void;
  readonly resolve: (servers: readonly ModelServer[]) => void;
}

interface PendingWorkspaceLocal {
  readonly operationId: string;
  readonly reject: (error: unknown) => void;
  readonly resolve: (result: RunnerWorkspaceLocalResult) => void;
}

interface OwnedRunBinding {
  readonly environmentId: EnvironmentId;
  readonly bindingGeneration: number;
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
}

interface RunnerConnection {
  /**
   * Whether this connection's Runner has said which Runs it holds and the Host
   * has answered. Nothing is dispatched to it before: a Run sent earlier could
   * be confused with one it carried over from its previous connection.
   */
  attached: boolean;
  /** Committed progress not yet acknowledged to the Runner, per Run. */
  readonly eventAcks: Map<RunId, { sessionBound: boolean; throughOrdinal: number }>;
  eventAckTimer: NodeJS.Timeout | undefined;
  /**
   * Runs the Host ended without this Runner. Their later events and progress
   * are discarded rather than refused again: the Runner has been told to stop.
   */
  readonly revokedRunIds: Set<RunId>;
  readonly disconnected: {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
  };
  identity: RunnerIdentity;
  readonly peer: RunnerPeer;
  readonly pendingAcks: Map<string, PendingAck>;
  readonly pendingCatalogs: Map<string, PendingCatalog>;
  readonly pendingHarnessAuthentications: Map<string, PendingHarnessAuthentication>;
  readonly pendingVoice: Map<
    string,
    { resolve: (result: RunnerVoiceResult) => void; reject: (error: unknown) => void }
  >;
  readonly pendingModelServers: Map<string, PendingModelServers>;
  readonly pendingTriggerPrograms: Map<TriggerOccurrenceId, PendingTriggerProgram>;
  readonly pendingWorkspaceLocal: Map<string, PendingWorkspaceLocal>;
  /**
   * Work that may have crossed the transport boundary on this exact socket.
   * An acknowledgement can be lost after the Runner accepted a command. The Host must retain ownership
   * until a terminal event, an explicit rejection, or disconnect recovery.
   */
  readonly ownedRunIds: Set<RunId>;
  /**
   * The binding and placement each Run was dispatched with on this socket.
   * Only these Runs may stream progress here: a heartbeat says what a Runner
   * claims to be running, never what the Host gave it to run.
   */
  readonly ownedRunBindings: Map<RunId, OwnedRunBinding>;
  readonly ownedTriggerOccurrenceIds: Set<TriggerOccurrenceId>;
  /** Latest bounded observation reported by the Runner. Heartbeats replace
   * this snapshot; only Host-dispatched ownership is monotonic. */
  observedRunIds: Set<RunId>;
  observedTriggerOccurrenceIds: Set<TriggerOccurrenceId>;
  /**
   * Orders authoritative reconciliations against one another, and nothing else.
   * Two reconciliations disagree about the complete desired set, so the later
   * one must win; a read-only inspection has no such relationship with anything
   * and used to queue behind every reconciliation for no reason at all — which
   * meant one slow Runner turned every dispatch check into head-of-line waiting.
   */
  reconciliationTail: Promise<void>;
  /**
   * What each module last reported about itself. A module absent from this map
   * has said nothing since this connection began and is not routable, which is
   * exactly the state a freshly reconnected Runner should be in.
   */
  readonly readiness: Map<RunnerModuleName, RunnerModuleReadinessReport>;
  readonly auxiliaryStreams: Map<RunnerAuxiliaryModule, AuxiliaryStream>;
  authenticatedAt: number;
  lastHeartbeatSentAt: number | undefined;
  leaseExpiresAt: number;
  leaseTimer: NodeJS.Timeout | undefined;
  /**
   * Catalog requests already on the wire, keyed by the exact set they asked
   * about. Dispatch inspects live on every run, so a burst of runs on one
   * environment collapses into a single Runner round trip instead of N.
   */
  readonly inFlightCatalogs: Map<string, Promise<readonly HarnessInstanceCatalog[]>>;
  readonly catalogCache: Map<
    string,
    {
      readonly catalog: HarnessInstanceCatalog;
      readonly expiresAt: number;
      readonly fingerprint: string;
      readonly revision: number;
    }
  >;
  /**
   * AI accounts whose last answer was that they are still preparing. Their
   * Runs wait undispatched until the Runner reports preparation settled.
   */
  readonly preparingHarnesses: Set<HarnessInstanceId>;
  catalogRequestRevision: number;
  catalogGeneration: number;
  lastSeenAt: number;
}

interface RunnerRegistryOptions {
  readonly commandAckTimeoutMs?: number;
  readonly connectionLeaseMs?: number;
  /** How long a Run's execution lease lasts without renewal; it paces heartbeats. */
  readonly executionLeaseMs?: number;
  readonly hooks: RunnerRegistryHooks;
  readonly now?: () => number;
}

/**
 * How long a silent socket keeps its authority. A TCP connection can stay open
 * long after the process behind it stopped answering, so a live socket is not
 * evidence that the machine is there; the Runner has to keep saying so.
 */
const defaultConnectionLeaseMs = 2 * 60_000;
const defaultExecutionLeaseMs = 90_000;
/** How long committed events wait to be acknowledged together. */
const eventAckBatchMs = 200;
const maximumConnectionLeaseMs = 5 * 60_000;
const maximumHeartbeatClockSkewMs = 30_000;

/**
 * A request a person is waiting on in the app. It ends before the client's own
 * 30 s transport deadline (`packages/client/src/connections/host-transport.ts`),
 * so the person reads that the computer was slow rather than that the
 * Deployment is unreachable.
 */
export const interactiveRunnerRequestTimeoutMs = 20_000;

interface AuxiliaryStream {
  readonly admittedAt: number;
  readonly auxiliaryStreamId: RunnerAuxiliaryStreamId;
  readonly fence: RunnerAuxiliaryFrameFence;
  readonly identity: RunnerIdentity;
  readonly module: RunnerAuxiliaryModule;
  readonly peer: RunnerAuxiliaryPeer;
  detached: boolean;
  lastHeartbeatSentAt: number | undefined;
  leaseExpiresAt: number;
  leaseTimer: NodeJS.Timeout | undefined;
}

export class RunnerRegistry {
  readonly #hooks: RunnerRegistryHooks;
  readonly #commandAckTimeoutMs: number;
  readonly #connectionLeaseMs: number;
  readonly #executionLeaseMs: number;
  readonly #now: () => number;
  readonly #byRunner = new Map<RunnerId, RunnerConnection>();
  readonly #auxiliaryByPeer = new Map<string, AuxiliaryStream>();
  readonly #byEnvironment = new Map<EnvironmentId, RunnerConnection>();
  readonly #byPeer = new Map<string, RunnerConnection>();
  // A cancellation fence exists only while its interrupt dispatch is in flight,
  // or while the exact execution remains owned by this live connection. Durable
  // Host state prevents a fresh execute after authority was revoked; this fence
  // only closes the concurrent dispatch interval and therefore needs no TTL.
  readonly #canceledRuns = new Map<
    RunId,
    { active: boolean; pendingInterrupts: number; threadId: string }
  >();
  readonly #canceledTriggerOccurrences = new Map<
    TriggerOccurrenceId,
    { active: boolean; pendingInterrupts: number }
  >();
  readonly #hookOperations = new Set<Promise<unknown>>();
  readonly #revokedRunnerIds = new Set<RunnerId>();
  readonly #lifetime = new AbortController();
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: RunnerRegistryOptions) {
    this.#hooks = options.hooks;
    this.#commandAckTimeoutMs = options.commandAckTimeoutMs ?? 15_000;
    this.#connectionLeaseMs = options.connectionLeaseMs ?? defaultConnectionLeaseMs;
    if (this.#connectionLeaseMs < 1 || this.#connectionLeaseMs > maximumConnectionLeaseMs) {
      throw new Error("Runner connection lease must be between 1ms and five minutes");
    }
    this.#now = options.now ?? Date.now;
    this.#executionLeaseMs = options.executionLeaseMs ?? defaultExecutionLeaseMs;
  }

  async register(identity: RunnerIdentity, peer: RunnerPeer): Promise<RunnerIdentity> {
    this.#assertOpen();
    if (this.#revokedRunnerIds.has(identity.runnerId)) {
      throw new OpensteerError({ code: "forbidden", message: "Runner identity is revoked" });
    }
    if (this.#byPeer.has(peer.id)) {
      throw new OpensteerError({ code: "conflict", message: "Runner peer is already registered" });
    }
    await this.#runHook(() => this.#hooks.authorize(identity));
    this.#assertOpen();
    if (this.#revokedRunnerIds.has(identity.runnerId)) {
      throw new OpensteerError({ code: "forbidden", message: "Runner identity is revoked" });
    }
    for (const environmentId of identity.environmentIds) {
      const owner = this.#byEnvironment.get(environmentId);
      if (owner && owner.identity.runnerId !== identity.runnerId) {
        throw new OpensteerError({
          code: "conflict",
          message: `Execution environment ${environmentId} already belongs to another Runner`,
        });
      }
    }

    const prior = this.#byRunner.get(identity.runnerId);
    if (prior) {
      if (prior.identity.connectionGeneration >= identity.connectionGeneration) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Runner connection generation is stale",
        });
      }
      const sameBoot = prior.identity.bootId === identity.bootId;
      await this.#disconnect(
        prior,
        new Error(sameBoot ? "Runner reconnected" : "Runner reconnected with a new boot"),
        4001,
        sameBoot ? "superseded" : "replaced",
      );
      this.#assertOpen();
    }
    const settled = deferred<void>();
    const now = this.#now();
    const connection: RunnerConnection = {
      attached: false,
      auxiliaryStreams: new Map(),
      eventAckTimer: undefined,
      eventAcks: new Map(),
      authenticatedAt: now,
      disconnected: { promise: settled.promise, resolve: () => settled.resolve() },
      identity,
      inFlightCatalogs: new Map(),
      catalogCache: new Map(),
      preparingHarnesses: new Set(),
      catalogGeneration: 0,
      catalogRequestRevision: 0,
      lastHeartbeatSentAt: undefined,
      lastSeenAt: now,
      leaseExpiresAt: now + this.#connectionLeaseMs,
      leaseTimer: undefined,
      readiness: new Map(),
      reconciliationTail: Promise.resolve(),
      revokedRunIds: new Set(),
      peer,
      pendingAcks: new Map(),
      pendingCatalogs: new Map(),
      pendingHarnessAuthentications: new Map(),
      pendingModelServers: new Map(),
      pendingVoice: new Map(),
      pendingTriggerPrograms: new Map(),
      pendingWorkspaceLocal: new Map(),
      ownedRunIds: new Set(),
      ownedRunBindings: new Map(),
      ownedTriggerOccurrenceIds: new Set(),
      observedRunIds: new Set(),
      observedTriggerOccurrenceIds: new Set(),
    };
    connection.leaseTimer = this.#leaseTimer(connection);
    this.#byRunner.set(identity.runnerId, connection);
    this.#byPeer.set(peer.id, connection);
    for (const environmentId of identity.environmentIds)
      this.#byEnvironment.set(environmentId, connection);
    try {
      await peer.send({
        ...identity.fence,
        allowedModules: [...identity.allowedModules],
        connectionLeaseExpiresAt: new Date(connection.leaseExpiresAt).toISOString(),
        environmentIds: [...identity.environmentIds],
        // Several renewals fit in one execution lease, so one lost heartbeat
        // never costs a Run its lease.
        heartbeatIntervalMs: Math.min(15_000, Math.floor(this.#executionLeaseMs / 4)),
        serverTime: new Date(now).toISOString(),
        type: "host.welcome",
      });
    } catch (error) {
      await this.#disconnect(
        connection,
        error instanceof Error ? error : new Error("Runner welcome failed", { cause: error }),
        1011,
      );
      throw error;
    }
    if (this.#byPeer.get(peer.id) !== connection) {
      throw new OpensteerError({
        code: "conflict",
        message: "Runner disconnected before registration completed",
      });
    }
    if (this.#hooks.onRegistered) {
      void this.#runHook(() => this.#hooks.onRegistered?.(identity)).catch(() => undefined);
    }
    return identity;
  }

  identityForEnvironment(environmentId: EnvironmentId): RunnerIdentity | undefined {
    return this.#byEnvironment.get(environmentId)?.identity;
  }

  identityForRunner(runnerId: RunnerId): RunnerIdentity | undefined {
    return this.#byRunner.get(runnerId)?.identity;
  }

  isAvailable(environmentId: EnvironmentId): boolean {
    return this.#byEnvironment.has(environmentId);
  }

  /**
   * Whether durable commands may be sent to the environment's Runner: it is
   * connected and the Host has settled which Runs it carried over.
   */
  isAttached(environmentId: EnvironmentId): boolean {
    return this.#byEnvironment.get(environmentId)?.attached === true;
  }

  /**
   * Whether the environment's Runner can take another Run beside `dispatching`
   * Runs already on their way to it. Runs dispatched to it and not yet ended
   * count against the capacity it advertised, so a Run waiting on a person
   * holds a place on its own Runner and nowhere else.
   */
  hasRunCapacity(environmentId: EnvironmentId, dispatching = 0): boolean {
    const connection = this.#byEnvironment.get(environmentId);
    if (!connection?.attached) return false;
    const capacity = connection.identity.modules.agents?.maxConcurrentRuns ?? 1;
    return connection.ownedRunIds.size + dispatching < capacity;
  }

  isRunnerConnected(runnerId: RunnerId): boolean {
    return this.#byRunner.has(runnerId);
  }

  /**
   * What a module last said about itself on the connection that is current
   * right now. A Runner that has connected but reported nothing is `undefined`,
   * which routing must read as "not yet", never as "ready".
   */
  moduleReadiness(runnerId: RunnerId, module: RunnerModuleName): RunnerModuleReadiness | undefined {
    const connection = this.#byRunner.get(runnerId);
    if (!connection || connection.leaseExpiresAt <= this.#now()) return undefined;
    return connection.readiness.get(module)?.readiness;
  }

  /**
   * The Runners that can serve this module now. `unavailable` drops out at
   * once and without touching the connection generation: a module failing is
   * not the machine's identity changing, and forcing a reconnect for it would
   * take the machine's other modules down with it.
   */
  runnersForModule(module: RunnerModuleName): readonly RunnerIdentity[] {
    const now = this.#now();
    const identities: RunnerIdentity[] = [];
    for (const connection of this.#byRunner.values()) {
      if (connection.leaseExpiresAt <= now) continue;
      if (connection.identity.modules[module] === undefined) continue;
      const readiness = connection.readiness.get(module)?.readiness;
      if (readiness === undefined || readiness === "unavailable") continue;
      identities.push(connection.identity);
    }
    return identities.sort((left, right) => left.runnerId.localeCompare(right.runnerId));
  }

  /**
   * Admits a stream beside the primary connection.
   *
   * The ticket says which primary connection asked for it, and that has to be
   * the connection that is live now — not merely some connection of the same
   * Runner. Without this check a ticket minted before a reconnect would open a
   * stream alongside the replacement, and the Host would be relaying for a boot
   * that no longer holds the machine.
   */
  admitAuxiliary(input: {
    readonly claims: RunnerAuxiliaryTicketClaims;
    readonly module: RunnerAuxiliaryModule;
    readonly peer: RunnerAuxiliaryPeer;
  }): RunnerAuxiliaryStream {
    this.#assertOpen();
    if (input.claims.module !== input.module) {
      throw new OpensteerError({
        code: "forbidden",
        message: "The auxiliary ticket was issued for another module",
      });
    }
    const connection = this.#byRunner.get(input.claims.runnerId);
    if (!connection || connection.leaseExpiresAt <= this.#now()) {
      throw new OpensteerError({
        code: "conflict",
        message: "The Runner has no live primary connection",
        retryable: true,
      });
    }
    if (
      connection.identity.bootId !== input.claims.bootId ||
      connection.identity.connectionId !== input.claims.connectionId ||
      connection.identity.connectionGeneration !== input.claims.connectionGeneration
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "The auxiliary ticket names a superseded primary connection",
      });
    }
    if (connection.identity.modules[input.module] === undefined) {
      throw new OpensteerError({
        code: "forbidden",
        message: `The Runner does not advertise the ${input.module} module`,
      });
    }
    if (this.#auxiliaryByPeer.has(input.peer.id)) {
      throw new OpensteerError({ code: "conflict", message: "Auxiliary peer is already admitted" });
    }
    const now = this.#now();
    const auxiliaryStreamId = `rax_${randomUUID()}` as RunnerAuxiliaryStreamId;
    const stream: AuxiliaryStream = {
      admittedAt: now,
      auxiliaryStreamId,
      detached: false,
      fence: { ...connection.identity.fence, auxiliaryStreamId, module: input.module },
      identity: connection.identity,
      lastHeartbeatSentAt: undefined,
      leaseExpiresAt: now + this.#connectionLeaseMs,
      leaseTimer: undefined,
      module: input.module,
      peer: input.peer,
    };
    stream.leaseTimer = this.#auxiliaryLeaseTimer(stream);
    const previous = connection.auxiliaryStreams.get(input.module);
    connection.auxiliaryStreams.set(input.module, stream);
    this.#auxiliaryByPeer.set(input.peer.id, stream);
    if (previous && previous.peer !== input.peer) {
      this.#removeAuxiliary(previous, "superseded");
      previous.peer.close(4001, "auxiliary stream superseded");
    }
    return auxiliarySnapshot(stream);
  }

  /** The admitted stream this frame belongs to, or a refusal. */
  assertAuxiliaryFence(
    peer: RunnerAuxiliaryPeer,
    fence: RunnerAuxiliaryFrameFence,
  ): RunnerAuxiliaryStream {
    const stream = this.#auxiliaryByPeer.get(peer.id);
    if (!stream || stream.peer !== peer) {
      throw new OpensteerError({
        code: "forbidden",
        message: "The auxiliary stream is not admitted",
      });
    }
    if (stream.leaseExpiresAt <= this.#now()) {
      throw new OpensteerError({ code: "conflict", message: "The auxiliary stream lease expired" });
    }
    if (
      stream.fence.auxiliaryStreamId !== fence.auxiliaryStreamId ||
      stream.fence.module !== fence.module ||
      !sameRunnerConnectionFence(stream.fence, fence)
    ) {
      throw new OpensteerError({ code: "conflict", message: "The auxiliary fence is stale" });
    }
    return auxiliarySnapshot(stream);
  }

  heartbeatAuxiliary(peer: RunnerAuxiliaryPeer, sentAt: string): RunnerAuxiliaryStream {
    const stream = this.#auxiliaryByPeer.get(peer.id);
    if (!stream || stream.peer !== peer) {
      throw new OpensteerError({
        code: "forbidden",
        message: "The auxiliary stream is not admitted",
      });
    }
    const now = this.#now();
    const sent = Date.parse(sentAt);
    if (
      !Number.isFinite(sent) ||
      sent < stream.admittedAt - maximumHeartbeatClockSkewMs ||
      sent > now + maximumHeartbeatClockSkewMs ||
      (stream.lastHeartbeatSentAt !== undefined && sent <= stream.lastHeartbeatSentAt)
    ) {
      throw new OpensteerError({
        code: "bad_request",
        message: "The auxiliary heartbeat timestamp is invalid",
      });
    }
    stream.lastHeartbeatSentAt = sent;
    stream.leaseExpiresAt = Math.max(now + this.#connectionLeaseMs, stream.leaseExpiresAt + 1);
    if (stream.leaseTimer) clearTimeout(stream.leaseTimer);
    stream.leaseTimer = this.#auxiliaryLeaseTimer(stream);
    return auxiliarySnapshot(stream);
  }

  detachAuxiliary(peer: RunnerAuxiliaryPeer): void {
    const stream = this.#auxiliaryByPeer.get(peer.id);
    if (!stream || stream.peer !== peer) return;
    this.#removeAuxiliary(stream, "transport-disconnected");
  }

  #removeAuxiliary(stream: AuxiliaryStream, reason: RunnerStreamLossReason): void {
    if (stream.detached) return;
    stream.detached = true;
    if (stream.leaseTimer) clearTimeout(stream.leaseTimer);
    if (this.#auxiliaryByPeer.get(stream.peer.id) === stream) {
      this.#auxiliaryByPeer.delete(stream.peer.id);
    }
    const connection = this.#byRunner.get(stream.identity.runnerId);
    if (connection?.auxiliaryStreams.get(stream.module) === stream) {
      connection.auxiliaryStreams.delete(stream.module);
    }
    try {
      this.#hooks.onAuxiliaryLost?.(auxiliarySnapshot(stream), reason);
    } catch {
      // A module observer cannot prevent identity cleanup.
    }
  }

  #auxiliaryLeaseTimer(stream: AuxiliaryStream): NodeJS.Timeout {
    const timer = setTimeout(
      () => {
        if (stream.detached || stream.leaseExpiresAt > this.#now()) return;
        this.#removeAuxiliary(stream, "lease-expired");
        stream.peer.close(4003, "auxiliary stream lease expired");
      },
      Math.max(1, stream.leaseExpiresAt - this.#now()),
    );
    timer.unref();
    return timer;
  }

  #leaseTimer(connection: RunnerConnection): NodeJS.Timeout {
    const timer = setTimeout(
      () => {
        if (
          this.#byPeer.get(connection.peer.id) !== connection ||
          connection.leaseExpiresAt > this.#now()
        ) {
          return;
        }
        void this.#disconnect(connection, new Error("Runner connection lease expired"), 4003).catch(
          () => undefined,
        );
      },
      Math.max(1, connection.leaseExpiresAt - this.#now()),
    );
    timer.unref();
    return timer;
  }

  /**
   * Every post-authentication frame repeats the fence. A socket that is open
   * but writing for a superseded connection is exactly the case a lease cannot
   * catch, because it is talking.
   */
  #assertFence(connection: RunnerConnection, fence: RunnerConnectionFence): void {
    if (connection.leaseExpiresAt <= this.#now()) {
      throw new OpensteerError({ code: "conflict", message: "Runner connection lease expired" });
    }
    if (!sameRunnerConnectionFence(connection.identity.fence, fence)) {
      throw new OpensteerError({ code: "conflict", message: "Runner connection fence is stale" });
    }
  }

  /**
   * Drops every connection that was admitted over the remote-access route, and
   * remembers nothing.
   *
   * The Personal answer to a remote-access change: the route those computers
   * arrived on is gone, so the connections standing on it are gone with it and
   * their shell sessions end as a disconnection. Unlike `revoke`, no identity
   * is retired and no id is remembered — each of them reconnects by itself the
   * moment a route exists again.
   *
   * The set is named by the admission fence rather than by Runner kind, because
   * that is exactly the set the store admitted under a route generation — the
   * same set `confirmRunnerRegistration` fences, so the two mechanisms cannot
   * disagree about who this change is about. A null fence means the connection
   * reached the Host without a route: the Main Runner, which is the machine the
   * change was made on, and the services the Deployment supervises beside its
   * Host on that same machine.
   */
  async disconnectRouteAdmittedRunners(reason: string): Promise<void> {
    await Promise.all(
      [...this.#byRunner.values()]
        .filter((connection) => connection.identity.personalRemoteAccessGeneration !== null)
        // Not the revoked code: every session riding this connection would then
        // end as `machine-revoked` rather than as the disconnection this is.
        .map((connection) => this.#disconnect(connection, new Error(reason), 1001)),
    );
  }

  /**
   * Drops one named connection, if it is still the one that is connected.
   *
   * Named by `connectionId` rather than by Runner, because the caller is
   * usually reacting to something it learned about a connection and the Runner
   * may have reconnected since: dropping whatever is there now would take away
   * a connection nobody judged. Nothing is remembered — this is not a
   * revocation — so the Runner is free to come straight back.
   */
  async disconnectConnection(
    identity: Pick<RunnerIdentity, "connectionId" | "runnerId">,
    options: { readonly code: number; readonly reason: string },
  ): Promise<boolean> {
    const connection = this.#byRunner.get(identity.runnerId);
    if (!connection || connection.identity.connectionId !== identity.connectionId) return false;
    await this.#disconnect(connection, new Error(options.reason), options.code);
    return true;
  }

  async revoke(runnerId: RunnerId): Promise<void> {
    this.#revokedRunnerIds.add(runnerId);
    const connection = this.#byRunner.get(runnerId);
    if (connection) {
      await this.#disconnect(
        connection,
        new Error(runnerIdentityRevokedMessage),
        runnerIdentityRevokedCloseCode,
      );
    }
  }

  isHarnessPreparing(environmentId: EnvironmentId, harnessInstanceId: HarnessInstanceId): boolean {
    return (
      this.#byEnvironment.get(environmentId)?.preparingHarnesses.has(harnessInstanceId) ?? false
    );
  }

  canRunHarness(environmentId: EnvironmentId, driverKind: HarnessId): boolean {
    const connection = this.#byEnvironment.get(environmentId);
    if (!connection || connection.readiness.get("agents")?.readiness === "unavailable") {
      return false;
    }
    const advertised = connection.identity.modules.agents?.harnessDrivers.find(
      (driver) => driver.driverKind === driverKind,
    );
    return advertised !== undefined && advertised.readiness !== "unavailable";
  }

  attachmentInputFailure(input: {
    readonly content: readonly ContentPart[];
    readonly driverKind: HarnessId;
    readonly environmentId: EnvironmentId;
    readonly harnessInstanceId: HarnessInstanceId;
    readonly modelSelection: ModelSelection;
    readonly steering?: boolean;
  }): string | null {
    const capabilities = this.#byEnvironment.get(input.environmentId)?.identity.capabilities;
    const placeFailure = capabilities ? placeInputFailure(input.content, capabilities) : null;
    if (placeFailure) return placeFailure;
    const parts = input.content.filter((part) => part.type === "artifact");
    if (parts.length === 0) return null;
    const connection = this.#byEnvironment.get(input.environmentId);
    const advertised = connection?.identity.modules.agents?.harnessDrivers.find(
      (driver) => driver.driverKind === input.driverKind,
    );
    if (!advertised || advertised.readiness === "unavailable" || !advertised.messageAttachments) {
      return "The selected Runner has not confirmed attachment delivery support";
    }
    const images = parts.filter((part) => part.mediaType.startsWith("image/"));
    if (images.length === 0) return null;
    const native = advertised.messageAttachments.nativeImages;
    if (!native) return "The selected AI engine does not support native image input";
    if (input.steering && !native.steering) {
      return "The selected AI engine does not support steering with images";
    }
    for (const image of images) {
      if (!native.mediaTypes.includes(image.mediaType)) {
        return `The selected AI engine does not support ${image.mediaType} images`;
      }
      if (image.sizeBytes === undefined || image.sizeBytes > native.maxBytes) {
        return `Image ${image.name} exceeds the selected AI engine's verified input size`;
      }
    }
    const catalog = connection?.catalogCache.get(input.harnessInstanceId)?.catalog;
    if (catalog?.status !== "ready") {
      return "The selected AI engine's image input capability is unverified";
    }
    const model = catalog.models.find(
      (candidate) =>
        candidate.providerId === input.modelSelection.providerId &&
        candidate.modelId === input.modelSelection.modelId,
    );
    if (!model || model.acceptsImages === undefined) {
      return "The selected model's image input capability is unverified";
    }
    if (!model.acceptsImages) return "The selected model does not accept images";
    return null;
  }

  supportsMessageAttachments(environmentId: EnvironmentId, driverKind: HarnessId): boolean {
    const advertised = this.#byEnvironment
      .get(environmentId)
      ?.identity.modules.agents?.harnessDrivers.find((driver) => driver.driverKind === driverKind);
    return advertised?.readiness !== "unavailable" && advertised?.messageAttachments !== undefined;
  }

  /**
   * Whether a tool result's image block would reach the model this work runs
   * on. Both halves have to say yes: the engine must render an MCP image
   * content block, and the selected model must read images.
   *
   * Every half is read from what the Runner advertised, and false when it said nothing, including when
   * it has reported no catalog for this account yet. A picture sent to an
   * engine that drops it, or to a model that cannot see it, is a picture
   * nobody saw and nobody can report; the caller says so in words instead.
   * This is the one place that decision is made.
   */
  rendersMcpImagesForModel(input: {
    readonly driverKind: HarnessId;
    readonly environmentId: EnvironmentId;
    readonly harnessInstanceId: HarnessInstanceId;
    readonly modelSelection: ModelSelection;
  }): boolean {
    const connection = this.#byEnvironment.get(input.environmentId);
    const advertised = connection?.identity.modules.agents?.harnessDrivers.find(
      (driver) => driver.driverKind === input.driverKind,
    );
    if (
      advertised === undefined ||
      advertised.readiness === "unavailable" ||
      advertised.mcpImageContent !== true
    ) {
      return false;
    }
    const catalog = connection?.catalogCache.get(input.harnessInstanceId)?.catalog;
    if (catalog?.status !== "ready") return false;
    // The canonical pair is what a selection and a descriptor are matched on
    // everywhere else, so it is what they are matched on here.
    const model = catalog.models.find(
      (candidate) =>
        candidate.providerId === input.modelSelection.providerId &&
        candidate.modelId === input.modelSelection.modelId,
    );
    return model?.acceptsImages === true;
  }

  /**
   * The Thread access modes this engine advertises here, or undefined when it
   * has not said — the environment is away, or the driver cannot run. Undefined
   * is not "none": the Host refuses a mode an engine declares it cannot
   * enforce, and silence is not a declaration.
   */
  harnessAccessModes(
    environmentId: EnvironmentId,
    driverKind: HarnessId,
  ): readonly ThreadAccessMode[] | undefined {
    const advertised = this.#byEnvironment
      .get(environmentId)
      ?.identity.modules.agents?.harnessDrivers.find((driver) => driver.driverKind === driverKind);
    if (!advertised || advertised.readiness === "unavailable") return undefined;
    return advertised.accessModes;
  }

  /**
   * Hands the Runner the environment's complete desired profile set. This is
   * the destructive direction: the Runner closes every profile absent from the
   * list, so only a caller holding the whole set may use it.
   *
   * Reconciliations are serialized against one another because they disagree —
   * two overlapping full sets must land in a defined order — and against
   * nothing else. The result still fills the shared catalog cache, so a
   * read-only inspection of the same set right afterwards costs no round trip.
   */
  async reconcileHarnesses(
    environmentId: EnvironmentId,
    harnesses: HarnessCatalogRequestDefinitions,
    signal: AbortSignal,
  ): Promise<readonly HarnessInstanceCatalog[]> {
    const connection = this.#byEnvironment.get(environmentId);
    if (!connection) return [];
    const priorReconciliation = connection.reconciliationTail;
    // The gate exists before the wait so that abandoning the wait can still
    // release it. A caller that gives up must not leave the queue stalled.
    const gate = deferred<void>();
    connection.reconciliationTail = priorReconciliation.then(() => gate.promise);
    // The queue wait is the caller's wait. Ignoring the signal here meant a
    // request that had already given up still held its place in line and still
    // sent its reconciliation when it reached the front.
    try {
      await withAbort(priorReconciliation, signal);
    } catch (error) {
      gate.resolve();
      throw error;
    }
    try {
      // Deliberately never served from the cache: a reconciliation is an
      // instruction to the Runner, not a question, so it must reach the wire.
      return await this.#requestCatalogs(connection, harnesses, "host.reconcile-harnesses", signal);
    } finally {
      gate.resolve();
    }
  }

  /**
   * Reads what a subset of profiles currently offers, changing nothing. Cached
   * answers are served before any queue is entered, and concurrent callers
   * asking the identical question share one round trip.
   */
  async inspectHarnesses(
    environmentId: EnvironmentId,
    harnesses: HarnessCatalogRequestDefinitions,
    signal: AbortSignal,
    options?: { readonly fresh: boolean },
  ): Promise<readonly HarnessInstanceCatalog[]> {
    const connection = this.#byEnvironment.get(environmentId);
    if (!connection) return [];
    return await Promise.all(
      harnesses.map(async (harness) => {
        const cached = options?.fresh ? undefined : this.#cachedCatalog(connection, harness);
        if (cached) return cached;
        const catalogs = await this.#requestCatalogs(
          connection,
          [harness],
          "host.inspect-harnesses",
          signal,
        );
        const catalog = catalogs[0];
        if (!catalog) throw new Error("Runner returned no catalog for the requested AI account");
        return catalog;
      }),
    );
  }

  #cachedCatalog(
    connection: RunnerConnection,
    harness: HarnessCatalogRequestDefinitions[number],
  ): HarnessInstanceCatalog | undefined {
    const cached = connection.catalogCache.get(harness.id);
    return cached &&
      // A clock cannot sign an account in. Keep that answer until an explicit
      // refresh, profile revision, authentication action or Runner invalidation.
      (cached.catalog.status === "authentication-required" || cached.expiresAt > Date.now()) &&
      cached.fingerprint === catalogFingerprint([harness])
      ? cached.catalog
      : undefined;
  }

  /**
   * One catalog round trip, deduplicated by the exact set it asks about. A
   * caller that joins an in-flight request still races it against its own
   * signal, so joining never extends anybody's deadline.
   */
  async #requestCatalogs(
    connection: RunnerConnection,
    harnesses: HarnessCatalogRequestDefinitions,
    type: "host.inspect-harnesses" | "host.reconcile-harnesses",
    signal: AbortSignal,
  ): Promise<readonly HarnessInstanceCatalog[]> {
    const fingerprint = catalogFingerprint(harnesses);
    const definitionFingerprints = new Map(
      harnesses.map((harness) => [harness.id, catalogFingerprint([harness])]),
    );
    const generation = connection.catalogGeneration;
    const joined = connection.inFlightCatalogs.get(fingerprint);
    // A reconciliation always issues its own request; only a read may join one.
    if (joined && type === "host.inspect-harnesses") return await withAbort(joined, signal);
    const revision = ++connection.catalogRequestRevision;
    const requestId = CorrelationIdSchema.parse(`catalog:${randomUUID()}`);
    const pending = deferred<readonly HarnessInstanceCatalog[]>();
    connection.pendingCatalogs.set(requestId, {
      expected: new Map(harnesses.map((harness) => [harness.id, harness.driverKind])),
      reject: pending.reject,
      resolve: pending.resolve,
    });
    const capture = (async (): Promise<readonly HarnessInstanceCatalog[]> => {
      try {
        await connection.peer.send({
          ...connection.identity.fence,
          harnesses: [...harnesses],
          requestId,
          type,
        });
        // Catalog startup can include provider-owned index recovery. It belongs
        // to the attached Runner lifecycle, while each caller still races this
        // shared attempt against its own signal below.
        return await withAbort(pending.promise, this.#lifetime.signal);
      } finally {
        connection.pendingCatalogs.delete(requestId);
      }
    })();
    const attempt = capture.then((catalogs) => {
      if (connection.catalogGeneration !== generation) {
        throw new OpensteerError({
          code: "conflict",
          message: "Harness catalog changed while it was being read",
          reason: "harness-catalog-stale-read",
          retryable: true,
        });
      }
      const expiresAt = Date.now() + 30_000;
      return catalogs.map((catalog) => {
        const cached = connection.catalogCache.get(catalog.harnessInstanceId);
        if (cached && cached.revision > revision) return cached.catalog;
        if (catalog.status === "preparing") {
          connection.preparingHarnesses.add(catalog.harnessInstanceId);
        } else {
          connection.preparingHarnesses.delete(catalog.harnessInstanceId);
          const definitionFingerprint = definitionFingerprints.get(catalog.harnessInstanceId);
          if (!definitionFingerprint) {
            throw new Error("Runner returned a catalog for an unrequested AI account");
          }
          connection.catalogCache.set(catalog.harnessInstanceId, {
            catalog,
            expiresAt,
            fingerprint: definitionFingerprint,
            revision,
          });
        }
        return catalog;
      });
    });
    // Nothing must observe an unhandled rejection on the shared promise while
    // its only awaiters are racing it.
    attempt.catch(() => undefined);
    if (!joined) {
      connection.inFlightCatalogs.set(fingerprint, attempt);
      const forget = () => {
        if (connection.inFlightCatalogs.get(fingerprint) === attempt) {
          connection.inFlightCatalogs.delete(fingerprint);
        }
      };
      void attempt.then(forget, forget);
    }
    return await withAbort(attempt, signal);
  }

  catalogForHarness(
    environmentId: EnvironmentId,
    harnessInstanceId: string,
  ): HarnessInstanceCatalog | undefined {
    return this.#byEnvironment.get(environmentId)?.catalogCache.get(harnessInstanceId)?.catalog;
  }

  async manageHarnessAuthentication(
    environmentId: EnvironmentId,
    request: Extract<
      HostToRunnerMessage,
      { readonly type: "host.harness-authentication" }
    >["request"],
    signal: AbortSignal,
  ): Promise<HarnessAuthenticationState> {
    const connection = this.#byEnvironment.get(environmentId);
    if (!connection) {
      throw new OpensteerError({
        code: "conflict",
        message: "The selected Runner is not connected",
        retryable: true,
      });
    }
    const target =
      request.action === "start" || request.action === "logout" || request.action === "remove"
        ? { driverKind: request.harness.driverKind, harnessInstanceId: request.harness.id }
        : request;
    const requestId = CorrelationIdSchema.parse(`harness-auth:${randomUUID()}`);
    const pending = deferred<HarnessAuthenticationState>();
    connection.pendingHarnessAuthentications.set(requestId, {
      driverKind: target.driverKind,
      harnessInstanceId: target.harnessInstanceId,
      reject: pending.reject,
      resolve: pending.resolve,
    });
    try {
      // The deadline covers sending too: a socket backed up behind other
      // frames is as slow, to the person waiting, as a Runner that is.
      const state = await withDeadline(
        connection.peer
          .send({
            ...connection.identity.fence,
            request,
            requestId,
            type: "host.harness-authentication",
          })
          .then(() => pending.promise),
        interactiveRunnerRequestTimeoutMs,
        signal,
        "This computer didn't answer in time. Try again.",
      );
      connection.catalogCache.delete(target.harnessInstanceId);
      return state;
    } finally {
      connection.pendingHarnessAuthentications.delete(requestId);
    }
  }

  async voice(
    environmentId: EnvironmentId,
    userId: UserId,
    command: RunnerVoiceCommand,
    signal: AbortSignal,
  ): Promise<RunnerVoiceResult> {
    const connection = this.#byEnvironment.get(environmentId);
    if (!connection)
      throw new OpensteerError({
        code: "runner_offline",
        message: "This computer is not connected",
        retryable: true,
      });
    const agentSupported = connection.identity.capabilities.includes("voice-agent-v1");
    const requestedAgent = command.action === "start" && command.agent === true;
    if (!agentSupported && ["next", "answer", "context"].includes(command.action))
      throw new OpensteerError({
        code: "conflict",
        reason: "voice-ended",
        message: "This computer does not support voice agents.",
      });
    if (!connection.identity.capabilities.includes("voice-v1"))
      throw new OpensteerError({
        code: "conflict",
        reason: "voice-runner-unsupported",
        message: "Update Opensteer on this computer to use voice.",
      });
    if (command.action === "start" && !agentSupported) {
      const { agent: _agent, ...legacy } = command;
      command = legacy;
    }
    const requestId = CorrelationIdSchema.parse(`voice:${randomUUID()}`);
    const pending = deferred<RunnerVoiceResult>();
    connection.pendingVoice.set(requestId, pending);
    try {
      const result = await withDeadline(
        Promise.all([
          connection.peer.send({
            ...connection.identity.fence,
            type: "host.voice",
            requestId,
            userId,
            command,
          }),
          pending.promise,
        ]).then(([, result]) => result),
        command.action === "start" ? 30_000 : 10_000,
        signal,
        "This computer didn't answer the voice request in time.",
      );
      return requestedAgent && result.ok
        ? { ...result, agent: agentSupported && result.agent === true }
        : result;
    } finally {
      connection.pendingVoice.delete(requestId);
    }
  }

  /**
   * Asks the computer behind an environment which model servers it has, or
   * what the one at `address` is. The computer answers from its own settings
   * and loopback; nothing about a server's credential comes back.
   */
  async discoverModelServers(
    environmentId: EnvironmentId,
    address: string | undefined,
    signal: AbortSignal,
  ): Promise<readonly ModelServer[]> {
    const connection = this.#byEnvironment.get(environmentId);
    if (!connection) {
      throw new OpensteerError({
        code: "conflict",
        message: "This computer is not connected. Reconnect it, then look again.",
        retryable: true,
      });
    }
    if (!connection.identity.capabilities.includes("model-server-discovery-v1")) {
      throw new OpensteerError({
        code: "conflict",
        message: "Update Opensteer on this computer to find its model servers.",
      });
    }
    const requestId = CorrelationIdSchema.parse(`model-servers:${randomUUID()}`);
    const pending = deferred<readonly ModelServer[]>();
    connection.pendingModelServers.set(requestId, pending);
    try {
      return await withDeadline(
        connection.peer
          .send({
            ...connection.identity.fence,
            ...(address === undefined ? {} : { address }),
            requestId,
            type: "host.discover-model-servers",
          })
          .then(() => pending.promise),
        interactiveRunnerRequestTimeoutMs,
        signal,
        "This computer didn't answer in time. Try again.",
      );
    } finally {
      connection.pendingModelServers.delete(requestId);
    }
  }

  /**
   * Asks the machine that holds a local directory to act on it. Everything the
   * Host knows about that disk is second-hand, so the request is fenced to the
   * exact connection and storage authority it was written for, and the answer
   * is refused unless it echoes both back.
   */
  async requestWorkspaceLocal(
    environmentId: EnvironmentId,
    request: WorkspaceLocalRequest,
    signal: AbortSignal,
  ): Promise<RunnerWorkspaceLocalResult> {
    const connection = this.#byEnvironment.get(environmentId);
    if (!connection) {
      throw new OpensteerError({
        code: "workspace_unavailable",
        message: "That computer is not connected right now.",
        retryable: true,
      });
    }
    const authority = connection.identity.modules.agents?.localStorage?.storageAuthorityId;
    if (authority === undefined) {
      throw new OpensteerError({
        code: "workspace_unavailable",
        message: "That computer does not offer directories of its own.",
        retryable: true,
      });
    }
    if (authority !== request.binding.storageAuthorityId) {
      // The environment reconnected from a different disk. Answering from it
      // would report the original directory missing, or destroy the wrong one.
      throw new OpensteerError({
        code: "conflict",
        message: "That computer does not hold the disk this Workspace lives on.",
      });
    }
    const fence: WorkspaceStorageFence = {
      ...connection.identity.fence,
      environmentId,
      storageAuthorityId: authority,
    };
    const pending = deferred<RunnerWorkspaceLocalResult>();
    connection.pendingWorkspaceLocal.set(request.requestId, {
      operationId: request.operationId,
      reject: pending.reject,
      resolve: pending.resolve,
    });
    try {
      // A workspace-local request carries the connection fence inside its
      // storage fence, which also names the disk. Repeating the bare fence
      // beside it would be a second, weaker copy of the same statement.
      await connection.peer.send({ ...request, fence } as HostToRunnerMessage);
      const result = await withDeadline(
        pending.promise,
        this.#commandAckTimeoutMs * 2,
        signal,
        "The machine holding this Workspace did not answer in time",
      );
      if (
        !sameRunnerConnectionFence(result.fence, fence) ||
        result.fence.environmentId !== fence.environmentId ||
        result.fence.storageAuthorityId !== fence.storageAuthorityId
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: "The machine answered for another connection or another disk.",
        });
      }
      return result;
    } finally {
      connection.pendingWorkspaceLocal.delete(request.requestId);
    }
  }

  /**
   * Sends a durable command and resolves when the Runner accepts it. A caller
   * that prepared the command for one connection names its generation: a
   * command meant for a connection that has since been replaced is never sent
   * on the replacement, whose attach may already have settled the same Run.
   */
  async dispatch(
    command: RunnerCommand,
    signal: AbortSignal,
    options: {
      /** Runs when the Runner accepts, before the receipt is released. */
      readonly beforeAck?: () => Promise<void>;
      /**
       * The caller's last authority check. It runs once this connection holds
       * the Run, so an interrupt dispatched meanwhile keeps its fence, and the
       * command is written straight after it with nothing in between.
       */
      readonly beforeSend?: () => Promise<void>;
      readonly connectionGeneration?: number;
    } = {},
  ): Promise<RunnerCommandReceipt> {
    const { beforeAck, beforeSend, connectionGeneration } = options;
    RunnerCommandSchema.parse(command);
    const current = this.#byEnvironment.get(command.environmentId);
    const connection =
      current?.attached &&
      (connectionGeneration === undefined ||
        current.identity.connectionGeneration === connectionGeneration)
        ? current
        : undefined;
    let runCancellation:
      { active: boolean; pendingInterrupts: number; threadId: string } | undefined;
    let triggerCancellation: { active: boolean; pendingInterrupts: number } | undefined;
    if (command.type === "run.interrupt") {
      const existing = this.#canceledRuns.get(command.runId);
      if (existing && existing.threadId !== command.threadId) {
        throw new CommandDispatchError("Run cancellation targets a different Thread", "failed");
      }
      runCancellation = existing ?? {
        active: false,
        pendingInterrupts: 0,
        threadId: command.threadId,
      };
      runCancellation.pendingInterrupts += 1;
      runCancellation.active ||= Boolean(
        connection &&
        (connection.ownedRunIds.has(command.runId) || connection.observedRunIds.has(command.runId)),
      );
      this.#canceledRuns.set(command.runId, runCancellation);
    } else if (command.type === "trigger.interrupt") {
      triggerCancellation = this.#canceledTriggerOccurrences.get(command.occurrenceId) ?? {
        active: false,
        pendingInterrupts: 0,
      };
      triggerCancellation.pendingInterrupts += 1;
      triggerCancellation.active ||= Boolean(
        connection &&
        (connection.ownedTriggerOccurrenceIds.has(command.occurrenceId) ||
          connection.observedTriggerOccurrenceIds.has(command.occurrenceId) ||
          connection.pendingTriggerPrograms.has(command.occurrenceId)),
      );
      this.#canceledTriggerOccurrences.set(command.occurrenceId, triggerCancellation);
    } else if (command.type === "run.execute") {
      if (this.#canceledRuns.delete(command.context.runId)) {
        throw new CommandDispatchError("Run execution authority was revoked", "retry");
      }
    } else if (
      command.type === "trigger.execute" &&
      this.#canceledTriggerOccurrences.delete(command.context.occurrenceId)
    ) {
      throw new CommandDispatchError("Trigger execution authority was revoked", "failed");
    }
    if (!connection) {
      // A Trigger program ends with its connection, so there is nothing left to
      // interrupt. A Run outlives it on its lease: its interrupt waits for the
      // Runner to return, and the Run's end settles it if the Runner never does.
      if (command.type === "trigger.interrupt") {
        this.#releaseCancellation(command, runCancellation, triggerCancellation);
        return {
          commandId: command.commandId,
          correlationId: command.correlationId,
          type: "runner.command-accepted",
        };
      }
      // An offline Runner has no running turn to steer. Failing here rather
      // than retrying lets the Host requeue the message as an ordered turn.
      if (command.type === "run.steer") {
        throw new CommandDispatchError("Runner is offline", "failed");
      }
      this.#releaseCancellation(command, runCancellation, triggerCancellation);
      throw new CommandDispatchError("Runner is offline", "retry");
    }
    if (
      command.type === "run.execute" &&
      !this.canRunHarness(command.environmentId, command.context.harness.driverKind)
    ) {
      throw new CommandDispatchError(
        `Runner cannot execute harness driver ${command.context.harness.driverKind}`,
        "failed",
      );
    }
    const runId = command.type === "run.execute" ? command.context.runId : undefined;
    const occurrenceId =
      command.type === "trigger.execute" ? command.context.occurrenceId : undefined;
    const ack = deferred<RunnerCommandAccepted>();
    // A disconnect can reject it before anything awaits it, during the
    // caller's authority check or a failed send; the await below still sees it.
    void ack.promise.catch(() => undefined);
    connection.pendingAcks.set(command.commandId, {
      ...ack,
      commandType: command.type,
      ...(beforeAck ? { beforeAck } : {}),
      ...(runId ? { runId } : {}),
      ...(occurrenceId ? { triggerOccurrenceId: occurrenceId } : {}),
    });
    // A Trigger program's dispatch lasts until its result. A Run's ends when the
    // Runner accepts it: its outcome arrives as events, and a Run that waits on
    // a person must not hold a Host dispatch slot while it does.
    const completion = occurrenceId ? deferred<void>() : undefined;
    // A disconnect can reject both lifecycle stages while dispatch is still
    // awaiting acknowledgement. Observe the later completion rejection now;
    // awaiting the original Promise below still receives the same error.
    if (completion) void completion.promise.catch(() => undefined);
    if (runId && command.type === "run.execute") {
      // A revocation named the execution this one replaces; reports from that
      // one are told apart by their binding from now on.
      connection.revokedRunIds.delete(runId);
      connection.ownedRunIds.add(runId);
      connection.ownedRunBindings.set(runId, {
        bindingGeneration: command.context.bindingGeneration,
        environmentId: command.context.environmentId,
        threadId: command.context.threadId,
        workspaceId: command.context.workspaceId,
      });
    }
    if (completion && occurrenceId) {
      connection.pendingTriggerPrograms.set(occurrenceId, completion);
      connection.ownedTriggerOccurrenceIds.add(occurrenceId);
    }
    let sent = false;
    let checked = !beforeSend;
    try {
      if (beforeSend) await beforeSend();
      checked = true;
      // Never sent, so its Run is settled as one no Runner holds: requeued,
      // or ended if it was stopped.
      if (runId && this.#canceledRuns.delete(runId)) {
        throw new CommandDispatchError("Run execution authority was revoked", "retry");
      }
      // The connection may have gone while the caller checked.
      if (this.#byPeer.get(connection.peer.id) !== connection) {
        throw new CommandDispatchError("Runner is offline", "retry");
      }
      throwIfAborted(signal, "Aborted");
      sent = true;
      await connection.peer.send({
        ...connection.identity.fence,
        command,
        type: "host.command",
      });
      const accepted = await withDeadline(
        ack.promise,
        this.#commandAckTimeoutMs,
        signal,
        "Runner command acknowledgement timed out",
      );
      if (completion) await withAbort(completion.promise, signal);
      return accepted;
    } catch (error) {
      if (completion && occurrenceId) connection.pendingTriggerPrograms.delete(occurrenceId);
      // A Run never sent was never this Runner's; a Run that may have arrived
      // stays held until the next attach says whether the Runner has it.
      if (runId && !sent) {
        connection.ownedRunIds.delete(runId);
        connection.ownedRunBindings.delete(runId);
        this.#deactivateRunCancellation(runId);
      }
      if (error instanceof CommandDispatchError) throw error;
      // The caller's own refusal: nothing was sent, so the command is retried,
      // and settles as unsent work under whatever authority stands by then.
      if (!checked) {
        throw new CommandDispatchError(
          error instanceof Error ? error.message : "Runner dispatch was refused",
          "retry",
          { cause: error },
        );
      }
      // Once bytes may have crossed the socket, a missing acknowledgement is
      // not a retryable command failure; it means this connection can no
      // longer establish execution ownership. Eject it so the exact owned set
      // enters disconnect recovery instead of leaving a starting Run stranded
      // behind an otherwise healthy heartbeat stream.
      if (sent && !signal.aborted && this.#byPeer.get(connection.peer.id) === connection) {
        void this.#disconnect(
          connection,
          error instanceof Error
            ? error
            : new Error("Runner command acknowledgement failed", { cause: error }),
          1011,
        );
      }
      throw new CommandDispatchError(
        error instanceof Error ? error.message : "Runner dispatch failed",
        sent ? "uncertain" : "retry",
        { cause: error },
      );
    } finally {
      connection.pendingAcks.delete(command.commandId);
      this.#releaseCancellation(command, runCancellation, triggerCancellation);
    }
  }

  async reconcileWatches(
    environmentId: EnvironmentId,
    reconcileGeneration: number,
    desired: readonly WatchReconcileActivation[],
    signal: AbortSignal,
  ): Promise<void> {
    await this.dispatch(
      {
        commandId: createId("command"),
        correlationId: CorrelationIdSchema.parse(`watch:${randomUUID()}`),
        desired: [...desired],
        environmentId,
        reconcileGeneration,
        type: "watch.reconcile",
      },
      signal,
      { beforeAck: async () => undefined },
    );
  }

  async handle(peer: RunnerPeer, message: RunnerOperationalMessage): Promise<void> {
    this.#assertOpen();
    const connection = this.#byPeer.get(peer.id);
    if (!connection)
      throw new OpensteerError({ code: "forbidden", message: "Runner is not registered" });
    this.#assertFence(connection, connectionFenceOf(message));
    connection.lastSeenAt = this.#now();
    switch (message.type) {
      case "runner.auxiliary.ticket-request":
        await this.#runHook(async () => {
          const ticket = await this.#hooks.issueAuxiliaryTicket?.(
            connection.identity,
            message.module,
          );
          if (!ticket) {
            throw new OpensteerError({
              code: "conflict",
              message: "This Host cannot issue auxiliary tickets",
            });
          }
          await connection.peer.send({
            ...connection.identity.fence,
            expiresAt: ticket.expiresAt,
            module: message.module,
            requestId: message.requestId,
            ticket: ticket.ticket,
            type: "host.auxiliary.ticket",
          });
        });
        break;
      case "runner.grants.refresh":
        await this.#runHook(async () => {
          // A store that cannot answer now ends neither the Run's tools nor
          // this connection; the Runner asks again.
          const result = await Promise.resolve()
            .then(() => this.#hooks.refreshRunCredentials?.(connection.identity, message.runId))
            .then(
              (answer) => answer ?? ({ status: "refused" } as const),
              () => ({ status: "unavailable" }) as const,
            );
          await connection.peer.send({
            ...connection.identity.fence,
            requestId: message.requestId,
            result,
            runId: message.runId,
            type: "host.grants.credentials",
          });
        });
        break;
      case "runner.shell.full-disk-access": {
        const shell = connection.identity.modules.shell;
        if (!shell || shell.platform !== "darwin") {
          throw new OpensteerError({
            code: "forbidden",
            message: "Runner reported Full Disk Access without a macOS shell module",
          });
        }
        connection.identity = {
          ...connection.identity,
          modules: {
            ...connection.identity.modules,
            shell: { ...shell, fullDiskAccess: message.fullDiskAccess },
          },
        };
        if (this.#hooks.onShellFullDiskAccess) {
          await this.#runHook(() =>
            this.#hooks.onShellFullDiskAccess?.(connection.identity, message.fullDiskAccess),
          );
        }
        break;
      }
      case "runner.modules.report":
        for (const report of message.modules) {
          if (connection.identity.modules[report.module] === undefined) {
            throw new OpensteerError({
              code: "forbidden",
              message: `Runner reported readiness for the unadvertised ${report.module} module`,
            });
          }
          connection.readiness.set(report.module, report);
          if (this.#hooks.onModuleReadiness) {
            await this.#runHook(() => this.#hooks.onModuleReadiness?.(connection.identity, report));
          }
        }
        break;
      case "runner.heartbeat":
        this.#renewLease(connection, message.sentAt);
        // A heartbeat is a bounded point-in-time observation, not execution
        // authority. Retaining every identifier a faulty Runner ever reported
        // would permit unbounded Host memory growth. Host-dispatched ownership
        // remains monotonic independently, so a racing omission cannot erase it.
        connection.observedRunIds = new Set(message.activeRunIds);
        connection.observedTriggerOccurrenceIds = new Set(message.activeTriggerOccurrenceIds);
        await connection.peer.send({
          ...connection.identity.fence,
          connectionLeaseExpiresAt: new Date(connection.leaseExpiresAt).toISOString(),
          type: "host.connection.lease-renewed",
        });
        if (this.#hooks.onHeartbeat) {
          const renewed = await this.#runHook(() =>
            this.#hooks.onHeartbeat?.(
              connection.identity,
              message.activeRunIds,
              message.activeTriggerOccurrenceIds,
              message.activeWatchActivationIds,
            ),
          );
          if (renewed && renewed.length > 0) {
            await connection.peer.send({
              ...connection.identity.fence,
              heartbeatSentAt: message.sentAt,
              leaseMs: this.#executionLeaseMs,
              runIds: [...renewed],
              type: "host.executions.renewed",
            });
          }
        }
        break;
      case "runner.command-accepted":
        {
          const pending = connection.pendingAcks.get(message.commandId);
          try {
            if (pending?.beforeAck) {
              await this.#runHook(pending.beforeAck);
            } else if (this.#hooks.onCommandAccepted) {
              await this.#runHook(() =>
                this.#hooks.onCommandAccepted?.(connection.identity, message),
              );
            }
          } catch (error) {
            pending?.reject(error);
            throw error;
          }
          pending?.resolve(message);
        }
        break;
      case "runner.command-rejected":
        {
          const pending = connection.pendingAcks.get(message.commandId);
          if (pending?.runId) {
            connection.ownedRunIds.delete(pending.runId);
            connection.ownedRunBindings.delete(pending.runId);
            this.#deactivateRunCancellation(pending.runId);
          }
          if (pending?.triggerOccurrenceId) {
            connection.ownedTriggerOccurrenceIds.delete(pending.triggerOccurrenceId);
            this.#deactivateTriggerCancellation(pending.triggerOccurrenceId);
          }
          pending?.reject(
            new CommandDispatchError(
              message.error.retryable || pending?.commandType === "run.steer"
                ? message.error.message
                : "The AI engine could not be started.",
              message.error.retryable ? "retry" : "failed",
              { cause: message.error },
            ),
          );
        }
        break;
      case "runner.command-uncertain":
        {
          const pending = connection.pendingAcks.get(message.commandId);
          if (pending && pending.commandType !== "run.steer") {
            const error = new CommandDispatchError(
              `Runner reported uncertain delivery for ${pending.commandType}`,
              "failed",
            );
            pending.reject(error);
            throw new OpensteerError({
              code: "conflict",
              message: `Runner reported uncertain delivery for ${pending.commandType}`,
            });
          }
          pending?.reject(new CommandDispatchError(message.message, "uncertain"));
        }
        break;
      case "runner.event": {
        if (!connection.identity.environmentIds.includes(message.event.environmentId)) {
          throw new OpensteerError({
            code: "forbidden",
            message: "Runner emitted an event for another environment",
          });
        }
        const { event } = message;
        if (connection.revokedRunIds.has(event.runId)) break;
        try {
          await this.#runHook(() => this.#hooks.onEvent(connection.identity, event));
        } catch (error) {
          // Only a refusal of this event isolates to its Run. Anything else —
          // the store unreachable, a commit whose outcome is unknown — says
          // nothing about the event, and is answered by the connection.
          if (!isRunnerEventRefusal(error)) throw error;
          await this.#refuseEvent(connection, event, error);
          break;
        }
        const terminal =
          event.type === "run.completed" ||
          event.type === "run.failed" ||
          event.type === "run.interrupted";
        this.#acknowledge(connection, event.runId, { ordinal: event.ordinal }, terminal);
        if (terminal) this.#releaseRun(connection, event.runId);
        break;
      }
      case "runner.live": {
        const { progress } = message;
        // Progress is forwarded only for a Run the Host dispatched on this
        // socket, under the binding and placement it was dispatched with. A
        // frame for anything else is dropped, never answered: it costs a reader
        // streaming text at most, and nothing about it is worth a disconnect.
        const owned = connection.ownedRunBindings.get(progress.runId);
        if (
          !owned ||
          connection.revokedRunIds.has(progress.runId) ||
          !connection.identity.environmentIds.includes(message.environmentId) ||
          owned.bindingGeneration !== message.bindingGeneration ||
          owned.environmentId !== message.environmentId ||
          owned.threadId !== progress.threadId ||
          owned.workspaceId !== progress.workspaceId
        ) {
          break;
        }
        this.#hooks.onLive?.(connection.identity, message);
        break;
      }
      case "runner.thread-title": {
        const owned = connection.ownedRunBindings.get(message.runId);
        if (
          !owned ||
          connection.revokedRunIds.has(message.runId) ||
          !connection.identity.environmentIds.includes(message.environmentId) ||
          owned.bindingGeneration !== message.bindingGeneration ||
          owned.environmentId !== message.environmentId ||
          owned.threadId !== message.threadId ||
          owned.workspaceId !== message.workspaceId
        )
          break;
        await this.#runHook(() => this.#hooks.onThreadTitle?.(connection.identity, message));
        break;
      }
      case "runner.trigger-result":
        if (!connection.identity.environmentIds.includes(message.environmentId)) {
          throw new OpensteerError({
            code: "forbidden",
            message: "Runner emitted a Trigger result for another environment",
          });
        }
        if (this.#hooks.onTriggerResult) {
          await this.#runHook(() => this.#hooks.onTriggerResult?.(connection.identity, message));
        }
        connection.pendingTriggerPrograms.get(message.output.occurrenceId)?.resolve();
        connection.pendingTriggerPrograms.delete(message.output.occurrenceId);
        connection.ownedTriggerOccurrenceIds.delete(message.output.occurrenceId);
        connection.observedTriggerOccurrenceIds.delete(message.output.occurrenceId);
        this.#canceledTriggerOccurrences.delete(message.output.occurrenceId);
        break;
      case "runner.watch-status":
        if (this.#hooks.onWatchStatus) {
          await this.#runHook(() => this.#hooks.onWatchStatus?.(connection.identity, message));
        }
        break;
      case "runner.session-bound":
        if (this.#hooks.onSessionBound) {
          try {
            await this.#runHook(() => this.#hooks.onSessionBound?.(connection.identity, message));
          } catch (error) {
            // A binding the Host refuses belongs to a Run this Runner no longer
            // holds, typically one that ended while the binding was replayed.
            if (!isRunnerEventRefusal(error)) throw error;
            await this.#refuseEvent(connection, message, error);
            break;
          }
        }
        this.#acknowledge(connection, message.runId, { sessionBound: true }, false);
        break;
      case "runner.executions.attach":
        await this.#attach(connection, message);
        break;
      case "runner.harness-catalog": {
        const pending = connection.pendingCatalogs.get(message.requestId);
        if (!pending) {
          throw new OpensteerError({
            code: "conflict",
            message: "Harness catalog request is stale",
          });
        }
        const received = new Set<string>();
        for (const catalog of message.catalogs) {
          if (
            received.has(catalog.harnessInstanceId) ||
            pending.expected.get(catalog.harnessInstanceId) !== catalog.driverKind
          ) {
            throw new OpensteerError({
              code: "conflict",
              message: "Runner returned a mismatched harness catalog",
            });
          }
          received.add(catalog.harnessInstanceId);
        }
        if (received.size !== pending.expected.size) {
          throw new OpensteerError({
            code: "conflict",
            message: "Runner returned an incomplete harness catalog",
          });
        }
        pending.resolve(message.catalogs);
        break;
      }
      case "runner.harness-authentication": {
        // The sign-in changed the account whether or not anyone still waits.
        connection.catalogCache.delete(message.harnessInstanceId);
        const pending = connection.pendingHarnessAuthentications.get(message.requestId);
        // Past its deadline the Host stops waiting while the Runner finishes:
        // a late answer is expected, and ending the connection over it would
        // abort every Run on the computer.
        if (!pending) break;
        if (
          pending.driverKind !== message.driverKind ||
          pending.harnessInstanceId !== message.harnessInstanceId
        ) {
          throw new OpensteerError({
            code: "conflict",
            message: "Runner returned a mismatched AI engine sign-in response",
          });
        }
        pending.resolve(message.state);
        break;
      }
      case "runner.voice": {
        connection.pendingVoice.get(message.requestId)?.resolve(message.result);
        break;
      }
      case "runner.model-servers": {
        const pending = connection.pendingModelServers.get(message.requestId);
        // A late answer to a request the Host gave up on, as for sign-in above.
        if (!pending) break;
        if (message.error === undefined) pending.resolve(message.servers);
        else pending.reject(new OpensteerError({ code: "conflict", message: message.error }));
        break;
      }
      case "runner.workspace.local.provisioned":
      case "runner.workspace.local.inspected":
      case "runner.workspace.local.destroyed":
      case "runner.workspace.local.files.listed":
      case "runner.workspace.local.files.read":
      case "runner.workspace.local.error": {
        const pending = connection.pendingWorkspaceLocal.get(message.requestId);
        // A late answer to a request the Host gave up on, as for sign-in above.
        if (!pending) break;
        if (pending.operationId !== message.operationId) {
          throw new OpensteerError({
            code: "conflict",
            message: "The machine answered a different Workspace storage operation",
          });
        }
        pending.resolve(message);
        break;
      }
      case "runner.harness-catalog-invalidated":
        connection.catalogGeneration += 1;
        connection.catalogCache.delete(message.harnessInstanceId);
        // Preparation settled, so work waiting on it may be dispatched; the
        // inspection that follows says what the account is now.
        connection.preparingHarnesses.delete(message.harnessInstanceId);
        // Existing callers still own their request, but a recapture prompted by
        // this signal must observe the state after preparation completed.
        connection.inFlightCatalogs.clear();
        if (this.#hooks.onHarnessCatalogInvalidated) {
          void this.#runHook(() =>
            this.#hooks.onHarnessCatalogInvalidated?.(connection.identity, message),
          ).catch(() => undefined);
        }
        break;
      case "runner.harness-installation": {
        const agents = connection.identity.modules.agents;
        if (agents) {
          connection.identity = {
            ...connection.identity,
            modules: {
              ...connection.identity.modules,
              agents: {
                ...agents,
                harnessDrivers: agents.harnessDrivers.map((driver) =>
                  driver.driverKind === message.driverKind
                    ? { ...driver, installation: message.installation }
                    : driver,
                ),
              },
            },
          };
        }
        if (this.#hooks.onHarnessInstallation) {
          void this.#runHook(() =>
            this.#hooks.onHarnessInstallation?.(connection.identity, message),
          ).catch(() => undefined);
        }
        break;
      }
    }
  }

  /** Tells this connection to stop Runs the Host has already ended. */
  async revokeRuns(
    runnerId: RunnerId,
    revocations: readonly { readonly reason: string; readonly runId: RunId }[],
  ): Promise<void> {
    const connection = this.#byRunner.get(runnerId);
    if (!connection || revocations.length === 0) return;
    for (const { runId } of revocations) {
      connection.revokedRunIds.add(runId);
      this.#releaseRun(connection, runId);
    }
    await connection.peer.send({
      ...connection.identity.fence,
      revocations: revocations.map(({ reason, runId }) => ({
        reason: reason.slice(0, 500) || "The Host ended this Run",
        runId,
      })),
      type: "host.runs.revoked",
    });
  }

  async #refuseEvent(
    connection: RunnerConnection,
    event: RefusedRunnerReport,
    refusal: Error,
  ): Promise<void> {
    if (this.#hooks.onEventRefused) {
      await this.#runHook(() => this.#hooks.onEventRefused?.(connection.identity, event, refusal));
    }
    // A report from a binding this connection no longer runs the Run under —
    // one a recovery retired — names an execution already replaced here.
    // Revocation is by Run, so it would stop the replacement instead.
    const owned = connection.ownedRunBindings.get(event.runId);
    if (owned && owned.bindingGeneration !== event.bindingGeneration) return;
    await this.revokeRuns(connection.identity.runnerId, [
      { reason: refusal.message, runId: event.runId },
    ]);
  }

  /**
   * Settles the Runs a new connection says it holds, before anything else is
   * dispatched to it. The Host answers for every announced Run; a Run the
   * Host resumes is held by this connection exactly as if dispatched on it.
   */
  async #attach(connection: RunnerConnection, message: RunnerAttach): Promise<void> {
    if (connection.attached) {
      throw new OpensteerError({
        code: "conflict",
        message: "Runner announced its Runs twice on one connection",
      });
    }
    for (const execution of message.executions) {
      if (!connection.identity.environmentIds.includes(execution.environmentId)) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Runner announced a Run in another environment",
        });
      }
    }
    const results =
      (this.#hooks.onAttach
        ? await this.#runHook(() => this.#hooks.onAttach?.(connection.identity, message.executions))
        : undefined) ??
      message.executions.map((execution): RunnerAttachResult => ({
        reason: "This Host does not resume Runs",
        runId: execution.runId,
        status: "revoked",
      }));
    const executions = new Map(message.executions.map((entry) => [entry.runId, entry]));
    for (const result of results) {
      const execution = executions.get(result.runId);
      if (result.status !== "attached" || !execution) continue;
      connection.ownedRunIds.add(result.runId);
      connection.ownedRunBindings.set(result.runId, {
        bindingGeneration: execution.bindingGeneration,
        environmentId: execution.environmentId,
        threadId: execution.threadId,
        workspaceId: execution.workspaceId,
      });
    }
    await connection.peer.send({
      ...connection.identity.fence,
      leaseMs: this.#executionLeaseMs,
      results: [...results],
      type: "host.executions.attached",
    });
    connection.attached = true;
    if (this.#hooks.onAttached) {
      void this.#runHook(() => this.#hooks.onAttached?.(connection.identity)).catch(
        () => undefined,
      );
    }
  }

  /** Notes committed progress for the next acknowledgement to this Runner. */
  #acknowledge(
    connection: RunnerConnection,
    runId: RunId,
    progress: { readonly ordinal?: number; readonly sessionBound?: true },
    immediately: boolean,
  ): void {
    const pending = connection.eventAcks.get(runId) ?? { sessionBound: false, throughOrdinal: -1 };
    if (progress.ordinal !== undefined) {
      pending.throughOrdinal = Math.max(pending.throughOrdinal, progress.ordinal);
    }
    if (progress.sessionBound) pending.sessionBound = true;
    connection.eventAcks.set(runId, pending);
    if (immediately) {
      if (connection.eventAckTimer) clearTimeout(connection.eventAckTimer);
      connection.eventAckTimer = undefined;
      void this.#flushAcknowledgements(connection);
      return;
    }
    // The Runner needs to learn only soon enough to stop holding events for
    // replay, so acknowledgements travel together. A terminal event is the
    // exception: once it is acknowledged, the Runner can forget the Run.
    if (connection.eventAckTimer) return;
    connection.eventAckTimer = setTimeout(() => {
      connection.eventAckTimer = undefined;
      void this.#flushAcknowledgements(connection);
    }, eventAckBatchMs);
    connection.eventAckTimer.unref?.();
  }

  async #flushAcknowledgements(connection: RunnerConnection): Promise<void> {
    if (connection.eventAcks.size === 0 || this.#byPeer.get(connection.peer.id) !== connection) {
      return;
    }
    const acks = [...connection.eventAcks].slice(0, 1_000);
    for (const [runId] of acks) connection.eventAcks.delete(runId);
    if (connection.eventAcks.size > 0) void this.#flushAcknowledgements(connection);
    // A lost acknowledgement costs a replay the Host deduplicates, nothing more.
    await connection.peer
      .send({
        ...connection.identity.fence,
        acks: acks.map(([runId, ack]) => ({
          runId,
          sessionBound: ack.sessionBound,
          throughOrdinal: ack.throughOrdinal,
        })),
        type: "host.events.acked",
      })
      .catch(() => undefined);
  }

  /** Ends this connection's hold on a Run that is terminal or revoked. */
  #releaseRun(connection: RunnerConnection, runId: RunId): void {
    connection.ownedRunIds.delete(runId);
    connection.ownedRunBindings.delete(runId);
    connection.observedRunIds.delete(runId);
    this.#canceledRuns.delete(runId);
  }

  disconnect(peer: RunnerPeer): void {
    const connection = this.#byPeer.get(peer.id);
    if (connection) void this.#disconnect(connection, new Error("Runner disconnected"));
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#lifetime.abort(new Error("Runner registry is closing"));
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    await Promise.all(
      [...this.#byRunner.values()].map((connection) =>
        this.#disconnect(connection, new Error("Host is shutting down"), 1001),
      ),
    );
    while (this.#hookOperations.size > 0) {
      await Promise.allSettled(this.#hookOperations);
    }
    this.#canceledRuns.clear();
    this.#canceledTriggerOccurrences.clear();
  }

  async #disconnect(
    connection: RunnerConnection,
    error: Error,
    code = 1001,
    reason: RunnerDisconnectReason = code === runnerIdentityRevokedCloseCode ? "revoked" : "lost",
  ): Promise<void> {
    if (this.#byPeer.get(connection.peer.id) !== connection) return;
    if (connection.eventAckTimer) clearTimeout(connection.eventAckTimer);
    connection.eventAckTimer = undefined;
    connection.attached = false;
    // Recovery must follow execution ownership, not merely Runner process
    // identity. The same Runner boot may reconnect before this asynchronous
    // disconnect hook finishes and begin different work on its new socket.
    const scope: RunnerDisconnectScope = {
      reason: this.#closing ? "shutdown" : reason,
      runIds: [...new Set([...connection.ownedRunIds, ...connection.observedRunIds])],
      triggerOccurrenceIds: [
        ...new Set([
          ...connection.ownedTriggerOccurrenceIds,
          ...connection.observedTriggerOccurrenceIds,
        ]),
      ],
    };
    for (const runId of scope.runIds) this.#canceledRuns.delete(runId);
    for (const occurrenceId of scope.triggerOccurrenceIds) {
      this.#canceledTriggerOccurrences.delete(occurrenceId);
    }
    this.#byPeer.delete(connection.peer.id);
    if (connection.leaseTimer) clearTimeout(connection.leaseTimer);
    if (this.#byRunner.get(connection.identity.runnerId) === connection) {
      this.#byRunner.delete(connection.identity.runnerId);
    }
    // An auxiliary stream exists only beside a live primary connection: its
    // whole authority is the fence the primary handed it.
    for (const stream of Array.from(connection.auxiliaryStreams.values())) {
      // Only a revocation is a revocation. A lease that expired closes 4003 and
      // is a disconnection like any other, so the sessions riding this stream
      // end saying the machine went away rather than that it was removed.
      this.#removeAuxiliary(
        stream,
        code === runnerIdentityRevokedCloseCode ? "revoked" : "primary-lost",
      );
      stream.peer.close(code, error.message);
    }
    connection.auxiliaryStreams.clear();
    connection.readiness.clear();
    for (const environmentId of connection.identity.environmentIds) {
      if (this.#byEnvironment.get(environmentId) === connection)
        this.#byEnvironment.delete(environmentId);
    }
    for (const pending of connection.pendingAcks.values()) pending.reject(error);
    for (const pending of connection.pendingCatalogs.values()) pending.reject(error);
    for (const pending of connection.pendingHarnessAuthentications.values()) pending.reject(error);
    for (const pending of connection.pendingModelServers.values()) pending.reject(error);
    for (const pending of connection.pendingVoice.values()) pending.reject(error);
    for (const pending of connection.pendingTriggerPrograms.values()) pending.reject(error);
    for (const pending of connection.pendingWorkspaceLocal.values()) pending.reject(error);
    connection.pendingAcks.clear();
    connection.pendingCatalogs.clear();
    connection.pendingHarnessAuthentications.clear();
    connection.pendingModelServers.clear();
    connection.pendingVoice.clear();
    connection.pendingTriggerPrograms.clear();
    connection.pendingWorkspaceLocal.clear();
    connection.ownedRunIds.clear();
    connection.ownedRunBindings.clear();
    connection.ownedTriggerOccurrenceIds.clear();
    connection.observedRunIds.clear();
    connection.observedTriggerOccurrenceIds.clear();
    connection.peer.close(code, error.message);
    connection.disconnected.resolve();
    if (this.#hooks.onDisconnect) {
      await this.#runHook(() => this.#recoverDisconnect(connection.identity, scope));
    }
  }

  async #recoverDisconnect(identity: RunnerIdentity, scope: RunnerDisconnectScope): Promise<void> {
    let retryMs = 250;
    for (;;) {
      try {
        // Once recovery has crossed into its owner, shutdown must drain it.
        // Aborting only this wait would leave the hook running after the
        // database and the rest of the Host lifetime have been destroyed.
        await this.#hooks.onDisconnect?.(identity, scope);
        return;
      } catch {
        // The durable Run rows are the restart recovery ledger. While this Host
        // remains alive, retain the exact connection scope and retry instead of
        // turning a transient database outage into permanently active work.
        if (this.#closing) return;
        await withAbort(delay(retryMs), this.#lifetime.signal).catch(() => undefined);
        if (this.#closing) return;
        retryMs = Math.min(retryMs * 2, 1_000);
      }
    }
  }

  #runHook<T>(invoke: () => Promise<T> | T): Promise<T> {
    const operation = Promise.resolve().then(invoke);
    this.#hookOperations.add(operation);
    void operation.finally(() => this.#hookOperations.delete(operation)).catch(() => undefined);
    return operation;
  }

  /**
   * Heartbeat timestamps must advance. A replayed heartbeat would otherwise
   * extend a lease on behalf of a Runner that has stopped answering.
   */
  #renewLease(connection: RunnerConnection, sentAt: string): void {
    const now = this.#now();
    const sent = Date.parse(sentAt);
    if (
      !Number.isFinite(sent) ||
      sent < connection.authenticatedAt - maximumHeartbeatClockSkewMs ||
      sent > now + maximumHeartbeatClockSkewMs ||
      (connection.lastHeartbeatSentAt !== undefined && sent <= connection.lastHeartbeatSentAt)
    ) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Runner heartbeat timestamp is invalid",
      });
    }
    connection.lastHeartbeatSentAt = sent;
    connection.leaseExpiresAt = Math.max(
      now + this.#connectionLeaseMs,
      connection.leaseExpiresAt + 1,
    );
    if (connection.leaseTimer) clearTimeout(connection.leaseTimer);
    connection.leaseTimer = this.#leaseTimer(connection);
  }

  #assertOpen(): void {
    if (this.#closing) {
      throw new OpensteerError({ code: "conflict", message: "Runner registry is closed" });
    }
  }

  #releaseCancellation(
    command: RunnerCommand,
    runCancellation: { active: boolean; pendingInterrupts: number; threadId: string } | undefined,
    triggerCancellation: { active: boolean; pendingInterrupts: number } | undefined,
  ): void {
    if (command.type === "run.interrupt" && runCancellation) {
      if (this.#canceledRuns.get(command.runId) !== runCancellation) return;
      runCancellation.pendingInterrupts -= 1;
      if (runCancellation.pendingInterrupts === 0 && !runCancellation.active) {
        this.#canceledRuns.delete(command.runId);
      }
    } else if (command.type === "trigger.interrupt" && triggerCancellation) {
      if (this.#canceledTriggerOccurrences.get(command.occurrenceId) !== triggerCancellation)
        return;
      triggerCancellation.pendingInterrupts -= 1;
      if (triggerCancellation.pendingInterrupts === 0 && !triggerCancellation.active) {
        this.#canceledTriggerOccurrences.delete(command.occurrenceId);
      }
    }
  }

  #deactivateRunCancellation(runId: RunId): void {
    const cancellation = this.#canceledRuns.get(runId);
    if (!cancellation) return;
    cancellation.active = false;
    if (cancellation.pendingInterrupts === 0) this.#canceledRuns.delete(runId);
  }

  #deactivateTriggerCancellation(occurrenceId: TriggerOccurrenceId): void {
    const cancellation = this.#canceledTriggerOccurrences.get(occurrenceId);
    if (!cancellation) return;
    cancellation.active = false;
    if (cancellation.pendingInterrupts === 0) {
      this.#canceledTriggerOccurrences.delete(occurrenceId);
    }
  }
}

/**
 * A Workspace storage result carries its fence as one field because that fence
 * also names the disk; everything else repeats the connection fence inline.
 * Both are the same statement about which socket this frame belongs to.
 */
function connectionFenceOf(message: RunnerOperationalMessage): RunnerConnectionFence {
  return "fence" in message ? message.fence : message;
}

function auxiliarySnapshot(stream: AuxiliaryStream): RunnerAuxiliaryStream {
  return {
    auxiliaryStreamId: stream.auxiliaryStreamId,
    fence: stream.fence,
    identity: stream.identity,
    streamLeaseExpiresAt: new Date(stream.leaseExpiresAt).toISOString(),
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      withAbort(promise, signal),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new OpensteerError({ code: "timeout", message, retryable: true })),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Aborted"));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * Identifies one catalog question by the set it asks about — never by who is
 * asking or with what authority, so a reconciliation's answer is reusable by
 * the read-only inspections that follow it.
 */
function catalogFingerprint(harnesses: HarnessCatalogRequestDefinitions): string {
  return canonicalJson(harnesses);
}

const runnerEventRefusalCodes: ReadonlySet<OpensteerError["code"]> = new Set([
  "bad_request",
  "conflict",
  "forbidden",
  "not_found",
  "unauthorized",
  "workspace_unavailable",
]);

/**
 * Whether the Host rejected an event for what it says, as opposed to failing
 * to decide. A malformed payload is a refusal; a retryable error, an outage or
 * an unknown commit outcome never is.
 */
export function isRunnerEventRefusal(error: unknown): error is OpensteerError | Error {
  // Frames are parsed before they reach the store, so a validation failure
  // here is the store refusing a value derived from this event.
  if (error instanceof Error && error.name === "ZodError") return true;
  return (
    error instanceof OpensteerError && !error.retryable && runnerEventRefusalCodes.has(error.code)
  );
}
