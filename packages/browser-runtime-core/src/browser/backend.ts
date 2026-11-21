import type { BrowserCdpBackend, CdpChannel, CdpParameters } from "@opensteer/browser-core";
import type { BrowserCookie } from "@opensteer/browser-profile/cookies";
import type {
  BrowserCaptureDescriptor,
  BrowserEngine,
  BrowserSessionId,
  BrowserSurfaceId,
  LocalProfileBinding,
} from "@opensteer/protocol/browser";
import type { PageEndReason } from "./page-ownership.js";
import type { PageSize } from "./surface-ledger.js";
import type { ViewportCapture, ViewportCaptureRequest } from "./viewport-capture.js";

export interface CdpSession extends CdpChannel {
  /** Keeps native compositing demanded across an atomic screencast restart. */
  retainRendering?(): () => void;
  close(): Promise<void>;
  detach(): Promise<void>;
  off(event: string, listener: (parameters: unknown) => void): void;
  on(event: string, listener: (parameters: unknown) => void): void;
  send<Result = unknown>(method: string, parameters?: Record<string, unknown>): Promise<Result>;
}

/**
 * The whole geometry the ledger gives a page: the person's size and the
 * agent's device-metrics override exactly as the ledger accepted it, with a
 * zero width or height already resolved to the person's size.
 */
export interface PageGeometry {
  readonly agent: CdpParameters | null;
  readonly person: PageSize;
}

/** The CSS size a page is laid out at: the agent's override when it has one, else the person's size. */
export function pageViewport(geometry: PageGeometry): PageSize {
  if (!geometry.agent) return geometry.person;
  return { height: Number(geometry.agent.height), width: Number(geometry.agent.width) };
}

/** A person's input an engine saw arrive at the page itself, never an agent's. */
export interface HumanInputObservation {
  readonly kind: "click" | "typing";
  /** Viewport CSS pixels of a click. */
  readonly x?: number;
  readonly y?: number;
}

export interface PageCapture extends BrowserCaptureDescriptor {
  readonly rasterScale: number;
}

export interface PageCapturePort {
  /** Null while bounds/metrics are pending or the owner is terminal. */
  read(): PageCapture | null;
  subscribe(listener: () => void): () => void;
}

export type KeepAwakeReason = "upload" | "post" | "download" | "media" | "fullscreen" | "capturing";

/** A renderer after its page ended: gone, still serving other pages, or still running alone. */
export type RendererExit = "exited" | "shared" | "running";

/** What told the engine its native page is gone: the page's own end, or its whole context ending. */
export type PageGoneCause = "page" | "context";

/** Why a renderer went away while its page stayed: a crash or kill, or an orderly exit. */
export type RendererGoneCause = "crashed" | "exited";

export class BrowserPaintTimeoutError extends Error {
  constructor(message = "Browser paint wait timed out.") {
    super(message);
  }
}

/** Engine operations never own native focus; active-surface selection belongs to the ledger. */
export interface BrowserPage {
  /** Reads opaque restore state without closing or changing the page. Null refuses this document. */
  captureRestore?(): Promise<unknown | null>;
  keepAwake?(): KeepAwakeReason | null | Promise<KeepAwakeReason | null>;
  hasOpenerAccess?(): boolean | Promise<boolean>;
  readonly cursor?: import("./cursor-hints.js").NativePageCursor;
  readonly capture?: PageCapturePort;
  /**
   * Observes compositing after geometry acknowledgement, outside its lock.
   * Electron cannot identify the metrics revision of those pixels: an already
   * composed frame of this page can satisfy it. Cancellation and timeout reject
   * the wait without waiting on the renderer.
   */
  settleRendering?(signal?: AbortSignal): Promise<void>;
  /**
   * Gives the page the ledger's geometry. An engine without it has the ledger
   * apply the person's size as device emulation.
   */
  applyGeometry?(geometry: PageGeometry): Promise<void>;
  /**
   * One look at the page: an image whose pixel (x, y) is where an input at
   * (x, y) lands. Looking never changes the page. An engine may demand
   * rendering and transform the returned pixels, but must leave native bounds,
   * layout, emulation, scroll, focus and selection alone. That rules out
   * `Page.captureScreenshot` with a clip, or on a channel holding emulation:
   * Chromium then resizes the view for the capture and a person watches it shrink.
   */
  captureViewport(request: ViewportCaptureRequest): Promise<ViewportCapture>;
  /** Native bounds share the ledger's serialization and held-input release barrier. */
  bindGeometry?(
    serialize: (operation: () => Promise<void>) => Promise<void>,
    beforeResize: () => Promise<void>,
  ): () => void;
  /** Invalidates and reconciles a native surface without changing ledger geometry. */
  invalidateSurface?(): Promise<void>;
  /** Input a person gave a natively shown page directly; agent and viewer input never appear here. */
  /** Trusted input delivered to a native view, after application shortcut interception. */
  observePasskeyInput?(listener: () => void): () => void;
  observeHumanInput?(listener: (observation: HumanInputObservation) => void): () => void;
  /** Opened behind its opener, as a ⌘-click opens a tab: nobody asked to look at it yet. */
  readonly openedInBackground?: boolean;
  /** True when the page came back from the engine's own session restore with its document intact. */
  readonly restoredFromSession?: boolean;
  agentCdp(): Promise<CdpSession>;
  cdp(): Promise<CdpSession>;
  /** Asks the engine to end the page. Settling proves nothing; `onClose` does. */
  close(options?: { readonly reason?: PageEndReason }): Promise<void>;
  /** True only once the engine confirms the native page gone, never while a close is under way. */
  isClosed(): boolean;
  offClose(listener: (cause?: PageGoneCause) => void): void;
  offMetadataChanged(listener: () => void): void;
  /** The engine's one confirmation that the native page is gone. */
  onClose(listener: (cause?: PageGoneCause) => void): void;
  /** The renderer went away; the page stays until it is closed. Returns the unsubscribe. */
  onRendererGone?(listener: (cause: RendererGoneCause) => void): () => void;
  /** After the page is gone: what became of the renderer it last used, null when unknown. */
  rendererExit?(): RendererExit | null;
  onMetadataChanged(listener: () => void): void;
  opener(): Promise<BrowserPage | null>;
  targetId(): Promise<string>;
  title(): Promise<string>;
  url(): string;
}

export interface BrowserSessionRestore {
  /** Claims a Chromium-restored tab for `surfaceId` (verifying `url` and `lineageId` when given), or returns null. */
  claim(
    surfaceId: BrowserSurfaceId,
    url?: string,
    own?: (page: BrowserPage) => void,
    lineageId?: string,
  ): Promise<BrowserPage | null>;
  /**
   * Reconciles restored tabs against the Home's authoritative saved-tab list,
   * closing every restored tab not named in `savedTabIds` (or outside `lineageId`) with evidence.
   */
  reconcile(savedTabIds: ReadonlySet<BrowserSurfaceId>, lineageId?: string): Promise<void>;
  /** Arms a bounded fallback reconcile if the Home never sends `session.saved`. */
  armFallbackReconcile?(
    keepIds: ReadonlySet<BrowserSurfaceId>,
    lineageId: string,
    delayMs?: number,
  ): void;
  /** Associates a saved-lineage page with its durable Home `surfaceId`, or clears it on `null`. */
  trackSavedTab(surfaceId: BrowserSurfaceId, page: BrowserPage | null, lineageId: string): void;
  /** Flushes any pending profile tab-map write before an orderly browser close. */
  flush?(): Promise<void>;
}

export interface BrowserContext {
  /** False after whole-context/browser teardown; page closes alone keep it connected. */
  isConnected?(): boolean;
  /**
   * Restore precedes any load; other new pages submit their initial blank
   * document. `own` receives the page synchronously as soon as its handle
   * exists, before any later step can fail.
   */
  createPage(options?: {
    readonly restore?: unknown;
    readonly own?: (page: BrowserPage) => void;
  }): Promise<BrowserPage>;
  /**
   * Releases engine-held resources for a sleeping tab that will not be woken.
   * Returns true only when the tab is confirmed gone from the browser.
   */
  releaseRestore?(restore: unknown): Promise<boolean> | boolean;
  /** Present only on engines that persist and reconcile native session restore. */
  readonly sessionRestore?: BrowserSessionRestore | undefined;
  /**
   * The one handoff of native pages to the runtime: called synchronously as
   * each page handle comes to exist, before any asynchronous work, with the
   * page whose script opened it. Pages that already exist are handed off at
   * subscription. Returns the unsubscribe.
   */
  handOff(listener: (page: BrowserPage, opener: BrowserPage | null) => void): () => void;
  offPage(listener: (page: BrowserPage) => void): void;
  onPage(listener: (page: BrowserPage) => void): void;
  pages(): BrowserPage[];
}

/**
 * Names the storage partition a launched browser owns. Profile identities share
 * one partition per profile; a fresh identity gets its own per session. The two
 * namespaces are disjoint by construction, so a fresh partition can never
 * collide with a profile partition.
 */
export type BrowserPartitionKey = `profile:${string}` | `session:${string}`;

export type BrowserLaunchStorage =
  { kind: "guest" } | { kind: "local"; binding: LocalProfileBinding; directory: string };

export interface BrowserLaunchRequest {
  remainingBudgetMs?: number;
  authenticator?: import("../passkeys/authenticator.js").PasskeyAuthenticator;
  initialViewport: Viewport;
  partitionKey: BrowserPartitionKey;
  sessionId?: BrowserSessionId;
  storage: BrowserLaunchStorage;
}

/** One clipboard representation as the engine holds it. */
export interface EngineClipboardItem {
  readonly type: string;
  readonly name?: string;
  readonly bytes: Uint8Array;
}

/**
 * The page clipboard of one launched browser, isolated from the clipboard of
 * the machine it runs on. A remote person's copy, cut and paste, and the page
 * writes their input causes, run inside a scope; nothing in a scope ever reads
 * or writes the machine's clipboard, and nothing outside one reaches a person.
 */
export interface EngineClipboard {
  /** Native commands outside a scope would reach the machine clipboard (Electron). */
  readonly machineClipboardShared?: boolean;
  /**
   * Opens the browser's only logical scope, bound to `page`: its native input
   * and asynchronous page writes use exactly `input` (nothing when null).
   * Other pages and desktop writes retain their local clipboard. Scopes never overlap.
   */
  open(
    page: BrowserPage,
    input: readonly EngineClipboardItem[] | null,
  ): Promise<EngineClipboardScope>;
}

export interface EngineClipboardScope {
  /** Ends the scope and empties the page clipboard, returning what the page wrote in it, if anything. */
  close(): Promise<readonly EngineClipboardItem[] | null>;
}

export interface LaunchedBrowser {
  /** Restoration completed, independently of permission to serve user pages. */
  profile?: { ready(): Promise<void>; admit(signal?: AbortSignal): Promise<void> };
  cdp: BrowserCdpBackend;
  /** Present on engines that implement the editing contract's clipboard. */
  clipboard?: EngineClipboard;
  close(): Promise<void>;
  context: BrowserContext;
  offClose(listener: () => void): void;
  onClose(listener: () => void): void;
  /**
   * Makes the live context hold exactly `cookies` for `site`, in one cookie
   * write built by `siteCookieReplacementBatch`. Cookies outside the site's
   * scope are untouched. A local profile resolves only once the write, and any
   * session cookies Opensteer keeps for it, are persisted. Nothing is written once
   * `deadline` has aborted.
   */
  replaceSiteCookies(
    site: string,
    cookies: readonly BrowserCookie[],
    deadline: AbortSignal,
  ): Promise<void>;
}

/** Engine support for profiles stored natively on this computer. */
export interface LocalProfileEngine {
  createFiles(directory: string, binding: LocalProfileBinding, signal: AbortSignal): Promise<void>;
  readonly engine: BrowserEngine;
  /**
   * Gives up the engine's hold on a local profile directory so it can be erased.
   * Electron cannot unload a persistent Session it has created; it reports
   * `retained-until-exit`, and the directory is erased at the next start.
   */
  release(directory: string): Promise<"released" | "retained-until-exit">;
}

export interface BrowserRendererUsage {
  readonly processes: number;
  /** Total resident bytes when every attributed process was measured. */
  readonly bytes: number | null;
  readonly unassignedProcesses?: number;
}

export interface BrowserMemoryPressure {
  readonly usedBytes: number;
  readonly limitBytes: number;
}

export interface BrowserLauncher {
  readonly hostCost?: "process" | "partition";
  /** Deduplicated renderer census for this runtime, including its subframes. */
  rendererUsage?(): BrowserRendererUsage | Promise<BrowserRendererUsage>;
  /** Linux memory-pressure reading (container working set or host MemTotal - MemAvailable). */
  memoryPressure?(): BrowserMemoryPressure | null | Promise<BrowserMemoryPressure | null>;
  /** Completes engine initialization before the runtime advertises placement. */
  prepare?(): Promise<void>;
  /** Cancellation covers acquisition; the shared runtime owns the admitted host's lifetime. */
  launch(request: BrowserLaunchRequest, signal?: AbortSignal): Promise<LaunchedBrowser>;
  /** Present only on engines that implement native local profiles. */
  readonly localProfiles?: LocalProfileEngine;
}

export interface Viewport {
  devicePixelRatio: number;
  height: number;
  width: number;
}
