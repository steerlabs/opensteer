import {
  SessionCdpRouterError,
  cdpProfileRefusal,
  contextScopedCdpMethods,
  CdpProductIsolation,
  type CdpProfileRefusal,
  ExecutionContextInventory,
  type BrowserCdpBackend,
  type CdpChannel,
  type CdpParameters,
} from "@opensteer/browser-core";
import { type BrowserCookie } from "@opensteer/browser-profile";
import {
  BrowserPaintTimeoutError,
  BrowserRuntimeError,
  pageViewport,
  pageWithTarget,
  normalizeElectronCursor,
  siteCookieReplacementBatch,
  viewportCapturePlan,
  viewportImageScript,
  type BrowserContext,
  type BrowserLauncher,
  type BrowserLaunchRequest,
  type BrowserPage,
  type BrowserPartitionKey,
  type BrowserRendererUsage,
  type RendererExit,
  type PageGoneCause,
  type RendererGoneCause,
  type CdpSession,
  type EngineClipboard,
  type HumanInputObservation,
  type LaunchedBrowser,
  type LocalProfileEngine,
  type PageCapture,
  type PageGeometry,
  type Viewport,
  type ViewportCapture,
  type ViewportCaptureRequest,
} from "@opensteer/browser-runtime-core";
import {
  browserPageDisabledBlinkFeatures,
  browserPagePolicyScriptFor,
} from "@opensteer/browser-runtime-core/page-policy";
import { withTimeout } from "@opensteer/shared/withTimeout";
import {
  app,
  ipcMain,
  BaseWindow,
  session as electronSession,
  screen,
  webContents,
  WebContentsView,
  type BrowserWindowConstructorOptions,
  type Debugger,
  type NativeImage,
  type Session,
  type WebContents,
  type WebPreferences,
} from "electron";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { desktopBrowserAppShortcut } from "../app/application-menu.js";
import type { DesktopDownloads } from "../downloads/desktop-downloads.js";
import { boundPageRestore, ElectronPageRestoreSchema, WakeSeeds } from "./page-restore.js";
import {
  applyBrowserSessionPolicy,
  bindBrowserSessionRequestGate,
  browserAcceptLanguages,
  browserIdentity,
  chromeUserAgent,
  updateBrowserPasskeyPolicy,
  type BrowserIdentity,
  type BrowserSessionRequestGate,
} from "./browser-session-policy.js";
import {
  acquireElectronLocalProfile,
  createEmptySessionCookieMirror,
  electronSessionCookieCommand,
  releaseElectronLocalProfile,
  requireElectronLocalProfiles,
  type ElectronLocalProfile,
  type ElectronLocalProfileDiagnostic,
} from "./electron-local-profile.js";

import type { BrowserPagePolicyConfig } from "@opensteer/browser-runtime-core/page-policy";
import {
  createPasskeyProviderConfig,
  PasskeyBridge,
} from "@opensteer/browser-runtime-core/passkey-bridge";
import type { PasskeyAuthenticator } from "@opensteer/browser-runtime-core/passkeys";

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
    | "blank-navigation-submitted"
    | "blank-loaded"
    | "renderer-ready"
    | "page-announced"
    | "first-page-created";
  /** Cumulative time from local launch; preparation and the real open share this clock. */
  readonly elapsedMs: number;
}

type PageOpenTiming = (stage: ElectronLocalProfileOpenTiming["stage"]) => void;
const paintWaitMs = 5_000;
const placementWaitMs = 5_000;
const pageCloseGraceMs = 1_000;
/** A raw target is looked up briefly; the router reports a miss rather than waiting on it. */
const targetLookupMs = 5_000;
const pageDestroyMs = 500;

/** Why an agent's CPU profile was refused, for the Home's own log and never the agent. */
export type ElectronProfileRefusal = CdpProfileRefusal | "page-changed";

interface ElectronBrowserLauncherOptions {
  readonly onPageCleanupFailure?: (() => void) | undefined;
  readonly onProfileRefused?: ((reason: ElectronProfileRefusal) => void) | undefined;
  readonly onLocalProfileOpenTiming?: (timing: ElectronLocalProfileOpenTiming) => void;
  readonly onLocalProfileDiagnostic?: (diagnostic: ElectronLocalProfileDiagnostic) => void;
  readonly authenticator?: PasskeyAuthenticator;
  readonly clipboard?: EngineClipboard;
  readonly downloads: Pick<DesktopDownloads, "accept"> & Partial<Pick<DesktopDownloads, "active">>;
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
  readonly hostCost = "partition";
  readonly #wakeSeeds: WakeSeeds;
  readonly #methods = new Map<number, string>();
  readonly #uploads = new Map<number, number>();
  readonly #authenticator: PasskeyAuthenticator | undefined;
  readonly #clipboard: EngineClipboard | undefined;
  readonly #downloads: ElectronBrowserLauncherOptions["downloads"];
  readonly #configuredSessions = new WeakSet<Session>();
  readonly #pagePolicyPreloadPath: string;
  readonly #views: ElectronBrowserViewPool;
  readonly #localProfileRoot: string | undefined;
  readonly #onPageCleanupFailure: ElectronBrowserLauncherOptions["onPageCleanupFailure"];
  readonly #onProfileRefused: ElectronBrowserLauncherOptions["onProfileRefused"];
  readonly #onLocalProfileOpenTiming: ElectronBrowserLauncherOptions["onLocalProfileOpenTiming"];
  readonly #onLocalProfileDiagnostic: ElectronBrowserLauncherOptions["onLocalProfileDiagnostic"];
  readonly localProfiles: LocalProfileEngine = {
    engine: "electron",
    release: releaseElectronLocalProfile,
    createFiles: async (directory, binding, signal) => {
      await requireElectronLocalProfiles();
      signal.throwIfAborted();
      await createEmptySessionCookieMirror(directory, binding, signal);
    },
  };
  #preparation: Promise<void> | undefined;
  #nativeProfilesAvailable = false;

  get nativeProfilesAvailable(): boolean {
    return this.#nativeProfilesAvailable;
  }

  rendererUsage(): BrowserRendererUsage {
    const owned = this.#views.contents();
    const ownPids = new Set<number>();
    const assignedPids = new Set<number>();
    for (const contents of new Set([...webContents.getAllWebContents(), ...owned])) {
      if (contents.isDestroyed()) continue;
      for (const frame of contents.mainFrame?.framesInSubtree ?? []) {
        if (frame.isDestroyed()) continue;
        const pid = frame.osProcessId;
        if (pid <= 0) continue;
        assignedPids.add(pid);
        if (owned.has(contents)) ownPids.add(pid);
      }
    }

    const measured = new Map<number, number | null>();
    let unassignedProcesses = 0;
    for (const { type, pid, memory } of app.getAppMetrics()) {
      if (type !== "Tab" || pid <= 0 || measured.has(pid)) continue;
      const resident = ownPids.has(pid)
        ? (memory?.workingSetSize ?? (process.platform === "linux" ? linuxRendererRss(pid) : null))
        : null;
      measured.set(pid, resident && resident > 0 ? resident * 1024 : null);
      if (!assignedPids.has(pid)) unassignedProcesses++;
    }
    let total = 0;
    let count = 0;
    for (const pid of ownPids) {
      const resident = measured.get(pid);
      if (resident == null) continue;
      total += resident;
      count++;
    }
    const bytes = count > 0 && count === ownPids.size ? total : null;
    return { bytes, processes: ownPids.size, unassignedProcesses };
  }

  constructor(options: ElectronBrowserLauncherOptions) {
    if (!path.isAbsolute(options.pagePolicyPreloadPath)) {
      throw new TypeError("The browser page policy preload path must be absolute.");
    }
    // Contents that never see a session user agent (popups' first documents,
    // passkey pages, local-profile pages before their override lands) fall
    // back to the app default, so the default itself must not name the app
    // or Electron. The app's own service traffic is the opposite: device
    // lists label it "Opensteer app" from the Electron token, so the default
    // session keeps the branded agent explicitly.
    const brandedFallback = app.userAgentFallback;
    app.userAgentFallback = chromeUserAgent(brandedFallback);
    electronSession.defaultSession.setUserAgent(brandedFallback);
    this.#localProfileRoot = options.localProfileRoot;
    this.#onPageCleanupFailure = options.onPageCleanupFailure;
    this.#onProfileRefused = options.onProfileRefused;
    this.#onLocalProfileOpenTiming = options.onLocalProfileOpenTiming;
    this.#onLocalProfileDiagnostic = options.onLocalProfileDiagnostic;
    this.#authenticator = options.authenticator;
    this.#pagePolicyPreloadPath = options.pagePolicyPreloadPath;
    this.#clipboard = options.clipboard;
    this.#downloads = options.downloads;
    this.#views = new ElectronBrowserViewPool();
    this.#wakeSeeds = new WakeSeeds(ipcMain);
  }

  prepare(): Promise<void> {
    this.#preparation ??= (async () => {
      await app.whenReady();
      // Engine support is stable. Keychain availability is checked on each explicit acquisition.
      this.#nativeProfilesAvailable = true;
    })();
    return this.#preparation;
  }

  /** Cancels native work when the owning shutdown deadline expires. */
  close(): void {
    this.#wakeSeeds.close();
    this.#methods.clear();
    this.#uploads.clear();
    this.#views.close();
  }

  async launch(request: BrowserLaunchRequest, signal?: AbortSignal): Promise<LaunchedBrowser> {
    signal?.throwIfAborted();
    if (request.storage.kind === "local") {
      await requireElectronLocalProfiles();
      signal?.throwIfAborted();
      const started = performance.now();
      const timing: PageOpenTiming = (stage) =>
        this.#onLocalProfileOpenTiming?.({ stage, elapsedMs: performance.now() - started });
      const profile = acquireElectronLocalProfile({
        ...request.storage,
        root: this.#localProfileRoot,
        ...(this.#onLocalProfileDiagnostic ? { onDiagnostic: this.#onLocalProfileDiagnostic } : {}),
        configure: (session, gate) =>
          this.#configureSession(
            session,
            request.authenticator !== undefined || this.#authenticator !== undefined,
            gate,
          ),
      });
      timing("session-created");
      const sharedOwner = profile.hasContexts;
      let context: ElectronBrowserContext | undefined;
      const cancel = () => {
        if (sharedOwner) void context?.close().catch(() => undefined);
        else void profile.retire().catch(() => undefined);
      };
      const removeCancellation = () => signal?.removeEventListener("abort", cancel);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      try {
        await withTimeout(profile.ready(), 5_000, {
          ...(signal ? { signal } : {}),
          timeoutError: () => new Error("Browser profile restore timed out. Retry to reopen it."),
        });
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
        signal?.throwIfAborted();
        return browser;
      } catch (error) {
        removeCancellation();
        if (!sharedOwner)
          void profile
            .retire(signal?.aborted ? "cancelled" : "startup-failed", error)
            .catch(() => undefined);
        await context?.close().catch(() => undefined);
        throw error;
      }
    }
    const authenticator = request.authenticator ?? this.#authenticator;
    const partition = electronBrowserPartition(request.partitionKey);
    const profileSession = electronSession.fromPartition(partition, {
      cache: true,
    });
    this.#configureSession(profileSession, authenticator !== undefined);
    await Promise.all([profileSession.clearCache(), profileSession.clearStorageData()]);
    const context = new ElectronBrowserContext({
      wakeSeeds: this.#wakeSeeds,
      onPageCleanupFailure: this.#onPageCleanupFailure,
      onProfileRefused: this.#onProfileRefused,
      protection: (contents) => this.#protection(contents),
      createView: (options, opener) => this.#views.create(options, opener, request.initialViewport),
      createHelper: (options) => this.#views.createHelper(options),
      profileSession,
      ...(authenticator ? { authenticator } : {}),
    });
    try {
      // Guest begins on a blank page before it receives attach authority.
      await context.createPage();
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
    onPageTiming?: PageOpenTiming,
  ): ElectronBrowserContext {
    return new ElectronBrowserContext({
      wakeSeeds: this.#wakeSeeds,
      onPageCleanupFailure: this.#onPageCleanupFailure,
      onProfileRefused: this.#onProfileRefused,
      protection: (contents) => this.#protection(contents),
      createView: (options, opener, timing, startRenderer) =>
        this.#views.create(options, opener, viewport, timing, startRenderer),
      createHelper: (options) => this.#views.createHelper(options),
      profileSession,
      ...(authenticator ? { authenticator } : {}),
      ...(localProfile ? { localProfile } : {}),
      ...(onPageTiming ? { onPageTiming } : {}),
    });
  }

  #configureSession(
    profileSession: Session,
    provider: boolean,
    requestGate?: BrowserSessionRequestGate,
  ): void {
    if (requestGate) bindBrowserSessionRequestGate(profileSession, requestGate);
    if (this.#configuredSessions.has(profileSession)) {
      updateBrowserPasskeyPolicy(profileSession, provider);
      return;
    }
    applyBrowserSessionPolicy(profileSession, {
      acceptLanguages: browserAcceptLanguages(app.getPreferredSystemLanguages()),
      onMainFrameRequest: (id, method) => {
        if (this.#methods.has(id)) this.#methods.set(id, method);
      },
      onUploadRequest: (id, requestId) => {
        if (this.#methods.has(id)) this.#uploads.set(requestId, id);
      },
      onRequestFinished: (requestId) => this.#uploads.delete(requestId),
      provider,
      downloads: this.#downloads,
      pagePolicyPreloadPath: this.#pagePolicyPreloadPath,
      ...(requestGate ? { requestGate } : {}),
    });
    this.#configuredSessions.add(profileSession);
  }

  #protection(contents: WebContents) {
    this.#methods.set(contents.id, "GET");
    contents.once("destroyed", () => {
      this.#methods.delete(contents.id);
      for (const [requestId, id] of this.#uploads)
        if (id === contents.id) this.#uploads.delete(requestId);
    });
    return {
      method: () => this.#methods.get(contents.id) ?? "GET",
      uploading: () => [...this.#uploads.values()].includes(contents.id),
      downloading: () => this.#downloads.active?.(contents.id) === true,
    };
  }
}

function linuxRendererRss(pid: number): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    return Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1]) || null;
  } catch {
    // A renderer can exit between the census and the memory read.
    return null;
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
  readonly initialLoad?: Promise<void>;
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
  /**
   * The window this page is mounted in went out of sight. A parked page rests
   * in its own host so it still composites for a phone's Watch and an agent's
   * screencast; unparking puts it back where the window shows it.
   */
  setParked(parked: boolean): void;
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

// Electron's native disposal is scoped to this WebContents even when its
// renderer process is shared with another page.
function destroyWebContents(contents: WebContents): void {
  (contents as WebContents & { destroy(): void }).destroy();
}

class ElectronBrowserViewPool {
  #closed = false;
  readonly #views = new Map<WebContentsView, BaseWindow>();
  /**
   * Storage helpers never draw and live for one save or restore, at most
   * three at a time per profile, so they take no page slot: a save never
   * fails or crowds out pages because many pages are open.
   */
  readonly #helpers = new Set<WebContentsView>();

  contents(): ReadonlySet<WebContents> {
    return new Set(
      [...this.#views.keys(), ...this.#helpers].flatMap((view) =>
        view.webContents ? [view.webContents] : [],
      ),
    );
  }

  close(): void {
    this.#closed = true;
    for (const view of this.#views.keys()) {
      const contents = view.webContents;
      if (contents && !contents.isDestroyed()) destroyWebContents(contents);
    }
    for (const view of this.#helpers) {
      const contents = view.webContents;
      if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    }
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
    startRenderer = false,
  ): ElectronBrowserView {
    if (this.#closed) throw new Error("The Electron browser is stopping.");
    const view = new WebContentsView(options);
    timing?.("web-contents-view-created");
    const size = opener?.getBounds() ?? restingBounds;
    const bounds = { height: Math.round(size.height), width: Math.round(size.width) };
    let host: BaseWindow | null = null;
    let initialLoad: Promise<void> | undefined;
    try {
      if (startRenderer) {
        // The Session preload guards this blank before the page debugger attaches.
        initialLoad = view.webContents.loadURL("about:blank");
        timing?.("blank-navigation-submitted");
        void initialLoad.catch(() => undefined);
      }
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
    return { view, host: restingHost, ...(initialLoad ? { initialLoad } : {}) };
  }
}

type StorageCommand = (method: string, parameters?: Record<string, unknown>) => Promise<unknown>;

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
  #closedNotified = false;

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
        admit: async (signal) => {
          if (this.#closePromise) throw new Error("Electron browser profile is closed.");
          await localProfile.admit(signal);
          if (!this.#admitted) {
            lifecycle?.admitted();
            this.#admitted = true;
          }
        },
      };
    this.context = context;
    context.onClose(() => this.#notifyClosed());
    this.#profileSession = profileSession;
    this.cdp = new ElectronBrowserCdpBackend(context);
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
    this.#closePromise ??= this.#close().catch((error: unknown) => {
      this.#closePromise = null;
      throw error;
    });
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    const failures: unknown[] = [];
    await (this.cdp as ElectronBrowserCdpBackend).close().catch((error) => failures.push(error));
    try {
      await this.context.close();
      // Save only after the closing pages had their last chance to write.
      await (this.#localProfile
        ? this.#finalSave(this.#localProfile)
        : Promise.all([
            this.#profileSession.clearCache(),
            this.#profileSession.clearStorageData(),
          ]));
    } catch (error) {
      failures.push(error);
    } finally {
      this.#notifyClosed();
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(failures, "Electron browser close did not complete cleanly.");
  }

  async #finalSave(profile: ElectronLocalProfile): Promise<void> {
    if (!this.#admitted || profile.retired) return;
    let saving = true;
    try {
      await withTimeout(
        (async () => {
          await this.#profileSession.cookies.flushStore();
          if (saving && !profile.retired) await profile.mirror.flush();
        })(),
        5_000,
        { timeoutError: () => new Error("Browser profile final save timed out.") },
      );
    } catch (cause) {
      if (profile.retired) return;
      throw new BrowserRuntimeError(
        "conflict",
        "Browser profile storage is unavailable. The profile was preserved.",
        { cause, reason: "browser-profile-persistence-failed" },
      );
    } finally {
      saving = false;
    }
  }

  #notifyClosed(): void {
    if (this.#closedNotified) return;
    this.#closedNotified = true;
    this.#onProfileClose?.();
    this.#events.emit("close");
    this.#events.removeAllListeners();
  }
}

interface ElectronBrowserContextOptions {
  readonly onPageCleanupFailure?: (() => void) | undefined;
  readonly onProfileRefused?: ElectronBrowserLauncherOptions["onProfileRefused"];
  readonly wakeSeeds: WakeSeeds;
  readonly protection: (contents: WebContents) => {
    method(): string;
    uploading(): boolean;
    downloading(): boolean;
  };
  readonly authenticator?: PasskeyAuthenticator;
  readonly createView: (
    options: ElectronBrowserViewOptions,
    opener: WebContentsView | null,
    timing?: PageOpenTiming,
    startRenderer?: boolean,
  ) => ElectronBrowserView;
  readonly createHelper: (options: ElectronBrowserViewOptions) => WebContentsView;
  readonly profileSession: Session;
  readonly localProfile?: ElectronLocalProfile;
  readonly onPageTiming?: PageOpenTiming;
}

class ElectronBrowserContext implements BrowserContext {
  readonly #options: ElectronBrowserContextOptions;
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
  readonly #handOffs = new Set<(page: BrowserPage, opener: BrowserPage | null) => void>();
  readonly #profileSession: Session;
  readonly #localProfile: ElectronLocalProfile | undefined;
  readonly #untrack: (() => void) | undefined;
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #onPageTiming: PageOpenTiming | undefined;
  readonly #storageViews = new Set<WebContentsView>();
  readonly #displayChanged = () => {
    for (const page of this.#pages) page.displayChanged();
  };

  constructor(options: ElectronBrowserContextOptions) {
    this.#options = options;
    this.#authenticator = options.authenticator;
    this.#providerConfig = options.authenticator ? createPasskeyProviderConfig() : undefined;
    this.#createView = options.createView;
    this.#createHelper = options.createHelper;
    this.#profileSession = options.profileSession;
    this.#localProfile = options.localProfile;
    this.#onPageTiming = options.onPageTiming;
    this.#untrack = options.localProfile?.trackContext(() => this.close());
    screen.on("display-metrics-changed", this.#displayChanged);
    screen.on("display-added", this.#displayChanged);
    screen.on("display-removed", this.#displayChanged);
  }

  pages(): BrowserPage[] {
    return [...this.#pages].filter((page) => !page.isClosed());
  }

  async createPage(options?: {
    readonly restore?: unknown;
    readonly own?: (page: BrowserPage) => void;
  }): Promise<BrowserPage> {
    await this.#localProfile?.ready();
    this.#assertOpen();
    this.#localProfile?.assertAdmitted();
    const restore =
      options?.restore === undefined ? null : ElectronPageRestoreSchema.parse(options.restore);
    const timing = this.#onPageTiming;
    this.#onPageTiming = undefined;
    timing?.("page-create-started");
    const page = this.#newPage(
      null,
      {
        webPreferences: this.#securePreferences(restore !== null),
      },
      timing,
      restore === null && this.#localProfile !== undefined,
    );
    options?.own?.(page);
    try {
      // Electron needs a renderer to answer Page.enable. Start it while target
      // identity and ledger ownership are established; the real navigation may
      // supersede this blank load before it finishes.
      if (restore) {
        this.#options.wakeSeeds.offer(page.view.webContents, restore.sessionStorage);
        page.restoreHistory(restore.entries, restore.index);
      } else {
        const loading = page.initialLoad ?? page.loadInitialUrl("about:blank");
        if (this.#localProfile) {
          void loading.then(() => timing?.("blank-loaded")).catch(() => undefined);
        } else await loading;
      }
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

  handOff(listener: (page: BrowserPage, opener: BrowserPage | null) => void): () => void {
    this.#handOffs.add(listener);
    for (const page of this.#pages) if (!page.isClosed()) listener(page, page.openerPage);
    return () => this.#handOffs.delete(listener);
  }

  offPage(listener: (page: BrowserPage) => void): void {
    this.#events.off("page", listener);
  }

  onClose(listener: () => void): void {
    this.#events.on("close", listener);
  }

  onTargetEvent(listener: (method: string, parameters: CdpParameters) => void): () => void {
    this.#events.on("target", listener);
    return () => this.#events.off("target", listener);
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
      this.#withCookieTarget(deadline, async (command) => {
        // This target addresses the Session's complete jar without loading a document.
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

  close(): Promise<void> {
    this.#closePromise ??= this.#close().catch((error: unknown) => {
      this.#closePromise = undefined;
      throw error;
    });
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#events.emit("close");
      screen.off("display-metrics-changed", this.#displayChanged);
      screen.off("display-added", this.#displayChanged);
      screen.off("display-removed", this.#displayChanged);
      this.#events.removeAllListeners();
    }
    for (const view of this.#storageViews) {
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    }
    for (const page of this.#pages) page.endWithContext();
    const results = await Promise.allSettled([...this.#pages].map((page) => page.close()));
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(failures, "Electron browser pages failed to close.");
    this.#untrack?.();
  }

  /** A page asked to close is never found, and no page's target lookup delays another's. */
  pageByTargetId(targetId: string): Promise<ElectronBrowserPage | null> {
    return pageWithTarget(
      this.#pages,
      targetId,
      targetLookupMs,
      (page) => !page.isClosed() && !page.closeRequested,
    );
  }

  async targetInfos(): Promise<Record<string, unknown>[]> {
    return Promise.all(
      [...this.#pages].filter((page) => !page.isClosed()).map((page) => page.targetInfo()),
    );
  }

  #newPage(
    opener: ElectronBrowserPage | null,
    options: ElectronBrowserViewOptions,
    timing?: PageOpenTiming,
    startRenderer = false,
  ): ElectronBrowserPage {
    this.#assertOpen();
    const page = new ElectronBrowserPage(
      this.#createView(options, opener?.view ?? null, timing, startRenderer),
      opener,
      this.#authenticator,
      this.#providerConfig,
      timing,
      this.#options.protection,
      browserIdentity(this.#profileSession.getUserAgent(), {
        architecture: process.arch === "arm64" ? "arm" : process.arch === "x64" ? "x86" : "",
        bitness: process.arch === "arm64" || process.arch === "x64" ? "64" : "",
        platformVersion:
          process.platform === "darwin" && typeof process.getSystemVersion === "function"
            ? process.getSystemVersion()
            : "",
        fullVersion: process.versions.chrome,
      }),
      browserAcceptLanguages(app.getPreferredSystemLanguages()),
      this.#options.onPageCleanupFailure,
      this.#options.onProfileRefused,
    );
    this.#pages.add(page);
    for (const listener of this.#handOffs) listener(page, opener);
    page.onClose(() => {
      this.#pages.delete(page);
      void page
        .targetId()
        .then((targetId) => {
          this.#events.emit("target", "Target.targetDestroyed", { targetId });
        })
        .catch(() => undefined);
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
      popup.openedInBackground = details.disposition === "background-tab";
      if (popup.openedInBackground && !popupOptions.webContents) {
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

  #securePreferences(wake = false): WebPreferences {
    return {
      additionalArguments: [
        ...(wake ? ["--opensteer-wake"] : []),
        ...(this.#providerConfig
          ? [`--opensteer-passkey-provider=${JSON.stringify(this.#providerConfig)}`]
          : []),
      ],
      allowRunningInsecureContent: false,
      autoplayPolicy: "document-user-activation-required",
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

  async #withCookieTarget<T>(
    deadline: AbortSignal,
    operation: (command: StorageCommand) => Promise<T>,
  ): Promise<T> {
    await this.#localProfile?.ready();
    this.#assertOpen();
    deadline.throwIfAborted();
    const view = this.#createHelper({ webPreferences: this.#securePreferences() });
    this.#storageViews.add(view);
    const contents = view.webContents;
    const inspector = contents.debugger;
    const command: StorageCommand = (method, parameters) => {
      deadline.throwIfAborted();
      return withTimeout(
        electronSessionCookieCommand(this.#profileSession, method, () =>
          inspector.sendCommand(method, parameters),
        ),
        5_000,
        { signal: deadline, timeoutError: () => new Error("Browser cookie operation timed out.") },
      );
    };
    try {
      // Cookie commands need this exact Session, without a renderer or website request.
      inspector.attach("1.3");
      return await operation(command);
    } finally {
      this.#storageViews.delete(view);
      if (!contents.isDestroyed()) {
        const destroyed = new Promise<void>((resolve) =>
          contents.once("destroyed", () => resolve()),
        );
        contents.close({ waitForBeforeUnload: false });
        await withTimeout(destroyed, 2_000, {
          timeoutError: () => new Error("Browser cookie target did not close."),
        });
      }
    }
  }

  #assertOpen(): void {
    this.#localProfile?.assertReady();
    if (this.#closed) throw new Error("Electron browser profile is closed.");
  }
}

class ElectronBrowserPage implements BrowserPage, ElectronPagePresentation {
  readonly #protection: { method(): string; uploading(): boolean; downloading(): boolean };
  #documentMethod = "GET";
  #mediaPlaying = false;
  #restore: Promise<void> | undefined;
  #cursor: import("@opensteer/protocol/browser").BrowserCursor = "default";
  readonly #cursorListeners = new Set<
    (cursor: import("@opensteer/protocol/browser").BrowserCursor | null) => void
  >();
  readonly cursor = {
    read: () => (this.#mount ? "default" : this.#cursor),
    subscribe: (
      listener: (cursor: import("@opensteer/protocol/browser").BrowserCursor | null) => void,
    ) => {
      this.#cursorListeners.add(listener);
      return () => {
        this.#cursorListeners.delete(listener);
      };
    },
  };
  #invalidateCursor(): void {
    this.#cursor = "default";
    for (const listener of this.#cursorListeners) listener(null);
  }

  readonly initialLoad: Promise<void> | undefined;
  readonly view: WebContentsView;
  /**
   * Kept from creation: a destroyed view no longer exposes its WebContents,
   * and closing a page still needs it to remove listeners and report closed.
   */
  readonly #webContents: WebContents;
  readonly #onPageCleanupFailure: (() => void) | undefined;
  #closePromise: Promise<void> | undefined;
  /** The main frame's renderer when the page was asked to close; a destroyed page cannot say. */
  #rendererPid = 0;
  /** The page whose script opened this one, known from creation. */
  get openerPage(): ElectronBrowserPage | null {
    return this.#opener;
  }
  /** A close was asked for; the page may still exist until `destroyed`. */
  get closeRequested(): boolean {
    return this.#closeRequested;
  }
  /** Set by the first close and never cleared: a page asked to close never returns to service. */
  #closeRequested = false;
  /** Its context is ending, so its end is the context's, not the page's own. */
  #contextEnding = false;
  readonly #goneListeners = new Map<(cause?: PageGoneCause) => void, () => void>();
  endWithContext(): void {
    this.#contextEnding = true;
  }
  #passkeyBridge: PasskeyBridge | undefined;
  readonly #hub: ElectronDebuggerHub;
  readonly #opener: ElectronBrowserPage | null;
  openedInBackground = false;
  readonly #cdpPromise: Promise<CdpSession>;
  #dialog: unknown = null;
  #targetIdPromise: Promise<string> | null = null;
  readonly #passkeyInput = new Set<() => void>();
  readonly #humanInput = new Set<(observation: HumanInputObservation) => void>();
  #frameWorld: number | null = null;
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
  #parked = false;
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
    attached: boolean;
    onPlaced: (placement: NativePlacement) => void;
    dispose(): void;
  } | null = null;

  constructor(
    { view, host, initialLoad }: ElectronBrowserView,
    opener: ElectronBrowserPage | null,
    authenticator?: PasskeyAuthenticator,
    providerConfig?: BrowserPagePolicyConfig,
    timing?: PageOpenTiming,
    protection: ElectronBrowserContextOptions["protection"] = () => ({
      method: () => "GET",
      uploading: () => false,
      downloading: () => false,
    }),
    identity?: BrowserIdentity,
    acceptLanguage?: string,
    onPageCleanupFailure?: () => void,
    onProfileRefused?: ElectronBrowserLauncherOptions["onProfileRefused"],
  ) {
    this.view = view;
    this.initialLoad = initialLoad;
    this.#restingHost = host;
    this.#webContents = view.webContents;
    this.#onPageCleanupFailure = onPageCleanupFailure;
    this.#protection = protection(view.webContents);
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
    // A fromPath (local profile) session's user agent never reaches its
    // contents in Electron 44, so present the session identity per page. The
    // metadata must accompany the string: without it Chromium empties
    // navigator.userAgentData while the wire still carries client hints.
    // Pages whose debugger the passkey bridge owns attach during bootstrap,
    // after this point, so the identity is applied again once it resolves;
    // until then the app fallback covers these pages.
    let identityApplied = false;
    const applyIdentity = () => {
      if (identityApplied || !identity || !inspector.isAttached()) return;
      identityApplied = true;
      void inspector
        .sendCommand("Emulation.setUserAgentOverride", {
          userAgent: identity.userAgent,
          ...(identity.userAgentMetadata ? { userAgentMetadata: identity.userAgentMetadata } : {}),
          ...(acceptLanguage ? { acceptLanguage } : {}),
        })
        .catch(() => undefined);
    };
    applyIdentity();
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
      onProfileRefused,
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
    void platform.then(applyIdentity, () => undefined);
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
    view.webContents.on("cursor-changed", (_event, type) => {
      this.#cursor = normalizeElectronCursor(type);
      for (const listener of this.#cursorListeners) listener(this.#mount ? null : this.#cursor);
    });
    view.webContents.on("before-mouse-event", (_event, mouse) => {
      // Native and injected input cannot be disambiguated while a local view
      // is mounted. Remote hints remain default until native viewing ends.
      if (this.#mount || !this.inputOutstanding()) this.#invalidateCursor();
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
      if (this.#mount || !this.inputOutstanding()) this.#invalidateCursor();
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
      this.#documentMethod = this.#protection.method();
      this.#mediaPlaying = false;
      this.#invalidateCursor();
      void this.invalidateSurface().catch(() => undefined);
    });
    view.webContents.on("media-started-playing", () => {
      this.#mediaPlaying = true;
    });
    view.webContents.on("media-paused", () => {
      this.#mediaPlaying = false;
    });
    view.webContents.on("render-process-gone", () => {
      this.#invalidateCursor();
      // The hub rejects placement while crashed; navigation can recover it.
      this.#cancelPaint("crash");
      this.#fullscreen = false;
      this.#mediaPlaying = false;
      this.#contextMenuTrigger = null;
      this.#contextMenuCandidate = null;
    });
    view.webContents.once("destroyed", () => {
      this.#cancelPaint();
      this.#passkeyInput.clear();
      this.#humanInput.clear();
      this.#invalidateCursor();
      this.#cursorListeners.clear();
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
    this.#endPaintSubscription();
  }

  /** The same placement and parent the apply path would choose, already in place. */
  #placementCurrent(): boolean {
    return (
      (!this.#mount || this.#parked || this.#mount.attached) &&
      this.#appliedSurfaceRevision === this.#surfaceRevision &&
      JSON.stringify(this.#desiredPlacement) === JSON.stringify(this.#placement())
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
    const deadline = performance.now() + paintWaitMs;
    const canceled =
      signal && lifecycle ? AbortSignal.any([signal, lifecycle]) : (signal ?? lifecycle);
    for (;;) {
      const epoch = this.#surfaceAbort.signal;
      const pending = canceled ? AbortSignal.any([canceled, epoch]) : epoch;
      try {
        // Cancellation never waits for a renderer command.
        if (this.#serializeGeometry)
          void this.#readyPlacement(pending).catch((error: unknown) => {
            if (!pending.aborted)
              for (const waiter of this.#paintWaiters)
                waiter.reject(error instanceof Error ? error : new Error(String(error)));
          });
        await this.#paint(pending, deadline);
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
      this.#paintWaiters.size === 0 ||
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
    this.#endPaintSubscription();
    this.#frameSubscriptionRevision = revision;
    const scale = this.#displayScale();
    this.#webContents.beginFrameSubscription((image) => {
      if (
        this.#frameSubscriptionRevision !== revision ||
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
      for (const waiter of this.#paintWaiters) waiter.resolve();
    });
  }

  #endPaintSubscription(): void {
    if (this.#frameSubscriptionRevision === null) return;
    this.#frameSubscriptionRevision = null;
    if (!this.isClosed()) this.#webContents.endFrameSubscription();
  }

  #paint(signal: AbortSignal, deadline: number): Promise<void> {
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
      const remaining = deadline - performance.now();
      if (remaining <= 0)
        throw new BrowserPaintTimeoutError("Electron browser paint wait timed out.");
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#paintWaiters.delete(waiter);
        signal.removeEventListener("abort", abort);
        if (this.#paintWaiters.size === 0) this.#endPaintSubscription();
        this.#syncRenderingDemand();
        if (error) reject(error);
        else resolve();
      };
      const abort = () => settle(new Error("Electron browser paint wait was canceled."));
      const waiter = {
        resolve: () => settle(),
        reject: (error: Error) => settle(error),
      };
      const timer = setTimeout(
        () => settle(new BrowserPaintTimeoutError("Electron browser paint wait timed out.")),
        remaining,
      );
      timer.unref();
      this.#paintWaiters.add(waiter);
      this.#syncRenderingDemand();
      signal.addEventListener("abort", abort, { once: true });
      try {
        this.#subscribePaint();
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
      }
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
    this.#endPaintSubscription();
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
    this.#invalidateCursor();
    const displayChanged = () => this.displayChanged();
    window.on("resize", displayChanged);
    window.on("move", displayChanged);
    // The view stays in its resting host until placement moves it here: it
    // keeps resting bounds until then, and placement can wait on agent work.
    this.#parked = false;
    this.#mount = {
      window,
      stage: { ...stage },
      followsPerson: window.isFocused(),
      attached: false,
      onPlaced,
      dispose: () => {
        window.off("resize", displayChanged);
        window.off("move", displayChanged);
      },
    };
    this.#invalidateAppliedSurface();
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

  setParked(parked: boolean): void {
    if (this.isClosed() || this.#parked === parked) return;
    this.#parked = parked;
    const mount = this.#mount;
    if (!mount) return;
    if (parked && mount.attached && !this.#restingHost.isDestroyed()) {
      mount.attached = false;
      this.#cancelPaint("reparent");
      const { width, height } = this.view.getBounds();
      this.#resizeRestingHost({ width, height });
      this.view.setBorderRadius(0);
      this.#restingHost.contentView.addChildView(this.view);
      this.view.setBounds({ ...this.#placement().bounds, width, height });
      this.#syncRenderingDemand();
    }
    // Unparking returns the view to the window through the one apply path.
    void this.#reconcile().catch(() => undefined);
  }

  #placement(): NativePlacement {
    const placement = nativePlacement(this.#mount, this.#geometry);
    return this.#parked ? { ...placement, bounds: { ...placement.bounds, x: 0, y: 0 } } : placement;
  }

  unmount(): void {
    if (!this.#mount) return;
    this.#parked = false;
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

  keepAwake(): import("@opensteer/browser-runtime-core").KeepAwakeReason | null {
    if (this.#protection.uploading()) return "upload";
    if (!["GET", "HEAD"].includes(this.#documentMethod)) return "post";
    if (this.#protection.downloading()) return "download";
    if (this.#webContents.isCurrentlyAudible() || this.#mediaPlaying) return "media";
    if (this.#fullscreen) return "fullscreen";
    if (this.#webContents.isBeingCaptured()) return "capturing";
    return null;
  }

  hasOpenerAccess(): boolean {
    return this.#webContents.opener !== null;
  }

  restoreHistory(
    entries: z.infer<typeof ElectronPageRestoreSchema>["entries"],
    index: number,
  ): void {
    this.#restore = this.#webContents.navigationHistory.restore({
      entries: entries.map(({ url, title, pageState }) => ({
        url,
        title,
        ...(pageState === undefined ? {} : { pageState }),
      })),
      index,
    });
    void this.#restore.catch(() => this.close()).catch(() => undefined);
  }

  async captureRestore(): Promise<unknown | null> {
    const cdp = await this.cdp();
    const frame = z
      .object({ frameTree: z.object({ frame: z.object({ id: z.string() }) }) })
      .parse(await cdp.send("Page.getFrameTree"));
    const world = z.object({ executionContextId: z.number() }).parse(
      await cdp.send("Page.createIsolatedWorld", {
        frameId: frame.frameTree.frame.id,
        worldName: "opensteer-restore",
      }),
    );
    const result = z
      .object({
        result: z.object({ value: z.unknown().optional() }),
        exceptionDetails: z.unknown().optional(),
      })
      .parse(
        await cdp.send("Runtime.evaluate", {
          contextId: world.executionContextId,
          returnByValue: true,
          expression: `(() => {
        if (location.origin === 'null') return null;
        const items = [];
        let bytes = 0;
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          const value = sessionStorage.getItem(key);
          bytes += new TextEncoder().encode(JSON.stringify([key, value])).length;
          if (bytes > 262144) throw new Error('Session storage exceeds restore limit');
          items.push([key, value]);
        }
        return { origin: location.origin, items };
      })()`,
        }),
      );
    if (result.exceptionDetails) return null;
    return boundPageRestore({
      entries: this.#webContents.navigationHistory.getAllEntries(),
      index: this.#webContents.navigationHistory.getActiveIndex(),
      sessionStorage: ElectronPageRestoreSchema.shape.sessionStorage.parse(result.result.value),
    });
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
    const deadline = performance.now() + placementWaitMs;
    const wait = <T>(start: () => Promise<T>, epoch?: AbortSignal): Promise<T> => {
      const remaining = deadline - performance.now();
      const timeoutError = () =>
        new BrowserPaintTimeoutError("Electron browser geometry timed out.");
      if (remaining <= 0) throw timeoutError();
      const lifecycle = this.#paintLifecycle.signal;
      const signal = epoch ? AbortSignal.any([lifecycle, epoch]) : lifecycle;
      signal.throwIfAborted();
      return withTimeout(start(), remaining, { signal, timeoutError });
    };
    const cdp = await wait(() => this.cdp());
    this.#assertPlacementLive(owner);
    const release = cdp.retainRendering?.();
    try {
      do {
        this.#assertPlacementLive(owner);
        if (this.#dialog) return;
        let placement = this.#placement();
        const previous = this.view.getBounds();
        if (
          previous.width !== placement.bounds.width ||
          previous.height !== placement.bounds.height
        ) {
          const epoch = this.#surfaceAbort.signal;
          try {
            await wait(() => this.#beforeResize?.() ?? Promise.resolve(), epoch);
          } catch (error) {
            this.#assertPlacementLive(owner);
            if (epoch !== this.#surfaceAbort.signal) continue;
            throw error;
          }
          this.#assertPlacementLive(owner);
          if (epoch !== this.#surfaceAbort.signal) continue;
          if (this.#dialog) return;
          placement = this.#placement();
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
        }
        if (!this.#mount || this.#parked) this.#resizeRestingHost(bounds);
        // Reparenting moves the view without this pass: what it has is read, not assumed.
        const actual = this.view.getBounds();
        if (
          actual.x !== bounds.x ||
          actual.y !== bounds.y ||
          actual.width !== bounds.width ||
          actual.height !== bounds.height
        )
          this.view.setBounds(bounds);
        if (this.#mount && !this.#mount.attached && !this.#parked) {
          this.view.setBorderRadius(15);
          this.#mount.window.contentView.addChildView(this.view);
          this.#mount.attached = true;
          this.#syncRenderingDemand();
        }
        this.#mount?.onPlaced(placement);
        if (this.#appliedSurfaceRevision === this.#surfaceRevision) return;
        const revision = this.#surfaceRevision;
        const signal = this.#surfaceAbort.signal;
        const metrics = placement.emulation;
        if (!metrics && this.#metricsOverride === null) this.#metricsSurfaceRevision = revision;
        try {
          if (this.#boundsRevision !== this.#metricsBoundsRevision)
            await wait(() => cdp.send("Page.getLayoutMetrics"), signal);
          this.#assertPlacementLive(owner);
          if (signal.aborted) continue;
          if (metrics) {
            // A timed-out command can apply later. A subsequent non-emulated
            // placement must still ask Chromium to clear it.
            this.#metricsOverride = JSON.stringify(metrics);
            await wait(
              () => cdp.send("Emulation.setDeviceMetricsOverride", { ...metrics }),
              signal,
            );
          } else if (this.#metricsOverride !== null) {
            await wait(() => cdp.send("Emulation.clearDeviceMetricsOverride"), signal);
            this.#metricsOverride = null;
          }
          this.#assertPlacementLive(owner);
          if (signal.aborted) continue;
          this.#metricsSurfaceRevision = revision;
          await wait(() => cdp.send("Page.getLayoutMetrics"), signal);
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
    const owner = this.#mount?.attached ? this.#mount.window : this.#restingHost;
    return screen.getDisplayMatching(owner.getBounds()).scaleFactor;
  }

  #syncRenderingDemand(): void {
    if (this.isClosed() || this.#restingHost.isDestroyed()) return;
    const demanded = this.#renderingDemand || this.#paintWaiters.size > 0;
    this.#webContents.backgroundThrottling = !demanded;
    if (this.#mount?.attached) {
      if (this.#restingHost.isVisible()) this.#restingHost.hide();
    } else if (demanded && process.platform !== "linux") {
      if (!this.#restingHost.isVisible()) this.#restingHost.showInactive();
    } else if (this.#restingHost.isVisible()) this.#restingHost.hide();
  }

  /**
   * Copies the surface: unlike `Page.captureScreenshot`, this never resizes the
   * view, whatever its emulation. The bitmap is view DIPs at the display's
   * scale, whatever device scale factor a page emulates, cropped from the
   * top left when the view is smaller than the page.
   */
  async captureViewport({
    clip,
    format,
    layout,
    pageScale,
    quality,
    maxImageBytes,
  }: ViewportCaptureRequest): Promise<ViewportCapture> {
    const cdp = await this.cdp();
    const release = cdp.retainRendering?.();
    try {
      await this.#drawnFrame(cdp);
      const image = await this.#surfaceImage();
      const bounds = this.view.getBounds();
      const visible = {
        height: Math.round(bounds.height / pageScale),
        width: Math.round(bounds.width / pageScale),
      };
      const plan = viewportCapturePlan(image.getSize(), visible, clip);
      const { crop } = this.#desiredPlacement;
      const size = image.getSize();
      const x = Math.min(size.width - 1, Math.round(plan.source.x));
      const y = Math.min(size.height - 1, Math.round(plan.source.y));
      const picture = image
        .crop({
          x,
          y,
          width: Math.max(1, Math.min(size.width - x, Math.round(plan.source.width))),
          height: Math.max(1, Math.min(size.height - y, Math.round(plan.source.height))),
        })
        .resize({ ...plan.output, quality: "better" });
      return {
        data: await this.#encode(cdp, picture, format, quality, maxImageBytes),
        ...(crop.right || crop.bottom
          ? {
              cropped: {
                page: {
                  height: Math.round(layout.height / pageScale),
                  width: Math.round(layout.width / pageScale),
                },
                visible,
              },
            }
          : {}),
      };
    } finally {
      release?.();
    }
  }

  /** A world page scripts and agents never reach. */
  async #inFrameWorld(cdp: CdpSession, expression: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        this.#frameWorld ??= z.object({ executionContextId: z.number().int() }).parse(
          await cdp.send("Page.createIsolatedWorld", {
            frameId: await this.targetId(),
            worldName: "opensteer-frame",
          }),
        ).executionContextId;
        const { exceptionDetails, result } = z
          .object({
            exceptionDetails: z.unknown().optional(),
            result: z.object({ value: z.unknown().optional() }),
          })
          .parse(
            await cdp.send("Runtime.evaluate", {
              awaitPromise: true,
              contextId: this.#frameWorld,
              expression,
              returnByValue: true,
            }),
          );
        if (exceptionDetails) throw new Error("The page could not run a capture step.");
        return result.value;
      } catch (error) {
        // A navigation takes the world with it.
        this.#frameWorld = null;
        if (attempt > 0) throw error;
      }
    }
  }

  /** `capturePage` copies the last frame drawn, which can predate the page's latest change. */
  async #drawnFrame(cdp: CdpSession): Promise<void> {
    const frames =
      "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))";
    // A page that draws nothing has nothing newer to show.
    await withTimeout(this.#inFrameWorld(cdp, frames), 1_000, {
      timeoutError: () => new Error("No frame."),
    }).catch(() => undefined);
  }

  async #surfaceImage(): Promise<NativeImage> {
    const copy = () => this.#webContents.capturePage(undefined, { stayHidden: true });
    // Chromium fails one copy while a navigation swaps the surface.
    const image = await copy().catch(copy);
    if (image.isEmpty()) throw new Error("The page has no picture yet.");
    return image;
  }

  async #encode(
    cdp: CdpSession,
    image: NativeImage,
    format: ViewportCaptureRequest["format"],
    quality: number | undefined,
    maxImageBytes?: number,
  ): Promise<string> {
    const exceeds = () =>
      new BrowserRuntimeError("bad_message", "Screenshot exceeds its image budget.", {
        reason: "browser-reply-limit",
      });
    const bytes = format === "jpeg" ? image.toJPEG(quality ?? 80) : image.toPNG();
    if (format !== "webp" && maxImageBytes !== undefined && bytes.length > maxImageBytes)
      throw exceeds();
    const data = bytes.toString("base64");
    if (format !== "webp") return data;
    const size = image.getSize();
    const plan = { output: size, source: { x: 0, y: 0, ...size } };
    // nativeImage has no WebP encoder; the page's own does.
    const encoded = z
      .string()
      .nullable()
      .parse(
        await this.#inFrameWorld(
          cdp,
          viewportImageScript(data, plan, {
            format,
            ...(maxImageBytes === undefined ? {} : { maxImageBytes }),
            ...(quality === undefined ? {} : { quality }),
          }),
        ),
      );
    if (encoded === null) throw exceeds();
    return encoded;
  }

  loadInitialUrl(url: string): Promise<void> {
    if (!isAllowedBrowserNavigation(url)) {
      return Promise.reject(new Error("Electron browser navigation scheme is not allowed."));
    }
    return this.#webContents.loadURL(url);
  }

  cdp(): Promise<CdpSession> {
    return this.#cdpPromise;
  }

  agentCdp(): Promise<CdpSession> {
    return this.#hub.open("agent");
  }

  close(): Promise<void> {
    this.#closeRequested = true;
    this.#closePromise ??= this.#close().catch((error: unknown) => {
      this.#closePromise = undefined;
      throw error;
    });
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    if (this.#webContents.isDestroyed()) return;
    this.#passkeyBridge?.close();
    this.#webContents.stopFindInPage("clearSelection");
    this.#renderingDemand = false;
    this.unmount();
    this.#cancelPaint();
    this.#syncRenderingDemand();
    // Closing the page ends commands still waiting for that renderer.
    const cleanup = this.#hub.close().catch(() => this.#onPageCleanupFailure?.());
    await this.#disposeContents();
    await cleanup;
  }

  async #disposeContents(): Promise<void> {
    const contents = this.#webContents;
    if (contents.isDestroyed()) return;
    try {
      this.#rendererPid = contents.getOSProcessId();
    } catch {
      this.#rendererPid = 0;
    }
    const destroyed = Promise.withResolvers<void>();
    contents.once("destroyed", destroyed.resolve);
    try {
      try {
        contents.close({ waitForBeforeUnload: false });
        await withTimeout(destroyed.promise, pageCloseGraceMs, {
          timeoutError: () => new Error("Electron browser page didn't close."),
        });
      } catch {
        if (!contents.isDestroyed()) destroyWebContents(contents);
        await withTimeout(destroyed.promise, pageDestroyMs, {
          timeoutError: () => new Error("Electron browser page wasn't destroyed."),
        });
      }
    } finally {
      if (!contents.isDestroyed()) contents.off("destroyed", destroyed.resolve);
    }
  }

  /** The confirmation is the WebContents' own `destroyed`; a settled close or destroy call is not. */
  isClosed(): boolean {
    return this.#webContents.isDestroyed();
  }

  onClose(listener: (cause?: PageGoneCause) => void): void {
    if (this.#goneListeners.has(listener)) return;
    const destroyed = () => listener(this.#contextEnding ? "context" : "page");
    this.#goneListeners.set(listener, destroyed);
    this.#webContents.on("destroyed", destroyed);
  }

  onRendererGone(listener: (cause: RendererGoneCause) => void): () => void {
    const gone = (_event: unknown, details: Electron.RenderProcessGoneDetails) =>
      listener(details.reason === "clean-exit" ? "exited" : "crashed");
    this.#webContents.on("render-process-gone", gone);
    return () => this.#webContents.off("render-process-gone", gone);
  }

  rendererExit(): RendererExit | null {
    const pid = this.#rendererPid;
    if (pid <= 0) return null;
    if (!app.getAppMetrics().some((metric) => metric.pid === pid)) return "exited";
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      for (const frame of contents.mainFrame?.framesInSubtree ?? [])
        if (!frame.isDestroyed() && frame.osProcessId === pid) return "shared";
    }
    return "running";
  }

  offClose(listener: (cause?: PageGoneCause) => void): void {
    const destroyed = this.#goneListeners.get(listener);
    if (!destroyed) return;
    this.#goneListeners.delete(listener);
    this.#webContents.off("destroyed", destroyed);
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
    await this.#restore;
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

interface ProfileInventory {
  /** The agent channel whose Profiler.start opened it. */
  readonly channel: ElectronCdpChannel;
  readonly sessionId: string;
  readonly scripts: CdpProductIsolation;
  readonly isolate: string;
  readonly renderer: number;
  readonly context: number;
}

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
/** What the hub knows of one debugger session, which a new session knows nothing of. */
class DebuggerSessionState {
  /** For each session a cast can run in (the page's own is ""), the highest frame id Chromium sent. */
  readonly laneFrames = new Map<string, number>();
  /** For each, the starts Chromium has answered: its next cast's frames carry one more. */
  readonly laneStarts = new Map<string, number>();
  /**
   * The sessions the hub attached to this page for itself (cast sessions, profile inspections):
   * each is detached exactly once, on whatever path its use ends, and no channel sees it.
   */
  readonly ownSessions = new Set<string>();
  /** Every one of them in this debugger session: their events reach no channel. */
  readonly ownSessionsSeen = new Set<string>();
  /** The hub's own attaches Chromium has not answered. */
  ownAttaching = 0;
  /** Target events of the page's session that came while one was unanswered, in order. */
  held: { readonly method: string; readonly record: Record<string, unknown> }[] = [];
}

class ElectronDebuggerHub {
  readonly #channels = new Set<ElectronCdpChannel>();
  readonly #contexts = new ExecutionContextInventory();
  readonly #agentWorlds = new CdpProductIsolation();
  readonly #profileInspections = new Map<
    string,
    (method: string, parameters: CdpParameters) => void
  >();
  #profileContextGeneration = 0;
  /**
   * The page's scripts as they are parsed, from an agent's Profiler.start to
   * its stop, so a script the page ran and dropped meanwhile is still known.
   */
  #profileInventory: ProfileInventory | null = null;
  #profileInventoryOpening: Promise<unknown> | null = null;
  /** Each agent channel's Profiler.start under way; its later Profiler commands follow it. */
  readonly #profileStarts = new Map<ElectronCdpChannel, Promise<unknown>>();
  readonly #onProfileRefused: ElectronBrowserLauncherOptions["onProfileRefused"];
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
  readonly #renderingOwners = new Map<ElectronCdpChannel, number>();
  /**
   * The page's screencasts, one for each set of settings someone asked for (`castKey`): an owner
   * gets frames in the format and size it asked for, always, and owners who asked for the same
   * share one. At most `maxCastsPerPage` at once.
   */
  readonly #casts = new Set<Screencast>();
  /** Each screencasting channel's cast. */
  readonly #castOf = new Map<ElectronCdpChannel, Screencast>();
  /**
   * What each owner was handed, in order: which run's frame, by Chromium's frame `sessionId`. An
   * ack names only that id, and two runs in two sessions can share one, so this is what tells
   * which run an ack belongs to.
   */
  readonly #handed = new Map<
    ElectronCdpChannel,
    { readonly run: CastRun; readonly frame: number }[]
  >();
  #castStarts = 0;
  /**
   * What belongs to the debugger session now attached, and dies with it: made when the hub attaches
   * the debugger, discarded at every detach, the hub's own and Electron's (`#debuggerSessionEnded`).
   */
  #session = new DebuggerSessionState();
  readonly #webContents: WebContents;
  readonly #setRenderingDemand: (demanded: boolean) => void;
  readonly #prepareInput: () => Promise<void>;
  readonly #displayScale: () => number;
  #inputReady: Promise<void> | null = null;
  #deviceScaleFactor: number | null = null;
  /** Settles once the hub's own Runtime.enable has reported every context. */
  #attachment: Promise<void> | null = null;
  #closed = false;
  readonly #forcedDisposal = Promise.withResolvers<void>();
  #forced = false;
  #closePromise: Promise<void> | undefined;
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
    onProfileRefused?: ElectronBrowserLauncherOptions["onProfileRefused"],
  ) {
    this.#onProfileRefused = onProfileRefused;
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
    this.#debugger.on("message", (_event, method, parameters, sessionId) => {
      if (sessionId) {
        // A cast's private session runs only its cast: its frames are for that cast's owners alone.
        if (
          this.#session.ownSessionsSeen.has(sessionId) &&
          !this.#profileInspections.has(sessionId)
        ) {
          if (method === "Page.screencastFrame") this.#laneFrame(sessionId, asRecord(parameters));
          return;
        }
        const inspectProfile = this.#profileInspections.get(sessionId);
        if (inspectProfile) {
          // It skips every pause; should one arrive anyway, the page never waits on it.
          if (method === "Debugger.paused")
            void this.#debugger
              .sendCommand("Debugger.resume", {}, sessionId)
              .catch(() => undefined);
          inspectProfile(method, asRecord(parameters));
          return;
        }
        if (!this.#agentWorlds.observe(method, asRecord(parameters))) {
          if (method === "Debugger.paused")
            void this.#debugger
              .sendCommand("Debugger.resume", {}, sessionId)
              .catch(() => undefined);
          return;
        }
        for (const channel of this.#channels)
          if (channel.targetSessionId === sessionId) channel.emit(method, asRecord(parameters));
        return;
      }
      const record = asRecord(parameters);
      if (method === "Runtime.executionContextsCleared") {
        this.#profileContextGeneration++;
        // Its scripts belonged to documents that are gone; a stop reads what is alive then.
        if (this.#profileInventory) void this.#closeProfileInventory(this.#profileInventory);
      }
      // The hub's own sessions are no channel's: none hears of them, by their identity. While an
      // attach of the hub's own is unanswered, any Target event may be about it: every one waits,
      // in order, until the answer says which session is the hub's.
      if (method.startsWith("Target.") && this.#session.ownAttaching > 0) {
        this.#session.held.push({ method, record });
        return;
      }
      this.#targetOrPageEvent(method, record);
    });
    this.#debugger.on("detach", (_event, reason) => {
      // Every session it held is gone with it, the hub's own among them, and every cast.
      this.#castsEnded("detached");
      this.#debuggerSessionEnded();
      this.#interrupt(new Error(`Electron CDP debugger detached: ${reason}.`));
      this.#forgetContexts();
      this.#events.emit("detach", reason);
    });
    webContents.on("render-process-gone", (_event, details) => {
      this.#crashed = true;
      this.#castsEnded("crashed");
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
      // The latest frame was the last document's: no one is handed it now.
      this.#forgetLatestFrames();
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
    this.#attachDebugger();
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
    if (role === "agent")
      for (const context of this.#contexts.entries()) channel.observeContext(context.description);
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
    cleanup = false,
  ): Promise<unknown> {
    // A new size makes the latest frame the wrong shape for anyone who joins after it.
    if (method.startsWith("Emulation.set") || method === "Emulation.clearDeviceMetricsOverride")
      this.#forgetLatestFrames();
    const command = Promise.withResolvers<unknown>();
    this.#pending.add(command.reject);
    try {
      void this.#send(channel, method, parameters, cleanup).then(command.resolve, command.reject);
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
    cleanup = false,
  ): Promise<unknown> {
    if (channel.role === "agent" && method.startsWith("Profiler.") && method !== "Profiler.start") {
      // A command sent behind a Profiler.start reaches Chromium after it, as it was sent.
      const starting = this.#profileStarts.get(channel);
      if (starting)
        return starting.then(
          () => this.#send(channel, method, parameters, cleanup),
          () => this.#send(channel, method, parameters, cleanup),
        );
    }
    const sent = this.#route(channel, method, parameters, cleanup);
    if (channel.role !== "agent" || method !== "Profiler.disable") return sent;
    // Disabling the profiler ends its profile with no stop to classify.
    return sent.finally(() => {
      const live = this.#profileInventory;
      if (live?.channel === channel) void this.#closeProfileInventory(live);
    });
  }

  #route(
    channel: ElectronCdpChannel,
    method: string,
    parameters?: Record<string, unknown>,
    _cleanup = false,
  ): Promise<unknown> {
    const generation = this.#rendererGeneration;
    if (channel.role === "platform") this.#agentWorlds.observePlatformCommand(method, parameters);
    if (
      channel.role === "agent" &&
      !method.startsWith("Debugger.") &&
      method !== "Runtime.runScript" &&
      method !== "Page.removeScriptToEvaluateOnNewDocument"
    )
      this.#agentWorlds.assertCommand(method, parameters);
    const send = (method: string, parameters?: Record<string, unknown>) =>
      channel.role === "agent" && method === "Profiler.stop"
        ? this.#stopAgentProfile(channel, parameters)
        : channel.role === "agent" && method === "Profiler.start"
          ? this.#startAgentProfile(channel, parameters)
          : this.#command(method, parameters);
    if (channel.role === "agent" && method.startsWith("Target."))
      return this.#agentTargets(channel, method, parameters);
    if (this.#closed || !this.#channels.has(channel))
      return Promise.reject(new Error("CDP channel is closed."));
    if (
      channel.role === "agent" &&
      (method === "Page.bringToFront" || method === "Target.activateTarget")
    )
      return Promise.resolve({});
    // A first-document dialog can hold Runtime.enable or Page.enable. Its
    // answer releases those waits, so it must reach the browser ahead of them.
    if (method === "Page.handleJavaScriptDialog") return send(method, parameters);
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
    if (releasesInput) return send(method, parameters);
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
            .parse(await send("Page.getLayoutMetrics"));
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
        return send(method, parameters);
      });
    }
    if (method === "Page.startScreencast") {
      return this.#serializeOwnership(() => this.#startCast(channel, parameters, send));
    }
    if (method === "Page.stopScreencast") {
      return this.#serializeOwnership(async () => {
        await this.#leaveCast(channel, this.#rendererGeneration, parameters, true);
        return {};
      });
    }
    if (method === "Page.screencastFrameAck") return this.#ackCast(channel, parameters);
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
        if (owners.has(channel)) return reconfigure ? send(method, parameters) : {};
        const first = owners.size === 0;
        owners.add(channel);
        channel.enabledDomains.add(domain);
        this.#domainOwners.set(domain, owners);
        try {
          if (first || reconfigure) await send(method, parameters);
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
        if (owners.size === 1 && domain !== "Page") await send(method, parameters);
        owners.delete(channel);
        channel.enabledDomains.delete(domain);
        if (owners.size === 0 && this.#domainOwners.get(domain) === owners)
          this.#domainOwners.delete(domain);
        return {};
      });
    }
    const change = channel.domainChanges.get(domain);
    if (!change) return send(method, parameters);
    return change.then(() => {
      if (generation !== this.#rendererGeneration)
        throw new Error("Electron CDP renderer changed before command dispatch.");
      if (this.#closed || !this.#channels.has(channel)) throw new Error("CDP channel is closed.");
      return send(method, parameters);
    });
  }

  #startAgentProfile(
    channel: ElectronCdpChannel,
    parameters: CdpParameters | undefined,
  ): Promise<unknown> {
    const start = (async () => {
      const opened = await this.#openProfileInventory(channel).catch(() => null);
      try {
        // A channel that left while its inventory opened starts nothing.
        if (this.#closed || !this.#channels.has(channel)) throw new Error("CDP channel is closed.");
        return await this.#command("Profiler.start", parameters);
      } catch (error) {
        if (opened) await this.#closeProfileInventory(opened);
        throw error;
      }
    })();
    this.#profileStarts.set(channel, start);
    const settle = () => {
      if (this.#profileStarts.get(channel) === start) this.#profileStarts.delete(channel);
    };
    void start.then(settle, settle);
    return start;
  }

  /**
   * A private session that reports each script of the page with its world
   * from now on, and every script alive now. Without it, stop falls back to
   * the scripts still alive then.
   */
  async #openProfileInventory(channel: ElectronCdpChannel): Promise<ProfileInventory | null> {
    if (this.#profileInventory || this.#profileInventoryOpening) return null;
    const opening = Promise.withResolvers<void>();
    this.#profileInventoryOpening = opening.promise;
    let inventory: ProfileInventory | null = null;
    try {
      const renderer = this.#rendererGeneration;
      const context = this.#profileContextGeneration;
      const isolate = asRecord(await this.#dispatch("Runtime.getIsolateId")).id;
      if (typeof isolate !== "string") return null;
      // A session of the hub's own: attached and let go through its one register.
      const sessionId = await this.#attachOwn();
      const scripts = new CdpProductIsolation();
      inventory = { channel, sessionId, scripts, isolate, renderer, context };
      this.#profileInspections.set(sessionId, (method, parameters) => {
        scripts.observe(method, parameters);
      });
      const inspected = asRecord(await this.#dispatch("Runtime.getIsolateId", {}, sessionId));
      if (inspected.id !== isolate) throw new Error("The profile inventory reached another page.");
      await this.#dispatch("Runtime.enable", {}, sessionId);
      await this.#dispatch("Debugger.setSkipAllPauses", { skip: true }, sessionId);
      await this.#dispatch("Debugger.setBreakpointsActive", { active: false }, sessionId);
      await this.#dispatch("Debugger.enable", { maxScriptsCacheSize: 0 }, sessionId);
      // Again once Debugger is on, which is when a pause could first reach it.
      await this.#dispatch("Debugger.setSkipAllPauses", { skip: true }, sessionId);
      // Only a complete inventory, for a profile still wanted on the same documents, is used.
      if (
        this.#closed ||
        !this.#channels.has(channel) ||
        !channel.enabledDomains.has("Profiler") ||
        renderer !== this.#rendererGeneration ||
        context !== this.#profileContextGeneration
      ) {
        await this.#closeProfileInventory(inventory);
        return null;
      }
      this.#profileInventory = inventory;
      return inventory;
    } catch (error) {
      if (inventory) await this.#closeProfileInventory(inventory);
      throw error;
    } finally {
      this.#profileInventoryOpening = null;
      opening.resolve();
    }
  }

  async #closeProfileInventory(inventory: ProfileInventory): Promise<void> {
    if (this.#profileInventory === inventory) this.#profileInventory = null;
    try {
      await this.#detachOwn(inventory.sessionId);
    } finally {
      this.#profileInspections.delete(inventory.sessionId);
    }
  }

  async #stopAgentProfile(
    channel: ElectronCdpChannel,
    parameters: CdpParameters | undefined,
  ): Promise<unknown> {
    // Only the channel that started a profile reads, or ends, its inventory.
    const live = this.#profileInventory?.channel === channel ? this.#profileInventory : null;
    const renderer = this.#rendererGeneration;
    const context = this.#profileContextGeneration;
    const isolate = this.#dispatch("Runtime.getIsolateId").catch(() => undefined);
    try {
      const result = await this.#dispatch("Profiler.stop", parameters);
      // Script ids name scripts only within one isolate and its documents'
      // lifetimes; anything else is judged on what is alive now, as before.
      if (
        live &&
        live.renderer === renderer &&
        live.context === context &&
        renderer === this.#rendererGeneration &&
        context === this.#profileContextGeneration &&
        asRecord(await isolate).id === live.isolate
      ) {
        await this.#agentWorlds.observeProfileResult(result, live.scripts);
        return result;
      }
      await this.#agentWorlds.observeProfileResult(result, async (observe) => {
        const isolateId = asRecord(await isolate).id;
        if (typeof isolateId !== "string") return;
        const sessionId = await this.#attachOwn().catch(() => null);
        if (sessionId === null) return;

        this.#profileInspections.set(sessionId, observe);
        try {
          const inspected = asRecord(await this.#dispatch("Runtime.getIsolateId", {}, sessionId));
          if (inspected.id !== isolateId) return;
          await this.#dispatch("Runtime.enable", {}, sessionId);
          await this.#dispatch("Debugger.setSkipAllPauses", { skip: true }, sessionId);
          await this.#dispatch("Debugger.setBreakpointsActive", { active: false }, sessionId);
          await this.#dispatch("Debugger.enable", { maxScriptsCacheSize: 0 }, sessionId);
          if (renderer !== this.#rendererGeneration || context !== this.#profileContextGeneration)
            throw new SessionCdpRouterError(
              "forbidden",
              "The page changed while reading its profile.",
            );
        } finally {
          await this.#detachOwn(sessionId);
          this.#profileInspections.delete(sessionId);
        }
      });
      return result;
    } catch (error) {
      if (error instanceof SessionCdpRouterError && error.code === "forbidden")
        this.#onProfileRefused?.(cdpProfileRefusal(error) ?? "page-changed");
      throw error;
    } finally {
      if (live) await this.#closeProfileInventory(live);
    }
  }

  async #agentTargets(
    channel: ElectronCdpChannel,
    method: string,
    parameters?: Record<string, unknown>,
  ): Promise<unknown> {
    channel.targetConnection ??= (async () => {
      const info = asRecord(await this.#command("Target.getTargetInfo"));
      const targetId = asRecord(info.targetInfo).targetId;
      if (typeof targetId !== "string") throw new Error("Browser page target is unavailable");
      const attached = asRecord(
        await this.#command("Target.attachToTarget", { targetId, flatten: true }),
      );
      if (typeof attached.sessionId !== "string")
        throw new Error("Page debugger did not return a session");
      channel.targetSessionId = attached.sessionId;
      if (!this.#channels.has(channel)) {
        void this.#command("Target.detachFromTarget", { sessionId: attached.sessionId }).catch(
          () => undefined,
        );
        throw new Error("Page channel closed while attaching its child targets");
      }
      return attached.sessionId;
    })();
    return this.#command(method, parameters, await channel.targetConnection);
  }

  async release(channel: ElectronCdpChannel): Promise<void> {
    if (!this.#channels.delete(channel)) return;
    if (this.#profileInventory?.channel === channel)
      void this.#closeProfileInventory(this.#profileInventory);
    if (channel.targetSessionId)
      void this.#command("Target.detachFromTarget", { sessionId: channel.targetSessionId }).catch(
        () => undefined,
      );
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
      await this.#leaveCast(channel, generation).catch(() => undefined);
      // A cast it stopped and might have asked for again: it will not now.
      for (const cast of [...this.#casts])
        if (cast.parked?.by === channel)
          await this.#endCast(cast, generation).catch(() => undefined);
      this.#handed.delete(channel);
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

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const channels = [...this.#channels];
    this.#channels.clear();
    for (const channel of channels) channel.clearListeners();
    try {
      await withTimeout(this.#terminate(new Error("Electron CDP target is closing.")), 2_000, {
        timeoutError: () => new Error("Electron CDP target teardown timed out."),
      });
    } catch (error) {
      this.#forced = true;
      this.#forcedDisposal.resolve();
      throw error;
    } finally {
      this.#detachDebugger();
      this.#forgetContexts();
      this.#events.removeAllListeners();
    }
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
    // No cast is left; a private session one ran in is let go now, whether or not the
    // debugger itself is detached after (a channel opened meanwhile keeps it attached).
    this.#castsEnded("crashed");
    this.#castOf.clear();
    this.#casts.clear();
    this.#renderingOwners.clear();
    this.#updateThrottling();
    const teardown = (async () => {
      await Promise.race([this.#ownershipTail, this.#forcedDisposal.promise]);
      while (this.#outstandingInput.size > 0 && !this.#webContents.isDestroyed() && !this.#forced)
        await Promise.race([
          Promise.all(this.#outstandingInput),
          this.#destroyed,
          this.#forcedDisposal.promise,
        ]);
      if (!this.#closed && this.#channels.size === 0) this.#detachDebugger();
      this.#forgetContexts();
    })().finally(() => {
      if (this.#teardown === teardown) this.#teardown = null;
    });
    this.#teardown = teardown;
    return teardown;
  }

  #attach(): Promise<void> {
    if (this.#attachment) return this.#attachment;
    this.#attachDebugger();
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

  /**
   * A channel's start: it joins the running cast of the settings it asked for, or that cast
   * starts. A run's identity is fixed at its start: the session it runs in, and Chromium's frame
   * `sessionId` (`#laneFrame`); nothing is delivered or kept before the start has resolved. An
   * owner alone in its cast hands that cast's session to the new one, so the start replaces its
   * settings with no stop between; otherwise it keeps its old cast's frames until the new one has
   * started, and joins a cast only once it has left its old one. A start that fails leaves the
   * channel in the cast it had.
   */
  async #startCast(
    channel: ElectronCdpChannel,
    parameters: Record<string, unknown> | undefined,
    send: (method: string, parameters?: Record<string, unknown>) => Promise<unknown>,
  ): Promise<unknown> {
    const generation = this.#rendererGeneration;
    const key = castKey(parameters);
    // A channel closed while its start was queued does nothing: it joins nothing, resolves
    // nothing and sends Chromium nothing, on every branch below.
    this.#assertOpen(channel);
    // Nothing read before an await is used after it unless read again.
    const running = () =>
      [...this.#casts].find(
        (cast) => cast.key === key && cast.run?.started === true && cast.run.lane !== null,
      );
    if (running() !== undefined) {
      // Out of its old cast first, then into the running one, as both are after the leaving.
      if (this.#castOf.get(channel) !== running()) {
        await this.#leaveCast(channel, generation);
        this.#assertCurrent(generation);
        this.#assertOpen(channel);
      }
      const joined = running();
      if (joined?.run) {
        this.#joinCast(channel, joined);
        // One that asks again has reset what it shows: it is handed the latest frame too.
        this.#replay(channel, joined.run);
        return {};
      }
      // It ended while the channel left its old cast: it starts afresh, below.
    }
    // A cast someone else stopped and might have asked for again ends: this start changes what
    // the page is asked for.
    await this.#endParkedCasts(generation, channel);
    this.#assertCurrent(generation);
    this.#assertOpen(channel);
    // The cast this channel had: its own, or one it stopped and left running (parked).
    const parked = [...this.#casts].find((cast) => cast.parked?.by === channel);
    const previous = this.#castOf.get(channel) ?? parked;
    const same = [...this.#casts].find((cast) => cast.key === key);
    const leavingAlone =
      previous !== undefined &&
      previous !== same &&
      previous.owners.size === (previous === parked ? 0 : 1);
    // Casts that run or are starting: one whose renderer died runs nothing and holds no place.
    const live = [...this.#casts].filter((cast) => cast.run !== null);
    if (
      same === undefined &&
      channel.role !== "platform" &&
      live.length - (leavingAlone && previous.run !== null ? 1 : 0) >= maxCastsPerPage
    )
      throw new Error(
        `This page is already pictured in ${maxCastsPerPage} formats or sizes at once, the most it gives. Ask for one of those, or ask again when one of them ends.`,
      );
    const cast: Screencast = same ?? { key, owners: new Set(), parked: null, run: null };
    const left = previous !== undefined && previous !== cast ? previous : undefined;
    const handed = leavingAlone && left?.run?.lane ? left.run : null;
    const run: CastRun = {
      awaitingAck: 0,
      cast,
      floor: 0,
      frameSession: null,
      lane: null,
      lastFrame: null,
      started: false,
      unhanded: false,
    };
    // A cast it parked, and does not take the lane of, ends below like one it leaves.
    const parkedLeft = left !== undefined && left === parked;
    if (handed && left) {
      this.#unpark(left);
      run.lane = handed.lane;
      handed.lane = null;
      left.run = null;
      left.owners.delete(channel);
      this.#castOf.delete(channel);
      this.#casts.delete(left);
    }
    this.#casts.add(cast);
    cast.run = run;
    this.#castStarts += 1;
    this.#updateThrottling();
    let ending: Screencast | null = null;
    let released = false;
    try {
      this.#assertCurrent(generation);
      if (run.lane === null) {
        run.lane = this.#pageSessionFree(run)
          ? { id: undefined }
          : { id: await this.#attachOwn(generation) };
        // A crash or the debugger's detach while it attached ended this run.
        if (cast.run !== run)
          throw new Error("Electron CDP renderer changed before command dispatch.");
        this.#assertOpen(channel);
      }
      const lane = run.lane;
      const laneKey = lane.id ?? "";
      // Chromium numbers a session's casts upward, one more for each start it answers: every
      // earlier run's frames carry at most the higher of what it sent and what it answered.
      // The count is the debugger session's: one that lets go and attaches again counts afresh.
      const starts = this.#session.laneStarts;
      run.floor = Math.max(this.#session.laneFrames.get(laneKey) ?? 0, starts.get(laneKey) ?? 0);
      await (lane.id === undefined
        ? send("Page.startScreencast", parameters)
        : this.#command("Page.startScreencast", parameters, lane.id));
      starts.set(laneKey, (starts.get(laneKey) ?? 0) + 1);
      this.#assertCurrent(generation);
      if (cast.run !== run || run.lane !== lane)
        throw new Error("Electron CDP renderer changed before command dispatch.");
      run.started = true;
      if (this.#closed || !this.#channels.has(channel)) {
        // A channel released while it waited joins nothing (its release leaves its old cast);
        // the cast Chromium now runs for it ends unless someone else is in it.
        released = true;
        if (cast.owners.size === 0) ending = cast;
      } else {
        // The channel moves in one step, out of its old cast and into this one, so no frame of
        // this run reaches no one; the old cast, if no one is left in it, ends after.
        if (left && !handed) ending = parkedLeft ? left : this.#leaveMembership(channel);
        this.#joinCast(channel, cast);
      }
      // A frame of this run that came before its start resolved is handed now, to each owner.
      for (const owner of cast.owners) this.#replay(owner, run);
    } catch (error) {
      if (cast.run === run) cast.run = null;
      const lane = run.lane;
      // A frame of this run that came before its start failed was handed to no one: Chromium
      // waits for its ack, which it gets before the run is forgotten.
      if (run.unhanded && lane && run.frameSession !== null && run.awaitingAck > 0)
        void this.#command(
          "Page.screencastFrameAck",
          { sessionId: run.frameSession },
          lane.id,
        ).catch(() => undefined);
      run.lane = null;
      // A renderer change or the debugger's detach has ended every cast already.
      const interrupted = generation !== this.#rendererGeneration;
      if (handed && left && !interrupted && lane !== null) {
        handed.lane = lane;
        left.run = handed;
        this.#casts.add(left);
        // A released channel's cast is not restored for anyone to inherit, nor one it had stopped.
        if (this.#channels.has(channel) && !parkedLeft) this.#joinCast(channel, left);
        else await this.#endCast(left, generation).catch(() => undefined);
      } else if (lane?.id !== undefined) {
        // A session attached for this start is let go, whoever else is in the cast.
        await this.#detachOwn(lane.id);
      }
      if (cast.owners.size === 0) this.#casts.delete(cast);
      throw error;
    } finally {
      this.#castStarts -= 1;
      this.#updateThrottling();
    }
    // The start is done whatever ending the old cast comes to.
    if (ending) await this.#endCast(ending, generation).catch(() => undefined);
    if (released) throw new Error("CDP channel is closed.");
    return {};
  }

  #joinCast(channel: ElectronCdpChannel, cast: Screencast): void {
    this.#unpark(cast);
    cast.owners.add(channel);
    this.#castOf.set(channel, cast);
    this.#updateThrottling();
  }

  /**
   * The channel leaves its cast, and a cast no one is left in ends; or, where the channel itself
   * stopped it (`park`), it keeps running a moment for that channel to ask again (`parkedCastMs`).
   */
  async #leaveCast(
    channel: ElectronCdpChannel,
    generation: number,
    parameters?: Record<string, unknown>,
    park = false,
  ): Promise<void> {
    const empty = this.#leaveMembership(channel);
    if (!empty) return;
    if (park && empty.run?.started && empty.run.lane && generation === this.#rendererGeneration) {
      this.#park(empty, channel, parameters);
      return;
    }
    await this.#endCast(empty, generation, parameters);
  }

  /** `cast`, which `channel` was last to stop, runs on for it until `parkedCastMs` have passed. */
  #park(cast: Screencast, channel: ElectronCdpChannel, parameters?: Record<string, unknown>): void {
    this.#unpark(cast);
    const generation = this.#rendererGeneration;
    const timer = setTimeout(() => {
      void this.#serializeOwnership(async () => {
        if (cast.parked?.timer !== timer || cast.owners.size > 0 || !this.#casts.has(cast)) return;
        await this.#endCast(cast, generation, parameters);
      }, false).catch(() => undefined);
    }, parkedCastMs);
    timer.unref?.();
    cast.parked = { by: channel, timer };
  }

  #unpark(cast: Screencast): void {
    if (cast.parked) clearTimeout(cast.parked.timer);
    cast.parked = null;
  }

  /** Every cast someone other than `channel` parked ends: someone's needs have changed. */
  async #endParkedCasts(generation: number, keep?: ElectronCdpChannel): Promise<void> {
    for (const cast of [...this.#casts])
      if (cast.parked && cast.parked.by !== keep) await this.#endCast(cast, generation);
  }

  /**
   * The channel is no longer one of its cast's owners, at once; the cast, if no one is left in it,
   * is returned to be ended. What it was handed stays: its late acks go to that run, or nowhere.
   */
  #leaveMembership(channel: ElectronCdpChannel): Screencast | null {
    const cast = this.#castOf.get(channel);
    if (!cast) return null;
    cast.owners.delete(channel);
    this.#castOf.delete(channel);
    this.#updateThrottling();
    return cast.owners.size === 0 ? cast : null;
  }

  /** Whether the page's own session runs no cast but `run`. */
  #pageSessionFree(run: CastRun): boolean {
    for (const cast of this.#casts)
      if (cast.run && cast.run !== run && cast.run.lane && cast.run.lane.id === undefined)
        return false;
    return true;
  }

  /** The run cast in `lane` (undefined: the page's own session), if one is. */
  #runIn(lane: string | undefined): CastRun | null {
    for (const cast of this.#casts)
      if (cast.run?.lane && cast.run.lane.id === lane) return cast.run;
    return null;
  }

  /**
   * A frame Chromium sent in `lane`. It belongs to the run cast there only once that run's start
   * has resolved and it carries the run's frame `sessionId`: Chromium numbers a session's casts
   * upward, so a run's first frame names it, and anything at or below the highest id the session
   * had sent before the run started is an earlier run's, late. A frame that is not the run's is
   * not delivered, kept or counted.
   */
  #laneFrame(lane: string | undefined, frame: Record<string, unknown>): void {
    const id = Number(frame.sessionId);
    if (!Number.isFinite(id)) return;
    const key = lane ?? "";
    if (id > (this.#session.laneFrames.get(key) ?? 0)) this.#session.laneFrames.set(key, id);
    const run = this.#runIn(lane);
    if (!run) return;
    if (run.frameSession === null) {
      if (id <= run.floor) return;
      run.frameSession = id;
    } else if (id !== run.frameSession) return;
    if (!run.started || run.cast.owners.size === 0) {
      // This run's, though its start has not resolved or no one is in its cast now (parked): it
      // is kept, to be handed to whoever is in it next, and reaches no one before. Chromium waits
      // for an ack of each frame it sends, and stops for good at two: one this one replaces is
      // acked here.
      if (run.unhanded && run.lastFrame !== null && run.lane)
        void this.#command("Page.screencastFrameAck", { sessionId: id }, run.lane.id).catch(
          () => undefined,
        );
      else run.awaitingAck += 1;
      run.lastFrame = frame;
      run.unhanded = true;
      return;
    }
    run.lastFrame = frame;
    run.unhanded = false;
    run.awaitingAck += 1;
    for (const owner of run.cast.owners) this.#hand(owner, run, id, frame);
  }

  #hand(
    owner: ElectronCdpChannel,
    run: CastRun,
    frame: number,
    parameters: Record<string, unknown>,
  ): void {
    const handed = this.#handed.get(owner) ?? [];
    handed.push({ frame, run });
    // An owner that never acks keeps no more than this.
    if (handed.length > 16) handed.shift();
    this.#handed.set(owner, handed);
    owner.emit("Page.screencastFrame", parameters);
  }

  #replay(channel: ElectronCdpChannel, run: CastRun): void {
    if (run.lastFrame !== null && run.frameSession !== null) run.unhanded = false;
    if (run.lastFrame !== null && run.frameSession !== null)
      this.#hand(channel, run, run.frameSession, run.lastFrame);
  }

  /**
   * An owner's ack goes to the run that handed it that frame, in that run's session, once for each
   * frame Chromium sent there, from whichever of its owners acks first (a slow one holds no one
   * up). An ack of a run that has ended, or of a frame the owner was never handed, goes nowhere.
   */
  #ackCast(channel: ElectronCdpChannel, parameters: CdpParameters | undefined): Promise<unknown> {
    const frame = Number(asRecord(parameters).sessionId);
    const handed = this.#handed.get(channel) ?? [];
    const at = handed.findIndex((entry) => entry.frame === frame);
    if (at < 0) return Promise.resolve({});
    const run = handed.splice(0, at + 1).at(-1)!.run;
    if (run.cast.run !== run || !run.started || !run.lane || run.awaitingAck === 0)
      return Promise.resolve({});
    run.awaitingAck -= 1;
    return this.#command("Page.screencastFrameAck", parameters, run.lane.id);
  }

  /**
   * No one is left in `cast`: it ends. Its private session is let go on every path; the page's own
   * session is asked to stop only while the generation it was asked in lasts (a renderer change
   * or the debugger's detach has ended that cast already).
   */
  async #endCast(
    cast: Screencast,
    generation: number,
    parameters?: Record<string, unknown>,
  ): Promise<void> {
    this.#unpark(cast);
    this.#casts.delete(cast);
    const run = cast.run;
    cast.run = null;
    const lane = run?.lane ?? null;
    if (run) run.lane = null;
    if (lane === null) return;
    if (lane.id !== undefined) return this.#detachOwn(lane.id);
    if (generation !== this.#rendererGeneration) return;
    await this.#command("Page.stopScreencast", parameters);
  }

  /**
   * Chromium casts no more: no cast is left, and no channel owns one until it asks again (its
   * start is then sent anew); no old frame is handed to anyone. A private session a cast ran in is let go (`crashed`, and on the last channel's
   * release), or is already gone with the debugger (`detached`).
   */
  #castsEnded(how: "crashed" | "detached"): void {
    for (const cast of this.#casts) {
      this.#unpark(cast);
      const lane = cast.run?.lane ?? null;
      if (cast.run) cast.run.lane = null;
      cast.run = null;
      if (how === "crashed" && lane?.id !== undefined) void this.#detachOwn(lane.id);
      // Ownership ends with the run: a channel owns a cast again only by asking after this.
      cast.owners.clear();
    }
    this.#casts.clear();
    this.#castOf.clear();
    this.#handed.clear();
    this.#updateThrottling();
  }

  /** The hub attaches the debugger, if it is not: a new session, counted afresh. */
  #attachDebugger(): void {
    if (this.#debugger.isAttached()) return;
    this.#debugger.attach("1.3");
    this.#session = new DebuggerSessionState();
  }

  /**
   * The hub lets the debugger go. Electron says nothing of a detach it was asked for (no "detach"
   * event), so what the session counted ends here too.
   */
  #detachDebugger(): void {
    if (this.#isAttached()) this.#debugger.detach();
    this.#debuggerSessionEnded();
  }

  /**
   * The debugger session is gone, however it went: its frame and start counts, the hub's own
   * sessions and every event held for them go with it, and the next session starts from nothing.
   * A start or attach still answering counts in the session it was asked in, never the next.
   */
  #debuggerSessionEnded(): void {
    this.#session = new DebuggerSessionState();
  }

  /**
   * No one is handed a cast's latest frame any more. One kept for a start not yet answered was
   * never handed to anyone, and Chromium waits for its ack: it is acked here, not forgotten.
   */
  #forgetLatestFrames(): void {
    for (const cast of this.#casts) {
      const run = cast.run;
      if (!run || run.lastFrame === null) continue;
      if (run.unhanded && run.lane && run.frameSession !== null && run.awaitingAck > 0) {
        run.awaitingAck -= 1;
        void this.#command(
          "Page.screencastFrameAck",
          { sessionId: run.frameSession },
          run.lane.id,
        ).catch(() => undefined);
      }
      run.lastFrame = null;
      run.unhanded = false;
    }
  }

  /**
   * A session of the hub's own on this page. Its attach event reaches no channel, even one that
   * arrives before the attach answers. The attach goes straight to the debugger: a session it
   * opens is the hub's whatever happens to its caller meanwhile, and one that answers after its
   * caller was interrupted is let go at once, never left attached.
   */
  async #attachOwn(generation = this.#rendererGeneration): Promise<string> {
    const info = asRecord(await this.#command("Target.getTargetInfo"));
    const targetId = asRecord(info.targetInfo).targetId;
    if (typeof targetId !== "string") throw new Error("Browser page target is unavailable");
    const session = this.#session;
    return new Promise<string>((resolve, reject) => {
      {
        let interrupted = false;
        const interrupt = (error: Error) => {
          interrupted = true;
          reject(error);
        };
        this.#pending.add(interrupt);
        const answered = (sessionId: unknown) => {
          this.#pending.delete(interrupt);
          if (typeof sessionId !== "string") {
            reject(new Error("Page debugger did not return a session"));
            return;
          }
          session.ownSessions.add(sessionId);
          session.ownSessionsSeen.add(sessionId);
          if (interrupted || generation !== this.#rendererGeneration || session !== this.#session) {
            void this.#detachOwn(sessionId);
            reject(new Error("Electron CDP renderer changed before command dispatch."));
            return;
          }
          resolve(sessionId);
        };
        if (this.#webContents.isDestroyed() || !this.#debugger.isAttached()) {
          this.#pending.delete(interrupt);
          reject(new Error("Electron CDP target is closed."));
          return;
        }
        // Counted until Chromium answers, not until the caller stops waiting: an interrupted
        // caller's session is still announced, and is still the hub's.
        session.ownAttaching += 1;
        const settled = () => {
          session.ownAttaching -= 1;
          if (session.ownAttaching === 0 && session === this.#session) this.#releaseHeldEvents();
        };
        const failed = (error: unknown) => {
          this.#pending.delete(interrupt);
          reject(error instanceof Error ? error : new Error(String(error)));
          settled();
        };
        // Released on every exit: an answer, a refusal, or a throw before anything was sent.
        let sent: Promise<unknown>;
        try {
          sent = this.#debugger.sendCommand("Target.attachToTarget", { targetId, flatten: true });
        } catch (error) {
          failed(error);
          return;
        }
        void sent.then((result) => {
          answered(asRecord(result).sessionId);
          settled();
        }, failed);
      }
    });
  }

  /** An event of the page's own session, to the channels that hear it. */
  #pageEvent(method: string, record: Record<string, unknown>): void {
    this.#contexts.observe(method, record);
    const pageEvent = this.#agentWorlds.observe(method, record);
    if (method.startsWith("Runtime.executionContext"))
      for (const channel of this.#channels) channel.observeContextEvent(method, record);
    if (method === "Page.screencastFrame") {
      this.#laneFrame(undefined, record);
      return;
    }
    const recipients = this.#domainOwners.get(method.split(".", 1)[0] ?? "");
    for (const channel of recipients ?? []) {
      if (channel.role === "agent" && !pageEvent) {
        if (method === "Debugger.paused")
          void this.#command("Debugger.resume").catch(() => undefined);
        continue;
      }
      channel.emit(method, record);
    }
  }

  /** The Target events held while the hub's own attach was unanswered, in the order they came. */
  #releaseHeldEvents(): void {
    const held = this.#session.held;
    this.#session.held = [];
    for (const { method, record } of held) this.#targetOrPageEvent(method, record);
  }

  /** A Target event about one of the hub's own sessions reaches no channel; any other does. */
  #targetOrPageEvent(method: string, record: Record<string, unknown>): void {
    const own = typeof record.sessionId === "string" ? record.sessionId : null;
    if (
      (method === "Target.attachedToTarget" || method === "Target.detachedFromTarget") &&
      own !== null &&
      this.#session.ownSessionsSeen.has(own)
    ) {
      if (method === "Target.detachedFromTarget") this.#ownSessionGone(own);
      return;
    }
    this.#pageEvent(method, record);
  }

  /**
   * One of the hub's own sessions is let go: once, whatever path asks, and straight to the
   * debugger, since a crashed page or a teardown refuses every other command.
   */
  async #detachOwn(sessionId: string): Promise<void> {
    if (!this.#session.ownSessions.delete(sessionId)) return;
    if (this.#webContents.isDestroyed() || !this.#debugger.isAttached()) return;
    await this.#debugger
      .sendCommand("Target.detachFromTarget", { sessionId })
      .then(() => undefined)
      .catch(() => undefined);
  }

  /** Chromium detached one of the hub's own sessions itself: nothing is left to let go. */
  #ownSessionGone(sessionId: string): void {
    this.#session.ownSessions.delete(sessionId);
    const run = this.#runIn(sessionId);
    if (run) {
      run.lane = null;
      if (run.cast.run === run) run.cast.run = null;
    }
  }

  #updateThrottling(): void {
    if (this.#closed || this.#webContents.isDestroyed()) return;
    const demanded =
      [...this.#channels].some((channel) => channel.role === "agent") ||
      this.#castOf.size > 0 ||
      this.#castStarts > 0 ||
      this.#renderingOwners.size > 0;
    this.#setRenderingDemand(demanded);
  }

  #isAttached(): boolean {
    return !this.#webContents.isDestroyed() && this.#debugger.isAttached();
  }

  /** Only Runtime commands wait for the attachment to inventory execution contexts. */
  #command(
    method: string,
    parameters?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    const generation = this.#rendererGeneration;
    const gate = method.startsWith("Runtime.") ? this.#gate : null;
    if (!gate) return this.#dispatch(method, parameters, sessionId);
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
        return this.#dispatch(method, parameters, sessionId);
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

  #dispatch(
    method: string,
    parameters?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
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
      void (
        sessionId
          ? this.#debugger.sendCommand(method, parameters, sessionId)
          : this.#debugger.sendCommand(method, parameters)
      ).then(
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
    if (this.#profileInventory) void this.#closeProfileInventory(this.#profileInventory);
    this.#inputReady = null;
    this.#gate = null;
    for (const reject of this.#pending) reject(error);
    this.#pending.clear();
  }

  #assertOpen(channel: ElectronCdpChannel): void {
    if (this.#closed || !this.#channels.has(channel)) throw new Error("CDP channel is closed.");
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
  targetSessionId: string | undefined;
  targetConnection: Promise<string> | undefined;
  readonly #worlds = new CdpProductIsolation();
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

  cancelDragging(): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("CDP channel is closed."));
    return this.#hub.send(this, "Input.cancelDragging", undefined, true);
  }

  send<Result = unknown>(method: string, parameters?: Record<string, unknown>): Promise<Result> {
    if (this.#closed) return Promise.reject(new Error("CDP channel is closed."));
    if (this.role === "agent") {
      this.#worlds.assertCommand(method, parameters);
      if (
        method === "Runtime.addBinding" &&
        parameters?.executionContextId === undefined &&
        parameters?.executionContextName === undefined
      )
        parameters = { ...parameters, executionContextName: "" };
    }
    return this.#hub.send(this, method, parameters).then((result) => {
      if (this.role === "agent" && method !== "Profiler.stop")
        this.#worlds.observeResult(method, parameters ?? {}, result);
      return result as Result;
    });
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

  observeContext(context: CdpParameters): void {
    this.#worlds.observe("Runtime.executionContextCreated", { context });
  }
  observeContextEvent(method: string, params: CdpParameters): void {
    this.#worlds.observe(method, params);
  }

  emit(method: string, parameters: CdpParameters): void {
    if (this.#closed) return;
    if (this.role === "agent" && !this.#worlds.observe(method, parameters)) {
      if (method === "Debugger.paused")
        void this.#hub.send(this, "Debugger.resume").catch(() => undefined);
      return;
    }
    this.#events.emit("event", method, parameters);
    this.#events.emit(method, parameters);
  }

  clearListeners(): void {
    this.#events.removeAllListeners();
  }
}

class ElectronBrowserCdpBackend implements BrowserCdpBackend {
  readonly protectProductWorlds = true;
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

  assertScope(method: string, parameters: CdpParameters): void {
    if (method === "Browser.getBrowserCommandLine" || method.startsWith("SystemInfo."))
      throw new Error(`${method} describes the Opensteer process, outside browser page ownership.`);
    if (
      parameters.browserContextId !== undefined &&
      parameters.browserContextId !== "opensteer-electron-profile"
    )
      throw new SessionCdpRouterError(
        "forbidden",
        "CDP command requested another browser context.",
      );
    if (parameters.windowId !== undefined)
      throw new SessionCdpRouterError(
        "forbidden",
        "Opensteer windows are outside the browser page context.",
      );
  }

  async scopeParameters(method: string, parameters: CdpParameters): Promise<CdpParameters> {
    if (!contextScopedCdpMethods.has(method)) return parameters;
    const page = this.#context.pages()[0] as ElectronBrowserPage | undefined;
    if (!page) throw new SessionCdpRouterError("not_found", "Browser profile has no page target.");
    const platform = await page.cdp();
    const result = asRecord(await platform.send("Target.getTargetInfo"));
    const browserContextId = asRecord(result.targetInfo).browserContextId;
    if (typeof browserContextId !== "string" || !browserContextId.length)
      throw new SessionCdpRouterError(
        "forbidden",
        `${method} cannot be scoped to this browser profile by this Electron version.`,
      );
    return { ...parameters, browserContextId };
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
    if (method === "Target.activateTarget")
      throw new Error("Target.activateTarget is unavailable at Electron browser scope.");
    this.assertScope(method, parameters);
    const routed = await this.scopeParameters(method, parameters);
    const page = this.#context.pages()[0] as ElectronBrowserPage | undefined;
    if (!page) throw new Error("Electron profile has no page target.");
    const channel = await page.agentCdp();
    try {
      return await channel.send(method, routed);
    } catch (error) {
      // Electron discards the CDP error code and rejects with only its message.
      if (
        (method === "Browser.setDownloadBehavior" || method === "Browser.cancelDownload") &&
        error instanceof Error &&
        (error.message === `'${method}' wasn't found` ||
          error.message === "Not allowed" ||
          error.message === "Browser context management is not supported.")
      )
        throw new SessionCdpRouterError(
          "forbidden",
          `${method} cannot be scoped to this browser profile by this Electron version.`,
          { cause: error },
        );
      throw error;
    } finally {
      await channel.close();
    }
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

/**
 * The most casts one page runs at once, each its own capture and encode on every frame the page
 * draws: the person's view here, the same page on their phone at another size, and one agent's
 * picture. A request for a fourth is refused and takes nothing from the casts that run; the
 * person's own view (a platform channel) is never the one refused.
 */
const maxCastsPerPage = 3;

/**
 * How long a cast its last owner stopped keeps running for that owner to ask again. The follow
 * view stops and asks again for the same picture whenever a page navigates or is sized anew;
 * Chromium's picture need not change for that, so it is neither stopped nor started.
 */
const parkedCastMs = 1_000;

/** One of a page's screencasts: the settings it was asked for, its owners, and its current run. */
interface Screencast {
  readonly key: string;
  readonly owners: Set<ElectronCdpChannel>;
  run: CastRun | null;
  /**
   * The owner that stopped it, last, while it is kept running for that owner to ask again;
   * null while it has owners, or once it has ended.
   */
  parked: { readonly by: ElectronCdpChannel; readonly timer: ReturnType<typeof setTimeout> } | null;
}

/** A cast as Chromium runs it, from one start: its identity is fixed there. */
interface CastRun {
  readonly cast: Screencast;
  /** Where it runs: the page's own session (`id` undefined) or a private one; null once ended. */
  lane: { readonly id: string | undefined } | null;
  /** Whether its start has resolved: nothing is delivered or kept before. */
  started: boolean;
  /** Chromium's frame `sessionId` for it, from its first frame above `floor`. */
  frameSession: number | null;
  /** The highest frame id its session had sent when it started: anything at or below is earlier runs'. */
  floor: number;
  /** Its latest frame, for an owner that joins it: a still page sends no other. */
  lastFrame: Record<string, unknown> | null;
  /** Whether `lastFrame` reached no one yet: kept before its start resolved, or while parked. */
  unhanded: boolean;
  /**
   * Frames Chromium sent in it and has had no ack for. Chromium sends no more while two wait:
   * every one it sent is acked once.
   */
  awaitingAck: number;
}

/** A cast's settings with Chromium's defaults filled in, so equal settings compare equal. */
function castKey(parameters: Record<string, unknown> | undefined): string {
  const value = parameters ?? {};
  const format = value.format === "jpeg" ? "jpeg" : "png";
  return JSON.stringify({
    everyNthFrame: value.everyNthFrame ?? 1,
    format,
    maxHeight: value.maxHeight ?? null,
    maxWidth: value.maxWidth ?? null,
    quality: format === "jpeg" ? (value.quality ?? 80) : null,
  });
}
