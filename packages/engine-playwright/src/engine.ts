import {
  createBodyPayload,
  createBrowserCoreError,
  createChooserRef,
  createDevicePixelRatio,
  createDocumentEpoch,
  createDocumentRef,
  createDownloadRef,
  createFrameRef,
  createHeaderEntry,
  createNetworkRequestId,
  createNodeRef,
  createPageRef,
  createPoint,
  createRect,
  createScrollOffset,
  createSessionRef,
  createSize,
  createPageScaleFactor,
  createPageZoomFactor,
  createDialogRef,
  nextDocumentEpoch,
  noBrowserCapabilities,
  mergeBrowserCapabilities,
  rectToQuad,
  unsupportedCapabilityError,
  staleNodeRefError,
  closedPageError,
  closedSessionError,
  type BodyPayload,
  type BrowserCapabilities,
  type BrowserCoreEngine,
  type CoordinateSpace,
  type CookieRecord,
  type DocumentEpoch,
  type DocumentRef,
  type DomSnapshot,
  type DomSnapshotNode,
  type FrameInfo,
  type FrameRef,
  type HeaderEntry,
  type HitTestResult,
  type HtmlSnapshot,
  type KeyModifier,
  type MouseButton,
  type NetworkRecord,
  type NetworkResourceType,
  type NetworkSourceMetadata,
  type NetworkTiming,
  type NetworkTransferSizes,
  type NodeLocator,
  type NodeRef,
  type PageInfo,
  type PageLifecycleState,
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
} from "@opensteer/browser-core";
import {
  chromium,
  errors as playwrightErrors,
  type Browser,
  type BrowserContext,
} from "playwright";
import type {
  CDPSession,
  ConsoleMessage,
  Cookie,
  Dialog,
  Download,
  Frame,
  Page,
  Request,
  Response,
} from "playwright";

const DEFAULT_BODY_CAPTURE_LIMIT_BYTES = 1024 * 1024;

const PLAYWRIGHT_BROWSER_CORE_CAPABILITIES: BrowserCapabilities = mergeBrowserCapabilities(
  noBrowserCapabilities(),
  {
    executor: {
      sessionLifecycle: true,
      pageLifecycle: true,
      navigation: true,
      pointerInput: true,
      keyboardInput: true,
      screenshots: true,
      executionControl: {
        freeze: true,
      },
    },
    inspector: {
      pageEnumeration: true,
      frameEnumeration: true,
      html: true,
      domSnapshot: true,
      text: true,
      attributes: true,
      hitTest: true,
      viewportMetrics: true,
      network: true,
      networkBodies: true,
      cookies: true,
      localStorage: true,
      sessionStorage: true,
      indexedDb: true,
    },
    events: {
      pageLifecycle: true,
      dialog: true,
      download: true,
      chooser: true,
      console: true,
      pageError: true,
    },
  },
);

export interface PlaywrightChromiumLaunchOptions {
  readonly headless?: boolean;
  readonly executablePath?: string;
  readonly channel?: string;
  readonly args?: readonly string[];
  readonly chromiumSandbox?: boolean;
  readonly devtools?: boolean;
  readonly downloadsPath?: string;
  readonly proxy?: {
    readonly server: string;
    readonly bypass?: string;
    readonly username?: string;
    readonly password?: string;
  };
  readonly slowMo?: number;
  readonly timeoutMs?: number;
}

export interface PlaywrightBrowserContextOptions {
  readonly ignoreHTTPSErrors?: boolean;
  readonly locale?: string;
  readonly timezoneId?: string;
  readonly userAgent?: string;
  readonly viewport?: {
    readonly width: number;
    readonly height: number;
  } | null;
  readonly javaScriptEnabled?: boolean;
  readonly bypassCSP?: boolean;
  readonly reducedMotion?: "reduce" | "no-preference";
  readonly colorScheme?: "light" | "dark" | "no-preference";
  readonly extraHTTPHeaders?: readonly HeaderEntry[];
}

export interface AdoptedChromiumBrowser {
  readonly browserType: () => { readonly name: () => string };
  readonly close: () => Promise<void>;
  readonly newContext: (options?: Record<string, unknown>) => Promise<unknown>;
}

export interface PlaywrightBrowserCoreEngineOptions {
  readonly browser?: AdoptedChromiumBrowser;
  readonly closeBrowserOnDispose?: boolean;
  readonly launch?: PlaywrightChromiumLaunchOptions;
  readonly context?: PlaywrightBrowserContextOptions;
  readonly bodyCaptureLimitBytes?: number;
}

interface SessionState {
  readonly sessionRef: SessionRef;
  readonly context: BrowserContext;
  readonly pageRefs: Set<PageRef>;
  readonly networkRecords: NetworkRecordState[];
  readonly pendingRegistrations: PendingPageRegistration[];
  readonly pendingPageTasks: Set<Promise<void>>;
}

interface PendingPageRegistration {
  readonly openerPageRef?: PageRef;
  readonly resolve: (controller: PageController) => void;
  readonly reject: (reason: unknown) => void;
}

interface PageController {
  readonly pageRef: PageRef;
  readonly sessionRef: SessionRef;
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly queuedEvents: StepEvent[];
  readonly framesByCdpId: Map<string, FrameState>;
  readonly frameBindings: WeakMap<Frame, FrameRef>;
  readonly documentsByRef: Map<DocumentRef, DocumentState>;
  readonly networkByRequest: Map<Request, NetworkRecordState>;
  readonly backgroundTasks: Set<Promise<void>>;
  openerPageRef: PageRef | undefined;
  mainFrameRef: FrameRef | undefined;
  lifecycleState: PageLifecycleState;
  frozen: boolean;
  explicitCloseInFlight: boolean;
  lastKnownTitle: string;
}

interface FrameState {
  readonly pageRef: PageRef;
  readonly frameRef: FrameRef;
  readonly cdpFrameId: string;
  parentFrameRef: FrameRef | undefined;
  name: string | undefined;
  isMainFrame: boolean;
  currentDocument: DocumentState;
}

interface DocumentState {
  readonly pageRef: PageRef;
  readonly frameRef: FrameRef;
  readonly cdpFrameId: string;
  readonly documentRef: DocumentRef;
  documentEpoch: DocumentEpoch;
  url: string;
  parentDocumentRef: DocumentRef | undefined;
  readonly nodeRefsByBackendNodeId: Map<number, NodeRef>;
  readonly backendNodeIdsByNodeRef: Map<NodeRef, number>;
}

interface FrameDescriptor {
  readonly id: string;
  readonly parentId?: string;
  readonly name?: string;
  readonly url: string;
  readonly urlFragment?: string;
}

interface FrameTreeNode {
  readonly frame: FrameDescriptor;
  readonly childFrames?: readonly FrameTreeNode[];
}

interface NetworkRecordState {
  readonly kind: "http";
  readonly requestId: ReturnType<typeof createNetworkRequestId>;
  readonly sessionRef: SessionRef;
  pageRef?: PageRef;
  frameRef?: FrameRef;
  documentRef?: DocumentRef;
  method: string;
  url: string;
  requestHeaders: HeaderEntry[];
  responseHeaders: HeaderEntry[];
  status?: number;
  statusText?: string;
  resourceType: NetworkResourceType;
  redirectFromRequestId?: ReturnType<typeof createNetworkRequestId>;
  redirectToRequestId?: ReturnType<typeof createNetworkRequestId>;
  navigationRequest: boolean;
  timing?: NetworkTiming;
  transfer?: NetworkTransferSizes;
  source?: NetworkSourceMetadata;
  requestBody?: BodyPayload;
  responseBody?: BodyPayload;
}

interface CapturedDomSnapshot {
  readonly capturedAt: number;
  readonly rawDocument: DomSnapshotDocument;
  readonly strings: readonly string[];
}

interface DomSnapshotDocument {
  readonly frameId: number;
  readonly nodes: {
    readonly parentIndex?: readonly number[];
    readonly nodeType?: readonly number[];
    readonly nodeName?: readonly number[];
    readonly nodeValue?: readonly number[];
    readonly backendNodeId?: readonly number[];
    readonly attributes?: ReadonlyArray<readonly number[]>;
    readonly textValue?: RareStringData;
    readonly inputValue?: RareStringData;
  };
  readonly layout: {
    readonly nodeIndex: readonly number[];
    readonly bounds: ReadonlyArray<readonly number[]>;
    readonly text: readonly number[];
    readonly paintOrders?: readonly number[];
  };
}

interface RareStringData {
  readonly index: readonly number[];
  readonly value: readonly number[];
}

interface NormalizedIndexedDbRecord {
  readonly key?: unknown;
  readonly keyEncoded?: unknown;
  readonly value?: unknown;
  readonly valueEncoded?: unknown;
}

interface NormalizedIndexedDbStore {
  readonly name: string;
  readonly keyPath?: string;
  readonly keyPathArray?: readonly string[];
  readonly autoIncrement: boolean;
  readonly records: readonly NormalizedIndexedDbRecord[];
}

interface NormalizedIndexedDbDatabase {
  readonly name: string;
  readonly version: number;
  readonly stores: readonly NormalizedIndexedDbStore[];
}

interface ExtendedStorageStateOrigin {
  readonly origin: string;
  readonly localStorage: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
  }>;
  readonly indexedDB?: readonly NormalizedIndexedDbDatabase[];
}

interface ExtendedStorageState {
  readonly cookies: readonly {
    readonly name: string;
    readonly value: string;
    readonly domain: string;
    readonly path: string;
    readonly expires: number;
    readonly httpOnly: boolean;
    readonly secure: boolean;
    readonly sameSite: "Strict" | "Lax" | "None";
  }[];
  readonly origins: readonly ExtendedStorageStateOrigin[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizeSameSite(value: Cookie["sameSite"]): CookieRecord["sameSite"] {
  switch (value) {
    case "Strict":
      return "strict";
    case "Lax":
      return "lax";
    case "None":
      return "none";
  }
}

function normalizeResourceType(value: string): NetworkResourceType {
  switch (value) {
    case "document":
    case "stylesheet":
    case "image":
    case "media":
    case "font":
    case "script":
    case "texttrack":
    case "xhr":
    case "fetch":
    case "websocket":
    case "manifest":
      return value;
    case "eventsource":
      return "event-stream";
    default:
      return "other";
  }
}

function normalizeDialogType(
  value: string,
): Extract<StepEvent, { readonly kind: "dialog-opened" }>["dialogType"] {
  switch (value) {
    case "alert":
    case "beforeunload":
    case "confirm":
    case "prompt":
      return value;
    default:
      return "alert";
  }
}

function normalizeConsoleLevel(
  value: ReturnType<ConsoleMessage["type"]>,
): Extract<StepEvent, { readonly kind: "console" }>["level"] {
  switch (value) {
    case "warning":
      return "warn";
    case "debug":
    case "info":
    case "error":
    case "trace":
      return value;
    default:
      return "log";
  }
}

function parseMimeType(value: string | undefined): {
  readonly mimeType?: string;
  readonly charset?: string;
} {
  if (value === undefined) {
    return {};
  }
  const [mimeTypePart, ...parts] = value.split(";");
  const mimeType = mimeTypePart?.trim();
  let charset: string | undefined;
  for (const part of parts) {
    const [name, rawValue] = part.split("=");
    if (name?.trim().toLowerCase() === "charset" && rawValue) {
      charset = rawValue.trim();
    }
  }
  return {
    ...(mimeType ? { mimeType } : {}),
    ...(charset ? { charset } : {}),
  };
}

function captureBodyPayload(
  bytes: Buffer | Uint8Array | null,
  contentType: string | undefined,
  limit: number,
): BodyPayload | undefined {
  if (bytes === null) {
    return undefined;
  }

  const buffer = bytes instanceof Buffer ? bytes : Buffer.from(bytes);
  const truncated = buffer.byteLength > limit;
  const captured = truncated ? buffer.subarray(0, limit) : buffer;
  const { mimeType, charset } = parseMimeType(contentType);
  return createBodyPayload(new Uint8Array(captured), {
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(charset === undefined ? {} : { charset }),
    truncated,
    ...(truncated ? { originalByteLength: buffer.byteLength } : {}),
  });
}

function combineFrameUrl(url: string, fragment?: string): string {
  return `${url}${fragment ?? ""}`;
}

function parseStringTable(strings: readonly string[], index: number | undefined): string {
  if (index === undefined) {
    return "";
  }
  return strings[index] ?? "";
}

function rareStringValue(
  strings: readonly string[],
  data: RareStringData | undefined,
  index: number,
): string | undefined {
  if (!data) {
    return undefined;
  }
  const rareIndex = data.index.indexOf(index);
  if (rareIndex === -1) {
    return undefined;
  }
  const stringIndex = data.value[rareIndex];
  return parseStringTable(strings, stringIndex);
}

function interleavedAttributesToEntries(values: readonly string[]): StorageEntry[] {
  const entries: StorageEntry[] = [];
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (key !== undefined && value !== undefined) {
      entries.push({ key, value });
    }
  }
  return entries;
}

function mapScreenshotFormat(format: ScreenshotFormat | undefined): ScreenshotFormat {
  return format ?? "png";
}

function unsupportedCoordinateSpace(coordinateSpace: CoordinateSpace): never {
  throw createBrowserCoreError(
    "unsupported-capability",
    `coordinate space ${coordinateSpace} is not supported by this backend`,
    { details: { coordinateSpace } },
  );
}

function unsupportedCursorCapture(): never {
  throw createBrowserCoreError(
    "unsupported-capability",
    "capturing the cursor in screenshots is not supported by this backend",
  );
}

function asChromiumBrowser(browser: AdoptedChromiumBrowser): Browser {
  return browser as unknown as Browser;
}

function buildContextOptions(
  options: PlaywrightBrowserContextOptions | undefined,
): Record<string, unknown> {
  if (!options) {
    return {
      acceptDownloads: true,
    };
  }

  return {
    acceptDownloads: true,
    ...(options.ignoreHTTPSErrors === undefined
      ? {}
      : { ignoreHTTPSErrors: options.ignoreHTTPSErrors }),
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    ...(options.timezoneId === undefined ? {} : { timezoneId: options.timezoneId }),
    ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
    ...(options.viewport === undefined ? {} : { viewport: options.viewport }),
    ...(options.javaScriptEnabled === undefined
      ? {}
      : { javaScriptEnabled: options.javaScriptEnabled }),
    ...(options.bypassCSP === undefined ? {} : { bypassCSP: options.bypassCSP }),
    ...(options.reducedMotion === undefined ? {} : { reducedMotion: options.reducedMotion }),
    ...(options.colorScheme === undefined ? {} : { colorScheme: options.colorScheme }),
    ...(options.extraHTTPHeaders === undefined
      ? {}
      : {
          extraHTTPHeaders: Object.fromEntries(
            options.extraHTTPHeaders.map((header) => [header.name, header.value]),
          ),
        }),
  };
}

function buildLaunchOptions(
  options: PlaywrightChromiumLaunchOptions | undefined,
): Record<string, unknown> {
  if (!options) {
    return {};
  }

  return {
    ...(options.headless === undefined ? {} : { headless: options.headless }),
    ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
    ...(options.channel === undefined ? {} : { channel: options.channel }),
    ...(options.args === undefined ? {} : { args: [...options.args] }),
    ...(options.chromiumSandbox === undefined ? {} : { chromiumSandbox: options.chromiumSandbox }),
    ...(options.devtools === undefined ? {} : { devtools: options.devtools }),
    ...(options.downloadsPath === undefined ? {} : { downloadsPath: options.downloadsPath }),
    ...(options.proxy === undefined ? {} : { proxy: options.proxy }),
    ...(options.slowMo === undefined ? {} : { slowMo: options.slowMo }),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  };
}

export class PlaywrightBrowserCoreEngine implements BrowserCoreEngine {
  readonly capabilities = PLAYWRIGHT_BROWSER_CORE_CAPABILITIES;

  private readonly browser: Browser;
  private readonly closeBrowserOnDispose: boolean;
  private readonly contextOptions: PlaywrightBrowserContextOptions | undefined;
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
  private disposed = false;

  private constructor(
    browser: Browser,
    closeBrowserOnDispose: boolean,
    options: PlaywrightBrowserCoreEngineOptions,
  ) {
    this.browser = browser;
    this.closeBrowserOnDispose = closeBrowserOnDispose;
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

  async createSession(): Promise<SessionRef> {
    this.assertNotDisposed();
    const sessionRef = createSessionRef(`playwright-${++this.sessionCounter}`);
    const context = await this.browser.newContext(buildContextOptions(this.contextOptions));
    const session: SessionState = {
      sessionRef,
      context,
      pageRefs: new Set<PageRef>(),
      networkRecords: [],
      pendingRegistrations: [],
      pendingPageTasks: new Set(),
    };
    this.sessions.set(sessionRef, session);

    context.on("page", (page) => {
      const task = this.handleContextPage(session, page).catch((error) => {
        if (this.isContextClosedError(error)) {
          return;
        }
        throw error;
      });
      session.pendingPageTasks.add(task);
      void task.finally(() => {
        session.pendingPageTasks.delete(task);
      });
    });

    return sessionRef;
  }

  async closeSession(input: { readonly sessionRef: SessionRef }): Promise<void> {
    const session = this.requireSession(input.sessionRef);
    for (const controller of Array.from(this.pages.values())) {
      if (controller.sessionRef === session.sessionRef) {
        controller.explicitCloseInFlight = true;
      }
    }
    await session.context.close();
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
      await controller.page.goto(input.url);
      controller.lastKnownTitle = await this.readTitle(controller.page, controller.lastKnownTitle);
    }
    await this.flushPendingPageTasks(session.sessionRef);

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
    await controller.page.close();
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
    const startedAt = Date.now();
    await controller.page.bringToFront();
    controller.lastKnownTitle = await this.readTitle(controller.page, controller.lastKnownTitle);
    await this.flushPendingPageTasks(controller.sessionRef);
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
        ...(input.referrer === undefined ? {} : { referer: input.referrer }),
        ...(input.timeoutMs === undefined ? {} : { timeout: input.timeoutMs }),
      });
    } catch (error) {
      throw this.normalizePlaywrightError(error, input.pageRef);
    }
    controller.lastKnownTitle = await this.readTitle(controller.page, controller.lastKnownTitle);
    await this.flushPendingPageTasks(controller.sessionRef);
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
        ...(input.timeoutMs === undefined ? {} : { timeout: input.timeoutMs }),
      });
    } catch (error) {
      throw this.normalizePlaywrightError(error, input.pageRef);
    }
    controller.lastKnownTitle = await this.readTitle(controller.page, controller.lastKnownTitle);
    await this.flushPendingPageTasks(controller.sessionRef);
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
    const beforeUrl = controller.page.url();
    try {
      await controller.page.goBack();
    } catch (error) {
      throw this.normalizePlaywrightError(error, input.pageRef);
    }
    controller.lastKnownTitle = await this.readTitle(controller.page, controller.lastKnownTitle);
    await this.flushPendingPageTasks(controller.sessionRef);
    const mainFrame = this.requireMainFrame(controller);
    const changed = controller.page.url() !== beforeUrl;

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
    const beforeUrl = controller.page.url();
    try {
      await controller.page.goForward();
    } catch (error) {
      throw this.normalizePlaywrightError(error, input.pageRef);
    }
    controller.lastKnownTitle = await this.readTitle(controller.page, controller.lastKnownTitle);
    await this.flushPendingPageTasks(controller.sessionRef);
    const mainFrame = this.requireMainFrame(controller);
    const changed = controller.page.url() !== beforeUrl;

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
    const point = this.toViewportPoint(metrics, input.point, input.coordinateSpace);
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
    });
    const metrics = await this.getViewportMetrics({ pageRef: input.pageRef });
    const point = this.toViewportPoint(metrics, input.point, input.coordinateSpace);
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
    const point = this.toViewportPoint(metrics, input.point, input.coordinateSpace);
    await controller.page.mouse.move(point.x, point.y);
    await controller.page.mouse.wheel(input.delta.x, input.delta.y);
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
      const viewportRect = this.toViewportRect(
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

    const response = await controller.cdp.send("Page.captureScreenshot", {
      format,
      ...(clip === undefined ? {} : { clip }),
      ...(input.fullPage ? { captureBeyondViewport: true } : {}),
      fromSurface: true,
    });
    const payload = createBodyPayload(new Uint8Array(Buffer.from(response.data, "base64")), {
      mimeType: `image/${format}`,
    });
    await this.flushPendingPageTasks(controller.sessionRef);
    const mainFrame = this.requireMainFrame(controller);
    const artifact: ScreenshotArtifact = {
      pageRef: controller.pageRef,
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      payload,
      format,
      size,
      coordinateSpace,
      ...(input.clip === undefined ? {} : { clip: input.clip }),
    };

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
    return Array.from(controller.framesByCdpId.values())
      .map((frame) => this.buildFrameInfo(frame))
      .sort((left, right) => Number(right.isMainFrame) - Number(left.isMainFrame));
  }

  async getPageInfo(input: { readonly pageRef: PageRef }): Promise<PageInfo> {
    return this.buildPageInfo(this.requirePage(input.pageRef));
  }

  async getFrameInfo(input: { readonly frameRef: FrameRef }): Promise<FrameInfo> {
    return this.buildFrameInfo(this.requireFrame(input.frameRef));
  }

  async getHtmlSnapshot(input: {
    readonly frameRef?: FrameRef;
    readonly documentRef?: DocumentRef;
  }): Promise<HtmlSnapshot> {
    const document = this.resolveDocumentTarget(input);
    const controller = this.requirePage(document.pageRef);
    const captured = await this.captureDomSnapshot(controller, document);
    const rootElementBackendNodeId = this.findHtmlBackendNodeId(captured, document);
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
    const captured = await this.captureDomSnapshot(controller, document);
    return this.buildDomSnapshot(document, captured);
  }

  async readText(input: NodeLocator): Promise<string | null> {
    const { controller, document, backendNodeId } = this.requireLiveNode(input);
    try {
      const resolved = await controller.cdp.send("DOM.resolveNode", {
        backendNodeId,
      });
      const objectId = resolved.object.objectId;
      if (!objectId) {
        throw staleNodeRefError(input);
      }

      const result = await controller.cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function () { return this.textContent; }",
        returnByValue: true,
        awaitPromise: true,
      });
      await controller.cdp.send("Runtime.releaseObject", { objectId });
      if ("value" in result.result) {
        return (result.result.value as string | null | undefined) ?? null;
      }
      return null;
    } catch (error) {
      this.rethrowNodeLookupError(error, document, input);
      throw error;
    }
  }

  async readAttributes(
    input: NodeLocator,
  ): Promise<readonly { readonly name: string; readonly value: string }[]> {
    const { controller, document, backendNodeId } = this.requireLiveNode(input);
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
      this.rethrowNodeLookupError(error, document, input);
      throw error;
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
    const metrics = await this.getViewportMetrics({ pageRef: input.pageRef });
    const viewportPoint = this.toViewportPoint(metrics, input.point, input.coordinateSpace);
    const documentPoint = this.toDocumentPoint(metrics, input.point, input.coordinateSpace);
    const raw = await controller.cdp.send("DOM.getNodeForLocation", {
      x: viewportPoint.x,
      y: viewportPoint.y,
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
    const layout = await controller.cdp.send("Page.getLayoutMetrics");
    const devicePixelRatio = await controller.page.evaluate(() =>
      Number((globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1),
    );
    return {
      layoutViewport: {
        origin: createPoint(layout.cssLayoutViewport.pageX, layout.cssLayoutViewport.pageY),
        size: createSize(
          layout.cssLayoutViewport.clientWidth,
          layout.cssLayoutViewport.clientHeight,
        ),
      },
      visualViewport: {
        origin: createPoint(layout.cssVisualViewport.pageX, layout.cssVisualViewport.pageY),
        offsetWithinLayoutViewport: createScrollOffset(
          layout.cssVisualViewport.offsetX,
          layout.cssVisualViewport.offsetY,
        ),
        size: createSize(
          layout.cssVisualViewport.clientWidth,
          layout.cssVisualViewport.clientHeight,
        ),
      },
      scrollOffset: createScrollOffset(
        layout.cssVisualViewport.pageX,
        layout.cssVisualViewport.pageY,
      ),
      contentSize: createSize(layout.cssContentSize.width, layout.cssContentSize.height),
      devicePixelRatio: createDevicePixelRatio(devicePixelRatio),
      pageScaleFactor: createPageScaleFactor(layout.cssVisualViewport.scale),
      pageZoomFactor: createPageZoomFactor(layout.cssVisualViewport.zoom ?? 1),
    };
  }

  async getNetworkRecords(input: {
    readonly sessionRef: SessionRef;
    readonly pageRef?: PageRef;
    readonly includeBodies?: boolean;
  }): Promise<readonly NetworkRecord[]> {
    const session = this.requireSession(input.sessionRef);
    await Promise.all(
      Array.from(session.pageRefs, async (pageRef) =>
        this.flushBackgroundTasks(this.requirePage(pageRef)),
      ),
    );

    const records = session.networkRecords.filter(
      (record) => input.pageRef === undefined || record.pageRef === input.pageRef,
    );

    if (!(input.includeBodies ?? false)) {
      return records.map(({ requestBody: _requestBody, responseBody: _responseBody, ...record }) =>
        clone(record as Omit<NetworkRecord, "requestBody" | "responseBody">),
      );
    }

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

  async executeRequest(input: {
    readonly sessionRef: SessionRef;
    readonly request: SessionTransportRequest;
  }): Promise<StepResult<SessionTransportResponse>> {
    void input;
    throw unsupportedCapabilityError("transport.sessionHttp");
  }

  private async handleContextPage(session: SessionState, page: Page): Promise<void> {
    const registration = session.pendingRegistrations.shift();
    try {
      const controller = await this.initializePageController(
        session,
        page,
        registration?.openerPageRef,
      );
      registration?.resolve(controller);
    } catch (error) {
      registration?.reject(error);
      throw error;
    }
  }

  private async initializePageController(
    session: SessionState,
    page: Page,
    forcedOpenerPageRef?: PageRef,
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
      queuedEvents: [],
      framesByCdpId: new Map(),
      frameBindings: new WeakMap(),
      documentsByRef: new Map(),
      networkByRequest: new Map(),
      backgroundTasks: new Set(),
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

    controller.openerPageRef = forcedOpenerPageRef;

    await cdp.send("Page.enable", { enableFileChooserOpenedEvent: true });
    await cdp.send("DOM.enable", { includeWhitespace: "none" });
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
    page.on("request", (request) => this.handleRequest(controller, request));
    page.on("response", (response) => this.handleResponse(controller, response));
    page.on("requestfinished", (request) => {
      void this.handleRequestFinished(controller, request);
    });
    page.on("requestfailed", (request) => {
      void this.handleRequestFailed(controller, request);
    });
    page.on("close", () => this.handleUnexpectedPageClose(controller));

    const frameTree = await cdp.send("Page.getFrameTree");
    this.syncFrameTree(controller, frameTree.frameTree);
    this.bindPlaywrightFrames(controller, frameTree.frameTree, page.mainFrame());
    controller.lastKnownTitle = await this.readTitle(page, controller.lastKnownTitle);
    this.queueEvent(
      controller.pageRef,
      this.createEvent<"page-created">({
        kind: "page-created",
        sessionRef: controller.sessionRef,
        pageRef: controller.pageRef,
      }),
    );

    if (forcedOpenerPageRef) {
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
      if (pendingOpenerPageRef) {
        this.pendingPopupOpeners.delete(page);
      }
      const opener = pendingOpenerPageRef ? null : await page.opener().catch(() => null);
      const openerController = pendingOpenerPageRef
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
    for (const frame of controller.framesByCdpId.values()) {
      frame.currentDocument.documentEpoch = nextDocumentEpoch(frame.currentDocument.documentEpoch);
      frame.currentDocument.nodeRefsByBackendNodeId.clear();
      frame.currentDocument.backendNodeIdsByNodeRef.clear();
    }
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

  private handleRequest(controller: PageController, request: Request): void {
    const frameContext = this.resolveRequestFrameContext(controller, request);
    const record: NetworkRecordState = {
      kind: "http",
      requestId: createNetworkRequestId(`playwright-${++this.requestCounter}`),
      sessionRef: controller.sessionRef,
      ...(frameContext?.pageRef === undefined ? {} : { pageRef: frameContext.pageRef }),
      ...(frameContext?.frameRef === undefined ? {} : { frameRef: frameContext.frameRef }),
      ...(frameContext?.documentRef === undefined ? {} : { documentRef: frameContext.documentRef }),
      method: request.method(),
      url: request.url(),
      requestHeaders: [],
      responseHeaders: [],
      resourceType: normalizeResourceType(request.resourceType()),
      navigationRequest: request.isNavigationRequest(),
    };

    const redirectedFrom = request.redirectedFrom();
    if (redirectedFrom) {
      const prior = controller.networkByRequest.get(redirectedFrom);
      if (prior) {
        record.redirectFromRequestId = prior.requestId;
        prior.redirectToRequestId = record.requestId;
      }
    }

    controller.networkByRequest.set(request, record);
    this.requireSession(controller.sessionRef).networkRecords.push(record);

    const task = (async () => {
      record.requestHeaders = (await request.headersArray()).map((header) =>
        createHeaderEntry(header.name, header.value),
      );
      const contentType = await request.headerValue("content-type");
      const requestBody = captureBodyPayload(
        request.postDataBuffer(),
        contentType ?? undefined,
        this.bodyCaptureLimitBytes,
      );
      if (requestBody) {
        record.requestBody = requestBody;
      }
    })();
    this.trackBackgroundTask(controller, task);
  }

  private handleResponse(controller: PageController, response: Response): void {
    const task = (async () => {
      const request = response.request();
      const record = controller.networkByRequest.get(request);
      if (!record) {
        return;
      }
      record.status = response.status();
      record.statusText = response.statusText();
      record.responseHeaders = (await response.headersArray()).map((header) =>
        createHeaderEntry(header.name, header.value),
      );
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
    })();
    this.trackBackgroundTask(controller, task);
  }

  private async handleRequestFinished(controller: PageController, request: Request): Promise<void> {
    const task = (async () => {
      const record = controller.networkByRequest.get(request);
      if (!record) {
        return;
      }
      const timing = request.timing();
      const sizes = await request.sizes();
      record.timing = {
        requestStartMs: timing.startTime,
        ...(timing.domainLookupStart >= 0
          ? { dnsStartMs: timing.startTime + timing.domainLookupStart }
          : {}),
        ...(timing.domainLookupEnd >= 0
          ? { dnsEndMs: timing.startTime + timing.domainLookupEnd }
          : {}),
        ...(timing.connectStart >= 0
          ? { connectStartMs: timing.startTime + timing.connectStart }
          : {}),
        ...(timing.connectEnd >= 0 ? { connectEndMs: timing.startTime + timing.connectEnd } : {}),
        ...(timing.secureConnectionStart >= 0
          ? { sslStartMs: timing.startTime + timing.secureConnectionStart }
          : {}),
        ...(timing.requestStart >= 0
          ? { requestSentMs: timing.startTime + timing.requestStart }
          : {}),
        ...(timing.responseStart >= 0
          ? { responseStartMs: timing.startTime + timing.responseStart }
          : {}),
        ...(timing.responseEnd >= 0
          ? { responseEndMs: timing.startTime + timing.responseEnd }
          : {}),
      };
      record.transfer = {
        requestHeadersBytes: sizes.requestHeadersSize,
        responseHeadersBytes: sizes.responseHeadersSize,
        encodedBodyBytes: sizes.responseBodySize,
        transferSizeBytes:
          sizes.requestHeadersSize + sizes.responseHeadersSize + sizes.responseBodySize,
        ...(record.responseBody === undefined
          ? {}
          : { decodedBodyBytes: record.responseBody.capturedByteLength }),
      };

      if (record.navigationRequest && record.frameRef) {
        const frame = this.requireFrame(record.frameRef);
        record.documentRef = frame.currentDocument.documentRef;
      }

      const response = await request.response();
      if (!response) {
        return;
      }
      if (record.status === undefined) {
        record.status = response.status();
      }
      if (record.statusText === undefined) {
        record.statusText = response.statusText();
      }
      if (record.responseHeaders.length === 0) {
        record.responseHeaders = (await response.headersArray()).map((header) =>
          createHeaderEntry(header.name, header.value),
        );
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
      const contentType = await response.headerValue("content-type");
      const responseBody = captureBodyPayload(
        await response.body(),
        contentType ?? undefined,
        this.bodyCaptureLimitBytes,
      );
      if (responseBody) {
        record.responseBody = responseBody;
        record.transfer = {
          ...(record.transfer ?? {}),
          ...(record.transfer?.requestHeadersBytes === undefined
            ? {}
            : { requestHeadersBytes: record.transfer.requestHeadersBytes }),
          ...(record.transfer?.responseHeadersBytes === undefined
            ? {}
            : { responseHeadersBytes: record.transfer.responseHeadersBytes }),
          ...(record.transfer?.encodedBodyBytes === undefined
            ? {}
            : { encodedBodyBytes: record.transfer.encodedBodyBytes }),
          decodedBodyBytes: responseBody.capturedByteLength,
          ...(record.transfer?.transferSizeBytes === undefined
            ? {}
            : { transferSizeBytes: record.transfer.transferSizeBytes }),
        };
      }
    })();
    this.trackBackgroundTask(controller, task);
    await task;
  }

  private async handleRequestFailed(controller: PageController, request: Request): Promise<void> {
    const task = (async () => {
      const record = controller.networkByRequest.get(request);
      if (!record) {
        return;
      }
      const timing = request.timing();
      record.timing = {
        requestStartMs: timing.startTime,
        ...(timing.requestStart >= 0
          ? { requestSentMs: timing.startTime + timing.requestStart }
          : {}),
        ...(timing.responseEnd >= 0
          ? { responseEndMs: timing.startTime + timing.responseEnd }
          : {}),
      };
    })();
    this.trackBackgroundTask(controller, task);
    await task;
  }

  private async collectSessionStorageSnapshots(
    session: SessionState,
  ): Promise<readonly SessionStorageSnapshot[]> {
    const snapshots: SessionStorageSnapshot[] = [];
    for (const pageRef of session.pageRefs) {
      const controller = this.requirePage(pageRef);
      await this.refreshFrameBindings(controller);
      for (const frame of controller.framesByCdpId.values()) {
        const playwrightFrame = this.findPlaywrightFrame(controller, frame.frameRef);
        if (!playwrightFrame) {
          continue;
        }
        let origin: string;
        try {
          origin = new URL(frame.currentDocument.url).origin;
        } catch {
          continue;
        }
        if (origin === "null") {
          continue;
        }
        const entries = await playwrightFrame.evaluate(() =>
          Object.entries(sessionStorage).map(([key, value]) => ({ key, value })),
        );
        snapshots.push({
          pageRef: controller.pageRef,
          frameRef: frame.frameRef,
          origin,
          entries,
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

  private async captureDomSnapshot(
    controller: PageController,
    document: DocumentState,
  ): Promise<CapturedDomSnapshot> {
    const capturedAt = Date.now();
    const result = await controller.cdp.send("DOMSnapshot.captureSnapshot", {
      computedStyles: [],
      includePaintOrder: true,
      includeDOMRects: true,
    });
    const rawDocument = result.documents.find(
      (candidate) => parseStringTable(result.strings, candidate.frameId) === document.cdpFrameId,
    );
    if (!rawDocument) {
      throw createBrowserCoreError(
        "not-found",
        `document ${document.documentRef} was not found in the current page snapshot`,
      );
    }
    return {
      capturedAt,
      rawDocument: rawDocument as DomSnapshotDocument,
      strings: result.strings,
    };
  }

  private buildDomSnapshot(document: DocumentState, captured: CapturedDomSnapshot): DomSnapshot {
    const parentIndexes = captured.rawDocument.nodes.parentIndex ?? [];
    const childIndexes = new Map<number, number[]>();
    for (let index = 0; index < parentIndexes.length; index += 1) {
      const parentIndex = parentIndexes[index];
      if (parentIndex === undefined || parentIndex < 0) {
        continue;
      }
      const children = childIndexes.get(parentIndex) ?? [];
      children.push(index);
      childIndexes.set(parentIndex, children);
    }

    const layoutByNodeIndex = new Map<
      number,
      {
        readonly rect?: Rect;
        readonly paintOrder?: number;
      }
    >();
    for (let index = 0; index < captured.rawDocument.layout.nodeIndex.length; index += 1) {
      const nodeIndex = captured.rawDocument.layout.nodeIndex[index];
      if (nodeIndex === undefined) {
        continue;
      }
      const bounds = captured.rawDocument.layout.bounds[index];
      layoutByNodeIndex.set(nodeIndex, {
        ...(bounds === undefined
          ? {}
          : {
              rect: createRect(bounds[0] ?? 0, bounds[1] ?? 0, bounds[2] ?? 0, bounds[3] ?? 0),
            }),
        ...(captured.rawDocument.layout.paintOrders?.[index] === undefined
          ? {}
          : { paintOrder: captured.rawDocument.layout.paintOrders[index] }),
      });
    }

    const nodes: DomSnapshotNode[] = [];
    const nodeCount = captured.rawDocument.nodes.nodeType?.length ?? 0;
    for (let index = 0; index < nodeCount; index += 1) {
      const backendNodeId = captured.rawDocument.nodes.backendNodeId?.[index];
      const nodeRef =
        backendNodeId === undefined
          ? undefined
          : this.nodeRefForBackendNode(document, backendNodeId);
      const rawAttributes = captured.rawDocument.nodes.attributes?.[index] ?? [];
      const attributes: { name: string; value: string }[] = [];
      for (let pairIndex = 0; pairIndex < rawAttributes.length; pairIndex += 2) {
        const nameIndex = rawAttributes[pairIndex];
        const valueIndex = rawAttributes[pairIndex + 1];
        if (nameIndex === undefined || valueIndex === undefined) {
          continue;
        }
        attributes.push({
          name: parseStringTable(captured.strings, nameIndex),
          value: parseStringTable(captured.strings, valueIndex),
        });
      }
      const layout = layoutByNodeIndex.get(index);
      const textContent =
        parseStringTable(captured.strings, captured.rawDocument.layout.text[index]) ||
        rareStringValue(captured.strings, captured.rawDocument.nodes.textValue, index) ||
        rareStringValue(captured.strings, captured.rawDocument.nodes.inputValue, index) ||
        (captured.rawDocument.nodes.nodeType?.[index] === 3
          ? parseStringTable(captured.strings, captured.rawDocument.nodes.nodeValue?.[index])
          : undefined);
      nodes.push({
        snapshotNodeId: index + 1,
        ...(nodeRef === undefined ? {} : { nodeRef }),
        ...(parentIndexes[index] === undefined || parentIndexes[index]! < 0
          ? {}
          : { parentSnapshotNodeId: parentIndexes[index]! + 1 }),
        childSnapshotNodeIds: (childIndexes.get(index) ?? []).map((childIndex) => childIndex + 1),
        nodeType: captured.rawDocument.nodes.nodeType?.[index] ?? 0,
        nodeName: parseStringTable(captured.strings, captured.rawDocument.nodes.nodeName?.[index]),
        nodeValue: parseStringTable(
          captured.strings,
          captured.rawDocument.nodes.nodeValue?.[index],
        ),
        ...(textContent === undefined || textContent.length === 0 ? {} : { textContent }),
        attributes,
        ...(layout?.rect === undefined
          ? {}
          : {
              layout: {
                rect: layout.rect,
                quad: rectToQuad(layout.rect),
                ...(layout.paintOrder === undefined ? {} : { paintOrder: layout.paintOrder }),
              },
            }),
      });
    }

    return {
      pageRef: document.pageRef,
      frameRef: document.frameRef,
      documentRef: document.documentRef,
      ...(document.parentDocumentRef === undefined
        ? {}
        : { parentDocumentRef: document.parentDocumentRef }),
      documentEpoch: document.documentEpoch,
      url: document.url,
      capturedAt: captured.capturedAt,
      rootSnapshotNodeId: 1,
      shadowDomMode: "flattened",
      geometryCoordinateSpace: "document-css",
      nodes,
    };
  }

  private findHtmlBackendNodeId(
    captured: CapturedDomSnapshot,
    document: DocumentState,
  ): number | undefined {
    const nodeNames = captured.rawDocument.nodes.nodeName ?? [];
    const backendNodeIds = captured.rawDocument.nodes.backendNodeId ?? [];
    for (let index = 0; index < nodeNames.length; index += 1) {
      const nodeName = parseStringTable(captured.strings, nodeNames[index]);
      if (nodeName === "HTML") {
        return backendNodeIds[index];
      }
    }
    const doc = this.documents.get(document.documentRef);
    return doc ? doc.backendNodeIdsByNodeRef.values().next().value : undefined;
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
      const document = this.documents.get(input.documentRef);
      if (!document) {
        throw createBrowserCoreError("not-found", `document ${input.documentRef} was not found`, {
          details: { documentRef: input.documentRef },
        });
      }
      return document;
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

  private rethrowNodeLookupError(
    error: unknown,
    document: DocumentState,
    input: NodeLocator,
  ): never {
    if (this.isNodeLookupFailure(error)) {
      throw staleNodeRefError({
        documentRef: document.documentRef,
        documentEpoch: input.documentEpoch,
        nodeRef: input.nodeRef,
      });
    }
    throw error;
  }

  private isNodeLookupFailure(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    return /No node with given id found|Could not find node with given id|Cannot find context/i.test(
      error.message,
    );
  }

  private resolveRequestFrameContext(
    controller: PageController,
    request: Request,
  ):
    | {
        readonly pageRef: PageRef;
        readonly frameRef?: FrameRef;
        readonly documentRef?: DocumentRef;
      }
    | undefined {
    const worker = request.serviceWorker();
    if (worker) {
      return {
        pageRef: controller.pageRef,
      };
    }
    try {
      const frame = request.frame();
      const frameRef = controller.frameBindings.get(frame);
      if (!frameRef) {
        return { pageRef: controller.pageRef };
      }
      const frameState = this.requireFrame(frameRef);
      return {
        pageRef: controller.pageRef,
        frameRef,
        documentRef: frameState.currentDocument.documentRef,
      };
    } catch {
      return { pageRef: controller.pageRef };
    }
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

  private cleanupPageController(controller: PageController): void {
    controller.lifecycleState = "closed";
    this.pages.delete(controller.pageRef);
    this.requireSession(controller.sessionRef).pageRefs.delete(controller.pageRef);
    for (const frame of controller.framesByCdpId.values()) {
      this.frames.delete(frame.frameRef);
      this.documents.delete(frame.currentDocument.documentRef);
      this.retiredDocuments.add(frame.currentDocument.documentRef);
    }
    controller.framesByCdpId.clear();
    controller.documentsByRef.clear();
  }

  private trackBackgroundTask(controller: PageController, promise: Promise<void>): void {
    controller.backgroundTasks.add(promise);
    void promise.finally(() => {
      controller.backgroundTasks.delete(promise);
    });
  }

  private async flushBackgroundTasks(controller: PageController): Promise<void> {
    if (controller.backgroundTasks.size === 0) {
      return;
    }
    await Promise.all(Array.from(controller.backgroundTasks));
  }

  private async flushPendingPageTasks(sessionRef: SessionRef): Promise<void> {
    const session = this.sessions.get(sessionRef);
    if (!session) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (session.pendingPageTasks.size === 0) {
      return;
    }
    await Promise.all(Array.from(session.pendingPageTasks));
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

  private toDocumentPoint(
    metrics: ViewportMetrics,
    point: Point,
    coordinateSpace: CoordinateSpace,
  ): Point {
    switch (coordinateSpace) {
      case "document-css":
        return point;
      case "layout-viewport-css":
        return createPoint(point.x + metrics.scrollOffset.x, point.y + metrics.scrollOffset.y);
      case "visual-viewport-css":
        return createPoint(
          point.x + metrics.visualViewport.origin.x,
          point.y + metrics.visualViewport.origin.y,
        );
      case "device-pixel":
        return createPoint(
          point.x / metrics.devicePixelRatio + metrics.scrollOffset.x,
          point.y / metrics.devicePixelRatio + metrics.scrollOffset.y,
        );
      case "screen":
      case "window":
        unsupportedCoordinateSpace(coordinateSpace);
    }
  }

  private toViewportPoint(
    metrics: ViewportMetrics,
    point: Point,
    coordinateSpace: CoordinateSpace,
  ): Point {
    switch (coordinateSpace) {
      case "layout-viewport-css":
      case "visual-viewport-css":
        return point;
      case "document-css":
        return createPoint(point.x - metrics.scrollOffset.x, point.y - metrics.scrollOffset.y);
      case "device-pixel":
        return createPoint(point.x / metrics.devicePixelRatio, point.y / metrics.devicePixelRatio);
      case "screen":
      case "window":
        unsupportedCoordinateSpace(coordinateSpace);
    }
  }

  private toViewportRect(
    metrics: ViewportMetrics,
    rect: Rect,
    coordinateSpace: CoordinateSpace,
  ): Rect {
    const origin = this.toViewportPoint(metrics, createPoint(rect.x, rect.y), coordinateSpace);
    return createRect(origin.x, origin.y, rect.width, rect.height);
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

  private findPlaywrightFrame(controller: PageController, frameRef: FrameRef): Frame | undefined {
    for (const frame of controller.page.frames()) {
      if (controller.frameBindings.get(frame) === frameRef) {
        return frame;
      }
    }
    return undefined;
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

  private normalizePlaywrightError(error: unknown, pageRef: PageRef): Error {
    if (error instanceof playwrightErrors.TimeoutError) {
      return createBrowserCoreError("timeout", error.message, { cause: error });
    }
    if (error instanceof Error && /Navigation failed/i.test(error.message)) {
      return createBrowserCoreError("navigation-failed", error.message, {
        cause: error,
        details: { pageRef },
      });
    }
    if (error instanceof Error) {
      return createBrowserCoreError("operation-failed", error.message, {
        cause: error,
        details: { pageRef },
      });
    }
    return createBrowserCoreError("operation-failed", "Playwright operation failed", {
      cause: error,
      details: { pageRef },
    });
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw createBrowserCoreError("operation-failed", "engine has been disposed");
    }
  }

  private isContextClosedError(error: unknown): boolean {
    return (
      error instanceof Error &&
      /Target page, context or browser has been closed/i.test(error.message)
    );
  }
}

export async function createPlaywrightBrowserCoreEngine(
  options: PlaywrightBrowserCoreEngineOptions = {},
): Promise<PlaywrightBrowserCoreEngine> {
  return PlaywrightBrowserCoreEngine.create(options);
}
