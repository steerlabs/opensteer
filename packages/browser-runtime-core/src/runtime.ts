import type {
  StandardCdpAttemptReconciliation,
  StandardCdpLeaseReconciliation,
  StandardCdpMode,
} from "@opensteer/protocol/standard-cdp";
import {
  browserFrameFits,
  defaultBrowserViewport,
  SessionCdpRouter,
  type StandardCdpAttachment,
} from "@opensteer/browser-core";
import {
  type RuntimeBrowserAttachTicketClaims as BrowserAttachTicketClaims,
  type BrowserEngine,
  type BrowserSessionId,
  type BrowserSurfaceId,
  type HeldLocalProfile,
  type InitialPageReady,
  type LocalProfileBinding,
} from "@opensteer/protocol";
import { delay } from "@opensteer/shared/delay";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { AsyncMutex, LifecycleLanes, settleCleanup } from "./async.js";
import type {
  BrowserLauncher,
  BrowserPartitionKey,
  LaunchedBrowser,
  Viewport,
} from "./browser/backend.js";
import { BrowserController, type BrowserControllerSink } from "./browser/controller.js";
import { HostSignIns } from "./browser/host-sign-ins.js";
import type {
  NativePresentationSource,
  PresentedSurface,
  PresentedSurfaceEvent,
} from "./browser/presentation.js";
import { SessionFiles, sessionFilesRoot } from "./browser/session-files.js";
import type { BrowserLoginAuthority } from "./browser/sign-in.js";
import { TabSleeper, type TabSleepPass } from "./browser/tab-sleeper.js";
import { SurfaceLedger } from "./browser/surface-ledger.js";
import {
  PageOwnership,
  type BrowserPageDiagnostic,
  type PageEndReason,
} from "./browser/page-ownership.js";
import { BrowserRuntimeError, toBrowserRuntimeError } from "./errors.js";
import {
  BrowserPoolRuntimeControl,
  type BrowserPoolControl,
  type BrowserPoolDocument,
  type BrowserPoolPageLoss,
  type BrowserPoolRuntimeHooks,
  type BrowserPoolRuntimeOptions,
} from "./browser-pool.js";
import type { TabRecord } from "./browser/surface-ledger.js";
import { LocalProfileStore, sameLocalBinding } from "./local-profile-store.js";
import { HostRelayAuthenticator } from "./passkeys/host-relay.js";
import type { AttachTicketVerifier } from "./security/attach-ticket.js";
export type BrowserRuntimeState = "closed" | "closing" | "idle" | "ready" | "starting";

const acquisitionTimeoutMs = 18_000;
const cleanupTimeoutMs = 2_000;
const shutdownTimeoutMs = 5_000;
/** Within the shutdown budget, after hosts close, for the last pages to be confirmed. */
const pageShutdownMs = 1_000;
/** One session's teardown on its profile lane, so a dying page never holds the lane. */
const sessionTeardownMs = 5_000;
export interface BrowserRuntimeOptions {
  memoryBudgetBytes?: number | undefined;
  initialViewport?: Viewport;
  launcher: BrowserLauncher;
  pool?: BrowserPoolRuntimeOptions;
  /**
   * The caller must own this root exclusively for the process lifetime (desktop
   * application lock or standalone OS lock). Only one live runtime may use it.
   */
  localProfiles?: { readonly root: string };
  runtimeId: string;
  /** Emptied on first use; each live session stages page-bound files beneath it. */
  sessionFilesRoot: string;
  /**
   * Authorizes and fills saved logins on the computer this runtime shares
   * with Opensteer Passwords. Absent on every runtime that cannot.
   */
  loginAuthority?: BrowserLoginAuthority;
  ticketVerifier: AttachTicketVerifier;
  onOpenTiming?: (diagnostic: BrowserOpenTiming) => void;
  /** Each reported sleep pass, with the runtime's native page counts. */
  onSleepPass?: (pass: TabSleepPass) => void;
  /** Page endings, sleep refusals, stuck closes, renderer crashes and exits. */
  onPageDiagnostic?: (diagnostic: BrowserPageDiagnostic) => void;
  onHostCleanupFailure?: (diagnostic: {
    readonly kind: "fresh" | "local";
    readonly stage: string;
    readonly error: unknown;
  }) => void;
  onStartFailure?: (diagnostic: {
    readonly correlationId: string;
    readonly stage: string;
    readonly error: unknown;
  }) => void;
}

export interface BrowserOpenTiming {
  readonly correlationId: string;
  readonly stage: "lane-wait" | "profile-acquire" | "root-page-ready" | "navigation-submitted";
  readonly elapsedMs: number;
  readonly elapsedSinceStartMs: number;
  readonly acquisition?: "warm" | "cold" | "guest";
}

export interface BrowserRuntimeHealth {
  wireVersion: 2;
  standardCdp: 1;
  standardCdpLineage: 1;
  connectionCommands: 1;
  wholeContextCdp?: 1;
  standardCdpLeaseRecovery: 1;
  standardCdpAttemptRecovery: 1;
  localProfileStorage?: { storageInstanceId: string; engine: BrowserEngine };
  profileHostCount: number;
  runtimeId: string;
  sessionCount: number;
  state: BrowserRuntimeState;
}

interface ActiveSession {
  claims: BrowserAttachTicketClaims;
  controller: BrowserController;
  files: SessionFiles;
  generation: number;
  host: BrowserHost;
  ledger: SurfaceLedger;
  sessionId: string;
  readonly presentations: Set<() => void>;
  reattachUntil?: ReturnType<typeof setTimeout>;
  poolDetached?: boolean;
  poolAttachment?: number;
  /** A pooled session whose channel was lost: kept until its Home reattaches or the deadline. */
  channelLostUntil?: ReturnType<typeof setTimeout>;
  /** When the lost channel's reconnect window ends; a failed reattach keeps this deadline. */
  channelLostDeadline?: number;
}

interface FreshHostIdentity {
  readonly key: BrowserPartitionKey;
  readonly kind: "fresh";
}

interface NativeHostIdentity {
  readonly key: BrowserPartitionKey;
  readonly kind: "local";
  readonly binding: LocalProfileBinding;
}
type BrowserHostIdentity = FreshHostIdentity | NativeHostIdentity;

export interface BrowserHost {
  acceptingSessions: boolean;
  lastUsed: number;
  passkeys: HostRelayAuthenticator | undefined;
  readonly passkeysEnabled: boolean;
  holdUntilClosed: boolean;
  browser: LaunchedBrowser;
  cleanup: { readonly result: Promise<void> } | null;
  disposal: Promise<void> | null;
  generation: number;
  identity: BrowserHostIdentity;
  onBrowserClose: () => void;
  quiesced: boolean;
  router: SessionCdpRouter;
  sessions: Map<string, ActiveSession>;
  readonly signIns: HostSignIns;
  readonly helperCancellation: AbortController;
  /**
   * Every session on a host shares its cookie jar, so sign-ins arriving through
   * different sessions apply one after another rather than interleaving their
   * read-then-write batches.
   */
  stateImports: AsyncMutex;
  readonly stateMutations: Map<Promise<void>, AbortSignal>;
}

/**
 * Profile identities share one host per profile; every fresh session gets its
 * own. Concurrent fresh sessions are normal, and their namespace is disjoint
 * from the profile namespace.
 */
function browserHostKey(claims: BrowserAttachTicketClaims): BrowserPartitionKey {
  return claims.identity.kind === "fresh"
    ? `session:${claims.sessionId}`
    : `profile:${claims.identity.binding.profileId}`;
}

/** How long a pooled session whose Runner channel was lost waits for its Home to come back. */
export const pooledChannelDeadlineMs = 20_000;

export class BrowserAttachment {
  readonly initialPage?: InitialPageReady;
  private closePromise: Promise<void> | null = null;
  private readonly controller: BrowserController;
  private readonly detach: (
    confirmPages: boolean,
    restarting: boolean,
    channelLost?: boolean,
  ) => Promise<void>;
  private readonly acceptsTraffic: (() => boolean) | undefined;
  readonly sessionId: string;

  constructor(
    sessionId: string,
    controller: BrowserController,
    detach: (confirmPages: boolean, restarting: boolean, channelLost?: boolean) => Promise<void>,
    initialPage?: InitialPageReady,
    acceptsTraffic?: () => boolean,
  ) {
    if (initialPage) this.initialPage = initialPage;
    this.sessionId = sessionId;
    this.controller = controller;
    this.detach = detach;
    this.acceptsTraffic = acceptsTraffic;
  }

  handle(frame: string | Buffer): Promise<void> {
    if (this.acceptsTraffic && !this.acceptsTraffic())
      return Promise.reject(new BrowserRuntimeError("conflict", "The browser is parked."));
    return this.controller.handleRaw(frame);
  }

  close(confirmPages = false, restarting = false, channelLost = false): Promise<void> {
    this.closePromise ??= this.detach(confirmPages, restarting, channelLost);
    return this.closePromise;
  }
}

/**
 * Supervises many Browser Hosts. One host owns one physical browser context —
 * a saved profile shared by its sessions, or one fresh session's throwaway
 * state. Each attach creates an isolated Browser Session inside its host.
 */
export class BrowserRuntime implements NativePresentationSource {
  private generation = 0;
  readonly standardCdpBootId = randomUUID();
  private readonly standardCdpLeases = new Map<
    BrowserPartitionKey,
    { generation: number; active?: { generation: number; client: StandardCdpAttachment } }
  >();
  private readonly standardCdpAttempts = new Map<
    string,
    { sessionId: BrowserSessionId; client: StandardCdpAttachment }
  >();
  private readonly stoppedStandardCdpAttempts = new Map<string, number>();
  private readonly initialViewport: Viewport;
  private readonly launcher: BrowserLauncher;
  private readonly lanes = new LifecycleLanes<BrowserPartitionKey>();
  private readonly pendingSessions = new Set<string>();
  private usage = 0;
  private readonly onOpenTiming: NonNullable<BrowserRuntimeOptions["onOpenTiming"]>;
  private readonly localProfilesOptions: BrowserRuntimeOptions["localProfiles"];
  private localStore: LocalProfileStore | undefined;
  private readonly deletedProfiles = new Set<string>();
  private readonly deletions = new Map<
    string,
    {
      binding: LocalProfileBinding;
      deletionId: string;
      result: Promise<"pending-restart" | "deleted">;
    }
  >();
  private readonly initialOperations = new Map<
    string,
    { fingerprint: string; sessionId: string; result?: InitialPageReady }
  >();
  private readonly hosts = new Map<BrowserPartitionKey, BrowserHost>();
  private readonly runtimeId: string;
  private readonly sessionFilesRoot: string;
  private preparation: Promise<void> | undefined;
  private readonly onHostCleanupFailure: NonNullable<BrowserRuntimeOptions["onHostCleanupFailure"]>;
  private readonly onStartFailure: NonNullable<BrowserRuntimeOptions["onStartFailure"]>;
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly sleeper: TabSleeper;
  /** Every native page this runtime holds, across sessions and hosts. */
  readonly pages: PageOwnership;
  private shuttingDown = false;
  private readonly attempts = new Set<AbortController>();
  private shutdownResult: Promise<void> | undefined;
  private readonly nativePresentations = new Set<{
    sessionId: string;
    surfaceId: BrowserSurfaceId;
    consumerToken: string | null;
  }>();
  private readonly loginAuthority: BrowserLoginAuthority | undefined;
  private state: BrowserRuntimeState = "idle";
  private readonly ticketVerifier: AttachTicketVerifier;
  private readonly pool: BrowserPoolRuntimeControl | undefined;
  private readonly poolChannelDeadlineMs: number;
  private readonly frozenPages = new Map<BrowserSurfaceId, NonNullable<TabRecord["live"]>>();
  /** Pages a vetoed retire could not thaw since that retire began; each was closed. */
  private poolUnthawed: BrowserPoolPageLoss[] = [];
  /** The session of each frozen page, so a page that does not thaw is that session's loss. */
  private readonly frozenSessions = new Map<BrowserSurfaceId, BrowserSessionId>();
  private readonly pooledCdp = new Set<StandardCdpAttachment>();
  /** Pages a session opened while it was suspended for the pool, and that were ended. */
  private poolDrops = 0;

  constructor(options: BrowserRuntimeOptions) {
    this.initialViewport = options.initialViewport ?? {
      devicePixelRatio: 1,
      ...defaultBrowserViewport,
    };
    if (
      this.initialViewport.devicePixelRatio !== 1 ||
      !browserFrameFits(
        this.initialViewport.width,
        this.initialViewport.height,
        this.initialViewport.devicePixelRatio,
      )
    ) {
      throw new TypeError("The initial browser viewport is invalid.");
    }
    this.launcher = options.launcher;
    const pool = options.pool;
    this.poolChannelDeadlineMs = pool?.channelDeadlineMs ?? pooledChannelDeadlineMs;
    if (pool) {
      this.pool = new BrowserPoolRuntimeControl(
        pool.controllerKey,
        this.poolHooks(pool),
        pool.adoptionWindowMs,
        pool.boot,
      );
    }
    this.pages = new PageOwnership({ onDiagnostic: options.onPageDiagnostic });
    this.sleeper = new TabSleeper({
      ...(options.pool ? { scheduling: false } : {}),
      memoryBudgetBytes: options.memoryBudgetBytes,
      hostCost: this.launcher.hostCost,
      rendererUsage: this.launcher.rendererUsage?.bind(this.launcher),
      onPass: options.onSleepPass,
      pageCounts: () => this.pages.counts(),
      untabbedPages: () => {
        const { provisional, closing } = this.pages.counts().states;
        return provisional + closing;
      },
      hosts: () =>
        [...this.hosts.values()].map((host) => ({
          key: host.identity.key,
          kind: host.identity.kind,
          lastUsed: host.lastUsed,
          sessionIds: [...host.sessions.keys()],
          blocked:
            !host.acceptingSessions ||
            host.holdUntilClosed ||
            host.stateMutations.size > 0 ||
            [...host.sessions.values()].some(
              (session) =>
                session.presentations.size > 0 || host.signIns.holdsSession(session.sessionId),
            ),
        })),
      retireHost: (key) =>
        this.retireHost(key).catch((error: unknown) =>
          this.reportHostCleanupFailure("fresh", "retire", error),
        ),
    });
    this.onOpenTiming = options.onOpenTiming ?? (() => {});
    this.onHostCleanupFailure =
      options.onHostCleanupFailure ??
      (({ kind, stage, error }) => {
        console.error("browser.host.cleanup.failed", {
          kind,
          stage,
          code: error instanceof BrowserRuntimeError ? error.code : "internal",
        });
      });
    this.localProfilesOptions = options.localProfiles;
    this.runtimeId = options.runtimeId;
    if (
      !path.isAbsolute(options.sessionFilesRoot) ||
      path.resolve(options.sessionFilesRoot) !== options.sessionFilesRoot
    ) {
      throw new TypeError("sessionFilesRoot must be an absolute normalized path.");
    }
    this.sessionFilesRoot = options.sessionFilesRoot;
    if (options.localProfiles) {
      const localRoot = options.localProfiles.root;
      if (!path.isAbsolute(localRoot) || path.resolve(localRoot) !== localRoot)
        throw new TypeError("localProfiles.root must be an absolute normalized path.");
      if (
        localRoot === this.sessionFilesRoot ||
        localRoot.startsWith(this.sessionFilesRoot + path.sep) ||
        (this.sessionFilesRoot.startsWith(localRoot + path.sep) &&
          this.sessionFilesRoot !== sessionFilesRoot(localRoot))
      )
        throw new TypeError("Local profiles and disposable session files must use separate roots.");
    }
    this.loginAuthority = options.loginAuthority;
    this.ticketVerifier = options.ticketVerifier;
    this.onStartFailure =
      options.onStartFailure ??
      ((diagnostic) => {
        console.error("browser.session.start.failed", {
          correlationId: diagnostic.correlationId,
          stage: diagnostic.stage,
          code:
            diagnostic.error instanceof BrowserRuntimeError ? diagnostic.error.code : "internal",
        });
      });
  }

  health(): BrowserRuntimeHealth {
    return {
      wireVersion: 2,
      standardCdp: 1,
      standardCdpLineage: 1,
      connectionCommands: 1,
      standardCdpLeaseRecovery: 1,
      standardCdpAttemptRecovery: 1,
      ...(this.launcher.hostCost === "process" && this.localProfileStorage?.engine === "chromium"
        ? { wholeContextCdp: 1 as const }
        : {}),
      ...(this.localProfileStorage
        ? {
            localProfileStorage: this.localProfileStorage,
          }
        : {}),
      profileHostCount: this.hosts.size,
      runtimeId: this.runtimeId,
      sessionCount: this.sessions.size,
      state: this.state,
    };
  }

  poolState() {
    return this.pool?.state();
  }

  get pooled(): boolean {
    return this.pool !== undefined;
  }

  controlPool(control: BrowserPoolControl, signature: Uint8Array) {
    if (!this.pool || this.shuttingDown)
      return Promise.reject(
        new BrowserRuntimeError("not_found", "Browser pool control is unavailable."),
      );
    return this.pool.apply(control, signature);
  }

  private requirePoolTraffic(claims?: BrowserAttachTicketClaims, adoptionAttach = false): void {
    if (this.pool) {
      if (
        !this.pool.acceptsTraffic &&
        !(adoptionAttach && claims?.reattach && this.pool.canAdopt(claims.sessionId))
      )
        throw new BrowserRuntimeError("conflict", "The browser is parked.");
      if (claims) this.pool.checkFence(claims.pool);
    } else if (claims?.pool) {
      throw new BrowserRuntimeError("forbidden", "This browser runtime is outside the pool.");
    }
  }

  private poolTrafficFor(session: ActiveSession, generation: number): (() => boolean) | undefined {
    if (!this.pool) return undefined;
    return () =>
      (this.pool!.acceptsTraffic || this.pool!.canAdopt(session.sessionId as BrowserSessionId)) &&
      !session.poolDetached &&
      this.sessions.get(session.sessionId)?.generation === generation;
  }

  private poolHooks(options: BrowserPoolRuntimeOptions): BrowserPoolRuntimeHooks {
    return {
      retire: () => this.retireForPool(options),
      finishAdoption: (sessions, attempt, reason) =>
        this.finishPoolAdoption(sessions, attempt, reason),
      discard: () => this.discardForPool(),
      highestAttempt: (sessions) =>
        Math.max(0, ...sessions.map((id) => this.sessions.get(id)?.poolAttachment ?? 0)),
      dropped: () => this.poolDrops,
      unthawed: () => this.poolUnthawed,
      detached: () =>
        [...this.sessions.values()]
          .filter((session) => session.poolDetached)
          .map((session) => session.sessionId as BrowserSessionId),
    };
  }

  private async retireForPool(options: BrowserPoolRuntimeOptions) {
    this.poolDrops = 0;
    this.poolUnthawed = [];
    try {
      await withTimeout(
        (async () => {
          await this.lanes.drain();
          await Promise.all(
            [...this.sessions.values()].map(({ controller }) => controller.drainForPool()),
          );
        })(),
        cleanupTimeoutMs,
        { timeoutError: () => new Error("Browser commands did not drain.") },
      );
    } catch {
      return ["command-drain-unknown"];
    }
    const sessions = [...this.sessions.values()];
    const pages = sessions.flatMap((session) =>
      [...session.ledger.policyRecords()].map((record) => ({
        session,
        record,
        live: record.live,
        documentId: record.documentId,
      })),
    );
    const probe = async (phase: "active" | "frozen") => {
      const blockers = new Set<string>();
      if (this.pooledCdp.size) blockers.add("standard-cdp");
      if (this.nativePresentations.size) blockers.add("presentation");
      if (this.pendingSessions.size) blockers.add("session-changing");
      const { provisional, closing } = this.pages.counts().states;
      if (provisional || closing) blockers.add("page-ownership");
      for (const host of this.hosts.values()) {
        if (host.stateMutations.size) blockers.add("cookie-import");
        if (!host.acceptingSessions) blockers.add("host-state-unknown");
        if (
          host.browser.context
            .pages()
            .some((page) => !pages.some(({ live }) => live?.page === page))
        )
          blockers.add("page-ownership");
      }
      for (const session of sessions) {
        // Missing protection data is unknown, never quiet.
        const state = this.sleeper.poolState(session.sessionId);
        if (!state || state.runs || state.keepAwake) blockers.add("session-protection-unknown");
        if (state?.viewed.length || state?.pinned.length) blockers.add("viewed-or-pinned");
        if (
          session.reattachUntil ||
          session.poolDetached ||
          session.ledger.closing ||
          this.sessions.get(session.sessionId) !== session
        )
          blockers.add("session-changing");
      }
      await Promise.all(
        pages.map(async ({ session, record, live, documentId }) => {
          const protection = session.controller.sleepProtection(record.id);
          if (protection) blockers.add(protection);
          if (record.lease.busy || record.live !== live || record.documentId !== documentId)
            blockers.add("document-changing");
          if (!live) return;
          if (live.dialog) blockers.add("dialog");
          if (live.loading || live.pendingNavigations.size) blockers.add("navigation");
          if (live.page.isClosed()) blockers.add("page-closed");
          for (const reason of await options.probePage(live.page, phase)) blockers.add(reason);
        }),
      );
      return [...blockers].sort();
    };
    const boundedProbe = (phase: "active" | "frozen") =>
      withTimeout(probe(phase), cleanupTimeoutMs, {
        timeoutError: () => new Error("Browser quiescence could not be observed."),
      }).catch(() => ["page-quiescence-unknown"]);
    const before = await boundedProbe("active");
    if (before.length) return before;
    try {
      for (const { session, record, live } of pages) {
        if (!live) continue;
        this.frozenPages.set(record.id, live);
        this.frozenSessions.set(record.id, session.claims.sessionId);
        await this.setPoolLifecycle(live, "frozen");
      }
    } catch {
      await this.thawVetoed().catch(() => undefined);
      return ["page-lifecycle-unknown"];
    }
    const after = await boundedProbe("frozen");
    if (after.length) {
      await this.thawVetoed();
      return after;
    }
    // Every live page of every session is kept; nothing a person could lose is ended.
    const documents: BrowserPoolDocument[] = pages.flatMap(
      ({ session, record, live, documentId }) =>
        live
          ? [
              {
                sessionId: session.claims.sessionId,
                surfaceId: record.id,
                documentId,
                pageRevision: live.commitSequence,
                typed: record.typed,
              },
            ]
          : [],
    );
    for (const session of sessions) {
      session.poolDetached = true;
      session.ledger.suspendForPool(() => this.poolDrops++);
      await session.host.router.unregisterSession(session.sessionId, true);
      await session.controller.detachForPool();
    }
    return { documents, sessions: sessions.map(({ claims }) => claims.sessionId) };
  }

  private setPoolLifecycle(page: NonNullable<TabRecord["live"]>, state: "active" | "frozen") {
    return withTimeout(page.cdp.send("Page.setWebLifecycleState", { state }), cleanupTimeoutMs, {
      timeoutError: () => new Error("The browser page lifecycle could not be confirmed."),
    });
  }

  /**
   * Thaws every frozen page. A page that cannot be thawed is closed, so it is never shown as
   * usable while frozen, and is returned as its own loss; the others still thaw.
   */
  private async thawPoolPages(): Promise<
    { readonly surfaceId: BrowserSurfaceId; readonly sessionId: BrowserSessionId | undefined }[]
  > {
    const failed: { surfaceId: BrowserSurfaceId; sessionId: BrowserSessionId | undefined }[] = [];
    for (const [id, live] of this.frozenPages) {
      const sessionId = this.frozenSessions.get(id);
      this.frozenPages.delete(id);
      this.frozenSessions.delete(id);
      if (live.page.isClosed()) continue;
      try {
        await this.setPoolLifecycle(live, "active");
      } catch {
        failed.push({ surfaceId: id, sessionId });
        await live.page.close().catch(() => undefined);
      }
    }
    return failed;
  }

  /** A vetoed retire thaws its pages; one that cannot be thawed is closed and is a loss. */
  private async thawVetoed(): Promise<void> {
    for (const { surfaceId, sessionId } of await this.thawPoolPages())
      if (sessionId) this.poolUnthawed.push({ sessionId, surfaceId, reason: "thaw-failed" });
  }

  /** A retained session is adopted only if its current channel is the given attempt's. */
  private async finishPoolAdoption(
    sessions: readonly BrowserSessionId[],
    attempt: number | null,
    reason: string,
  ) {
    await this.lanes.drain();
    const adopted: BrowserSessionId[] = [];
    const lost: { sessionId: BrowserSessionId; reason: string }[] = [];
    for (const sessionId of sessions) {
      const session = this.sessions.get(sessionId);
      if (
        session &&
        !session.poolDetached &&
        (attempt === null || session.poolAttachment === attempt)
      ) {
        adopted.push(sessionId);
        continue;
      }
      // Ending one lost session is that session's alone: a failure cannot touch the adopted.
      const ended = session
        ? await this.endPooledSession(session).then(
            () => true,
            () => false,
          )
        : true;
      lost.push({ sessionId, reason: ended ? reason : `${reason}; end-unconfirmed` });
    }
    // A page that did not thaw is that page's loss; its session and the others are kept.
    const pagesLost = (await this.thawPoolPages()).flatMap(({ surfaceId, sessionId }) =>
      sessionId && adopted.includes(sessionId)
        ? [{ sessionId, surfaceId, reason: "thaw-failed" }]
        : [],
    );
    return { adopted, lost, ...(pagesLost.length ? { pagesLost } : {}) };
  }

  private async endPooledSession(session: ActiveSession): Promise<void> {
    session.poolDetached = true;
    for (const record of session.ledger.policyRecords()) {
      this.frozenPages.delete(record.id);
      this.frozenSessions.delete(record.id);
    }
    await this.detach(session.sessionId, session.generation, true, false, true);
  }

  /** The loopback stand-in for a newly started guest: no page of the previous one survives. */
  private async discardForPool(): Promise<void> {
    this.frozenPages.clear();
    this.frozenSessions.clear();
    // A copy: ending a session removes it from the map.
    for (const session of Array.from(this.sessions.values())) {
      session.poolDetached = true;
      await session.controller.detachForPool().catch(() => undefined);
      await this.detach(session.sessionId, session.generation, false, false, true);
    }
  }

  prepare(): Promise<void> {
    if (this.shuttingDown || this.state === "closed")
      return Promise.reject(new Error("The Browser Runtime is shutting down."));
    if (this.preparation) return this.preparation;
    const preparing = (async () => {
      let acquired: LocalProfileStore | undefined;
      try {
        if (this.localProfilesOptions && this.launcher.localProfiles) {
          let waiting = true;
          const acquiring = LocalProfileStore.acquire(
            this.localProfilesOptions.root,
            this.launcher.localProfiles.engine,
          );
          void acquiring.then(
            (store) => {
              if (!waiting) void store.close();
            },
            () => undefined,
          );
          try {
            acquired = await withTimeout(acquiring, 5_000, {
              timeoutError: () => new Error("Native profile root setup timed out."),
            });
          } catch (error) {
            waiting = false;
            throw error;
          }
          if (this.shuttingDown) throw new Error("Browser Runtime is shutting down.");
          this.localStore = acquired;
        }
        for (let attempt = 0; ; attempt += 1) {
          try {
            // This root contains only sessions from an earlier runtime. No
            // session is admitted until preparation finishes.
            await rm(this.sessionFilesRoot, { force: true, recursive: true });
            await mkdir(this.sessionFilesRoot, { mode: 0o700, recursive: true });
            break;
          } catch (error) {
            if (attempt >= 2 || !["EBUSY", "EMFILE", "ENFILE"].includes(nodeErrorCode(error) ?? ""))
              throw error;
            await delay(100 * 2 ** attempt);
          }
        }
        await withTimeout(Promise.resolve(this.launcher.prepare?.()), 5_000, {
          timeoutError: () => new Error("Browser engine setup timed out."),
        });
        if (this.shuttingDown) throw new Error("Browser Runtime is shutting down.");
      } catch (error) {
        if (this.localStore === acquired) this.localStore = undefined;
        await acquired?.close();
        throw error;
      }
    })();
    this.preparation = preparing;
    void preparing.catch(() => {
      if (this.preparation === preparing) this.preparation = undefined;
    });
    return this.preparation;
  }

  hasSession(sessionId: BrowserSessionId): boolean {
    return !this.shuttingDown && this.sessions.has(sessionId);
  }

  presentSurface(
    sessionId: BrowserSessionId,
    surfaceId: BrowserSurfaceId,
  ): PresentedSurface | null {
    if (this.pool) return null;
    const session = this.sessions.get(sessionId);
    session?.ledger.demand(surfaceId);
    const binding = session?.ledger.binding(surfaceId);
    if (this.shuttingDown || !session || !binding || binding.page.isClosed()) return null;
    const listeners = new Set<(event: PresentedSurfaceEvent) => void>();
    let released = false;
    const native = { sessionId, surfaceId, consumerToken: null as string | null };
    this.nativePresentations.add(native);
    session.ledger.touch(surfaceId, true);
    const release = () => {
      if (released) return;
      released = true;
      this.nativePresentations.delete(native);
      this.sleeper.poke();
      unsubscribe();
      session.presentations.delete(closed);
      binding.page.offClose(closed);
      listeners.clear();
    };
    const closed = () => {
      if (released) return;
      const recipients = [...listeners];
      release();
      for (const listener of recipients) listener({ type: "closed" });
    };
    const unsubscribe = session.ledger.subscribe((event) => {
      if (
        event.type === "closed" ||
        (event.type === "changed" && event.change === "closed" && event.surface.id === surfaceId)
      )
        closed();
      if (event.type === "geometry" && event.surfaceId === surfaceId) {
        for (const listener of listeners) {
          listener({
            geometry: event.geometry,
            geometryRevision: event.geometryRevision,
            type: "geometry",
          });
        }
      }
    });
    binding.page.onClose(closed);
    session.presentations.add(closed);
    return {
      passkeyInput: (consumerToken) => {
        if (!released && session.claims.passkeys === 1)
          session.host.passkeys?.record(
            binding.targetId,
            consumerToken ? { person: consumerToken } : "unknown",
          );
      },
      viewerInput: (consumerToken) => {
        if (!released) {
          native.consumerToken = consumerToken;
          session.ledger.recordViewerInput(surfaceId, consumerToken, true);
        }
      },
      page: binding.page,
      sessionId,
      surfaceId,
      follow: (size) => {
        if (released)
          return Promise.reject(
            new BrowserRuntimeError("not_found", "The presentation is released."),
          );
        return session.controller.followPresentedSurface(surfaceId, () =>
          released ? null : typeof size === "function" ? size() : size,
        );
      },
      geometry: () => (released ? null : session.ledger.appliedGeometry(surfaceId)),
      onEvent: (listener) => {
        if (!released) listeners.add(listener);
        return () => listeners.delete(listener);
      },
      release,
    };
  }

  get localProfileStorage(): { storageInstanceId: string; engine: BrowserEngine } | undefined {
    return this.localStore && !this.shuttingDown
      ? { storageInstanceId: this.localStore.storageInstanceId, engine: this.localStore.engine }
      : undefined;
  }

  async localProfileInventory(): Promise<HeldLocalProfile[]> {
    await this.prepare();
    if (!this.localStore)
      throw new BrowserRuntimeError("conflict", "Native profiles are unavailable.");
    return this.localStore.inventory();
  }

  deleteLocalProfile(
    binding: LocalProfileBinding,
    deletionId: string,
  ): Promise<"pending-restart" | "deleted"> {
    if (this.pool && !this.pool.acceptsTraffic)
      return Promise.reject(new BrowserRuntimeError("conflict", "The browser is parked."));
    if (this.shuttingDown)
      return Promise.reject(
        new BrowserRuntimeError("conflict", "The Browser Runtime is shutting down."),
      );
    // Fence immediately, before waiting for already admitted page work.
    if (
      !this.localStore ||
      binding.storageInstanceId !== this.localStore.storageInstanceId ||
      binding.engine !== this.localStore.engine
    )
      return Promise.reject(
        new BrowserRuntimeError(
          "conflict",
          "The deletion belongs to another local storage instance.",
        ),
      );
    const previous = this.deletions.get(binding.profileId);
    if (previous) {
      if (previous.deletionId !== deletionId || !sameLocalBinding(previous.binding, binding))
        return Promise.reject(
          new BrowserRuntimeError(
            "conflict",
            "A different profile deletion already owns this binding.",
          ),
        );
      return previous.result;
    }
    this.deletedProfiles.add(binding.profileId);
    const store = this.localStore;
    const durable = store.tombstone(binding, deletionId);
    void durable.catch(() => undefined);
    const result = this.lanes.run(`profile:${binding.profileId}`, async () => {
      const claim = await durable;
      const engine = this.launcher.localProfiles!;
      const host = this.hosts.get(`profile:${binding.profileId}`);
      if (host) {
        if (host.identity.kind !== "local" || !sameLocalBinding(host.identity.binding, binding))
          throw new BrowserRuntimeError(
            "conflict",
            "The deletion binding does not match the browser host.",
          );
        host.helperCancellation.abort();
        await this.cleanupHost(host, "profile-closed");
      }
      if (claim.erasure === "deleted") return "deleted" as const;
      const released = await engine.release(store.directory(binding));
      if (released === "retained-until-exit") {
        store.retainDirectory(binding);
        return "pending-restart" as const;
      }
      await store.erase(binding, deletionId);
      return "deleted" as const;
    });
    const deletion = { binding, deletionId, result };
    this.deletions.set(binding.profileId, deletion);
    void result.catch(() => {
      if (this.deletions.get(binding.profileId) === deletion)
        this.deletions.delete(binding.profileId);
    });
    return result;
  }

  async reconcileStandardCdpLease(lease?: StandardCdpLeaseReconciliation) {
    if (lease) {
      this.requirePoolTraffic();
      const hostKey = `profile:${lease.profileId}` as const;
      const state = this.standardCdpLeases.get(hostKey) ?? { generation: 0 };
      state.generation = Math.max(state.generation, lease.generation);
      this.standardCdpLeases.set(hostKey, state);
      const active = state.active;
      if (active?.generation === lease.generation) {
        active.client.close();
        await active.client.settled;
      }
    }
    return { runtimeBootId: this.standardCdpBootId };
  }

  async reconcileStandardCdpAttempt(attempt: StandardCdpAttemptReconciliation) {
    this.requirePoolTraffic();
    if (attempt.runtimeBootId === this.standardCdpBootId) {
      const active = this.standardCdpAttempts.get(attempt.attachmentId);
      if (active && active.sessionId !== attempt.sessionId)
        throw new BrowserRuntimeError(
          "forbidden",
          "The CDP attachment belongs to another session.",
        );
      const now = Date.now();
      for (const [id, expiresAt] of this.stoppedStandardCdpAttempts)
        if (expiresAt <= now) this.stoppedStandardCdpAttempts.delete(id);
      const expiresAt = Date.parse(attempt.operationExpiresAt);
      if (expiresAt > now) this.stoppedStandardCdpAttempts.set(attempt.attachmentId, expiresAt);
      if (active) {
        active.client.close();
        await active.client.settled;
      }
    }
    return { runtimeBootId: this.standardCdpBootId, attachmentId: attempt.attachmentId };
  }

  /** A signed raw CDP ticket attaches to a live Browser Session without taking its lifecycle lease. */
  async attachStandardCdp(
    ticket: string,
    onOverflow: () => void,
    signal: AbortSignal,
  ): Promise<StandardCdpAttachment & { readonly mode?: StandardCdpMode }> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(acquisitionTimeoutMs)]);
    const claims = await waitForAcquisition(
      this.ticketVerifier.verify(ticket, { runtimeId: this.runtimeId }),
      deadline,
    );
    if (!claims.standardCdp || claims.access !== "read-write" || claims.initialNavigation)
      throw new BrowserRuntimeError("forbidden", "This ticket does not authorize standard CDP.");
    const mode = claims.standardCdp;
    const hostKey = browserHostKey(claims);
    return this.lanes.run(hostKey, async () => {
      deadline.throwIfAborted();
      this.requirePoolTraffic(claims);
      const active = this.sessions.get(claims.sessionId);
      if (
        this.shuttingDown ||
        !active ||
        active.poolDetached ||
        !active.host.acceptingSessions ||
        active.host.identity.key !== hostKey ||
        active.claims.subject !== claims.subject ||
        Date.parse(claims.operationExpiresAt) <= Date.now() ||
        (claims.identity.kind === "profile-local" &&
          (active.host.identity.kind !== "local" ||
            !sameLocalBinding(active.host.identity.binding, claims.identity.binding)))
      )
        throw new BrowserRuntimeError(
          "forbidden",
          "This ticket does not authorize a live Browser Session.",
        );
      const attempt = claims.standardCdpAttempt;
      if (
        attempt &&
        (mode !== "session" ||
          attempt.runtimeBootId !== this.standardCdpBootId ||
          this.stoppedStandardCdpAttempts.has(attempt.attachmentId) ||
          this.standardCdpAttempts.has(attempt.attachmentId))
      )
        throw new BrowserRuntimeError("forbidden", "This browser attachment has ended.");
      const wholeContext = claims.standardCdp === "whole-context";
      const exclusive = claims.standardCdpLease;
      const state = this.standardCdpLeases.get(hostKey);
      if (
        wholeContext &&
        (claims.identity.kind !== "profile-local" ||
          !exclusive ||
          exclusive.bootId !== this.standardCdpBootId ||
          state?.active !== undefined ||
          exclusive.generation <= (state?.generation ?? 0))
      )
        throw new BrowserRuntimeError(
          "forbidden",
          "Whole-context CDP requires an exclusive saved profile.",
        );
      const client = active.controller.openStandardCdp(
        wholeContext,
        onOverflow,
        claims.standardCdpLineage,
      );
      if (this.pool) {
        this.pooledCdp.add(client);
        const release = () => this.pooledCdp.delete(client);
        void client.settled.then(release, release);
      }
      if (attempt) {
        this.standardCdpAttempts.set(attempt.attachmentId, { sessionId: claims.sessionId, client });
        void client.settled.then(() => this.standardCdpAttempts.delete(attempt.attachmentId));
      }
      if (wholeContext && exclusive) {
        const entry = { generation: exclusive.generation, client };
        const lease = { generation: exclusive.generation, active: entry };
        this.standardCdpLeases.set(hostKey, lease);
        void client.settled.then(() => {
          const current = this.standardCdpLeases.get(hostKey);
          if (current?.active === entry) delete current.active;
        });
      }
      return { ...client, mode };
    });
  }

  async attach(
    ticket: string,
    sink: BrowserControllerSink,
    options: {
      passkeys?: boolean;
      signal?: AbortSignal;
      waitForCleanup?: boolean;
    } = {},
  ): Promise<BrowserAttachment> {
    const cancellation = new AbortController();
    this.attempts.add(cancellation);
    const abort = () => cancellation.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(
      () =>
        cancellation.abort(
          new BrowserRuntimeError(
            "conflict",
            "Opening this browser timed out. Retry or close the tab.",
            { retryable: true, reason: "browser-open.timeout" },
          ),
        ),
      acquisitionTimeoutMs,
    );
    timer.unref?.();
    const signal = cancellation.signal;
    const wait = <T>(operation: Promise<T>) => waitForAcquisition(operation, signal);
    try {
      const attempt = this.attachAttempt(ticket, sink, options, signal);
      return await (options.waitForCleanup ? attempt : wait(attempt));
    } finally {
      clearTimeout(timer);
      this.attempts.delete(cancellation);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  private async attachAttempt(
    ticket: string,
    sink: BrowserControllerSink,
    options: NonNullable<Parameters<BrowserRuntime["attach"]>[2]>,
    parentSignal: AbortSignal,
  ): Promise<BrowserAttachment> {
    let signal = parentSignal;
    const wait = <T>(operation: Promise<T>) => waitForAcquisition(operation, signal);
    const started = performance.now();
    let correlationId = "unverified";
    const timing = (
      stage: BrowserOpenTiming["stage"],
      since: number,
      acquisition?: BrowserOpenTiming["acquisition"],
    ) => {
      const now = performance.now();
      try {
        this.onOpenTiming({
          correlationId,
          stage,
          elapsedMs: now - since,
          elapsedSinceStartMs: now - started,
          ...(acquisition ? { acquisition } : {}),
        });
      } catch {
        // Diagnostics cannot change browser ownership or readiness.
      }
    };
    const verified = await wait(this.ticketVerifier.verify(ticket, { runtimeId: this.runtimeId }));
    this.requirePoolTraffic(verified, true);
    if (verified.standardCdp)
      throw new BrowserRuntimeError("forbidden", "This ticket is for the standard CDP endpoint.");
    const claims = options.passkeys ? verified : { ...verified, passkeys: undefined };
    if (claims.wireVersion !== 2)
      throw new BrowserRuntimeError(
        "conflict",
        "Update this Browser Runtime to use the current browser contract.",
      );
    correlationId = claims.initialNavigation?.operationKey ?? claims.sessionId;
    const remaining = Math.min(
      acquisitionTimeoutMs,
      claims.remainingBudgetMs,
      Date.parse(claims.operationExpiresAt) - Date.now(),
    );
    if (remaining <= 0)
      throw new BrowserRuntimeError("conflict", "The browser opening authority expired.", {
        reason: "browser-open.timeout",
      });
    signal = AbortSignal.any([parentSignal, AbortSignal.timeout(remaining)]);
    const hostKey = browserHostKey(claims);
    const queued = performance.now();
    return this.lanes.run(hostKey, async () => {
      timing("lane-wait", queued);
      signal.throwIfAborted();
      this.requirePoolTraffic(claims, true);
      if (this.shuttingDown || this.state === "closed") {
        throw new BrowserRuntimeError("conflict", "The Browser Runtime is shutting down.");
      }
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(claims.sessionId))
        throw new BrowserRuntimeError("bad_message", "The Browser Session ID is invalid.");
      const operationKey = claims.initialNavigation
        ? `${claims.subject}:${claims.initialNavigation.operationKey}`
        : undefined;
      const fingerprint = JSON.stringify({
        sessionId: claims.sessionId,
        identity: claims.identity.kind === "profile-local" ? claims.identity.binding : "fresh",
        navigation: claims.initialNavigation,
      });
      const previous = operationKey ? this.initialOperations.get(operationKey) : undefined;
      const active = previous && this.sessions.get(previous.sessionId);
      if (this.pool) {
        const attachment = claims.pool?.attachment;
        const held = this.sessions.get(claims.sessionId);
        if (!attachment || (held?.poolAttachment && attachment <= held.poolAttachment))
          throw new BrowserRuntimeError("forbidden", "The pooled browser attachment is stale.");
        if (held && (this.pool.canAdopt(claims.sessionId) || held.channelLostUntil !== undefined))
          return wait(this.reattachAfterPool(held, claims, sink, attachment));
        if (!this.pool.acceptsTraffic || held?.poolDetached)
          throw new BrowserRuntimeError("not_found", "The retained Browser Session has ended.");
        if (held) held.poolAttachment = attachment;
      }
      if (claims.reattach && active?.sessionId !== claims.sessionId)
        throw new BrowserRuntimeError("not_found", "The browser session has ended.");
      if (
        claims.identity.kind !== "fresh" &&
        this.deletedProfiles.has(hostKey.slice("profile:".length))
      )
        throw new BrowserRuntimeError("conflict", "This browser profile has been deleted.");
      if (previous) {
        if (previous.fingerprint !== fingerprint || !active || !previous.result)
          throw new BrowserRuntimeError(
            "conflict",
            "The initial browser operation already has an outcome; it cannot start another browser.",
          );
        this.sleeper.resetSessionState(active.sessionId);
        if (active.reattachUntil) {
          if (claims.actor !== "person" || active.claims.actor !== "person")
            throw new BrowserRuntimeError(
              "forbidden",
              "This browser is reconnecting for the person.",
            );
          const [root, ...others] = active.ledger.resumeAfterRelayRestart();
          if (!root) throw new BrowserRuntimeError("not_found", "The browser page closed.");
          const router = active.host.router;
          try {
            router.registerSession(
              active.sessionId,
              root,
              active.ledger.resolveTarget.bind(active.ledger),
              active.files.root,
            );
            for (const target of others) router.claimTarget(active.sessionId, target);
            const controller = this.createController(
              active.host,
              claims,
              active.files,
              active.ledger,
              sink,
            );
            active.controller = controller;
            await wait(controller.start());
          } catch (error) {
            await router.unregisterSession(active.sessionId);
            throw error;
          }
          clearTimeout(active.reattachUntil);
          delete active.reattachUntil;
        } else {
          await wait(active.controller.reattach(sink));
        }
        active.generation = ++this.generation;
        const generation = active.generation;
        return new BrowserAttachment(
          active.sessionId,
          active.controller,
          (confirmPages, restarting, channelLost) =>
            this.detach(active.sessionId, generation, confirmPages, restarting, false, channelLost),
          previous.result,
          this.poolTrafficFor(active, generation),
        );
      }
      if (this.sessions.has(claims.sessionId) || this.pendingSessions.has(claims.sessionId))
        throw new BrowserRuntimeError("conflict", "The Browser Session is already attached.");
      this.pendingSessions.add(claims.sessionId);
      if (operationKey)
        this.initialOperations.set(operationKey, { fingerprint, sessionId: claims.sessionId });
      try {
        try {
          await wait(this.prepare());
        } catch (error) {
          throw this.startFailure(claims.sessionId, "runtime-preparation", error);
        }
        if (claims.identity.kind === "profile-local" && !this.localStore)
          throw new BrowserRuntimeError(
            "conflict",
            "Native browser profile storage is unavailable.",
          );
        const files = new SessionFiles(path.join(this.sessionFilesRoot, claims.sessionId));
        this.state = "starting";

        const acquiring = performance.now();
        let pageStarting = acquiring;
        let host = this.hosts.get(hostKey);
        let createdHost = false;
        let ledger: SurfaceLedger | null = null;
        let controller: BrowserController | null = null;
        let rootPage = null as Awaited<ReturnType<LaunchedBrowser["context"]["createPage"]>> | null;
        const sessionGeneration = ++this.generation;
        let stage = "profile-state";
        try {
          const acquired = await this.acquireHost(claims, hostKey, signal);
          if (!acquired.host) throw new Error("Browser acquisition returned no host.");
          host = acquired.host;
          createdHost = acquired.createdHost;
          signal.throwIfAborted();
          const acquisition = acquired.acquisition;
          timing("profile-acquire", acquiring, acquisition);
          pageStarting = performance.now();
          stage = "profile-admission";
          await wait(Promise.resolve(host.browser.profile?.admit(signal)));
          if (
            signal.aborted ||
            this.shuttingDown ||
            (claims.identity.kind !== "fresh" &&
              this.deletedProfiles.has(hostKey.slice("profile:".length)))
          )
            throw new BrowserRuntimeError(
              "conflict",
              "This browser profile has been deleted or stopped.",
            );
          if (host.router.hasExclusiveContextClient)
            throw new BrowserRuntimeError(
              "conflict",
              "This browser profile has a whole-context CDP attachment.",
            );
          stage = "page-create";
          // A new host's launch page is this session's root unless another already owns it.
          const launchPage = createdHost ? host.browser.context.pages()[0] : undefined;
          if (launchPage && this.pages.claim(launchPage, claims.sessionId)) rootPage = launchPage;
          else {
            // Owned by this session from its handle on; rollback ends it.
            const context = host.browser.context;
            const creation = this.pages.create(claims.sessionId, null, "open-failed", (own) =>
              context.createPage({ own }),
            );
            rootPage = await wait(creation.page);
          }

          signal.throwIfAborted();
          stage = "session-initialize";
          const sessionRouter = host.router;
          ledger = new SurfaceLedger(host.browser.context, {
            pages: this.pages,
            sessionId: claims.sessionId,
            creationOrigin: claims.creationOrigin,
            navigationVersion: claims.navigationVersion,
            beforeResize: async (surfaceId) =>
              (this.sessions.get(claims.sessionId)?.controller ?? controller)?.prepareResize(
                surfaceId,
              ),
            // Every page the session holds, a tab the person opened included, is
            // one its agents can list and attach to.
            claimTarget: (targetId, openerId) =>
              sessionRouter.claimTarget(claims.sessionId, targetId, openerId),
            releaseTarget: (targetId) => sessionRouter.releaseTarget(claims.sessionId, targetId),
            // A person who started the browser from a view gets its first page
            // at that view's size, before anything loads there.
            initialViewport: claims.viewport
              ? { devicePixelRatio: 1, ...claims.viewport }
              : this.initialViewport,
            rootPages: [rootPage],
            ...(claims.tabRestoreVersion === 1 && claims.initialSurfaceId
              ? { initialSurfaceId: claims.initialSurfaceId }
              : {}),
          });
          sessionRouter.registerSession(
            claims.sessionId,
            await wait(rootPage.targetId()),
            ledger.resolveTarget.bind(ledger),
            files.root,
          );
          await wait(ledger.start());
          controller = this.createController(host, claims, files, ledger, sink);
          const active: ActiveSession = {
            claims,
            controller,
            files,
            generation: sessionGeneration,
            host,
            ledger,
            sessionId: claims.sessionId,
            presentations: new Set(),
            ...(claims.pool?.attachment ? { poolAttachment: claims.pool.attachment } : {}),
          };
          host.sessions.set(claims.sessionId, active);
          this.sessions.set(claims.sessionId, active);
          this.sleeper.add(claims.sessionId, {
            ledger,
            restoreVersion: claims.tabRestoreVersion,
            blocked: (id) =>
              [...this.nativePresentations].some(
                (p) => p.sessionId === claims.sessionId && p.surfaceId === id,
              )
                ? "native"
                : active.controller.sleepProtection(id),
          });
          stage = "session-snapshot";
          await wait(controller.start());
          timing("root-page-ready", pageStarting);
          let initialPage: InitialPageReady | undefined;
          if (claims.initialNavigation) {
            const navigating = performance.now();
            initialPage = controller.startInitialNavigation(rootPage, claims.initialNavigation);
            timing("navigation-submitted", navigating);
            this.initialOperations.set(operationKey!, {
              fingerprint,
              sessionId: claims.sessionId,
              result: initialPage,
            });
          }
          host.lastUsed = ++this.usage;
          this.state = "ready";
          return new BrowserAttachment(
            claims.sessionId,
            controller,
            (confirmPages, restarting, channelLost) =>
              this.detach(
                claims.sessionId,
                sessionGeneration,
                confirmPages,
                restarting,
                false,
                channelLost,
              ),
            initialPage,
            this.poolTrafficFor(active, sessionGeneration),
          );
        } catch (error) {
          if (host) {
            host.sessions.delete(claims.sessionId);
            await boundedCleanup(host.router.unregisterSession(claims.sessionId)).catch(
              () => undefined,
            );
          }
          this.sleeper.remove(claims.sessionId);
          this.sessions.delete(claims.sessionId);
          await boundedCleanup(
            settleCleanup([
              async () => controller?.close(),
              async () => ledger?.closeOwnedPages("open-failed"),
              async () => ledger?.close(),
              () => files.dispose(),
              async () => {
                // Pages still being created or registered for this session end too.
                void this.pages.endSession(claims.sessionId, "open-failed");
                if (createdHost && host) await this.cleanupHost(host, "open-failed");
              },
            ]),
          ).catch((cleanupError: unknown) => {
            if (host)
              this.reportHostCleanupFailure(host.identity.kind, "session-rollback", cleanupError);
          });
          this.updateState();
          throw this.startFailure(correlationId, stage, error);
        }
      } finally {
        this.pendingSessions.delete(claims.sessionId);
      }
    });
  }
  private async reattachAfterPool(
    session: ActiveSession,
    claims: BrowserAttachTicketClaims,
    sink: BrowserControllerSink,
    attachment: number,
  ): Promise<BrowserAttachment> {
    if (
      !claims.reattach ||
      claims.initialNavigation ||
      claims.actor !== session.claims.actor ||
      claims.creationOrigin !== session.claims.creationOrigin ||
      claims.subject !== session.claims.subject ||
      browserHostKey(claims) !== session.host.identity.key ||
      (claims.identity.kind === "profile-local" &&
        (session.host.identity.kind !== "local" ||
          !sameLocalBinding(claims.identity.binding, session.host.identity.binding)))
    )
      throw new BrowserRuntimeError("forbidden", "This ticket cannot adopt the retained session.");

    session.poolAttachment = attachment;
    const channelLostDeadline =
      session.channelLostUntil !== undefined ? session.channelLostDeadline : undefined;
    clearTimeout(session.channelLostUntil);
    delete session.channelLostUntil;
    if (!session.poolDetached) {
      session.poolDetached = true;
      await session.host.router.unregisterSession(session.sessionId, true);
      await session.controller.detachForPool().catch(() => undefined);
    }
    const router = session.host.router;
    let registered = false;
    let controller: BrowserController | undefined;
    try {
      const [root, ...others] = session.ledger.resumeAfterRelayRestart();
      if (!root) throw new BrowserRuntimeError("not_found", "The browser page closed.");
      router.registerSession(
        session.sessionId,
        root,
        session.ledger.resolveTarget.bind(session.ledger),
        session.files.root,
      );
      registered = true;
      for (const target of others) router.claimTarget(session.sessionId, target);
      controller = this.createController(session.host, claims, session.files, session.ledger, sink);
      await controller.start();
    } catch (error) {
      const started = controller;
      await settleCleanup([
        ...(started ? [() => started.detachForPool()] : []),
        ...(registered ? [() => router.unregisterSession(session.sessionId)] : []),
      ]);
      session.ledger.suspendForPool(() => this.poolDrops++);
      // A reattach after a lost channel that did not take leaves the session detached until the
      // same deadline, for the Home's next attempt; an adoption keeps it for its window.
      if (channelLostDeadline !== undefined)
        this.armChannelDeadline(session, session.generation, channelLostDeadline);
      throw error;
    }
    session.controller = controller;
    session.claims = claims;
    session.generation = ++this.generation;
    session.poolDetached = false;
    const generation = session.generation;
    return new BrowserAttachment(
      session.sessionId,
      controller,
      (confirmPages, restarting, channelLost) =>
        this.detach(session.sessionId, generation, confirmPages, restarting, false, channelLost),
      undefined,
      this.poolTrafficFor(session, generation),
    );
  }

  /** Ends a detached session whose lost channel did not come back by `at`. */
  private armChannelDeadline(session: ActiveSession, generation: number, at: number): void {
    clearTimeout(session.channelLostUntil);
    session.channelLostDeadline = at;
    session.channelLostUntil = setTimeout(
      () => {
        void this.detach(session.sessionId, generation, false, false, true).catch(() => undefined);
      },
      Math.max(0, at - Date.now()),
    );
    session.channelLostUntil.unref();
  }

  private createController(
    host: BrowserHost,
    claims: BrowserAttachTicketClaims,
    files: SessionFiles,
    ledger: SurfaceLedger,
    sink: BrowserControllerSink,
  ): BrowserController {
    const hostBrowser = host.browser;
    const stateImports = host.stateImports;
    const stateHost = host;
    return new BrowserController({
      sessionState: (state) => this.sleeper.setSessionState(claims.sessionId, state),
      loginAuthority: this.loginAuthority,
      nativePresentation: (surfaceId, consumerToken) => {
        const live = [...this.nativePresentations].filter(
          (presentation) =>
            presentation.sessionId === claims.sessionId && presentation.surfaceId === surfaceId,
        );
        return live.length === 1 && live[0]?.consumerToken === consumerToken;
      },
      passkeys: claims.passkeys === 1 ? host.passkeys : undefined,
      verifyOpenAuthority: this.pool
        ? async (ticket) => {
            const verified = await this.ticketVerifier.verify(ticket, {
              runtimeId: this.runtimeId,
            });
            this.requirePoolTraffic(verified);
            return verified;
          }
        : (ticket) => this.ticketVerifier.verify(ticket, { runtimeId: this.runtimeId }),
      cdpRouter: host.router,
      clipboard: hostBrowser.clipboard,
      claims,
      files,
      ledger,
      replaceSiteCookies: (site, cookies, deadline) => {
        if (!stateHost.acceptingSessions) {
          throw new BrowserRuntimeError("conflict", "The browser host is shutting down.", {
            retryable: true,
          });
        }
        const mutation = stateImports.run(() => {
          deadline.throwIfAborted();
          return hostBrowser.replaceSiteCookies(site, cookies, deadline);
        });
        stateHost.stateMutations.set(mutation, deadline);
        const finished = () => {
          stateHost.stateMutations.delete(mutation);
        };
        void mutation.then(finished, finished);
        return mutation;
      },
      signIns: host.signIns,
      sink,
    });
  }

  private async acquireHost(
    claims: BrowserAttachTicketClaims,
    hostKey: BrowserPartitionKey,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{
    host: BrowserHost | undefined;
    createdHost: boolean;
    acquisition: BrowserOpenTiming["acquisition"];
  }> {
    const wait = <T>(operation: Promise<T>) => waitForAcquisition(operation, signal);
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (
        this.shuttingDown ||
        (claims.identity.kind !== "fresh" &&
          this.deletedProfiles.has(hostKey.slice("profile:".length)))
      )
        throw new BrowserRuntimeError(
          "conflict",
          "This browser profile has been deleted or stopped.",
        );
    };
    assertCurrent();
    let host = this.hosts.get(hostKey);
    let createdHost = false;
    let stage = "profile-state";
    let acquisition: BrowserOpenTiming["acquisition"] =
      claims.identity.kind === "profile-local" ? "cold" : "guest";
    try {
      const passkeysEnabled = claims.passkeys === 1;
      if (host && !host.acceptingSessions && host.disposal) {
        await wait(host.disposal).catch(() => undefined);
        host = this.hosts.get(hostKey);
        if (host && !host.acceptingSessions)
          throw new BrowserRuntimeError(
            "conflict",
            "The browser session is finishing its shutdown.",
            { retryable: true },
          );
        assertCurrent();
      }
      if (host && host.passkeysEnabled !== passkeysEnabled) {
        if (!host.acceptingSessions || host.sessions.size > 0) {
          throw new BrowserRuntimeError(
            "conflict",
            "The browser profile is in use with a different passkey mode. Close its sessions and retry.",
            { retryable: true },
          );
        }
        stage = "profile-close";
        host.holdUntilClosed = true;
        await wait(this.cleanupHost(host, "profile-closed"));
        host = undefined;
        stage = "profile-state";
      }
      if (!host) {
        let localDirectory: string | undefined;
        if (claims.identity.kind === "profile-local") {
          const identity = claims.identity;
          localDirectory = await this.localStore!.provision(
            identity.binding,
            identity.initialized,
            (directory) =>
              this.launcher.localProfiles!.createFiles(directory, identity.binding, signal),
            signal,
          );
        }
        assertCurrent();
        stage = "context-launch";
        const passkeys =
          claims.passkeys === 1
            ? new HostRelayAuthenticator((targetId) => {
                for (const session of this.sessions.values()) {
                  if (session.host.identity.key !== hostKey || session.claims.passkeys !== 1)
                    continue;
                  const surfaceId = session.ledger.surfaceIdForTarget(targetId);
                  if (surfaceId)
                    return {
                      sessionId: session.sessionId,
                      surfaceId,
                      send: (message) => {
                        void session.controller
                          .sendPasskey(message)
                          .catch(() => passkeys?.disconnect(session.sessionId));
                      },
                    };
                }
                return undefined;
              })
            : undefined;
        if (localDirectory && claims.identity.kind === "profile-local")
          this.localStore!.engineOwnsDirectory(claims.identity.binding);
        const launching = this.launcher.launch(
          {
            ...(passkeys ? { authenticator: passkeys } : {}),
            initialViewport: this.initialViewport,
            remainingBudgetMs: Math.max(
              1,
              Math.min(
                claims.remainingBudgetMs,
                Date.parse(claims.operationExpiresAt) - Date.now(),
              ),
            ),
            partitionKey: hostKey,
            ...("sessionId" in claims ? { sessionId: claims.sessionId } : {}),
            storage:
              claims.identity.kind === "profile-local" && localDirectory
                ? { kind: "local", binding: claims.identity.binding, directory: localDirectory }
                : { kind: "guest" },
          },
          signal,
        );
        void launching.then(
          (browser) => {
            if (signal.aborted)
              void boundedCleanup(browser.close()).catch((error: unknown) =>
                this.reportHostCleanupFailure(
                  claims.identity.kind === "profile-local" ? "local" : "fresh",
                  "cancelled-launch",
                  error,
                ),
              );
          },
          () => undefined,
        );
        const browser = await wait(launching);
        this.pages.adopt(browser.context);
        assertCurrent();
        const generation = ++this.generation;
        const stateImports = new AsyncMutex();
        const router = new SessionCdpRouter(browser.cdp);
        const onBrowserClose = () => {
          // Signal controllers before waiting for this profile's lifecycle
          // lane: detach may already be waiting on dead Chromium CDP.
          for (const session of host?.sessions.values() ?? []) {
            endPresentations(session);
            session.controller.browserDisconnected();
          }
          void this.closeHost(hostKey, generation).catch((error: unknown) =>
            this.reportHostCleanupFailure(launchedHost.identity.kind, "browser-close", error),
          );
        };
        const launchedHost: BrowserHost = {
          passkeys,
          passkeysEnabled,
          holdUntilClosed: false,
          acceptingSessions: true,
          lastUsed: ++this.usage,
          browser,
          cleanup: null,
          disposal: null,
          generation,
          identity:
            claims.identity.kind === "profile-local"
              ? { key: hostKey, kind: "local", binding: claims.identity.binding }
              : { key: hostKey, kind: "fresh" },
          onBrowserClose,
          quiesced: false,
          router,
          sessions: new Map(),
          signIns: new HostSignIns({
            authority: this.loginAuthority,
            runtimeId: this.runtimeId,
          }),
          stateImports,
          helperCancellation: new AbortController(),
          stateMutations: new Map(),
        };
        host = launchedHost;
        browser.onClose(onBrowserClose);
        this.hosts.set(hostKey, host);
        createdHost = true;
        await wait(Promise.resolve(browser.profile?.ready()));
        assertCurrent();
      } else {
        if (claims.identity.kind === "profile-local") {
          await this.localStore!.requireReady(claims.identity.binding);
        }
        if (
          host.identity.kind === "local" &&
          (claims.identity.kind !== "profile-local" ||
            !sameLocalBinding(host.identity.binding, claims.identity.binding))
        )
          throw new BrowserRuntimeError("conflict", "The browser host binding does not match.");
        if (!host.acceptingSessions) {
          throw new BrowserRuntimeError(
            "conflict",
            "The browser session is finishing its shutdown.",
            { retryable: true },
          );
        }
        acquisition = "warm";
      }

      assertCurrent();
      return { host, createdHost, acquisition };
    } catch (error) {
      if (createdHost && host) {
        const { kind } = host.identity;
        await boundedCleanup(this.cleanupHost(host, "open-failed")).catch((error: unknown) =>
          this.reportHostCleanupFailure(kind, "acquire-rollback", error),
        );
      }
      this.updateState();
      throw this.startFailure("sessionId" in claims ? claims.sessionId : hostKey, stage, error);
    }
  }

  private reportHostCleanupFailure(kind: "fresh" | "local", stage: string, error: unknown): void {
    try {
      this.onHostCleanupFailure({ kind, stage, error });
    } catch {
      // Reporting cannot change browser ownership.
    }
  }

  private startFailure(correlationId: string, stage: string, error: unknown): BrowserRuntimeError {
    if (error instanceof BrowserRuntimeError && error.reason?.startsWith("session-start."))
      return error;
    try {
      this.onStartFailure({ correlationId, stage, error });
    } catch {
      /* Reporting cannot change session ownership or cleanup. */
    }
    const normalized = toBrowserRuntimeError(error);
    if (normalized.code !== "internal") return normalized;
    return new BrowserRuntimeError(
      normalized.code,
      `Browser Session ${correlationId} could not initialize (${stage}).`,
      { cause: error, retryable: false, reason: `session-start.${stage}` },
    );
  }

  shutdown(): Promise<void> {
    this.sleeper.close();
    this.pool?.close();
    if (this.shutdownResult) return this.shutdownResult;
    this.shuttingDown = true;
    for (const attempt of this.attempts) attempt.abort();
    for (const host of this.hosts.values()) {
      host.acceptingSessions = false;
      host.helperCancellation.abort();
      for (const session of host.sessions.values()) endPresentations(session);
    }
    this.state = "closing";
    const operation = (async () => {
      await this.lanes.drain();
      await this.preparation?.catch(() => undefined);
      const results = await Promise.allSettled(
        [...this.hosts.values()].map((host) => this.cleanupHost(host, "runtime-shutdown")),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      // Every page still held is asked again. Pages still unconfirmed are reported
      // and stay owned, but never fail the shutdown: the engine's own teardown and a
      // supervisor restart must still run after it.
      await this.pages.shutdown(pageShutdownMs);
      if (failures.length)
        throw new AggregateError(failures, "Browser resources could not be closed.");
      this.hosts.clear();
      this.sessions.clear();
      await this.localStore?.close();
      this.state = "closed";
    })();
    this.shutdownResult = withTimeout(operation, shutdownTimeoutMs, {
      timeoutError: () =>
        new BrowserRuntimeError("conflict", "Browser shutdown persistence did not finish.", {
          retryable: true,
          reason: "runtime-shutdown.queue-timeout",
        }),
    });
    void this.shutdownResult.catch(() => {
      this.shutdownResult = undefined;
    });
    return this.shutdownResult;
  }

  private detach(
    sessionId: string,
    generation: number,
    confirmPages: boolean,
    restarting = false,
    forcePoolDetach = false,
    channelLost = false,
  ): Promise<void> {
    const current = this.sessions.get(sessionId);
    if (current?.generation === generation) endPresentations(current);
    if (!current) return Promise.resolve();
    return this.lanes.run(current.host.identity.key, async () => {
      const active = this.sessions.get(sessionId);
      if (!active || active.generation !== generation) return;
      if (active.poolDetached && !forcePoolDetach) return;
      if (!forcePoolDetach && channelLost && this.pool?.acceptsTraffic) {
        // The Runner's channel went away, the guest did not: the pages keep running, detached,
        // until the Home reattaches the session or the reconnect deadline ends it. A command
        // already sent may never answer in a kept page, so its routing ends without waiting
        // for it: its outcome is unknown, and a late answer reaches no one.
        // The same command gives up its claim on the kept pages, so the Home's reattach can take
        // them at once; it is never sent again.
        active.poolDetached = true;
        active.ledger.suspendForPool(() => this.poolDrops++);
        await settleCleanup([
          () => active.controller.detachForPool(),
          () => active.host.router.unregisterSession(sessionId, false, true),
        ]);
        this.armChannelDeadline(active, generation, Date.now() + this.poolChannelDeadlineMs);
        return;
      }
      if (!forcePoolDetach && this.pool?.canAdopt(active.sessionId as BrowserSessionId)) {
        // A channel lost during adoption keeps the session for the next attempt or the window;
        // as above, its routing ends without waiting for a command a kept page may never answer.
        active.poolDetached = true;
        active.ledger.suspendForPool(() => this.poolDrops++);
        await settleCleanup([
          () => active.controller.detachForPool(),
          () => active.host.router.unregisterSession(sessionId, false, true),
        ]);
        return;
      }
      if (restarting && active.claims.actor === "person") {
        active.controller.browserDisconnected();
        const router = active.host.router.unregisterSession(sessionId, true);
        void router.catch(() => undefined);
        try {
          await withTimeout(
            settleCleanup([
              () => active.controller.close(),
              () => active.ledger.suspendForRelayRestart(),
              () => router,
            ]),
            sessionTeardownMs,
            { timeoutError: () => new Error("Browser session teardown did not finish.") },
          );
        } catch (error) {
          void this.detach(sessionId, generation, false).catch(() => undefined);
          throw error;
        }
        this.sleeper.resetSessionState(sessionId);
        active.reattachUntil = setTimeout(() => {
          void this.detach(sessionId, generation, false).catch(() => undefined);
        }, 20_000);
        active.reattachUntil.unref();
        return;
      }
      clearTimeout(active.reattachUntil);
      clearTimeout(active.channelLostUntil);
      this.sleeper.remove(sessionId);
      this.sessions.delete(sessionId);
      const host = active.host;
      host.sessions.delete(sessionId);
      host.signIns.sessionDetached(sessionId);
      const closeHost = host.sessions.size === 0;
      try {
        await settleCleanup([
          () =>
            withTimeout(
              settleCleanup(closeSession(active, "session-ended", confirmPages)),
              sessionTeardownMs,
              {
                timeoutError: () => new Error("Browser session teardown did not finish."),
              },
            ),
          () => active.files.dispose(),
          ...((closeHost && (host.identity.kind === "fresh" || this.launcher.hostCost === "process")
            ? [() => this.cleanupHost(host)]
            : []) satisfies (() => Promise<void>)[]),
        ]);
      } finally {
        if (closeHost) host.lastUsed = ++this.usage;
        this.updateState();
      }
    });
  }
  private closeHost(key: BrowserPartitionKey, generation: number): Promise<void> {
    return this.lanes.run(key, async () => {
      const host = this.hosts.get(key);
      if (!host || host.generation !== generation) return;
      await this.cleanupHost(host);
      this.updateState();
    });
  }
  private retireHost(key: string): Promise<void> {
    const host = [...this.hosts.values()].find((host) => host.identity.key === key);
    if (!host || this.launcher.hostCost !== "process") return Promise.resolve();
    return this.lanes.run(host.identity.key, async () => {
      if (this.hosts.get(host.identity.key) !== host || !this.sleeper.canRetireHost(key)) return;
      host.acceptingSessions = false;
      await Promise.all(
        [...host.sessions.values()].map((session) => session.controller.close("retired")),
      );
      await this.cleanupHost(host, "host-retired");
      this.updateState();
    });
  }
  private cleanupHost(host: BrowserHost, reason: PageEndReason = "session-ended"): Promise<void> {
    if (this.hosts.get(host.identity.key) !== host) return Promise.resolve();
    if (host.cleanup) return host.cleanup.result;
    const result = (async () => {
      host.acceptingSessions = false;
      host.passkeys?.close();
      host.signIns.close();
      host.helperCancellation.abort();
      const quiesced = boundedCleanup(this.quiesceHost(host, reason), "session teardown");
      const importsDrained = boundedCleanup(
        host.stateImports.run(async () => {}),
        "cookie import drain",
      );
      if (!host.disposal) {
        host.disposal = this.disposeHost(host);
        void host.disposal.catch((error: unknown) =>
          this.reportHostCleanupFailure(host.identity.kind, "engine-close", error),
        );
      }
      const settled = await Promise.allSettled([
        quiesced,
        importsDrained,
        boundedCleanup(host.disposal, `${host.identity.kind} browser process teardown`),
      ]);
      const failures = settled.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length)
        throw new AggregateError(
          failures,
          `Browser cleanup did not complete cleanly: ${failures.map((error) => (error instanceof Error ? error.message : String(error))).join("; ")}`,
        );
    })();
    host.cleanup = { result };
    const release = () => {
      if (host.cleanup?.result === result) host.cleanup = null;
    };
    void result.then(release, release);
    return result;
  }
  private async disposeHost(host: BrowserHost): Promise<void> {
    const closed = () => {
      if (this.hosts.get(host.identity.key) === host) this.hosts.delete(host.identity.key);
    };
    const onClose = () => {
      if (host.identity.kind !== "local" && !host.holdUntilClosed) closed();
    };
    host.browser.onClose(onClose);
    host.browser.offClose(host.onBrowserClose);
    try {
      await settleCleanup([() => host.router.close(), () => host.browser.close()]);
    } finally {
      closed();
      host.browser.offClose(onClose);
      // The context is done; the registry lets it go once its last page is confirmed gone.
      this.pages.release(host.browser.context);
    }
  }

  private async quiesceHost(host: BrowserHost, reason: PageEndReason): Promise<void> {
    if (host.quiesced) return;
    const sessions = [...host.sessions.values()];
    for (const session of sessions) endPresentations(session);
    await settleCleanup(
      sessions.flatMap((session) => [
        ...closeSession(session, reason),
        () => session.files.dispose(),
      ]),
    );
    for (const session of sessions) {
      this.sleeper.remove(session.sessionId);
      this.sessions.delete(session.sessionId);
    }
    host.sessions.clear();
    host.quiesced = true;
  }

  private updateState(): void {
    if (this.shuttingDown) {
      this.state = this.hosts.size ? "closing" : "closed";
      return;
    }
    this.state = this.sessions.size ? "ready" : "idle";
  }
}

/**
 * Ends a session's browser work. Its CDP routing ends first, so an agent
 * command still queued reaches no page and cannot open one the session would
 * never close. A pending one, such as a script awaiting the person's click,
 * fails at the latest when its page closes; no step waits on it.
 */
function endPresentations(session: ActiveSession): void {
  for (const close of session.presentations) close();
}

function closeSession(
  session: ActiveSession,
  reason: PageEndReason,
  confirmPages = false,
): Array<() => Promise<void>> {
  let routing: Promise<void> | undefined;
  return [
    async () => {
      routing = session.host.router.unregisterSession(session.sessionId, confirmPages);
      void routing.catch(() => undefined);
    },
    () => session.controller.close(),
    () => session.ledger.closeOwnedPages(reason, confirmPages),
    () => session.ledger.close(),
    async () => {
      await routing;
    },
  ];
}

function waitForAcquisition<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return withTimeout(operation, acquisitionTimeoutMs, {
    signal,
    timeoutError: () =>
      new BrowserRuntimeError("conflict", "Browser acquisition timed out.", {
        retryable: true,
        reason: "browser-open.timeout",
      }),
  });
}
function boundedCleanup<T>(operation: Promise<T>, stage = "resource cleanup"): Promise<T> {
  return withTimeout(operation, cleanupTimeoutMs, {
    timeoutError: () => new Error(`Browser ${stage} did not finish.`),
  });
}
