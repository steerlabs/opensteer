import { withTimeout } from "@opensteer/shared/withTimeout";
import { delay } from "@opensteer/shared/delay";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  browserFrameFits,
  defaultBrowserViewport,
  SessionCdpRouter,
} from "@opensteer/browser-core";
import {
  EmptyBrowserProfileSnapshot,
  type BrowserProfileSnapshot,
  type BrowserOriginCaptureFailure,
} from "@opensteer/browser-profile/snapshot";
import {
  browserStateImportRuntimeTimeoutMs,
  type BrowserAttachTicketClaims,
  type BrowserSessionId,
  type BrowserSurfaceId,
} from "@opensteer/protocol";
import { AsyncMutex, settleCleanup } from "./async.js";
import type {
  BrowserLauncher,
  BrowserPartitionKey,
  LaunchedBrowser,
  Viewport,
} from "./browser/backend.js";
import { BrowserController, type BrowserControllerSink } from "./browser/controller.js";
import type {
  NativePresentationSource,
  PresentedSurface,
  PresentedSurfaceEvent,
} from "./browser/presentation.js";
import { HostSignIns } from "./browser/host-sign-ins.js";
import type { BrowserLoginAuthority } from "./browser/sign-in.js";
import { SessionFiles } from "./browser/session-files.js";
import { SurfaceLedger } from "./browser/surface-ledger.js";
import { BrowserRuntimeError, toBrowserRuntimeError } from "./errors.js";
import type { AttachTicketVerifier } from "./security/attach-ticket.js";
import {
  isProfileAttachTicketClaims,
  type BrowserProfileAttachTicketClaims,
  type BrowserProfileStateClient,
} from "./profile-state-client.js";

export type BrowserRuntimeState = "closed" | "closing" | "idle" | "ready" | "starting";

const profileSnapshotTimeoutMs = 15_000;
// Includes the existing 20 s import drain and one bounded save request.
const profileCloseTimeoutMs = browserStateImportRuntimeTimeoutMs + profileSnapshotTimeoutMs;
type CheckpointStage =
  "quiesce" | "imports" | "checkpoint-lock" | "snapshot" | "host-commit" | "browser-close";

export interface BrowserCheckpointFailure {
  readonly runtimeId: string;
  readonly profileId: string;
  readonly sessionId: string;
  readonly phase: "periodic" | "final";
  readonly stage: CheckpointStage;
  readonly elapsedMs: number;
  readonly error: BrowserRuntimeError;
}

interface BrowserRuntimeOptions {
  /** How often an in-use profile's changed state is saved; a clean close always saves. */
  checkpointIntervalMs?: number;
  checkpointRetryMs?: number;
  idleProfileHostTimeoutMs?: number;
  initialViewport?: Viewport;
  launcher: BrowserLauncher;
  maxProfileHosts?: number;
  maxSessionsPerProfile?: number;
  profileStateClient: BrowserProfileStateClient;
  runtimeId: string;
  /** Emptied on first use; each live session stages page-bound files beneath it. */
  sessionFilesRoot: string;
  /**
   * Authorizes and fills saved logins on the computer this runtime shares
   * with Opensteer Passwords. Absent on every runtime that cannot.
   */
  loginAuthority?: BrowserLoginAuthority;
  ticketVerifier: AttachTicketVerifier;
  onCheckpointFailure?: (diagnostic: BrowserCheckpointFailure) => void;
  onStartFailure?: (diagnostic: {
    readonly correlationId: string;
    readonly stage: string;
    readonly error: unknown;
  }) => void;
}

export interface BrowserRuntimeHealth {
  checkpointFailures: number;
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
}

/**
 * A host's identity, fixed when it launches. Durable profile state — the lease
 * claims and the revision a checkpoint builds on — exists only on the profile
 * arm, so a fresh host has nothing to commit and no way to name a profile.
 */
interface ProfileHostIdentity {
  readonly key: BrowserPartitionKey;
  readonly kind: "profile";
  /** Digest of the state the current revision holds, so unchanged state is not saved again. */
  profileDigest: string;
  profileRevision: number;
  profileStateClaims: BrowserProfileAttachTicketClaims;
}

interface FreshHostIdentity {
  readonly key: BrowserPartitionKey;
  readonly kind: "fresh";
}

type BrowserHostIdentity = FreshHostIdentity | ProfileHostIdentity;

interface BrowserHost {
  acceptingSessions: boolean;
  browser: LaunchedBrowser;
  /** Serializes every profile commit, periodic or final, against one revision chain. */
  readonly checkpoints: AsyncMutex;
  checkpointTimer: NodeJS.Timeout | null;
  cleanup: { readonly result: Promise<void> } | null;
  snapshotExport: Promise<BrowserProfileSnapshot> | null;
  finalSnapshotSaved: boolean;
  closeTimer: NodeJS.Timeout | null;
  generation: number;
  identity: BrowserHostIdentity;
  onBrowserClose: () => void;
  quiesced: boolean;
  router: SessionCdpRouter;
  sessions: Map<string, ActiveSession>;
  readonly signIns: HostSignIns;
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
  return claims.identity.kind === "profile"
    ? `profile:${claims.identity.profileId}`
    : `session:${claims.sessionId}`;
}

export class BrowserAttachment {
  private closePromise: Promise<void> | null = null;
  private readonly controller: BrowserController;
  private readonly detach: () => Promise<void>;
  readonly sessionId: string;

  constructor(sessionId: string, controller: BrowserController, detach: () => Promise<void>) {
    this.sessionId = sessionId;
    this.controller = controller;
    this.detach = detach;
  }

  handle(frame: string | Buffer): Promise<void> {
    return this.controller.handleRaw(frame);
  }

  close(): Promise<void> {
    this.closePromise ??= this.detach();
    return this.closePromise;
  }
}

/**
 * Supervises many Browser Hosts. One host owns one physical browser context —
 * a saved profile shared by its sessions, or one fresh session's throwaway
 * state. Each attach creates an isolated Browser Session inside its host.
 */
export class BrowserRuntime implements NativePresentationSource {
  private checkpointFailures = 0;
  private readonly checkpointIntervalMs: number;
  private readonly checkpointRetryMs: number;
  private generation = 0;
  private readonly idleProfileHostTimeoutMs: number;
  private readonly initialViewport: Viewport;
  private readonly launcher: BrowserLauncher;
  private readonly maxProfileHosts: number;
  private readonly maxSessionsPerProfile: number;
  private readonly mutex = new AsyncMutex();
  private readonly hosts = new Map<BrowserPartitionKey, BrowserHost>();
  private readonly profileStateClient: BrowserProfileStateClient;
  private readonly runtimeId: string;
  private readonly sessionFilesRoot: string;
  private preparation: Promise<void> | undefined;
  private readonly onStartFailure: NonNullable<BrowserRuntimeOptions["onStartFailure"]>;
  private readonly onCheckpointFailure: NonNullable<BrowserRuntimeOptions["onCheckpointFailure"]>;
  private readonly sessions = new Map<string, ActiveSession>();
  private shuttingDown = false;
  private readonly loginAuthority: BrowserLoginAuthority | undefined;
  private state: BrowserRuntimeState = "idle";
  private readonly ticketVerifier: AttachTicketVerifier;

  constructor(options: BrowserRuntimeOptions) {
    this.checkpointIntervalMs = options.checkpointIntervalMs ?? 120_000;
    this.checkpointRetryMs = options.checkpointRetryMs ?? 30_000;
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
    this.idleProfileHostTimeoutMs = options.idleProfileHostTimeoutMs ?? 0;
    this.launcher = options.launcher;
    this.maxProfileHosts = options.maxProfileHosts ?? 8;
    this.maxSessionsPerProfile = options.maxSessionsPerProfile ?? 32;
    this.profileStateClient = options.profileStateClient;
    this.runtimeId = options.runtimeId;
    if (
      !path.isAbsolute(options.sessionFilesRoot) ||
      path.resolve(options.sessionFilesRoot) !== options.sessionFilesRoot
    ) {
      throw new TypeError("sessionFilesRoot must be an absolute normalized path.");
    }
    this.sessionFilesRoot = options.sessionFilesRoot;
    this.loginAuthority = options.loginAuthority;
    this.onCheckpointFailure =
      options.onCheckpointFailure ??
      ((diagnostic) => {
        console.error("browser.profile.checkpoint.failed", diagnostic);
      });
    this.ticketVerifier = options.ticketVerifier;
    this.onStartFailure =
      options.onStartFailure ??
      ((diagnostic) => {
        console.error(
          "browser.session.start.failed",
          diagnostic.correlationId,
          diagnostic.stage,
          diagnostic.error,
        );
      });
    for (const [name, value, maximum] of [
      ["checkpointIntervalMs", this.checkpointIntervalMs, 3_600_000],
      ["idleProfileHostTimeoutMs", this.idleProfileHostTimeoutMs, 600_000],
      ["checkpointRetryMs", this.checkpointRetryMs, 600_000],
      ["maxProfileHosts", this.maxProfileHosts, 64],
      ["maxSessionsPerProfile", this.maxSessionsPerProfile, 128],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
        throw new TypeError(`${name} is outside its supported range.`);
      }
    }
    if (this.checkpointRetryMs < 1_000 || this.checkpointIntervalMs < 1_000) {
      throw new TypeError("Checkpoint intervals must be at least one second.");
    }
    if (this.maxProfileHosts < 1 || this.maxSessionsPerProfile < 1) {
      throw new TypeError("Browser Runtime capacities must be positive.");
    }
  }

  health(): BrowserRuntimeHealth {
    return {
      checkpointFailures: this.checkpointFailures,
      profileHostCount: this.hosts.size,
      runtimeId: this.runtimeId,
      sessionCount: this.sessions.size,
      state: this.state,
    };
  }

  prepare(): Promise<void> {
    if (this.shuttingDown || this.state === "closed")
      return Promise.reject(new Error("The Browser Runtime is shutting down."));
    this.preparation ??= (async () => {
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
      await this.launcher.prepare?.();
    })();
    return this.preparation;
  }

  hasSession(sessionId: BrowserSessionId): boolean {
    return !this.shuttingDown && this.sessions.has(sessionId);
  }

  presentSurface(
    sessionId: BrowserSessionId,
    surfaceId: BrowserSurfaceId,
  ): PresentedSurface | null {
    const session = this.sessions.get(sessionId);
    const binding = session?.ledger.binding(surfaceId);
    if (this.shuttingDown || !session || !binding || binding.page.isClosed()) return null;
    const listeners = new Set<(event: PresentedSurfaceEvent) => void>();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
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

  attach(ticket: string, sink: BrowserControllerSink): Promise<BrowserAttachment> {
    return this.mutex.run(async () => {
      if (this.shuttingDown || this.state === "closed") {
        throw new BrowserRuntimeError("conflict", "The Browser Runtime is shutting down.");
      }
      const claims = await this.ticketVerifier.verify(ticket, { runtimeId: this.runtimeId });
      if (this.sessions.has(claims.sessionId)) {
        throw new BrowserRuntimeError("conflict", "The Browser Session is already attached.");
      }
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(claims.sessionId)) {
        throw new BrowserRuntimeError("bad_message", "The Browser Session ID is invalid.");
      }
      try {
        await this.prepare();
      } catch (error) {
        throw this.startFailure(claims.sessionId, "runtime-preparation", error);
      }
      const files = new SessionFiles(path.join(this.sessionFilesRoot, claims.sessionId));
      this.state = "starting";

      const hostKey = browserHostKey(claims);
      let host = this.hosts.get(hostKey);
      let createdHost = false;
      let ledger: SurfaceLedger | null = null;
      let controller: BrowserController | null = null;
      let rootPage = null as Awaited<ReturnType<LaunchedBrowser["context"]["createPage"]>> | null;
      const sessionGeneration = ++this.generation;
      let stage = "profile-state";
      try {
        if (!host) {
          if (this.hosts.size >= this.maxProfileHosts) {
            throw new BrowserRuntimeError("conflict", "Browser Runtime host capacity is full.");
          }
          // A fresh identity has no durable state to restore: it starts empty
          // and never touches the profile-state endpoint.
          const profileClaims = isProfileAttachTicketClaims(claims) ? claims : null;
          const profileState = profileClaims
            ? await this.profileStateClient.load(profileClaims)
            : null;
          stage = "context-launch";
          const browser = await this.launcher.launch({
            initialViewport: this.initialViewport,
            partitionKey: hostKey,
            sessionId: claims.sessionId,
            snapshot: profileState?.snapshot ?? EmptyBrowserProfileSnapshot,
          });
          rootPage = browser.context.pages()[0] ?? null;
          if (!rootPage) throw new BrowserRuntimeError("internal", "Browser has no root page.");
          const generation = ++this.generation;
          const stateImports = new AsyncMutex();
          const router = new SessionCdpRouter(
            browser.cdp,
            {
              maxSessions: this.maxSessionsPerProfile,
            },
            browser.clipboard?.machineClipboardShared !== false,
          );
          const onBrowserClose = () => {
            // Signal controllers before waiting for the Runtime mutex: a
            // detach already holding it may be waiting on dead Chromium CDP.
            for (const session of host?.sessions.values() ?? []) {
              endPresentations(session);
              session.controller.browserDisconnected();
            }
            void this.closeHost(hostKey, generation, false).catch(() => undefined);
          };
          host = {
            acceptingSessions: true,
            browser,
            checkpoints: new AsyncMutex(),
            checkpointTimer: null,
            cleanup: null,
            snapshotExport: null,
            finalSnapshotSaved: false,
            closeTimer: null,
            generation,
            identity:
              profileClaims && profileState
                ? {
                    key: hostKey,
                    kind: "profile",
                    profileDigest: snapshotDigest(profileState.snapshot),
                    profileRevision: profileState.revision,
                    profileStateClaims: profileClaims,
                  }
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
            stateMutations: new Map(),
          };
          browser.onClose(onBrowserClose);
          this.hosts.set(hostKey, host);
          createdHost = true;
          if (host.identity.kind === "profile") this.scheduleCheckpoint(host);
        } else {
          if (!host.acceptingSessions) {
            throw new BrowserRuntimeError(
              "conflict",
              host.identity.kind === "profile"
                ? "The browser profile is finishing its durable checkpoint."
                : "The browser session is finishing its shutdown.",
              { retryable: true },
            );
          }
          if (host.sessions.size >= this.maxSessionsPerProfile) {
            throw new BrowserRuntimeError("conflict", "Browser Host session capacity is full.");
          }
          if (host.closeTimer) {
            clearTimeout(host.closeTimer);
            host.closeTimer = null;
          }
          stage = "page-create";
          rootPage = await host.browser.context.createPage();
          if (host.identity.kind === "profile" && isProfileAttachTicketClaims(claims)) {
            host.identity.profileStateClaims = claims;
          }
        }

        stage = "session-initialize";
        const sessionRouter = host.router;
        ledger = new SurfaceLedger(host.browser.context, {
          navigationVersion: claims.navigationVersion,
          beforeResize: async (surfaceId) => controller?.prepareResize(surfaceId),
          // Every page the session holds, a tab the person opened included, is
          // one its agents can list and attach to.
          claimTarget: (targetId) => sessionRouter.claimTarget(claims.sessionId, targetId),
          // A person who started the browser from a view gets its first page
          // at that view's size, before anything loads there.
          initialViewport: claims.viewport
            ? { devicePixelRatio: 1, ...claims.viewport }
            : this.initialViewport,
          rootPages: [rootPage],
          ...(claims.workspaceTabRestoreVersion === 1 && claims.dormantSurfaceIds
            ? { dormantSurfaceIds: claims.dormantSurfaceIds }
            : {}),
          ...(claims.workspaceTabRestoreVersion === 1 && claims.initialSurfaceId
            ? { initialSurfaceId: claims.initialSurfaceId }
            : {}),
        });
        sessionRouter.registerSession(
          claims.sessionId,
          await rootPage.targetId(),
          ledger.resolveTarget.bind(ledger),
          files.root,
        );
        await ledger.start();
        const hostBrowser = host.browser;
        const stateImports = host.stateImports;
        const stateHost = host;
        controller = new BrowserController({
          cdpRouter: host.router,
          clipboard: hostBrowser.clipboard,
          claims,
          exportSnapshot: () => stateImports.run(() => hostBrowser.exportSnapshot()),
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
        const active: ActiveSession = {
          claims,
          controller,
          files,
          generation: sessionGeneration,
          host,
          ledger,
          sessionId: claims.sessionId,
          presentations: new Set(),
        };
        host.sessions.set(claims.sessionId, active);
        this.sessions.set(claims.sessionId, active);
        stage = "session-snapshot";
        await controller.start();
        this.state = "ready";
        return new BrowserAttachment(claims.sessionId, controller, () =>
          this.detach(claims.sessionId, sessionGeneration),
        );
      } catch (error) {
        if (host) {
          host.sessions.delete(claims.sessionId);
          await host.router.unregisterSession(claims.sessionId).catch(() => undefined);
        }
        this.sessions.delete(claims.sessionId);
        await settleCleanup([
          async () => controller?.close(),
          async () => ledger?.closeOwnedPages(),
          async () => ledger?.close(),
          () => files.dispose(),
          async () => {
            if (createdHost && host) await this.cleanupHost(host, false);
            else if (rootPage) await rootPage.close();
          },
        ]).catch(() => undefined);
        this.updateState();
        throw this.startFailure(claims.sessionId, stage, error);
      }
    });
  }

  private startFailure(correlationId: string, stage: string, error: unknown): BrowserRuntimeError {
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
    this.shuttingDown = true;
    for (const session of this.sessions.values()) endPresentations(session);
    const entered = Promise.withResolvers<void>();
    const controller = new AbortController();
    const operation = this.mutex.run(async () => {
      entered.resolve();
      controller.signal.throwIfAborted();
      if (this.state === "closed") return;
      await withTimeout(
        this.preparation?.catch(() => undefined) ?? Promise.resolve(),
        profileSnapshotTimeoutMs,
        {
          timeoutError: () =>
            new BrowserRuntimeError(
              "conflict",
              "Browser Runtime preparation is still pending; shutdown did not complete.",
              { retryable: true, reason: "runtime-shutdown.preparation-timeout" },
            ),
        },
      );
      this.state = "closing";
      const hosts = [...this.hosts.values()];
      const results = await Promise.allSettled(hosts.map((host) => this.cleanupHost(host, true)));
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length) {
        throw new AggregateError(failures, "Browser profiles could not be checkpointed.");
      }
      this.hosts.clear();
      this.sessions.clear();
      this.state = "closed";
    });
    // A timed-out queued stop must never run later without its caller.
    void operation.catch(() => undefined);
    return withTimeout(entered.promise, profileSnapshotTimeoutMs, {
      timeoutError: () =>
        new BrowserRuntimeError(
          "conflict",
          "The Browser Runtime is still finishing an admitted operation; shutdown did not complete.",
          { retryable: true, reason: "runtime-shutdown.queue-timeout" },
        ),
    })
      .then(() => operation)
      .catch((error: unknown) => {
        controller.abort(error);
        if (!(error instanceof AggregateError))
          console.error("browser.runtime.shutdown.failed", { runtimeId: this.runtimeId, error });
        throw error;
      });
  }

  private detach(sessionId: string, generation: number): Promise<void> {
    const current = this.sessions.get(sessionId);
    if (current?.generation === generation) endPresentations(current);
    return this.mutex.run(async () => {
      const active = this.sessions.get(sessionId);
      if (!active || active.generation !== generation) return;
      this.sessions.delete(sessionId);
      const host = active.host;
      host.sessions.delete(sessionId);
      host.signIns.sessionDetached(sessionId);
      const closeHost = host.sessions.size === 0;
      const identity = host.identity;
      if (identity.kind === "profile") {
        if (closeHost) {
          if (isProfileAttachTicketClaims(active.claims)) {
            identity.profileStateClaims = active.claims;
          }
        } else if (identity.profileStateClaims.sessionId === active.claims.sessionId) {
          const remaining = [...host.sessions.values()].at(-1);
          if (remaining && isProfileAttachTicketClaims(remaining.claims)) {
            identity.profileStateClaims = remaining.claims;
          }
        }
      }
      try {
        await settleCleanup([
          ...closeSession(active),
          () => active.files.dispose(),
          ...((closeHost && this.idleProfileHostTimeoutMs === 0
            ? [() => this.checkpointAndCloseHost(host)]
            : []) satisfies (() => Promise<void>)[]),
        ]);
      } finally {
        if (closeHost && this.idleProfileHostTimeoutMs > 0) this.scheduleHostClose(host);
        this.updateState();
      }
    });
  }

  /**
   * A profile in use saves its changed state on an interval, so a crash or a
   * forced quit loses at most one interval instead of everything since it
   * opened. Failures leave the live browser untouched and try again next time.
   */
  private scheduleCheckpoint(host: BrowserHost): void {
    host.checkpointTimer = setTimeout(() => {
      let retryable = true;
      void this.checkpointInUse(host)
        .catch((error: unknown) => {
          retryable = !(error instanceof BrowserRuntimeError) || error.retryable;
        })
        .finally(() => {
          if (this.hosts.get(host.identity.key)?.generation === host.generation) {
            if (host.acceptingSessions && retryable) this.scheduleCheckpoint(host);
          }
        });
    }, this.checkpointIntervalMs);
    host.checkpointTimer.unref();
  }

  private checkpointInUse(host: BrowserHost): Promise<void> {
    const identity = host.identity;
    if (identity.kind !== "profile") return Promise.resolve();
    const started = performance.now();
    let stage: CheckpointStage = "checkpoint-lock";
    return host.checkpoints
      .run(async () => {
        if (!host.acceptingSessions || host.sessions.size === 0) return;
        // Cookie imports rewrite one site's cookies in several steps; a save
        // between them would capture half a sign-in.
        stage = "snapshot";
        const { snapshot, failures } = await this.exportCheckpointSnapshot(host);
        const digest = snapshotDigest(snapshot);
        if (!host.acceptingSessions) return;
        if (digest === identity.profileDigest) {
          this.reportOriginFailures(host, "periodic", started, failures);
          return;
        }
        stage = "host-commit";
        identity.profileRevision = await this.profileStateClient.commit(
          identity.profileStateClaims,
          identity.profileRevision,
          snapshot,
        );
        identity.profileDigest = digest;
        this.reportOriginFailures(host, "periodic", started, failures);
      })
      .catch((error: unknown) => {
        throw this.checkpointFailure(host, "periodic", stage, started, error);
      });
  }

  private scheduleHostClose(host: BrowserHost, delayMs = this.idleProfileHostTimeoutMs): void {
    if (host.closeTimer) clearTimeout(host.closeTimer);
    host.closeTimer = setTimeout(() => {
      void this.closeHost(host.identity.key, host.generation, true).catch((error: unknown) => {
        const current = this.hosts.get(host.identity.key);
        if (
          !this.shuttingDown &&
          (!(error instanceof BrowserRuntimeError) || error.retryable) &&
          current?.generation === host.generation &&
          current.sessions.size === 0
        ) {
          this.scheduleHostClose(current, this.checkpointRetryMs);
        }
      });
    }, delayMs);
    host.closeTimer.unref();
  }

  private async checkpointAndCloseHost(host: BrowserHost): Promise<void> {
    try {
      await this.cleanupHost(host, true);
    } catch (error) {
      const current = this.hosts.get(host.identity.key);
      if (
        !this.shuttingDown &&
        (!(error instanceof BrowserRuntimeError) || error.retryable) &&
        current?.generation === host.generation &&
        current.sessions.size === 0
      ) {
        this.scheduleHostClose(current, this.checkpointRetryMs);
      }
      throw error;
    }
  }

  private closeHost(
    key: BrowserPartitionKey,
    generation: number,
    checkpoint: boolean,
  ): Promise<void> {
    return this.mutex.run(async () => {
      const host = this.hosts.get(key);
      if (!host || host.generation !== generation) return;
      await this.cleanupHost(host, checkpoint);
      this.updateState();
    });
  }

  private cleanupHost(host: BrowserHost, checkpoint: boolean): Promise<void> {
    if (this.hosts.get(host.identity.key)?.generation !== host.generation) return Promise.resolve();
    // An expired attempt can still own a native operation. Do not overlap it
    // or silently restart its deadline when another caller asks to stop.
    if (host.cleanup) return host.cleanup.result;
    const controller = new AbortController();
    const started = performance.now();
    let stage: CheckpointStage = "quiesce";
    const operation = this.cleanupHostOnce(host, checkpoint, controller.signal, (next) => {
      stage = next;
    });
    const result = withTimeout(operation, profileCloseTimeoutMs, {
      timeoutError: () =>
        new BrowserRuntimeError(
          "conflict",
          `Browser profile close timed out during ${stage}; shutdown did not complete.`,
          {
            retryable: true,
            reason: `profile-checkpoint.${stage}-timeout`,
          },
        ),
    }).catch((error: unknown) => {
      controller.abort(error);
      throw checkpoint && host.identity.kind === "profile"
        ? this.checkpointFailure(host, "final", stage, started, error)
        : error;
    });
    const pending = { result };
    host.cleanup = pending;
    const release = () => {
      if (host.cleanup === pending) host.cleanup = null;
    };
    void operation.then(release, release);
    return result;
  }

  private async cleanupHostOnce(
    host: BrowserHost,
    checkpoint: boolean,
    signal: AbortSignal,
    stage: (next: CheckpointStage) => void,
  ): Promise<void> {
    const identity = host.identity;
    const started = performance.now();
    if (this.hosts.get(identity.key)?.generation !== host.generation) return;
    host.acceptingSessions = false;
    host.signIns.close();
    if (host.checkpointTimer) clearTimeout(host.checkpointTimer);
    host.checkpointTimer = null;
    if (host.closeTimer) clearTimeout(host.closeTimer);
    host.closeTimer = null;
    await this.quiesceHost(host);
    signal.throwIfAborted();
    // A fresh host has no durable state: closing it is always checkpoint-free.
    // The final commit is unconditional: it also ends the profile's lease grace.
    if (checkpoint && identity.kind === "profile" && !host.finalSnapshotSaved) {
      // A periodic checkpoint may already hold checkpoints while waiting for
      // an import, so its lock cannot guard this deadline-aware drain.
      if (host.stateMutations.size > 0) {
        stage("imports");
        try {
          await withTimeout(
            Promise.allSettled(host.stateMutations.keys()),
            browserStateImportRuntimeTimeoutMs,
            {
              signal: AbortSignal.any([signal, ...host.stateMutations.values()]),
              timeoutError: () => new Error("Sign-in import drain timed out."),
            },
          );
        } catch (cause) {
          throw new BrowserRuntimeError(
            "conflict",
            "Could not save this browser profile because a sign-in import is still pending. Unsaved state remains in memory, and " +
              (this.shuttingDown
                ? "shutdown did not complete."
                : "Opensteer will retry saving it automatically."),
            { cause, retryable: true, reason: "profile-checkpoint.import-pending" },
          );
        }
      }
      stage("checkpoint-lock");
      await host.checkpoints.run(async () => {
        signal.throwIfAborted();
        stage("snapshot");
        const { snapshot, failures } = await this.exportCheckpointSnapshot(host, signal);
        signal.throwIfAborted();
        stage("host-commit");
        identity.profileRevision = await this.profileStateClient.commit(
          identity.profileStateClaims,
          identity.profileRevision,
          snapshot,
        );
        identity.profileDigest = snapshotDigest(snapshot);
        // A successful final commit retires this lease. A later close failure
        // must retry disposal without attempting another commit on that lease.
        host.finalSnapshotSaved = true;
        this.reportOriginFailures(host, "final", started, failures);
      });
    }
    signal.throwIfAborted();
    stage("browser-close");
    if (host.closeTimer) clearTimeout(host.closeTimer);
    const closed = () => {
      if (this.hosts.get(identity.key)?.generation === host.generation)
        this.hosts.delete(identity.key);
    };
    host.browser.onClose(closed);
    host.browser.offClose(host.onBrowserClose);
    try {
      await settleCleanup([() => host.router.close(), () => host.browser.close()]);
      closed();
    } finally {
      host.browser.offClose(closed);
    }
  }

  private async exportCheckpointSnapshot(
    host: BrowserHost,
    signal?: AbortSignal,
  ): Promise<{ snapshot: BrowserProfileSnapshot; failures: BrowserOriginCaptureFailure[] }> {
    if (host.snapshotExport)
      throw new BrowserRuntimeError(
        "conflict",
        "A previous browser profile snapshot is still pending; unsaved state remains in memory.",
        {
          retryable: true,
          reason: "profile-checkpoint.snapshot-pending",
        },
      );
    const controller = new AbortController();
    const deadline = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const failures: BrowserOriginCaptureFailure[] = [];
    const operation = host.stateImports.run(async () => {
      deadline.throwIfAborted();
      return host.browser.exportSnapshot((failure) => failures.push(failure));
    });
    host.snapshotExport = operation;
    const release = () => {
      if (host.snapshotExport === operation) host.snapshotExport = null;
    };
    void operation.then(release, release);
    try {
      const snapshot = await withTimeout(operation, profileSnapshotTimeoutMs, {
        signal: deadline,
        timeoutError: () =>
          new BrowserRuntimeError(
            "conflict",
            "Browser profile snapshot timed out; unsaved state remains in memory.",
            {
              retryable: true,
              reason: "profile-checkpoint.snapshot-timeout",
            },
          ),
      });
      return { snapshot, failures };
    } catch (error) {
      // Native snapshot export has no cancellation API. It keeps the state
      // lock until it settles; its late result cannot initiate a commit.
      controller.abort(error);
      throw error;
    }
  }

  private reportOriginFailures(
    host: BrowserHost,
    phase: BrowserCheckpointFailure["phase"],
    started: number,
    failures: readonly BrowserOriginCaptureFailure[],
  ): void {
    if (failures.length === 0) return;
    this.checkpointFailure(
      host,
      phase,
      "snapshot",
      started,
      new BrowserRuntimeError(
        "internal",
        `Browser profile saved incompletely: ${failures.length} site(s) could not be captured. Other sites and cookies were saved; the last captured state was retained where available. ${JSON.stringify(failures)}`,
        { retryable: true, reason: "profile-checkpoint.origins-incomplete" },
      ),
    );
  }

  private checkpointFailure(
    host: BrowserHost,
    phase: BrowserCheckpointFailure["phase"],
    stage: CheckpointStage,
    started: number,
    cause: unknown,
  ): BrowserRuntimeError {
    const error =
      cause instanceof BrowserRuntimeError
        ? cause
        : new BrowserRuntimeError(
            "internal",
            `Browser profile checkpoint failed during ${stage}.`,
            {
              cause,
              retryable: true,
              reason: `profile-checkpoint.${stage}-failed`,
            },
          );
    this.checkpointFailures += 1;
    const identity = host.identity;
    if (identity.kind === "profile") {
      try {
        this.onCheckpointFailure({
          runtimeId: this.runtimeId,
          profileId: identity.profileStateClaims.identity.profileId,
          sessionId: identity.profileStateClaims.sessionId,
          phase,
          stage,
          elapsedMs: performance.now() - started,
          error,
        });
      } catch {
        /* Reporting cannot change checkpoint ownership. */
      }
    }
    return error;
  }

  private async quiesceHost(host: BrowserHost): Promise<void> {
    if (host.quiesced) return;
    const sessions = [...host.sessions.values()];
    for (const session of sessions) endPresentations(session);
    const checkpointSession = sessions.at(-1);
    if (
      host.identity.kind === "profile" &&
      checkpointSession &&
      isProfileAttachTicketClaims(checkpointSession.claims)
    ) {
      host.identity.profileStateClaims = checkpointSession.claims;
    }
    await settleCleanup(
      sessions.flatMap((session) => [...closeSession(session), () => session.files.dispose()]),
    );
    for (const session of sessions) this.sessions.delete(session.sessionId);
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

function closeSession(session: ActiveSession): Array<() => Promise<void>> {
  return [
    () => session.host.router.unregisterSession(session.sessionId),
    () => session.controller.close(),
    () => session.ledger.closeOwnedPages(),
    () => session.ledger.close(),
  ];
}

/**
 * Browsers list cookies and origins in no promised order, so the digest reads
 * them sorted: the same state never looks changed.
 */
function snapshotDigest(snapshot: BrowserProfileSnapshot): string {
  const cookies = snapshot.cookies
    .map((cookie) => JSON.stringify(cookie))
    .sort((left, right) => left.localeCompare(right));
  const origins = snapshot.origins
    .map((origin) => JSON.stringify(origin))
    .sort((left, right) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify({ cookies, origins })).digest("hex");
}
