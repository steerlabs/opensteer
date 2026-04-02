import {
  allBrowserCapabilities,
  hasCapability,
  type BrowserCapabilities,
  type BrowserCapabilityPath,
} from "./capabilities.js";
import type {
  BrowserCoreEngine,
  BrowserInitScriptRegistration,
  BrowserInitScriptInput,
  BrowserRouteRegistration,
  BrowserRouteRegistrationInput,
  FakeBrowserCoreEngineOptions,
  GetNetworkRecordsInput,
  SessionTransportRequest,
  SessionTransportResponse,
} from "./contracts.js";
import type { StepEvent, StepResult } from "./events.js";
import {
  closedPageError,
  closedSessionError,
  createBrowserCoreError,
  staleNodeRefError,
  unsupportedCapabilityError,
} from "./errors.js";
import {
  createDevicePixelRatio,
  createPageScaleFactor,
  createPageZoomFactor,
  createPoint,
  createRect,
  createScrollOffset,
  createSize,
  rectToQuad,
  type CoordinateSpace,
  type Point,
  type Rect,
  type Size,
  type ViewportMetrics,
} from "./geometry.js";
import {
  createDocumentEpoch,
  createDocumentRef,
  createFrameRef,
  createNetworkRequestId,
  createNodeRef,
  createPageRef,
  createSessionRef,
  nextDocumentEpoch,
  type DocumentEpoch,
  type DocumentRef,
  type FrameRef,
  type NodeLocator,
  type NodeRef,
  type PageRef,
  type SessionRef,
} from "./identity.js";
import type { FrameInfo, PageInfo, PageLifecycleState } from "./metadata.js";
import {
  bodyPayloadFromUtf8,
  createHeaderEntry,
  matchesNetworkRecordFilters,
  type NetworkRecord,
} from "./network.js";
import {
  findDomSnapshotNodeByRef,
  type DomSnapshot,
  type DomSnapshotNode,
  type HitTestResult,
  type HtmlSnapshot,
  type ScreenshotArtifact,
} from "./snapshots.js";
import { filterCookieRecords, type CookieRecord, type StorageSnapshot } from "./storage.js";

interface FakeSessionState {
  readonly sessionRef: SessionRef;
  readonly pageRefs: Set<PageRef>;
  cookies: CookieRecord[];
  storage: StorageSnapshot;
  transportResponses: Map<string, SessionTransportResponse>;
}

interface FakePageState {
  readonly pageRef: PageRef;
  readonly sessionRef: SessionRef;
  readonly frameRefs: Set<FrameRef>;
  readonly queuedEvents: StepEvent[];
  history: string[];
  historyIndex: number;
  lifecycleState: PageLifecycleState;
  openerPageRef?: PageRef;
  paused: boolean;
  frozen: boolean;
  viewportMetrics: ViewportMetrics;
}

interface FakeFrameState {
  frameInfo: FrameInfo;
}

interface FakeDocumentState {
  readonly pageRef: PageRef;
  readonly frameRef: FrameRef;
  documentRef: DocumentRef;
  documentEpoch: DocumentEpoch;
  url: string;
  htmlSnapshot: HtmlSnapshot;
  domSnapshot: DomSnapshot;
  nodeText: Map<NodeRef, string | null>;
  nodeAttributes: Map<NodeRef, readonly { readonly name: string; readonly value: string }[]>;
  nodeRects: Map<NodeRef, Rect>;
  hitTests: Map<string, Omit<HitTestResult, "inputPoint" | "inputCoordinateSpace">>;
  networkRecords: NetworkRecord[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.length === 0) {
      return url;
    }
    return parsed.hostname;
  } catch {
    return url;
  }
}

function buildTransportKey(request: SessionTransportRequest): string {
  return `${request.method.toUpperCase()} ${request.url}`;
}

function stripFragment(url: string): string {
  const hashIndex = url.indexOf("#");
  return hashIndex === -1 ? url : url.slice(0, hashIndex);
}

function originFromUrl(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export class FakeBrowserCoreEngine implements BrowserCoreEngine {
  readonly capabilities: Readonly<BrowserCapabilities>;

  private readonly sessions = new Map<SessionRef, FakeSessionState>();
  private readonly pages = new Map<PageRef, FakePageState>();
  private readonly frames = new Map<FrameRef, FakeFrameState>();
  private readonly documents = new Map<DocumentRef, FakeDocumentState>();
  private readonly retiredDocuments = new Set<DocumentRef>();
  private pageCounter = 0;
  private frameCounter = 0;
  private documentCounter = 0;
  private nodeCounter = 0;
  private requestCounter = 0;
  private sessionCounter = 0;
  private stepCounter = 0;
  private eventCounter = 0;
  private timestampMs: number;

  constructor(options: FakeBrowserCoreEngineOptions = {}) {
    this.capabilities = options.capabilities ?? allBrowserCapabilities();
    this.timestampMs = options.timestampSeedMs ?? 1_700_000_000_000;

    if (options.initialPages && options.initialPages.length > 0) {
      const sessionRef = createSessionRef(`seed-${++this.sessionCounter}`);
      const storage = this.createDefaultStorage(sessionRef);
      this.sessions.set(sessionRef, {
        sessionRef,
        pageRefs: new Set<PageRef>(),
        cookies: [],
        storage,
        transportResponses: new Map(),
      });

      for (const page of options.initialPages) {
        void this.createPageInternal(sessionRef, {
          ...(page.url === undefined ? {} : { url: page.url }),
          ...(page.title === undefined ? {} : { title: page.title }),
          ...(page.viewportSize === undefined ? {} : { viewportSize: page.viewportSize }),
        });
      }
    }
  }

  enqueueStepEvents(pageRef: PageRef, events: readonly StepEvent[]): void {
    const page = this.requirePage(pageRef);
    for (const event of events) {
      this.assertEventCapability(event.kind);
      page.queuedEvents.push(clone(event));
    }
  }

  advanceDocumentEpoch(documentRef: DocumentRef): DocumentEpoch {
    const document = this.requireDocument(documentRef);
    const nextEpoch = nextDocumentEpoch(document.documentEpoch);
    this.rebuildDocumentState(documentRef, {
      documentRef,
      documentEpoch: nextEpoch,
      url: document.url,
      title: titleFromUrl(document.url),
    });
    return nextEpoch;
  }

  seedCookies(sessionRef: SessionRef, cookies: readonly CookieRecord[]): void {
    const session = this.requireSession(sessionRef);
    session.cookies = cookies.map((cookie) => clone(cookie));
  }

  seedTransportResponse(
    sessionRef: SessionRef,
    request: SessionTransportRequest,
    response: SessionTransportResponse,
  ): void {
    const session = this.requireSession(sessionRef);
    session.transportResponses.set(buildTransportKey(request), clone(response));
  }

  async addInitScript(input: BrowserInitScriptInput): Promise<BrowserInitScriptRegistration> {
    if (!hasCapability(this.capabilities, "instrumentation.initScripts")) {
      throw unsupportedCapabilityError("instrumentation.initScripts");
    }
    this.requireSession(input.sessionRef);
    return {
      registrationId: `fake-init-script-${String(++this.stepCounter)}`,
      sessionRef: input.sessionRef,
      ...(input.pageRef === undefined ? {} : { pageRef: input.pageRef }),
    };
  }

  async registerRoute(input: BrowserRouteRegistrationInput): Promise<BrowserRouteRegistration> {
    if (!hasCapability(this.capabilities, "instrumentation.routing")) {
      throw unsupportedCapabilityError("instrumentation.routing");
    }
    this.requireSession(input.sessionRef);
    return {
      routeId: `fake-route-${String(++this.stepCounter)}`,
      sessionRef: input.sessionRef,
      ...(input.pageRef === undefined ? {} : { pageRef: input.pageRef }),
      urlPattern: input.urlPattern,
    };
  }

  async createSession(): Promise<SessionRef> {
    this.requireCapability("executor.sessionLifecycle");
    const sessionRef = createSessionRef(`fake-${++this.sessionCounter}`);
    this.sessions.set(sessionRef, {
      sessionRef,
      pageRefs: new Set<PageRef>(),
      cookies: [],
      storage: this.createDefaultStorage(sessionRef),
      transportResponses: new Map(),
    });
    return sessionRef;
  }

  async closeSession(input: { readonly sessionRef: SessionRef }): Promise<void> {
    this.requireCapability("executor.sessionLifecycle");
    const session = this.requireSession(input.sessionRef);

    for (const pageRef of session.pageRefs) {
      this.destroyPage(pageRef);
    }

    this.sessions.delete(input.sessionRef);
  }

  async createPage(input: {
    readonly sessionRef: SessionRef;
    readonly openerPageRef?: PageRef;
    readonly url?: string;
  }): Promise<StepResult<PageInfo>> {
    this.requireCapability("executor.pageLifecycle");
    const session = this.requireSession(input.sessionRef);
    const page = this.createPageInternal(session.sessionRef, {
      ...(input.openerPageRef === undefined ? {} : { openerPageRef: input.openerPageRef }),
      ...(input.url === undefined ? {} : { url: input.url }),
    });

    const events: StepEvent[] = [];
    const pageCreatedEvent = this.maybeCreateEvent({
      kind: "page-created",
      sessionRef: session.sessionRef,
      pageRef: page.pageInfo.pageRef,
    });
    if (pageCreatedEvent) {
      events.push(pageCreatedEvent);
    }

    if (input.openerPageRef) {
      const popupOpenedEvent = this.maybeCreateEvent<"popup-opened">({
        kind: "popup-opened",
        sessionRef: session.sessionRef,
        pageRef: page.pageInfo.pageRef,
        openerPageRef: input.openerPageRef,
      });
      if (popupOpenedEvent) {
        events.push(popupOpenedEvent);
      }
    }

    return this.createStepResult(session.sessionRef, page.pageInfo.pageRef, {
      frameRef: page.frameInfo.frameRef,
      documentRef: page.frameInfo.documentRef,
      documentEpoch: page.frameInfo.documentEpoch,
      events,
      data: clone(page.pageInfo),
    });
  }

  async closePage(input: { readonly pageRef: PageRef }): Promise<StepResult<void>> {
    this.requireCapability("executor.pageLifecycle");
    const page = this.requirePage(input.pageRef);
    const frameInfo = this.getMainFrameInfo(page.pageRef);
    const sessionRef = page.sessionRef;
    this.destroyPage(page.pageRef);
    const pageClosedEvent = this.maybeCreateEvent({
      kind: "page-closed",
      sessionRef,
      pageRef: page.pageRef,
    });
    return this.createStepResult(sessionRef, page.pageRef, {
      frameRef: frameInfo.frameRef,
      documentRef: frameInfo.documentRef,
      documentEpoch: frameInfo.documentEpoch,
      events: pageClosedEvent ? [pageClosedEvent] : [],
      data: undefined,
    });
  }

  async activatePage(input: { readonly pageRef: PageRef }): Promise<StepResult<PageInfo>> {
    this.requireCapability("executor.pageLifecycle");
    const page = this.requirePage(input.pageRef);
    const mainFrame = this.getMainFrameInfo(page.pageRef);
    return this.createStepResult(page.sessionRef, page.pageRef, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.documentRef,
      documentEpoch: mainFrame.documentEpoch,
      events: this.drainQueuedEvents(page.pageRef),
      data: clone(this.pageInfoFromState(page)),
    });
  }

  async navigate(input: {
    readonly pageRef: PageRef;
    readonly url: string;
    readonly referrer?: string;
    readonly timeoutMs?: number;
  }): Promise<
    StepResult<{
      readonly pageInfo: PageInfo;
      readonly mainFrame: FrameInfo;
    }>
  > {
    return this.performNavigation(input.pageRef, input.url, {
      forceNewDocument: false,
      recordHistory: true,
      ...(input.referrer === undefined ? {} : { referrer: input.referrer }),
    });
  }

  async reload(input: { readonly pageRef: PageRef; readonly timeoutMs?: number }): Promise<
    StepResult<{
      readonly pageInfo: PageInfo;
      readonly mainFrame: FrameInfo;
    }>
  > {
    const page = this.requirePage(input.pageRef);
    const pageInfo = this.pageInfoFromState(page);
    return this.performNavigation(input.pageRef, pageInfo.url, {
      forceNewDocument: true,
      recordHistory: false,
    });
  }

  async goBack(input: { readonly pageRef: PageRef }): Promise<StepResult<boolean>> {
    this.requireCapability("executor.navigation");
    const page = this.requirePage(input.pageRef);
    const mainFrame = this.getMainFrameInfo(page.pageRef);
    if (page.historyIndex === 0) {
      return this.createStepResult(page.sessionRef, page.pageRef, {
        frameRef: mainFrame.frameRef,
        documentRef: mainFrame.documentRef,
        documentEpoch: mainFrame.documentEpoch,
        events: this.drainQueuedEvents(page.pageRef),
        data: false,
      });
    }

    page.historyIndex -= 1;
    const url = page.history[page.historyIndex]!;
    const result = await this.performNavigation(input.pageRef, url, {
      forceNewDocument: false,
      recordHistory: false,
    });
    return {
      ...result,
      data: true,
    };
  }

  async goForward(input: { readonly pageRef: PageRef }): Promise<StepResult<boolean>> {
    this.requireCapability("executor.navigation");
    const page = this.requirePage(input.pageRef);
    const mainFrame = this.getMainFrameInfo(page.pageRef);
    if (page.historyIndex >= page.history.length - 1) {
      return this.createStepResult(page.sessionRef, page.pageRef, {
        frameRef: mainFrame.frameRef,
        documentRef: mainFrame.documentRef,
        documentEpoch: mainFrame.documentEpoch,
        events: this.drainQueuedEvents(page.pageRef),
        data: false,
      });
    }

    page.historyIndex += 1;
    const url = page.history[page.historyIndex]!;
    const result = await this.performNavigation(input.pageRef, url, {
      forceNewDocument: false,
      recordHistory: false,
    });
    return {
      ...result,
      data: true,
    };
  }

  async stopLoading(input: { readonly pageRef: PageRef }): Promise<StepResult<void>> {
    this.requireCapability("executor.navigation");
    const page = this.requirePage(input.pageRef);
    const mainFrame = this.getMainFrameInfo(page.pageRef);
    return this.createStepResult(page.sessionRef, page.pageRef, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.documentRef,
      documentEpoch: mainFrame.documentEpoch,
      events: this.drainQueuedEvents(page.pageRef),
      data: undefined,
    });
  }

  async mouseMove(input: {
    readonly pageRef: PageRef;
    readonly point: Point;
    readonly coordinateSpace: CoordinateSpace;
  }): Promise<StepResult<void>> {
    this.requireCapability("executor.pointerInput");
    const page = this.requirePage(input.pageRef);
    const mainFrame = this.getMainFrameInfo(page.pageRef);
    return this.createStepResult(page.sessionRef, page.pageRef, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.documentRef,
      documentEpoch: mainFrame.documentEpoch,
      events: this.drainQueuedEvents(page.pageRef),
      data: undefined,
    });
  }

  async mouseClick(input: {
    readonly pageRef: PageRef;
    readonly point: Point;
    readonly coordinateSpace: CoordinateSpace;
    readonly button?: "left" | "middle" | "right";
    readonly clickCount?: number;
    readonly modifiers?: readonly ("Shift" | "Control" | "Alt" | "Meta")[];
  }): Promise<StepResult<HitTestResult | undefined>> {
    this.requireCapability("executor.pointerInput");
    const page = this.requirePage(input.pageRef);
    const hitTest = await this.hitTest({
      pageRef: input.pageRef,
      point: input.point,
      coordinateSpace: input.coordinateSpace,
    });
    const mainFrame = this.getMainFrameInfo(page.pageRef);
    return this.createStepResult(page.sessionRef, page.pageRef, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.documentRef,
      documentEpoch: mainFrame.documentEpoch,
      events: this.drainQueuedEvents(page.pageRef),
      data: hitTest,
    });
  }

  async mouseScroll(input: {
    readonly pageRef: PageRef;
    readonly point: Point;
    readonly coordinateSpace: CoordinateSpace;
    readonly delta: Point;
  }): Promise<StepResult<void>> {
    this.requireCapability("executor.pointerInput");
    const page = this.requirePage(input.pageRef);
    const mainFrame = this.getMainFrame(page.pageRef);
    const nextScroll = createScrollOffset(
      page.viewportMetrics.scrollOffset.x + input.delta.x,
      page.viewportMetrics.scrollOffset.y + input.delta.y,
    );
    page.viewportMetrics = {
      ...page.viewportMetrics,
      scrollOffset: nextScroll,
      layoutViewport: {
        ...page.viewportMetrics.layoutViewport,
        origin: createPoint(nextScroll.x, nextScroll.y),
      },
      visualViewport: {
        ...page.viewportMetrics.visualViewport,
        origin: createPoint(nextScroll.x, nextScroll.y),
      },
    };
    this.rebuildDocumentState(mainFrame.frameInfo.documentRef, {
      documentRef: mainFrame.frameInfo.documentRef,
      documentEpoch: mainFrame.frameInfo.documentEpoch,
      url: mainFrame.frameInfo.url,
      title: titleFromUrl(mainFrame.frameInfo.url),
    });
    return this.createStepResult(page.sessionRef, page.pageRef, {
      frameRef: mainFrame.frameInfo.frameRef,
      documentRef: mainFrame.frameInfo.documentRef,
      documentEpoch: mainFrame.frameInfo.documentEpoch,
      events: this.drainQueuedEvents(page.pageRef),
      data: undefined,
    });
  }

  async keyPress(input: {
    readonly pageRef: PageRef;
    readonly key: string;
    readonly modifiers?: readonly ("Shift" | "Control" | "Alt" | "Meta")[];
  }): Promise<StepResult<void>> {
    this.requireCapability("executor.keyboardInput");
    const page = this.requirePage(input.pageRef);
    const mainFrame = this.getMainFrameInfo(page.pageRef);
    return this.createStepResult(page.sessionRef, page.pageRef, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.documentRef,
      documentEpoch: mainFrame.documentEpoch,
      events: this.drainQueuedEvents(page.pageRef),
      data: undefined,
    });
  }

  async textInput(input: {
    readonly pageRef: PageRef;
    readonly text: string;
  }): Promise<StepResult<void>> {
    this.requireCapability("executor.keyboardInput");
    const page = this.requirePage(input.pageRef);
    const mainFrame = this.getMainFrameInfo(page.pageRef);
    return this.createStepResult(page.sessionRef, page.pageRef, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.documentRef,
      documentEpoch: mainFrame.documentEpoch,
      events: this.drainQueuedEvents(page.pageRef),
      data: undefined,
    });
  }

  async captureScreenshot(input: {
    readonly pageRef: PageRef;
    readonly format?: "png" | "jpeg" | "webp";
    readonly clip?: Rect;
    readonly clipSpace?: CoordinateSpace;
    readonly fullPage?: boolean;
    readonly includeCursor?: boolean;
  }): Promise<StepResult<ScreenshotArtifact>> {
    this.requireCapability("executor.screenshots");
    const page = this.requirePage(input.pageRef);
    const mainFrame = this.getMainFrameInfo(page.pageRef);
    const targetSize = input.fullPage
      ? page.viewportMetrics.contentSize
      : page.viewportMetrics.visualViewport.size;
    const payload = bodyPayloadFromUtf8(
      JSON.stringify({
        pageRef: page.pageRef,
        url: mainFrame.url,
        format: input.format ?? "webp",
        includeCursor: input.includeCursor ?? false,
      }),
      { mimeType: `image/${input.format ?? "webp"}` },
    );
    const artifact: ScreenshotArtifact = {
      pageRef: page.pageRef,
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.documentRef,
      documentEpoch: mainFrame.documentEpoch,
      payload,
      format: input.format ?? "webp",
      size: targetSize,
      coordinateSpace: input.clipSpace ?? "layout-viewport-css",
      ...(input.clip === undefined ? {} : { clip: input.clip }),
    };
    return this.createStepResult(page.sessionRef, page.pageRef, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.documentRef,
      documentEpoch: mainFrame.documentEpoch,
      events: this.drainQueuedEvents(page.pageRef),
      data: artifact,
    });
  }

  async setExecutionState(input: {
    readonly pageRef: PageRef;
    readonly paused?: boolean;
    readonly frozen?: boolean;
  }): Promise<
    StepResult<{
      readonly paused: boolean;
      readonly frozen: boolean;
    }>
  > {
    const page = this.requirePage(input.pageRef);
    const pausedChanged = input.paused !== undefined && input.paused !== page.paused;
    const frozenChanged = input.frozen !== undefined && input.frozen !== page.frozen;
    const nextPaused = input.paused ?? page.paused;
    const nextFrozen = input.frozen ?? page.frozen;

    if (pausedChanged) {
      this.requireCapability(
        nextPaused ? "executor.executionControl.pause" : "executor.executionControl.resume",
      );
    }
    if (frozenChanged) {
      this.requireCapability("executor.executionControl.freeze");
    }

    page.paused = nextPaused;
    page.frozen = nextFrozen;
    const mainFrame = this.getMainFrameInfo(page.pageRef);
    const events = this.drainQueuedEvents(page.pageRef);

    if (pausedChanged) {
      const executionEvent = this.maybeCreateEvent({
        kind: nextPaused ? "paused" : "resumed",
        sessionRef: page.sessionRef,
        pageRef: page.pageRef,
        frameRef: mainFrame.frameRef,
        documentRef: mainFrame.documentRef,
        documentEpoch: mainFrame.documentEpoch,
      });
      if (executionEvent) {
        events.push(executionEvent);
      }
    }

    if (frozenChanged && nextFrozen) {
      const frozenEvent = this.maybeCreateEvent({
        kind: "frozen",
        sessionRef: page.sessionRef,
        pageRef: page.pageRef,
        frameRef: mainFrame.frameRef,
        documentRef: mainFrame.documentRef,
        documentEpoch: mainFrame.documentEpoch,
      });
      if (frozenEvent) {
        events.push(frozenEvent);
      }
    }

    return this.createStepResult(page.sessionRef, page.pageRef, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.documentRef,
      documentEpoch: mainFrame.documentEpoch,
      events,
      data: {
        paused: page.paused,
        frozen: page.frozen,
      },
    });
  }

  async listPages(input: { readonly sessionRef: SessionRef }): Promise<readonly PageInfo[]> {
    this.requireCapability("inspector.pageEnumeration");
    const session = this.requireSession(input.sessionRef);
    return Array.from(session.pageRefs, (pageRef) =>
      clone(this.pageInfoFromState(this.requirePage(pageRef))),
    );
  }

  async drainEvents(input: { readonly pageRef: PageRef }): Promise<readonly StepEvent[]> {
    return this.drainQueuedEvents(input.pageRef);
  }

  async listFrames(input: { readonly pageRef: PageRef }): Promise<readonly FrameInfo[]> {
    this.requireCapability("inspector.frameEnumeration");
    const page = this.requirePage(input.pageRef);
    return Array.from(page.frameRefs, (frameRef) => clone(this.requireFrame(frameRef).frameInfo));
  }

  async getPageInfo(input: { readonly pageRef: PageRef }): Promise<PageInfo> {
    this.requireCapability("inspector.pageEnumeration");
    return clone(this.pageInfoFromState(this.requirePage(input.pageRef)));
  }

  async getFrameInfo(input: { readonly frameRef: FrameRef }): Promise<FrameInfo> {
    this.requireCapability("inspector.frameEnumeration");
    return clone(this.requireFrame(input.frameRef).frameInfo);
  }

  async getHtmlSnapshot(input: {
    readonly frameRef?: FrameRef;
    readonly documentRef?: DocumentRef;
  }): Promise<HtmlSnapshot> {
    this.requireCapability("inspector.html");
    const document = this.resolveDocumentInput(input);
    return clone(document.htmlSnapshot);
  }

  async getDomSnapshot(input: {
    readonly frameRef?: FrameRef;
    readonly documentRef?: DocumentRef;
  }): Promise<DomSnapshot> {
    this.requireCapability("inspector.domSnapshot");
    const document = this.resolveDocumentInput(input);
    return clone(document.domSnapshot);
  }

  async waitForVisualStability(_input: {
    readonly pageRef: PageRef;
    readonly timeoutMs?: number;
    readonly settleMs?: number;
    readonly scope?: "main-frame" | "visible-frames";
  }): Promise<void> {
    this.requireCapability("inspector.visualStability");
  }

  async readText(input: NodeLocator): Promise<string | null> {
    this.requireCapability("inspector.text");
    const document = this.requireLiveNode(input);
    return clone(document.nodeText.get(input.nodeRef) ?? null);
  }

  async readAttributes(
    input: NodeLocator,
  ): Promise<readonly { readonly name: string; readonly value: string }[]> {
    this.requireCapability("inspector.attributes");
    const document = this.requireLiveNode(input);
    return clone(document.nodeAttributes.get(input.nodeRef) ?? []);
  }

  async hitTest(input: {
    readonly pageRef: PageRef;
    readonly point: Point;
    readonly coordinateSpace: CoordinateSpace;
    readonly ignorePointerEventsNone?: boolean;
    readonly includeUserAgentShadowDom?: boolean;
  }): Promise<HitTestResult> {
    this.requireCapability("inspector.hitTest");
    const page = this.requirePage(input.pageRef);
    const mainFrame = this.getMainFrameInfo(page.pageRef);
    const document = this.requireDocument(mainFrame.documentRef);
    const resolvedPoint = this.resolvePoint(
      page.viewportMetrics,
      input.point,
      input.coordinateSpace,
    );
    const key = this.hitTestKey(resolvedPoint, input.ignorePointerEventsNone ?? false);
    const hit = document.hitTests.get(key);

    if (hit) {
      return clone({
        inputPoint: input.point,
        inputCoordinateSpace: input.coordinateSpace,
        ...hit,
      });
    }

    return {
      inputPoint: input.point,
      inputCoordinateSpace: input.coordinateSpace,
      resolvedPoint,
      resolvedCoordinateSpace: "document-css",
      pageRef: page.pageRef,
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.documentRef,
      documentEpoch: mainFrame.documentEpoch,
      obscured: false,
      pointerEventsSkipped: false,
    };
  }

  async getViewportMetrics(input: { readonly pageRef: PageRef }): Promise<ViewportMetrics> {
    this.requireCapability("inspector.viewportMetrics");
    return clone(this.requirePage(input.pageRef).viewportMetrics);
  }

  async getNetworkRecords(input: GetNetworkRecordsInput): Promise<readonly NetworkRecord[]> {
    this.requireCapability("inspector.network");
    input.signal?.throwIfAborted?.();
    const session = this.requireSession(input.sessionRef);
    const records: NetworkRecord[] = [];
    const includeBodies = input.includeBodies ?? false;
    const pageRefs = input.pageRef === undefined ? Array.from(session.pageRefs) : [input.pageRef];
    const requestIds = input.requestIds === undefined ? undefined : new Set(input.requestIds);

    for (const pageRef of pageRefs) {
      const page = this.requirePage(pageRef);
      const mainFrame = this.getMainFrame(page.pageRef);
      const document = this.requireDocument(mainFrame.frameInfo.documentRef);
      records.push(
        ...document.networkRecords
          .filter(
            (record) =>
              (requestIds === undefined || requestIds.has(record.requestId)) &&
              matchesNetworkRecordFilters(record, input),
          )
          .map((record) => clone(record)),
      );
    }

    if (!includeBodies) {
      return records.map(
        ({ requestBody: _requestBody, responseBody: _responseBody, ...record }) => ({
          ...record,
        }),
      );
    }

    this.requireCapability("inspector.networkBodies");
    return records;
  }

  async getCookies(input: {
    readonly sessionRef: SessionRef;
    readonly urls?: readonly string[];
  }): Promise<readonly CookieRecord[]> {
    this.requireCapability("inspector.cookies");
    const session = this.requireSession(input.sessionRef);
    const cookies =
      input.urls && input.urls.length > 0
        ? filterCookieRecords(session.cookies, input.urls)
        : session.cookies;
    return cookies.map((cookie) => clone(cookie));
  }

  async setCookies(input: {
    readonly sessionRef: SessionRef;
    readonly cookies: readonly CookieRecord[];
  }): Promise<void> {
    const session = this.requireSession(input.sessionRef);
    const merged = new Map(
      session.cookies.map((cookie) => [
        `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`,
        clone(cookie),
      ]),
    );
    for (const cookie of input.cookies) {
      merged.set(`${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`, clone(cookie));
    }
    session.cookies = [...merged.values()];
  }

  async getStorageSnapshot(input: {
    readonly sessionRef: SessionRef;
    readonly includeSessionStorage?: boolean;
    readonly includeIndexedDb?: boolean;
  }): Promise<StorageSnapshot> {
    const session = this.requireSession(input.sessionRef);
    this.requireCapability("inspector.localStorage");

    if (input.includeSessionStorage ?? true) {
      this.requireCapability("inspector.sessionStorage");
    }
    if (input.includeIndexedDb ?? true) {
      this.requireCapability("inspector.indexedDb");
    }

    const snapshot = clone(session.storage);
    return {
      sessionRef: snapshot.sessionRef,
      capturedAt: snapshot.capturedAt,
      origins: snapshot.origins.map((origin) => ({
        origin: origin.origin,
        localStorage: origin.localStorage,
        ...((input.includeIndexedDb ?? true) && origin.indexedDb
          ? { indexedDb: origin.indexedDb }
          : {}),
      })),
      ...((input.includeSessionStorage ?? true)
        ? { sessionStorage: snapshot.sessionStorage ?? [] }
        : {}),
    };
  }

  async evaluatePage(input: {
    readonly pageRef: PageRef;
    readonly script: string;
    readonly args?: readonly unknown[];
    readonly timeoutMs?: number;
  }): Promise<StepResult<unknown>> {
    const page = this.requirePage(input.pageRef);
    const mainFrame = this.getMainFrameInfo(page.pageRef);
    const value = await Promise.resolve().then(() => {
      const evaluated = (0, eval)(input.script) as unknown;
      if (typeof evaluated === "function") {
        return (evaluated as (...args: readonly unknown[]) => unknown)(...(input.args ?? []));
      }
      return evaluated;
    });

    return this.createStepResult(page.sessionRef, page.pageRef, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.documentRef,
      documentEpoch: mainFrame.documentEpoch,
      events: this.drainQueuedEvents(page.pageRef),
      data: clone(value),
    });
  }

  async executeRequest(input: {
    readonly sessionRef: SessionRef;
    readonly request: SessionTransportRequest;
    readonly signal?: AbortSignal;
  }): Promise<StepResult<SessionTransportResponse>> {
    this.requireCapability("transport.sessionHttp");
    input.signal?.throwIfAborted?.();
    const session = this.requireSession(input.sessionRef);
    const key = buildTransportKey(input.request);
    const seededResponse = session.transportResponses.get(key);
    const response =
      seededResponse ??
      ({
        url: input.request.url,
        status: 200,
        statusText: "OK",
        headers: [createHeaderEntry("content-type", "text/plain; charset=utf-8")],
        body: bodyPayloadFromUtf8(`${input.request.method.toUpperCase()} ${input.request.url}`, {
          mimeType: "text/plain",
        }),
        redirected: false,
      } satisfies SessionTransportResponse);

    const requestId = createNetworkRequestId(`transport-${++this.requestCounter}`);
    const transportRecord: NetworkRecord = {
      kind: "http",
      requestId,
      sessionRef: input.sessionRef,
      method: input.request.method.toUpperCase(),
      url: input.request.url,
      requestHeaders: input.request.headers ?? [],
      responseHeaders: response.headers,
      status: response.status,
      statusText: response.statusText,
      resourceType: "fetch",
      navigationRequest: false,
      captureState: "complete",
      requestBodyState: input.request.body === undefined ? "skipped" : "complete",
      responseBodyState: response.body === undefined ? "skipped" : "complete",
      ...(input.request.body === undefined ? { requestBodySkipReason: "not-present" } : {}),
      ...(response.body === undefined ? { responseBodySkipReason: "not-present" } : {}),
      ...(input.request.body === undefined ? {} : { requestBody: input.request.body }),
      ...(response.body === undefined ? {} : { responseBody: response.body }),
    };

    for (const pageRef of session.pageRefs) {
      const mainFrame = this.getMainFrame(pageRef);
      this.requireDocument(mainFrame.frameInfo.documentRef).networkRecords.push(transportRecord);
      break;
    }

    return this.createStepResult(input.sessionRef, undefined, {
      events: [],
      data: clone(response),
    });
  }

  private createPageInternal(
    sessionRef: SessionRef,
    options: {
      readonly openerPageRef?: PageRef;
      readonly url?: string;
      readonly title?: string;
      readonly viewportSize?: Size;
    },
  ): { readonly pageInfo: PageInfo; readonly frameInfo: FrameInfo } {
    const session = this.requireSession(sessionRef);
    const pageRef = createPageRef(`fake-${++this.pageCounter}`);
    const frameRef = createFrameRef(`fake-${++this.frameCounter}`);
    const documentRef = createDocumentRef(`fake-${++this.documentCounter}`);
    const documentEpoch = createDocumentEpoch(0);
    const url = options.url ?? "about:blank";
    const title = options.title ?? titleFromUrl(url);
    const viewportSize = options.viewportSize ?? createSize(1280, 720);
    const page: FakePageState = {
      pageRef,
      sessionRef,
      frameRefs: new Set([frameRef]),
      queuedEvents: [],
      history: [url],
      historyIndex: 0,
      lifecycleState: "open",
      paused: false,
      frozen: false,
      viewportMetrics: {
        layoutViewport: {
          origin: createPoint(0, 0),
          size: viewportSize,
        },
        visualViewport: {
          origin: createPoint(0, 0),
          offsetWithinLayoutViewport: createScrollOffset(0, 0),
          size: viewportSize,
        },
        scrollOffset: createScrollOffset(0, 0),
        contentSize: createSize(1280, 2400),
        devicePixelRatio: createDevicePixelRatio(2),
        pageScaleFactor: createPageScaleFactor(1),
        pageZoomFactor: createPageZoomFactor(1),
      },
      ...(options.openerPageRef === undefined ? {} : { openerPageRef: options.openerPageRef }),
    };
    const frameInfo: FrameInfo = {
      frameRef,
      pageRef,
      documentRef,
      documentEpoch,
      url,
      isMainFrame: true,
    };

    this.pages.set(pageRef, page);
    this.frames.set(frameRef, { frameInfo });
    session.pageRefs.add(pageRef);
    this.rebuildDocumentStateForFrame(pageRef, frameRef, {
      documentRef,
      documentEpoch,
      url,
      title,
    });
    session.storage = this.seedDefaultSessionStorage(session.storage, pageRef, frameRef, url);

    return {
      pageInfo: this.pageInfoFromState(page, url, title),
      frameInfo,
    };
  }

  private pageInfoFromState(page: FakePageState, url?: string, title?: string): PageInfo {
    const mainFrame = this.getMainFrameInfo(page.pageRef);
    return {
      pageRef: page.pageRef,
      sessionRef: page.sessionRef,
      url: url ?? mainFrame.url,
      title: title ?? titleFromUrl(mainFrame.url),
      lifecycleState: page.lifecycleState,
      ...(page.openerPageRef === undefined ? {} : { openerPageRef: page.openerPageRef }),
    };
  }

  private createDefaultStorage(sessionRef: SessionRef): StorageSnapshot {
    return {
      sessionRef,
      capturedAt: this.timestampMs,
      origins: [
        {
          origin: "https://example.com",
          localStorage: [
            { key: "theme", value: "dark" },
            { key: "draft", value: "hello" },
          ],
          indexedDb: [
            {
              name: "app-db",
              version: 1,
              objectStores: [
                {
                  name: "messages",
                  keyPath: "id",
                  autoIncrement: false,
                  indexes: [],
                  records: [
                    {
                      key: "1",
                      value: { id: "1", text: "hello" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      sessionStorage: [],
    };
  }

  private seedDefaultSessionStorage(
    storage: StorageSnapshot,
    pageRef: PageRef,
    frameRef: FrameRef,
    url: string,
  ): StorageSnapshot {
    const origin = originFromUrl(url);
    if (origin === undefined) {
      return storage;
    }

    if (
      storage.sessionStorage?.some(
        (snapshot) =>
          snapshot.pageRef === pageRef &&
          snapshot.frameRef === frameRef &&
          snapshot.origin === origin,
      )
    ) {
      return storage;
    }

    return {
      ...storage,
      sessionStorage: [
        ...(storage.sessionStorage ?? []),
        {
          pageRef,
          frameRef,
          origin,
          entries: [{ key: "csrf", value: "token-123" }],
        },
      ],
    };
  }

  private async performNavigation(
    pageRef: PageRef,
    url: string,
    options: {
      readonly referrer?: string;
      readonly forceNewDocument: boolean;
      readonly recordHistory: boolean;
    },
  ): Promise<
    StepResult<{
      readonly pageInfo: PageInfo;
      readonly mainFrame: FrameInfo;
    }>
  > {
    this.requireCapability("executor.navigation");
    const page = this.requirePage(pageRef);
    const mainFrame = this.getMainFrame(page.pageRef);
    const currentFrameInfo = mainFrame.frameInfo;
    const currentDocument = this.requireDocument(currentFrameInfo.documentRef);
    const sameDocument =
      !options.forceNewDocument && stripFragment(currentFrameInfo.url) === stripFragment(url);
    const title = titleFromUrl(url);
    const requestBody =
      options.referrer === undefined
        ? undefined
        : bodyPayloadFromUtf8(options.referrer, { mimeType: "text/plain" });
    const requestHeaders =
      options.referrer === undefined ? [] : [createHeaderEntry("referer", options.referrer)];

    let nextDocumentRef = currentFrameInfo.documentRef;
    let nextDocumentEpoch = currentFrameInfo.documentEpoch;

    if (sameDocument) {
      currentDocument.url = url;
      currentDocument.htmlSnapshot = {
        ...currentDocument.htmlSnapshot,
        url,
        capturedAt: this.nextTimestamp(),
      };
      currentDocument.domSnapshot = {
        ...currentDocument.domSnapshot,
        url,
        capturedAt: this.nextTimestamp(),
      };
      mainFrame.frameInfo = {
        ...currentFrameInfo,
        url,
      };
    } else {
      nextDocumentRef = createDocumentRef(`fake-${++this.documentCounter}`);
      nextDocumentEpoch = createDocumentEpoch(0);
      mainFrame.frameInfo = {
        ...currentFrameInfo,
        url,
        documentRef: nextDocumentRef,
        documentEpoch: nextDocumentEpoch,
      };
      this.rebuildDocumentStateForFrame(page.pageRef, currentFrameInfo.frameRef, {
        documentRef: nextDocumentRef,
        documentEpoch: nextDocumentEpoch,
        url,
        title,
      });
      this.retireDocument(currentFrameInfo.documentRef);

      const requestId = createNetworkRequestId(`fake-${++this.requestCounter}`);
      const responseBody = bodyPayloadFromUtf8(`<html><title>${title}</title></html>`, {
        mimeType: "text/html",
      });
      this.requireDocument(nextDocumentRef).networkRecords.push({
        kind: "http",
        requestId,
        sessionRef: page.sessionRef,
        pageRef: page.pageRef,
        frameRef: currentFrameInfo.frameRef,
        documentRef: nextDocumentRef,
        method: "GET",
        url,
        requestHeaders,
        responseHeaders: [
          createHeaderEntry("content-type", "text/html; charset=utf-8"),
          createHeaderEntry("set-cookie", "session=abc"),
          createHeaderEntry("set-cookie", "theme=dark"),
        ],
        status: 200,
        statusText: "OK",
        resourceType: "document",
        navigationRequest: true,
        captureState: "complete",
        requestBodyState: requestBody === undefined ? "skipped" : "complete",
        responseBodyState: "complete",
        ...(requestBody === undefined ? { requestBodySkipReason: "not-present" } : {}),
        timing: {
          requestStartMs: this.timestampMs,
          responseStartMs: this.timestampMs + 5,
          responseEndMs: this.timestampMs + 10,
        },
        transfer: {
          encodedBodyBytes: responseBody.capturedByteLength,
          decodedBodyBytes: responseBody.capturedByteLength,
          transferSizeBytes: responseBody.capturedByteLength + 256,
        },
        ...(requestBody === undefined ? {} : { requestBody }),
        responseBody,
      });
    }

    if (options.recordHistory) {
      page.history = [...page.history.slice(0, page.historyIndex + 1), url];
      page.historyIndex = page.history.length - 1;
    }

    const pageInfo = this.pageInfoFromState(page, url, title);
    return this.createStepResult(page.sessionRef, page.pageRef, {
      frameRef: mainFrame.frameInfo.frameRef,
      documentRef: nextDocumentRef,
      documentEpoch: nextDocumentEpoch,
      events: this.drainQueuedEvents(page.pageRef),
      data: {
        pageInfo,
        mainFrame: clone(mainFrame.frameInfo),
      },
    });
  }

  private createDocumentSnapshot(
    pageRef: PageRef,
    frameRef: FrameRef,
    documentRef: DocumentRef,
    documentEpoch: DocumentEpoch,
    url: string,
    title: string,
  ): Omit<FakeDocumentState, "pageRef" | "frameRef" | "documentRef" | "documentEpoch" | "url"> {
    const bodyRect = createRect(0, 0, 1280, 2400);
    const buttonRect = createRect(16, 16, 160, 48);
    const obscuredRect = createRect(240, 16, 160, 48);
    const titleRect = createRect(16, 96, 220, 32);
    const buttonRef = createNodeRef(`fake-${++this.nodeCounter}`);
    const obscuredRef = createNodeRef(`fake-${++this.nodeCounter}`);
    const documentNodeRef = createNodeRef(`fake-${++this.nodeCounter}`);
    const htmlNodeRef = createNodeRef(`fake-${++this.nodeCounter}`);
    const bodyNodeRef = createNodeRef(`fake-${++this.nodeCounter}`);
    const titleRef = createNodeRef(`fake-${++this.nodeCounter}`);
    const hiddenPanelRef = createNodeRef(`fake-${++this.nodeCounter}`);
    const shadowHostRef = createNodeRef(`fake-${++this.nodeCounter}`);
    const shadowActionRef = createNodeRef(`fake-${++this.nodeCounter}`);
    const nestedShadowHostRef = createNodeRef(`fake-${++this.nodeCounter}`);
    const nestedShadowActionRef = createNodeRef(`fake-${++this.nodeCounter}`);

    const nodes: DomSnapshotNode[] = [
      {
        snapshotNodeId: 1,
        nodeRef: documentNodeRef,
        childSnapshotNodeIds: [2],
        nodeType: 9,
        nodeName: "#document",
        nodeValue: "",
        attributes: [],
      },
      {
        snapshotNodeId: 2,
        nodeRef: htmlNodeRef,
        parentSnapshotNodeId: 1,
        childSnapshotNodeIds: [3],
        nodeType: 1,
        nodeName: "HTML",
        nodeValue: "",
        attributes: [],
      },
      {
        snapshotNodeId: 3,
        nodeRef: bodyNodeRef,
        parentSnapshotNodeId: 2,
        childSnapshotNodeIds: [4, 5, 6, 7, 8, 9, 10, 11],
        nodeType: 1,
        nodeName: "BODY",
        nodeValue: "",
        attributes: [],
        layout: {
          rect: bodyRect,
          quad: rectToQuad(bodyRect),
          paintOrder: 1,
        },
      },
      {
        snapshotNodeId: 4,
        nodeRef: buttonRef,
        parentSnapshotNodeId: 3,
        childSnapshotNodeIds: [],
        nodeType: 1,
        nodeName: "BUTTON",
        nodeValue: "",
        textContent: "Continue",
        attributes: [
          { name: "id", value: "continue" },
          { name: "type", value: "button" },
        ],
        layout: {
          rect: buttonRect,
          quad: rectToQuad(buttonRect),
          paintOrder: 2,
        },
      },
      {
        snapshotNodeId: 5,
        nodeRef: obscuredRef,
        parentSnapshotNodeId: 3,
        childSnapshotNodeIds: [],
        nodeType: 1,
        nodeName: "DIV",
        nodeValue: "",
        textContent: "Overlay",
        attributes: [{ name: "id", value: "overlay" }],
        layout: {
          rect: obscuredRect,
          quad: rectToQuad(obscuredRect),
          paintOrder: 3,
        },
      },
      {
        snapshotNodeId: 6,
        nodeRef: titleRef,
        parentSnapshotNodeId: 3,
        childSnapshotNodeIds: [],
        nodeType: 1,
        nodeName: "H1",
        nodeValue: "",
        textContent: "Snapshot Heading",
        attributes: [{ name: "id", value: "snapshot-title" }],
        layout: {
          rect: titleRect,
          quad: rectToQuad(titleRect),
          paintOrder: 4,
        },
      },
      {
        snapshotNodeId: 7,
        nodeRef: hiddenPanelRef,
        parentSnapshotNodeId: 3,
        childSnapshotNodeIds: [],
        nodeType: 1,
        nodeName: "DIV",
        nodeValue: "",
        textContent: "Hidden panel",
        computedStyle: {
          display: "none",
        },
        attributes: [{ name: "id", value: "hidden-panel" }],
      },
      {
        snapshotNodeId: 8,
        nodeRef: shadowHostRef,
        parentSnapshotNodeId: 3,
        childSnapshotNodeIds: [],
        nodeType: 1,
        nodeName: "DIV",
        nodeValue: "",
        textContent: "",
        attributes: [{ name: "id", value: "shadow-host" }],
      },
      {
        snapshotNodeId: 9,
        nodeRef: shadowActionRef,
        parentSnapshotNodeId: 3,
        childSnapshotNodeIds: [],
        shadowHostNodeRef: shadowHostRef,
        nodeType: 1,
        nodeName: "BUTTON",
        nodeValue: "",
        textContent: "Shadow Action",
        attributes: [{ name: "id", value: "shadow-action" }],
      },
      {
        snapshotNodeId: 10,
        nodeRef: nestedShadowHostRef,
        parentSnapshotNodeId: 3,
        childSnapshotNodeIds: [],
        nodeType: 1,
        nodeName: "DIV",
        nodeValue: "",
        textContent: "",
        attributes: [{ name: "id", value: "nested-shadow-host" }],
      },
      {
        snapshotNodeId: 11,
        nodeRef: nestedShadowActionRef,
        parentSnapshotNodeId: 3,
        childSnapshotNodeIds: [],
        shadowHostNodeRef: nestedShadowHostRef,
        nodeType: 1,
        nodeName: "BUTTON",
        nodeValue: "",
        textContent: "Nested Shadow",
        attributes: [{ name: "id", value: "nested-shadow-action" }],
      },
    ];

    const domSnapshot: DomSnapshot = {
      pageRef,
      frameRef,
      documentRef,
      documentEpoch,
      url,
      capturedAt: this.timestampMs,
      rootSnapshotNodeId: 1,
      shadowDomMode: "flattened",
      geometryCoordinateSpace: "document-css",
      nodes,
    };

    const nodeText = new Map<NodeRef, string | null>([
      [buttonRef, "Continue"],
      [obscuredRef, "Overlay"],
      [titleRef, "Snapshot Heading"],
      [hiddenPanelRef, "Hidden panel"],
      [shadowHostRef, ""],
      [shadowActionRef, "Shadow Action"],
      [nestedShadowHostRef, ""],
      [nestedShadowActionRef, "Nested Shadow"],
      [documentNodeRef, null],
      [htmlNodeRef, null],
      [bodyNodeRef, null],
    ]);
    const nodeAttributes = new Map<
      NodeRef,
      readonly { readonly name: string; readonly value: string }[]
    >([
      [buttonRef, nodes[3]!.attributes],
      [obscuredRef, nodes[4]!.attributes],
      [titleRef, nodes[5]!.attributes],
      [hiddenPanelRef, nodes[6]!.attributes],
      [shadowHostRef, nodes[7]!.attributes],
      [shadowActionRef, nodes[8]!.attributes],
      [nestedShadowHostRef, nodes[9]!.attributes],
      [nestedShadowActionRef, nodes[10]!.attributes],
      [documentNodeRef, []],
      [htmlNodeRef, []],
      [bodyNodeRef, []],
    ]);
    const nodeRects = new Map<NodeRef, Rect>([
      [buttonRef, buttonRect],
      [obscuredRef, obscuredRect],
      [titleRef, titleRect],
      [bodyNodeRef, bodyRect],
    ]);
    const hitTests = new Map<string, Omit<HitTestResult, "inputPoint" | "inputCoordinateSpace">>([
      [
        this.hitTestKey(createPoint(20, 20), false),
        {
          resolvedPoint: createPoint(20, 20),
          resolvedCoordinateSpace: "document-css",
          pageRef,
          frameRef,
          documentRef,
          documentEpoch,
          nodeRef: buttonRef,
          targetQuad: rectToQuad(buttonRect),
          obscured: false,
          pointerEventsSkipped: false,
        },
      ],
      [
        this.hitTestKey(createPoint(260, 20), false),
        {
          resolvedPoint: createPoint(260, 20),
          resolvedCoordinateSpace: "document-css",
          pageRef,
          frameRef,
          documentRef,
          documentEpoch,
          nodeRef: obscuredRef,
          targetQuad: rectToQuad(obscuredRect),
          obscured: true,
          pointerEventsSkipped: false,
        },
      ],
      [
        this.hitTestKey(createPoint(20, 20), true),
        {
          resolvedPoint: createPoint(20, 20),
          resolvedCoordinateSpace: "document-css",
          pageRef,
          frameRef,
          documentRef,
          documentEpoch,
          nodeRef: buttonRef,
          targetQuad: rectToQuad(buttonRect),
          obscured: false,
          pointerEventsSkipped: true,
        },
      ],
    ]);

    return {
      htmlSnapshot: {
        pageRef,
        frameRef,
        documentRef,
        documentEpoch,
        url,
        capturedAt: this.timestampMs,
        html:
          `<html><head><title>${title}</title></head><body>` +
          `<button id="continue" type="button">Continue</button>` +
          `<div id="overlay">Overlay</div>` +
          `<h1 id="snapshot-title">Snapshot Heading</h1>` +
          `<div id="hidden-panel" style="display:none">Hidden panel</div>` +
          `<div id="shadow-host"></div>` +
          `<button id="shadow-action">Shadow Action</button>` +
          `<div id="nested-shadow-host"></div>` +
          `<button id="nested-shadow-action">Nested Shadow</button>` +
          `</body></html>`,
      },
      domSnapshot,
      nodeText,
      nodeAttributes,
      nodeRects,
      hitTests,
      networkRecords: [],
    };
  }

  private rebuildDocumentStateForFrame(
    pageRef: PageRef,
    frameRef: FrameRef,
    input: {
      readonly documentRef: DocumentRef;
      readonly documentEpoch: DocumentEpoch;
      readonly url: string;
      readonly title: string;
    },
  ): void {
    const nextState = this.createDocumentSnapshot(
      pageRef,
      frameRef,
      input.documentRef,
      input.documentEpoch,
      input.url,
      input.title,
    );

    this.retiredDocuments.delete(input.documentRef);
    this.documents.set(input.documentRef, {
      pageRef,
      frameRef,
      documentRef: input.documentRef,
      documentEpoch: input.documentEpoch,
      url: input.url,
      ...nextState,
    });
  }

  private rebuildDocumentState(
    documentRef: DocumentRef,
    input: {
      readonly documentRef: DocumentRef;
      readonly documentEpoch: DocumentEpoch;
      readonly url: string;
      readonly title: string;
    },
  ): void {
    const existing = this.requireDocument(documentRef);
    this.rebuildDocumentStateForFrame(existing.pageRef, existing.frameRef, input);
    const frame = this.requireFrame(existing.frameRef);
    frame.frameInfo = {
      ...frame.frameInfo,
      documentRef: input.documentRef,
      documentEpoch: input.documentEpoch,
      url: input.url,
    };
  }

  private resolveDocumentInput(input: {
    readonly frameRef?: FrameRef;
    readonly documentRef?: DocumentRef;
  }): FakeDocumentState {
    if (input.frameRef && input.documentRef) {
      throw createBrowserCoreError(
        "invalid-argument",
        "provide either frameRef or documentRef, not both",
      );
    }

    if (input.documentRef) {
      return this.requireDocument(input.documentRef);
    }

    if (input.frameRef) {
      return this.requireDocument(this.requireFrame(input.frameRef).frameInfo.documentRef);
    }

    throw createBrowserCoreError("invalid-argument", "either frameRef or documentRef is required");
  }

  private requireLiveNode(input: NodeLocator): FakeDocumentState {
    if (this.retiredDocuments.has(input.documentRef)) {
      throw staleNodeRefError(input);
    }

    const document = this.requireDocument(input.documentRef);
    if (document.documentEpoch !== input.documentEpoch) {
      throw staleNodeRefError(input);
    }

    const node = findDomSnapshotNodeByRef(document.domSnapshot, input.nodeRef);
    if (!node) {
      throw staleNodeRefError(input);
    }

    return document;
  }

  private resolvePoint(
    metrics: ViewportMetrics,
    point: Point,
    coordinateSpace: CoordinateSpace,
  ): Point {
    switch (coordinateSpace) {
      case "document-css":
        return point;
      case "layout-viewport-css":
      case "visual-viewport-css":
        return createPoint(point.x + metrics.scrollOffset.x, point.y + metrics.scrollOffset.y);
      case "computer-display-css":
        throw createBrowserCoreError(
          "unsupported-capability",
          `coordinate space ${coordinateSpace} is not supported by the fake engine`,
          {
            details: {
              coordinateSpace,
            },
          },
        );
      case "window":
      case "screen":
      case "device-pixel":
        return createPoint(
          point.x / metrics.devicePixelRatio + metrics.scrollOffset.x,
          point.y / metrics.devicePixelRatio + metrics.scrollOffset.y,
        );
    }

    throw createBrowserCoreError(
      "invalid-argument",
      `coordinate space ${coordinateSpace} is not supported by the fake engine`,
    );
  }

  private hitTestKey(point: Point, ignorePointerEventsNone: boolean): string {
    return `${Math.round(point.x)}:${Math.round(point.y)}:${ignorePointerEventsNone ? "ignore" : "respect"}`;
  }

  private requireCapability(path: BrowserCapabilityPath): void {
    if (!hasCapability(this.capabilities, path)) {
      throw unsupportedCapabilityError(path);
    }
  }

  private assertEventCapability(kind: StepEvent["kind"]): void {
    const capability = this.eventCapabilityForKind(kind);
    if (!hasCapability(this.capabilities, capability)) {
      throw unsupportedCapabilityError(capability);
    }
  }

  private eventCapabilityForKind(kind: StepEvent["kind"]): BrowserCapabilityPath {
    switch (kind) {
      case "page-created":
      case "popup-opened":
      case "page-closed":
        return "events.pageLifecycle";
      case "dialog-opened":
        return "events.dialog";
      case "download-started":
      case "download-finished":
        return "events.download";
      case "chooser-opened":
        return "events.chooser";
      case "worker-created":
      case "worker-destroyed":
        return "events.worker";
      case "console":
        return "events.console";
      case "page-error":
        return "events.pageError";
      case "websocket-opened":
      case "websocket-frame":
      case "websocket-closed":
        return "events.websocket";
      case "event-stream-message":
        return "events.eventStream";
      case "paused":
      case "resumed":
      case "frozen":
        return "events.executionState";
    }
  }

  private createEvent<TKind extends StepEvent["kind"]>(
    value: Omit<Extract<StepEvent, { readonly kind: TKind }>, "eventId" | "timestamp">,
  ): Extract<StepEvent, { readonly kind: TKind }> {
    this.assertEventCapability(value.kind);
    return {
      ...value,
      eventId: `event:${++this.eventCounter}`,
      timestamp: this.nextTimestamp(),
    } as Extract<StepEvent, { readonly kind: TKind }>;
  }

  private maybeCreateEvent<TKind extends StepEvent["kind"]>(
    value: Omit<Extract<StepEvent, { readonly kind: TKind }>, "eventId" | "timestamp">,
  ): Extract<StepEvent, { readonly kind: TKind }> | undefined {
    if (!hasCapability(this.capabilities, this.eventCapabilityForKind(value.kind))) {
      return undefined;
    }

    return this.createEvent(value);
  }

  private createStepResult<TData>(
    sessionRef: SessionRef,
    pageRef: PageRef | undefined,
    input: {
      readonly frameRef?: FrameRef;
      readonly documentRef?: DocumentRef;
      readonly documentEpoch?: DocumentEpoch;
      readonly events: readonly StepEvent[];
      readonly data: TData;
    },
  ): StepResult<TData> {
    const startedAt = this.nextTimestamp();
    const completedAt = this.nextTimestamp();
    return {
      stepId: `step:${++this.stepCounter}`,
      sessionRef,
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
      events: input.events.map((event) => clone(event)),
      data: clone(input.data),
      ...(pageRef === undefined ? {} : { pageRef }),
      ...(input.frameRef === undefined ? {} : { frameRef: input.frameRef }),
      ...(input.documentRef === undefined ? {} : { documentRef: input.documentRef }),
      ...(input.documentEpoch === undefined ? {} : { documentEpoch: input.documentEpoch }),
    };
  }

  private drainQueuedEvents(pageRef: PageRef): StepEvent[] {
    const page = this.requirePage(pageRef);
    const events = page.queuedEvents.splice(0, page.queuedEvents.length);
    return events.map((event) => clone(event));
  }

  private requireSession(sessionRef: SessionRef): FakeSessionState {
    const session = this.sessions.get(sessionRef);
    if (!session) {
      throw closedSessionError(sessionRef);
    }
    return session;
  }

  private requirePage(pageRef: PageRef): FakePageState {
    const page = this.pages.get(pageRef);
    if (!page || page.lifecycleState === "closed") {
      throw closedPageError(pageRef);
    }
    return page;
  }

  private requireFrame(frameRef: FrameRef): FakeFrameState {
    const frame = this.frames.get(frameRef);
    if (!frame) {
      throw createBrowserCoreError("not-found", `frame ${frameRef} was not found`, {
        details: { frameRef },
      });
    }
    return frame;
  }

  private requireDocument(documentRef: DocumentRef): FakeDocumentState {
    const document = this.documents.get(documentRef);
    if (!document) {
      throw createBrowserCoreError("not-found", `document ${documentRef} was not found`, {
        details: { documentRef },
      });
    }
    return document;
  }

  private getMainFrame(pageRef: PageRef): FakeFrameState {
    const page = this.requirePage(pageRef);
    const mainFrameRef = Array.from(page.frameRefs).find(
      (frameRef) => this.requireFrame(frameRef).frameInfo.isMainFrame,
    );
    if (!mainFrameRef) {
      throw createBrowserCoreError("operation-failed", `page ${pageRef} has no main frame`);
    }
    return this.requireFrame(mainFrameRef);
  }

  private getMainFrameInfo(pageRef: PageRef): FrameInfo {
    return clone(this.getMainFrame(pageRef).frameInfo);
  }

  private destroyPage(pageRef: PageRef): void {
    const page = this.requirePage(pageRef);
    page.lifecycleState = "closed";
    this.pages.delete(pageRef);
    const session = this.requireSession(page.sessionRef);
    session.pageRefs.delete(pageRef);

    for (const frameRef of page.frameRefs) {
      const frame = this.frames.get(frameRef);
      if (!frame) {
        continue;
      }
      this.documents.delete(frame.frameInfo.documentRef);
      this.frames.delete(frameRef);
    }
  }

  private retireDocument(documentRef: DocumentRef): void {
    this.documents.delete(documentRef);
    this.retiredDocuments.add(documentRef);
  }

  private nextTimestamp(): number {
    return (this.timestampMs += 5);
  }
}

export function createFakeBrowserCoreEngine(
  options: FakeBrowserCoreEngineOptions = {},
): FakeBrowserCoreEngine {
  const capabilities = options.capabilities ?? allBrowserCapabilities();
  return new FakeBrowserCoreEngine({ ...options, capabilities });
}
