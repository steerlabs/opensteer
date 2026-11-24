/**
 * A pooled Cloud Computer's Home chooses its browser's coordinator (phase B, piece 5: W6, S7).
 * Only a Home whose boot answer said browserPool reaches this; for it, the coordinator is built
 * for the target its account placed, and replaced, never patched, when the target changes. A
 * Home with no ready target has no coordinator at all.
 */
import { createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import type { Kysely } from "kysely";
import type { EnvironmentId, RunnerId } from "@opensteer/core";
import {
  listBrowserPoolRetiredTargets,
  retireBrowserPoolTarget,
  type BrowserPoolRetiredTarget,
  type DatabaseSchema,
} from "@opensteer/database";
import { RunnerAuxiliaryFrameFenceSchema } from "@opensteer/protocol";
import { BrowserModuleRelay, LocalBrowserRuntimeBridge } from "@opensteer/runner-client";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { BrowserPoolCoordinator } from "./browser-pool-coordinator.js";
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

/** Operator-facing status of a pooled Cloud Computer's browser target. */
export type ManagedBrowserPoolStatus = "no-target" | "preparing" | "ready";

export interface ManagedBrowserPoolHome {
  readonly runnerId: RunnerId | undefined;
  readonly keys: ManagedBrowserPoolHomeKeys;
  readonly targets: ManagedBrowserPoolTargetService;
  status(): ManagedBrowserPoolStatus;
  bindRunner(runnerId: RunnerId): void;
  close(): Promise<void>;
}

interface ManagedPooledRelay {
  ensureAttached(signal?: AbortSignal): Promise<void>;
  detach(): void;
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
      const relay = new BrowserModuleRelay(bridge);
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
          }
        },
        send: (message) => relay.handleFrame(Buffer.from(JSON.stringify(message), "utf8"), false),
      };
      activePeer = peer;
      activeRelay = relay;
      const buildStream = () => ({
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
            browser: {
              runtimeId: pooledBrowserRuntimeId,
              ...capabilities,
              stateImport: true,
              fileStaging: true,
              passkeys: 1,
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
            },
          },
        },
      });
      try {
        input.browserRelay.attach(peer, buildStream() as never);
        await relay.attach({
          fence,
          browserWireVersion: 2,
          ...(input.passkeys ? { passkeys: 1 as const } : {}),
          browserAttachPublicKeys: [
            { keyId: input.ticketKey.keyId, publicKeyPem: ticketPublicKeyPem },
          ],
          send: async (frame: Buffer | string, binary: boolean) => {
            if (binary) {
              await input.browserRelay.handleBinary(
                peer,
                Buffer.isBuffer(frame) ? frame : Buffer.from(frame),
              );
              return;
            }
            const parsed = BrowserRuntimeRelayToHostMessageSchema.parse(JSON.parse(String(frame)));
            if (parsed.type !== "runner.auxiliary.heartbeat")
              await input.browserRelay.handleMessage(peer, parsed);
          },
        } as never);
        attached = true;
        // Keep the synthetic stream lease well under Node's 32-bit setTimeout limit while never expiring.
        renewalTimer = setInterval(() => {
          if (activePeer === peer) input.browserRelay.renew(peer, buildStream() as never);
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

  return { ensureAttached, detach };
}

/** Builds the coordinator for one target: a different target is a different coordinator. */
export function managedBrowserPoolCoordinator(input: {
  readonly database: Kysely<DatabaseSchema>;
  readonly runnerId: RunnerId;
  readonly target: ManagedBrowserPoolTarget;
  readonly keys: ManagedBrowserPoolHomeKeys;
  readonly onSuspect: (reason?: "over") => void;
  readonly onError?: (error: unknown) => void;
  readonly idleParkMs?: number | null;
  readonly statusEveryMs?: number;
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
    ...(input.idleParkMs !== undefined ? { idleParkMs: input.idleParkMs } : {}),
    ...(input.statusEveryMs !== undefined ? { statusEveryMs: input.statusEveryMs } : {}),
    ...(input.onRunning ? { onRunning: input.onRunning } : {}),
    ...(input.drain ? { drain: input.drain } : {}),
  });
}

/**
 * Starts a pooled Cloud Computer's Home's browser: a target it already read is chosen at once (its
 * sessions were kept by the startup sweep), and the target service reads the account for any
 * other. Call after `BrowserService.initialize`.
 */
export async function startManagedBrowserPool(input: {
  readonly database: Kysely<DatabaseSchema>;
  readonly dataDirectory: string;
  readonly cloudComputerId: string;
  readonly runnerId?: RunnerId | undefined;
  readonly resolveRunnerId?: () => Promise<RunnerId | undefined>;
  readonly onRunnerBound?: (runnerId: RunnerId) => void;
  readonly environmentIds?: readonly EnvironmentId[];
  readonly runnerName?: string;
  readonly hostKey: KeyObject;
  readonly browser: Pick<BrowserService, "adoptPool" | "retirePool" | "drainPool">;
  readonly browserRelay?: RunnerBrowserHub;
  readonly passkeys?: boolean;
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
  const keys = await loadOrCreateManagedBrowserPoolKeys(input.dataDirectory);
  const record = databaseManagedBrowserPoolTargetRecord(input.database, input.cloudComputerId);
  let activeRunnerId: RunnerId | undefined = input.runnerId;
  let current: string | undefined;
  let currentTarget: ManagedBrowserPoolTarget | undefined;
  let currentCoordinator: BrowserPoolCoordinator | undefined;
  let currentRelay: ManagedPooledRelay | undefined;
  let status: ManagedBrowserPoolStatus = "no-target";
  let closed = false;
  const setStatus = (next: ManagedBrowserPoolStatus) => {
    if (status === next) return;
    status = next;
    input.onStatusChanged?.(next);
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
  let changing: Promise<void> = Promise.resolve();
  const choose = (target: ManagedBrowserPoolTarget) => {
    changing = changing.then(async () => {
      if (closed) return;
      const runnerId = await resolveRunner();
      if (!runnerId)
        throw new Error(
          "Waiting for this Cloud Computer's main Runner before adopting its browser.",
        );
      // Canonical: a target read back from the database has its keys in another order.
      const key = canonicalJson(target);
      if (key === current) return;
      if (current !== undefined && currentTarget) {
        await input.browser.retirePool(runnerId, "browser-replaced");
        currentRelay?.detach();
        currentRelay = undefined;
        currentCoordinator = undefined;
        // Nothing of the old target is ever sent to the new one. A Stop it held that its own
        // runtime has not ended yet keeps the old target recorded, and asked (W8).
        await retireBrowserPoolTarget(input.database, runnerId, {
          target: currentTarget as unknown as Readonly<Record<string, unknown>>,
        });
        await drainRetired(runnerId);
      }
      if (closed) return;
      const parts = managedBrowserPool(target, keys);
      const relay = input.browserRelay
        ? createManagedPooledRelay({
            browserRelay: input.browserRelay,
            runnerId,
            runnerName: input.runnerName ?? "Cloud Computer",
            environmentIds: input.environmentIds ?? [],
            transport: parts.transport,
            ticketKey: keys.ticketKey,
            passkeys: input.passkeys === true,
          })
        : undefined;
      const coordinator = managedBrowserPoolCoordinator({
        database: input.database,
        runnerId,
        target,
        keys,
        parts,
        idleParkMs:
          input.idleParkMs === undefined ? defaultManagedBrowserPoolIdleMs : input.idleParkMs,
        ...(input.statusEveryMs !== undefined ? { statusEveryMs: input.statusEveryMs } : {}),
        ...(relay ? { onRunning: (signal) => relay.ensureAttached(signal) } : {}),
        onSuspect: (reason) => targets.suspect(reason === "over" ? { over: true } : {}),
        ...(input.onError ? { onError: input.onError } : {}),
      });
      current = key;
      currentTarget = target;
      currentCoordinator = coordinator;
      currentRelay = relay;
      await input.browser.adoptPool(runnerId, coordinator);
      setStatus("ready");
    });
    return changing;
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
      if (current === undefined) setStatus(answer === "preparing" ? "preparing" : "no-target");
    },
    ...(input.firstDelayMs !== undefined ? { firstDelayMs: input.firstDelayMs } : {}),
    ...(input.maxDelayMs !== undefined ? { maxDelayMs: input.maxDelayMs } : {}),
    ...(input.onError ? { onError: input.onError } : {}),
  });
  const stored = await record.read();
  if (stored?.status === "preparing") setStatus("preparing");
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
    status: () => status,
    bindRunner: (runnerId) => {
      if (closed || activeRunnerId === runnerId) return;
      activeRunnerId = runnerId;
      input.onRunnerBound?.(runnerId);
      void drainRetired(runnerId).catch((error: unknown) => input.onError?.(error));
      targets.suspect();
    },
    close: async () => {
      closed = true;
      await targets.close();
      await changing.catch(() => undefined);
      currentCoordinator?.close();
      currentCoordinator = undefined;
      currentRelay?.detach();
      currentRelay = undefined;
    },
  };
}
