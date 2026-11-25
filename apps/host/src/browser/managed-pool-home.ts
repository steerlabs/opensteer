/**
 * A pooled Cloud Computer's Home chooses its browser's coordinator (phase B, piece 5: W6, S7).
 * Only a Home whose boot answer said browserPool reaches this; for it, the coordinator is built
 * for the target its account placed, and replaced, never patched, when the target changes. A
 * Home with no ready target has no coordinator at all.
 */
import { createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import type { Kysely } from "kysely";
import { OpensteerError, type EnvironmentId, type RunnerId } from "@opensteer/core";
import {
  BrowserPoolAdmissionClosed,
  listAllBrowserPoolRetiredTargets,
  listBrowserPoolRetiredTargets,
  retireBrowserPoolTarget,
  type BrowserPoolRetiredTarget,
  type DatabaseSchema,
} from "@opensteer/database";
import type { RunnerAuxiliaryStream } from "@opensteer/orchestration";
import { RunnerAuxiliaryFrameFenceSchema, type RunnerDescriptor } from "@opensteer/protocol";
import { maxBrowserRelayEnvelopeBytes } from "@opensteer/protocol/browser-relay";
import {
  BrowserModuleRelay,
  LocalBrowserRuntimeBridge,
  type RunnerModuleStream,
} from "@opensteer/runner-client";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import {
  BrowserPoolCoordinator,
  type BrowserPoolCoordinatorOptions,
} from "./browser-pool-coordinator.js";
import type { BrowserService } from "./browser-service.js";
import { managedBrowserPool, type ManagedBrowserPoolHomeKeys } from "./managed-pool.js";
import { loadOrCreateManagedBrowserPoolKeys } from "./managed-pool-keys.js";
import {
  databaseManagedBrowserPoolTargetRecord,
  ManagedBrowserPoolAccountClient,
  ManagedBrowserPoolTargetService,
  type ManagedBrowserPoolAccount,
  type ManagedBrowserPoolTarget,
} from "./managed-pool-target.js";
import type { RunnerBrowserHub, RunnerBrowserPeer } from "./runner-browser-hub.js";
import { BrowserRuntimeRelayToHostMessageSchema } from "./runner-browser-runtime.js";

/** The runtime id the Cloud Computer's Runner reports for its browser (deploy/home/compose.yaml). */
export const pooledBrowserRuntimeId = "browser-main";

/** How long a pooled browser sits open with nobody holding it before the Home parks it (5 min). */
export const defaultManagedBrowserPoolIdleMs = 5 * 60_000;

/**
 * Raw ingress byte bounds at the pooled guest boundary (matching the Host's Runner WebSocket
 * ingress bounds at `apps/host/src/server.ts`), enforced before parsing guest JSON or frames.
 */
const maxPooledGuestTextFrameBytes = 1 * 1_024 * 1_024;
const maxPooledGuestBinaryFrameBytes = maxBrowserRelayEnvelopeBytes;

/** Operator-facing status of a pooled Cloud Computer's browser target. */
export type ManagedBrowserPoolStatus = "no-target" | "preparing" | "ready" | "unavailable";

export interface ManagedBrowserPoolHome {
  readonly runnerId: RunnerId | undefined;
  readonly keys: ManagedBrowserPoolHomeKeys;
  readonly targets: ManagedBrowserPoolTargetService;
  status(): ManagedBrowserPoolStatus;
  unavailableReason(): string;
  bindRunner(runnerId: RunnerId): void;
  close(): Promise<void>;
}

interface ManagedPooledRelay {
  isAttached(): boolean;
  ensureAttached(signal?: AbortSignal): Promise<void>;
  /** Permanently ends this target's relay, cancelling any in-flight attach and detaching its peer. */
  retire(): void;
}

function untilSettledOrAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Derives the advertised `modules.browser` descriptor from the guest runtime's live `/health`
 * capabilities and the Host's feature switches (S3). Never claims capabilities that are disabled.
 */
export function pooledBrowserModuleDescriptor(
  capabilities: Awaited<ReturnType<LocalBrowserRuntimeBridge["capabilities"]>>,
  options: { readonly runtimeId: string; readonly passkeys: boolean },
): NonNullable<RunnerDescriptor["modules"]["browser"]> {
  return {
    runtimeId: options.runtimeId,
    ...capabilities,
    stateImport: true,
    fileStaging: true,
    ...(options.passkeys ? { passkeys: 1 as const } : {}),
    cdpBoundary: 1,
    sharedControl: 1,
    targetControl: 1,
    navigationVersion: 1,
    navigationAttributionVersion: 1,
    tabRestoreVersion: 1,
    surfaceState: 1,
    popupFollowVersion: 1,
    actorClaim: 1,
    captureRegion: 1,
    rasterDemand: 1,
    editing: 2,
    clipboard: false,
  };
}

/**
 * Attaches the Host's own `LocalBrowserRuntimeBridge({ transport })` + `BrowserModuleRelay`
 * directly to `RunnerBrowserHub` for the pooled Cloud Computer's Runner, so the Host drives the
 * pool guest over its mTLS relay tunnels without any local browser container or Runner relay.
 *
 * Every attach is fenced by this target's lifetime abort controller (M2): a retired target
 * aborts any in-flight health/inventory read and can never publish a peer over a replacement.
 */
export function createManagedPooledRelay(input: {
  readonly browserRelay: RunnerBrowserHub;
  readonly runnerId: RunnerId;
  readonly runnerName: string;
  readonly environmentIds: readonly EnvironmentId[];
  readonly transport: ReturnType<typeof managedBrowserPool>["transport"];
  readonly ticketKey: ManagedBrowserPoolHomeKeys["ticketKey"];
  readonly passkeys: boolean;
  readonly currentGuest?:
    (() => { readonly instanceId: string; readonly epoch: number } | null) | undefined;
  readonly isAgentsStopped?: (() => boolean) | undefined;
  readonly onDetached?: (() => void) | undefined;
}): ManagedPooledRelay {
  const targetLifetime = new AbortController();
  let retired = false;
  let attached = false;
  let attaching: Promise<void> | undefined;
  let activePeer: RunnerBrowserPeer | undefined;
  let activeRelay: BrowserModuleRelay | undefined;
  let renewalTimer: ReturnType<typeof setInterval> | undefined;
  const streamLeaseMs = 60 * 60_000;
  const ticketPublicKeyPem = createPublicKey(input.ticketKey.key)
    .export({ format: "pem", type: "spki" })
    .toString();

  const clearRenewal = () => {
    if (!renewalTimer) return;
    clearInterval(renewalTimer);
    renewalTimer = undefined;
  };

  const cleanupPeer = (
    peer: RunnerBrowserPeer | undefined,
    relay: BrowserModuleRelay | undefined,
  ) => {
    if (peer && activePeer === peer) {
      clearRenewal();
      activePeer = undefined;
      activeRelay = undefined;
      attached = false;
    }
    if (peer) input.browserRelay.detach(peer, "superseded");
    relay?.detach();
  };

  const retire = () => {
    if (retired) return;
    retired = true;
    targetLifetime.abort(new BrowserPoolAdmissionClosed("This browser target was retired."));
    clearRenewal();
    const peer = activePeer;
    const relay = activeRelay;
    activePeer = undefined;
    activeRelay = undefined;
    attached = false;
    if (peer) input.browserRelay.detach(peer, "superseded");
    relay?.detach();
  };

  const ensureAttached = async (signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    if (retired || targetLifetime.signal.aborted)
      throw new BrowserPoolAdmissionClosed("This browser target was retired.");
    if (attached) return;
    if (attaching) {
      await untilSettledOrAborted(attaching, signal);
      return;
    }
    const run = (async () => {
      const targetSignal = targetLifetime.signal;
      targetSignal.throwIfAborted();
      // Capture the slot's active guest `(instanceId, epoch)` at attach start (Sol 2).
      const startedGuest = input.currentGuest?.();
      if (input.currentGuest && !startedGuest)
        throw new BrowserPoolAdmissionClosed("The pooled browser is not running.");
      const guestChanged = (): boolean => {
        if (!input.currentGuest) return false;
        const current = input.currentGuest();
        return (
          !current ||
          !startedGuest ||
          current.instanceId !== startedGuest.instanceId ||
          current.epoch !== startedGuest.epoch
        );
      };
      const bridge = new LocalBrowserRuntimeBridge({
        transport: input.transport,
        runtimeId: pooledBrowserRuntimeId,
        maxTextFrameBytes: maxPooledGuestTextFrameBytes,
        maxBinaryFrameBytes: maxPooledGuestBinaryFrameBytes,
      });
      const capabilities = await bridge.capabilities(targetSignal);
      if (retired || targetSignal.aborted)
        throw new BrowserPoolAdmissionClosed("This browser target was retired.");
      const relay = new BrowserModuleRelay(bridge, input.isAgentsStopped ?? false);
      const fence = RunnerAuxiliaryFrameFenceSchema.parse({
        runnerId: input.runnerId,
        bootId: `rbt_${randomUUID()}`,
        connectionId: `rcn_${randomUUID()}`,
        connectionLeaseId: `rls_${randomUUID()}`,
        connectionGeneration: 1,
        auxiliaryStreamId: `rax_${randomUUID()}`,
        module: "browser",
      });
      const { auxiliaryStreamId, module: _module, ...primaryFence } = fence;
      const peer: RunnerBrowserPeer = {
        id: `managed-pool-browser:${randomUUID()}`,
        close: () => {
          clearRenewal();
          relay.detach();
          if (activePeer === peer) {
            activePeer = undefined;
            activeRelay = undefined;
            attached = false;
            if (!retired) input.onDetached?.();
          }
        },
        send: (message) => relay.handleFrame(Buffer.from(JSON.stringify(message), "utf8"), false),
      };
      const browserModule = pooledBrowserModuleDescriptor(capabilities, {
        runtimeId: pooledBrowserRuntimeId,
        passkeys: input.passkeys,
      });
      const buildStream = (): RunnerAuxiliaryStream => ({
        auxiliaryStreamId,
        fence,
        streamLeaseExpiresAt: new Date(Date.now() + streamLeaseMs).toISOString(),
        identity: {
          ...primaryFence,
          fence: primaryFence,
          allowedModules: ["agents", "browser"],
          capabilities: [],
          environmentIds: [...input.environmentIds],
          personalRemoteAccessGeneration: null,
          runnerKind: "main",
          name: input.runnerName,
          runtimeVersion: "managed-pool",
          modules: {
            browser: browserModule,
          },
        },
      });
      const relayStream: RunnerModuleStream = {
        fence,
        browserWireVersion: 2,
        ...(input.passkeys ? { passkeys: 1 as const } : {}),
        browserAttachPublicKeys: [
          { keyId: input.ticketKey.keyId, publicKeyPem: ticketPublicKeyPem },
        ],
        send: async (frame: Buffer | string, binary: boolean) => {
          if (binary) {
            const buffer = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
            if (buffer.byteLength > maxPooledGuestBinaryFrameBytes) {
              throw new OpensteerError({
                code: "bad_request",
                message: "The browser relay binary frame exceeds the size limit.",
              });
            }
            await input.browserRelay.handleBinary(peer, buffer);
            return;
          }
          const textBytes = Buffer.isBuffer(frame)
            ? frame.byteLength
            : Buffer.byteLength(frame, "utf8");
          if (textBytes > maxPooledGuestTextFrameBytes) {
            throw new OpensteerError({
              code: "bad_request",
              message: "The browser relay message exceeds the size limit.",
            });
          }
          const parsed = BrowserRuntimeRelayToHostMessageSchema.parse(
            JSON.parse(Buffer.isBuffer(frame) ? frame.toString("utf8") : frame),
          );
          if (parsed.type !== "runner.auxiliary.heartbeat")
            await input.browserRelay.handleMessage(peer, parsed);
        },
      };
      // Fence check immediately before publishing the peer to the hub (target + guest fence).
      if (retired || targetSignal.aborted || guestChanged())
        throw new BrowserPoolAdmissionClosed("This browser target was retired.");
      activePeer = peer;
      activeRelay = relay;
      try {
        input.browserRelay.attach(peer, buildStream());
        await relay.attach(relayStream, targetSignal);
        // Fence check again after inventory/reconciliation completes (target + guest fence).
        if (retired || targetSignal.aborted || activePeer !== peer || guestChanged()) {
          cleanupPeer(peer, relay);
          throw new BrowserPoolAdmissionClosed("This browser target was retired.");
        }
        attached = true;
        // Keep the synthetic stream lease well under Node's 32-bit setTimeout limit while never expiring.
        renewalTimer = setInterval(() => {
          if (!retired && activePeer === peer) input.browserRelay.renew(peer, buildStream());
        }, streamLeaseMs / 4);
        renewalTimer.unref();
      } catch (error) {
        cleanupPeer(peer, relay);
        throw error;
      }
    })();
    attaching = run;
    // Prevent unhandled rejection when all caller signals abort before the single-flight run settles.
    void run.catch(() => undefined);
    try {
      await untilSettledOrAborted(run, signal);
    } finally {
      if (attaching === run) {
        void run
          .catch(() => undefined)
          .finally(() => {
            if (attaching === run) attaching = undefined;
          });
      }
    }
  };

  return {
    isAttached: () => attached && !retired,
    ensureAttached,
    retire,
  };
}

/** Builds the coordinator for one target: a different target is a different coordinator. */
export function managedBrowserPoolCoordinator(input: {
  readonly database: Kysely<DatabaseSchema>;
  readonly runnerId: RunnerId;
  readonly target: ManagedBrowserPoolTarget;
  readonly keys: ManagedBrowserPoolHomeKeys;
  readonly onSuspect: (reason?: "over") => void;
  readonly onError?: (error: unknown) => void;
  readonly onDiscard?: (reason: string) => void;
  readonly onStateChanged?: () => void;
  readonly idleParkMs?: number | null;
  readonly statusEveryMs?: number;
  readonly retryMs?: number;
  readonly unansweredRetryMaxMs?: number;
  readonly unreachableAfterMs?: number;
  readonly unansweredMs?: number;
  readonly relay?: BrowserPoolCoordinatorOptions["relay"];
  readonly onRunning?: (signal?: AbortSignal) => Promise<void>;
  readonly parts?: ReturnType<typeof managedBrowserPool>;
  /** W8: only drain this replaced target, of the fence its slot had. */
  readonly drain?: { readonly instanceId: string; readonly epoch: number };
}): BrowserPoolCoordinator {
  const parts = input.parts ?? managedBrowserPool(input.target, input.keys);
  return new BrowserPoolCoordinator({
    database: input.database,
    runnerId: input.runnerId,
    runtimeId: pooledBrowserRuntimeId,
    slotId: input.target.slotId,
    term: input.target.term,
    runtime: parts.runtime,
    controller: parts.controller,
    onSuspect: input.onSuspect,
    ...(input.onError ? { onError: input.onError } : {}),
    ...(input.onDiscard ? { onDiscard: input.onDiscard } : {}),
    ...(input.onStateChanged ? { onStateChanged: input.onStateChanged } : {}),
    ...(input.idleParkMs !== undefined ? { idleParkMs: input.idleParkMs } : {}),
    ...(input.statusEveryMs !== undefined ? { statusEveryMs: input.statusEveryMs } : {}),
    ...(input.retryMs !== undefined ? { retryMs: input.retryMs } : {}),
    ...(input.unansweredRetryMaxMs !== undefined
      ? { unansweredRetryMaxMs: input.unansweredRetryMaxMs }
      : {}),
    ...(input.unreachableAfterMs !== undefined
      ? { unreachableAfterMs: input.unreachableAfterMs }
      : {}),
    ...(input.unansweredMs !== undefined ? { unansweredMs: input.unansweredMs } : {}),
    ...(input.relay ? { relay: input.relay } : {}),
    ...(input.onRunning ? { onRunning: input.onRunning } : {}),
    ...(input.drain ? { drain: input.drain } : {}),
  });
}

interface AppliedPool {
  readonly runnerId: RunnerId;
  readonly target: ManagedBrowserPoolTarget;
  readonly targetKey: string;
  readonly coordinator: BrowserPoolCoordinator;
  readonly relay: ManagedPooledRelay | undefined;
}

interface PendingRetirement {
  readonly runnerId: RunnerId;
  readonly target: ManagedBrowserPoolTarget;
  readonly reason: "runner-replaced" | "browser-replaced";
  poolRetired: boolean;
  dbRetired: boolean;
}

/**
 * Starts a pooled Cloud Computer's Home's browser: a target it already read is placed as desired
 * at once (its sessions were kept by the startup sweep), and the target service reads the account
 * for any other. One level-triggered reconciliation loop (M4) compares desired `{ runnerId,
 * target }` against what is applied, retires what differs durably, and adopts what is desired.
 * Call after `BrowserService.initialize` and `BrowserService.setPoolSigner`.
 */
export async function startManagedBrowserPool(input: {
  readonly database: Kysely<DatabaseSchema>;
  readonly dataDirectory: string;
  readonly cloudComputerId: string;
  readonly keys?: ManagedBrowserPoolHomeKeys;
  readonly runnerId?: RunnerId | undefined;
  readonly resolveRunnerId?: () => Promise<RunnerId | undefined>;
  readonly onRunnerBound?: (runnerId: RunnerId) => void;
  readonly environmentIds?: readonly EnvironmentId[];
  readonly runnerName?: string;
  readonly hostKey: KeyObject;
  readonly browser: Pick<BrowserService, "adoptPool" | "retirePool" | "drainPool">;
  readonly browserRelay?: RunnerBrowserHub;
  readonly passkeys?: boolean;
  readonly isAgentsStopped?: (runnerId: RunnerId) => boolean;
  readonly idleParkMs?: number | null;
  readonly statusEveryMs?: number;
  readonly firstDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly account:
    | ManagedBrowserPoolAccount
    | {
        readonly controlApiOrigin: URL;
        readonly hostCredential: string | (() => Promise<string | null>);
        readonly fetch?: typeof fetch;
      };
  readonly onStatusChanged?: (status: ManagedBrowserPoolStatus) => void;
  readonly onError?: (error: unknown) => void;
}): Promise<ManagedBrowserPoolHome> {
  const keys = input.keys ?? (await loadOrCreateManagedBrowserPoolKeys(input.dataDirectory));
  const record = databaseManagedBrowserPoolTargetRecord(input.database, input.cloudComputerId);
  let desiredRunnerId: RunnerId | undefined = input.runnerId;
  let desiredTarget: ManagedBrowserPoolTarget | undefined;
  let desiredTargetKey: string | undefined;
  let applied: AppliedPool | undefined;
  let pendingRetirement: PendingRetirement | undefined;
  let reconcileError: unknown;
  let startupDrained = false;
  let notReadyStatus: "no-target" | "preparing" = "no-target";
  let lastStatus: ManagedBrowserPoolStatus = "no-target";
  let closed = false;

  const computeStatus = (): ManagedBrowserPoolStatus => {
    if (!applied) {
      if (reconcileError !== undefined || pendingRetirement !== undefined) return "unavailable";
      return notReadyStatus;
    }
    const phase = applied.coordinator.gate.phase;
    const report = applied.coordinator.report();
    const relayReady = applied.relay ? applied.relay.isAttached() : true;
    if (
      phase === "released" ||
      phase === "unavailable" ||
      report?.unreachable ||
      report?.refused ||
      report?.relayFailed
    )
      return "unavailable";
    if (phase === "open") return relayReady ? "ready" : "unavailable";
    if (phase === "parked") {
      if (
        report?.phase === "waking" ||
        report?.phase === "starting" ||
        report?.phase === "restarting"
      )
        return "preparing";
      return applied.coordinator.unanswered ? "unavailable" : "ready";
    }
    return "preparing";
  };

  const syncStatus = () => {
    const next = computeStatus();
    if (next === lastStatus) return;
    lastStatus = next;
    try {
      input.onStatusChanged?.(next);
    } catch {
      // Diagnostic callbacks must never interrupt pool reconciliation or retries.
    }
  };

  const unavailableReason = (): string => {
    if (!applied) {
      if (reconcileError !== undefined)
        return "Your Cloud Computer’s browser couldn’t be set up right now. Try again in a moment.";
      return "Setting up your browser… This can take a few minutes.";
    }
    const phase = applied.coordinator.gate.phase;
    const report = applied.coordinator.report();
    if (phase === "released") return "This device was removed.";
    if (
      applied.coordinator.over ||
      (report?.refused !== undefined &&
        (report.refused === "slot-deleted" ||
          report.refused === "fenced" ||
          report.refused === "browser-replaced"))
    )
      return "Setting up your browser… This can take a few minutes.";
    if (
      report?.unreachable ||
      report?.relayFailed ||
      applied.coordinator.unanswered ||
      phase === "unavailable"
    )
      return "Your Cloud Computer’s browser couldn’t be reached. Try again in a moment.";
    if (report?.refused)
      return report.savedStateKept
        ? "Your Cloud Computer’s browser can’t start right now. Your tabs and sign-ins are kept."
        : "Your Cloud Computer’s browser can’t start right now. Try again in a moment.";
    if (phase === "open" && applied.relay && !applied.relay.isAttached())
      return "Your Cloud Computer’s browser isn’t connected right now. Try again in a moment.";
    return "Setting up your browser… This can take a few minutes.";
  };

  const resolveRunner = async (): Promise<RunnerId | undefined> => {
    if (desiredRunnerId) return desiredRunnerId;
    const found = await input.resolveRunnerId?.();
    if (found) {
      desiredRunnerId = found;
      input.onRunnerBound?.(found);
    }
    return desiredRunnerId;
  };

  /** Replaced targets being drained now, by slot and term. */
  const draining = new Set<string>();
  const drainCoordinator = (runnerId: RunnerId, retired: BrowserPoolRetiredTarget) =>
    managedBrowserPoolCoordinator({
      database: input.database,
      runnerId,
      target: retired.target as unknown as ManagedBrowserPoolTarget,
      keys,
      onSuspect: () => {},
      ...(input.onError ? { onError: input.onError } : {}),
      drain: { instanceId: retired.instanceId, epoch: retired.epoch },
    });
  const startDrains = (retiredRows: readonly BrowserPoolRetiredTarget[]) => {
    for (const retired of retiredRows) {
      const key = `${retired.slotId}:${retired.term}`;
      if (draining.has(key)) continue;
      draining.add(key);
      void input.browser
        .drainPool(retired.runnerId, drainCoordinator(retired.runnerId, retired))
        .catch((error: unknown) => input.onError?.(error))
        .finally(() => draining.delete(key));
    }
  };
  // W8: each replaced target a Stop still waits on is asked until it has answered for each.
  const drainRetired = async (runnerId: RunnerId) => {
    startDrains(await listBrowserPoolRetiredTargets(input.database, runnerId));
  };
  // Startup scan (M4): find retired targets stored under any Runner, including earlier replaced ones.
  const drainAllRetired = async () => {
    startDrains(await listAllBrowserPoolRetiredTargets(input.database));
  };

  const finishPendingRetirement = async () => {
    if (!pendingRetirement) return;
    const pending = pendingRetirement;
    if (!pending.poolRetired) {
      await input.browser.retirePool(pending.runnerId, pending.reason);
      pending.poolRetired = true;
    }
    if (!pending.dbRetired) {
      await retireBrowserPoolTarget(input.database, pending.runnerId, {
        target: pending.target as unknown as Readonly<Record<string, unknown>>,
      });
      pending.dbRetired = true;
    }
    await drainRetired(pending.runnerId);
    pendingRetirement = undefined;
  };

  const reconcileOnce = async (): Promise<void> => {
    if (closed) return;
    if (!startupDrained) {
      await drainAllRetired();
      startupDrained = true;
    }
    if (closed) return;
    if (pendingRetirement) {
      await finishPendingRetirement();
      if (closed) return;
    }
    const runnerId = await resolveRunner();
    const target = desiredTarget;
    const targetKey = desiredTargetKey;

    // If what is applied differs from the latest desired pair, retire it first and keep the
    // retirement pending until both DB retirement and drain registration succeed.
    if (
      applied &&
      (!runnerId || !target || applied.runnerId !== runnerId || applied.targetKey !== targetKey)
    ) {
      const retiring = applied;
      retiring.relay?.retire();
      pendingRetirement = {
        runnerId: retiring.runnerId,
        target: retiring.target,
        reason: retiring.runnerId !== runnerId ? "runner-replaced" : "browser-replaced",
        poolRetired: false,
        dbRetired: false,
      };
      applied = undefined;
      syncStatus();
      await finishPendingRetirement();
      if (closed) return;
    }

    if (applied || !target || !targetKey) return;
    if (!runnerId)
      throw new Error("Waiting for this Cloud Computer's main Runner before adopting its browser.");

    // Clean any stale `browser_pool_slots` row left behind by a replaced Runner holding this slot
    // or by an earlier crashed retirement leaving another slot/term under this Runner key (M4, S7).
    const staleBySlot = await input.database
      .selectFrom("browserPoolSlots")
      .select(["runnerId", "slotId", "term"])
      .where("slotId", "=", target.slotId)
      .where("runnerId", "!=", runnerId)
      .execute();
    for (const stale of staleBySlot) {
      await retireBrowserPoolTarget(input.database, stale.runnerId, {
        target: target as unknown as Readonly<Record<string, unknown>>,
        endActiveSessions: true,
      });
      await drainRetired(stale.runnerId);
    }
    const staleByRunner = await input.database
      .selectFrom("browserPoolSlots")
      .select(["runnerId", "slotId", "term"])
      .where("runnerId", "=", runnerId)
      .executeTakeFirst();
    if (
      staleByRunner &&
      (staleByRunner.slotId !== target.slotId || staleByRunner.term !== target.term)
    ) {
      await retireBrowserPoolTarget(input.database, staleByRunner.runnerId, {
        endActiveSessions: true,
      });
      await drainRetired(staleByRunner.runnerId);
    }
    if (closed) return;

    const parts = managedBrowserPool(target, keys);
    let coordinator: BrowserPoolCoordinator | undefined;
    const relay = input.browserRelay
      ? createManagedPooledRelay({
          browserRelay: input.browserRelay,
          runnerId,
          runnerName: input.runnerName ?? "Cloud Computer",
          environmentIds: input.environmentIds ?? [],
          transport: parts.transport,
          ticketKey: keys.ticketKey,
          passkeys: input.passkeys === true,
          currentGuest: () => coordinator?.activeGuest() ?? null,
          ...(input.isAgentsStopped
            ? { isAgentsStopped: () => input.isAgentsStopped!(runnerId) }
            : {}),
          onDetached: () => {
            if (applied?.relay === relay) {
              coordinator?.relayDetached();
              syncStatus();
            }
          },
        })
      : undefined;
    coordinator = managedBrowserPoolCoordinator({
      database: input.database,
      runnerId,
      target,
      keys,
      parts,
      idleParkMs:
        input.idleParkMs === undefined ? defaultManagedBrowserPoolIdleMs : input.idleParkMs,
      ...(input.statusEveryMs !== undefined ? { statusEveryMs: input.statusEveryMs } : {}),
      ...(relay
        ? {
            relay: {
              attached: () => relay.isAttached(),
              attach: (signal) => relay.ensureAttached(signal),
            },
          }
        : {}),
      onStateChanged: syncStatus,
      onSuspect: (reason) => targets.suspect(reason === "over" ? { over: true } : {}),
      ...(input.onError ? { onError: input.onError } : {}),
    });
    const candidate: AppliedPool = {
      runnerId,
      target,
      targetKey,
      coordinator,
      relay,
    };
    applied = candidate;
    try {
      await input.browser.adoptPool(runnerId, coordinator, {
        label: input.runnerName ?? "Cloud Computer",
        environmentIds: input.environmentIds ?? [],
      });
    } catch (error) {
      coordinator.close();
      relay?.retire();
      if (applied === candidate) applied = undefined;
      syncStatus();
      throw error;
    }
    syncStatus();
    // If a newer desired runner or target arrived while adoptPool was in flight, run another pass.
    if (desiredRunnerId !== candidate.runnerId || desiredTargetKey !== candidate.targetKey)
      reconcileNeeded = true;
  };

  let reconciling: Promise<void> | undefined;
  let reconcileNeeded = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryAttempt = 0;

  const clearRetryTimer = () => {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  const scheduleRetry = () => {
    if (closed || retryTimer) return;
    const first = input.firstDelayMs ?? 200;
    const max = input.maxDelayMs ?? 15_000;
    const delayMs = Math.min(first * 2 ** Math.min(retryAttempt++, 16), max);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (closed) return;
      void scheduleReconcile(false);
    }, delayMs);
    retryTimer.unref();
  };

  const runReconcileLoop = async () => {
    while (!closed && reconcileNeeded) {
      reconcileNeeded = false;
      try {
        await reconcileOnce();
        reconcileError = undefined;
        retryAttempt = 0;
        syncStatus();
      } catch (error) {
        reconcileError = error;
        try {
          input.onError?.(error);
        } catch {
          // Diagnostic callbacks must never stop reconciliation retries.
        }
        syncStatus();
        scheduleRetry();
        return;
      }
    }
  };

  const scheduleReconcile = (immediate = true): Promise<void> => {
    if (closed) return Promise.resolve();
    reconcileNeeded = true;
    if (immediate) {
      clearRetryTimer();
      retryAttempt = 0;
    }
    if (!reconciling) {
      reconciling = runReconcileLoop().finally(() => {
        reconciling = undefined;
        if (!closed && reconcileNeeded && !retryTimer) {
          void scheduleReconcile(false);
        }
      });
    }
    return reconciling;
  };

  const account =
    "register" in input.account
      ? input.account
      : new ManagedBrowserPoolAccountClient({
          controlApiOrigin: input.account.controlApiOrigin,
          hostCredential: input.account.hostCredential,
          ...(input.account.fetch ? { fetch: input.account.fetch } : {}),
        });
  const targets = new ManagedBrowserPoolTargetService({
    cloudComputerId: input.cloudComputerId,
    keys,
    hostKey: input.hostKey,
    account,
    record,
    onTarget: async (target) => {
      if (closed) return;
      desiredTarget = target;
      desiredTargetKey = canonicalJson(target);
      void scheduleReconcile(true);
    },
    onNotReady: (answer) => {
      notReadyStatus = answer === "preparing" ? "preparing" : "no-target";
      syncStatus();
    },
    ...(input.firstDelayMs !== undefined ? { firstDelayMs: input.firstDelayMs } : {}),
    ...(input.maxDelayMs !== undefined ? { maxDelayMs: input.maxDelayMs } : {}),
    ...(input.onError ? { onError: input.onError } : {}),
  });
  const stored = await record.read();
  if (stored?.status === "preparing") {
    notReadyStatus = "preparing";
    syncStatus();
  }
  if (stored?.status === "ready" && stored.target) {
    desiredTarget = stored.target as unknown as ManagedBrowserPoolTarget;
    desiredTargetKey = canonicalJson(desiredTarget);
  }
  // Kick the level-triggered reconciliation loop (including startup drain of all stored retired
  // targets and adoption of any stored ready target) without letting an adoption rejection stop
  // `targets.start()` from running (M4).
  void scheduleReconcile(true);
  targets.start();
  return {
    get runnerId() {
      return desiredRunnerId;
    },
    keys,
    targets,
    status: () => computeStatus(),
    unavailableReason,
    bindRunner: (runnerId) => {
      if (closed || desiredRunnerId === runnerId) return;
      desiredRunnerId = runnerId;
      input.onRunnerBound?.(runnerId);
      void scheduleReconcile(true);
      if (!desiredTarget) targets.suspect();
    },
    close: async () => {
      closed = true;
      clearRetryTimer();
      await targets.close();
      await reconciling?.catch(() => undefined);
      applied?.coordinator.close();
      applied?.relay?.retire();
      applied = undefined;
      pendingRetirement = undefined;
      syncStatus();
    },
  };
}
