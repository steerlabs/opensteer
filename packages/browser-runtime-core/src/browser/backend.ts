import type { BrowserCdpBackend, CdpChannel, CdpParameters } from "@opensteer/browser-core";
import type { BrowserCookie } from "@opensteer/browser-profile/cookies";
import type {
  BrowserCaptureDescriptor,
  BrowserEngine,
  BrowserSessionId,
  LocalProfileBinding,
} from "@opensteer/protocol/browser";
import type { PageSize } from "./surface-ledger.js";

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

/** Engine operations never own native focus; active-surface selection belongs to the ledger. */
export interface BrowserPage {
  readonly capture?: PageCapturePort;
  /**
   * Observes compositing after geometry acknowledgement, outside its lock.
   * Electron cannot identify the metrics revision of those pixels: an already
   * composed frame of this page can satisfy it, without a duration bound if
   * rendering stalls. Cancellation never waits for paint; no timeout is readiness.
   */
  settleRendering?(signal?: AbortSignal): Promise<void>;
  /**
   * Gives the page the ledger's geometry. An engine without it has the ledger
   * apply the person's size as device emulation.
   */
  applyGeometry?(geometry: PageGeometry): Promise<void>;
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
  agentCdp(): Promise<CdpSession>;
  cdp(): Promise<CdpSession>;
  close(): Promise<void>;
  isClosed(): boolean;
  offClose(listener: () => void): void;
  offMetadataChanged(listener: () => void): void;
  onClose(listener: () => void): void;
  onMetadataChanged(listener: () => void): void;
  opener(): Promise<BrowserPage | null>;
  targetId(): Promise<string>;
  title(): Promise<string>;
  url(): string;
}

export interface BrowserContext {
  /** False after whole-context/browser teardown; page closes alone keep it connected. */
  isConnected?(): boolean;
  /** New user pages, including eager launch pages, have their initial blank document submitted. */
  createPage(): Promise<BrowserPage>;
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

export interface BrowserLauncher {
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
