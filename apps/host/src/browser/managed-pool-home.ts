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
  listBrowserPoolRetiredTargets,
  retireBrowserPoolTarget,
  type BrowserPoolRetiredTarget,
  type DatabaseSchema,
} from "@opensteer/database";
import type { RunnerAuxiliaryStream } from "@opensteer/orchestration";
import { RunnerAuxiliaryFrameFenceSchema, type RunnerDescriptor } from "@opensteer/protocol";
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
import {
  maxRunnerBrowserBinaryBytes,
  maxRunnerBrowserMessageBytes,
  type RunnerBrowserHub,
  type RunnerBrowserPeer,
} from "./runner-browser-hub.js";
import { BrowserRuntimeRelayToHostMessageSchema } from "./runner-browser-runtime.js";

/** The runtime id the Cloud Computer's Runner reports for its browser (deploy/home/compose.yaml). */
export const pooledBrowserRuntimeId = "browser-main";

/** How long a pooled browser sits open with nobody holding it before the Home parks it (5 min). */
export const defaultManagedBrowserPoolIdleMs = 5 * 60_000;

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
  detach(): void;
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
 */
function createManagedPooledRelay(input: {
  readonly browserRelay: RunnerBrowserHub;
  readonly runnerId: RunnerId;
  readonly runnerName: string;
  readonly environmentIds: readonly EnvironmentId[];
  readonly transport: ReturnType<typeof managedBrowserPool>["transport"];
  readonly ticketKey: ManagedBrowserPoolHomeKeys["ticketKey"];
  readonly passkeys: boolean;
  readonly isAgentsStopped?: (() => boolean) | undefined;
  readonly onDetached?: (() => void) | undefined;
}): ManagedPooledRelay {
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

  const detach = () => {
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
    if (attached) return;
    if (attaching) return attaching;
    const run = (async () => {
      signal?.throwIfAborted();
      const bridge = new LocalBrowserRuntimeBridge({
        transport: input.transport,
        runtimeId: pooledBrowserRuntimeId,
      });
      const capabilities = await bridge.capabilities();
      signal?.throwIfAborted();
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
            input.onDetached?.();
          }
        },
        send: (message) => relay.handleFrame(Buffer.from(JSON.stringify(message), "utf8"), false),
      };
      activePeer = peer;
      activeRelay = relay;
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
            if (buffer.byteLength > maxRunnerBrowserBinaryBytes) {
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
          if (textBytes > maxRunnerBrowserMessageBytes) {
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
      try {
        input.browserRelay.attach(peer, buildStream());
        await relay.attach(relayStream);
        attached = true;
        // Keep the synthetic stream lease well under Node's 32-bit setTimeout limit while never expiring.
        renewalTimer = setInterval(() => {
          if (activePeer === peer) input.browserRelay.renew(peer, buildStream());
        }, streamLeaseMs / 4);
        renewalTimer.unref();
      } catch (error) {
        if (activePeer === peer) detach();
        throw error;
      }
    })();
    attaching = run;
    try {
      await run;
    } finally {
      if (attaching === run) attaching = undefined;
    }
  };

  return {
    isAttached: () => attached,
    ensureAttached,
    detach,
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
    ...(input.relay ? { relay: input.relay } : {}),
    ...(input.onRunning ? { onRunning: input.onRunning } : {}),
    ...(input.drain ? { drain: input.drain } : {}),
  });
}

/**
 * Starts a pooled Cloud Computer's Home's browser: a target it already read is chosen at once (its
 * sessions were kept by the startup sweep), and the target service reads the account for any
 * other. Call after `BrowserService.initialize` and `BrowserService.setPoolSigner`.
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
  let activeRunnerId: RunnerId | undefined = input.runnerId;
  let current: string | undefined;
  let currentRunnerId: RunnerId | undefined;
  let currentTarget: ManagedBrowserPoolTarget | undefined;
  let currentCoordinator: BrowserPoolCoordinator | undefined;
  let currentRelay: ManagedPooledRelay | undefined;
  let notReadyStatus: "no-target" | "preparing" = "no-target";
  let lastStatus: ManagedBrowserPoolStatus = "no-target";
  let closed = false;

  const computeStatus = (): ManagedBrowserPoolStatus => {
    if (!currentCoordinator) return notReadyStatus;
    const phase = currentCoordinator.gate.phase;
    const report = currentCoordinator.report();
    const relayReady = currentRelay ? currentRelay.isAttached() : true;
    if (phase === "released" || phase === "unavailable" || report?.unreachable || report?.refused)
      return "unavailable";
    if (phase === "open") return relayReady ? "ready" : "unavailable";
    if (phase === "parked") return "ready";
    return "preparing";
  };

  const syncStatus = () => {
    const next = computeStatus();
    if (next === lastStatus) return;
    lastStatus = next;
    input.onStatusChanged?.(next);
  };

  const unavailableReason = (): string => {
    if (!currentCoordinator) return "Setting up your browser… This can take a few minutes.";
    const phase = currentCoordinator.gate.phase;
    const report = currentCoordinator.report();
    if (phase === "released") return "This device was removed.";
    if (report?.refused)
      return "Your Cloud Computer’s browser can’t start right now. Your tabs and sign-ins are kept.";
    if (report?.unreachable || phase === "unavailable")
      return "Your browser couldn’t start. Your tabs and sign-ins are kept. Try again in a moment.";
    if (phase === "open" && currentRelay && !currentRelay.isAttached())
      return "Your Cloud Computer’s browser can’t start right now. Your tabs and sign-ins are kept.";
    return "Setting up your browser… This can take a few minutes.";
  };

  const resolveRunner = async (): Promise<RunnerId | undefined> => {
    if (activeRunnerId) return activeRunnerId;
    const found = await input.resolveRunnerId?.();
    if (found) {
      activeRunnerId = found;
      input.onRunnerBound?.(found);
    }
    return activeRunnerId;
  };
  /** Replaced targets being drained now, by slot and term. */
  const draining = new Set<string>();
  // W8: each replaced target a Stop still waits on is asked until it has answered for each.
  const drainRetired = async (runnerId: RunnerId) => {
    for (const retired of await listBrowserPoolRetiredTargets(input.database, runnerId)) {
      const key = `${retired.slotId}:${retired.term}`;
      if (draining.has(key)) continue;
      draining.add(key);
      void input.browser
        .drainPool(runnerId, drainCoordinator(runnerId, retired))
        .catch((error: unknown) => input.onError?.(error))
        .finally(() => draining.delete(key));
    }
  };
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
  // One target change at a time: the old coordinator retires before the new one is adopted.
  // Always chain from a settled predecessor so one failed choose() never blocks later adoptions (W4).
  let changing: Promise<void> = Promise.resolve();
  const choose = (target: ManagedBrowserPoolTarget): Promise<void> => {
    const next = changing
      .catch(() => undefined)
      .then(async () => {
        if (closed) return;
        const runnerId = await resolveRunner();
        if (!runnerId)
          throw new Error(
            "Waiting for this Cloud Computer's main Runner before adopting its browser.",
          );
        // Canonical: a target read back from the database has its keys in another order.
        const key = canonicalJson(target);
        if (key === current && currentRunnerId === runnerId) return;
        const previousKey = current;
        const previousTarget = currentTarget;
        const previousRunnerId = currentRunnerId;
        if (previousKey !== undefined && previousTarget && previousRunnerId) {
          const reason = previousRunnerId !== runnerId ? "runner-replaced" : "browser-replaced";
          await input.browser.retirePool(previousRunnerId, reason);
          currentRelay?.detach();
          current = undefined;
          currentRunnerId = undefined;
          currentTarget = undefined;
          currentCoordinator = undefined;
          currentRelay = undefined;
          syncStatus();
          // Nothing of the old target is ever sent to the new one. A Stop it held that its own
          // runtime has not ended yet keeps the old target recorded, and asked (W8).
          if (previousKey !== key) {
            await retireBrowserPoolTarget(input.database, previousRunnerId, {
              target: previousTarget as unknown as Readonly<Record<string, unknown>>,
            });
            await drainRetired(previousRunnerId);
          }
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
              ...(input.isAgentsStopped
                ? { isAgentsStopped: () => input.isAgentsStopped!(runnerId) }
                : {}),
              onDetached: () => {
                if (currentRelay === relay) {
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
        current = key;
        currentRunnerId = runnerId;
        currentTarget = target;
        currentCoordinator = coordinator;
        currentRelay = relay;
        try {
          await input.browser.adoptPool(runnerId, coordinator);
        } catch (error) {
          coordinator.close();
          relay?.detach();
          if (currentCoordinator === coordinator) {
            current = undefined;
            currentRunnerId = undefined;
            currentTarget = undefined;
            currentCoordinator = undefined;
            currentRelay = undefined;
          }
          syncStatus();
          throw error;
        }
        syncStatus();
      });
    changing = next;
    return next;
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
    onTarget: choose,
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
  if (activeRunnerId) {
    // Replaced targets a Stop still waits on, from before this Home started (W8).
    await drainRetired(activeRunnerId);
    if (stored?.status === "ready" && stored.target)
      await choose(stored.target as unknown as ManagedBrowserPoolTarget);
  }
  targets.start();
  return {
    get runnerId() {
      return activeRunnerId;
    },
    keys,
    targets,
    status: () => computeStatus(),
    unavailableReason,
    bindRunner: (runnerId) => {
      if (closed || activeRunnerId === runnerId) return;
      activeRunnerId = runnerId;
      input.onRunnerBound?.(runnerId);
      void drainRetired(runnerId).catch((error: unknown) => input.onError?.(error));
      if (currentTarget) {
        void choose(currentTarget).catch((error: unknown) => input.onError?.(error));
      } else {
        targets.suspect();
      }
    },
    close: async () => {
      closed = true;
      await targets.close();
      await changing.catch(() => undefined);
      currentCoordinator?.close();
      currentCoordinator = undefined;
      currentRelay?.detach();
      currentRelay = undefined;
      current = undefined;
      currentRunnerId = undefined;
      currentTarget = undefined;
      syncStatus();
    },
  };
}
