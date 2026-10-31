import { randomUUID } from "node:crypto";
import { LocalProfileStore, sameLocalBinding } from "./local-profile-store.js";
import {
  HttpProfileInitializationClient,
  type ProfileInitializationClient,
} from "./profile-initialization-client.js";
import { HostRelayAuthenticator } from "./passkeys/host-relay.js";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { delay } from "@opensteer/shared/delay";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  browserFrameFits,
  defaultBrowserViewport,
  SessionCdpRouter,
} from "@opensteer/browser-core";
import {
  type BrowserAttachTicketClaims,
  type BrowserPreparationTicketClaims,
  type BrowserSessionId,
  type BrowserSurfaceId,
  type InitialPageReady,
  type LocalProfileBinding,
  type HeldLocalProfile,
  type BrowserEngine,
} from "@opensteer/protocol";
import { AsyncMutex, LifecycleLanes, settleCleanup } from "./async.js";
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
import { SessionFiles, sessionFilesRoot } from "./browser/session-files.js";
import { SurfaceLedger } from "./browser/surface-ledger.js";
import { BrowserRuntimeError, toBrowserRuntimeError } from "./errors.js";
import type { AttachTicketVerifier } from "./security/attach-ticket.js";
import {
  isProfileAttachTicketClaims,
  type BrowserProfileStateClient,
} from "./legacy-snapshot-adapter.js";
import { LegacySnapshotAdapter, type BrowserCheckpointFailure } from "./legacy-snapshot-adapter.js";
export type { BrowserCheckpointFailure } from "./legacy-snapshot-adapter.js";

export type BrowserRuntimeState = "closed" | "closing" | "idle" | "ready" | "starting";

const shutdownAdmissionTimeoutMs = 15_000;
export interface BrowserRuntimeOptions {
  /** How often an in-use profile's changed state is saved; a clean close always saves. */
  checkpointIntervalMs?: number;
  checkpointRetryMs?: number;
  idleProfileHostTimeoutMs?: number;
  initialViewport?: Viewport;
  launcher: BrowserLauncher;
  maxProfileHosts?: number;
  maxSessionsPerProfile?: number;
  profileStateClient: BrowserProfileStateClient;
  /**
   * The caller must own this root exclusively for the process lifetime (desktop
   * application lock or standalone OS lock). Only one live runtime may use it.
   */
  localProfiles?: { readonly root: string };
  initializationClient?: ProfileInitializationClient;
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
  onOpenTiming?: (diagnostic: BrowserOpenTiming) => void;
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
  readonly acquisition?: "warm" | "cold" | "conversion" | "legacy" | "guest";
}

export interface BrowserRuntimeHealth {
  initialNavigationVersion: 1;
  localProfiles?: 1;
  profilePrepare?: 1;
  profilePrepareInstanceId?: string;
  localProfileStorage?: { storageInstanceId: string; engine: BrowserEngine };
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

interface ProfileHostIdentity {
  readonly key: BrowserPartitionKey;
  readonly kind: "profile";
  readonly snapshot: LegacySnapshotAdapter;
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
type BrowserHostIdentity = FreshHostIdentity | ProfileHostIdentity | NativeHostIdentity;

export interface BrowserHost {
  acceptingSessions: boolean;
  lastUsed: number;
  passkeys: HostRelayAuthenticator | undefined;
  readonly passkeysEnabled: boolean;
  holdUntilClosed: boolean;
  browser: LaunchedBrowser;
  cleanup: { readonly result: Promise<void> } | null;
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
    : `profile:${claims.identity.kind === "profile" ? claims.identity.profileId : claims.identity.binding.profileId}`;
}

export class BrowserAttachment {
  readonly initialPage?: InitialPageReady;
  private closePromise: Promise<void> | null = null;
  private readonly controller: BrowserController;
  private readonly detach: () => Promise<void>;
  readonly sessionId: string;

  constructor(
    sessionId: string,
    controller: BrowserController,
    detach: () => Promise<void>,
    initialPage?: InitialPageReady,
  ) {
    if (initialPage) this.initialPage = initialPage;
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
  private readonly lanes = new LifecycleLanes<BrowserPartitionKey>();
  private readonly profilePrepareInstanceId = randomUUID();
  private readonly preparationAttempts = new Set<string>();
  private reservations = 0;
  private speculative:
    | {
        controller: AbortController;
        profileId: string;
        host: BrowserHost | undefined;
        consumed: boolean;
      }
    | undefined;
  private readonly pendingSessions = new Set<string>();
  private usage = 0;
  private readonly onOpenTiming: NonNullable<BrowserRuntimeOptions["onOpenTiming"]>;
  private readonly localProfilesOptions: BrowserRuntimeOptions["localProfiles"];
  private localStore: LocalProfileStore | undefined;
  private readonly initializationClient: ProfileInitializationClient;
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
    this.onOpenTiming = options.onOpenTiming ?? (() => {});
    this.localProfilesOptions = options.localProfiles;
    this.initializationClient =
      options.initializationClient ?? new HttpProfileInitializationClient();
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
      initialNavigationVersion: 1,
      ...(this.localProfileStorage
        ? {
            localProfiles: 1,
            localProfileStorage: this.localProfileStorage,
            ...(this.launcher.localProfiles?.preparation
              ? {
                  profilePrepare: 1 as const,
                  profilePrepareInstanceId: this.profilePrepareInstanceId,
                }
              : {}),
          }
        : {}),
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
      if (this.localProfilesOptions && this.launcher.localProfiles) {
        this.localStore = await LocalProfileStore.acquire(
          this.localProfilesOptions.root,
          this.launcher.localProfiles.engine,
        );
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
      passkeyInput: (consumerToken) => {
        if (!released && session.claims.passkeys === 1)
          session.host.passkeys?.record(
            binding.targetId,
            consumerToken ? { person: consumerToken } : "unknown",
          );
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
    if (this.shuttingDown)
      return Promise.reject(
        new BrowserRuntimeError("conflict", "The Browser Runtime is shutting down."),
      );
    // Fence immediately, before waiting for already admitted conversion/page work.
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
    if (this.speculative?.profileId === binding.profileId) this.speculative?.controller.abort();
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
        await this.cleanupHost(host, false);
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

  async attach(
    ticket: string,
    sink: BrowserControllerSink,
    options: {
      passkeys?: boolean;
      localProfiles?: boolean;
      initialNavigation?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<BrowserAttachment> {
    const started = performance.now();
    const correlationId = randomUUID();
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
    const verified = await this.ticketVerifier.verify(ticket, { runtimeId: this.runtimeId });
    const claims = options.passkeys ? verified : { ...verified, passkeys: undefined };
    const hostKey = browserHostKey(claims);
    const queued = performance.now();
    return this.lanes.run(hostKey, async () => {
      timing("lane-wait", queued);
      options.signal?.throwIfAborted();
      if (this.shuttingDown || this.state === "closed") {
        throw new BrowserRuntimeError("conflict", "The Browser Runtime is shutting down.");
      }
      if (
        (claims.identity.kind === "profile-local" && !options.localProfiles) ||
        (claims.initialNavigationVersion === 1 && !options.initialNavigation)
      )
        throw new BrowserRuntimeError(
          "conflict",
          "Browser attachment features were not negotiated.",
        );
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(claims.sessionId))
        throw new BrowserRuntimeError("bad_message", "The Browser Session ID is invalid.");
      const operationKey = claims.initialNavigation
        ? `${claims.subject}:${claims.initialNavigation.operationKey}`
        : undefined;
      const fingerprint = JSON.stringify({
        sessionId: claims.sessionId,
        identity:
          claims.identity.kind === "profile-local"
            ? claims.identity.binding
            : claims.identity.kind === "profile"
              ? claims.identity.profileId
              : "fresh",
        navigation: claims.initialNavigation,
      });
      if (
        claims.identity.kind !== "fresh" &&
        this.deletedProfiles.has(hostKey.slice("profile:".length))
      )
        throw new BrowserRuntimeError("conflict", "This browser profile has been deleted.");
      const previous = operationKey ? this.initialOperations.get(operationKey) : undefined;
      if (previous) {
        const active = this.sessions.get(previous.sessionId);
        if (previous.fingerprint !== fingerprint || !active || !previous.result)
          throw new BrowserRuntimeError(
            "conflict",
            "The initial browser operation already has an outcome; it cannot start another browser.",
          );
        await active.controller.reattach(sink);
        active.generation = ++this.generation;
        const generation = active.generation;
        return new BrowserAttachment(
          active.sessionId,
          active.controller,
          () => this.detach(active.sessionId, generation),
          previous.result,
        );
      }
      if (this.sessions.has(claims.sessionId) || this.pendingSessions.has(claims.sessionId))
        throw new BrowserRuntimeError("conflict", "The Browser Session is already attached.");
      this.pendingSessions.add(claims.sessionId);
      if (operationKey)
        this.initialOperations.set(operationKey, { fingerprint, sessionId: claims.sessionId });
      try {
        try {
          await this.prepare();
        } catch (error) {
          throw this.startFailure(claims.sessionId, "runtime-preparation", error);
        }
        if (claims.identity.kind === "profile-local" && !this.localStore)
          throw new BrowserRuntimeError(
            "conflict",
            "Native browser profile storage is unavailable.",
          );
        if (
          claims.identity.kind === "profile" &&
          (await this.localStore?.hasProfile(claims.identity.profileId))
        )
          throw new BrowserRuntimeError(
            "conflict",
            "Update this Host to open this native browser profile.",
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
          const acquired = await this.acquireHost(claims, hostKey, false, options.signal);
          if (!acquired.host) throw new Error("Browser acquisition returned no host.");
          host = acquired.host;
          createdHost = acquired.createdHost || this.speculative?.host === host;
          options.signal?.throwIfAborted();
          const acquisition = acquired.acquisition;
          if (this.speculative?.host === host) this.speculative.consumed = true;
          timing("profile-acquire", acquiring, acquisition);
          pageStarting = performance.now();
          stage = "profile-admission";
          await host.browser.profile?.admit(options.signal);
          if (
            options.signal?.aborted ||
            this.shuttingDown ||
            (claims.identity.kind !== "fresh" &&
              this.deletedProfiles.has(hostKey.slice("profile:".length)))
          )
            throw new BrowserRuntimeError(
              "conflict",
              "This browser profile has been deleted or stopped.",
            );
          stage = "page-create";
          rootPage =
            host.browser.context.pages()[0] && createdHost
              ? host.browser.context.pages()[0]!
              : await host.browser.context.createPage();

          options.signal?.throwIfAborted();
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
            passkeys: claims.passkeys === 1 ? host.passkeys : undefined,
            cdpRouter: host.router,
            clipboard: hostBrowser.clipboard,
            claims,
            exportSnapshot: () => {
              if (stateHost.identity.kind === "local")
                throw new BrowserRuntimeError(
                  "conflict",
                  "Native browser profile snapshot export is unavailable.",
                );
              return stateImports.run(() => hostBrowser.exportSnapshot());
            },
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
          timing("root-page-ready", pageStarting);
          let initialPage: InitialPageReady | undefined;
          if (claims.initialNavigationVersion === 1 && claims.initialNavigation) {
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
            () => this.detach(claims.sessionId, sessionGeneration),
            initialPage,
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
      } finally {
        this.pendingSessions.delete(claims.sessionId);
      }
    });
  }

  private async acquireHost(
    claims: BrowserAttachTicketClaims | BrowserPreparationTicketClaims,
    hostKey: BrowserPartitionKey,
    preparation = false,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{
    host: BrowserHost | undefined;
    createdHost: boolean;
    acquisition: BrowserOpenTiming["acquisition"];
  }> {
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
    let reserved = false;
    let stage = "profile-state";
    let acquisition: BrowserOpenTiming["acquisition"] =
      claims.identity.kind === "profile-local"
        ? "cold"
        : claims.identity.kind === "profile"
          ? "legacy"
          : "guest";
    try {
      const passkeysEnabled = claims.passkeys === 1;
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
        await this.checkpointAndCloseHost(host);
        host = undefined;
        stage = "profile-state";
      }
      if (!host) {
        if (preparation && this.hosts.size + this.reservations >= this.maxProfileHosts)
          throw new BrowserRuntimeError("conflict", "Browser Runtime host capacity is full.");
        await this.reserveCapacity();
        reserved = true;
        // A fresh identity has no durable state to restore: it starts empty
        // and never touches the profile-state endpoint.
        const profileClaims =
          "sessionId" in claims && isProfileAttachTicketClaims(claims) ? claims : null;
        const profileState = profileClaims
          ? await LegacySnapshotAdapter.load(this.profileStateClient, profileClaims)
          : null;
        let localDirectory: string | undefined;
        if (claims.identity.kind === "profile-local") {
          const identity = claims.identity;
          const store = this.localStore!;
          const marker = await store.inspect(identity.binding, identity.initialization?.seed);
          if (identity.initialization) {
            if (marker?.phase === "ready")
              localDirectory = await store.requireReady(identity.binding);
            if (marker?.phase !== "ready") {
              acquisition = "conversion";
              stage = "profile-initialization";
              localDirectory = await store.initialize(
                identity.binding,
                identity.initialization.seed,
              );
              const snapshot = await this.initializationClient.load(identity, signal);
              assertCurrent();
              store.engineOwnsDirectory(identity.binding);
              await this.launcher.localProfiles!.importAndFlush({
                directory: localDirectory,
                binding: identity.binding,
                snapshot,
                signal,
              });
              signal.throwIfAborted();
              await store.ready(identity.binding, identity.initialization.seed);
            }
            signal.throwIfAborted();
            await this.initializationClient.complete(identity, signal);
          }
          localDirectory = await store.requireReady(identity.binding);
        }
        assertCurrent();
        if (preparation && this.launcher.localProfiles?.preparation === "conversion") {
          this.reservations--;
          reserved = false;
          return { host: undefined, createdHost: false, acquisition };
        }
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
        const browser = await this.launcher.launch(
          {
            ...(passkeys ? { authenticator: passkeys } : {}),
            initialViewport: this.initialViewport,
            partitionKey: hostKey,
            ...("sessionId" in claims ? { sessionId: claims.sessionId } : {}),
            ...(preparation ? { preparation: true } : {}),
            storage:
              claims.identity.kind === "profile-local" && localDirectory
                ? { kind: "local", binding: claims.identity.binding, directory: localDirectory }
                : profileState
                  ? { kind: "legacy", snapshot: profileState.snapshot }
                  : { kind: "guest" },
          },
          signal,
        );
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
          // Signal controllers before waiting for this profile's lifecycle
          // lane: detach may already be waiting on dead Chromium CDP.
          for (const session of host?.sessions.values() ?? []) {
            endPresentations(session);
            session.controller.browserDisconnected();
          }
          void this.closeHost(hostKey, generation, false).catch(() => undefined);
        };
        const launchedHost: BrowserHost = {
          passkeys,
          passkeysEnabled,
          holdUntilClosed: false,
          acceptingSessions: true,
          lastUsed: ++this.usage,
          browser,
          cleanup: null,
          generation,
          identity:
            profileClaims && profileState
              ? {
                  key: hostKey,
                  kind: "profile",
                  snapshot: new LegacySnapshotAdapter(profileClaims, profileState, {
                    checkpointIntervalMs: this.checkpointIntervalMs,
                    checkpointRetryMs: this.checkpointRetryMs,
                    idleProfileHostTimeoutMs: this.idleProfileHostTimeoutMs,
                    runtimeId: this.runtimeId,
                    profileStateClient: this.profileStateClient,
                    shuttingDown: () => this.shuttingDown,
                    current: () => this.hosts.get(hostKey) === launchedHost,
                    closeHost: () => this.closeHost(hostKey, generation, true),
                    quiesceHost: () => this.quiesceHost(launchedHost),
                    disposeHost: () => this.disposeHost(launchedHost),
                    onCheckpointFailure: (diagnostic) => {
                      this.checkpointFailures++;
                      this.onCheckpointFailure(diagnostic);
                    },
                  }),
                }
              : claims.identity.kind === "profile-local"
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
        this.reservations--;
        reserved = false;
        createdHost = true;
        await browser.profile?.ready();
        assertCurrent();
        if (host.identity.kind === "profile") host.identity.snapshot.scheduleCheckpoint(host);
      } else {
        if (claims.identity.kind === "profile-local") {
          await this.localStore!.inspect(
            claims.identity.binding,
            claims.identity.initialization?.seed,
          );
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
            host.identity.kind === "profile"
              ? "The browser profile is finishing its durable checkpoint."
              : "The browser session is finishing its shutdown.",
            { retryable: true },
          );
        }
        if (host.sessions.size >= this.maxSessionsPerProfile) {
          throw new BrowserRuntimeError("conflict", "Browser Host session capacity is full.");
        }
        if (host.identity.kind === "profile") host.identity.snapshot.cancelClose();
        acquisition = "warm";
        if (
          host.identity.kind === "profile" &&
          "sessionId" in claims &&
          isProfileAttachTicketClaims(claims)
        ) {
          host.identity.snapshot.profileStateClaims = claims;
        }
      }

      assertCurrent();
      return { host, createdHost, acquisition };
    } catch (error) {
      if (reserved) this.reservations--;
      if (createdHost && host) await this.cleanupHost(host, false).catch(() => undefined);
      this.updateState();
      throw this.startFailure("sessionId" in claims ? claims.sessionId : hostKey, stage, error);
    }
  }

  async prepareProfile(
    ticket: string,
    options: {
      localProfiles?: boolean;
      profilePrepare?: boolean;
      passkeys?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<{ retained: boolean; closed: Promise<void>; close(): Promise<void> }> {
    if (
      !options.localProfiles ||
      !options.profilePrepare ||
      !this.launcher.localProfiles?.preparation ||
      !this.ticketVerifier.verifyPreparation
    )
      throw new BrowserRuntimeError("conflict", "Profile preparation was not negotiated.");
    const verified = await this.ticketVerifier.verifyPreparation(ticket, {
      runtimeId: this.runtimeId,
    });
    const claims = options.passkeys ? verified : { ...verified, passkeys: undefined };
    options.signal?.throwIfAborted();
    const profileId = claims.identity.binding.profileId;
    if (this.preparationAttempts.has(profileId))
      return { retained: false, closed: Promise.resolve(), close: async () => {} };
    this.preparationAttempts.add(profileId);
    if (this.speculative)
      return { retained: false, closed: Promise.resolve(), close: async () => {} };
    const ended = Promise.withResolvers<void>();
    const operation = {
      controller: new AbortController(),
      profileId: claims.identity.binding.profileId,
      consumed: false,
      host: undefined as BrowserHost | undefined,
    };
    this.speculative = operation;
    const hostKey = `profile:${claims.identity.binding.profileId}` as const;
    const cancel = () => {
      if (!operation.consumed) operation.controller.abort();
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    const close = async () => {
      cancel();
      options.signal?.removeEventListener("abort", cancel);
      ended.resolve();
      await this.lanes.run(hostKey, async () => {
        const host = operation.host;
        if (
          !operation.consumed &&
          host &&
          this.hosts.get(hostKey) === host &&
          host.sessions.size === 0
        )
          await this.cleanupHost(host, false);
        if (this.speculative === operation) this.speculative = undefined;
      });
    };
    try {
      await this.lanes.run(hostKey, async () => {
        operation.controller.signal.throwIfAborted();
        await this.prepare();
        if (this.deletedProfiles.has(claims.identity.binding.profileId))
          throw new BrowserRuntimeError("conflict", "This browser profile has been deleted.");
        // Speculation never displaces a useful host, including one with another engine policy.
        if (this.hosts.has(hostKey) || this.hosts.size + this.reservations >= this.maxProfileHosts)
          return;
        const acquired = await this.acquireHost(claims, hostKey, true, operation.controller.signal);
        if (!acquired.host) return;
        operation.host = acquired.host;
        acquired.host.browser.onClose(() => {
          ended.resolve();
          if (this.speculative === operation && !operation.consumed) this.speculative = undefined;
        });
        if (acquired.host.browser.context.pages().length)
          throw new BrowserRuntimeError(
            "conflict",
            "Prepared profiles must not create user pages.",
          );
      });
      if (!operation.host) await close();
      return { retained: operation.host !== undefined, closed: ended.promise, close };
    } catch (error) {
      await close();
      throw error;
    }
  }

  private async reserveCapacity(): Promise<void> {
    // Synchronous counters/selection are the entire capacity reservation. No I/O
    // holds this critical section, including an evicted host's process exit.
    if (this.hosts.size + this.reservations < this.maxProfileHosts) {
      this.reservations++;
      return;
    }
    const victim = [...this.hosts.values()]
      .filter(
        (host) =>
          host.acceptingSessions && host.sessions.size === 0 && !this.lanes.busy(host.identity.key),
      )
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!victim)
      throw new BrowserRuntimeError("conflict", "Browser Runtime host capacity is full.");
    victim.acceptingSessions = false;
    await this.closeHost(victim.identity.key, victim.generation, true);
    return this.reserveCapacity();
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
    this.shuttingDown = true;
    this.speculative?.controller.abort();
    for (const session of this.sessions.values()) endPresentations(session);
    const entered = Promise.withResolvers<void>();
    const controller = new AbortController();
    const operation = (async () => {
      await this.lanes.drain();
      entered.resolve();
      controller.signal.throwIfAborted();
      if (this.state === "closed") return;
      await withTimeout(
        this.preparation?.catch(() => undefined) ?? Promise.resolve(),
        shutdownAdmissionTimeoutMs,
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
      await this.localStore?.close();
      this.state = "closed";
    })();
    // A timed-out queued stop must never run later without its caller.
    void operation.catch(() => undefined);
    return withTimeout(entered.promise, shutdownAdmissionTimeoutMs, {
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
    if (!current) return Promise.resolve();
    return this.lanes.run(current.host.identity.key, async () => {
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
            identity.snapshot.profileStateClaims = active.claims;
          }
        } else if (identity.snapshot.profileStateClaims.sessionId === active.claims.sessionId) {
          const remaining = [...host.sessions.values()].at(-1);
          if (remaining && isProfileAttachTicketClaims(remaining.claims)) {
            identity.snapshot.profileStateClaims = remaining.claims;
          }
        }
      }
      try {
        await settleCleanup([
          ...closeSession(active),
          () => active.files.dispose(),
          ...((closeHost &&
          (host.identity.kind === "fresh" ||
            (host.identity.kind === "profile" && this.idleProfileHostTimeoutMs === 0))
            ? [() => this.checkpointAndCloseHost(host)]
            : []) satisfies (() => Promise<void>)[]),
        ]);
      } finally {
        if (closeHost) host.lastUsed = ++this.usage;
        if (closeHost && host.identity.kind === "profile" && this.idleProfileHostTimeoutMs > 0)
          host.identity.snapshot.scheduleHostClose(host);
        this.updateState();
      }
    });
  }

  private checkpointAndCloseHost(host: BrowserHost): Promise<void> {
    return host.identity.kind === "profile"
      ? host.identity.snapshot.checkpointAndCloseHost(host)
      : this.cleanupHost(host, false);
  }
  private closeHost(
    key: BrowserPartitionKey,
    generation: number,
    checkpoint: boolean,
  ): Promise<void> {
    return this.lanes.run(key, async () => {
      const host = this.hosts.get(key);
      if (!host || host.generation !== generation) return;
      await this.cleanupHost(host, checkpoint);
      this.updateState();
    });
  }
  private cleanupHost(host: BrowserHost, checkpoint: boolean): Promise<void> {
    if (this.hosts.get(host.identity.key) !== host) return Promise.resolve();
    if (host.identity.kind === "profile")
      return host.identity.snapshot.cleanupHost(host, checkpoint);
    if (host.cleanup) return host.cleanup.result;
    const result = (async () => {
      host.acceptingSessions = false;
      host.passkeys?.close();
      host.signIns.close();
      await this.quiesceHost(host);
      await host.stateImports.run(async () => {});
      await this.disposeHost(host);
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
      closed();
    } finally {
      host.browser.offClose(onClose);
    }
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
      host.identity.snapshot.profileStateClaims = checkpointSession.claims;
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
