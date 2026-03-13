import type { BrowserCapabilities } from "./capabilities.js";
import type { StepResult } from "./events.js";
import type { CoordinateSpace, Point, Rect, Size, ViewportMetrics } from "./geometry.js";
import type {
  DocumentEpoch,
  DocumentRef,
  FrameRef,
  NodeLocator,
  NodeRef,
  PageRef,
  SessionRef,
} from "./identity.js";
import type { FrameInfo, PageInfo } from "./metadata.js";
import type { BodyPayload, HeaderEntry, NetworkRecord } from "./network.js";
import type {
  DomSnapshot,
  HitTestResult,
  HtmlSnapshot,
  ScreenshotArtifact,
  ScreenshotFormat,
} from "./snapshots.js";
import type { CookieRecord, StorageSnapshot } from "./storage.js";

export type MouseButton = "left" | "middle" | "right";

export type KeyModifier = "Shift" | "Control" | "Alt" | "Meta";

export interface SessionTransportRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: readonly HeaderEntry[];
  readonly body?: BodyPayload;
  readonly timeoutMs?: number;
  readonly followRedirects?: boolean;
}

export interface SessionTransportResponse {
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly HeaderEntry[];
  readonly body?: BodyPayload;
  readonly redirected: boolean;
}

export interface BrowserExecutor {
  readonly capabilities: Readonly<BrowserCapabilities>;

  createSession(): Promise<SessionRef>;
  closeSession(input: { readonly sessionRef: SessionRef }): Promise<void>;
  createPage(input: {
    readonly sessionRef: SessionRef;
    readonly openerPageRef?: PageRef;
    readonly url?: string;
  }): Promise<StepResult<PageInfo>>;
  closePage(input: { readonly pageRef: PageRef }): Promise<StepResult<void>>;
  activatePage(input: { readonly pageRef: PageRef }): Promise<StepResult<PageInfo>>;
  navigate(input: {
    readonly pageRef: PageRef;
    readonly url: string;
    readonly referrer?: string;
    readonly timeoutMs?: number;
  }): Promise<
    StepResult<{
      readonly pageInfo: PageInfo;
      readonly mainFrame: FrameInfo;
    }>
  >;
  reload(input: { readonly pageRef: PageRef; readonly timeoutMs?: number }): Promise<
    StepResult<{
      readonly pageInfo: PageInfo;
      readonly mainFrame: FrameInfo;
    }>
  >;
  goBack(input: { readonly pageRef: PageRef }): Promise<StepResult<boolean>>;
  goForward(input: { readonly pageRef: PageRef }): Promise<StepResult<boolean>>;
  stopLoading(input: { readonly pageRef: PageRef }): Promise<StepResult<void>>;
  mouseMove(input: {
    readonly pageRef: PageRef;
    readonly point: Point;
    readonly coordinateSpace: CoordinateSpace;
  }): Promise<StepResult<void>>;
  mouseClick(input: {
    readonly pageRef: PageRef;
    readonly point: Point;
    readonly coordinateSpace: CoordinateSpace;
    readonly button?: MouseButton;
    readonly clickCount?: number;
    readonly modifiers?: readonly KeyModifier[];
  }): Promise<StepResult<HitTestResult | undefined>>;
  mouseScroll(input: {
    readonly pageRef: PageRef;
    readonly point: Point;
    readonly coordinateSpace: CoordinateSpace;
    readonly delta: Point;
  }): Promise<StepResult<void>>;
  keyPress(input: {
    readonly pageRef: PageRef;
    readonly key: string;
    readonly modifiers?: readonly KeyModifier[];
  }): Promise<StepResult<void>>;
  textInput(input: { readonly pageRef: PageRef; readonly text: string }): Promise<StepResult<void>>;
  captureScreenshot(input: {
    readonly pageRef: PageRef;
    readonly format?: ScreenshotFormat;
    readonly clip?: Rect;
    readonly clipSpace?: CoordinateSpace;
    readonly fullPage?: boolean;
    readonly includeCursor?: boolean;
  }): Promise<StepResult<ScreenshotArtifact>>;
  setExecutionState(input: {
    readonly pageRef: PageRef;
    readonly paused?: boolean;
    readonly frozen?: boolean;
  }): Promise<
    StepResult<{
      readonly paused: boolean;
      readonly frozen: boolean;
    }>
  >;
}

export interface BrowserInspector {
  readonly capabilities: Readonly<BrowserCapabilities>;

  listPages(input: { readonly sessionRef: SessionRef }): Promise<readonly PageInfo[]>;
  listFrames(input: { readonly pageRef: PageRef }): Promise<readonly FrameInfo[]>;
  getPageInfo(input: { readonly pageRef: PageRef }): Promise<PageInfo>;
  getFrameInfo(input: { readonly frameRef: FrameRef }): Promise<FrameInfo>;
  getHtmlSnapshot(input: {
    readonly frameRef?: FrameRef;
    readonly documentRef?: DocumentRef;
  }): Promise<HtmlSnapshot>;
  getDomSnapshot(input: {
    readonly frameRef?: FrameRef;
    readonly documentRef?: DocumentRef;
  }): Promise<DomSnapshot>;
  readText(input: NodeLocator): Promise<string | null>;
  readAttributes(
    input: NodeLocator,
  ): Promise<readonly { readonly name: string; readonly value: string }[]>;
  hitTest(input: {
    readonly pageRef: PageRef;
    readonly point: Point;
    readonly coordinateSpace: CoordinateSpace;
    readonly ignorePointerEventsNone?: boolean;
    readonly includeUserAgentShadowDom?: boolean;
  }): Promise<HitTestResult>;
  getViewportMetrics(input: { readonly pageRef: PageRef }): Promise<ViewportMetrics>;
  getNetworkRecords(input: {
    readonly sessionRef: SessionRef;
    readonly pageRef?: PageRef;
    readonly includeBodies?: boolean;
  }): Promise<readonly NetworkRecord[]>;
  getCookies(input: {
    readonly sessionRef: SessionRef;
    readonly urls?: readonly string[];
  }): Promise<readonly CookieRecord[]>;
  getStorageSnapshot(input: {
    readonly sessionRef: SessionRef;
    readonly includeSessionStorage?: boolean;
    readonly includeIndexedDb?: boolean;
  }): Promise<StorageSnapshot>;
}

export interface SessionTransportExecutor {
  readonly capabilities: Readonly<BrowserCapabilities>;

  executeRequest(input: {
    readonly sessionRef: SessionRef;
    readonly request: SessionTransportRequest;
  }): Promise<StepResult<SessionTransportResponse>>;
}

export interface BrowserCoreEngine
  extends BrowserExecutor, BrowserInspector, SessionTransportExecutor {}

export interface FakeBrowserCorePageSeed {
  readonly url?: string;
  readonly title?: string;
  readonly viewportSize?: Size;
}

export interface FakeBrowserCoreEngineOptions {
  readonly capabilities?: BrowserCapabilities;
  readonly timestampSeedMs?: number;
  readonly initialPages?: readonly FakeBrowserCorePageSeed[];
}
