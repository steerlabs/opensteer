import type { DesktopDownloads } from "../downloads/desktop-downloads.js";
import { z } from "zod";
import { createBrowserSessionId } from "@opensteer/protocol/browser";
import { browserCookieFromCdp, browserCookieToCdp } from "@opensteer/browser-profile/cookies";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import {
  app,
  BaseWindow,
  session as electronSession,
  WebContentsView,
  screen,
  type BrowserWindowConstructorOptions,
  type Debugger,
  type Session,
  type WebContents,
  type WebPreferences,
} from "electron";
import {
  BrowserOriginStateSchema,
  BrowserProfileSnapshotSchema,
  captureBrowserProfileSnapshot,
  EmptyBrowserProfileSnapshot,
  type BrowserOriginCaptureFailure,
  browserStorageOperation,
  type BrowserCookie,
  type BrowserOriginState,
  type BrowserProfileSnapshot,
} from "@opensteer/browser-profile";
import {
  defaultBrowserViewport,
  agentCdpAllowlist,
  ExecutionContextInventory,
  type BrowserCdpBackend,
  type CdpChannel,
  type CdpParameters,
} from "@opensteer/browser-core";
import {
  browserPageDisabledBlinkFeatures,
  browserPagePolicyScriptFor,
} from "@opensteer/browser-runtime-core/page-policy";
import {
  siteCookieReplacementBatch,
  type BrowserContext,
  type BrowserLaunchRequest,
  type BrowserLauncher,
  type BrowserPage,
  type BrowserPartitionKey,
  type CdpSession,
  type EngineClipboard,
  type LaunchedBrowser,
  type LocalProfileEngine,
  type PageGeometry,
  type PageCapture,
  type Viewport,
  pageViewport,
  type HumanInputObservation,
} from "@opensteer/browser-runtime-core";
import {
  applyBrowserSessionPolicy,
  updateBrowserPasskeyPolicy,
  type BrowserSessionRequestGate,
} from "./browser-session-policy.js";
import {
  acquireElectronLocalProfile,
  prepareElectronLocalProfiles,
  releaseElectronLocalProfile,
  type ElectronLocalProfile,
} from "./electron-local-profile.js";
import { desktopBrowserAppShortcut } from "../app/application-menu.js";

import {
  PasskeyBridge,
  createPasskeyProviderConfig,
} from "@opensteer/browser-runtime-core/passkey-bridge";
import type { BrowserPagePolicyConfig } from "@opensteer/browser-runtime-core/page-policy";
import type { PasskeyAuthenticator } from "@opensteer/browser-runtime-core/passkeys";

const storageWorldId = 10_991;
/**
 * Parallel helper loads for restoring and saving profile storage. Each site
 * load starts a renderer; past three at once they contend for CPU and a cold
 * start gets slower, not faster (measured in the GUI test VM).
 */
const storageViewConcurrency = 3;
const blankDocument = Buffer.from("<!doctype html><meta charset=utf-8>", "utf8").toString("base64");

export interface ElectronLocalProfileOpenTiming {
  readonly stage:
    | "session-created"
    | "mirror-restored"
    | "admitted"
    | "page-create-started"
    | "web-contents-view-created"
    | "resting-host-created"
    | "page-policy-dispatched"
    | "page-policy-ready"
    | "renderer-ready"
    | "page-announced"
    | "first-page-created";
  /** Cumulative time from local launch; preparation and the real open share this clock. */
  readonly elapsedMs: number;
}

type PageOpenTiming = (stage: ElectronLocalProfileOpenTiming["stage"]) => void;

interface ElectronBrowserLauncherOptions {
  readonly onLocalProfileOpenTiming?: (timing: ElectronLocalProfileOpenTiming) => void;
  readonly authenticator?: PasskeyAuthenticator;
  readonly clipboard?: EngineClipboard;
  readonly downloads: Pick<DesktopDownloads, "accept">;
  readonly maxWebContents?: number;
  readonly localProfileRoot?: string;
  /** Absolute path of the bundled `browser-page-preload.cjs`. */
  readonly pagePolicyPreloadPath: string;
}

/**
 * Names the Electron session partition for a launch. The partition key already
 * namespaces profile identities apart from fresh ones
 * (`profile:<profileId>` vs `session:<sessionId>`), so hashing it whole keeps a
 * fresh partition from ever colliding with a profile partition.
 */
export function electronBrowserPartition(partitionKey: BrowserPartitionKey): string {
  return `opensteer-browser-${createHash("sha256").update(partitionKey).digest("hex").slice(0, 32)}`;
}

/** Electron-native BrowserEngine used only by the connected desktop composition root. */
export class ElectronBrowserLauncher implements BrowserLauncher {
  readonly #authenticator: PasskeyAuthenticator | undefined;
  readonly #clipboard: EngineClipboard | undefined;
  readonly #downloads: Pick<DesktopDownloads, "accept">;
  readonly #configuredSessions = new WeakSet<Session>();
  readonly #pagePolicyPreloadPath: string;
  readonly #views: ElectronBrowserViewPool;
  readonly #localProfileRoot: string | undefined;
  readonly #onLocalProfileOpenTiming: ElectronBrowserLauncherOptions["onLocalProfileOpenTiming"];
  readonly localProfiles: LocalProfileEngine = {
    engine: "electron",
    preparation: 1,
    release: releaseElectronLocalProfile,
    importAndFlush: async (input) => {
      input.signal.throwIfAborted();
      const profile = acquireElectronLocalProfile({
        ...input,
        root: this.#localProfileRoot,
        configure: (session, gate) => this.#configureSession(session, false, gate),
        initialize: async (owner) => {
          const context = this.#context(
            owner.session,
            { devicePixelRatio: 1, ...defaultBrowserViewport },
            undefined,
            undefined,
            owner.gate,
          );
          const untrack = owner.trackContext(() => context.close());
          try {
            await owner.mirror.initialize(
              async () => {
                input.signal.throwIfAborted();
                await context.importSnapshot(input.snapshot);
                input.signal.throwIfAborted();
                await context.verifyImportedCookies(input.snapshot);
                await owner.session.cookies.flushStore();
              },
              async () => {
                if (
                  [
                    ...new Map(
                      input.snapshot.origins.map((origin) => [origin.origin, origin]),
                    ).values(),
                  ].some((origin) => origin.localStorage.length > 0)
                ) {
                  owner.session.flushStorageData();
                  // An unloaded origin replies only after the earlier Flush commits on
                  // the same LocalStorageControl pipe (Electron 44.9.2 / Chromium 152.0.7977.167).
                  await owner.session.clearStorageData({
                    origin: `https://${randomUUID()}.invalid`,
                    storages: ["localstorage"],
                  });
                }
              },
            );
            input.signal.throwIfAborted();
          } finally {
            await context.close();
            untrack();
          }
        },
      });
      const cancel = () => {
        void profile.retire().catch(() => undefined);
      };
      input.signal.addEventListener("abort", cancel, { once: true });
      if (input.signal.aborted) cancel();
      try {
        await profile.ready();
        input.signal.throwIfAborted();
      } finally {
        input.signal.removeEventListener("abort", cancel);
      }
    },
  };
  #preparation: Promise<void> | undefined;

  constructor(options: ElectronBrowserLauncherOptions) {
    if (!path.isAbsolute(options.pagePolicyPreloadPath)) {
      throw new TypeError("The browser page policy preload path must be absolute.");
    }
    this.#localProfileRoot = options.localProfileRoot;
    this.#onLocalProfileOpenTiming = options.onLocalProfileOpenTiming;
    this.#authenticator = options.authenticator;
    this.#pagePolicyPreloadPath = options.pagePolicyPreloadPath;
    this.#clipboard = options.clipboard;
    this.#downloads = options.downloads;
    this.#views = new ElectronBrowserViewPool(options.maxWebContents ?? 64);
  }

  prepare(): Promise<void> {
    this.#preparation ??= (async () => {
      await app.whenReady();
      await prepareElectronLocalProfiles();
      const sessionId = createBrowserSessionId();
      const browser = await this.launch({
        initialViewport: { devicePixelRatio: 1, ...defaultBrowserViewport },
        partitionKey: `session:${sessionId}`,
        sessionId,
        storage: { kind: "guest" },
      });
      try {
        const page = browser.context.pages()[0]!;
        const channel = await page.cdp();
        try {
          await channel.send("Runtime.enable");
        } finally {
          await channel.detach();
        }
      } finally {
        await browser.close();
      }
    })();
    return this.#preparation;
  }

  /** Cancels native work when the owning shutdown deadline expires. */
  close(): void {
    this.#views.close();
  }

  async launch(request: BrowserLaunchRequest, signal?: AbortSignal): Promise<LaunchedBrowser> {
    signal?.throwIfAborted();
    if (request.storage.kind === "local") {
      const started = performance.now();
      const timing: PageOpenTiming = (stage) =>
        this.#onLocalProfileOpenTiming?.({ stage, elapsedMs: performance.now() - started });
      const profile = acquireElectronLocalProfile({
        ...request.storage,
        root: this.#localProfileRoot,
        configure: (session, gate) =>
          this.#configureSession(
            session,
            request.authenticator !== undefined || this.#authenticator !== undefined,
            gate,
          ),
      });
      timing("session-created");
      const cancel = () => {
        void profile.retire().catch(() => undefined);
      };
      const removeCancellation = () => signal?.removeEventListener("abort", cancel);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      let context: ElectronBrowserContext | undefined;
      try {
        await profile.ready();
        signal?.throwIfAborted();
        timing("mirror-restored");
        this.#configureSession(
          profile.session,
          request.authenticator !== undefined || this.#authenticator !== undefined,
          profile.gate,
        );
        context = this.#context(
          profile.session,
          request.initialViewport,
          request.authenticator ?? this.#authenticator,
          profile,
          undefined,
          timing,
        );
        const browser = new ElectronLaunchedBrowser(
          context,
          profile.session,
          this.#clipboard,
          profile,
          {
            admitted: () => {
              signal?.throwIfAborted();
              removeCancellation();
              timing("admitted");
            },
            closed: removeCancellation,
          },
        );
        if (!request.preparation) {
          await browser.profile!.admit();
          await context.createPage();
        }
        signal?.throwIfAborted();
        return browser;
      } catch (error) {
        removeCancellation();
        await context?.close().catch(() => undefined);
        throw error;
      }
    }
    const snapshot =
      request.storage.kind === "legacy" ? request.storage.snapshot : EmptyBrowserProfileSnapshot;
    const authenticator = request.authenticator ?? this.#authenticator;
    const partition = electronBrowserPartition(request.partitionKey);
    const profileSession = electronSession.fromPartition(partition, {
      cache: true,
    });
    this.#configureSession(profileSession, authenticator !== undefined);
    await Promise.all([profileSession.clearCache(), profileSession.clearStorageData()]);
    const context = new ElectronBrowserContext({
      createView: (options, opener) => this.#views.create(options, opener, request.initialViewport),
      createHelper: (options) => this.#views.createHelper(options),
      profileSession,
      ...(authenticator ? { authenticator } : {}),
    });
    try {
      // The first page holds a blank document until launch returns, so it
      // opens while the saved sites restore; nothing can navigate it before.
      await joined([context.createPage(), context.importSnapshot(snapshot)]);
      signal?.throwIfAborted();
      return new ElectronLaunchedBrowser(context, profileSession, this.#clipboard);
    } catch (error) {
      await context.close().catch(() => undefined);
      await Promise.allSettled([profileSession.clearCache(), profileSession.clearStorageData()]);
      throw error;
    }
  }

  #context(
    profileSession: Session,
    viewport: Viewport,
    authenticator?: PasskeyAuthenticator,
    localProfile?: ElectronLocalProfile,
    importGate?: BrowserSessionRequestGate,
    onPageTiming?: PageOpenTiming,
  ): ElectronBrowserContext {
    return new ElectronBrowserContext({
      createView: (options, opener, timing) =>
        this.#views.create(options, opener, viewport, timing),
      createHelper: (options) => this.#views.createHelper(options),
      profileSession,
      ...(authenticator ? { authenticator } : {}),
      ...(localProfile ? { localProfile } : {}),
      ...(importGate ? { importGate } : {}),
      ...(onPageTiming ? { onPageTiming } : {}),
    });
  }

  #configureSession(
    profileSession: Session,
    provider: boolean,
    requestGate?: BrowserSessionRequestGate,
  ): void {
    if (this.#configuredSessions.has(profileSession)) {
      updateBrowserPasskeyPolicy(profileSession, provider);
      return;
    }
    this.#configuredSessions.add(profileSession);
    applyBrowserSessionPolicy(profileSession, {
      provider,
      downloads: this.#downloads,
      pagePolicyPreloadPath: this.#pagePolicyPreloadPath,
      ...(requestGate ? { requestGate } : {}),
    });
  }
}

/**
 * Keeps every browser page attached to its own non-interactive resting window.
 * A page can be reparented into the app for native presentation. A fully
 * transparent visible host keeps demanded pages compositing for CDP screencasts
 * wherever Electron implements window opacity. Hosts without capture or agent
 * demand stay hidden and background-throttled. Linux hosts remain hidden.
 */
interface ElectronBrowserView {
  readonly view: WebContentsView;
  readonly host: BaseWindow;
}

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElectronPagePresentation {
  readonly view: WebContentsView;
  waitForPaint(signal?: AbortSignal): Promise<void>;
  mount(
    window: BaseWindow,
    stage: WindowRect,
    onPlaced: (placement: NativePlacement) => void,
  ): void;
  invalidateSurface(): Promise<void>;
  setStage(stage: WindowRect, personFollows?: boolean): void;
  unmount(): void;
  inputOutstanding(): boolean;
  takeContextMenuTrigger(): "person" | "agent" | null;
  isFullscreen(): boolean;
  exitFullscreen(): Promise<void>;
}

export interface NativePlacement {
  readonly bounds: WindowRect;
  readonly crop: { readonly right: boolean; readonly bottom: boolean };
  readonly emulation: CdpParameters | null;
}

export function nativePlacement(
  mount: { readonly stage: WindowRect; readonly followsPerson: boolean } | null,
  geometry: PageGeometry,
): NativePlacement {
  const stage = mount?.stage;
  const layout = geometry.agent
    ? pageViewport(geometry)
    : mount?.followsPerson
      ? mount.stage
      : geometry.person;
  const width = stage ? Math.min(stage.width, layout.width) : layout.width;
  const height = stage ? Math.min(stage.height, layout.height) : layout.height;
  const crop = {
    right: !!stage && layout.width > stage.width,
    bottom: !!stage && layout.height > stage.height,
  };
  return {
    bounds: {
      x: stage ? stage.x + Math.floor((stage.width - width) / 2) : 0,
      y: stage?.y ?? 0,
      width,
      height,
    },
    crop,
    // Native bounds own visible size. Letting CDP resize the widget also caches
    // its old size, which Chromium restores on clear even after a native resize.
    emulation: geometry.agent
      ? { ...geometry.agent, dontSetVisibleSize: true }
      : crop.right || crop.bottom
        ? { ...layout, deviceScaleFactor: 0, mobile: false, dontSetVisibleSize: true }
        : null,
  };
}

export function electronPagePresentation(page: BrowserPage): ElectronPagePresentation | null {
  return page instanceof ElectronBrowserPage && !page.isClosed() ? page : null;
}

class ElectronBrowserViewPool {
  #closed = false;
  readonly #maxWebContents: number;
  readonly #views = new Map<WebContentsView, BaseWindow>();
  /**
   * Storage helpers never draw and live for one save or restore, at most
   * three at a time per profile, so they take no page slot: a save never
   * fails or crowds out pages because many pages are open.
   */
  readonly #helpers = new Set<WebContentsView>();

  constructor(maxWebContents: number) {
    if (!Number.isSafeInteger(maxWebContents) || maxWebContents < 1 || maxWebContents > 256) {
      throw new TypeError("Electron browser maxWebContents must be an integer from 1 through 256.");
    }
    this.#maxWebContents = maxWebContents;
  }

  close(): void {
    this.#closed = true;
    for (const view of [...this.#views.keys(), ...this.#helpers]) {
      const contents = view.webContents;
      if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    }
    for (const host of this.#views.values()) if (!host.isDestroyed()) host.destroy();
    this.#views.clear();
    this.#helpers.clear();
  }

  /** A view for hidden storage work; a native window per helper costs more than its load. */
  createHelper(options: ElectronBrowserViewOptions): WebContentsView {
    if (this.#closed) throw new Error("The Electron browser is stopping.");
    const view = new WebContentsView(options);
    this.#helpers.add(view);
    view.webContents.once("destroyed", () => this.#helpers.delete(view));
    return view;
  }

  create(
    options: ElectronBrowserViewOptions,
    opener: WebContentsView | null,
    restingBounds: { readonly height: number; readonly width: number },
    timing?: PageOpenTiming,
  ): ElectronBrowserView {
    if (this.#closed) throw new Error("The Electron browser is stopping.");
    if (this.#views.size >= this.#maxWebContents) {
      throw new Error("Electron Browser Runtime WebContents capacity is full.");
    }
    const view = new WebContentsView(options);
    timing?.("web-contents-view-created");
    const size = opener?.getBounds() ?? restingBounds;
    const bounds = { height: Math.round(size.height), width: Math.round(size.width) };
    let host: BaseWindow | null = null;
    try {
      const transparentRestingHost = process.platform !== "linux";
      host = new BaseWindow({
        enableLargerThanScreen: true,
        focusable: false,
        frame: false,
        ...bounds,
        hiddenInMissionControl: true,
        // Resting pages need a native owner that cannot activate the app.
        ...(process.platform === "darwin" ? { type: "panel" } : {}),
        ...(transparentRestingHost ? { opacity: 0 } : {}),
        show: false,
        skipTaskbar: true,
      });
      host.setIgnoreMouseEvents(true);
      host.contentView.addChildView(view);
      // Hiding the child view gives its renderer a zero-size viewport. The
      // resting host owns visibility; even an undrawn tab needs real layout.
      view.setBounds({ ...bounds, x: 0, y: 0 });
      // Unviewed pages stay hidden, as normal background tabs do. Capture or
      // an attached agent explicitly acquires compositing demand below.
    } catch (error) {
      if (host && !host.isDestroyed()) host.destroy();
      if (!view.webContents.isDestroyed()) {
        view.webContents.close({ waitForBeforeUnload: false });
      }
      throw error;
    }
    if (!host) throw new Error("Electron failed to create a browser resting host.");
    const restingHost = host;
    this.#views.set(view, restingHost);
    view.webContents.once("destroyed", () => {
      this.#views.delete(view);
      if (!restingHost.isDestroyed()) restingHost.destroy();
    });
    timing?.("resting-host-created");
    return { view, host: restingHost };
  }
}

type StorageCommand = (method: string, parameters?: Record<string, unknown>) => Promise<unknown>;
type StorageTask = (contents: WebContents, command: StorageCommand) => Promise<void>;

interface ElectronBrowserViewOptions {
  readonly webContents?: WebContents;
  readonly webPreferences?: WebPreferences;
}

type ElectronPopupWindowOptions = BrowserWindowConstructorOptions & {
  readonly webContents?: WebContents;
};

class ElectronLaunchedBrowser implements LaunchedBrowser {
  readonly clipboard?: EngineClipboard;
  readonly cdp: BrowserCdpBackend;
  readonly context: ElectronBrowserContext;
  readonly #events = new EventEmitter();
  readonly #profileSession: Session;
  #closePromise: Promise<void> | null = null;
  readonly #localProfile: ElectronLocalProfile | undefined;
  readonly #onProfileClose: (() => void) | undefined;
  readonly profile?: NonNullable<LaunchedBrowser["profile"]>;
  #admitted = false;

  constructor(
    context: ElectronBrowserContext,
    profileSession: Session,
    clipboard?: EngineClipboard,
    localProfile?: ElectronLocalProfile,
    lifecycle?: { admitted(): void; closed(): void },
  ) {
    if (clipboard) this.clipboard = clipboard;
    this.#localProfile = localProfile;
    this.#onProfileClose = lifecycle?.closed;
    if (localProfile)
      this.profile = {
        ready: () => localProfile.ready(),
        admit: async () => {
          if (this.#closePromise) throw new Error("Electron browser profile is closed.");
          await localProfile.admit();
          if (!this.#admitted) {
            lifecycle?.admitted();
            this.#admitted = true;
          }
        },
      };
    this.context = context;
    this.#profileSession = profileSession;
    this.cdp = new ElectronBrowserCdpBackend(context);
  }

  exportSnapshot(
    onOriginFailure?: (failure: BrowserOriginCaptureFailure) => void,
  ): Promise<BrowserProfileSnapshot> {
    return this.context.exportSnapshot(onOriginFailure);
  }

  replaceSiteCookies(
    site: string,
    cookies: readonly BrowserCookie[],
    deadline: AbortSignal,
  ): Promise<void> {
    return this.context.replaceSiteCookies(site, cookies, deadline);
  }

  onClose(listener: () => void): void {
    this.#events.on("close", listener);
  }

  offClose(listener: () => void): void {
    this.#events.off("close", listener);
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    await (this.cdp as ElectronBrowserCdpBackend).close().catch(() => undefined);
    this.#onProfileClose?.();
    await this.context.close();
    if (this.#localProfile) {
      if (!this.#admitted) await this.#localProfile.retire();
      else {
        await this.#profileSession.cookies.flushStore();
        await this.#localProfile.mirror.flush();
      }
    } else {
      await Promise.all([
        this.#profileSession.clearCache(),
        this.#profileSession.clearStorageData(),
      ]);
    }
    this.#events.emit("close");
    this.#events.removeAllListeners();
  }
}

interface ElectronBrowserContextOptions {
  readonly authenticator?: PasskeyAuthenticator;
  readonly createView: (
    options: ElectronBrowserViewOptions,
    opener: WebContentsView | null,
    timing?: PageOpenTiming,
  ) => ElectronBrowserView;
  readonly createHelper: (options: ElectronBrowserViewOptions) => WebContentsView;
  readonly profileSession: Session;
  readonly localProfile?: ElectronLocalProfile;
  readonly importGate?: BrowserSessionRequestGate;
  readonly onPageTiming?: PageOpenTiming;
}

class ElectronBrowserContext implements BrowserContext {
  isConnected(): boolean {
    return !this.#closed;
  }
  readonly #authenticator: PasskeyAuthenticator | undefined;
  // Popups inherit the session preload preferences before a page wrapper exists.
  // A random name per isolated browser context covers that first-document race.
  readonly #providerConfig: BrowserPagePolicyConfig;
  readonly #createView: ElectronBrowserContextOptions["createView"];
  readonly #createHelper: ElectronBrowserContextOptions["createHelper"];
  readonly #events = new EventEmitter();
  readonly #pages = new Set<ElectronBrowserPage>();
  readonly #profileSession: Session;
  readonly #visitedOrigins = new Set<string>();
  readonly #localProfile: ElectronLocalProfile | undefined;
  readonly #importGate: BrowserSessionRequestGate | undefined;
  readonly #untrack: (() => void) | undefined;
  #closed = false;
  #onPageTiming: PageOpenTiming | undefined;
  readonly #storageViews = new Set<WebContentsView>();
  readonly #displayChanged = () => {
    for (const page of this.#pages) page.displayChanged();
  };

  constructor(options: ElectronBrowserContextOptions) {
    this.#authenticator = options.authenticator;
    this.#providerConfig = options.authenticator ? createPasskeyProviderConfig() : undefined;
    this.#createView = options.createView;
    this.#createHelper = options.createHelper;
    this.#profileSession = options.profileSession;
    this.#localProfile = options.localProfile;
    this.#importGate = options.importGate;
    this.#onPageTiming = options.onPageTiming;
    this.#untrack = options.localProfile?.trackContext(() => this.close());
    screen.on("display-metrics-changed", this.#displayChanged);
    screen.on("display-added", this.#displayChanged);
    screen.on("display-removed", this.#displayChanged);
  }

  pages(): BrowserPage[] {
    return [...this.#pages].filter((page) => !page.isClosed());
  }

  async createPage(): Promise<BrowserPage> {
    await this.#localProfile?.ready();
    this.#assertOpen();
    this.#localProfile?.assertAdmitted();
    const timing = this.#onPageTiming;
    this.#onPageTiming = undefined;
    timing?.("page-create-started");
    const page = this.#newPage(
      null,
      {
        webPreferences: this.#securePreferences(),
      },
      timing,
    );
    try {
      // Native contexts need no import document. Browser-side target identity
      // lets the ledger subscribe before the first real navigation.
      if (!this.#localProfile) await page.loadInitialUrl("about:blank");
      await this.#announcePage(page);
      timing?.("page-announced");
      timing?.("first-page-created");
      return page;
    } catch (error) {
      await page.close().catch(() => undefined);
      throw error;
    }
  }

  onPage(listener: (page: BrowserPage) => void): void {
    this.#events.on("page", listener);
  }

  offPage(listener: (page: BrowserPage) => void): void {
    this.#events.off("page", listener);
  }

  onTargetEvent(listener: (method: string, parameters: CdpParameters) => void): () => void {
    this.#events.on("target", listener);
    return () => this.#events.off("target", listener);
  }

  #lastSnapshot: BrowserProfileSnapshot = EmptyBrowserProfileSnapshot;

  async importSnapshot(snapshot: BrowserProfileSnapshot): Promise<void> {
    const parsed = BrowserProfileSnapshotSchema.parse(snapshot);
    this.#lastSnapshot = parsed;
    // A repeated origin keeps its last state, as a restore in snapshot order would.
    const latest = new Map(parsed.origins.map((state) => [state.origin, state] as const));
    const states = new Map([...latest].filter(([, state]) => holdsStorage(state)));
    const tasks: StorageTask[] = [...states.values()].map((state) => async (contents) => {
      await loadStorageOrigin(contents, state.origin);
      await executeStorageOperation(contents, "restore", state);
    });
    if (parsed.cookies.length > 0)
      tasks.unshift(async (_contents, command) => {
        await command("Network.setCookies", { cookies: parsed.cookies.map(browserCookieToCdp) });
      });
    await this.#inStorageViews(tasks);
  }

  async replaceSiteCookies(
    site: string,
    cookies: readonly BrowserCookie[],
    deadline: AbortSignal,
  ): Promise<void> {
    deadline.throwIfAborted();
    // Invalid sign-in input cannot compromise the persistent store or its mirror lane.
    siteCookieReplacementBatch(site, [], cookies);
    const replace = async () =>
      this.#withStorageView(async (_view, command) => {
        // The same page-scoped Network domain exportSnapshot reads: it addresses
        // this Session's partition, which every page of the profile shares.
        const live = asRecord(await command("Network.getAllCookies")).cookies;
        const batch = siteCookieReplacementBatch(site, Array.isArray(live) ? live : [], cookies);
        if (batch.length === 0) return;
        deadline.throwIfAborted();
        await command("Network.setCookies", { cookies: batch });
      });
    if (this.#localProfile) {
      await this.#localProfile.mirror.mutate(async () => {
        await replace();
        await this.#profileSession.cookies.flushStore();
      }, deadline);
    } else await replace();
  }

  async verifyImportedCookies(snapshot: BrowserProfileSnapshot): Promise<void> {
    await this.#withStorageView(async (_view, command) => {
      const live = asRecord(await command("Network.getAllCookies")).cookies;
      if (!Array.isArray(live))
        throw new Error("Browser profile cookie import could not be verified.");
      const actual = live.map(browserCookieFromCdp);
      const normalize = (cookie: BrowserCookie) => ({
        ...browserCookieToCdp(cookie),
        expires: cookie.expires,
      });
      const now = Date.now() / 1_000;
      const canonical = (cookies: BrowserCookie[]) =>
        [
          ...new Set(
            cookies
              .filter((cookie) => cookie.expires < 0 || cookie.expires > now)
              .map((cookie) => JSON.stringify(normalize(cookie))),
          ),
        ].sort();
      if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(snapshot.cookies))) {
        throw new Error("Browser profile cookie import could not be verified.");
      }
    });
  }

  async exportSnapshot(
    onOriginFailure?: (failure: BrowserOriginCaptureFailure) => void,
  ): Promise<BrowserProfileSnapshot> {
    // A site gains storage only by running there, but loses it in other ways
    // too (Clear-Site-Data on a same-site request, eviction), so every site that
    // holds storage is read again.
    const origins = [
      ...new Set([
        ...this.#lastSnapshot.origins.filter(holdsStorage).map((state) => state.origin),
        ...this.#visitedOrigins,
      ]),
    ].sort();
    // Electron exposes a page debugger: Network addresses this Session's
    // partition. Storage defaults to the process's default context and only
    // accepts browserContextId on a Browser target. The real Electron smoke
    // verifies this page-scoped API's CHIPS fidelity and cross-profile isolation.
    let cookies: BrowserCookie[] = [];
    const collected = new Map<string, unknown>();
    const failedOrigins: string[] = [];
    await this.#inStorageViews([
      async (_contents, command) => {
        const result = asRecord(await command("Network.getAllCookies")).cookies;
        cookies = (Array.isArray(result) ? result : []).map(browserCookieFromCdp);
      },
      ...origins.map((origin): StorageTask => async (contents) => {
        try {
          await loadStorageOrigin(contents, origin);
          collected.set(origin, {
            ...(await executeStorageOperation(contents, "collect")),
            origin,
          });
        } catch {
          failedOrigins.push(origin);
        }
      }),
    ]);
    const snapshot = captureBrowserProfileSnapshot({
      cookies,
      // A site that now holds nothing is left out, which ends its saved state;
      // an invalid capture stays in, so validation rejects and reports it.
      origins: origins.flatMap((origin) => {
        if (!collected.has(origin)) return [];
        const state = collected.get(origin);
        const parsed = BrowserOriginStateSchema.safeParse(state);
        return !parsed.success || holdsStorage(parsed.data) ? [state] : [];
      }),
      previous: this.#lastSnapshot,
      failedOrigins: failedOrigins.sort(),
      ...(onOriginFailure ? { onOriginFailure } : {}),
    });
    this.#lastSnapshot = snapshot;
    return snapshot;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    screen.off("display-metrics-changed", this.#displayChanged);
    screen.off("display-added", this.#displayChanged);
    screen.off("display-removed", this.#displayChanged);
    const pages = [...this.#pages];
    this.#pages.clear();
    for (const view of this.#storageViews) {
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    }
    await Promise.allSettled(pages.map((page) => page.close()));
    this.#untrack?.();
    this.#events.removeAllListeners();
  }

  pageByTargetId(targetId: string): Promise<ElectronBrowserPage | null> {
    return this.#findPage(async (page) => (await page.targetId()) === targetId);
  }

  async targetInfos(): Promise<Record<string, unknown>[]> {
    return Promise.all(
      [...this.#pages].filter((page) => !page.isClosed()).map((page) => page.targetInfo()),
    );
  }

  async #findPage(predicate: (page: ElectronBrowserPage) => Promise<boolean>) {
    for (const page of this.#pages) if (!page.isClosed() && (await predicate(page))) return page;
    return null;
  }

  #newPage(
    opener: ElectronBrowserPage | null,
    options: ElectronBrowserViewOptions,
    timing?: PageOpenTiming,
  ): ElectronBrowserPage {
    this.#assertOpen();
    const page = new ElectronBrowserPage(
      this.#createView(options, opener?.view ?? null, timing),
      opener,
      this.#authenticator,
      this.#providerConfig,
      timing,
    );
    this.#pages.add(page);
    page.onClose(() => {
      this.#pages.delete(page);
      void page
        .targetId()
        .then((targetId) => {
          this.#events.emit("target", "Target.targetDestroyed", { targetId });
        })
        .catch(() => undefined);
    });
    if (!this.#localProfile)
      page.onFrameNavigated((url) => {
        const origin = httpOrigin(url);
        if (origin) this.#visitedOrigins.add(origin);
      });
    const securePreferences = this.#securePreferences();
    page.installPopupHandler(securePreferences, (popupOptions, details) => {
      // A view wrapping existing contents resets their preferences unless it is
      // given them again; the next cross-site navigation would apply defaults.
      const popup = this.#newPage(
        page,
        popupOptions.webContents
          ? {
              webContents: popupOptions.webContents,
              webPreferences: securePreferences,
            }
          : { webPreferences: securePreferences },
      );
      if (details.disposition === "background-tab" && !popupOptions.webContents) {
        void popup.loadInitialUrl(details.url).catch(() => popup.close());
      }
      setImmediate(() => {
        void this.#announcePage(popup).catch(() => popup.close());
      });
      return popup.view.webContents;
    });
    return page;
  }

  async #announcePage(page: ElectronBrowserPage): Promise<void> {
    const targetInfo = await page.targetInfo();
    this.#events.emit("target", "Target.targetCreated", { targetInfo });
    this.#events.emit("page", page);
  }

  #securePreferences(): WebPreferences {
    return {
      ...(this.#providerConfig
        ? {
            additionalArguments: [
              `--opensteer-passkey-provider=${JSON.stringify(this.#providerConfig)}`,
            ],
          }
        : {}),
      allowRunningInsecureContent: false,
      backgroundThrottling: true,
      contextIsolation: true,
      devTools: false,
      disableHtmlFullscreenWindowResize: true,
      disableBlinkFeatures: browserPageDisabledBlinkFeatures,
      focusOnNavigation: false,
      navigateOnDragDrop: false,
      nodeIntegration: false,
      // The page policy preload runs in main frames only; frames get the
      // page's debugger script (ElectronBrowserPage).
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      offscreen: false,
      safeDialogs: true,
      sandbox: true,
      session: this.#profileSession,
      webSecurity: true,
      webviewTag: false,
    };
  }

  async #withStorageView<T>(
    operation: (view: WebContentsView, command: StorageCommand) => Promise<T>,
  ): Promise<T> {
    await this.#localProfile?.ready();
    this.#assertOpen();
    const view = this.#createHelper({ webPreferences: this.#securePreferences() });
    this.#storageViews.add(view);
    const contents = view.webContents;
    const inspector = contents.debugger;
    const pending = new Set<Promise<unknown>>();
    const send = (method: string, parameters?: Record<string, unknown>) =>
      inspector.sendCommand(method, parameters);
    const onMessage = (_event: Electron.Event, method: string, parameters: unknown) => {
      if (method !== "Fetch.requestPaused") return;
      const requestId = asRecord(parameters).requestId;
      if (typeof requestId !== "string") return;
      const response = send("Fetch.fulfillRequest", {
        body: blankDocument,
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: "content-type", value: "text/html; charset=utf-8" },
          { name: "cache-control", value: "no-store" },
        ],
      });
      pending.add(response);
      void response.finally(() => pending.delete(response)).catch(() => undefined);
    };
    let removeHelper: (() => void) | undefined;
    try {
      inspector.attach("1.3");
      inspector.on("message", onMessage);
      // A worker the site registered this lifetime would otherwise answer the
      // helper's navigation and run site code here. The Network domain answers
      // only once the view has a renderer, which a blank document gives it.
      await contents.loadURL("about:blank");
      await send("Network.enable");
      await send("Network.setBypassServiceWorker", { bypass: true });
      await send("Fetch.enable", {
        patterns: [{ requestStage: "Request", urlPattern: "*" }],
      });
      removeHelper = this.#importGate?.allowStorageHelper(contents.id);
      return await operation(view, send);
    } finally {
      this.#storageViews.delete(view);
      removeHelper?.();
      await Promise.allSettled(pending);
      inspector.off("message", onMessage);
      // Closing also ends the debugger session. Returning only once the helper
      // is gone keeps its writes from outliving a failed start's cleanup, and
      // frees its pool slot.
      if (!contents.isDestroyed()) {
        const destroyed = new Promise<void>((resolve) =>
          contents.once("destroyed", () => resolve()),
        );
        contents.close({ waitForBeforeUnload: false });
        await destroyed;
      }
    }
  }

  /**
   * Runs each task once, spread over up to three storage views: a cross-site
   * load costs a renderer process, which parallel views hide. Origins are
   * independent storage keys, and cookies are one more task. The first failure
   * stops further tasks and rejects after every view is gone.
   */
  async #inStorageViews(tasks: readonly StorageTask[]): Promise<void> {
    const queue = [...tasks];
    let stopped = false;
    const stop = (error: unknown): never => {
      stopped = true;
      throw error;
    };
    await joined(
      Array.from({ length: Math.min(storageViewConcurrency, queue.length) }, () =>
        this.#withStorageView(async (view, command) => {
          while (!stopped && queue.length > 0)
            await queue.shift()!(view.webContents, command).catch(stop);
        }).catch(stop),
      ),
    );
  }

  #assertOpen(): void {
    this.#localProfile?.assertReady();
    if (this.#closed) throw new Error("Electron browser profile is closed.");
  }
}

class ElectronBrowserPage implements BrowserPage, ElectronPagePresentation {
  readonly view: WebContentsView;
  /**
   * Kept from creation: a destroyed view no longer exposes its WebContents,
   * and closing a page still needs it to remove listeners and report closed.
   */
  readonly #webContents: WebContents;
  #passkeyBridge: PasskeyBridge | undefined;
  readonly #hub: ElectronDebuggerHub;
  readonly #opener: ElectronBrowserPage | null;
  readonly #cdpPromise: Promise<CdpSession>;
  #dialog: unknown = null;
  #targetIdPromise: Promise<string> | null = null;
  readonly #passkeyInput = new Set<() => void>();
  readonly #humanInput = new Set<(observation: HumanInputObservation) => void>();
  readonly #restingHost: BaseWindow;
  #requestedRestingSize: { width: number; height: number };
  readonly #paintWaiters = new Set<{
    resolve(): void;
    reject(error: Error): void;
  }>();
  #capture: PageCapture | null = null;
  #captureRevision = 0;
  #captureKey: string | null = null;
  readonly #captureListeners = new Set<() => void>();
  readonly capture = {
    read: (): PageCapture | null => this.#capture,
    subscribe: (listener: () => void): (() => void) => {
      this.#captureListeners.add(listener);
      return () => this.#captureListeners.delete(listener);
    },
  };
  #frameSubscriptionRevision: number | null = null;
  #paintedSurfaceRevision = -1;
  #metricsSurfaceRevision = 0;
  #renderingDemand = false;
  #controlDown = false;
  #contextMenuTrigger: "person" | "agent" | null = null;
  #contextMenuCandidate: "person" | "agent" | null = null;
  #fullscreen = false;
  #geometry: PageGeometry;
  #metricsOverride: string | null = null;
  #boundsRevision = 0;
  #metricsBoundsRevision = 0;
  #desiredPlacement: NativePlacement;
  #surfaceRevision = 0;
  #appliedSurfaceRevision = -1;
  #surfaceAbort = new AbortController();
  #paintLifecycle = new AbortController();
  #reconciliation: Promise<void> | null = null;
  #serializeGeometry: ((operation: () => Promise<void>) => Promise<void>) | null = null;
  #beforeResize: (() => Promise<void>) | null = null;
  #mount: {
    window: BaseWindow;
    stage: WindowRect;
    followsPerson: boolean;
    onPlaced: (placement: NativePlacement) => void;
    dispose(): void;
  } | null = null;

  constructor(
    { view, host }: ElectronBrowserView,
    opener: ElectronBrowserPage | null,
    authenticator?: PasskeyAuthenticator,
    providerConfig?: BrowserPagePolicyConfig,
    timing?: PageOpenTiming,
  ) {
    this.view = view;
    this.#restingHost = host;
    this.#webContents = view.webContents;
    // Electron installs a native message-box listener even with Page enabled.
    // The debugger and ledger own these dialogs for the page's entire lifetime.
    view.webContents.removeAllListeners("-run-dialog");
    this.#opener = opener;
    const { width, height } = view.getBounds();
    this.#requestedRestingSize = { width, height };
    this.#geometry = { person: { width, height }, agent: null };
    this.#desiredPlacement = nativePlacement(null, this.#geometry);
    const inspector = view.webContents.debugger;
    inspector.on("message", (_event, method, parameters) => {
      if (method === "Page.javascriptDialogOpening") this.#dialog = parameters;
      if (method === "Page.javascriptDialogClosed") {
        this.#dialog = null;
        void this.#reconcile().catch(() => undefined);
      }
    });
    // Electron starts a popup's document as soon as createWindow returns.
    // Own dialogs before that first script, ahead of the hub's renderer-dependent
    // Runtime initialization, and keep an opening until the ledger subscribes.
    if (!authenticator && !inspector.isAttached()) inspector.attach("1.3");
    const pageEnabled = authenticator ? undefined : inspector.sendCommand("Page.enable");
    // The passkey policy has two hooks, each where its timing holds. Electron
    // has no pause-on-start and answers this registration only from a
    // renderer, so a page's first document cannot wait for it: the session's
    // main-frame preload covers first documents, and this script every later
    // document and every frame, where that preload sometimes never runs.
    const dispatchPolicy = () =>
      inspector.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
        source: browserPagePolicyScriptFor(providerConfig),
        runImmediately: true,
      });
    const timedPolicy = () => {
      const pending = dispatchPolicy();
      timing?.("page-policy-dispatched");
      return pending.then(() => timing?.("page-policy-ready"));
    };
    const pagePolicy = authenticator ? undefined : timedPolicy();
    this.#hub = new ElectronDebuggerHub(
      view.webContents,
      (demanded) => {
        this.#renderingDemand = demanded;
        this.#syncRenderingDemand();
      },
      () => this.waitForPaint(),
      () => this.#displayScale(),
      authenticator ? ["Network", "Security"] : [],
      () => timing?.("renderer-ready"),
    );
    const installBridge = (channel: ElectronCdpChannel) => {
      if (!authenticator || !providerConfig) return;
      this.#passkeyBridge = new PasskeyBridge(channel, authenticator, {
        targetId: () => this.targetId(),
        config: providerConfig,
        contexts: this.#hub.executionContexts,
      });
      view.webContents.once("destroyed", () => this.#passkeyBridge?.close());
      inspector.once("detach", () => this.#passkeyBridge?.close());
    };
    // Reserve subscriptions before Runtime's first replay or a first commit.
    // Dispatch is synchronous; renderer replies never gate navigation.
    const platform = authenticator
      ? Promise.resolve(this.#hub.bootstrapPlatform(installBridge))
      : this.#hub.open("platform");
    if (authenticator)
      void timedPolicy()
        .catch(() => this.close())
        .catch(() => undefined);
    if (this.#passkeyBridge)
      void this.#passkeyBridge
        .start()
        .catch(() => this.close())
        .catch(() => undefined);
    this.#cdpPromise = platform.then((channel) => {
      const on = channel.on.bind(channel);
      channel.on = (event, listener) => {
        on(event, listener);
        if (event === "Page.javascriptDialogOpening" && this.#dialog) listener(this.#dialog);
      };
      return channel;
    });
    void pageEnabled?.catch(() => this.close()).catch(() => undefined);
    void pagePolicy?.catch(() => this.close()).catch(() => undefined);
    void this.#cdpPromise.catch(() => this.close()).catch(() => undefined);
    view.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedBrowserNavigation(url)) event.preventDefault();
    });
    view.webContents.on("before-mouse-event", (_event, mouse) => {
      if (mouse.type !== "mouseDown") return;
      const origin = this.inputOutstanding() ? "agent" : "person";
      if (mouse.button === "right" || mouse.modifiers?.includes("control") || this.#controlDown)
        this.#contextMenuCandidate = origin;
      else this.#contextMenuCandidate = null;
      if (origin === "person") {
        for (const listener of this.#humanInput)
          listener({ kind: "click", x: mouse.x, y: mouse.y });
      }
    });
    view.webContents.on("before-input-event", (_event, input) => {
      this.#controlDown = input.control;
      if (input.type !== "keyDown" && input.type !== "rawKeyDown") return;
      const origin = this.inputOutstanding() ? "agent" : "person";
      this.#contextMenuCandidate =
        input.key === "ContextMenu" || (input.key === "F10" && input.shift) ? origin : null;
      if (
        origin === "person" &&
        !desktopBrowserAppShortcut(input) &&
        ![
          "Shift",
          "Control",
          "Alt",
          "Meta",
          "OS",
          "AltGraph",
          "CapsLock",
          "NumLock",
          "ScrollLock",
          "Fn",
        ].includes(input.key)
      ) {
        for (const listener of this.#humanInput) listener({ kind: "typing" });
      }
    });
    view.webContents.on("input-event", (_event, input) => {
      if (!["keyDown", "rawKeyDown", "mouseDown", "touchStart"].includes(input.type)) return;
      // input-event follows shortcut interception. The hub marks injected CDP
      // input, so only input from the person at the native view is attributed.
      if (!this.inputOutstanding()) for (const listener of this.#passkeyInput) listener();
      this.#contextMenuTrigger = this.#contextMenuCandidate;
      this.#contextMenuCandidate = null;
    });
    view.webContents.on("blur", () => {
      this.#controlDown = false;
    });
    view.webContents.on("enter-html-full-screen", () => {
      this.#fullscreen = true;
    });
    view.webContents.on("leave-html-full-screen", () => {
      this.#fullscreen = false;
    });
    view.webContents.on("did-navigate", () => {
      void this.invalidateSurface().catch(() => undefined);
    });
    view.webContents.on("render-process-gone", () => {
      // The hub rejects placement while crashed; navigation can recover it.
      this.#cancelPaint("crash");
      this.#fullscreen = false;
      this.#contextMenuTrigger = null;
      this.#contextMenuCandidate = null;
    });
    view.webContents.once("destroyed", () => {
      this.#cancelPaint();
      this.#passkeyInput.clear();
      this.#humanInput.clear();
      this.#contextMenuTrigger = null;
      this.#contextMenuCandidate = null;
      this.#mount?.dispose();
      this.#mount = null;
    });
    void view.webContents.setVisualZoomLevelLimits(1, 3).catch(() => undefined);
  }

  bindGeometry(
    serialize: (operation: () => Promise<void>) => Promise<void>,
    beforeResize: () => Promise<void>,
  ): () => void {
    if (this.#serializeGeometry) throw new Error("Electron page geometry already has an owner.");
    this.#serializeGeometry = serialize;
    this.#beforeResize = beforeResize;
    if (this.#surfaceAbort.signal.aborted) {
      // A released owner left its epoch terminal; a new owner starts a live one.
      this.#surfaceRevision += 1;
      this.#surfaceAbort = new AbortController();
    }
    return () => {
      this.#serializeGeometry = null;
      this.#beforeResize = null;
      this.#cancelPaint();
    };
  }

  async applyGeometry(geometry: PageGeometry): Promise<void> {
    const previous = this.#geometry;
    this.#geometry = geometry;
    try {
      await this.#applyPlacement(true);
    } catch (error) {
      this.#geometry = previous;
      if (!this.isClosed()) void this.#applyPlacement().catch(() => undefined);
      throw error;
    }
  }

  invalidateSurface(): Promise<void> {
    this.#invalidateAppliedSurface();
    return this.#reconcile();
  }

  #invalidateAppliedSurface(): void {
    if (
      this.#surfaceAbort.signal.aborted ||
      !this.#serializeGeometry ||
      this.isClosed() ||
      this.#hub.isCrashed()
    )
      return;
    this.#surfaceRevision += 1;
    this.#surfaceAbort.abort();
    this.#surfaceAbort = new AbortController();
    this.#hub.invalidateInput();
    this.#capture = null;
    for (const listener of this.#captureListeners) listener();
    if (this.#frameSubscriptionRevision !== null) this.#webContents.endFrameSubscription();
    this.#frameSubscriptionRevision = null;
  }

  #placementCurrent(): boolean {
    return (
      this.#appliedSurfaceRevision === this.#surfaceRevision &&
      JSON.stringify(this.#desiredPlacement) ===
        JSON.stringify(nativePlacement(this.#mount, this.#geometry))
    );
  }

  #reconcile(): Promise<void> {
    // Chromium holds renderer geometry requests under a dialog. Keep its
    // existing content and apply the latest placement after the answer.
    if (this.#dialog || this.#surfaceAbort.signal.aborted) return Promise.resolve();
    if (this.#placementCurrent()) return Promise.resolve();
    if (this.#reconciliation) return this.#reconciliation;
    if (!this.#serializeGeometry)
      return Promise.reject(new Error("Electron page geometry has no ledger owner."));
    const operation = this.#serializeGeometry(() => this.#applyPlacement(true));
    let completed = false;
    const reconciliation = operation
      .then(() => {
        completed = true;
      })
      .finally(() => {
        if (this.#reconciliation !== reconciliation) return;
        this.#reconciliation = null;
        if (
          completed &&
          !this.#surfaceAbort.signal.aborted &&
          this.#serializeGeometry &&
          !this.isClosed() &&
          !this.#hub.isCrashed() &&
          !this.#placementCurrent()
        )
          void this.#reconcile().catch(() => undefined);
      });
    this.#reconciliation = reconciliation;
    return reconciliation;
  }

  async #readyPlacement(signal: AbortSignal): Promise<void> {
    while (this.#appliedSurfaceRevision !== this.#surfaceRevision) {
      signal.throwIfAborted();
      if (this.isClosed()) throw new Error("Electron browser page is closed.");
      if (this.#hub.isCrashed()) throw new Error("Electron browser page crashed.");
      if (this.#dialog) return;
      await this.#reconcile();
    }
  }

  waitForPaint(signal?: AbortSignal): Promise<void> {
    return this.#waitForPaint(signal, this.#paintLifecycle.signal);
  }

  async #waitForPaint(signal?: AbortSignal, lifecycle?: AbortSignal): Promise<void> {
    const canceled =
      signal && lifecycle ? AbortSignal.any([signal, lifecycle]) : (signal ?? lifecycle);
    for (;;) {
      const epoch = this.#surfaceAbort.signal;
      const pending = canceled ? AbortSignal.any([canceled, epoch]) : epoch;
      try {
        // Start reconciliation independently: cancellation never waits for a
        // renderer command, and no geometry lane waits for compositor evidence.
        if (this.#serializeGeometry)
          void this.#readyPlacement(pending).catch((error: unknown) => {
            if (!epoch.aborted)
              for (const waiter of this.#paintWaiters)
                waiter.reject(error instanceof Error ? error : new Error(String(error)));
          });
        await this.#paint(pending);
        return;
      } catch (error) {
        if (
          epoch === this.#surfaceAbort.signal ||
          !epoch.aborted ||
          canceled?.aborted ||
          this.isClosed() ||
          this.#hub.isCrashed()
        )
          throw error;
      }
    }
  }

  #subscribePaint(): void {
    if (
      this.isClosed() ||
      this.#hub.isCrashed() ||
      this.#surfaceAbort.signal.aborted ||
      !this.#serializeGeometry ||
      this.#appliedSurfaceRevision !== this.#surfaceRevision ||
      this.#metricsSurfaceRevision !== this.#surfaceRevision
    )
      return;
    const revision = this.#surfaceRevision;
    if (this.#frameSubscriptionRevision === revision) return;
    if (this.#frameSubscriptionRevision !== null) this.#webContents.endFrameSubscription();
    this.#frameSubscriptionRevision = revision;
    const scale = this.#displayScale();
    this.#webContents.beginFrameSubscription((image) => {
      if (
        revision !== this.#surfaceRevision ||
        this.#surfaceAbort.signal.aborted ||
        !this.#serializeGeometry ||
        this.isClosed() ||
        this.#hub.isCrashed() ||
        this.#appliedSurfaceRevision !== revision ||
        this.#metricsSurfaceRevision !== revision ||
        scale !== this.#displayScale()
      )
        return;
      const raster = image.getSize(scale);
      const pixels = (dips: number) => Math.round(Math.fround(dips * Math.fround(scale)));
      const bounds = this.#desiredPlacement.bounds;
      if (raster.width !== pixels(bounds.width) || raster.height !== pixels(bounds.height)) return;
      this.#paintedSurfaceRevision = revision;
      this.#finishPaint();
    });
    this.#syncRenderingDemand();
  }

  #finishPaint(): void {
    if (
      this.#appliedSurfaceRevision !== this.#surfaceRevision ||
      this.#paintedSurfaceRevision !== this.#surfaceRevision
    )
      return;
    if (this.#frameSubscriptionRevision !== null) {
      this.#webContents.endFrameSubscription();
      this.#frameSubscriptionRevision = null;
    }
    for (const waiter of this.#paintWaiters) waiter.resolve();
    this.#syncRenderingDemand();
  }

  #paint(signal: AbortSignal = this.#surfaceAbort.signal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.isClosed()) throw new Error("Electron browser page is closed.");
      if (this.#hub.isCrashed())
        throw new Error("Electron browser page crashed; reload the page to continue.");
      signal.throwIfAborted();
      if (
        this.#paintedSurfaceRevision === this.#surfaceRevision &&
        this.#appliedSurfaceRevision === this.#surfaceRevision
      ) {
        resolve();
        return;
      }
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        this.#paintWaiters.delete(waiter);
        signal.removeEventListener("abort", abort);
        this.#syncRenderingDemand();
        if (error) reject(error);
        else resolve();
      };
      const abort = () => settle(new Error("Electron browser paint wait was canceled."));
      const waiter = {
        resolve: () => settle(),
        reject: (error: Error) => settle(error),
      };
      this.#paintWaiters.add(waiter);
      this.#syncRenderingDemand();
      signal.addEventListener("abort", abort, { once: true });
      this.#subscribePaint();
    });
  }

  settleRendering(signal?: AbortSignal): Promise<void> {
    // A remote cast survives reparenting; native handoff waiters cancel with it.
    return this.#waitForPaint(signal);
  }

  #cancelPaint(reason: "terminal" | "crash" | "reparent" = "terminal"): void {
    this.#paintLifecycle.abort();
    this.#paintLifecycle = new AbortController();
    if (reason === "terminal") this.#surfaceAbort.abort();
    this.#capture = null;
    if (reason !== "reparent") this.#captureKey = null;
    for (const listener of this.#captureListeners) listener();
    if (this.#frameSubscriptionRevision !== null && !this.isClosed())
      this.#webContents.endFrameSubscription();
    this.#frameSubscriptionRevision = null;
    for (const waiter of this.#paintWaiters)
      waiter.reject(new Error("Electron browser page is closed."));
  }

  observePasskeyInput(listener: () => void): () => void {
    this.#passkeyInput.add(listener);
    return () => {
      this.#passkeyInput.delete(listener);
    };
  }
  observeHumanInput(listener: (observation: HumanInputObservation) => void): () => void {
    this.#humanInput.add(listener);
    return () => this.#humanInput.delete(listener);
  }

  mount(
    window: BaseWindow,
    stage: WindowRect,
    onPlaced: (placement: NativePlacement) => void,
  ): void {
    if (this.isClosed() || window.isDestroyed())
      throw new Error("The browser presentation is closed.");
    const displayChanged = () => this.displayChanged();
    window.on("resize", displayChanged);
    window.on("move", displayChanged);
    this.#mount = {
      window,
      stage: { ...stage },
      followsPerson: window.isFocused(),
      onPlaced,
      dispose: () => {
        window.off("resize", displayChanged);
        window.off("move", displayChanged);
      },
    };
    this.#invalidateAppliedSurface();
    window.contentView.addChildView(this.view);
    this.view.setBorderRadius(15);
    void this.#reconcile().catch(() => undefined);
    this.#syncRenderingDemand();
  }

  setStage(stage: WindowRect, personFollows = true): void {
    if (!this.#mount || this.isClosed()) return;
    if (
      JSON.stringify(this.#mount.stage) === JSON.stringify(stage) &&
      this.#mount.followsPerson === personFollows
    )
      return;
    const previous = nativePlacement(this.#mount, this.#geometry);
    this.#mount.stage = { ...stage };
    this.#mount.followsPerson = personFollows;
    const next = nativePlacement(this.#mount, this.#geometry);
    if (
      previous.bounds.width !== next.bounds.width ||
      previous.bounds.height !== next.bounds.height ||
      JSON.stringify(previous.emulation) !== JSON.stringify(next.emulation)
    )
      this.#invalidateAppliedSurface();
    void this.#reconcile().catch(() => undefined);
  }

  unmount(): void {
    if (!this.#mount) return;
    this.#mount.dispose();
    this.#mount = null;
    // Reparenting cancels paint waits but keeps the geometry owner live.
    this.#cancelPaint("reparent");
    if (this.isClosed() || this.#restingHost.isDestroyed()) return;
    const { width, height } = this.view.getBounds();
    this.#resizeRestingHost({ width, height });
    this.#invalidateAppliedSurface();
    this.#restingHost.contentView.addChildView(this.view);
    this.view.setBorderRadius(0);
    void this.#reconcile().catch(() => undefined);
    this.#syncRenderingDemand();
  }

  inputOutstanding(): boolean {
    return this.#hub.inputOutstanding();
  }

  takeContextMenuTrigger(): "person" | "agent" | null {
    const origin = this.#contextMenuTrigger;
    this.#contextMenuTrigger = null;
    return origin;
  }

  isFullscreen(): boolean {
    return this.#fullscreen;
  }

  async exitFullscreen(): Promise<void> {
    const cdp = await this.cdp();
    const world = z.object({ executionContextId: z.number().int() }).parse(
      await cdp.send("Page.createIsolatedWorld", {
        frameId: await this.targetId(),
        worldName: "opensteer-paint",
      }),
    );
    await cdp.send("Runtime.evaluate", {
      contextId: world.executionContextId,
      expression: "document.fullscreenElement ? document.exitFullscreen() : undefined",
      awaitPromise: true,
    });
  }

  #assertPlacementLive(owner = this.#serializeGeometry): void {
    if (owner !== this.#serializeGeometry)
      throw new Error("Electron page geometry owner was replaced.");
    this.#surfaceAbort.signal.throwIfAborted();
    if (!this.#serializeGeometry) throw new Error("Electron page geometry has no ledger owner.");
    if (this.isClosed()) throw new Error("Electron browser page is closed.");
    if (this.#hub.isCrashed()) throw new Error("Electron browser page crashed.");
  }

  #resizeRestingHost(size: { width: number; height: number }): void {
    if (
      this.#restingHost.isDestroyed() ||
      (this.#requestedRestingSize.width === size.width &&
        this.#requestedRestingSize.height === size.height)
    )
      return;
    this.#restingHost.setContentSize(size.width, size.height);
    // An OS-constrained host may report a smaller size. The child and ledger
    // retain their full layout; repeating this request cannot prove acceptance.
    this.#requestedRestingSize = { ...size };
  }

  async #applyPlacement(geometryLocked = false): Promise<void> {
    if (!geometryLocked) return this.#reconcile();
    const owner = this.#serializeGeometry;
    this.#assertPlacementLive(owner);
    if (this.#dialog) return;
    const cdp = await this.cdp();
    this.#assertPlacementLive(owner);
    const release = cdp.retainRendering?.();
    try {
      do {
        this.#assertPlacementLive(owner);
        if (this.#dialog) return;
        let placement = nativePlacement(this.#mount, this.#geometry);
        const previous = this.view.getBounds();
        if (
          previous.width !== placement.bounds.width ||
          previous.height !== placement.bounds.height
        ) {
          const epoch = this.#surfaceAbort.signal;
          try {
            await this.#beforeResize?.();
          } catch (error) {
            this.#assertPlacementLive(owner);
            if (epoch !== this.#surfaceAbort.signal) continue;
            throw error;
          }
          this.#assertPlacementLive(owner);
          if (epoch !== this.#surfaceAbort.signal) continue;
          if (this.#dialog) return;
          placement = nativePlacement(this.#mount, this.#geometry);
        }
        const bounds = placement.bounds;
        if (JSON.stringify(placement) !== JSON.stringify(this.#desiredPlacement)) {
          const resized = previous.width !== bounds.width || previous.height !== bounds.height;
          const metricsChanged =
            JSON.stringify(placement.emulation) !==
            JSON.stringify(this.#desiredPlacement.emulation);
          this.#desiredPlacement = placement;
          if (resized) this.#boundsRevision += 1;
          if (resized || metricsChanged) this.#invalidateAppliedSurface();
          if (!this.#mount) this.#resizeRestingHost(bounds);
          if (previous.x !== bounds.x || previous.y !== bounds.y || resized)
            this.view.setBounds(bounds);
        }
        this.#mount?.onPlaced(placement);
        if (this.#appliedSurfaceRevision === this.#surfaceRevision) return;
        const revision = this.#surfaceRevision;
        const signal = this.#surfaceAbort.signal;
        const metrics = placement.emulation;
        if (!metrics && this.#metricsOverride === null) this.#metricsSurfaceRevision = revision;
        try {
          if (this.#boundsRevision !== this.#metricsBoundsRevision)
            await cdp.send("Page.getLayoutMetrics");
          this.#assertPlacementLive(owner);
          if (signal.aborted) continue;
          if (metrics) await cdp.send("Emulation.setDeviceMetricsOverride", { ...metrics });
          else if (this.#metricsOverride !== null)
            await cdp.send("Emulation.clearDeviceMetricsOverride");
          this.#metricsOverride = metrics ? JSON.stringify(metrics) : null;
          this.#assertPlacementLive(owner);
          if (signal.aborted) continue;
          this.#metricsSurfaceRevision = revision;
          await cdp.send("Page.getLayoutMetrics");
          this.#assertPlacementLive(owner);
          if (signal.aborted) continue;
          this.#metricsBoundsRevision = this.#boundsRevision;
          this.#appliedSurfaceRevision = revision;
          const rasterScale = this.#displayScale();
          const key = JSON.stringify([bounds.width, bounds.height, rasterScale, this.#geometry]);
          if (key !== this.#captureKey) {
            this.#captureRevision += 1;
            this.#captureKey = key;
          }
          this.#capture = {
            width: bounds.width,
            height: bounds.height,
            rasterScale,
            revision: this.#captureRevision,
          };
          for (const listener of this.#captureListeners) listener();
          this.#subscribePaint();
          this.#finishPaint();
        } catch (error) {
          this.#assertPlacementLive(owner);
          if (!signal.aborted) throw error;
        }
      } while (this.#appliedSurfaceRevision !== this.#surfaceRevision);
    } finally {
      release?.();
    }
  }

  displayChanged(): void {
    if (this.#capture && this.#capture.rasterScale !== this.#displayScale())
      void this.invalidateSurface().catch(() => undefined);
  }

  #displayScale(): number {
    const owner = this.#mount?.window ?? this.#restingHost;
    return screen.getDisplayMatching(owner.getBounds()).scaleFactor;
  }

  #syncRenderingDemand(): void {
    if (this.isClosed() || this.#restingHost.isDestroyed()) return;
    const demanded =
      this.#renderingDemand ||
      this.#paintWaiters.size > 0 ||
      this.#frameSubscriptionRevision !== null;
    this.#webContents.backgroundThrottling = !demanded;
    if (this.#mount) {
      if (this.#restingHost.isVisible()) this.#restingHost.hide();
    } else if (demanded && process.platform !== "linux") {
      if (!this.#restingHost.isVisible()) this.#restingHost.showInactive();
    } else if (this.#restingHost.isVisible()) this.#restingHost.hide();
  }

  loadInitialUrl(url: string): Promise<void> {
    if (!isAllowedBrowserNavigation(url)) {
      return Promise.reject(new Error("Electron browser navigation scheme is not allowed."));
    }
    return this.#webContents.loadURL(url);
  }

  submitNavigation(url: string): void {
    // Loading and failure remain page observations, independent of submission.
    void this.loadInitialUrl(url).catch(() => undefined);
  }

  cdp(): Promise<CdpSession> {
    return this.#cdpPromise;
  }

  agentCdp(): Promise<CdpSession> {
    return this.#hub.open("agent");
  }

  async close(): Promise<void> {
    if (this.#webContents.isDestroyed()) return;
    this.#passkeyBridge?.close();
    this.#webContents.stopFindInPage("clearSelection");
    this.unmount();
    this.#cancelPaint();
    // Closing the page answers whatever its commands still wait for, such as
    // an evaluation awaiting the person's input, so the hub finishes after it.
    const hubClosed = this.#hub.close();
    this.#webContents.close({ waitForBeforeUnload: false });
    await hubClosed;
  }

  isClosed(): boolean {
    return this.#webContents.isDestroyed();
  }

  onClose(listener: () => void): void {
    this.#webContents.on("destroyed", listener);
  }

  offClose(listener: () => void): void {
    this.#webContents.off("destroyed", listener);
  }

  onMetadataChanged(listener: () => void): void {
    this.#webContents.on("page-title-updated", listener);
    this.#webContents.on("did-navigate", listener);
    this.#webContents.on("did-navigate-in-page", listener);
    this.#webContents.on("did-finish-load", listener);
  }

  offMetadataChanged(listener: () => void): void {
    this.#webContents.off("page-title-updated", listener);
    this.#webContents.off("did-navigate", listener);
    this.#webContents.off("did-navigate-in-page", listener);
    this.#webContents.off("did-finish-load", listener);
  }

  onFrameNavigated(listener: (url: string) => void): void {
    this.#webContents.on("did-frame-navigate", (_event, url) => listener(url));
  }

  opener(): Promise<BrowserPage | null> {
    return Promise.resolve(this.#opener);
  }

  targetId(): Promise<string> {
    this.#targetIdPromise ??= this.#hub.open("platform").then(async (channel) => {
      try {
        const response = asRecord(await channel.send("Target.getTargetInfo"));
        const targetId = asRecord(response.targetInfo).targetId;
        if (typeof targetId !== "string" || targetId.length < 1 || targetId.length > 512) {
          throw new Error("Electron WebContents did not expose a valid CDP target ID.");
        }
        return targetId;
      } finally {
        await channel.close();
      }
    });
    return this.#targetIdPromise;
  }

  async targetInfo(): Promise<Record<string, unknown>> {
    return {
      attached: this.#webContents.debugger.isAttached(),
      browserContextId: "opensteer-electron-profile",
      canAccessOpener: Boolean(this.#opener),
      openerId: this.#opener ? await this.#opener.targetId() : undefined,
      targetId: await this.targetId(),
      title: await this.title(),
      type: "page",
      url: this.url(),
    };
  }

  title(): Promise<string> {
    return Promise.resolve(this.#webContents.getTitle());
  }

  url(): string {
    return this.#webContents.getURL() || "about:blank";
  }

  installPopupHandler(
    securePreferences: WebPreferences,
    create: (options: ElectronPopupWindowOptions, details: ElectronPopupDetails) => WebContents,
  ): void {
    this.#webContents.setWindowOpenHandler((details) => {
      if (!isAllowedBrowserNavigation(details.url, true)) return { action: "deny" };
      return {
        action: "allow",
        createWindow: (options) => create(options as ElectronPopupWindowOptions, details),
        outlivesOpener: true,
        overrideBrowserWindowOptions: {
          show: false,
          webPreferences: securePreferences,
        },
      };
    });
  }
}

interface ElectronPopupDetails {
  readonly disposition: string;
  readonly url: string;
}

type ChannelRole = "agent" | "platform";

/**
 * Shares one `webContents.debugger` among logical channels. Each channel must
 * behave as a fresh CDP session, which the agent CDP router relies on to know
 * every frame's main world: Chromium reports every live execution context to
 * a session that enables Runtime. Only the first enable of a shared session
 * reaches Chromium, so the hub enables Runtime itself for as long as the
 * debugger is attached, keeps the contexts, and reports them to each channel
 * that enables Runtime.
 *
 * Commands go to Chromium as they are issued, without waiting for earlier
 * answers: an agent's evaluation awaiting a promise never holds the person's
 * input, navigation or screencast acknowledgements, and a promise that waits
 * for the person's input can settle. Shared state, domain enables and
 * disables, screencast ownership and Runtime subscription, changes one
 * operation at a time, so such a change can wait behind another channel's. A
 * channel's later command of the same domain waits for it; a command of
 * another domain does not, and can reach Chromium first.
 *
 * Chromium casts the page once for every channel that screencasts it, with
 * one channel's parameters: the person's view's while it casts, since its
 * picture is the one the person reads and aims their input at, and otherwise
 * those of the latest channel to start. Every start reaches Chromium as a
 * fresh cast with those parameters, stopping the one under way first: a start
 * while casting would picture its last capture again, which after a resize
 * still shows the old size. So the person's restart after a resize is never
 * lost behind an agent's cast, and an agent joining a static page gets its
 * first frame at once. Only the
 * last stop ends the cast; the channels left keep its parameters until one of
 * them starts again. Chromium counts one acknowledgement per frame it sent, so
 * only the channel whose parameters it uses acknowledges frames to it.
 */
class ElectronDebuggerHub {
  readonly #channels = new Set<ElectronCdpChannel>();
  readonly #contexts = new ExecutionContextInventory();
  readonly #debugger: Debugger;
  readonly #destroyed: Promise<void>;
  readonly #domainOwners = new Map<string, Set<ElectronCdpChannel>>();
  readonly #persistentPlatformDomains: ReadonlySet<string>;
  readonly #onRendererReady: (() => void) | undefined;
  readonly #events = new EventEmitter();
  /**
   * Chromium's own answers to input it has not answered yet. Callers can be
   * rejected sooner; the input stays the page's until its answer arrives.
   */
  readonly #outstandingInput = new Set<Promise<void>>();
  readonly #pending = new Set<(error: Error) => void>();
  #rendererGeneration = 0;
  #crashed = false;
  /** Each channel screencasting, with the parameters it asked for, in the order they started. */
  readonly #renderingOwners = new Map<ElectronCdpChannel, number>();
  readonly #screencastOwners = new Map<ElectronCdpChannel, Record<string, unknown> | undefined>();
  readonly #webContents: WebContents;
  readonly #setRenderingDemand: (demanded: boolean) => void;
  readonly #prepareInput: () => Promise<void>;
  readonly #displayScale: () => number;
  #inputReady: Promise<void> | null = null;
  #deviceScaleFactor: number | null = null;
  /** Settles once the hub's own Runtime.enable has reported every context. */
  #attachment: Promise<void> | null = null;
  #closed = false;
  /**
   * Resolves when the next Runtime command may go to Chromium. Browser-side
   * target identity and dialog ownership never wait for renderer contexts.
   */
  #gate: Promise<void> | null = null;
  #ownershipPending = 0;
  #ownershipTail: Promise<void> = Promise.resolve();
  /** The detach once no channel is left; a channel opened meanwhile waits for it. */
  #teardown: Promise<void> | null = null;
  #autoAttachRequest = 0;

  constructor(
    webContents: WebContents,
    setRenderingDemand: (demanded: boolean) => void,
    prepareInput: () => Promise<void>,
    displayScale: () => number,
    persistentPlatformDomains: readonly string[] = [],
    onRendererReady?: () => void,
  ) {
    this.#persistentPlatformDomains = new Set(persistentPlatformDomains);
    this.#onRendererReady = onRendererReady;
    this.#webContents = webContents;
    this.#setRenderingDemand = setRenderingDemand;
    this.#prepareInput = prepareInput;
    this.#displayScale = displayScale;
    this.#debugger = webContents.debugger;
    this.#destroyed = new Promise((resolve) => {
      webContents.once("destroyed", () => resolve());
    });
    this.#debugger.on("message", (_event, method, parameters) => {
      const record = asRecord(parameters);
      this.#contexts.observe(method, record);
      const recipients =
        method === "Page.screencastFrame"
          ? [...this.#screencastOwners.keys()]
          : this.#domainOwners.get(method.split(".", 1)[0] ?? "");
      for (const channel of recipients ?? []) channel.emit(method, record);
    });
    this.#debugger.on("detach", (_event, reason) => {
      this.#interrupt(new Error(`Electron CDP debugger detached: ${reason}.`));
      this.#forgetContexts();
      this.#events.emit("detach", reason);
    });
    webContents.on("render-process-gone", (_event, details) => {
      this.#crashed = true;
      this.#interrupt(
        new Error(
          `Electron browser page crashed (${details.reason}); reload the page to continue.`,
        ),
      );
      this.#forgetContexts();
    });
    webContents.once("destroyed", () =>
      this.#interrupt(new Error("Electron CDP target is closed.")),
    );
    // Electron applies background throttling to the renderer the page has when
    // it is set. A navigation can give the page a new renderer, which starts
    // hidden in the transparent resting window: until throttling is set again
    // it draws nothing, takes no clicks and gives a screencast no frame.
    webContents.on("did-navigate", () => {
      this.#crashed = false;
      this.#inputReady = null;
      this.#updateThrottling();
      if (!this.#closed && this.#channels.size && !this.#attachment)
        void this.#attach().catch(() => undefined);
    });
  }

  get executionContexts(): Pick<ExecutionContextInventory, "entries"> {
    return this.#contexts;
  }

  inputOutstanding(): boolean {
    return this.#outstandingInput.size > 0;
  }

  invalidateInput(): void {
    this.#inputReady = null;
  }

  isCrashed(): boolean {
    return this.#crashed;
  }

  /** Only the fresh page's provider bootstrap may dispatch this initial batch. */
  bootstrapPlatform(install: (channel: ElectronCdpChannel) => void): ElectronCdpChannel {
    if (this.#channels.size || this.#attachment || this.#ownershipPending || this.#closed)
      throw new Error("Electron platform bootstrap is already initialized.");
    const channel = new ElectronCdpChannel(this, "platform");
    this.#channels.add(channel);
    const domains = ["Page", "Network", "Security"];
    for (const domain of [...domains, "Runtime"]) {
      this.#domainOwners.set(domain, new Set([channel]));
      channel.enabledDomains.add(domain);
    }
    install(channel);
    if (!this.#debugger.isAttached()) this.#debugger.attach("1.3");
    // All owners and listeners exist before the first command can emit. This
    // fresh-session exception dispatches independent initial enables together;
    // their accounting and every later ownership change remain serialized.
    const completions = domains.map((domain) => {
      const owners = this.#domainOwners.get(domain)!;
      const command = this.#dispatch(`${domain}.enable`).catch((error: unknown) => {
        owners.delete(channel);
        channel.enabledDomains.delete(domain);
        if (owners.size === 0 && this.#domainOwners.get(domain) === owners)
          this.#domainOwners.delete(domain);
        void this.close().catch(() => undefined);
        throw error;
      });
      void command.catch(() => undefined);
      return { domain, command };
    });
    for (const { domain, command } of completions) {
      void this.#changeDomain(channel, domain, () => command).catch(() => undefined);
    }
    void this.#attach()
      .catch(() => this.close())
      .catch(() => undefined);
    return channel;
  }

  async open(role: ChannelRole): Promise<ElectronCdpChannel> {
    // A channel never joins the session its predecessors gave up: a command
    // they abandoned can still take effect there, and Chromium reports the
    // contexts only to a fresh Runtime.enable.
    while (this.#teardown) await this.#teardown;
    if (this.#closed || this.#webContents.isDestroyed())
      throw new Error("Electron CDP target is closed.");
    const channel = new ElectronCdpChannel(this, role);
    // Counted before the attachment settles, so a release cannot detach under it.
    this.#channels.add(channel);
    this.#updateThrottling();
    const generation = this.#rendererGeneration;
    try {
      if (!this.#crashed)
        void this.#attach()
          .catch(() => {
            if (generation === this.#rendererGeneration) return this.close();
            return undefined;
          })
          .catch(() => undefined);
    } catch (error) {
      await channel.close();
      throw error;
    }
    return channel;
  }

  retainRendering(channel: ElectronCdpChannel): () => void {
    if (this.#closed || !this.#channels.has(channel)) return () => undefined;
    this.#renderingOwners.set(channel, (this.#renderingOwners.get(channel) ?? 0) + 1);
    this.#updateThrottling();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.#renderingOwners.get(channel) ?? 0;
      if (count <= 1) this.#renderingOwners.delete(channel);
      else this.#renderingOwners.set(channel, count - 1);
      this.#updateThrottling();
    };
  }

  send(
    channel: ElectronCdpChannel,
    method: string,
    parameters?: Record<string, unknown>,
  ): Promise<unknown> {
    const command = Promise.withResolvers<unknown>();
    this.#pending.add(command.reject);
    try {
      void this.#send(channel, method, parameters).then(command.resolve, command.reject);
    } catch (error) {
      command.reject(error);
    }
    const settle = () => this.#pending.delete(command.reject);
    void command.promise.then(settle, settle);
    return command.promise;
  }

  #send(
    channel: ElectronCdpChannel,
    method: string,
    parameters?: Record<string, unknown>,
  ): Promise<unknown> {
    const generation = this.#rendererGeneration;
    if (this.#closed || !this.#channels.has(channel))
      return Promise.reject(new Error("CDP channel is closed."));
    if (
      channel.role === "agent" &&
      (method === "Page.bringToFront" || method === "Target.activateTarget")
    )
      return Promise.resolve({});
    // Derived gestures can deliver native input after their CDP response.
    // Live composition belongs only to the private editing channel.
    if (
      method.startsWith("Input.") &&
      !agentCdpAllowlist.methods.has(method) &&
      !(channel.role === "platform" && method === "Input.imeSetComposition")
    )
      return Promise.reject(new Error(`${method} is unavailable on an Electron page channel.`));
    // A first-document dialog can hold Runtime.enable or Page.enable. Its
    // answer releases those waits, so it must reach the browser ahead of them.
    if (method === "Page.handleJavaScriptDialog") return this.#dispatch(method, parameters);
    if (method === "Page.captureScreenshot") {
      const release = this.retainRendering(channel);
      return this.#command(method, parameters).finally(release);
    }
    if (
      method === "Emulation.setDeviceMetricsOverride" &&
      typeof parameters?.deviceScaleFactor === "number" &&
      Number.isFinite(parameters.deviceScaleFactor) &&
      parameters.deviceScaleFactor >= 0
    )
      this.#deviceScaleFactor = parameters.deviceScaleFactor || null;
    if (method === "Emulation.clearDeviceMetricsOverride") this.#deviceScaleFactor = null;
    const releasesInput =
      (method === "Input.dispatchMouseEvent" && parameters?.type === "mouseReleased") ||
      (method === "Input.dispatchKeyEvent" && parameters?.type === "keyUp") ||
      (method === "Input.dispatchTouchEvent" &&
        (parameters?.type === "touchEnd" || parameters?.type === "touchCancel")) ||
      method === "Input.cancelDragging";
    // Resize/revocation releases run before geometry changes. Waiting for that
    // geometry's paint here would make the ledger wait on its own lock.
    if (releasesInput) return this.#command(method, parameters);
    if (method.startsWith("Input.")) {
      // A background document can finish before its native hit-test surface
      // exists. Its first input waits for paint; dialog answers and the other
      // domains remain independent of that wait.
      if (!this.#inputReady) {
        const ready = this.#prepareInput();
        this.#inputReady = ready;
        void ready.catch(() => {
          if (this.#inputReady === ready) this.#inputReady = null;
        });
      }
      return this.#inputReady.then(async () => {
        if (generation !== this.#rendererGeneration)
          throw new Error("Electron CDP renderer changed before command dispatch.");
        if (this.#closed || !this.#channels.has(channel)) throw new Error("CDP channel is closed.");
        if (
          method === "Input.dispatchMouseEvent" &&
          parameters?.type === "mouseWheel" &&
          typeof parameters.deltaX === "number" &&
          typeof parameters.deltaY === "number"
        ) {
          const { cssVisualViewport } = z
            .object({
              cssVisualViewport: z.object({
                zoom: z.number().positive(),
                scale: z.number().positive(),
              }),
            })
            .parse(await this.#command("Page.getLayoutMetrics"));
          // Chromium divides native wheel deltas by the emulated/native DPR ratio
          // and visual page scale. CDP pointer anchors already use CSS coordinates.
          const density =
            this.#deviceScaleFactor === null ? 1 : this.#deviceScaleFactor / this.#displayScale();
          const scale = density * cssVisualViewport.zoom * cssVisualViewport.scale;
          parameters = {
            ...parameters,
            deltaX: parameters.deltaX * scale,
            deltaY: parameters.deltaY * scale,
          };
        }
        if (generation !== this.#rendererGeneration)
          throw new Error("Electron CDP renderer changed before command dispatch.");
        if (this.#closed || !this.#channels.has(channel)) throw new Error("CDP channel is closed.");
        return this.#command(method, parameters);
      });
    }
    if (method === "Page.startScreencast") {
      return this.#serializeOwnership(async () => {
        const generation = this.#rendererGeneration;
        const casting = this.#screencastOwners.size > 0;
        const restarted = this.#screencastOwners.has(channel);
        const previous = this.#screencastOwners.get(channel);
        this.#screencastOwners.delete(channel);
        this.#screencastOwners.set(channel, parameters);
        this.#updateThrottling();
        try {
          if (casting) await this.#command("Page.stopScreencast");
          this.#assertCurrent(generation);
          await this.#command(method, this.#deciding()?.[1]);
          return {};
        } catch (error) {
          this.#screencastOwners.delete(channel);
          // A released channel's cast is not restored for anyone to inherit.
          if (restarted && this.#channels.has(channel))
            this.#screencastOwners.set(channel, previous);
          this.#updateThrottling();
          throw error;
        }
      });
    }
    if (method === "Page.stopScreencast") {
      return this.#serializeOwnership(async () => {
        if (!this.#screencastOwners.delete(channel)) return {};
        this.#updateThrottling();
        if (this.#screencastOwners.size === 0) await this.#command(method, parameters);
        return {};
      });
    }
    if (method === "Page.screencastFrameAck" && this.#deciding()?.[0] !== channel) {
      return Promise.resolve({});
    }
    if (method === "Target.setAutoAttach" || method === "Target.sendMessageToTarget") {
      // Out-of-process frames' sessions are the platform's, as the agent
      // router already keeps them.
      if (channel.role === "agent")
        return Promise.reject(new Error(`${method} is unavailable on an Electron page channel.`));
      if (method === "Target.setAutoAttach") return this.#autoAttach(channel, parameters);
    }
    if (method === "Runtime.enable") {
      return this.#changeDomain(channel, "Runtime", () => this.#subscribe(channel));
    }
    if (method === "Runtime.disable") {
      return this.#changeDomain(channel, "Runtime", async () => {
        const owners = this.#domainOwners.get("Runtime");
        owners?.delete(channel);
        channel.enabledDomains.delete("Runtime");
        if (owners?.size === 0) this.#domainOwners.delete("Runtime");
        return {};
      });
    }
    const separator = method.indexOf(".");
    const domain = separator > 0 ? method.slice(0, separator) : "";
    const operation = separator > 0 ? method.slice(separator + 1) : "";
    if (operation === "enable") {
      return this.#changeDomain(channel, domain, async () => {
        const owners = this.#domainOwners.get(domain) ?? new Set<ElectronCdpChannel>();
        const reconfigure =
          domain === "Network" && parameters !== undefined && Object.keys(parameters).length > 0;
        if (owners.has(channel)) return reconfigure ? this.#command(method, parameters) : {};
        const first = owners.size === 0;
        owners.add(channel);
        channel.enabledDomains.add(domain);
        this.#domainOwners.set(domain, owners);
        try {
          if (first || reconfigure) await this.#command(method, parameters);
          return {};
        } catch (error) {
          owners.delete(channel);
          channel.enabledDomains.delete(domain);
          if (owners.size === 0 && this.#domainOwners.get(domain) === owners)
            this.#domainOwners.delete(domain);
          throw error;
        }
      });
    }
    if (operation === "disable") {
      return this.#changeDomain(channel, domain, async () => {
        const owners = this.#domainOwners.get(domain);
        if (!owners?.has(channel)) return {};
        // Provider TLS observations outlive short platform consumers such as
        // favicon acquisition. The same channel releases them when it closes.
        if (channel.role === "platform" && this.#persistentPlatformDomains.has(domain)) return {};
        // Page remains enabled for this page's lifetime so Electron never owns
        // JavaScript dialogs, even between ledger/channel subscriptions.
        if (owners.size === 1 && domain !== "Page") await this.#command(method, parameters);
        owners.delete(channel);
        channel.enabledDomains.delete(domain);
        if (owners.size === 0 && this.#domainOwners.get(domain) === owners)
          this.#domainOwners.delete(domain);
        return {};
      });
    }
    const change = channel.domainChanges.get(domain);
    if (!change) return this.#command(method, parameters);
    return change.then(() => {
      if (generation !== this.#rendererGeneration)
        throw new Error("Electron CDP renderer changed before command dispatch.");
      if (this.#closed || !this.#channels.has(channel)) throw new Error("CDP channel is closed.");
      return this.#command(method, parameters);
    });
  }

  async release(channel: ElectronCdpChannel): Promise<void> {
    if (!this.#channels.delete(channel)) return;
    this.#renderingOwners.delete(channel);
    if (this.#channels.size === 0) {
      channel.clearListeners();
      await this.#terminate(new Error("Electron CDP channel was released."));
      return;
    }
    // Letting go of what the channel owned always completes, in order with the
    // other ownership changes, or a later enable would count it and send
    // nothing. Chromium is asked to stop or disable only while the generation
    // the release began in lasts; a renderer change or the last channel's
    // teardown has already asked nothing more of it.
    const generation = this.#rendererGeneration;
    const current = () => generation === this.#rendererGeneration;
    await this.#serializeOwnership(async () => {
      if (this.#screencastOwners.delete(channel) && this.#screencastOwners.size === 0 && current())
        await this.#command("Page.stopScreencast").catch(() => undefined);
      for (const domain of channel.enabledDomains) {
        const owners = this.#domainOwners.get(domain);
        owners?.delete(channel);
        if (!owners || owners.size > 0) continue;
        this.#domainOwners.delete(domain);
        // The hub's own Runtime subscription outlives its channels'.
        if (domain === "Runtime" || domain === "Page" || !current()) continue;
        await (
          domain === "Target"
            ? this.#command("Target.setAutoAttach", {
                autoAttach: false,
                waitForDebuggerOnStart: false,
              })
            : this.#command(`${domain}.disable`)
        ).catch(() => undefined);
      }
      channel.enabledDomains.clear();
    }, false);
    channel.clearListeners();
    this.#updateThrottling();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const channels = [...this.#channels];
    this.#channels.clear();
    for (const channel of channels) channel.clearListeners();
    await this.#terminate(new Error("Electron CDP target is closing."));
    this.#events.removeAllListeners();
  }

  /**
   * Ends the session once no channel is left. Nothing still waiting on the
   * renderer is waited for: every caller is rejected, operations already
   * running ask nothing more, and no cleanup is sent, since the detach ends the
   * cast and every domain. Only input waits for Chromium's own answer (or the
   * page's destruction), which ends its exclusion. Concurrent callers share it.
   */
  #terminate(error: Error): Promise<void> {
    if (this.#teardown) return this.#teardown;
    this.#interrupt(error);
    this.#domainOwners.clear();
    this.#screencastOwners.clear();
    this.#renderingOwners.clear();
    this.#updateThrottling();
    const teardown = (async () => {
      await this.#ownershipTail;
      while (this.#outstandingInput.size > 0 && !this.#webContents.isDestroyed())
        await Promise.race([Promise.all(this.#outstandingInput), this.#destroyed]);
      if (this.#channels.size === 0 && this.#isAttached()) this.#debugger.detach();
      this.#forgetContexts();
    })().finally(() => {
      if (this.#teardown === teardown) this.#teardown = null;
    });
    this.#teardown = teardown;
    return teardown;
  }

  #attach(): Promise<void> {
    if (this.#attachment) return this.#attachment;
    if (!this.#debugger.isAttached()) this.#debugger.attach("1.3");
    this.#contexts.clear();
    // Runtime commands wait until every context has been inventoried.
    const attachment = this.#dispatch("Runtime.enable").then(() => {
      this.#onRendererReady?.();
    });
    this.#attachment = attachment;
    const settled = attachment.then(
      () => undefined,
      () => undefined,
    );
    const earlier = this.#gate;
    this.#holdCommandsUntil(earlier ? earlier.then(() => settled) : settled);
    attachment.catch(() => {
      if (this.#attachment === attachment) this.#forgetContexts();
    });
    return attachment;
  }

  /** Reports the contexts that exist to a channel that enables Runtime, then each change. */
  async #subscribe(channel: ElectronCdpChannel): Promise<Record<string, never>> {
    if (this.#domainOwners.get("Runtime")?.has(channel)) return {};
    const attachment = this.#attachment ?? this.#attach();
    await attachment;
    if (this.#closed || !this.#channels.has(channel)) throw new Error("CDP channel is closed.");
    const owners = this.#domainOwners.get("Runtime") ?? new Set<ElectronCdpChannel>();
    owners.add(channel);
    channel.enabledDomains.add("Runtime");
    this.#domainOwners.set("Runtime", owners);
    for (const context of this.#contexts.entries()) {
      channel.emit("Runtime.executionContextCreated", {
        context: context.description,
      });
    }
    return {};
  }

  /**
   * Auto-attach is the debugger session's own state: Chromium announces each
   * out-of-process frame once and relays that frame's session as one stream.
   * So one channel at a time owns it and alone hears the Target events, and a
   * different channel's request is refused rather than silently replacing it.
   * Its answer can wait for the renderer, so it never joins the ownership
   * changes other channels wait behind.
   */
  #autoAttach(
    channel: ElectronCdpChannel,
    parameters: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    const owners = this.#domainOwners.get("Target");
    if (owners && !owners.has(channel))
      return Promise.reject(new Error("Another channel owns this page's out-of-process frames."));
    // Only the latest request's answer may change ownership: a later request
    // has already set it as Chromium will apply them, in order.
    const request = ++this.#autoAttachRequest;
    const latest = () => request === this.#autoAttachRequest;
    const release = () => {
      if (this.#domainOwners.get("Target")?.has(channel)) this.#domainOwners.delete("Target");
      channel.enabledDomains.delete("Target");
    };
    if (parameters?.autoAttach !== true) {
      if (!owners) return Promise.resolve({});
      // Each frame's detachment arrives before the answer, for the owner.
      return this.#command("Target.setAutoAttach", parameters).finally(() => {
        if (latest()) release();
      });
    }
    // Frames that already exist are announced before the answer.
    this.#domainOwners.set("Target", owners ?? new Set([channel]));
    channel.enabledDomains.add("Target");
    return this.#command("Target.setAutoAttach", parameters).catch((error: unknown) => {
      if (latest() && !owners) release();
      throw error;
    });
  }

  /**
   * The debugger is gone, and with it every context it reported: subscribed
   * channels hear them cleared, and the next attachment reports them afresh.
   */
  #forgetContexts(): void {
    this.#attachment = null;
    if (this.#contexts.entries().length === 0) return;
    this.#contexts.clear();
    for (const channel of this.#domainOwners.get("Runtime") ?? []) {
      channel.emit("Runtime.executionContextsCleared", {});
    }
  }

  /** The screencasting channel whose parameters Chromium's cast uses, with them. */
  #deciding(): readonly [ElectronCdpChannel, Record<string, unknown> | undefined] | undefined {
    const owners = [...this.#screencastOwners];
    return owners.findLast(([owner]) => owner.role === "platform") ?? owners.at(-1);
  }

  #updateThrottling(): void {
    if (this.#closed || this.#webContents.isDestroyed()) return;
    const demanded =
      [...this.#channels].some((channel) => channel.role === "agent") ||
      this.#screencastOwners.size > 0 ||
      this.#renderingOwners.size > 0;
    this.#setRenderingDemand(demanded);
  }

  #isAttached(): boolean {
    return !this.#webContents.isDestroyed() && this.#debugger.isAttached();
  }

  /** Only Runtime commands wait for the attachment to inventory execution contexts. */
  #command(method: string, parameters?: Record<string, unknown>): Promise<unknown> {
    const generation = this.#rendererGeneration;
    const gate = method.startsWith("Runtime.") ? this.#gate : null;
    if (!gate) return this.#dispatch(method, parameters);
    let dispatched: () => void = () => undefined;
    this.#holdCommandsUntil(
      new Promise<void>((resolve) => {
        dispatched = resolve;
      }),
    );
    return gate.then(() => {
      try {
        if (generation !== this.#rendererGeneration)
          throw new Error("Electron CDP renderer changed before command dispatch.");
        return this.#dispatch(method, parameters);
      } finally {
        dispatched();
      }
    });
  }

  #holdCommandsUntil(gate: Promise<void>): void {
    this.#gate = gate;
    void gate.then(() => {
      if (this.#gate === gate) this.#gate = null;
    });
  }

  #dispatch(method: string, parameters?: Record<string, unknown>): Promise<unknown> {
    if (this.#webContents.isDestroyed())
      return Promise.reject(new Error("Electron CDP target is closed."));
    if (this.#crashed && method !== "Page.reload" && method !== "Page.navigate")
      return Promise.reject(
        new Error("Electron browser page crashed; reload the page to continue."),
      );
    const command = Promise.withResolvers<unknown>();
    const input = method.startsWith("Input.");
    // Register before sendCommand: Electron may call input hooks synchronously.
    // Only the underlying response removes input exclusion, even after a
    // channel is disposed or the caller is rejected on renderer loss.
    const answered = input ? Promise.withResolvers<void>() : null;
    if (answered) this.#outstandingInput.add(answered.promise);
    this.#pending.add(command.reject);
    const settle = () => {
      if (!answered) return;
      this.#outstandingInput.delete(answered.promise);
      answered.resolve();
    };
    const completed = () => this.#pending.delete(command.reject);
    void command.promise.then(completed, completed);
    try {
      void this.#debugger.sendCommand(method, parameters).then(
        (result) => {
          settle();
          command.resolve(result);
        },
        (error: unknown) => {
          settle();
          command.reject(error);
        },
      );
    } catch (error) {
      settle();
      command.reject(error);
    }
    return command.promise;
  }

  #interrupt(error: Error): void {
    this.#rendererGeneration += 1;
    this.#inputReady = null;
    this.#gate = null;
    for (const reject of this.#pending) reject(error);
    this.#pending.clear();
  }

  #assertCurrent(generation: number): void {
    if (generation !== this.#rendererGeneration)
      throw new Error("Electron CDP renderer changed before command dispatch.");
  }

  /**
   * Changes a channel's subscription to one domain after the shared-state
   * changes before it. Until it completes, the channel's later commands of
   * that domain wait for it, so none reaches Chromium ahead of it.
   */
  #changeDomain<T>(
    channel: ElectronCdpChannel,
    domain: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = this.#serializeOwnership(operation);
    const completed = result.then(
      () => undefined,
      () => undefined,
    );
    channel.domainChanges.set(domain, completed);
    void completed.then(() => {
      if (channel.domainChanges.get(domain) === completed) channel.domainChanges.delete(domain);
    });
    return result;
  }

  /**
   * Runs one shared-state change after the ones before it. When none is
   * pending it starts at once, so its command keeps its place among commands
   * issued after it. A fenced change is refused once the renderer changes
   * before its turn; a release is not, since it only lets go.
   */
  #serializeOwnership<T>(operation: () => Promise<T>, fenced = true): Promise<T> {
    const generation = this.#rendererGeneration;
    const run = () => {
      if (fenced && generation !== this.#rendererGeneration)
        throw new Error("Electron CDP renderer changed before command dispatch.");
      return operation();
    };
    const result = this.#ownershipPending === 0 ? run() : this.#ownershipTail.then(run, run);
    this.#ownershipPending += 1;
    this.#ownershipTail = result.then(
      () => {
        this.#ownershipPending -= 1;
      },
      () => {
        this.#ownershipPending -= 1;
      },
    );
    return result;
  }
}

class ElectronCdpChannel implements CdpSession, CdpChannel {
  /** This channel's domain enables and disables that have not completed. */
  readonly domainChanges = new Map<string, Promise<void>>();
  readonly enabledDomains = new Set<string>();
  readonly role: ChannelRole;
  readonly #events = new EventEmitter();
  readonly #hub: ElectronDebuggerHub;
  #closed = false;

  constructor(hub: ElectronDebuggerHub, role: ChannelRole) {
    this.#hub = hub;
    this.role = role;
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    return this.#hub.release(this);
  }

  detach(): Promise<void> {
    return this.close();
  }

  retainRendering(): () => void {
    return this.#hub.retainRendering(this);
  }

  send<Result = unknown>(method: string, parameters?: Record<string, unknown>): Promise<Result> {
    if (this.#closed) return Promise.reject(new Error("CDP channel is closed."));
    return this.#hub.send(this, method, parameters) as Promise<Result>;
  }

  onEvent(listener: (method: string, parameters: CdpParameters) => void): () => void {
    this.#events.on("event", listener);
    return () => this.#events.off("event", listener);
  }

  on(event: string, listener: (parameters: unknown) => void): void {
    this.#events.on(event, listener);
  }

  off(event: string, listener: (parameters: unknown) => void): void {
    this.#events.off(event, listener);
  }

  emit(method: string, parameters: CdpParameters): void {
    if (this.#closed) return;
    this.#events.emit("event", method, parameters);
    this.#events.emit(method, parameters);
  }

  clearListeners(): void {
    this.#events.removeAllListeners();
  }
}

class ElectronBrowserCdpBackend implements BrowserCdpBackend {
  readonly #context: ElectronBrowserContext;
  readonly #listeners = new Set<(method: string, parameters: CdpParameters) => void>();
  readonly #removeTargetListener: () => void;
  #closed = false;

  constructor(context: ElectronBrowserContext) {
    this.#context = context;
    this.#removeTargetListener = context.onTargetEvent((method, parameters) => {
      for (const listener of this.#listeners) listener(method, parameters);
    });
  }

  async attach(targetId: string): Promise<CdpChannel> {
    this.#assertOpen();
    const page = await this.#context.pageByTargetId(targetId);
    if (!page) throw new Error("CDP target is not an attachable page in this Profile Host.");
    return page.agentCdp();
  }

  onEvent(listener: (method: string, parameters: CdpParameters) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async send(method: string, parameters: CdpParameters = {}): Promise<unknown> {
    this.#assertOpen();
    if (method === "Target.getBrowserContexts") {
      return { browserContextIds: ["opensteer-electron-profile"] };
    }
    if (method === "Target.getTargets") return { targetInfos: await this.#context.targetInfos() };
    if (method === "Target.createTarget") {
      const requestedContext = parameters.browserContextId;
      if (requestedContext !== undefined && requestedContext !== "opensteer-electron-profile") {
        throw new Error("CDP target requested another browser context.");
      }
      const url = typeof parameters.url === "string" ? parameters.url : "about:blank";
      if (!isAllowedBrowserNavigation(url)) {
        throw new Error("Electron browser navigation scheme is not allowed.");
      }
      const page = (await this.#context.createPage()) as ElectronBrowserPage;
      const targetId = await page.targetId();
      // As CDP's own createTarget does, the tab loads in the background; a
      // failed load stays visible in the tab.
      if (url !== "about:blank") void page.loadInitialUrl(url).catch(() => undefined);
      return { targetId };
    }
    const targetId = typeof parameters.targetId === "string" ? parameters.targetId : null;
    if (method === "Target.getTargetInfo") {
      if (!targetId) throw new Error("Target.getTargetInfo requires targetId.");
      const page = await this.#context.pageByTargetId(targetId);
      if (!page) throw new Error("CDP target does not exist in this Profile Host.");
      return { targetInfo: await page.targetInfo() };
    }
    if (method === "Target.closeTarget") {
      if (!targetId) throw new Error("Target.closeTarget requires targetId.");
      const page = await this.#context.pageByTargetId(targetId);
      if (!page) throw new Error("CDP target does not exist in this Profile Host.");
      await page.close();
      return { success: true };
    }
    if (method === "Browser.getVersion") {
      const page = this.#context.pages()[0] as ElectronBrowserPage | undefined;
      if (!page) throw new Error("Electron profile has no page target.");
      const channel = await page.agentCdp();
      try {
        return await channel.send(method, { ...parameters });
      } finally {
        await channel.close();
      }
    }
    throw new Error(`${method} is unavailable at Electron browser scope.`);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#removeTargetListener();
    this.#listeners.clear();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Electron browser CDP backend is closed.");
  }
}

async function loadStorageOrigin(contents: WebContents, origin: string): Promise<void> {
  const url = new URL("/.opensteer-profile-state", `${origin}/`);
  await contents.loadURL(url.toString());
}

async function executeStorageOperation(
  contents: WebContents,
  operation: "collect" | "restore",
  state?: BrowserOriginState,
): Promise<Omit<BrowserOriginState, "origin">> {
  const input = state
    ? { indexedDB: state.indexedDB ?? [], localStorage: state.localStorage }
    : undefined;
  const code = `(${browserStorageOperation.toString()})(${JSON.stringify(operation)}, ${JSON.stringify(input)})`;
  return (await contents.executeJavaScriptInIsolatedWorld(
    storageWorldId,
    [{ code, url: "opensteer://browser-profile-storage" }],
    false,
  )) as Omit<BrowserOriginState, "origin">;
}

/** Settles every task before rethrowing the first failure, so none outlives the call. */
async function joined(tasks: readonly Promise<unknown>[]): Promise<void> {
  const failure = (await Promise.allSettled(tasks)).find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
}

/** Restoring a site with no storage changes nothing, so it is neither restored nor kept. */
function holdsStorage(state: BrowserOriginState): boolean {
  return state.localStorage.length > 0 || (state.indexedDB?.length ?? 0) > 0;
}

function httpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function isAllowedBrowserNavigation(value: string, popup = false): boolean {
  if (value === "about:blank") return true;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:" || (popup && protocol === "blob:");
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
