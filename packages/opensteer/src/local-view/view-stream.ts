import type { Page, Browser, BrowserContext, CDPSession } from "playwright";
import WebSocket, { type RawData } from "ws";

import type { OpensteerViewport, OpensteerViewStreamTab } from "@opensteer/protocol";

import { orderPagesByBrowserTargetOrder } from "./browser-target-order.js";
import { resolveLocalViewSession } from "./discovery.js";
import { LocalViewRuntimeState } from "./runtime-state.js";
import { TabStateTracker } from "./tab-state-tracker.js";
import { selectScreencastSize, type RequestedStreamSize } from "./view-stream-capture-policy.js";
import {
  buildErrorMessage,
  buildHelloMessage,
  buildStatusMessage,
  buildTabsMessage,
  parseViewClientMessage,
  sendControlMessage,
} from "./view-stream-protocol.js";
import type { LocalViewSocket } from "./ws-types.js";

const INITIAL_FRAME_CAPTURE_ATTEMPTS = 3;
const INITIAL_FRAME_CAPTURE_RETRY_DELAY_MS = 150;
const TAB_STATE_POLL_MS = 1_000;
const CLIENT_FRAME_FLUSH_RETRY_MS = 16;

interface ClientStreamState {
  requestedRenderSize: RequestedStreamSize | null;
  frameSendInFlight: boolean;
  pendingFrameBuffer: Buffer | null;
  pendingFlushTimer: NodeJS.Timeout | null;
}

export interface LocalViewStreamHubDeps {
  readonly runtimeState: LocalViewRuntimeState;
  readonly maxFps: number;
  readonly quality: number;
  readonly maxClientBufferBytes: number;
}

export class LocalViewStreamHub {
  private readonly deps: LocalViewStreamHubDeps;
  private readonly producers = new Map<string, SessionViewStreamProducer>();

  constructor(deps: LocalViewStreamHubDeps) {
    this.deps = deps;
  }

  attachClient(sessionId: string, ws: LocalViewSocket): void {
    let producer = this.producers.get(sessionId);
    if (!producer) {
      producer = new SessionViewStreamProducer({
        sessionId,
        runtimeState: this.deps.runtimeState,
        maxFps: this.deps.maxFps,
        quality: this.deps.quality,
        maxClientBufferBytes: this.deps.maxClientBufferBytes,
        onDrained: () => {
          this.producers.delete(sessionId);
        },
      });
      this.producers.set(sessionId, producer);
    }

    producer.addClient(ws);
  }
}

interface SessionViewStreamProducerDeps {
  readonly sessionId: string;
  readonly runtimeState: LocalViewRuntimeState;
  readonly maxFps: number;
  readonly quality: number;
  readonly maxClientBufferBytes: number;
  readonly onDrained: () => void;
}

class SessionViewStreamProducer {
  private readonly deps: SessionViewStreamProducerDeps;
  private readonly clients = new Set<LocalViewSocket>();
  private readonly clientStateBySocket = new Map<LocalViewSocket, ClientStreamState>();
  private readonly frameIntervalMs: number;
  private tracker: TabStateTracker | null = null;
  private browser: Browser | null = null;
  private browserDisconnectedHandler: ((browser: Browser) => void) | null = null;
  private context: BrowserContext | null = null;
  private cdpSession: CDPSession | null = null;
  private screencastHandler:
    | ((event: { readonly data: string; readonly sessionId: number }) => void)
    | null = null;
  private pageLifecycleCleanup: (() => void) | null = null;
  private activePage: Page | null = null;
  private activeViewport: OpensteerViewport | null = null;
  private activeScreencastSizeKey: string | null = null;
  private pendingFrameAckTimer: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;
  private started = false;
  private rebinding: Promise<void> = Promise.resolve();
  private stopped = false;
  private lastFrameSentAt = 0;
  private lastFrameBuffer: Buffer | null = null;
  private lastTabsPayload: {
    readonly tabs: readonly OpensteerViewStreamTab[];
    readonly activeTabIndex: number;
  } | null = null;

  constructor(deps: SessionViewStreamProducerDeps) {
    this.deps = deps;
    this.frameIntervalMs = Math.max(1, Math.floor(1000 / Math.max(1, deps.maxFps)));
  }

  addClient(ws: LocalViewSocket): void {
    if (this.stopped) {
      ws.close(1011, "View stream is unavailable.");
      return;
    }

    this.clients.add(ws);
    this.clientStateBySocket.set(ws, {
      requestedRenderSize: null,
      frameSendInFlight: false,
      pendingFrameBuffer: null,
      pendingFlushTimer: null,
    });

    if (this.activeViewport) {
      sendControlMessage(
        ws,
        buildHelloMessage({
          sessionId: this.deps.sessionId,
          fps: this.deps.maxFps,
          quality: this.deps.quality,
          viewport: this.activeViewport,
        }),
      );
    }
    if (this.lastTabsPayload) {
      sendControlMessage(
        ws,
        buildTabsMessage({
          sessionId: this.deps.sessionId,
          tabs: this.lastTabsPayload.tabs,
          activeTabIndex: this.lastTabsPayload.activeTabIndex,
        }),
      );
    }
    if (this.lastFrameBuffer) {
      const queued = this.enqueueFrameForClient(ws, this.lastFrameBuffer);
      if (!queued) {
        this.removeClient(ws);
        return;
      }
    }

    ws.on("close", () => {
      this.removeClient(ws);
    });
    ws.on("error", () => {
      this.removeClient(ws);
    });
    ws.on("message", (raw: RawData, isBinary: boolean) => {
      if (isBinary) {
        return;
      }
      const message = parseViewClientMessage(readTextFrame(raw));
      if (message?.type !== "stream-config") {
        return;
      }

      const nextSize = {
        width: message.renderWidth,
        height: message.renderHeight,
      };
      const clientState = this.clientStateBySocket.get(ws);
      if (!clientState) {
        return;
      }
      const priorSize = clientState.requestedRenderSize;
      if (priorSize?.width === nextSize.width && priorSize?.height === nextSize.height) {
        return;
      }
      clientState.requestedRenderSize = nextSize;
      this.maybeRebindForStreamConfigChange();
    });

    void this.ensureStarted();
  }

  private maybeRebindForStreamConfigChange(): void {
    if (!this.activePage || !this.started || this.stopped) {
      return;
    }

    const nextSizeKey = this.getRequestedScreencastSizeKey();
    if (nextSizeKey === this.activeScreencastSizeKey) {
      return;
    }

    void this.queueBindToPage(this.activePage, { force: true }).catch(() => undefined);
  }

  private removeClient(ws: LocalViewSocket): void {
    this.clients.delete(ws);
    const clientState = this.clientStateBySocket.get(ws);
    if (clientState?.pendingFlushTimer) {
      clearTimeout(clientState.pendingFlushTimer);
    }
    this.clientStateBySocket.delete(ws);
    if (this.clients.size === 0) {
      void this.stop();
      return;
    }
    this.maybeRebindForStreamConfigChange();
  }

  private async ensureStarted(): Promise<void> {
    if (this.stopped || this.started) {
      return;
    }
    if (this.starting) {
      return this.starting;
    }

    this.starting = this.start()
      .then(() => {
        if (!this.stopped) {
          this.started = true;
        }
      })
      .finally(() => {
        this.starting = null;
      });

    try {
      await this.starting;
    } catch {
      this.broadcastControl(
        buildErrorMessage({
          sessionId: this.deps.sessionId,
          error: "Failed to start live browser stream.",
        }),
      );
      this.closeAllClients(1011, "View stream failed");
      await this.stop();
    }
  }

  private async start(): Promise<void> {
    const session = await this.connectSession();
    this.broadcastControl(
      buildStatusMessage({
        sessionId: this.deps.sessionId,
        status: "starting",
      }),
    );

    this.browser = session.browser;
    this.browserDisconnectedHandler = () => {
      if (this.stopped) {
        return;
      }
      this.browserDisconnectedHandler = null;
      this.broadcastControl(
        buildErrorMessage({
          sessionId: this.deps.sessionId,
          error: "Live browser stream disconnected.",
        }),
      );
      this.closeAllClients(1011, "View stream failed");
      void this.stop();
    };
    this.browser.once("disconnected", this.browserDisconnectedHandler);

    this.context = session.context;
    this.activePage = session.page;
    this.activeViewport = await readViewportForPage(session.page);
    if (this.stopped) {
      return;
    }
    if (this.activeViewport) {
      this.broadcastControl(
        buildHelloMessage({
          sessionId: this.deps.sessionId,
          fps: this.deps.maxFps,
          quality: this.deps.quality,
          viewport: this.activeViewport,
        }),
      );
    }

    this.tracker = new TabStateTracker({
      browserContext: session.context,
      sessionId: this.deps.sessionId,
      pollMs: TAB_STATE_POLL_MS,
      runtimeState: this.deps.runtimeState,
      initialActivePage: session.page,
      onActivePageChanged: (page) => {
        this.activePage = page;
        void this.queueBindToPage(page).catch(() => undefined);
      },
      onTabsChanged: ({ tabs, activeTabIndex }) => {
        this.lastTabsPayload = { tabs, activeTabIndex };
        this.broadcastControl(
          buildTabsMessage({
            sessionId: this.deps.sessionId,
            tabs,
            activeTabIndex,
          }),
        );
      },
    });
    this.tracker.start();

    await this.queueBindToPage(session.page);
    if (this.stopped) {
      return;
    }
    this.broadcastControl(
      buildStatusMessage({
        sessionId: this.deps.sessionId,
        status: "live",
      }),
    );
  }

  private queueBindToPage(
    page: Page,
    options: {
      readonly force?: boolean;
    } = {},
  ): Promise<void> {
    this.rebinding = this.rebinding
      .catch(() => undefined)
      .then(() => this.bindToPage(page, options));
    return this.rebinding;
  }

  private async bindToPage(
    page: Page,
    options: {
      readonly force?: boolean;
    } = {},
  ): Promise<void> {
    if (this.stopped) {
      return;
    }
    const requestedSizeKey = this.getRequestedScreencastSizeKey();
    if (
      !options.force &&
      this.activePage === page &&
      this.cdpSession &&
      this.activeScreencastSizeKey === requestedSizeKey
    ) {
      return;
    }

    await this.stopScreencast();
    if (this.stopped) {
      return;
    }

    const context = this.context;
    if (!context) {
      throw new Error("Browser context is unavailable.");
    }
    const requestedSize = this.getRequestedScreencastSize();
    this.activePage = page;
    this.activeScreencastSizeKey = requestedSizeKey;
    this.activeViewport = await readViewportForPage(page);
    if (this.activeViewport) {
      this.broadcastControl(
        buildHelloMessage({
          sessionId: this.deps.sessionId,
          fps: this.deps.maxFps,
          quality: this.deps.quality,
          viewport: this.activeViewport,
        }),
      );
    }

    const cdpSession = await context.newCDPSession(page);
    if (this.stopped) {
      await cdpSession.detach().catch(() => undefined);
      return;
    }
    this.cdpSession = cdpSession;

    const onFrame = (event: { readonly data: string; readonly sessionId: number }) => {
      void this.handleScreencastFrame(event);
    };
    this.screencastHandler = onFrame;

    cdpSession.on("Page.screencastFrame", onFrame);
    await cdpSession.send("Page.enable");
    await cdpSession.send("Page.startScreencast", {
      format: "jpeg",
      quality: this.deps.quality,
      everyNthFrame: 1,
      ...(requestedSize
        ? {
            maxWidth: requestedSize.width,
            maxHeight: requestedSize.height,
          }
        : {}),
    });
    this.bindPageLifecycleFrameRefresh(page, cdpSession);
    void this.seedInitialFrame(cdpSession).catch(() => undefined);
  }

  private async connectSession(): Promise<{
    readonly browser: Browser;
    readonly context: BrowserContext;
    readonly page: Page;
  }> {
    const resolved = await resolveLocalViewSession(this.deps.sessionId);
    if (!resolved) {
      throw new Error(`Local view session ${this.deps.sessionId} is unavailable.`);
    }

    const browser = await connectPlaywrightChromiumBrowser({
      url: resolved.browserWebSocketUrl,
    });
    try {
      const context = browser.contexts()[0];
      if (!context) {
        throw new Error("Connected browser did not expose a Chromium browser context.");
      }

      const existingPages = context.pages();
      if (existingPages.length === 0) {
        const page = await context.newPage();
        return {
          browser,
          context,
          page,
        };
      }

      const orderedPages = await orderPagesByBrowserTargetOrder(context, existingPages);
      const page =
        (await resolvePersistedActivePage(orderedPages, {
          ...(resolved.record.activePageUrl === undefined
            ? {}
            : { activePageUrl: resolved.record.activePageUrl }),
          ...(resolved.record.activePageTitle === undefined
            ? {}
            : { activePageTitle: resolved.record.activePageTitle }),
        })) ?? orderedPages[0]!;
      return {
        browser,
        context,
        page,
      };
    } catch (error) {
      await disconnectPlaywrightChromiumBrowser(browser).catch(() => undefined);
      throw error;
    }
  }

  private async handleScreencastFrame(event: {
    readonly data: string;
    readonly sessionId: number;
  }): Promise<void> {
    const cdpSession = this.cdpSession;
    if (!cdpSession || this.stopped) {
      return;
    }

    const frameBuffer = Buffer.from(event.data, "base64");
    this.lastFrameBuffer = frameBuffer;

    const now = Date.now();
    const delayMs = Math.max(0, this.frameIntervalMs - (now - this.lastFrameSentAt));
    if (delayMs === 0) {
      this.flushScreencastFrame({
        cdpSession,
        sessionId: event.sessionId,
        frameBuffer,
      });
      return;
    }

    if (this.pendingFrameAckTimer !== null) {
      return;
    }

    this.pendingFrameAckTimer = setTimeout(() => {
      this.pendingFrameAckTimer = null;
      if (this.stopped || this.cdpSession !== cdpSession) {
        return;
      }
      this.flushScreencastFrame({
        cdpSession,
        sessionId: event.sessionId,
        frameBuffer,
      });
    }, delayMs);
  }

  private flushScreencastFrame(args: {
    readonly cdpSession: CDPSession;
    readonly sessionId: number;
    readonly frameBuffer: Buffer;
  }): void {
    this.lastFrameSentAt = Date.now();
    this.broadcastFrame(args.frameBuffer);
    void args.cdpSession
      .send("Page.screencastFrameAck", { sessionId: args.sessionId })
      .catch(() => undefined);
  }

  private broadcastFrame(frameBuffer: Buffer): void {
    for (const client of this.clients) {
      if (!this.enqueueFrameForClient(client, frameBuffer)) {
        this.removeClient(client);
      }
    }

    if (this.clients.size === 0) {
      void this.stop();
    }
  }

  private enqueueFrameForClient(client: LocalViewSocket, frameBuffer: Buffer): boolean {
    if (client.readyState !== WebSocket.OPEN) {
      return false;
    }

    const clientState = this.clientStateBySocket.get(client);
    if (!clientState) {
      return false;
    }

    clientState.pendingFrameBuffer = frameBuffer;
    this.flushQueuedFrameToClient(client);
    return true;
  }

  private flushQueuedFrameToClient(client: LocalViewSocket): void {
    if (client.readyState !== WebSocket.OPEN) {
      this.removeClient(client);
      return;
    }

    const clientState = this.clientStateBySocket.get(client);
    if (!clientState || clientState.frameSendInFlight || !clientState.pendingFrameBuffer) {
      return;
    }

    if (clientState.pendingFlushTimer) {
      clearTimeout(clientState.pendingFlushTimer);
      clientState.pendingFlushTimer = null;
    }

    if (client.bufferedAmount > this.deps.maxClientBufferBytes) {
      clientState.pendingFlushTimer = setTimeout(() => {
        clientState.pendingFlushTimer = null;
        this.flushQueuedFrameToClient(client);
      }, CLIENT_FRAME_FLUSH_RETRY_MS);
      return;
    }

    const frameBuffer = clientState.pendingFrameBuffer;
    clientState.pendingFrameBuffer = null;
    clientState.frameSendInFlight = true;

    try {
      client.send(frameBuffer, { binary: true }, (error?: Error) => {
        const latestClientState = this.clientStateBySocket.get(client);
        if (latestClientState) {
          latestClientState.frameSendInFlight = false;
        }
        if (error) {
          this.removeClient(client);
          return;
        }
        this.flushQueuedFrameToClient(client);
      });
    } catch {
      clientState.frameSendInFlight = false;
      this.removeClient(client);
    }
  }

  private broadcastControl(message: Parameters<typeof sendControlMessage>[1]): void {
    for (const client of this.clients) {
      sendControlMessage(client, message);
    }
  }

  private closeAllClients(code: number, reason: string): void {
    for (const client of this.clients) {
      try {
        client.close(code, reason);
      } catch {}
    }
    this.clients.clear();
    for (const clientState of this.clientStateBySocket.values()) {
      if (clientState.pendingFlushTimer) {
        clearTimeout(clientState.pendingFlushTimer);
      }
    }
    this.clientStateBySocket.clear();
  }

  private async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.started = false;

    if (this.tracker) {
      this.tracker.stop();
      this.tracker = null;
    }
    await this.rebinding.catch(() => undefined);
    await this.stopScreencast();
    const browser = this.browser;
    const browserDisconnectedHandler = this.browserDisconnectedHandler;
    this.browser = null;
    this.browserDisconnectedHandler = null;
    this.context = null;
    this.activePage = null;
    if (browser) {
      if (browserDisconnectedHandler) {
        browser.off("disconnected", browserDisconnectedHandler);
      }
      await disconnectPlaywrightChromiumBrowser(browser).catch(() => undefined);
    }
    this.deps.onDrained();
  }

  private async stopScreencast(): Promise<void> {
    const cdpSession = this.cdpSession;
    const handler = this.screencastHandler;
    const pageLifecycleCleanup = this.pageLifecycleCleanup;

    this.cdpSession = null;
    this.screencastHandler = null;
    this.pageLifecycleCleanup = null;
    this.activeScreencastSizeKey = null;
    if (this.pendingFrameAckTimer !== null) {
      clearTimeout(this.pendingFrameAckTimer);
      this.pendingFrameAckTimer = null;
    }

    pageLifecycleCleanup?.();

    if (!cdpSession) {
      return;
    }

    if (handler) {
      cdpSession.off("Page.screencastFrame", handler);
    }

    await cdpSession.send("Page.stopScreencast").catch(() => undefined);
    await cdpSession.detach().catch(() => undefined);
  }

  private bindPageLifecycleFrameRefresh(page: Page, cdpSession: CDPSession): void {
    this.pageLifecycleCleanup?.();

    const refresh = () => {
      void this.refreshPageFrame(page, cdpSession).catch(() => undefined);
    };

    page.on("domcontentloaded", refresh);
    page.on("load", refresh);
    page.on("framenavigated", refresh);
    this.pageLifecycleCleanup = () => {
      page.off("domcontentloaded", refresh);
      page.off("load", refresh);
      page.off("framenavigated", refresh);
    };
  }

  private async refreshPageFrame(page: Page, cdpSession: CDPSession): Promise<void> {
    if (this.stopped || this.cdpSession !== cdpSession || this.activePage !== page) {
      return;
    }

    const viewport = await readViewportForPage(page);
    if (viewport && this.cdpSession === cdpSession && this.activePage === page) {
      this.activeViewport = viewport;
      this.broadcastControl(
        buildHelloMessage({
          sessionId: this.deps.sessionId,
          fps: this.deps.maxFps,
          quality: this.deps.quality,
          viewport,
        }),
      );
    }

    if (this.stopped || this.cdpSession !== cdpSession || this.activePage !== page) {
      return;
    }
    await this.seedInitialFrame(cdpSession);
  }

  private async seedInitialFrame(cdpSession: CDPSession): Promise<void> {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= INITIAL_FRAME_CAPTURE_ATTEMPTS; attempt += 1) {
      if (this.stopped || this.cdpSession !== cdpSession) {
        return;
      }

      try {
        const screenshotData = await this.captureCurrentFrame(cdpSession);
        if (this.stopped || this.cdpSession !== cdpSession) {
          return;
        }

        const frameBuffer = Buffer.from(screenshotData, "base64");
        this.lastFrameBuffer = frameBuffer;
        this.lastFrameSentAt = Date.now();
        this.broadcastFrame(frameBuffer);
        return;
      } catch (error) {
        lastError = error;
      }

      if (attempt < INITIAL_FRAME_CAPTURE_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, INITIAL_FRAME_CAPTURE_RETRY_DELAY_MS));
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }

    throw new Error("Failed to capture initial stream screenshot.");
  }

  private async captureCurrentFrame(cdpSession: CDPSession): Promise<string> {
    const primaryParams = {
      format: "jpeg" as const,
      quality: this.deps.quality,
      optimizeForSpeed: true as const,
    };
    try {
      const result = (await cdpSession.send("Page.captureScreenshot", primaryParams)) as {
        readonly data?: unknown;
      } | null;
      if (result && typeof result.data === "string" && result.data.length > 0) {
        return result.data;
      }
    } catch {}

    const fallbackResult = (await cdpSession.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: this.deps.quality,
    })) as {
      readonly data?: unknown;
    } | null;
    if (
      !fallbackResult ||
      typeof fallbackResult.data !== "string" ||
      fallbackResult.data.length === 0
    ) {
      throw new Error("Failed to capture initial stream screenshot.");
    }

    return fallbackResult.data;
  }

  private getRequestedScreencastSize(): RequestedStreamSize | null {
    if (this.clients.size === 0 || !this.activeViewport) {
      return null;
    }

    const requestedSizes: RequestedStreamSize[] = [];
    for (const client of this.clients) {
      const requestedSize = this.clientStateBySocket.get(client)?.requestedRenderSize ?? null;
      if (!requestedSize) {
        return null;
      }
      requestedSizes.push(requestedSize);
    }

    return selectScreencastSize({
      viewport: this.activeViewport,
      requestedSizes,
    });
  }

  private getRequestedScreencastSizeKey(): string | null {
    const size = this.getRequestedScreencastSize();
    return size ? `${size.width}x${size.height}` : null;
  }
}

async function readViewportForPage(page: Page): Promise<OpensteerViewport | null> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const result = (await cdp.send("Page.getLayoutMetrics")) as {
      readonly cssVisualViewport?: {
        readonly clientWidth?: unknown;
        readonly clientHeight?: unknown;
      };
      readonly cssLayoutViewport?: {
        readonly clientWidth?: unknown;
        readonly clientHeight?: unknown;
      };
      readonly visualViewport?: {
        readonly clientWidth?: unknown;
        readonly clientHeight?: unknown;
      };
      readonly layoutViewport?: {
        readonly clientWidth?: unknown;
        readonly clientHeight?: unknown;
      };
    } | null;
    const candidates = [
      result?.cssVisualViewport,
      result?.cssLayoutViewport,
      result?.visualViewport,
      result?.layoutViewport,
    ];

    for (const candidate of candidates) {
      const width = normalizeViewportDimension(candidate?.clientWidth);
      const height = normalizeViewportDimension(candidate?.clientHeight);
      if (width !== null && height !== null) {
        return { width, height };
      }
    }
    return null;
  } catch {
    const viewportSize = page.viewportSize();
    if (!viewportSize) {
      return null;
    }
    const width = normalizeViewportDimension(viewportSize.width);
    const height = normalizeViewportDimension(viewportSize.height);
    return width !== null && height !== null ? { width, height } : null;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

function normalizeViewportDimension(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  const normalized = Math.floor(value);
  if (normalized < 100) {
    return null;
  }
  return Math.min(8_192, normalized);
}

function readTextFrame(raw: RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  return raw.toString("utf8");
}

async function connectPlaywrightChromiumBrowser(input: { readonly url: string }): Promise<Browser> {
  const { connectPlaywrightChromiumBrowser: connect } =
    await import("@opensteer/engine-playwright");
  return connect(input);
}

async function disconnectPlaywrightChromiumBrowser(browser: Browser): Promise<void> {
  const { disconnectPlaywrightChromiumBrowser: disconnect } =
    await import("@opensteer/engine-playwright");
  await disconnect(browser);
}

async function resolvePersistedActivePage(
  pages: readonly Page[],
  input: {
    readonly activePageUrl?: string;
    readonly activePageTitle?: string;
  },
): Promise<Page | null> {
  if (pages.length === 0) {
    return null;
  }

  const matchesByUrl =
    input.activePageUrl === undefined
      ? pages
      : pages.filter((page) => page.url() === input.activePageUrl);
  if (matchesByUrl.length === 0) {
    return null;
  }
  if (input.activePageTitle === undefined) {
    return matchesByUrl[0] ?? null;
  }

  for (const page of matchesByUrl) {
    const title = await page.title().catch(() => "");
    if (title === input.activePageTitle) {
      return page;
    }
  }

  return matchesByUrl[0] ?? null;
}
