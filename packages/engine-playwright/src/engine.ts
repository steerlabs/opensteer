import {
  createBodyPayload,
  createBrowserCoreError,
  createChooserRef,
  createDocumentEpoch,
  createNodeLocator,
  createDocumentRef,
  createDownloadRef,
  createFrameRef,
  createHeaderEntry,
  createNetworkRequestId,
  createNodeRef,
  createPageRef,
  createPoint,
  createSessionRef,
  createSize,
  createDialogRef,
  matchesNetworkRecordFilters,
  waitForCdpVisualStability,
  unsupportedCapabilityError,
  staleNodeRefError,
  closedPageError,
  closedSessionError,
  type GetNetworkRecordsInput,
  type BrowserCoreEngine,
  type CoordinateSpace,
  type DocumentEpoch,
  type DocumentRef,
  type DomSnapshot,
  type FrameInfo,
  type FrameRef,
  type HitTestResult,
  type HtmlSnapshot,
  type KeyModifier,
  type MouseButton,
  type NetworkRecord,
  type NodeLocator,
  type NodeRef,
  type PageInfo,
  type PageRef,
  type Point,
  type Rect,
  type ScreenshotArtifact,
  type ScreenshotFormat,
  type SessionRef,
  type SessionStorageSnapshot,
  type SessionTransportRequest,
  type SessionTransportResponse,
  type StepEvent,
  type StepResult,
  type StorageEntry,
  type StorageSnapshot,
  type ViewportMetrics,
  type CookieRecord,
} from "@opensteer/browser-core";
import { chromium, type Browser, type BrowserContext } from "playwright";
import {
  OPENSTEER_COMPUTER_USE_BRIDGE_SYMBOL,
  OPENSTEER_DOM_ACTION_BRIDGE_SYMBOL,
  type ComputerUseBridge,
  type DomActionBridge,
} from "@opensteer/protocol";
import type {
  CDPSession,
  ConsoleMessage,
  Dialog,
  Download,
  Frame,
  Page,
  Request,
  Response,
} from "playwright";

import type {
  SessionState,
  PendingPageRegistration,
  PageController,
  FrameState,
  DocumentState,
  FrameDescriptor,
  FrameTreeNode,
  NetworkRecordState,
  CapturedDomSnapshot,
  ExtendedStorageState,
} from "./types.js";
import {
  PLAYWRIGHT_BROWSER_CORE_CAPABILITIES,
  DEFAULT_BODY_CAPTURE_LIMIT_BYTES,
  asChromiumBrowser,
  buildContextOptions,
  buildLaunchOptions,
  type PlaywrightBrowserContextOptions,
  type PlaywrightBrowserCoreEngineOptions,
} from "./options.js";
import {
  clone,
  normalizeSameSite,
  normalizeResourceType,
  normalizeDialogType,
  normalizeConsoleLevel,
  captureBodyPayload,
  combineFrameUrl,
  interleavedAttributesToEntries,
  mapScreenshotFormat,
} from "./normalize.js";
import { toDocumentPoint, toViewportPoint, toViewportRect } from "./coordinate.js";
import {
  capturePageDomSnapshot,
  findCapturedDocument,
  updateDocumentTreeSignature,
  buildDomSnapshot as buildDomSnapshotFromCapture,
  resolveCapturedContentDocumentRef,
  findHtmlBackendNodeId,
  readTextContent,
} from "./dom.js";
import {
  unsupportedCursorCapture,
  normalizePlaywrightError,
  isContextClosedError,
  shouldIgnoreBackgroundTaskError,
  rethrowNodeLookupError,
} from "./errors.js";
import { createPlaywrightComputerUseBridge } from "./computer-use.js";
import { createPlaywrightDomActionBridge } from "./dom-action-bridge.js";
import {
  captureLayoutViewportScreenshotArtifact,
  getViewportMetricsFromCdp,
} from "./viewport-screenshot.js";

export type {
  PlaywrightChromiumLaunchOptions,
  PlaywrightBrowserContextOptions,
  AdoptedChromiumBrowser,
  PlaywrightBrowserCoreEngineOptions,
} from "./options.js";

export class PlaywrightBrowserCoreEngine implements BrowserCoreEngine {
  readonly capabilities = PLAYWRIGHT_BROWSER_CORE_CAPABILITIES;

  private readonly browser: Browser;
  private readonly closeBrowserOnDispose: boolean;
  private readonly contextOptions: PlaywrightBrowserContextOptions | undefined;
  private readonly options: PlaywrightBrowserCoreEngineOptions;
  private readonly bodyCaptureLimitBytes: number;
  private readonly sessions = new Map<SessionRef, SessionState>();
  private readonly pages = new Map<PageRef, PageController>();
  private readonly frames = new Map<FrameRef, FrameState>();
  private readonly documents = new Map<DocumentRef, DocumentState>();
  private readonly retiredDocuments = new Set<DocumentRef>();
  private readonly pageByPlaywrightPage = new WeakMap<Page, PageController>();
  private readonly pendingPopupOpeners = new WeakMap<Page, PageRef>();
  private readonly preassignedPopupPageRefs = new WeakMap<Page, PageRef>();
  private pageCounter = 0;
  private frameCounter = 0;
  private documentCounter = 0;
  private nodeCounter = 0;
  private requestCounter = 0;
  private sessionCounter = 0;
  private eventCounter = 0;
  private stepCounter = 0;
  private computerUseBridge: ComputerUseBridge | undefined;
  private domActionBridge: DomActionBridge | undefined;
  private disposed = false;

  private constructor(
    browser: Browser,
    closeBrowserOnDispose: boolean,
    options: PlaywrightBrowserCoreEngineOptions,
  ) {
    this.browser = browser;
    this.closeBrowserOnDispose = closeBrowserOnDispose;
    this.options = options;
    this.contextOptions = options.context;
    this.bodyCaptureLimitBytes = options.bodyCaptureLimitBytes ?? DEFAULT_BODY_CAPTURE_LIMIT_BYTES;
  }

  static async create(
    options: PlaywrightBrowserCoreEngineOptions = {},
  ): Promise<PlaywrightBrowserCoreEngine> {
    if (options.browser) {
      if (options.browser.browserType().name() !== "chromium") {
        throw createBrowserCoreError(
          "unsupported-capability",
          "only Chromium browsers are supported by this backend",
        );
      }
      return new PlaywrightBrowserCoreEngine(
        asChromiumBrowser(options.browser),
        options.closeBrowserOnDispose ?? false,
        options,
      );
    }

    const launched = await chromium.launch(buildLaunchOptions(options.launch));
    return new PlaywrightBrowserCoreEngine(launched, true, options);
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    for (const sessionRef of Array.from(this.sessions.keys())) {
      await this.closeSession({ sessionRef });
    }

    if (this.closeBrowserOnDispose) {
      await this.browser.close();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  [OPENSTEER_COMPUTER_USE_BRIDGE_SYMBOL](): ComputerUseBridge {
    this.computerUseBridge ??= createPlaywrightComputerUseBridge({
      resolveController: (pageRef) => this.requirePage(pageRef),
      flushPendingPageTasks: (sessionRef) => this.flushPendingPageTasks(sessionRef),
      flushDomUpdateTask: (controller) => this.flushDomUpdateTask(controller),
      requireMainFrame: (controller) => this.requireMainFrame(controller),
      drainQueuedEvents: (pageRef) => this.drainQueuedEvents(pageRef),
      withModifiers: (page, modifiers, action) => this.withModifiers(page, modifiers, action),
    });
    return this.computerUseBridge;
  }

  [OPENSTEER_DOM_ACTION_BRIDGE_SYMBOL](): DomActionBridge {
    this.domActionBridge ??= createPlaywrightDomActionBridge({
      resolveController: (pageRef: PageRef) => this.requirePage(pageRef),
      flushPendingPageTasks: (sessionRef: SessionRef) => this.flushPendingPageTasks(sessionRef),
      flushDomUpdateTask: (controller) => this.flushDomUpdateTask(controller),
      locateBackendNode: (document, backendNodeId) =>
        createNodeLocator(
          document.documentRef,
          document.documentEpoch,
          this.nodeRefForBackendNode(document, backendNodeId),
        ),
      requireLiveNode: (locator) => this.requireLiveNode(locator),
    });
    return this.domActionBridge;
  }

  async createSession(): Promise<SessionRef> {
    this.assertNotDisposed();
    const sessionRef = createSessionRef(`playwright-${++this.sessionCounter}`);
    const context =
      this.options.attachedContext ?? (await this.browser.newContext(buildContextOptions(this.contextOptions)));
    const session: SessionState = {
      sessionRef,
      context,
      pageRefs: new Set<PageRef>(),
      networkRecords: [],
      pendingRegistrations: [],
      pendingPageTasks: new Set(),
      initialPage: this.options.attachedPage,
      closeContextOnSessionClose:
        this.options.attachedContext === undefined
          ? true
          : this.options.closeAttachedContextOnSessionClose ?? false,
      activePageRef: undefined,
    };
    this.sessions.set(sessionRef, session);

    context.on("page", (page) => {
      const task = this.handleContextPage(session, page).catch((error) => {
        if (isContextClosedError(error)) {
          return;
        }
        throw error;
      });
      session.pendingPageTasks.add(task);
      void task.finally(() => {
        session.pendingPageTasks.delete(task);
      });
    });

    if (session.initialPage) {
      const task = this.handleAttachedInitialPage(session, session.initialPage).catch((error) => {
        if (isContextClosedError(error)) {
          return;
        }
        throw error;
      });
      session.pendingPageTasks.add(task);
      void task.finally(() => {
        session.pendingPageTasks.delete(task);
      });
    }

    return sessionRef;
  }

  async closeSession(input: { readonly sessionRef: SessionRef }): Promise<void> {
    const session = this.requireSession(input.sessionRef);
    for (const controller of Array.from(this.pages.values())) {
      if (controller.sessionRef === session.sessionRef) {
        controller.explicitCloseInFlight = true;
      }
    }
    if (session.closeContextOnSessionClose) {
      await session.context.close();
    }
    for (const pageRef of Array.from(session.pageRefs)) {
      const controller = this.pages.get(pageRef);
      if (controller) {
        this.cleanupPageController(controller);
      }
    }
    this.sessions.delete(session.sessionRef);
  }

  async createPage(input: {
    readonly sessionRef: SessionRef;
    readonly openerPageRef?: PageRef;
    readonly url?: string;
  }): Promise<StepResult<PageInfo>> {
    const session = this.requireSession(input.sessionRef);
    const startedAt = Date.now();
    if (session.initialPage) {
      const initialPage = session.initialPage;
      session.initialPage = undefined;
      const controller = this.pageByPlaywrightPage.get(initialPage)
        ?? (await this.initializePageController(session, initialPage, input.openerPageRef, true));
      if (input.url) {
        await controller.page.goto(input.url, {
          waitUntil: "domcontentloaded",
        });
        controller.lastKnownTitle = await this.readTitle(controller.page, controller.lastKnownTitle);
      }
      session.activePageRef = controller.pageRef;
      await this.flushPendingPageTasks(session.sessionRef);
      await this.flushDomUpdateTask(controller);
      const mainFrame = this.requireMainFrame(controller);
      return this.createStepResult(session.sessionRef, controller.pageRef, startedAt, {
        frameRef: mainFrame.frameRef,
        documentRef: mainFrame.currentDocument.documentRef,
        documentEpoch: mainFrame.currentDocument.documentEpoch,
        events: this.drainQueuedEvents(controller.pageRef),
        data: await this.buildPageInfo(controller),
      });
    }

    const controllerPromise = new Promise<PageController>((resolve, reject) => {
      session.pendingRegistrations.push({
        ...(input.openerPageRef === undefined ? {} : { openerPageRef: input.openerPageRef }),
        resolve,
        reject,
      });
    });

    const createdPage = await session.context.newPage();
    const controller = await controllerPromise;
    if (controller.page !== createdPage) {
      throw createBrowserCoreError("operation-failed", "manual page registration desynchronized");
    }

    if (input.url) {
      await controller.page.goto(input.url, {
        waitUntil: "domcontentloaded",
      });
      controller.lastKnownTitle = await this.readTitle(controller.page, controller.lastKnownTitle);
    }
    session.activePageRef = controller.pageRef;
    await this.flushPendingPageTasks(session.sessionRef);
    await this.flushDomUpdateTask(controller);

    const mainFrame = this.requireMainFrame(controller);
    return this.createStepResult(session.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: this.drainQueuedEvents(controller.pageRef),
      data: await this.buildPageInfo(controller),
    });
  }

  async closePage(input: { readonly pageRef: PageRef }): Promise<StepResult<void>> {
    const controller = this.requirePage(input.pageRef);
    const startedAt = Date.now();
    const mainFrame = this.requireMainFrame(controller);
    const queued = this.drainQueuedEvents(controller.pageRef);
    controller.explicitCloseInFlight = true;
    if (!controller.externallyOwned) {
      await controller.page.close();
    }
    this.cleanupPageController(controller);
    const pageClosedEvent = this.createEvent<"page-closed">({
      kind: "page-closed",
      sessionRef: controller.sessionRef,
      pageRef: controller.pageRef,
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
    });

    return this.createStepResult(controller.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: [...queued, pageClosedEvent],
      data: undefined,
    });
  }

  async activatePage(input: { readonly pageRef: PageRef }): Promise<StepResult<PageInfo>> {
    const controller = this.requirePage(input.pageRef);
    this.requireSession(controller.sessionRef).activePageRef = controller.pageRef;
    const startedAt = Date.now();
    await controller.page.bringToFront();
    controller.lastKnownTitle = await this.readTitle(controller.page, controller.lastKnownTitle);
    await this.flushPendingPageTasks(controller.sessionRef);
    await this.flushDomUpdateTask(controller);
    const mainFrame = this.requireMainFrame(controller);

    return this.createStepResult(controller.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: this.drainQueuedEvents(controller.pageRef),
      data: await this.buildPageInfo(controller),
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
    const controller = this.requirePage(input.pageRef);
    const startedAt = Date.now();
    try {
      await controller.page.goto(input.url, {
        waitUntil: "domcontentloaded",
        ...(input.referrer === undefined ? {} : { referer: input.referrer }),
        ...(input.timeoutMs === undefined ? {} : { timeout: input.timeoutMs }),
      });
    } catch (error) {
      throw normalizePlaywrightError(error, input.pageRef);
    }
    controller.lastKnownTitle = await this.readTitle(controller.page, controller.lastKnownTitle);
    await this.flushPendingPageTasks(controller.sessionRef);
    await this.flushDomUpdateTask(controller);
    const mainFrame = this.requireMainFrame(controller);

    return this.createStepResult(controller.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: this.drainQueuedEvents(controller.pageRef),
      data: {
        pageInfo: await this.buildPageInfo(controller),
        mainFrame: this.buildFrameInfo(mainFrame),
      },
    });
  }

  async reload(input: { readonly pageRef: PageRef; readonly timeoutMs?: number }): Promise<
    StepResult<{
      readonly pageInfo: PageInfo;
      readonly mainFrame: FrameInfo;
    }>
  > {
    const controller = this.requirePage(input.pageRef);
    const startedAt = Date.now();
    try {
      await controller.page.reload({
        waitUntil: "domcontentloaded",
        ...(input.timeoutMs === undefined ? {} : { timeout: input.timeoutMs }),
      });
    } catch (error) {
      throw normalizePlaywrightError(error, input.pageRef);
    }
    controller.lastKnownTitle = await this.readTitle(controller.page, controller.lastKnownTitle);
    await this.flushPendingPageTasks(controller.sessionRef);
    await this.flushDomUpdateTask(controller);
    const mainFrame = this.requireMainFrame(controller);

    return this.createStepResult(controller.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: this.drainQueuedEvents(controller.pageRef),
      data: {
        pageInfo: await this.buildPageInfo(controller),
        mainFrame: this.buildFrameInfo(mainFrame),
      },
    });
  }

  async goBack(input: { readonly pageRef: PageRef }): Promise<StepResult<boolean>> {
    const controller = this.requirePage(input.pageRef);
    const startedAt = Date.now();
    const beforeHistory = await controller.cdp.send("Page.getNavigationHistory");
    try {
      await controller.page.goBack();
    } catch (error) {
      throw normalizePlaywrightError(error, input.pageRef);
    }
    controller.lastKnownTitle = await this.readTitle(controller.page, controller.lastKnownTitle);
    await this.flushPendingPageTasks(controller.sessionRef);
    await this.flushDomUpdateTask(controller);
    const mainFrame = this.requireMainFrame(controller);
    const afterHistory = await controller.cdp.send("Page.getNavigationHistory");
    const changed = afterHistory.currentIndex !== beforeHistory.currentIndex;

    return this.createStepResult(controller.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: this.drainQueuedEvents(controller.pageRef),
      data: changed,
    });
  }

  async goForward(input: { readonly pageRef: PageRef }): Promise<StepResult<boolean>> {
    const controller = this.requirePage(input.pageRef);
    const startedAt = Date.now();
    const beforeHistory = await controller.cdp.send("Page.getNavigationHistory");
    try {
      await controller.page.goForward();
    } catch (error) {
      throw normalizePlaywrightError(error, input.pageRef);
    }
    controller.lastKnownTitle = await this.readTitle(controller.page, controller.lastKnownTitle);
    await this.flushPendingPageTasks(controller.sessionRef);
    await this.flushDomUpdateTask(controller);
    const mainFrame = this.requireMainFrame(controller);
    const afterHistory = await controller.cdp.send("Page.getNavigationHistory");
    const changed = afterHistory.currentIndex !== beforeHistory.currentIndex;

    return this.createStepResult(controller.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: this.drainQueuedEvents(controller.pageRef),
      data: changed,
    });
  }

  async stopLoading(input: { readonly pageRef: PageRef }): Promise<StepResult<void>> {
    const controller = this.requirePage(input.pageRef);
    const startedAt = Date.now();
    await controller.cdp.send("Page.stopLoading");
    await this.flushPendingPageTasks(controller.sessionRef);
    const mainFrame = this.requireMainFrame(controller);

    return this.createStepResult(controller.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: this.drainQueuedEvents(controller.pageRef),
      data: undefined,
    });
  }

  async mouseMove(input: {
    readonly pageRef: PageRef;
    readonly point: Point;
    readonly coordinateSpace: CoordinateSpace;
  }): Promise<StepResult<void>> {
    const controller = this.requirePage(input.pageRef);
    const startedAt = Date.now();
    const metrics = await this.getViewportMetrics({ pageRef: input.pageRef });
    const point = toViewportPoint(metrics, input.point, input.coordinateSpace);
    await controller.page.mouse.move(point.x, point.y);
    await this.flushPendingPageTasks(controller.sessionRef);
    const mainFrame = this.requireMainFrame(controller);

    return this.createStepResult(controller.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: this.drainQueuedEvents(controller.pageRef),
      data: undefined,
    });
  }

  async mouseClick(input: {
    readonly pageRef: PageRef;
    readonly point: Point;
    readonly coordinateSpace: CoordinateSpace;
    readonly button?: MouseButton;
    readonly clickCount?: number;
    readonly modifiers?: readonly KeyModifier[];
  }): Promise<StepResult<HitTestResult | undefined>> {
    const controller = this.requirePage(input.pageRef);
    const startedAt = Date.now();
    const hit = await this.hitTest({
      pageRef: input.pageRef,
      point: input.point,
      coordinateSpace: input.coordinateSpace,
    }).catch(() => undefined);
    const metrics = await this.getViewportMetrics({ pageRef: input.pageRef });
    const point = toViewportPoint(metrics, input.point, input.coordinateSpace);
    await this.withModifiers(controller.page, input.modifiers, async () => {
      await controller.page.mouse.click(point.x, point.y, {
        ...(input.button === undefined ? {} : { button: input.button }),
        ...(input.clickCount === undefined ? {} : { clickCount: input.clickCount }),
      });
    });
    await this.flushPendingPageTasks(controller.sessionRef);
    const mainFrame = this.requireMainFrame(controller);

    return this.createStepResult(controller.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: this.drainQueuedEvents(controller.pageRef),
      data: hit,
    });
  }

  async mouseScroll(input: {
    readonly pageRef: PageRef;
    readonly point: Point;
    readonly coordinateSpace: CoordinateSpace;
    readonly delta: Point;
  }): Promise<StepResult<void>> {
    const controller = this.requirePage(input.pageRef);
    const startedAt = Date.now();
    const metrics = await this.getViewportMetrics({ pageRef: input.pageRef });
    const point = toViewportPoint(metrics, input.point, input.coordinateSpace);
    await controller.page.mouse.move(point.x, point.y);
    await controller.page.mouse.wheel(input.delta.x, input.delta.y);
    await controller.page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const raf = (
            globalThis as typeof globalThis & {
              requestAnimationFrame: (callback: () => void) => number;
            }
          ).requestAnimationFrame;
          raf(() => resolve());
        }),
    );
    await this.flushPendingPageTasks(controller.sessionRef);
    await this.flushDomUpdateTask(controller);
    const mainFrame = this.requireMainFrame(controller);

    return this.createStepResult(controller.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: this.drainQueuedEvents(controller.pageRef),
      data: undefined,
    });
  }

  async keyPress(input: {
    readonly pageRef: PageRef;
    readonly key: string;
    readonly modifiers?: readonly KeyModifier[];
  }): Promise<StepResult<void>> {
    const controller = this.requirePage(input.pageRef);
    const startedAt = Date.now();
    await this.withModifiers(controller.page, input.modifiers, async () => {
      await controller.page.keyboard.press(input.key);
    });
    await this.flushPendingPageTasks(controller.sessionRef);
    const mainFrame = this.requireMainFrame(controller);

    return this.createStepResult(controller.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: this.drainQueuedEvents(controller.pageRef),
      data: undefined,
    });
  }

  async textInput(input: {
    readonly pageRef: PageRef;
    readonly text: string;
  }): Promise<StepResult<void>> {
    const controller = this.requirePage(input.pageRef);
    const startedAt = Date.now();
    await controller.page.keyboard.type(input.text);
    await this.flushPendingPageTasks(controller.sessionRef);
    const mainFrame = this.requireMainFrame(controller);

    return this.createStepResult(controller.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: this.drainQueuedEvents(controller.pageRef),
      data: undefined,
    });
  }

  async captureScreenshot(input: {
    readonly pageRef: PageRef;
    readonly format?: ScreenshotFormat;
    readonly clip?: Rect;
    readonly clipSpace?: CoordinateSpace;
    readonly fullPage?: boolean;
    readonly includeCursor?: boolean;
  }): Promise<StepResult<ScreenshotArtifact>> {
    const controller = this.requirePage(input.pageRef);
    const startedAt = Date.now();
    if (input.includeCursor) {
      unsupportedCursorCapture();
    }

    const format = mapScreenshotFormat(input.format);
    const metrics = await this.getViewportMetrics({ pageRef: input.pageRef });
    let clip:
      | {
          readonly x: number;
          readonly y: number;
          readonly width: number;
          readonly height: number;
          readonly scale: number;
        }
      | undefined;
    let size = input.fullPage ? metrics.contentSize : metrics.visualViewport.size;
    let coordinateSpace: CoordinateSpace = input.clipSpace ?? "layout-viewport-css";

    if (input.clip) {
      const viewportRect = toViewportRect(
        metrics,
        input.clip,
        input.clipSpace ?? "layout-viewport-css",
      );
      clip = {
        x: viewportRect.x,
        y: viewportRect.y,
        width: viewportRect.width,
        height: viewportRect.height,
        scale: 1,
      };
      size = createSize(input.clip.width, input.clip.height);
      coordinateSpace = input.clipSpace ?? "layout-viewport-css";
    } else if (input.fullPage) {
      clip = {
        x: 0,
        y: 0,
        width: metrics.contentSize.width,
        height: metrics.contentSize.height,
        scale: 1,
      };
      coordinateSpace = "document-css";
    }

    await this.flushPendingPageTasks(controller.sessionRef);
    const mainFrame = this.requireMainFrame(controller);
    let artifact: ScreenshotArtifact;
    if (clip === undefined && !input.fullPage) {
      artifact = (await captureLayoutViewportScreenshotArtifact(controller, mainFrame, format))
        .artifact;
    } else {
      const response = await controller.cdp.send("Page.captureScreenshot", {
        format,
        ...(clip === undefined ? {} : { clip }),
        ...(input.fullPage ? { captureBeyondViewport: true } : {}),
        fromSurface: true,
      });
      artifact = {
        pageRef: controller.pageRef,
        frameRef: mainFrame.frameRef,
        documentRef: mainFrame.currentDocument.documentRef,
        documentEpoch: mainFrame.currentDocument.documentEpoch,
        payload: createBodyPayload(new Uint8Array(Buffer.from(response.data, "base64")), {
          mimeType: `image/${format}`,
        }),
        format,
        size,
        coordinateSpace,
        ...(input.clip === undefined ? {} : { clip: input.clip }),
      };
    }

    return this.createStepResult(controller.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: this.drainQueuedEvents(controller.pageRef),
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
    const controller = this.requirePage(input.pageRef);
    const startedAt = Date.now();

    if (input.paused !== undefined) {
      throw unsupportedCapabilityError(
        input.paused ? "executor.executionControl.pause" : "executor.executionControl.resume",
      );
    }

    if (input.frozen !== undefined && input.frozen !== controller.frozen) {
      await controller.cdp.send("Page.setWebLifecycleState", {
        state: input.frozen ? "frozen" : "active",
      });
      controller.frozen = input.frozen;
    }

    await this.flushPendingPageTasks(controller.sessionRef);
    const mainFrame = this.requireMainFrame(controller);
    return this.createStepResult(controller.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: this.drainQueuedEvents(controller.pageRef),
      data: {
        paused: false,
        frozen: controller.frozen,
      },
    });
  }

  async listPages(input: { readonly sessionRef: SessionRef }): Promise<readonly PageInfo[]> {
    const session = this.requireSession(input.sessionRef);
    const infos = await Promise.all(
      Array.from(session.pageRefs, async (pageRef) =>
        this.buildPageInfo(this.requirePage(pageRef)),
      ),
    );
    return infos;
  }

  async listFrames(input: { readonly pageRef: PageRef }): Promise<readonly FrameInfo[]> {
    const controller = this.requirePage(input.pageRef);
    await this.flushDomUpdateTask(controller);
    return Array.from(controller.framesByCdpId.values())
      .map((frame) => this.buildFrameInfo(frame))
      .sort((left, right) => Number(right.isMainFrame) - Number(left.isMainFrame));
  }

  async getPageInfo(input: { readonly pageRef: PageRef }): Promise<PageInfo> {
    return this.buildPageInfo(this.requirePage(input.pageRef));
  }

  async getFrameInfo(input: { readonly frameRef: FrameRef }): Promise<FrameInfo> {
    const frame = this.requireFrame(input.frameRef);
    await this.flushDomUpdateTask(this.requirePage(frame.pageRef));
    return this.buildFrameInfo(frame);
  }

  async getHtmlSnapshot(input: {
    readonly frameRef?: FrameRef;
    readonly documentRef?: DocumentRef;
  }): Promise<HtmlSnapshot> {
    const document = this.resolveDocumentTarget(input);
    const controller = this.requirePage(document.pageRef);
    await this.flushDomUpdateTask(controller);
    const captured = await this.captureDomSnapshot(controller, document);
    const rootElementBackendNodeId = findHtmlBackendNodeId(captured, document);
    if (rootElementBackendNodeId === undefined) {
      throw createBrowserCoreError(
        "operation-failed",
        `document ${document.documentRef} does not expose an HTML root element`,
      );
    }
    const { outerHTML } = await controller.cdp.send("DOM.getOuterHTML", {
      backendNodeId: rootElementBackendNodeId,
      includeShadowDOM: true,
    });

    return {
      pageRef: document.pageRef,
      frameRef: document.frameRef,
      documentRef: document.documentRef,
      documentEpoch: document.documentEpoch,
      url: document.url,
      capturedAt: captured.capturedAt,
      html: outerHTML,
    };
  }

  async getDomSnapshot(input: {
    readonly frameRef?: FrameRef;
    readonly documentRef?: DocumentRef;
  }): Promise<DomSnapshot> {
    const document = this.resolveDocumentTarget(input);
    const controller = this.requirePage(document.pageRef);
    await this.flushDomUpdateTask(controller);
    const captured = await this.captureDomSnapshot(controller, document);
    return buildDomSnapshotFromCapture(
      document,
      captured,
      (doc, backendNodeId) => this.nodeRefForBackendNode(doc, backendNodeId),
      (contentDocIndex) =>
        resolveCapturedContentDocumentRef(controller.framesByCdpId, captured, contentDocIndex),
    );
  }

  async waitForVisualStability(input: {
    readonly pageRef: PageRef;
    readonly timeoutMs?: number;
    readonly settleMs?: number;
    readonly scope?: "main-frame" | "visible-frames";
  }): Promise<void> {
    const controller = this.requirePage(input.pageRef);
    await this.flushDomUpdateTask(controller);
    await waitForCdpVisualStability(controller.cdp, {
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.settleMs === undefined ? {} : { settleMs: input.settleMs }),
      ...(input.scope === undefined ? {} : { scope: input.scope }),
    });
    await this.flushDomUpdateTask(controller);
  }

  async readText(input: NodeLocator): Promise<string | null> {
    const document = this.requireDocument(input.documentRef);
    const controller = this.requirePage(document.pageRef);
    await this.flushDomUpdateTask(controller);
    const { document: liveDocument } = this.requireLiveNode(input);
    const captured = await this.captureDomSnapshot(controller, liveDocument);
    const snapshot = buildDomSnapshotFromCapture(
      liveDocument,
      captured,
      (doc, backendNodeId) => this.nodeRefForBackendNode(doc, backendNodeId),
      (contentDocIndex) =>
        resolveCapturedContentDocumentRef(controller.framesByCdpId, captured, contentDocIndex),
    );
    return readTextContent(snapshot, input);
  }

  async readAttributes(
    input: NodeLocator,
  ): Promise<readonly { readonly name: string; readonly value: string }[]> {
    const document = this.requireDocument(input.documentRef);
    const controller = this.requirePage(document.pageRef);
    await this.flushDomUpdateTask(controller);
    const { document: liveDocument, backendNodeId } = this.requireLiveNode(input);
    try {
      await controller.cdp.send("DOM.getDocument", { depth: 0 });
      const frontend = await controller.cdp.send("DOM.pushNodesByBackendIdsToFrontend", {
        backendNodeIds: [backendNodeId],
      });
      const nodeId = frontend.nodeIds[0];
      if (nodeId === undefined) {
        throw staleNodeRefError(input);
      }
      const { attributes } = await controller.cdp.send("DOM.getAttributes", { nodeId });
      const normalized = interleavedAttributesToEntries(attributes).map((entry) => ({
        name: entry.key,
        value: entry.value,
      }));
      return normalized;
    } catch (error) {
      rethrowNodeLookupError(error, liveDocument, input);
    }
  }

  async hitTest(input: {
    readonly pageRef: PageRef;
    readonly point: Point;
    readonly coordinateSpace: CoordinateSpace;
    readonly ignorePointerEventsNone?: boolean;
    readonly includeUserAgentShadowDom?: boolean;
  }): Promise<HitTestResult> {
    const controller = this.requirePage(input.pageRef);
    await this.flushDomUpdateTask(controller);
    const metrics = await this.getViewportMetrics({ pageRef: input.pageRef });
    const viewportPoint = toViewportPoint(metrics, input.point, input.coordinateSpace);
    const documentPoint = toDocumentPoint(metrics, input.point, input.coordinateSpace);
    const hitTestPoint = {
      x: Math.round(viewportPoint.x),
      y: Math.round(viewportPoint.y),
    };
    const raw = await controller.cdp.send("DOM.getNodeForLocation", {
      x: hitTestPoint.x,
      y: hitTestPoint.y,
      ...(input.includeUserAgentShadowDom === undefined
        ? {}
        : { includeUserAgentShadowDOM: input.includeUserAgentShadowDom }),
      ...(input.ignorePointerEventsNone === undefined
        ? {}
        : { ignorePointerEventsNone: input.ignorePointerEventsNone }),
    });

    const frame = controller.framesByCdpId.get(raw.frameId);
    if (!frame) {
      throw createBrowserCoreError("frame-detached", `frame ${raw.frameId} is no longer attached`);
    }
    const document = frame.currentDocument;
    const nodeRef = this.nodeRefForBackendNode(document, raw.backendNodeId);
    let targetQuad: HitTestResult["targetQuad"] | undefined;
    if (frame.isMainFrame) {
      try {
        await controller.cdp.send("DOM.getDocument", { depth: 0 });
        const frontend = await controller.cdp.send("DOM.pushNodesByBackendIdsToFrontend", {
          backendNodeIds: [raw.backendNodeId],
        });
        const nodeId = frontend.nodeIds[0];
        if (nodeId !== undefined) {
          const quads = await controller.cdp.send("DOM.getContentQuads", { nodeId });
          const quad = quads.quads[0];
          if (quad && quad.length === 8) {
            targetQuad = [
              createPoint(quad[0]! + metrics.scrollOffset.x, quad[1]! + metrics.scrollOffset.y),
              createPoint(quad[2]! + metrics.scrollOffset.x, quad[3]! + metrics.scrollOffset.y),
              createPoint(quad[4]! + metrics.scrollOffset.x, quad[5]! + metrics.scrollOffset.y),
              createPoint(quad[6]! + metrics.scrollOffset.x, quad[7]! + metrics.scrollOffset.y),
            ];
          }
        }
      } catch {
        targetQuad = undefined;
      }
    }

    return {
      inputPoint: input.point,
      inputCoordinateSpace: input.coordinateSpace,
      resolvedPoint: documentPoint,
      resolvedCoordinateSpace: "document-css",
      pageRef: controller.pageRef,
      frameRef: frame.frameRef,
      documentRef: document.documentRef,
      documentEpoch: document.documentEpoch,
      ...(nodeRef === undefined ? {} : { nodeRef }),
      ...(targetQuad === undefined ? {} : { targetQuad }),
      obscured: false,
      pointerEventsSkipped: input.ignorePointerEventsNone ?? false,
    };
  }

  async getViewportMetrics(input: { readonly pageRef: PageRef }): Promise<ViewportMetrics> {
    const controller = this.requirePage(input.pageRef);
    return getViewportMetricsFromCdp(controller);
  }

  async getNetworkRecords(input: GetNetworkRecordsInput): Promise<readonly NetworkRecord[]> {
    const session = this.requireSession(input.sessionRef);
    input.signal?.throwIfAborted?.();

    const requestIds = input.requestIds === undefined ? undefined : new Set(input.requestIds);
    const records = session.networkRecords.filter((record) => {
      if (input.pageRef !== undefined && record.pageRef !== input.pageRef) {
        return false;
      }
      if (requestIds !== undefined && !requestIds.has(record.requestId)) {
        return false;
      }
      return matchesNetworkRecordFilters(
        {
          url: record.url,
          method: record.method,
          resourceType: record.resourceType,
          ...(record.status === undefined ? {} : { status: record.status }),
        },
        input,
      );
    });

    if (!(input.includeBodies ?? false)) {
      return records.map(({ requestBody: _requestBody, responseBody: _responseBody, ...record }) =>
        clone(record as Omit<NetworkRecord, "requestBody" | "responseBody">),
      );
    }

    await raceWithAbort(
      Promise.all(
        records.map(async (record) => {
          const controller = this.resolvePageForNetworkRecord(record);
          if (!controller) {
            if (record.requestBodyState === "pending") {
              record.requestBodyState = "failed";
              record.requestBodyError = "request body capture is unavailable because the page is closed";
            }
            if (record.responseBodyState === "pending") {
              record.responseBodyState = "failed";
              record.responseBodyError = "response body capture is unavailable because the page is closed";
            }
            return;
          }
          await this.materializeNetworkRecordBodies(record, controller);
        }),
      ),
      input.signal,
    );

    return records.map((record) => clone(record as NetworkRecord));
  }

  async getCookies(input: {
    readonly sessionRef: SessionRef;
    readonly urls?: readonly string[];
  }): Promise<readonly CookieRecord[]> {
    const session = this.requireSession(input.sessionRef);
    const cookies = await session.context.cookies(input.urls ?? []);
    return cookies.map((cookie) => {
      const sameSite = normalizeSameSite(cookie.sameSite);
      return {
        sessionRef: input.sessionRef,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        ...(sameSite === undefined ? {} : { sameSite }),
        ...(cookie.partitionKey === undefined ? {} : { partitionKey: cookie.partitionKey }),
        session: cookie.expires === -1,
        ...(cookie.expires === -1 ? { expiresAt: null } : { expiresAt: cookie.expires * 1000 }),
      };
    });
  }

  async getStorageSnapshot(input: {
    readonly sessionRef: SessionRef;
    readonly includeSessionStorage?: boolean;
    readonly includeIndexedDb?: boolean;
  }): Promise<StorageSnapshot> {
    const session = this.requireSession(input.sessionRef);
    const includeSessionStorage = input.includeSessionStorage ?? true;
    const includeIndexedDb = input.includeIndexedDb ?? true;
    const state = (await session.context.storageState({
      indexedDB: includeIndexedDb,
    })) as ExtendedStorageState;

    const origins = state.origins.map((origin) => {
      const normalized = {
        origin: origin.origin,
        localStorage: origin.localStorage.map((entry) => ({
          key: entry.name,
          value: entry.value,
        })),
      };

      if (!includeIndexedDb || !origin.indexedDB) {
        return normalized;
      }

      return {
        ...normalized,
        indexedDb: origin.indexedDB.map((database) => ({
          name: database.name,
          version: database.version,
          objectStores: database.stores.map((store) => ({
            name: store.name,
            ...((store.keyPathArray?.length ?? 0) > 0
              ? { keyPath: [...store.keyPathArray!] }
              : store.keyPath === undefined
                ? {}
                : { keyPath: store.keyPath }),
            autoIncrement: store.autoIncrement,
            records: store.records.map((record) => ({
              key: record.key ?? record.keyEncoded ?? null,
              value: record.value ?? record.valueEncoded ?? null,
            })),
          })),
        })),
      };
    });

    const sessionStorage = includeSessionStorage
      ? await this.collectSessionStorageSnapshots(session)
      : undefined;

    return {
      sessionRef: input.sessionRef,
      capturedAt: Date.now(),
      origins,
      ...(sessionStorage === undefined ? {} : { sessionStorage }),
    };
  }

  async evaluatePage(input: {
    readonly pageRef: PageRef;
    readonly script: string;
    readonly args?: readonly unknown[];
    readonly timeoutMs?: number;
  }): Promise<StepResult<unknown>> {
    const controller = this.requirePage(input.pageRef);
    const startedAt = Date.now();
    const mainFrame = this.requireMainFrame(controller);

    try {
      const result = await withTimeout(
        controller.page.evaluate(
          ({ script, args }) => {
            const evaluated = (0, eval)(script) as unknown;
            if (typeof evaluated === "function") {
              return (evaluated as (...args: readonly unknown[]) => unknown)(...(args ?? []));
            }
            return evaluated;
          },
          {
            script: input.script,
            args: input.args ?? [],
          },
        ),
        input.timeoutMs,
      );

      return this.createStepResult(controller.sessionRef, controller.pageRef, startedAt, {
        frameRef: mainFrame.frameRef,
        documentRef: mainFrame.currentDocument.documentRef,
        documentEpoch: mainFrame.currentDocument.documentEpoch,
        events: this.drainQueuedEvents(controller.pageRef),
        data: result,
      });
    } catch (error) {
      throw normalizePlaywrightError(error, controller.pageRef);
    }
  }

  async executeRequest(input: {
    readonly sessionRef: SessionRef;
    readonly request: SessionTransportRequest;
    readonly signal?: AbortSignal;
  }): Promise<StepResult<SessionTransportResponse>> {
    const session = this.requireSession(input.sessionRef);
    const startedAt = Date.now();
    const pageRef = session.activePageRef ?? Array.from(session.pageRefs)[0];
    const controller = pageRef === undefined ? undefined : this.pages.get(pageRef);
    const mainFrame = controller === undefined ? undefined : this.requireMainFrame(controller);

    const headersObject = Object.fromEntries(
      (input.request.headers ?? []).map((header) => [header.name, header.value]),
    );
    const requestBodyBytes =
      input.request.body === undefined ? undefined : Buffer.from(input.request.body.bytes);

    let response: Awaited<ReturnType<BrowserContext["request"]["fetch"]>>;
    try {
      input.signal?.throwIfAborted?.();
      response = await raceWithAbort(
        session.context.request.fetch(input.request.url, {
          method: input.request.method,
          headers: headersObject,
          ...(requestBodyBytes === undefined ? {} : { data: requestBodyBytes }),
          failOnStatusCode: false,
          ...(input.request.timeoutMs === undefined ? {} : { timeout: input.request.timeoutMs }),
          ...(input.request.followRedirects === false ? { maxRedirects: 0 } : {}),
        }),
        input.signal,
      );
    } catch (error) {
      if (pageRef !== undefined) {
        throw normalizePlaywrightError(error, pageRef);
      }
      throw createBrowserCoreError(
        "operation-failed",
        `session ${input.sessionRef} failed to execute a session HTTP request`,
      );
    }

    const responseHeaders = (await response.headersArray()).map((header) =>
      createHeaderEntry(header.name, header.value),
    );
    const responseContentType = responseHeaders.find(
      (header) => header.name.toLowerCase() === "content-type",
    )?.value;
    let responseBody: ReturnType<typeof captureBodyPayload> | undefined;
    const responseBodySkipReason = getResponseBodySkipReasonForMetadata({
      method: input.request.method.toUpperCase(),
      status: response.status(),
      resourceType: "fetch",
      url: response.url(),
      captureState: "complete",
    });
    try {
      responseBody =
        responseBodySkipReason === undefined
          ? captureBodyPayload(
              await response.body(),
              responseContentType ?? undefined,
              this.bodyCaptureLimitBytes,
            )
          : undefined;
    } catch {
      responseBody = undefined;
    }

    const requestId = createNetworkRequestId(`transport-${++this.requestCounter}`);
    const record: NetworkRecordState = {
      kind: "http",
      requestId,
      sessionRef: input.sessionRef,
      cdpRequestId: undefined,
      pageRef,
      frameRef: mainFrame?.frameRef,
      documentRef: mainFrame?.currentDocument.documentRef,
      method: input.request.method.toUpperCase(),
      url: input.request.url,
      requestHeaders: (input.request.headers ?? []).map((header) =>
        createHeaderEntry(header.name, header.value),
      ),
      responseHeaders,
      status: response.status(),
      statusText: response.statusText(),
      resourceType: "fetch",
      redirectFromRequestId: undefined,
      redirectToRequestId: undefined,
      navigationRequest: false,
      timing: undefined,
      transfer: undefined,
      source: undefined,
      captureState: "complete",
      requestBodyState: input.request.body === undefined ? "skipped" : "complete",
      responseBodyState: responseBody === undefined ? "skipped" : "complete",
      requestBodySkipReason: input.request.body === undefined ? "not-present" : undefined,
      responseBodySkipReason:
        responseBody === undefined ? responseBodySkipReason ?? "not-present-or-unavailable" : undefined,
      requestBodyError: undefined,
      responseBodyError: undefined,
      requestBody: input.request.body === undefined ? undefined : clone(input.request.body),
      responseBody,
    };
    session.networkRecords.push(record);

    return this.createStepResult(input.sessionRef, pageRef, startedAt, {
      ...(mainFrame === undefined ? {} : { frameRef: mainFrame.frameRef }),
      ...(mainFrame === undefined ? {} : { documentRef: mainFrame.currentDocument.documentRef }),
      ...(mainFrame === undefined
        ? {}
        : { documentEpoch: mainFrame.currentDocument.documentEpoch }),
      events: controller === undefined ? [] : this.drainQueuedEvents(controller.pageRef),
      data: {
        url: response.url(),
        status: response.status(),
        statusText: response.statusText(),
        headers: responseHeaders,
        ...(responseBody === undefined ? {} : { body: responseBody }),
        redirected: response.url() !== input.request.url,
      },
    });
  }

  private async handleContextPage(session: SessionState, page: Page): Promise<void> {
    const registration = session.pendingRegistrations.shift();
    try {
      const controller = await this.initializePageController(
        session,
        page,
        registration?.openerPageRef,
        false,
      );
      registration?.resolve(controller);
    } catch (error) {
      registration?.reject(error);
      throw error;
    }
  }

  private async handleAttachedInitialPage(session: SessionState, page: Page): Promise<void> {
    if (this.pageByPlaywrightPage.has(page)) {
      return;
    }
    await this.initializePageController(session, page, undefined, true);
  }

  private async initializePageController(
    session: SessionState,
    page: Page,
    forcedOpenerPageRef?: PageRef,
    externallyOwned = false,
  ): Promise<PageController> {
    const cdp = await session.context.newCDPSession(page);
    const pageRef =
      this.preassignedPopupPageRefs.get(page) ?? createPageRef(`playwright-${++this.pageCounter}`);
    this.preassignedPopupPageRefs.delete(page);
    const controller: PageController = {
      pageRef,
      sessionRef: session.sessionRef,
      page,
      cdp,
      externallyOwned,
      queuedEvents: [],
      framesByCdpId: new Map(),
      frameBindings: new WeakMap(),
      documentsByRef: new Map(),
      networkByRequest: new WeakMap(),
      networkByCdpRequestId: new Map(),
      requestBodyTasks: new Map(),
      responseBodyTasks: new Map(),
      backgroundTasks: new Set(),
      domUpdateTask: undefined,
      backgroundError: undefined,
      openerPageRef: undefined,
      mainFrameRef: undefined,
      lifecycleState: "open",
      frozen: false,
      explicitCloseInFlight: false,
      lastKnownTitle: "",
    };

    this.pages.set(pageRef, controller);
    this.pageByPlaywrightPage.set(page, controller);
    session.pageRefs.add(pageRef);
    session.activePageRef = pageRef;

    await cdp.send("Page.enable", { enableFileChooserOpenedEvent: true });
    await cdp.send("Network.enable");
    await cdp.send("DOM.enable", { includeWhitespace: "none" });
    await cdp.send("DOMStorage.enable");
    await cdp.send("DOM.getDocument", { depth: 0 });

    cdp.on("Page.frameAttached", (payload) =>
      this.handleFrameAttached(controller, payload.frameId, payload.parentFrameId),
    );
    cdp.on("Page.frameDetached", (payload) =>
      this.handleFrameDetached(controller, payload.frameId),
    );
    cdp.on("Page.frameNavigated", (payload) =>
      this.handleFrameNavigated(controller, payload.frame),
    );
    cdp.on("Page.navigatedWithinDocument", (payload) =>
      this.handleNavigatedWithinDocument(controller, payload.frameId, payload.url),
    );
    cdp.on("Page.fileChooserOpened", (payload) =>
      this.handleFileChooserOpened(controller, payload.mode),
    );
    cdp.on("Network.requestWillBeSent", (payload) =>
      this.handleNetworkRequestWillBeSent(controller, payload),
    );
    cdp.on("Network.responseReceived", (payload) =>
      this.handleNetworkResponseReceived(controller, payload),
    );
    cdp.on("Network.responseReceivedExtraInfo", (payload) =>
      this.handleNetworkResponseReceivedExtraInfo(controller, payload),
    );
    cdp.on("Network.loadingFinished", (payload) =>
      this.handleNetworkLoadingFinished(controller, payload),
    );
    cdp.on("Network.loadingFailed", (payload) =>
      this.handleNetworkLoadingFailed(controller, payload),
    );
    cdp.on("DOM.documentUpdated", () => this.handleDocumentUpdated(controller));

    page.on("console", (message) => this.handleConsole(controller, message));
    page.on("popup", (popupPage) => {
      const popupPageRef = createPageRef(`playwright-${++this.pageCounter}`);
      this.preassignedPopupPageRefs.set(popupPage, popupPageRef);
      this.pendingPopupOpeners.set(popupPage, controller.pageRef);
      this.queueEvent(
        controller.pageRef,
        this.createEvent<"popup-opened">({
          kind: "popup-opened",
          sessionRef: controller.sessionRef,
          pageRef: popupPageRef,
          openerPageRef: controller.pageRef,
        }),
      );
    });
    page.on("dialog", (dialog) => {
      void this.handleDialog(controller, dialog);
    });
    page.on("download", (download) => {
      void this.handleDownload(controller, download);
    });
    page.on("pageerror", (error) => this.handlePageError(controller, error));
    page.on("request", (request) => this.handlePlaywrightRequest(controller, request));
    page.on("response", (response) => this.handlePlaywrightResponse(controller, response));
    page.on("close", () => this.handleUnexpectedPageClose(controller));

    const frameTree = await cdp.send("Page.getFrameTree");
    this.syncFrameTree(controller, frameTree.frameTree);
    this.bindPlaywrightFrames(controller, frameTree.frameTree, page.mainFrame());
    await this.reconcileDocumentEpochs(controller);
    controller.lastKnownTitle = await this.readTitle(page, controller.lastKnownTitle);
    this.queueEvent(
      controller.pageRef,
      this.createEvent<"page-created">({
        kind: "page-created",
        sessionRef: controller.sessionRef,
        pageRef: controller.pageRef,
      }),
    );

    if (forcedOpenerPageRef !== undefined) {
      controller.openerPageRef = forcedOpenerPageRef;
      this.queueEvent(
        controller.pageRef,
        this.createEvent<"popup-opened">({
          kind: "popup-opened",
          sessionRef: controller.sessionRef,
          pageRef: controller.pageRef,
          openerPageRef: forcedOpenerPageRef,
        }),
      );
    } else {
      const pendingOpenerPageRef = this.pendingPopupOpeners.get(page);
      if (pendingOpenerPageRef !== undefined) {
        this.pendingPopupOpeners.delete(page);
      }
      const opener =
        pendingOpenerPageRef !== undefined ? null : await page.opener().catch(() => null);
      const openerController =
        pendingOpenerPageRef !== undefined
          ? this.pages.get(pendingOpenerPageRef)
          : opener
            ? this.pageByPlaywrightPage.get(opener)
            : undefined;
      if (openerController) {
        controller.openerPageRef = openerController.pageRef;
      }
    }

    return controller;
  }

  private handleFrameAttached(
    controller: PageController,
    frameId: string,
    parentFrameId: string,
  ): void {
    if (controller.framesByCdpId.has(frameId)) {
      return;
    }
    const parent = controller.framesByCdpId.get(parentFrameId);
    const frameRef = createFrameRef(`playwright-${++this.frameCounter}`);
    const documentRef = createDocumentRef(`playwright-${++this.documentCounter}`);
    const document: DocumentState = {
      pageRef: controller.pageRef,
      frameRef,
      cdpFrameId: frameId,
      documentRef,
      documentEpoch: createDocumentEpoch(0),
      url: "about:blank",
      parentDocumentRef: parent?.currentDocument.documentRef,
      nodeRefsByBackendNodeId: new Map(),
      backendNodeIdsByNodeRef: new Map(),
      domTreeSignature: undefined,
    };
    const frame: FrameState = {
      pageRef: controller.pageRef,
      frameRef,
      cdpFrameId: frameId,
      parentFrameRef: parent?.frameRef,
      name: undefined,
      isMainFrame: false,
      currentDocument: document,
    };
    controller.framesByCdpId.set(frameId, frame);
    controller.documentsByRef.set(documentRef, document);
    this.frames.set(frameRef, frame);
    this.documents.set(documentRef, document);
    this.retiredDocuments.delete(documentRef);
    this.trackBackgroundTask(controller, this.refreshFrameBindings(controller));
  }

  private handleFrameDetached(controller: PageController, frameId: string): void {
    const root = controller.framesByCdpId.get(frameId);
    if (!root) {
      return;
    }
    const descendants = Array.from(controller.framesByCdpId.values()).filter((frame) =>
      this.isDescendantFrame(controller, frame, root.frameRef),
    );
    for (const frame of descendants) {
      this.retireDocument(frame.currentDocument.documentRef);
      this.frames.delete(frame.frameRef);
      controller.framesByCdpId.delete(frame.cdpFrameId);
      controller.documentsByRef.delete(frame.currentDocument.documentRef);
    }
    this.retireDocument(root.currentDocument.documentRef);
    this.frames.delete(root.frameRef);
    controller.framesByCdpId.delete(root.cdpFrameId);
    controller.documentsByRef.delete(root.currentDocument.documentRef);
    this.trackBackgroundTask(controller, this.refreshFrameBindings(controller));
  }

  private handleFrameNavigated(controller: PageController, frame: FrameDescriptor): void {
    if (!controller.framesByCdpId.has(frame.id)) {
      this.handleFrameAttached(controller, frame.id, frame.parentId ?? "");
    }
    const frameState = controller.framesByCdpId.get(frame.id);
    if (!frameState) {
      return;
    }
    const nextDocumentRef = createDocumentRef(`playwright-${++this.documentCounter}`);
    const parent = frame.parentId ? controller.framesByCdpId.get(frame.parentId) : undefined;
    const nextDocument: DocumentState = {
      pageRef: controller.pageRef,
      frameRef: frameState.frameRef,
      cdpFrameId: frame.id,
      documentRef: nextDocumentRef,
      documentEpoch: createDocumentEpoch(0),
      url: combineFrameUrl(frame.url, frame.urlFragment),
      parentDocumentRef: parent?.currentDocument.documentRef,
      nodeRefsByBackendNodeId: new Map(),
      backendNodeIdsByNodeRef: new Map(),
      domTreeSignature: undefined,
    };
    this.retireDocument(frameState.currentDocument.documentRef);
    frameState.currentDocument = nextDocument;
    frameState.parentFrameRef = parent?.frameRef;
    frameState.name = frame.name;
    frameState.isMainFrame = frame.parentId === undefined;
    if (frame.parentId === undefined) {
      controller.mainFrameRef = frameState.frameRef;
    }
    controller.documentsByRef.set(nextDocumentRef, nextDocument);
    this.documents.set(nextDocumentRef, nextDocument);
    this.retiredDocuments.delete(nextDocumentRef);
    this.trackBackgroundTask(controller, this.refreshFrameBindings(controller));
    this.queueDocumentReconciliation(controller);
  }

  private handleNavigatedWithinDocument(
    controller: PageController,
    frameId: string,
    url: string,
  ): void {
    const frame = controller.framesByCdpId.get(frameId);
    if (!frame) {
      return;
    }
    frame.currentDocument.url = url;
  }

  private handleDocumentUpdated(controller: PageController): void {
    this.queueDocumentReconciliation(controller);
  }

  private syncFrameTree(controller: PageController, tree: FrameTreeNode): void {
    const visit = (node: FrameTreeNode, parentFrameRef?: FrameRef): void => {
      const existing = controller.framesByCdpId.get(node.frame.id);
      if (!existing) {
        const frameRef = createFrameRef(`playwright-${++this.frameCounter}`);
        const documentRef = createDocumentRef(`playwright-${++this.documentCounter}`);
        const document: DocumentState = {
          pageRef: controller.pageRef,
          frameRef,
          cdpFrameId: node.frame.id,
          documentRef,
          documentEpoch: createDocumentEpoch(0),
          url: combineFrameUrl(node.frame.url, node.frame.urlFragment),
          parentDocumentRef:
            parentFrameRef === undefined
              ? undefined
              : this.requireFrame(parentFrameRef).currentDocument.documentRef,
          nodeRefsByBackendNodeId: new Map(),
          backendNodeIdsByNodeRef: new Map(),
          domTreeSignature: undefined,
        };
        const frame: FrameState = {
          pageRef: controller.pageRef,
          frameRef,
          cdpFrameId: node.frame.id,
          parentFrameRef,
          name: node.frame.name,
          isMainFrame: parentFrameRef === undefined,
          currentDocument: document,
        };
        controller.framesByCdpId.set(node.frame.id, frame);
        controller.documentsByRef.set(documentRef, document);
        this.frames.set(frameRef, frame);
        this.documents.set(documentRef, document);
        this.retiredDocuments.delete(documentRef);
        if (parentFrameRef === undefined) {
          controller.mainFrameRef = frameRef;
        }
      } else {
        existing.parentFrameRef = parentFrameRef;
        existing.name = node.frame.name;
        existing.isMainFrame = parentFrameRef === undefined;
        existing.currentDocument.url = combineFrameUrl(node.frame.url, node.frame.urlFragment);
        if (parentFrameRef === undefined) {
          controller.mainFrameRef = existing.frameRef;
        }
      }

      const current = controller.framesByCdpId.get(node.frame.id);
      for (const child of node.childFrames ?? []) {
        visit(child, current?.frameRef);
      }
    };

    visit(tree);
  }

  private async refreshFrameBindings(controller: PageController): Promise<void> {
    const frameTree = await controller.cdp.send("Page.getFrameTree");
    this.bindPlaywrightFrames(controller, frameTree.frameTree, controller.page.mainFrame());
  }

  private bindPlaywrightFrames(
    controller: PageController,
    tree: FrameTreeNode,
    frame: Frame,
  ): void {
    const frameState = controller.framesByCdpId.get(tree.frame.id);
    if (frameState) {
      controller.frameBindings.set(frame, frameState.frameRef);
    }
    const treeChildren = tree.childFrames ?? [];
    const playwrightChildren = frame.childFrames();
    const length = Math.min(treeChildren.length, playwrightChildren.length);
    for (let index = 0; index < length; index += 1) {
      const nextTree = treeChildren[index];
      const nextFrame = playwrightChildren[index];
      if (nextTree && nextFrame) {
        this.bindPlaywrightFrames(controller, nextTree, nextFrame);
      }
    }
  }

  private handleConsole(controller: PageController, message: ConsoleMessage): void {
    this.queueEvent(
      controller.pageRef,
      this.createEvent<"console">({
        kind: "console",
        sessionRef: controller.sessionRef,
        pageRef: controller.pageRef,
        level: normalizeConsoleLevel(message.type()),
        text: message.text(),
        location: {
          url: message.location().url,
          lineNumber: message.location().lineNumber,
          columnNumber: message.location().columnNumber,
        },
      }),
    );
  }

  private async handleDialog(controller: PageController, dialog: Dialog): Promise<void> {
    const mainFrame = this.requireMainFrame(controller);
    const dialogRef = createDialogRef(`playwright-${++this.eventCounter}`);
    this.queueEvent(
      controller.pageRef,
      this.createEvent<"dialog-opened">({
        kind: "dialog-opened",
        sessionRef: controller.sessionRef,
        pageRef: controller.pageRef,
        frameRef: mainFrame.frameRef,
        documentRef: mainFrame.currentDocument.documentRef,
        documentEpoch: mainFrame.currentDocument.documentEpoch,
        dialogRef,
        dialogType: normalizeDialogType(dialog.type()),
        message: dialog.message(),
        ...(dialog.defaultValue().length === 0 ? {} : { defaultValue: dialog.defaultValue() }),
      }),
    );
    await dialog.dismiss().catch(() => {});
  }

  private async handleDownload(controller: PageController, download: Download): Promise<void> {
    const mainFrame = this.requireMainFrame(controller);
    const downloadRef = createDownloadRef(`playwright-${++this.eventCounter}`);
    this.queueEvent(
      controller.pageRef,
      this.createEvent<"download-started">({
        kind: "download-started",
        sessionRef: controller.sessionRef,
        pageRef: controller.pageRef,
        frameRef: mainFrame.frameRef,
        documentRef: mainFrame.currentDocument.documentRef,
        documentEpoch: mainFrame.currentDocument.documentEpoch,
        downloadRef,
        url: download.url(),
        suggestedFilename: download.suggestedFilename(),
      }),
    );

    const task = (async () => {
      const failure = await download.failure();
      let filePath: string | undefined;
      try {
        filePath = await download.path();
      } catch {
        filePath = undefined;
      }
      this.queueEvent(
        controller.pageRef,
        this.createEvent<"download-finished">({
          kind: "download-finished",
          sessionRef: controller.sessionRef,
          pageRef: controller.pageRef,
          frameRef: mainFrame.frameRef,
          documentRef: mainFrame.currentDocument.documentRef,
          documentEpoch: mainFrame.currentDocument.documentEpoch,
          downloadRef,
          state: failure === null ? "completed" : failure === "canceled" ? "canceled" : "failed",
          ...(filePath === undefined ? {} : { filePath }),
        }),
      );
    })();
    this.trackBackgroundTask(controller, task);
  }

  private handleFileChooserOpened(
    controller: PageController,
    mode: "selectSingle" | "selectMultiple",
  ): void {
    this.queueEvent(
      controller.pageRef,
      this.createEvent<"chooser-opened">({
        kind: "chooser-opened",
        sessionRef: controller.sessionRef,
        pageRef: controller.pageRef,
        chooserRef: createChooserRef(`playwright-${++this.eventCounter}`),
        chooserType: "file",
        multiple: mode === "selectMultiple",
      }),
    );
  }

  private handlePageError(controller: PageController, error: Error): void {
    this.queueEvent(
      controller.pageRef,
      this.createEvent<"page-error">({
        kind: "page-error",
        sessionRef: controller.sessionRef,
        pageRef: controller.pageRef,
        message: error.message,
        ...(error.stack === undefined ? {} : { stack: error.stack }),
      }),
    );
  }

  private handleUnexpectedPageClose(controller: PageController): void {
    controller.lifecycleState = "closed";
    if (
      !controller.explicitCloseInFlight &&
      controller.openerPageRef &&
      this.pages.has(controller.openerPageRef)
    ) {
      this.queueEvent(
        controller.openerPageRef,
        this.createEvent<"page-closed">({
          kind: "page-closed",
          sessionRef: controller.sessionRef,
          pageRef: controller.pageRef,
        }),
      );
    }
    this.cleanupPageController(controller);
  }

  private handleNetworkRequestWillBeSent(
    controller: PageController,
    payload: {
      readonly requestId: string;
      readonly loaderId?: string;
      readonly type?: string;
      readonly frameId?: string;
      readonly request: {
        readonly url: string;
        readonly method: string;
        readonly headers?: Record<string, unknown>;
        readonly hasPostData?: boolean;
        readonly postData?: string;
      };
      readonly initiator?: {
        readonly type?: string;
        readonly url?: string;
        readonly lineNumber?: number;
        readonly columnNumber?: number;
        readonly stack?: {
          readonly callFrames?: ReadonlyArray<{
            readonly url?: string;
            readonly lineNumber?: number;
            readonly columnNumber?: number;
            readonly functionName?: string;
          }>;
        };
      };
      readonly redirectResponse?: {
        readonly url: string;
        readonly status: number;
        readonly statusText: string;
        readonly headers?: Record<string, unknown>;
        readonly protocol?: string;
        readonly remoteIPAddress?: string;
        readonly remotePort?: number;
        readonly fromDiskCache?: boolean;
        readonly fromServiceWorker?: boolean;
      };
    },
  ): void {
    const prior = controller.networkByCdpRequestId.get(payload.requestId);
    let redirectFromRequestId: NetworkRecordState["requestId"] | undefined;
    if (prior && payload.redirectResponse) {
      this.applyCdpResponseMetadata(prior, payload.redirectResponse);
      prior.captureState = "complete";
      prior.responseBodyState = "skipped";
      prior.responseBodySkipReason = "redirect-response";
      prior.responseBodyError = undefined;
      redirectFromRequestId = prior.requestId;
    }

    const frameContext = this.resolveNetworkFrameContext(controller, payload.frameId);
    const nextRequestId = createNetworkRequestId(`playwright-${++this.requestCounter}`);
    const requestHeaders = objectHeadersToEntries(payload.request.headers);
    const requestContentType = headerEntryValue(requestHeaders, "content-type");
    const postData = payload.request.postData;
    const requestBody =
      typeof postData === "string"
        ? captureBodyPayload(Buffer.from(postData, "utf8"), requestContentType, this.bodyCaptureLimitBytes)
        : undefined;
    const record: NetworkRecordState = {
      kind: "http",
      requestId: nextRequestId,
      sessionRef: controller.sessionRef,
      cdpRequestId: payload.requestId,
      pageRef: frameContext.pageRef,
      frameRef: frameContext.frameRef,
      documentRef: frameContext.documentRef,
      method: payload.request.method,
      url: payload.request.url,
      requestHeaders,
      responseHeaders: [],
      status: undefined,
      statusText: undefined,
      resourceType: normalizeResourceType((payload.type ?? "other").toLowerCase()),
      redirectFromRequestId,
      redirectToRequestId: undefined,
      navigationRequest: payload.type === "Document",
      timing: undefined,
      transfer: undefined,
      source: undefined,
      captureState: "pending",
      requestBodyState:
        requestBody !== undefined
          ? "complete"
          : payload.request.hasPostData === true
            ? "pending"
            : "skipped",
      responseBodyState: "pending",
      requestBodySkipReason:
        requestBody === undefined && payload.request.hasPostData !== true ? "not-present" : undefined,
      responseBodySkipReason: undefined,
      requestBodyError: undefined,
      responseBodyError: undefined,
      requestBody,
      responseBody: undefined,
      ...(payload.initiator === undefined ? {} : { initiator: normalizeNetworkInitiator(payload.initiator) }),
    };

    if (prior && payload.redirectResponse) {
      prior.redirectToRequestId = record.requestId;
    }

    controller.networkByCdpRequestId.set(payload.requestId, record);
    this.requireSession(controller.sessionRef).networkRecords.push(record);
  }

  private handlePlaywrightRequest(controller: PageController, request: Request): void {
    if (this.bindPlaywrightRequest(controller, request)) {
      this.enrichPlaywrightRequest(controller, request);
      return;
    }
    const task = (async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (this.bindPlaywrightRequest(controller, request)) {
          this.enrichPlaywrightRequest(controller, request);
          return;
        }
      }
    })();
    this.trackBackgroundTask(controller, task);
  }

  private handlePlaywrightResponse(controller: PageController, response: Response): void {
    const request = response.request();
    const record = controller.networkByRequest.get(request);
    if (!record) {
      return;
    }
    const task = (async () => {
      const responseHeaders = (await response.headersArray()).map((header) =>
        createHeaderEntry(header.name, header.value),
      );
      if (responseHeaders.length > 0) {
        record.responseHeaders = responseHeaders;
      }
      if (record.source === undefined) {
        const serverAddr = await response.serverAddr();
        record.source = {
          ...(serverAddr === null
            ? {}
            : {
                remoteAddress: {
                  ip: serverAddr.ipAddress,
                  port: serverAddr.port,
                },
              }),
          fromServiceWorker: response.fromServiceWorker(),
        };
      }
    })();
    this.trackBackgroundTask(controller, task);
  }

  private bindPlaywrightRequest(controller: PageController, request: Request): boolean {
    const session = this.requireSession(controller.sessionRef);
    const record = [...session.networkRecords]
      .reverse()
      .find(
        (entry) =>
          entry.pageRef === controller.pageRef &&
          entry.method === request.method() &&
          entry.url === request.url() &&
          entry.captureState === "pending",
      );
    if (!record) {
      return false;
    }
    controller.networkByRequest.set(request, record);
    return true;
  }

  private enrichPlaywrightRequest(controller: PageController, request: Request): void {
    const record = controller.networkByRequest.get(request);
    if (!record) {
      return;
    }
    const task = (async () => {
      const requestHeaders = (await request.headersArray()).map((header) =>
        createHeaderEntry(header.name, header.value),
      );
      if (requestHeaders.length > 0) {
        record.requestHeaders = requestHeaders;
      }
      if (record.requestBody === undefined) {
        const contentType = await request.headerValue("content-type");
        const requestBody = captureBodyPayload(
          request.postDataBuffer(),
          contentType ?? undefined,
          this.bodyCaptureLimitBytes,
        );
        if (requestBody !== undefined) {
          record.requestBody = requestBody;
          record.requestBodyState = "complete";
          record.requestBodySkipReason = undefined;
          record.requestBodyError = undefined;
        }
      }
    })();
    this.trackBackgroundTask(controller, task);
  }

  private handleNetworkResponseReceived(
    controller: PageController,
    payload: {
      readonly requestId: string;
      readonly response: {
        readonly url: string;
        readonly status: number;
        readonly statusText: string;
        readonly headers?: Record<string, unknown>;
        readonly protocol?: string;
        readonly remoteIPAddress?: string;
        readonly remotePort?: number;
        readonly fromDiskCache?: boolean;
        readonly fromServiceWorker?: boolean;
        readonly timing?: {
          readonly requestTime: number;
          readonly dnsStart?: number;
          readonly dnsEnd?: number;
          readonly connectStart?: number;
          readonly connectEnd?: number;
          readonly sslStart?: number;
          readonly sslEnd?: number;
          readonly sendStart?: number;
          readonly receiveHeadersStart?: number;
          readonly receiveHeadersEnd?: number;
          readonly workerStart?: number;
          readonly workerReady?: number;
        };
      };
    },
  ): void {
    const record = controller.networkByCdpRequestId.get(payload.requestId);
    if (!record) {
      return;
    }
    this.applyCdpResponseMetadata(record, payload.response);
    record.url = payload.response.url;
    record.timing = normalizeNetworkTiming(payload.response.timing);
    const skipReason = getResponseBodySkipReason(record);
    if (skipReason !== undefined) {
      record.responseBodyState = "skipped";
      record.responseBodySkipReason = skipReason;
      record.responseBodyError = undefined;
    }
  }

  private handleNetworkResponseReceivedExtraInfo(
    controller: PageController,
    payload: {
      readonly requestId: string;
      readonly headers?: Record<string, unknown>;
      readonly headersText?: string;
    },
  ): void {
    const record = controller.networkByCdpRequestId.get(payload.requestId);
    if (!record) {
      return;
    }
    const parsedFromText = parseRawHeadersText(payload.headersText);
    if (parsedFromText.length > 0) {
      if (
        record.responseHeaders.length === 0 ||
        !record.responseHeaders.some((header) => header.name.toLowerCase() === "set-cookie")
      ) {
        record.responseHeaders = parsedFromText;
      }
      return;
    }
    const parsedFromObject = objectHeadersToEntries(payload.headers);
    if (parsedFromObject.length > 0) {
      if (
        record.responseHeaders.length === 0 ||
        !record.responseHeaders.some((header) => header.name.toLowerCase() === "set-cookie")
      ) {
        record.responseHeaders = parsedFromObject;
      }
    }
  }

  private handleNetworkLoadingFinished(
    controller: PageController,
    payload: {
      readonly requestId: string;
      readonly encodedDataLength?: number;
    },
  ): void {
    const record = controller.networkByCdpRequestId.get(payload.requestId);
    if (!record) {
      return;
    }
    record.captureState = "complete";
    if (record.navigationRequest && record.frameRef) {
      const frame = this.requireFrame(record.frameRef);
      record.documentRef = frame.currentDocument.documentRef;
    }
    record.transfer = {
      ...(record.transfer ?? {}),
      ...(payload.encodedDataLength === undefined ? {} : { encodedBodyBytes: payload.encodedDataLength }),
      ...(payload.encodedDataLength === undefined ? {} : { transferSizeBytes: payload.encodedDataLength }),
      ...(record.responseBody === undefined
        ? {}
        : { decodedBodyBytes: record.responseBody.capturedByteLength }),
    };
    if (
      record.responseBodyState === "pending" &&
      getResponseBodySkipReason(record) !== undefined
    ) {
      record.responseBodyState = "skipped";
      record.responseBodySkipReason = getResponseBodySkipReason(record);
    }
  }

  private handleNetworkLoadingFailed(
    controller: PageController,
    payload: {
      readonly requestId: string;
      readonly errorText?: string;
    },
  ): void {
    const record = controller.networkByCdpRequestId.get(payload.requestId);
    if (!record) {
      return;
    }
    record.captureState = "failed";
    if (record.responseBodyState === "pending") {
      record.responseBodyState = "failed";
      record.responseBodyError = payload.errorText ?? "request failed before response body capture";
    }
  }

  private async collectSessionStorageSnapshots(
    session: SessionState,
  ): Promise<readonly SessionStorageSnapshot[]> {
    const snapshots: SessionStorageSnapshot[] = [];
    for (const pageRef of session.pageRefs) {
      const controller = this.requirePage(pageRef);
      await this.flushDomUpdateTask(controller);
      for (const frame of controller.framesByCdpId.values()) {
        let origin: string;
        try {
          origin = new URL(frame.currentDocument.url).origin;
        } catch {
          continue;
        }
        if (origin === "null") {
          continue;
        }
        let storageKey: string;
        try {
          const resolved = await controller.cdp.send("Storage.getStorageKey", {
            frameId: frame.cdpFrameId,
          });
          storageKey = resolved.storageKey;
        } catch {
          continue;
        }
        const storage = await controller.cdp.send("DOMStorage.getDOMStorageItems", {
          storageId: {
            storageKey,
            isLocalStorage: false,
          },
        });
        snapshots.push({
          pageRef: controller.pageRef,
          frameRef: frame.frameRef,
          origin,
          entries: storage.entries.reduce<StorageEntry[]>((entries, entry) => {
            const [key, value] = entry;
            if (key !== undefined && value !== undefined) {
              entries.push({ key, value });
            }
            return entries;
          }, []),
        });
      }
    }
    return snapshots;
  }

  private async buildPageInfo(controller: PageController): Promise<PageInfo> {
    controller.lastKnownTitle = await this.readTitle(controller.page, controller.lastKnownTitle);
    const mainFrame = this.requireMainFrame(controller);
    return {
      pageRef: controller.pageRef,
      sessionRef: controller.sessionRef,
      ...(controller.openerPageRef === undefined
        ? {}
        : { openerPageRef: controller.openerPageRef }),
      url: mainFrame.currentDocument.url,
      title: controller.lastKnownTitle,
      lifecycleState: controller.lifecycleState,
    };
  }

  private buildFrameInfo(frame: FrameState): FrameInfo {
    return {
      frameRef: frame.frameRef,
      pageRef: frame.pageRef,
      ...(frame.parentFrameRef === undefined ? {} : { parentFrameRef: frame.parentFrameRef }),
      documentRef: frame.currentDocument.documentRef,
      documentEpoch: frame.currentDocument.documentEpoch,
      url: frame.currentDocument.url,
      ...(frame.name === undefined ? {} : { name: frame.name }),
      isMainFrame: frame.isMainFrame,
    };
  }

  private async reconcileDocumentEpochs(controller: PageController): Promise<void> {
    const captured = await capturePageDomSnapshot(controller.cdp, { includeLayout: false });
    for (const frame of controller.framesByCdpId.values()) {
      const rawDocument = findCapturedDocument(captured, frame.cdpFrameId);
      if (!rawDocument) {
        continue;
      }
      updateDocumentTreeSignature(frame.currentDocument, rawDocument, this.retiredDocuments);
    }
  }

  private queueDocumentReconciliation(controller: PageController): void {
    const queued = (controller.domUpdateTask ?? Promise.resolve()).then(() =>
      this.reconcileDocumentEpochs(controller),
    );
    const tracked = this.trackBackgroundTask(controller, queued);
    const settled = tracked.finally(() => {
      if (controller.domUpdateTask === settled) {
        controller.domUpdateTask = undefined;
      }
    });
    controller.domUpdateTask = settled;
  }

  private async flushDomUpdateTask(controller: PageController): Promise<void> {
    while (controller.domUpdateTask) {
      await controller.domUpdateTask;
    }
    this.throwBackgroundError(controller);
  }

  private async captureDomSnapshot(
    controller: PageController,
    document: DocumentState,
  ): Promise<CapturedDomSnapshot> {
    const captured = await capturePageDomSnapshot(controller.cdp, { includeLayout: true });
    const rawDocument = findCapturedDocument(captured, document.cdpFrameId);
    if (!rawDocument) {
      throw createBrowserCoreError(
        "not-found",
        `document ${document.documentRef} was not found in the current page snapshot`,
      );
    }
    updateDocumentTreeSignature(document, rawDocument, this.retiredDocuments);
    return {
      capturedAt: captured.capturedAt,
      documents: captured.documents,
      rawDocument,
      shadowBoundariesByBackendNodeId: captured.shadowBoundariesByBackendNodeId,
      strings: captured.strings,
    };
  }

  private nodeRefForBackendNode(document: DocumentState, backendNodeId: number): NodeRef {
    const existing = document.nodeRefsByBackendNodeId.get(backendNodeId);
    if (existing) {
      return existing;
    }
    const nodeRef = createNodeRef(`playwright-${++this.nodeCounter}`);
    document.nodeRefsByBackendNodeId.set(backendNodeId, nodeRef);
    document.backendNodeIdsByNodeRef.set(nodeRef, backendNodeId);
    return nodeRef;
  }

  private resolveDocumentTarget(input: {
    readonly frameRef?: FrameRef;
    readonly documentRef?: DocumentRef;
  }): DocumentState {
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
      return this.requireFrame(input.frameRef).currentDocument;
    }
    throw createBrowserCoreError("invalid-argument", "either frameRef or documentRef is required");
  }

  private requireLiveNode(input: NodeLocator): {
    readonly controller: PageController;
    readonly document: DocumentState;
    readonly backendNodeId: number;
  } {
    if (this.retiredDocuments.has(input.documentRef)) {
      throw staleNodeRefError(input);
    }
    const document = this.documents.get(input.documentRef);
    if (!document) {
      throw createBrowserCoreError("not-found", `document ${input.documentRef} was not found`, {
        details: { documentRef: input.documentRef },
      });
    }
    if (document.documentEpoch !== input.documentEpoch) {
      throw staleNodeRefError(input);
    }
    const backendNodeId = document.backendNodeIdsByNodeRef.get(input.nodeRef);
    if (backendNodeId === undefined) {
      throw staleNodeRefError(input);
    }
    return {
      controller: this.requirePage(document.pageRef),
      document,
      backendNodeId,
    };
  }

  private resolveNetworkFrameContext(
    controller: PageController,
    cdpFrameId: string | undefined,
  ): {
    readonly pageRef: PageRef;
    readonly frameRef?: FrameRef;
    readonly documentRef?: DocumentRef;
  } {
    if (cdpFrameId === undefined) {
      return { pageRef: controller.pageRef };
    }
    const frame = controller.framesByCdpId.get(cdpFrameId);
    if (!frame) {
      return { pageRef: controller.pageRef };
    }
    return {
      pageRef: controller.pageRef,
      frameRef: frame.frameRef,
      documentRef: frame.currentDocument.documentRef,
    };
  }

  private resolvePageForNetworkRecord(record: NetworkRecordState): PageController | undefined {
    if (record.pageRef !== undefined) {
      const page = this.pages.get(record.pageRef);
      if (page && page.lifecycleState !== "closed") {
        return page;
      }
    }
    const session = this.sessions.get(record.sessionRef);
    if (!session) {
      return undefined;
    }
    for (const pageRef of session.pageRefs) {
      const page = this.pages.get(pageRef);
      if (page && page.lifecycleState !== "closed") {
        return page;
      }
    }
    return undefined;
  }

  private async materializeNetworkRecordBodies(
    record: NetworkRecordState,
    controller: PageController,
  ): Promise<void> {
    await Promise.all([
      this.materializeRequestBody(record, controller),
      this.materializeResponseBody(record, controller),
    ]);
  }

  private async materializeRequestBody(
    record: NetworkRecordState,
    controller: PageController,
  ): Promise<void> {
    if (record.requestBodyState !== "pending") {
      return;
    }
    const existing = controller.requestBodyTasks.get(record.requestId);
    if (existing) {
      await existing;
      return;
    }
    const task = (async () => {
      if (record.cdpRequestId === undefined) {
        record.requestBodyState = "failed";
        record.requestBodyError = "request body capture is unavailable without a CDP request id";
        return;
      }
      try {
        const result = await controller.cdp.send("Network.getRequestPostData", {
          requestId: record.cdpRequestId,
        });
        const contentType = headerEntryValue(record.requestHeaders, "content-type");
        record.requestBody =
          typeof result.postData === "string"
            ? captureBodyPayload(
                Buffer.from(result.postData, "utf8"),
                contentType ?? undefined,
                this.bodyCaptureLimitBytes,
              )
            : undefined;
        if (record.requestBody === undefined) {
          record.requestBodyState = "skipped";
          record.requestBodySkipReason = "not-present";
          return;
        }
        record.requestBodyState = "complete";
        record.requestBodySkipReason = undefined;
        record.requestBodyError = undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/No post data|No resource with given identifier|No data found/i.test(message)) {
          record.requestBodyState = "skipped";
          record.requestBodySkipReason = "not-present";
          record.requestBodyError = undefined;
          return;
        }
        record.requestBodyState = "failed";
        record.requestBodyError = message;
      }
    })();
    controller.requestBodyTasks.set(record.requestId, task);
    try {
      await task;
    } finally {
      controller.requestBodyTasks.delete(record.requestId);
    }
  }

  private async materializeResponseBody(
    record: NetworkRecordState,
    controller: PageController,
  ): Promise<void> {
    if (record.responseBodyState !== "pending") {
      return;
    }
    const skipReason = getResponseBodySkipReason(record);
    if (skipReason !== undefined) {
      record.responseBodyState = "skipped";
      record.responseBodySkipReason = skipReason;
      record.responseBodyError = undefined;
      return;
    }
    const existing = controller.responseBodyTasks.get(record.requestId);
    if (existing) {
      await existing;
      return;
    }
    const task = (async () => {
      if (record.cdpRequestId === undefined) {
        record.responseBodyState = "failed";
        record.responseBodyError = "response body capture is unavailable without a CDP request id";
        return;
      }
      try {
        const result = await controller.cdp.send("Network.getResponseBody", {
          requestId: record.cdpRequestId,
        });
        const contentType = headerEntryValue(record.responseHeaders, "content-type");
        const bytes = result.base64Encoded
          ? Buffer.from(result.body, "base64")
          : Buffer.from(result.body, "utf8");
        const responseBody = captureBodyPayload(
          bytes,
          contentType ?? undefined,
          this.bodyCaptureLimitBytes,
        );
        if (responseBody === undefined) {
          record.responseBodyState = "skipped";
          record.responseBodySkipReason = "not-present";
          return;
        }
        record.responseBody = responseBody;
        record.responseBodyState = "complete";
        record.responseBodySkipReason = undefined;
        record.responseBodyError = undefined;
        record.transfer = {
          ...(record.transfer ?? {}),
          decodedBodyBytes: responseBody.capturedByteLength,
          ...(record.transfer?.encodedBodyBytes === undefined
            ? {}
            : { encodedBodyBytes: record.transfer.encodedBodyBytes }),
          ...(record.transfer?.requestHeadersBytes === undefined
            ? {}
            : { requestHeadersBytes: record.transfer.requestHeadersBytes }),
          ...(record.transfer?.responseHeadersBytes === undefined
            ? {}
            : { responseHeadersBytes: record.transfer.responseHeadersBytes }),
          ...(record.transfer?.transferSizeBytes === undefined
            ? {}
            : { transferSizeBytes: record.transfer.transferSizeBytes }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/No resource with given identifier|No data found|Could not load body/i.test(message)) {
          record.responseBodyState = "failed";
          record.responseBodyError = message;
          return;
        }
        record.responseBodyState = "failed";
        record.responseBodyError = message;
      }
    })();
    controller.responseBodyTasks.set(record.requestId, task);
    try {
      await task;
    } finally {
      controller.responseBodyTasks.delete(record.requestId);
    }
  }

  private applyCdpResponseMetadata(
    record: NetworkRecordState,
    response: {
      readonly url: string;
      readonly status: number;
      readonly statusText: string;
      readonly headers?: Record<string, unknown>;
      readonly protocol?: string;
      readonly remoteIPAddress?: string;
      readonly remotePort?: number;
      readonly fromDiskCache?: boolean;
      readonly fromServiceWorker?: boolean;
    },
  ): void {
    record.url = response.url;
    record.status = response.status;
    record.statusText = response.statusText;
    const responseHeaders = objectHeadersToEntries(response.headers);
    if (
      record.responseHeaders.length === 0 ||
      !record.responseHeaders.some((header) => header.name.toLowerCase() === "set-cookie")
    ) {
      record.responseHeaders = responseHeaders;
    }
    record.source = {
      ...(response.protocol === undefined ? {} : { protocol: response.protocol }),
      ...((response.remoteIPAddress === undefined && response.remotePort === undefined)
        ? {}
        : {
            remoteAddress: {
              ...(response.remoteIPAddress === undefined ? {} : { ip: response.remoteIPAddress }),
              ...(response.remotePort === undefined ? {} : { port: response.remotePort }),
            },
          }),
      ...(response.fromDiskCache === undefined ? {} : { fromDiskCache: response.fromDiskCache }),
      ...(response.fromServiceWorker === undefined
        ? {}
        : { fromServiceWorker: response.fromServiceWorker }),
    };
  }

  private requireMainFrame(controller: PageController): FrameState {
    if (!controller.mainFrameRef) {
      throw createBrowserCoreError(
        "operation-failed",
        `page ${controller.pageRef} has no main frame`,
      );
    }
    return this.requireFrame(controller.mainFrameRef);
  }

  private requireSession(sessionRef: SessionRef): SessionState {
    const session = this.sessions.get(sessionRef);
    if (!session) {
      throw closedSessionError(sessionRef);
    }
    return session;
  }

  private requirePage(pageRef: PageRef): PageController {
    const page = this.pages.get(pageRef);
    if (!page || page.lifecycleState === "closed") {
      throw closedPageError(pageRef);
    }
    this.throwBackgroundError(page);
    return page;
  }

  private requireFrame(frameRef: FrameRef): FrameState {
    const frame = this.frames.get(frameRef);
    if (!frame) {
      throw createBrowserCoreError("not-found", `frame ${frameRef} was not found`, {
        details: { frameRef },
      });
    }
    return frame;
  }

  private requireDocument(documentRef: DocumentRef): DocumentState {
    const document = this.documents.get(documentRef);
    if (!document) {
      throw createBrowserCoreError("not-found", `document ${documentRef} was not found`, {
        details: { documentRef },
      });
    }
    return document;
  }

  private cleanupPageController(controller: PageController): void {
    controller.lifecycleState = "closed";
    this.pages.delete(controller.pageRef);
    const session = this.sessions.get(controller.sessionRef);
    if (session) {
      session.pageRefs.delete(controller.pageRef);
      if (session.activePageRef === controller.pageRef) {
        session.activePageRef = Array.from(session.pageRefs)[0];
      }
    }
    for (const frame of controller.framesByCdpId.values()) {
      this.frames.delete(frame.frameRef);
      this.documents.delete(frame.currentDocument.documentRef);
      this.retiredDocuments.add(frame.currentDocument.documentRef);
    }
    controller.framesByCdpId.clear();
    controller.documentsByRef.clear();
    controller.networkByCdpRequestId.clear();
    controller.requestBodyTasks.clear();
    controller.responseBodyTasks.clear();
  }

  private trackBackgroundTask(controller: PageController, promise: Promise<void>): Promise<void> {
    const tracked = promise.catch((error) => {
      if (shouldIgnoreBackgroundTaskError(controller, error)) {
        return;
      }
      controller.backgroundError ??= normalizePlaywrightError(error, controller.pageRef);
    });
    controller.backgroundTasks.add(tracked);
    void tracked.finally(() => {
      controller.backgroundTasks.delete(tracked);
    });
    return tracked;
  }

  private async flushBackgroundTasks(controller: PageController): Promise<void> {
    if (controller.backgroundTasks.size === 0) {
      this.throwBackgroundError(controller);
      return;
    }
    await Promise.all(Array.from(controller.backgroundTasks));
    this.throwBackgroundError(controller);
  }

  private async flushPendingPageTasks(sessionRef: SessionRef): Promise<void> {
    const session = this.sessions.get(sessionRef);
    if (!session) {
      return;
    }
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const pending = Array.from(session.pendingPageTasks);
      if (pending.length === 0) {
        return;
      }
      await Promise.all(pending);
    }
  }

  private throwBackgroundError(controller: PageController): void {
    if (controller.backgroundError) {
      throw controller.backgroundError;
    }
  }

  private createEvent<TKind extends StepEvent["kind"]>(
    value: Omit<Extract<StepEvent, { readonly kind: TKind }>, "eventId" | "timestamp">,
  ): Extract<StepEvent, { readonly kind: TKind }> {
    return {
      ...value,
      eventId: `event:${++this.eventCounter}`,
      timestamp: Date.now(),
    } as Extract<StepEvent, { readonly kind: TKind }>;
  }

  private queueEvent(pageRef: PageRef, event: StepEvent): void {
    const controller = this.pages.get(pageRef);
    if (!controller) {
      return;
    }
    controller.queuedEvents.push(event);
  }

  private drainQueuedEvents(pageRef: PageRef): StepEvent[] {
    const controller = this.requirePage(pageRef);
    const events = controller.queuedEvents.splice(0, controller.queuedEvents.length);
    return events.map((event) => clone(event));
  }

  private createStepResult<TData>(
    sessionRef: SessionRef,
    pageRef: PageRef | undefined,
    startedAt: number,
    input: {
      readonly frameRef?: FrameRef;
      readonly documentRef?: DocumentRef;
      readonly documentEpoch?: DocumentEpoch;
      readonly events: readonly StepEvent[];
      readonly data: TData;
    },
  ): StepResult<TData> {
    const completedAt = Date.now();
    return {
      stepId: `step:${++this.stepCounter}`,
      sessionRef,
      ...(pageRef === undefined ? {} : { pageRef }),
      ...(input.frameRef === undefined ? {} : { frameRef: input.frameRef }),
      ...(input.documentRef === undefined ? {} : { documentRef: input.documentRef }),
      ...(input.documentEpoch === undefined ? {} : { documentEpoch: input.documentEpoch }),
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
      events: input.events.map((event) => clone(event)),
      data: clone(input.data),
    };
  }

  private async withModifiers(
    page: Page,
    modifiers: readonly KeyModifier[] | undefined,
    action: () => Promise<void>,
  ): Promise<void> {
    if (!modifiers || modifiers.length === 0) {
      await action();
      return;
    }
    for (const modifier of modifiers) {
      await page.keyboard.down(modifier);
    }
    try {
      await action();
    } finally {
      for (const modifier of [...modifiers].reverse()) {
        await page.keyboard.up(modifier);
      }
    }
  }

  private async readTitle(page: Page, fallback: string): Promise<string> {
    try {
      return await page.title();
    } catch {
      return fallback;
    }
  }

  private retireDocument(documentRef: DocumentRef): void {
    this.documents.delete(documentRef);
    this.retiredDocuments.add(documentRef);
  }

  private isDescendantFrame(
    controller: PageController,
    frame: FrameState,
    ancestorFrameRef: FrameRef,
  ): boolean {
    let current = frame.parentFrameRef;
    while (current) {
      if (current === ancestorFrameRef) {
        return true;
      }
      current = this.frames.get(current)?.parentFrameRef;
    }
    return false;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw createBrowserCoreError("operation-failed", "engine has been disposed");
    }
  }
}

export async function createPlaywrightBrowserCoreEngine(
  options: PlaywrightBrowserCoreEngineOptions = {},
): Promise<PlaywrightBrowserCoreEngine> {
  return PlaywrightBrowserCoreEngine.create(options);
}

export async function connectPlaywrightChromiumBrowser(input: {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}): Promise<Browser> {
  return chromium.connectOverCDP({
    endpointURL: input.url,
    ...(input.headers === undefined ? {} : { headers: input.headers }),
  });
}

function objectHeadersToEntries(
  headers: Record<string, unknown> | undefined,
): ReturnType<typeof createHeaderEntry>[] {
  if (!headers) {
    return [];
  }
  return Object.entries(headers).flatMap(([name, value]) => {
    if (typeof value === "string" && name.toLowerCase() === "set-cookie" && value.includes("\n")) {
      return value
        .split("\n")
        .filter((entry) => entry.length > 0)
        .map((entry) => createHeaderEntry(name, entry));
    }
    return [createHeaderEntry(name, stringifyHeaderValue(value))];
  });
}

function stringifyHeaderValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => stringifyHeaderValue(entry)).join(", ");
  }
  return typeof value === "string" ? value : String(value ?? "");
}

function headerEntryValue(
  headers: readonly { readonly name: string; readonly value: string }[],
  name: string,
): string | undefined {
  const normalized = name.toLowerCase();
  for (const header of headers) {
    if (header.name.toLowerCase() === normalized) {
      return header.value;
    }
  }
  return undefined;
}

function parseRawHeadersText(value: string | undefined): ReturnType<typeof createHeaderEntry>[] {
  if (value === undefined || value.length === 0) {
    return [];
  }
  return value
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const index = line.indexOf(":");
      if (index <= 0) {
        return [];
      }
      const name = line.slice(0, index).trim();
      const headerValue = line.slice(index + 1).trim();
      return [createHeaderEntry(name, headerValue)];
    });
}

function normalizeNetworkInitiator(
  initiator: {
    readonly type?: string;
    readonly url?: string;
    readonly lineNumber?: number;
    readonly columnNumber?: number;
    readonly stack?: {
      readonly callFrames?: ReadonlyArray<{
        readonly url?: string;
        readonly lineNumber?: number;
        readonly columnNumber?: number;
        readonly functionName?: string;
      }>;
    };
  },
): NonNullable<NetworkRecord["initiator"]> {
  const type =
    initiator.type === "parser" ||
    initiator.type === "script" ||
    initiator.type === "preload" ||
    initiator.type === "redirect" ||
    initiator.type === "user" ||
    initiator.type === "service-worker"
      ? initiator.type
      : "other";
  const stackTrace =
    initiator.stack?.callFrames?.map((frame) =>
      [frame.functionName, frame.url, frame.lineNumber, frame.columnNumber]
        .filter((value) => value !== undefined && value !== "")
        .join(" "),
    ) ?? [];
  return {
    type,
    ...(initiator.url === undefined ? {} : { url: initiator.url }),
    ...(initiator.lineNumber === undefined ? {} : { lineNumber: initiator.lineNumber }),
    ...(initiator.columnNumber === undefined ? {} : { columnNumber: initiator.columnNumber }),
    ...(stackTrace.length === 0 ? {} : { stackTrace }),
  };
}

function normalizeNetworkTiming(
  timing:
    | {
        readonly requestTime: number;
        readonly dnsStart?: number;
        readonly dnsEnd?: number;
        readonly connectStart?: number;
        readonly connectEnd?: number;
        readonly sslStart?: number;
        readonly sslEnd?: number;
        readonly sendStart?: number;
        readonly receiveHeadersStart?: number;
        readonly receiveHeadersEnd?: number;
        readonly workerStart?: number;
        readonly workerReady?: number;
      }
    | undefined,
): NetworkRecord["timing"] | undefined {
  if (timing === undefined) {
    return undefined;
  }
  const start = timing.requestTime * 1000;
  const at = (value: number | undefined) =>
    value === undefined || value < 0 ? undefined : start + value;
  const normalized: {
    requestStartMs: number;
    dnsStartMs?: number;
    dnsEndMs?: number;
    connectStartMs?: number;
    connectEndMs?: number;
    sslStartMs?: number;
    sslEndMs?: number;
    requestSentMs?: number;
    responseStartMs?: number;
    responseEndMs?: number;
    workerStartMs?: number;
    workerReadyMs?: number;
  } = {
    requestStartMs: start,
  };
  const dnsStartMs = at(timing.dnsStart);
  const dnsEndMs = at(timing.dnsEnd);
  const connectStartMs = at(timing.connectStart);
  const connectEndMs = at(timing.connectEnd);
  const sslStartMs = at(timing.sslStart);
  const sslEndMs = at(timing.sslEnd);
  const requestSentMs = at(timing.sendStart);
  const responseStartMs = at(timing.receiveHeadersStart);
  const responseEndMs = at(timing.receiveHeadersEnd);
  const workerStartMs = at(timing.workerStart);
  const workerReadyMs = at(timing.workerReady);
  if (dnsStartMs !== undefined) normalized.dnsStartMs = dnsStartMs;
  if (dnsEndMs !== undefined) normalized.dnsEndMs = dnsEndMs;
  if (connectStartMs !== undefined) normalized.connectStartMs = connectStartMs;
  if (connectEndMs !== undefined) normalized.connectEndMs = connectEndMs;
  if (sslStartMs !== undefined) normalized.sslStartMs = sslStartMs;
  if (sslEndMs !== undefined) normalized.sslEndMs = sslEndMs;
  if (requestSentMs !== undefined) normalized.requestSentMs = requestSentMs;
  if (responseStartMs !== undefined) normalized.responseStartMs = responseStartMs;
  if (responseEndMs !== undefined) normalized.responseEndMs = responseEndMs;
  if (workerStartMs !== undefined) normalized.workerStartMs = workerStartMs;
  if (workerReadyMs !== undefined) normalized.workerReadyMs = workerReadyMs;
  return normalized;
}

function getResponseBodySkipReason(record: NetworkRecordState): string | undefined {
  return getResponseBodySkipReasonForMetadata({
    method: record.method,
    status: record.status,
    resourceType: record.resourceType,
    url: record.url,
    captureState: record.captureState,
  });
}

function getResponseBodySkipReasonForMetadata(input: {
  readonly method: string;
  readonly status: number | undefined;
  readonly resourceType: NetworkRecordState["resourceType"];
  readonly url: string;
  readonly captureState: NetworkRecordState["captureState"];
}): string | undefined {
  if (input.captureState === "failed") {
    return "request-failed";
  }
  if (input.method.toUpperCase() === "HEAD") {
    return "head-request";
  }
  if (input.status !== undefined && [204, 205, 304].includes(input.status)) {
    return "status-without-body";
  }
  if (input.status !== undefined && input.status >= 300 && input.status < 400) {
    return "redirect-response";
  }
  if (
    input.resourceType === "preflight" ||
    input.resourceType === "websocket" ||
    input.resourceType === "event-stream"
  ) {
    return "unsupported-resource-type";
  }
  if (/^(blob|data):/i.test(input.url)) {
    return "unsupported-url-scheme";
  }
  return undefined;
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  signal.throwIfAborted?.();

  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
        },
        { once: true },
      );
    }),
  ]);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined) {
    return promise;
  }

  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => {
        reject(createBrowserCoreError("timeout", `page evaluation timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);
    }),
  ]);
}
