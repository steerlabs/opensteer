import {
  bodyPayloadFromUtf8,
  closedPageError,
  closedSessionError,
  createBodyPayload,
  createBrowserCoreError,
  createChooserRef,
  createDevicePixelRatio,
  createDialogRef,
  createDocumentEpoch,
  createDocumentRef,
  createDownloadRef,
  createFrameRef,
  createHeaderEntry,
  createNetworkRequestId,
  createNodeRef,
  createPageRef,
  createPageScaleFactor,
  createPageZoomFactor,
  createPoint,
  createScrollOffset,
  createSessionRef,
  createSize,
  filterCookieRecords,
  isBrowserCoreError,
  staleNodeRefError,
  unsupportedCapabilityError,
  type GetNetworkRecordsInput,
  type BrowserCoreEngine,
  type BodyPayload,
  type CoordinateSpace,
  type CookieRecord,
  type DocumentEpoch,
  type DocumentRef,
  type DomSnapshot,
  type FrameInfo,
  type FrameRef,
  type HitTestResult,
  type HtmlSnapshot,
  type IndexedDbDatabaseSnapshot,
  type IndexedDbObjectStoreSnapshot,
  type KeyModifier,
  type MouseButton,
  type NetworkRecord,
  type NetworkResourceType,
  type NodeLocator,
  type NodeRef,
  type PageInfo,
  type PageRef,
  type Point,
  type ScreenshotArtifact,
  type ScreenshotFormat,
  type SessionRef,
  type SessionStorageSnapshot,
  type SessionTransportRequest,
  type SessionTransportResponse,
  type StepEvent,
  type StepResult,
  type StorageEntry,
  type StorageOriginSnapshot,
  type StorageSnapshot,
  type ViewportMetrics,
} from "@opensteer/browser-core";
import {
  OPENSTEER_COMPUTER_USE_BRIDGE_SYMBOL,
  OPENSTEER_DOM_ACTION_BRIDGE_SYMBOL,
  type ComputerUseBridge,
  type DomActionBridge,
} from "@opensteer/protocol";
import { STATUS_CODES } from "node:http";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ABP_BROWSER_CORE_CAPABILITIES,
  normalizeAbpBaseUrl,
  normalizeRemoteDebuggingUrl,
  type AbpBrowserCoreEngineOptions,
  type AbpLaunchOptions,
  type AdoptedAbpBrowser,
} from "./options.js";
import { derivePageWebSocketUrl, fetchBrowserWebSocketUrl } from "./cdp-discovery.js";
import {
  BROWSER_CDP_METHOD_ALLOWLIST,
  CdpClient,
  PAGE_CDP_METHOD_ALLOWLIST,
} from "./cdp-transport.js";
import { toDocumentPoint, toViewportPoint } from "./coordinate.js";
import {
  buildDomSnapshot as buildDomSnapshotFromCapture,
  capturePageDomSnapshot,
  findCapturedDocument,
  findHtmlBackendNodeId,
  readTextContent,
  resolveCapturedContentDocumentRef,
  updateDocumentTreeSignature,
} from "./dom.js";
import {
  AbpApiError,
  isActionTimeoutError,
  isPageClosedApiError,
  normalizeAbpError,
  rethrowNodeLookupError,
} from "./errors.js";
import { allocatePort, launchAbpProcess } from "./launcher.js";
import { normalizeSelectChooserEventData } from "./action-events.js";
import {
  clampAbpActionSettleTimeout,
  createAbpActionSettler,
  DEFAULT_ABP_ACTION_SETTLE_TIMEOUT_MS,
} from "./action-settle.js";
import {
  AbpRestClient,
  buildImmediateActionRequest,
  buildImmediateScreenshotRequest,
  buildInputActionRequest,
} from "./rest-client.js";
import { createAbpComputerUseBridge } from "./computer-use.js";
import { createAbpDomActionBridge } from "./dom-action-bridge.js";
import { buildAbpScrollSegments } from "./scroll.js";
import {
  chooseNextActivePageRef,
  resolveTabOpeners,
  shouldClaimBootstrapTab,
  shouldParkPageAsBootstrap,
} from "./session-model.js";
import { type DiscoveredTabEffects, resolveTabChangePageRef } from "./tab-change.js";
import type {
  AbpActionEvent,
  AbpActionResponse,
  AbpCdpCookie,
  AbpCdpTargetInfo,
  AbpDomStorageItemsResult,
  AbpIndexedDbDataResult,
  AbpIndexedDbDatabaseNamesResult,
  AbpIndexedDbDatabaseResult,
  AbpNetworkCall,
  AbpStorageKeyResult,
  AbpTab,
  CapturedDomSnapshot,
  DocumentState,
  FrameDescriptor,
  FrameState,
  FrameTreeNode,
  PageController,
  SessionState,
} from "./types.js";

export type {
  AbpLaunchOptions,
  AdoptedAbpBrowser,
  AbpBrowserCoreEngineOptions,
} from "./options.js";

interface MainFrameSnapshot {
  readonly documentRef: DocumentRef;
  readonly documentEpoch: DocumentEpoch;
  readonly url: string;
  readonly title: string;
}

interface LocalStorageOriginState {
  readonly origin: string;
  readonly storageKey: string;
}

interface SessionHttpScriptResponse {
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly bodyBase64?: string;
  readonly redirected: boolean;
}

interface SessionHttpScriptPendingResult {
  readonly state: "pending";
}

interface SessionHttpScriptFulfilledResult {
  readonly state: "fulfilled";
  readonly response: SessionHttpScriptResponse;
}

interface SessionHttpScriptRejectedResult {
  readonly state: "rejected";
  readonly error: {
    readonly name?: string;
    readonly message: string;
  };
}

type SessionHttpScriptPollResult =
  | SessionHttpScriptPendingResult
  | SessionHttpScriptFulfilledResult
  | SessionHttpScriptRejectedResult;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function combineFrameUrl(url: string, fragment?: string): string {
  return `${url}${fragment ?? ""}`;
}

function isAbpPageClosedError(error: unknown): boolean {
  return isPageClosedApiError(error) || (isBrowserCoreError(error) && error.code === "page-closed");
}

function buildSessionHttpStartScript(request: SessionTransportRequest): string {
  const serialized = JSON.stringify({
    url: request.url,
    method: request.method,
    headers: (request.headers ?? []).map((header) => [header.name, header.value]),
    bodyBase64:
      request.body === undefined ? undefined : Buffer.from(request.body.bytes).toString("base64"),
    followRedirects: request.followRedirects !== false,
    timeoutMs: request.timeoutMs,
  });

  return `(() => {
    const input = ${serialized};
    const state = globalThis.__opensteerSessionHttp ?? (globalThis.__opensteerSessionHttp = {
      nextId: 0,
      requests: Object.create(null),
    });
    const requestId = String(++state.nextId);
    state.requests[requestId] = { state: "pending" };

    const decodeBase64 = (value) => {
      if (typeof value !== "string") {
        return undefined;
      }
      const binary = atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    };

    const encodeBase64 = (bytes) => {
      let binary = "";
      const chunkSize = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const chunk = bytes.subarray(offset, offset + chunkSize);
        binary += String.fromCharCode(...chunk);
      }
      return btoa(binary);
    };

    const headers = new Headers();
    for (const [name, value] of input.headers) {
      headers.append(name, value);
    }

    const controller = new AbortController();
    const timeoutId =
      typeof input.timeoutMs === "number"
        ? setTimeout(
            () => controller.abort(new DOMException("session HTTP timed out", "AbortError")),
            input.timeoutMs,
          )
        : undefined;

    void fetch(input.url, {
      method: input.method,
      headers,
      credentials: "include",
      redirect: input.followRedirects ? "follow" : "manual",
      signal: controller.signal,
      ...(input.bodyBase64 === undefined ? {} : { body: decodeBase64(input.bodyBase64) }),
    })
      .then(async (response) => {
        const body = new Uint8Array(await response.arrayBuffer());
        const responseHeaders = [];
        response.headers.forEach((value, name) => {
          responseHeaders.push([name, value]);
        });
        state.requests[requestId] = {
          state: "fulfilled",
          response: {
            url: response.url,
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            bodyBase64: encodeBase64(body),
            redirected: response.redirected,
          },
        };
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      })
      .catch((error) => {
        state.requests[requestId] = {
          state: "rejected",
          error: {
            ...(error && typeof error.name === "string" ? { name: error.name } : {}),
            message:
              error && typeof error.message === "string"
                ? error.message
                : "session HTTP request failed",
          },
        };
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      });

    return requestId;
  })()`;
}

function buildSessionHttpPollScript(requestId: string): string {
  return `(() => {
    const requests = globalThis.__opensteerSessionHttp?.requests;
    const result = requests?.[${JSON.stringify(requestId)}];
    if (!result || result.state === "pending") {
      return { state: "pending" };
    }
    delete requests[${JSON.stringify(requestId)}];
    return result;
  })()`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeSessionHttpScriptResponse(value: unknown): SessionHttpScriptResponse {
  if (!isRecord(value)) {
    throw new Error("ABP session HTTP returned an invalid response payload");
  }

  const { url, status, statusText, headers, bodyBase64, redirected } = value;
  if (
    typeof url !== "string" ||
    !Number.isInteger(status) ||
    typeof statusText !== "string" ||
    !Array.isArray(headers) ||
    typeof redirected !== "boolean" ||
    (bodyBase64 !== undefined && typeof bodyBase64 !== "string")
  ) {
    throw new Error("ABP session HTTP returned an invalid response payload");
  }

  const normalizedHeaders = headers.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error("ABP session HTTP returned invalid response headers");
    }
    const [name, headerValue] = entry;
    if (typeof name !== "string" || typeof headerValue !== "string") {
      throw new Error("ABP session HTTP returned invalid response headers");
    }
    return [name, headerValue] as const;
  });
  const normalizedStatus = status as number;

  return {
    url,
    status: normalizedStatus,
    statusText,
    headers: normalizedHeaders,
    ...(bodyBase64 === undefined ? {} : { bodyBase64 }),
    redirected,
  };
}

function normalizeSessionHttpScriptPollResult(value: unknown): SessionHttpScriptPollResult {
  if (!isRecord(value) || typeof value.state !== "string") {
    throw new Error("ABP session HTTP returned an invalid execution state");
  }

  switch (value.state) {
    case "pending":
      return { state: "pending" };
    case "fulfilled":
      if (!isRecord(value.response)) {
        throw new Error("ABP session HTTP returned an invalid completion state");
      }
      return {
        state: "fulfilled",
        response: normalizeSessionHttpScriptResponse(value.response),
      };
    case "rejected":
      if (!isRecord(value.error) || typeof value.error.message !== "string") {
        throw new Error("ABP session HTTP returned an invalid failure state");
      }
      return {
        state: "rejected",
        error: {
          ...(typeof value.error.name === "string" ? { name: value.error.name } : {}),
          message: value.error.message,
        },
      };
    default:
      throw new Error("ABP session HTTP returned an unknown execution state");
  }
}

function headerValue(
  headers: readonly { readonly name: string; readonly value: string }[],
  name: string,
): string | undefined {
  const lowered = name.toLowerCase();
  return headers.find((header) => header.name.toLowerCase() === lowered)?.value;
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

function normalizeDialogType(
  value: string | undefined,
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

function normalizeCookieSameSite(value: AbpCdpCookie["sameSite"]): CookieRecord["sameSite"] {
  switch (value) {
    case "Strict":
      return "strict";
    case "Lax":
      return "lax";
    case "None":
      return "none";
  }
}

function normalizeCookiePriority(value: AbpCdpCookie["priority"]): CookieRecord["priority"] {
  switch (value) {
    case "Low":
      return "low";
    case "Medium":
      return "medium";
    case "High":
      return "high";
  }
}

function normalizeResourceType(value: string | undefined): NetworkResourceType {
  switch ((value ?? "").toLowerCase()) {
    case "document":
      return "document";
    case "stylesheet":
      return "stylesheet";
    case "image":
      return "image";
    case "media":
      return "media";
    case "font":
      return "font";
    case "script":
      return "script";
    case "fetch":
      return "fetch";
    case "xhr":
      return "xhr";
    case "websocket":
      return "websocket";
    case "manifest":
      return "manifest";
    case "texttrack":
      return "texttrack";
    case "beacon":
      return "beacon";
    case "ping":
      return "ping";
    case "preflight":
      return "preflight";
    case "eventsource":
      return "event-stream";
    default:
      return "other";
  }
}

function parseHeaderJson(
  value: string | undefined,
): readonly { readonly name: string; readonly value: string }[] {
  if (value === undefined || value.length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.entries(parsed).flatMap(([name, headerValue]) =>
      typeof headerValue === "string" ? [createHeaderEntry(name, headerValue)] : [],
    );
  } catch {
    return [];
  }
}

function parseFrameDescriptor(value: unknown): FrameDescriptor | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.url !== "string") {
    return undefined;
  }

  return {
    id: candidate.id,
    ...(typeof candidate.parentId === "string" ? { parentId: candidate.parentId } : {}),
    ...(typeof candidate.name === "string" && candidate.name.length > 0
      ? { name: candidate.name }
      : {}),
    url: candidate.url,
    ...(typeof candidate.urlFragment === "string" ? { urlFragment: candidate.urlFragment } : {}),
  };
}

function parseOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

async function waitForProcessExit(process: ChildProcess | undefined): Promise<void> {
  if (!process || process.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const onExit = () => resolve();
    process.once("exit", onExit);
    const timer = setTimeout(() => {
      process.off("exit", onExit);
      try {
        process.kill("SIGKILL");
      } catch {}
      resolve();
    }, 5_000);
    process.once("exit", () => clearTimeout(timer));
  });
}

export class AbpBrowserCoreEngine implements BrowserCoreEngine {
  readonly capabilities = ABP_BROWSER_CORE_CAPABILITIES;

  private readonly launchOptions: AbpLaunchOptions | undefined;
  private readonly adoptedBrowser: AdoptedAbpBrowser | undefined;
  private readonly extraHTTPHeaders: readonly { readonly name: string; readonly value: string }[];
  private readonly sessions = new Map<SessionRef, SessionState>();
  private readonly pages = new Map<PageRef, PageController>();
  private readonly frames = new Map<FrameRef, FrameState>();
  private readonly documents = new Map<DocumentRef, DocumentState>();
  private readonly retiredDocuments = new Set<DocumentRef>();
  private readonly downloadRefsByAbpId = new Map<string, ReturnType<typeof createDownloadRef>>();
  private readonly actionSettler = createAbpActionSettler({
    syncExecutionPaused: (controller) => this.syncControllerExecutionPaused(controller),
    setExecutionPaused: (controller, paused) => this.setControllerExecutionPaused(controller, paused),
    flushDomUpdateTask: (controller) => this.flushDomUpdateTask(controller),
    throwBackgroundError: (controller) => this.throwBackgroundError(controller),
    isPageClosedError: isAbpPageClosedError,
  });
  private pageCounter = 0;
  private frameCounter = 0;
  private documentCounter = 0;
  private nodeCounter = 0;
  private requestCounter = 0;
  private sessionCounter = 0;
  private computerUseBridge: ComputerUseBridge | undefined;
  private domActionBridge: DomActionBridge | undefined;
  private eventCounter = 0;
  private stepCounter = 0;
  private dialogCounter = 0;
  private chooserCounter = 0;
  private downloadCounter = 0;
  private disposed = false;

  private constructor(options: {
    readonly launchOptions?: AbpLaunchOptions;
    readonly adoptedBrowser?: AdoptedAbpBrowser;
    readonly extraHTTPHeaders: readonly { readonly name: string; readonly value: string }[];
  }) {
    this.launchOptions = options.launchOptions;
    this.adoptedBrowser = options.adoptedBrowser;
    this.extraHTTPHeaders = options.extraHTTPHeaders;
  }

  static async create(options: AbpBrowserCoreEngineOptions = {}): Promise<AbpBrowserCoreEngine> {
    if (options.browser && options.launch) {
      throw createBrowserCoreError(
        "invalid-argument",
        "provide either launch or browser options, not both",
      );
    }
    if (options.launch?.abpExecutablePath && options.launch.browserExecutablePath) {
      throw createBrowserCoreError(
        "invalid-argument",
        "provide either an ABP wrapper executable path or a browser executable path, not both",
      );
    }

    const adoptedBrowser = options.browser
      ? {
          baseUrl: normalizeAbpBaseUrl(options.browser.baseUrl),
          remoteDebuggingUrl: normalizeRemoteDebuggingUrl(options.browser.remoteDebuggingUrl),
        }
      : undefined;

    if (adoptedBrowser) {
      await fetchBrowserWebSocketUrl(adoptedBrowser.remoteDebuggingUrl);
    }

    return new AbpBrowserCoreEngine({
      ...(options.browser ? {} : { launchOptions: options.launch }),
      ...(adoptedBrowser === undefined ? {} : { adoptedBrowser }),
      extraHTTPHeaders: options.extraHTTPHeaders ?? [],
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    for (const sessionRef of Array.from(this.sessions.keys())) {
      await this.closeSession({ sessionRef });
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  [OPENSTEER_COMPUTER_USE_BRIDGE_SYMBOL](): ComputerUseBridge {
    this.computerUseBridge ??= createAbpComputerUseBridge({
      resolveController: (pageRef) => this.requirePage(pageRef),
      resolveSession: (sessionRef) => this.requireSession(sessionRef),
      normalizeActionEvents: (controller, response) =>
        this.normalizeActionEvents(controller, response),
      detectNewTabs: (session, openerController) => this.detectNewTabs(session, openerController),
      executeInputAction: (session, controller, execute) =>
        this.executeInputAction(session, controller, execute),
      flushDomUpdateTask: (controller) => this.flushDomUpdateTask(controller),
      settleActionBoundary: (controller, options) =>
        this.actionSettler.settle({ controller, ...options }),
      requireMainFrame: (controller) => this.requireMainFrame(controller),
      drainQueuedEvents: (pageRef) => this.drainQueuedEvents(pageRef),
    });
    return this.computerUseBridge;
  }

  [OPENSTEER_DOM_ACTION_BRIDGE_SYMBOL](): DomActionBridge {
    this.domActionBridge ??= createAbpDomActionBridge({
      resolveController: (pageRef: PageRef) => this.requirePage(pageRef),
      resolveSession: (sessionRef: SessionRef) => this.requireSession(sessionRef),
      flushDomUpdateTask: (controller) => this.flushDomUpdateTask(controller),
      settleActionBoundary: (controller, options) =>
        this.actionSettler.settle({ controller, ...options }),
      syncExecutionPaused: (controller) => this.syncControllerExecutionPaused(controller),
      setExecutionPaused: (controller, paused) =>
        this.setControllerExecutionPaused(controller, paused),
      isPageClosedError: isAbpPageClosedError,
      requireLiveNode: (locator) => this.requireLiveNode(locator),
      getDomSnapshot: (documentRef: DocumentRef) => this.getDomSnapshot({ documentRef }),
      getViewportMetrics: (pageRef: PageRef) => this.getViewportMetrics({ pageRef }),
    });
    return this.domActionBridge;
  }

  async createSession(): Promise<SessionRef> {
    this.assertNotDisposed();

    if (this.adoptedBrowser) {
      if (this.sessions.size > 0) {
        throw createBrowserCoreError(
          "operation-failed",
          "adopted ABP engines expose exactly one session",
        );
      }
      return this.createAdoptedSession();
    }

    return this.createLaunchSession();
  }

  async closeSession(input: { readonly sessionRef: SessionRef }): Promise<void> {
    const session = this.requireSession(input.sessionRef);
    session.closed = true;

    for (const controller of session.controllersByPageRef.values()) {
      controller.explicitCloseInFlight = true;
    }

    for (const controller of Array.from(session.controllersByPageRef.values())) {
      await controller.cdp.close().catch(() => undefined);
      this.cleanupPageController(controller);
    }

    await session.browserCdp.close().catch(() => undefined);

    if (session.closeBrowserOnDispose) {
      await session.rest.shutdownBrowser().catch(() => undefined);
      await waitForProcessExit(session.process);
    }

    this.sessions.delete(session.sessionRef);

    if (session.ownedUserDataDir && session.userDataDir) {
      await rm(session.userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
    if (session.ownedSessionDir && session.sessionDir) {
      await rm(session.sessionDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async createPage(input: {
    readonly sessionRef: SessionRef;
    readonly openerPageRef?: PageRef;
    readonly url?: string;
  }): Promise<StepResult<PageInfo>> {
    const session = this.requireSession(input.sessionRef);
    const startedAt = Date.now();

    let tabId: string;
    if (shouldClaimBootstrapTab(session.bootstrapTabId, input.openerPageRef)) {
      tabId = session.bootstrapTabId;
      session.bootstrapTabId = undefined;
    } else {
      const created = await session.rest.createTab();
      tabId = created.id;
    }

    const controller = await this.initializePageController(session, tabId, {
      ...(input.openerPageRef === undefined ? {} : { openerPageRef: input.openerPageRef }),
    });
    session.activePageRef = controller.pageRef;

    const directEvents: StepEvent[] = [
      this.createEvent({
        kind: "page-created",
        sessionRef: session.sessionRef,
        pageRef: controller.pageRef,
      }),
    ];

    if (input.openerPageRef !== undefined) {
      directEvents.push(
        this.createEvent({
          kind: "popup-opened",
          sessionRef: session.sessionRef,
          pageRef: controller.pageRef,
          openerPageRef: input.openerPageRef,
        }),
      );
    }

    if (input.url) {
      const before = await this.captureMainFrameSnapshot(controller);
      let response: AbpActionResponse;
      try {
        response = await session.rest.navigateTab(controller.tabId, {
          url: input.url,
          ...buildImmediateActionRequest(),
        });
      } catch (error) {
        throw normalizeAbpError(error, controller.pageRef);
      }
      await this.waitForNavigationObservation(controller, before, {
        timeoutMs: 30_000,
        requireDocumentChange: false,
        observeTitle: false,
      });
      await this.actionSettler.settle({
        controller,
        timeoutMs: DEFAULT_ABP_ACTION_SETTLE_TIMEOUT_MS,
      });
      const normalizedEvents = await this.normalizeActionEvents(controller, response);
      const mainFrame = this.requireMainFrame(controller);
      return this.createStepResult(session.sessionRef, controller.pageRef, startedAt, {
        frameRef: mainFrame.frameRef,
        documentRef: mainFrame.currentDocument.documentRef,
        documentEpoch: mainFrame.currentDocument.documentEpoch,
        events: [...directEvents, ...normalizedEvents],
        data: await this.buildPageInfo(controller),
      });
    }

    await this.waitForMainFrame(controller, 10_000);
    await this.flushDomUpdateTask(controller);
    const mainFrame = this.requireMainFrame(controller);
    return this.createStepResult(session.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: directEvents,
      data: await this.buildPageInfo(controller),
    });
  }

  async closePage(input: { readonly pageRef: PageRef }): Promise<StepResult<void>> {
    const controller = this.requirePage(input.pageRef);
    const session = this.requireSession(controller.sessionRef);
    const startedAt = Date.now();
    const mainFrame = this.requireMainFrame(controller);

    controller.explicitCloseInFlight = true;

    const remainingLogicalPages = session.pageRefs.size - 1;
    if (
      shouldParkPageAsBootstrap({
        launchOwned: session.closeBrowserOnDispose,
        remainingLogicalPages,
      })
    ) {
      try {
        await session.rest.navigateTab(controller.tabId, {
          url: "chrome://newtab/",
          ...buildImmediateActionRequest({
            captureNetwork: false,
          }),
        });
      } catch (error) {
        throw normalizeAbpError(error, controller.pageRef);
      }
      session.bootstrapTabId = controller.tabId;
    } else {
      try {
        await session.rest.closeTab(controller.tabId);
      } catch (error) {
        throw normalizeAbpError(error, controller.pageRef);
      }
    }

    await controller.cdp.close().catch(() => undefined);
    this.cleanupPageController(controller);
    session.activePageRef = chooseNextActivePageRef(Array.from(session.pageRefs));

    return this.createStepResult(session.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: [
        this.createEvent({
          kind: "page-closed",
          sessionRef: session.sessionRef,
          pageRef: controller.pageRef,
          frameRef: mainFrame.frameRef,
          documentRef: mainFrame.currentDocument.documentRef,
          documentEpoch: mainFrame.currentDocument.documentEpoch,
        }),
      ],
      data: undefined,
    });
  }

  async activatePage(input: { readonly pageRef: PageRef }): Promise<StepResult<PageInfo>> {
    const controller = this.requirePage(input.pageRef);
    const session = this.requireSession(controller.sessionRef);
    const startedAt = Date.now();

    try {
      await session.rest.activateTab(controller.tabId);
    } catch (error) {
      throw normalizeAbpError(error, controller.pageRef);
    }
    session.activePageRef = controller.pageRef;
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
    const session = this.requireSession(controller.sessionRef);
    const startedAt = Date.now();
    const before = await this.captureMainFrameSnapshot(controller);

    let response: AbpActionResponse;
    try {
      response = await session.rest.navigateTab(controller.tabId, {
        url: input.url,
        ...(input.referrer === undefined ? {} : { referrer: input.referrer }),
        ...buildImmediateActionRequest(),
      });
    } catch (error) {
      throw normalizeAbpError(error, controller.pageRef);
    }

    await this.waitForNavigationObservation(controller, before, {
      timeoutMs: input.timeoutMs ?? 30_000,
      requireDocumentChange: false,
      observeTitle: false,
    });
    await this.actionSettler.settle({
      controller,
      timeoutMs: clampAbpActionSettleTimeout(input.timeoutMs),
    });

    const directEvents = await this.normalizeActionEvents(controller, response);
    const mainFrame = this.requireMainFrame(controller);
    return this.createStepResult(session.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: [...this.drainQueuedEvents(controller.pageRef), ...directEvents],
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
    const session = this.requireSession(controller.sessionRef);
    const startedAt = Date.now();
    const before = await this.captureMainFrameSnapshot(controller);

    let response: AbpActionResponse;
    try {
      response = await session.rest.reloadTab(controller.tabId, buildImmediateActionRequest());
    } catch (error) {
      throw normalizeAbpError(error, controller.pageRef);
    }

    await this.waitForNavigationObservation(controller, before, {
      timeoutMs: input.timeoutMs ?? 30_000,
      requireDocumentChange: true,
      observeTitle: false,
    });
    await this.actionSettler.settle({
      controller,
      timeoutMs: clampAbpActionSettleTimeout(input.timeoutMs),
    });

    const directEvents = await this.normalizeActionEvents(controller, response);
    const mainFrame = this.requireMainFrame(controller);
    return this.createStepResult(session.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: [...this.drainQueuedEvents(controller.pageRef), ...directEvents],
      data: {
        pageInfo: await this.buildPageInfo(controller),
        mainFrame: this.buildFrameInfo(mainFrame),
      },
    });
  }

  async goBack(input: { readonly pageRef: PageRef }): Promise<StepResult<boolean>> {
    const controller = this.requirePage(input.pageRef);
    const session = this.requireSession(controller.sessionRef);
    const startedAt = Date.now();
    const before = await this.captureMainFrameSnapshot(controller);

    let response: AbpActionResponse;
    try {
      response = await session.rest.goBack(controller.tabId, buildImmediateActionRequest());
    } catch (error) {
      if (this.isHistoryBoundaryError(error, "back")) {
        const mainFrame = this.requireMainFrame(controller);
        return this.createStepResult(session.sessionRef, controller.pageRef, startedAt, {
          frameRef: mainFrame.frameRef,
          documentRef: mainFrame.currentDocument.documentRef,
          documentEpoch: mainFrame.currentDocument.documentEpoch,
          events: this.drainQueuedEvents(controller.pageRef),
          data: false,
        });
      }
      throw normalizeAbpError(error, controller.pageRef);
    }

    await this.waitForNavigationObservation(controller, before, {
      timeoutMs: 5_000,
      requireDocumentChange: false,
      observeTitle: true,
      allowFallback: true,
    });
    await this.actionSettler.settle({
      controller,
      timeoutMs: DEFAULT_ABP_ACTION_SETTLE_TIMEOUT_MS,
    });

    const directEvents = await this.normalizeActionEvents(controller, response);
    const mainFrame = this.requireMainFrame(controller);
    return this.createStepResult(session.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: [...this.drainQueuedEvents(controller.pageRef), ...directEvents],
      data: true,
    });
  }

  async goForward(input: { readonly pageRef: PageRef }): Promise<StepResult<boolean>> {
    const controller = this.requirePage(input.pageRef);
    const session = this.requireSession(controller.sessionRef);
    const startedAt = Date.now();
    const before = await this.captureMainFrameSnapshot(controller);

    let response: AbpActionResponse;
    try {
      response = await session.rest.goForward(controller.tabId, buildImmediateActionRequest());
    } catch (error) {
      if (this.isHistoryBoundaryError(error, "forward")) {
        const mainFrame = this.requireMainFrame(controller);
        return this.createStepResult(session.sessionRef, controller.pageRef, startedAt, {
          frameRef: mainFrame.frameRef,
          documentRef: mainFrame.currentDocument.documentRef,
          documentEpoch: mainFrame.currentDocument.documentEpoch,
          events: this.drainQueuedEvents(controller.pageRef),
          data: false,
        });
      }
      throw normalizeAbpError(error, controller.pageRef);
    }

    await this.waitForNavigationObservation(controller, before, {
      timeoutMs: 5_000,
      requireDocumentChange: false,
      observeTitle: true,
      allowFallback: true,
    });
    await this.actionSettler.settle({
      controller,
      timeoutMs: DEFAULT_ABP_ACTION_SETTLE_TIMEOUT_MS,
    });

    const directEvents = await this.normalizeActionEvents(controller, response);
    const mainFrame = this.requireMainFrame(controller);
    return this.createStepResult(session.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: [...this.drainQueuedEvents(controller.pageRef), ...directEvents],
      data: true,
    });
  }

  async stopLoading(input: { readonly pageRef: PageRef }): Promise<StepResult<void>> {
    const controller = this.requirePage(input.pageRef);
    const session = this.requireSession(controller.sessionRef);
    const startedAt = Date.now();

    try {
      await session.rest.stopTab(controller.tabId);
    } catch (error) {
      throw normalizeAbpError(error, controller.pageRef);
    }

    await this.flushDomUpdateTask(controller);
    const mainFrame = this.requireMainFrame(controller);
    return this.createStepResult(session.sessionRef, controller.pageRef, startedAt, {
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
    const session = this.requireSession(controller.sessionRef);
    const startedAt = Date.now();
    const metrics = await this.getViewportMetrics({ pageRef: input.pageRef });
    const point = toViewportPoint(metrics, input.point, input.coordinateSpace);

    let response: AbpActionResponse;
    try {
      response = await session.rest.moveTab(controller.tabId, {
        x: point.x,
        y: point.y,
        ...buildImmediateActionRequest(),
      });
    } catch (error) {
      throw normalizeAbpError(error, controller.pageRef);
    }

    await this.flushDomUpdateTask(controller);
    const mainFrame = this.requireMainFrame(controller);
    return this.createStepResult(session.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: [
        ...this.drainQueuedEvents(controller.pageRef),
        ...(await this.normalizeActionEvents(controller, response)),
      ],
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
    const session = this.requireSession(controller.sessionRef);
    const startedAt = Date.now();
    const hit = await this.hitTest({
      pageRef: input.pageRef,
      point: input.point,
      coordinateSpace: input.coordinateSpace,
    }).catch(() => undefined);
    const metrics = await this.getViewportMetrics({ pageRef: input.pageRef });
    const point = toViewportPoint(metrics, input.point, input.coordinateSpace);

    const { response, dialogEvents } = await this.executeInputAction(session, controller, () =>
      session.rest.clickTab(controller.tabId, {
        x: point.x,
        y: point.y,
        ...(input.button === undefined ? {} : { button: input.button }),
        ...(input.clickCount === undefined ? {} : { click_count: input.clickCount }),
        ...(input.modifiers === undefined ? {} : { modifiers: [...input.modifiers] }),
        ...buildInputActionRequest(),
      }),
    );

    const actionEvents = await this.normalizeActionEvents(controller, response);
    const discoveredTabs = await this.detectNewTabs(session, controller);
    this.applyActionTabChange(session, controller.pageRef, response, actionEvents, discoveredTabs);
    const resultController = this.requirePage(session.activePageRef ?? controller.pageRef);
    await this.actionSettler.settle({
      controller: resultController,
      timeoutMs: DEFAULT_ABP_ACTION_SETTLE_TIMEOUT_MS,
    });
    const mainFrame = this.requireMainFrame(resultController);
    return this.createStepResult(session.sessionRef, resultController.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: [
        ...this.drainQueuedEvents(controller.pageRef),
        ...(resultController.pageRef === controller.pageRef
          ? []
          : this.drainQueuedEvents(resultController.pageRef)),
        ...actionEvents,
        ...discoveredTabs.events,
        ...dialogEvents,
      ],
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
    const session = this.requireSession(controller.sessionRef);
    const startedAt = Date.now();
    const metrics = await this.getViewportMetrics({ pageRef: input.pageRef });
    const point = toViewportPoint(metrics, input.point, input.coordinateSpace);

    const { response, dialogEvents } = await this.executeInputAction(session, controller, () =>
      session.rest.scrollTab(controller.tabId, {
        x: point.x,
        y: point.y,
        scrolls: buildAbpScrollSegments(input.delta),
        ...buildInputActionRequest(),
      }),
    );

    const actionEvents = await this.normalizeActionEvents(controller, response);
    const discoveredTabs = await this.detectNewTabs(session, controller);
    this.applyActionTabChange(session, controller.pageRef, response, actionEvents, discoveredTabs);
    const resultController = this.requirePage(session.activePageRef ?? controller.pageRef);
    await this.actionSettler.settle({
      controller: resultController,
      timeoutMs: DEFAULT_ABP_ACTION_SETTLE_TIMEOUT_MS,
    });
    const mainFrame = this.requireMainFrame(resultController);
    return this.createStepResult(session.sessionRef, resultController.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: [
        ...this.drainQueuedEvents(controller.pageRef),
        ...(resultController.pageRef === controller.pageRef
          ? []
          : this.drainQueuedEvents(resultController.pageRef)),
        ...actionEvents,
        ...discoveredTabs.events,
        ...dialogEvents,
      ],
      data: undefined,
    });
  }

  async keyPress(input: {
    readonly pageRef: PageRef;
    readonly key: string;
    readonly modifiers?: readonly KeyModifier[];
  }): Promise<StepResult<void>> {
    const controller = this.requirePage(input.pageRef);
    const session = this.requireSession(controller.sessionRef);
    const startedAt = Date.now();

    const { response, dialogEvents } = await this.executeInputAction(session, controller, () =>
      session.rest.keyPressTab(controller.tabId, {
        key: input.key,
        ...(input.modifiers === undefined ? {} : { modifiers: [...input.modifiers] }),
        ...buildInputActionRequest(),
      }),
    );

    const actionEvents = await this.normalizeActionEvents(controller, response);
    const discoveredTabs = await this.detectNewTabs(session, controller);
    this.applyActionTabChange(session, controller.pageRef, response, actionEvents, discoveredTabs);
    const resultController = this.requirePage(session.activePageRef ?? controller.pageRef);
    await this.actionSettler.settle({
      controller: resultController,
      timeoutMs: DEFAULT_ABP_ACTION_SETTLE_TIMEOUT_MS,
    });
    const mainFrame = this.requireMainFrame(resultController);
    return this.createStepResult(session.sessionRef, resultController.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: [
        ...this.drainQueuedEvents(controller.pageRef),
        ...(resultController.pageRef === controller.pageRef
          ? []
          : this.drainQueuedEvents(resultController.pageRef)),
        ...actionEvents,
        ...discoveredTabs.events,
        ...dialogEvents,
      ],
      data: undefined,
    });
  }

  async textInput(input: {
    readonly pageRef: PageRef;
    readonly text: string;
  }): Promise<StepResult<void>> {
    const controller = this.requirePage(input.pageRef);
    const session = this.requireSession(controller.sessionRef);
    const startedAt = Date.now();

    const { response, dialogEvents } = await this.executeInputAction(session, controller, () =>
      session.rest.typeTab(controller.tabId, {
        text: input.text,
        ...buildInputActionRequest(),
      }),
    );

    const actionEvents = await this.normalizeActionEvents(controller, response);
    const discoveredTabs = await this.detectNewTabs(session, controller);
    this.applyActionTabChange(session, controller.pageRef, response, actionEvents, discoveredTabs);
    const resultController = this.requirePage(session.activePageRef ?? controller.pageRef);
    await this.actionSettler.settle({
      controller: resultController,
      timeoutMs: DEFAULT_ABP_ACTION_SETTLE_TIMEOUT_MS,
    });
    const mainFrame = this.requireMainFrame(resultController);
    return this.createStepResult(session.sessionRef, resultController.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: [
        ...this.drainQueuedEvents(controller.pageRef),
        ...(resultController.pageRef === controller.pageRef
          ? []
          : this.drainQueuedEvents(resultController.pageRef)),
        ...actionEvents,
        ...discoveredTabs.events,
        ...dialogEvents,
      ],
      data: undefined,
    });
  }

  async captureScreenshot(input: {
    readonly pageRef: PageRef;
    readonly format?: ScreenshotFormat;
    readonly clip?: import("@opensteer/browser-core").Rect;
    readonly clipSpace?: CoordinateSpace;
    readonly fullPage?: boolean;
    readonly includeCursor?: boolean;
  }): Promise<StepResult<ScreenshotArtifact>> {
    const controller = this.requirePage(input.pageRef);
    const session = this.requireSession(controller.sessionRef);
    const startedAt = Date.now();

    if (input.clip) {
      throw unsupportedCapabilityError("executor.screenshots");
    }
    if (input.fullPage) {
      throw unsupportedCapabilityError("executor.screenshots");
    }

    let response: AbpActionResponse;
    try {
      response = await session.rest.screenshotTab(
        controller.tabId,
        buildImmediateScreenshotRequest({
          ...(input.includeCursor === undefined ? {} : { cursor: input.includeCursor }),
          ...(input.format === undefined ? {} : { format: input.format }),
        }),
      );
    } catch (error) {
      throw normalizeAbpError(error, controller.pageRef);
    }

    const screenshot = response.screenshot_after;
    if (!screenshot) {
      throw createBrowserCoreError(
        "operation-failed",
        `ABP screenshot response for ${controller.pageRef} did not include image data`,
      );
    }

    const format = (screenshot.format as ScreenshotFormat | undefined) ?? input.format ?? "png";
    const payload = createBodyPayload(new Uint8Array(Buffer.from(screenshot.data, "base64")), {
      mimeType: `image/${format}`,
    });

    await this.flushDomUpdateTask(controller);
    const mainFrame = this.requireMainFrame(controller);
    return this.createStepResult(session.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: [
        ...this.drainQueuedEvents(controller.pageRef),
        ...(await this.normalizeActionEvents(controller, response)),
      ],
      data: {
        pageRef: controller.pageRef,
        frameRef: mainFrame.frameRef,
        documentRef: mainFrame.currentDocument.documentRef,
        documentEpoch: mainFrame.currentDocument.documentEpoch,
        payload,
        format,
        size: createSize(screenshot.width, screenshot.height),
        coordinateSpace: "layout-viewport-css",
      },
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
    const session = this.requireSession(controller.sessionRef);
    const startedAt = Date.now();

    if (input.paused !== undefined && input.frozen !== undefined && input.paused !== input.frozen) {
      throw createBrowserCoreError(
        "invalid-argument",
        "ABP pause and freeze controls are the same underlying state",
      );
    }

    const beforePaused = controller.executionPaused;
    const requestedPaused = input.paused ?? input.frozen;
    const state =
      requestedPaused === undefined
        ? await session.rest.getExecutionState(controller.tabId)
        : await session.rest
            .setExecutionState(controller.tabId, { paused: requestedPaused })
            .catch((error) => {
              throw normalizeAbpError(error, controller.pageRef);
            });

    const afterPaused = state.paused;
    controller.executionPaused = afterPaused;
    const mainFrame = this.requireMainFrame(controller);
    const events: StepEvent[] = [];

    if (!beforePaused && afterPaused) {
      events.push(
        this.createEvent({
          kind: "paused",
          sessionRef: session.sessionRef,
          pageRef: controller.pageRef,
          frameRef: mainFrame.frameRef,
          documentRef: mainFrame.currentDocument.documentRef,
          documentEpoch: mainFrame.currentDocument.documentEpoch,
        }),
      );
      events.push(
        this.createEvent({
          kind: "frozen",
          sessionRef: session.sessionRef,
          pageRef: controller.pageRef,
          frameRef: mainFrame.frameRef,
          documentRef: mainFrame.currentDocument.documentRef,
          documentEpoch: mainFrame.currentDocument.documentEpoch,
        }),
      );
    }

    if (beforePaused && !afterPaused) {
      events.push(
        this.createEvent({
          kind: "resumed",
          sessionRef: session.sessionRef,
          pageRef: controller.pageRef,
          frameRef: mainFrame.frameRef,
          documentRef: mainFrame.currentDocument.documentRef,
          documentEpoch: mainFrame.currentDocument.documentEpoch,
        }),
      );
    }

    return this.createStepResult(session.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events,
      data: {
        paused: afterPaused,
        frozen: afterPaused,
      },
    });
  }

  async listPages(input: { readonly sessionRef: SessionRef }): Promise<readonly PageInfo[]> {
    const session = this.requireSession(input.sessionRef);
    return Promise.all(
      Array.from(session.pageRefs, async (pageRef) =>
        this.buildPageInfo(this.requirePage(pageRef)),
      ),
    );
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
    const response = await controller.cdp.send<{ readonly outerHTML: string }>("DOM.getOuterHTML", {
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
      html: response.outerHTML,
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
      (liveDocument, backendNodeId) => this.nodeRefForBackendNode(liveDocument, backendNodeId),
      (contentDocumentIndex) =>
        resolveCapturedContentDocumentRef(controller.framesByCdpId, captured, contentDocumentIndex),
    );
  }

  async readText(input: NodeLocator): Promise<string | null> {
    const document = this.requireDocument(input.documentRef);
    const controller = this.requirePage(document.pageRef);
    await this.flushDomUpdateTask(controller);
    const { document: liveDocument, backendNodeId } = this.requireLiveNode(input);
    const captured = await this.captureDomSnapshot(controller, liveDocument);
    return readTextContent(captured, input, backendNodeId);
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
      const frontend = await controller.cdp.send<{ readonly nodeIds: readonly number[] }>(
        "DOM.pushNodesByBackendIdsToFrontend",
        {
          backendNodeIds: [backendNodeId],
        },
      );
      const nodeId = frontend.nodeIds[0];
      if (nodeId === undefined) {
        throw staleNodeRefError(input);
      }
      const attributesResult = await controller.cdp.send<{
        readonly attributes: readonly string[];
      }>("DOM.getAttributes", { nodeId });
      const attributes: { name: string; value: string }[] = [];
      for (let index = 0; index < attributesResult.attributes.length; index += 2) {
        const name = attributesResult.attributes[index];
        const value = attributesResult.attributes[index + 1];
        if (name !== undefined && value !== undefined) {
          attributes.push({ name, value });
        }
      }
      return attributes;
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
    const raw = await controller.cdp.send<{
      readonly backendNodeId: number;
      readonly frameId: string;
    }>("DOM.getNodeForLocation", {
      x: Math.round(viewportPoint.x),
      y: Math.round(viewportPoint.y),
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
        const frontend = await controller.cdp.send<{ readonly nodeIds: readonly number[] }>(
          "DOM.pushNodesByBackendIdsToFrontend",
          {
            backendNodeIds: [raw.backendNodeId],
          },
        );
        const nodeId = frontend.nodeIds[0];
        if (nodeId !== undefined) {
          const quads = await controller.cdp.send<{
            readonly quads: ReadonlyArray<readonly number[]>;
          }>("DOM.getContentQuads", { nodeId });
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
    const layout = await controller.cdp.send<{
      readonly cssLayoutViewport: {
        readonly pageX: number;
        readonly pageY: number;
        readonly clientWidth: number;
        readonly clientHeight: number;
      };
      readonly cssVisualViewport: {
        readonly pageX: number;
        readonly pageY: number;
        readonly offsetX: number;
        readonly offsetY: number;
        readonly clientWidth: number;
        readonly clientHeight: number;
        readonly scale: number;
        readonly zoom?: number;
      };
      readonly cssContentSize: {
        readonly width: number;
        readonly height: number;
      };
    }>("Page.getLayoutMetrics");

    let baseDevicePixelRatio = 1;
    try {
      const screens = await controller.cdp.send<{
        readonly screenInfos: ReadonlyArray<{
          readonly isPrimary?: boolean;
          readonly devicePixelRatio?: number;
        }>;
      }>("Emulation.getScreenInfos");
      const primary =
        screens.screenInfos.find((screen) => screen.isPrimary) ?? screens.screenInfos[0];
      baseDevicePixelRatio = primary?.devicePixelRatio ?? 1;
    } catch {
      baseDevicePixelRatio = 1;
    }

    const pageZoomFactor = layout.cssVisualViewport.zoom ?? 1;
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
      devicePixelRatio: createDevicePixelRatio(baseDevicePixelRatio * pageZoomFactor),
      pageScaleFactor: createPageScaleFactor(layout.cssVisualViewport.scale),
      pageZoomFactor: createPageZoomFactor(pageZoomFactor),
    };
  }

  async getNetworkRecords(input: GetNetworkRecordsInput): Promise<readonly NetworkRecord[]> {
    const session = this.requireSession(input.sessionRef);
    const includeBodies = input.includeBodies ?? false;
    const requestIds = input.requestIds === undefined ? undefined : new Set(input.requestIds);
    input.signal?.throwIfAborted?.();

    if (input.pageRef) {
      const controller = this.requirePage(input.pageRef);
      if (controller.sessionRef !== session.sessionRef) {
        throw createBrowserCoreError(
          "invalid-argument",
          `page ${input.pageRef} does not belong to session ${input.sessionRef}`,
        );
      }
      const calls = await raceWithAbort(
        session.rest.queryNetwork({
          tabId: controller.tabId,
          includeBodies,
          ...(input.url === undefined ? {} : { url: input.url }),
          ...(input.hostname === undefined ? {} : { hostname: input.hostname }),
          ...(input.path === undefined ? {} : { path: input.path }),
          ...(input.method === undefined ? {} : { method: input.method }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.resourceType === undefined ? {} : { resourceType: input.resourceType }),
        }),
        input.signal,
      );
      return calls
        .map((call) => this.normalizeNetworkRecord(session, controller.pageRef, call))
        .filter((record) => requestIds === undefined || requestIds.has(record.requestId));
    }

    const records = await Promise.all(
      Array.from(session.pageRefs, async (pageRef) => {
        const controller = this.requirePage(pageRef);
        const calls = await raceWithAbort(
          session.rest.queryNetwork({
            tabId: controller.tabId,
            includeBodies,
            ...(input.url === undefined ? {} : { url: input.url }),
            ...(input.hostname === undefined ? {} : { hostname: input.hostname }),
            ...(input.path === undefined ? {} : { path: input.path }),
            ...(input.method === undefined ? {} : { method: input.method }),
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(input.resourceType === undefined ? {} : { resourceType: input.resourceType }),
          }),
          input.signal,
        );
        return calls
          .map((call) => this.normalizeNetworkRecord(session, pageRef, call))
          .filter((record) => requestIds === undefined || requestIds.has(record.requestId));
      }),
    );
    return records.flat();
  }

  async getCookies(input: {
    readonly sessionRef: SessionRef;
    readonly urls?: readonly string[];
  }): Promise<readonly CookieRecord[]> {
    const session = this.requireSession(input.sessionRef);
    const result = await session.browserCdp.send<{ readonly cookies: readonly AbpCdpCookie[] }>(
      "Storage.getCookies",
    );
    const cookies = result.cookies.map((cookie) => {
      const sameSite = normalizeCookieSameSite(cookie.sameSite);
      const priority = normalizeCookiePriority(cookie.priority);
      return {
        sessionRef: session.sessionRef,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        ...(sameSite === undefined ? {} : { sameSite }),
        ...(priority === undefined ? {} : { priority }),
        ...(cookie.partitionKey === undefined ? {} : { partitionKey: cookie.partitionKey }),
        session: cookie.expires === undefined || cookie.expires < 0,
        ...(cookie.expires === undefined || cookie.expires < 0
          ? { expiresAt: null }
          : { expiresAt: cookie.expires * 1000 }),
      } satisfies CookieRecord;
    });

    return input.urls ? filterCookieRecords(cookies, [...input.urls]) : cookies;
  }

  async getStorageSnapshot(input: {
    readonly sessionRef: SessionRef;
    readonly includeSessionStorage?: boolean;
    readonly includeIndexedDb?: boolean;
  }): Promise<StorageSnapshot> {
    const session = this.requireSession(input.sessionRef);
    const includeSessionStorage = input.includeSessionStorage ?? true;
    const includeIndexedDb = input.includeIndexedDb ?? true;
    const origins = new Map<string, LocalStorageOriginState>();

    for (const pageRef of session.pageRefs) {
      const controller = this.requirePage(pageRef);
      await this.flushDomUpdateTask(controller);
      for (const frame of controller.framesByCdpId.values()) {
        const origin = parseOrigin(frame.currentDocument.url);
        if (origin === undefined) {
          continue;
        }
        if (origin === "null" || origins.has(origin)) {
          continue;
        }
        try {
          const storageKey = await controller.cdp.send<AbpStorageKeyResult>(
            "Storage.getStorageKey",
            {
              frameId: frame.cdpFrameId,
            },
          );
          origins.set(origin, {
            origin,
            storageKey: storageKey.storageKey,
          });
        } catch {}
      }
    }

    const normalizedOrigins: StorageOriginSnapshot[] = [];
    for (const { origin, storageKey } of origins.values()) {
      const localStorage = await this.readStorageEntriesForOrigin(session, storageKey, true);
      const indexedDb = includeIndexedDb
        ? await this.readIndexedDbSnapshotForOrigin(session, origin, storageKey)
        : undefined;
      normalizedOrigins.push({
        origin,
        localStorage,
        ...(indexedDb === undefined ? {} : { indexedDb }),
      });
    }

    const sessionStorage = includeSessionStorage
      ? await this.collectSessionStorageSnapshots(session)
      : undefined;

    return {
      sessionRef: session.sessionRef,
      capturedAt: Date.now(),
      origins: normalizedOrigins,
      ...(sessionStorage === undefined ? {} : { sessionStorage }),
    };
  }

  async executeRequest(input: {
    readonly sessionRef: SessionRef;
    readonly request: SessionTransportRequest;
    readonly signal?: AbortSignal;
  }): Promise<StepResult<SessionTransportResponse>> {
    const session = this.requireSession(input.sessionRef);
    const activePageRef = session.activePageRef;
    if (!activePageRef) {
      throw createBrowserCoreError(
        "operation-failed",
        `session ${input.sessionRef} has no active page for session HTTP`,
      );
    }

    const controller = this.requirePage(activePageRef);
    const startedAt = Date.now();
    input.signal?.throwIfAborted?.();
    const requestId = await raceWithAbort(
      session.rest.executeScript<string>(controller.tabId, buildSessionHttpStartScript(input.request), {
        wait_until: {
          type: "immediate",
        },
        screenshot: {
          area: "none",
        },
      }),
      input.signal,
    );

    let response: SessionHttpScriptResponse;
    try {
      response = await raceWithAbort(
        this.awaitSessionHttpResponse(session, controller, requestId, input.request.timeoutMs),
        input.signal,
      );
    } catch (error) {
      throw normalizeAbpError(error, controller.pageRef);
    }

    const responseHeaders = response.headers.map(([name, value]) => createHeaderEntry(name, value));
    const contentType = headerValue(responseHeaders, "content-type");
    const payload =
      response.bodyBase64 === undefined
        ? undefined
        : createBodyPayload(new Uint8Array(Buffer.from(response.bodyBase64, "base64")), {
            encoding: "base64",
            ...parseMimeType(contentType),
          });

    const mainFrame = this.requireMainFrame(controller);
    return this.createStepResult(session.sessionRef, controller.pageRef, startedAt, {
      frameRef: mainFrame.frameRef,
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      events: this.drainQueuedEvents(controller.pageRef),
      data: {
        url: response.url,
        status: response.status,
        statusText: response.statusText || STATUS_CODES[response.status] || "",
        headers: responseHeaders,
        ...(payload === undefined ? {} : { body: payload }),
        redirected: response.redirected,
      },
    });
  }

  private async awaitSessionHttpResponse(
    session: SessionState,
    controller: PageController,
    requestId: string,
    timeoutMs: number | undefined,
  ): Promise<SessionHttpScriptResponse> {
    const startedAt = Date.now();
    const maxWaitMs =
      timeoutMs === undefined ? 30_000 : Math.max(Math.ceil(timeoutMs) + 1_000, 30_000);

    while (Date.now() - startedAt < maxWaitMs) {
      const result = normalizeSessionHttpScriptPollResult(
        await session.rest.executeScript<unknown>(
          controller.tabId,
          buildSessionHttpPollScript(requestId),
          {
            wait_until: {
              type: "immediate",
            },
            screenshot: {
              area: "none",
            },
          },
        ),
      );

      if (result.state === "pending") {
        await delay(25);
        continue;
      }

      if (result.state === "rejected") {
        throw createBrowserCoreError(
          result.error.name === "AbortError" ? "timeout" : "operation-failed",
          result.error.message,
        );
      }

      return result.response;
    }

    throw createBrowserCoreError(
      "timeout",
      `session ${session.sessionRef} did not finish a session HTTP request within ${String(maxWaitMs)}ms`,
    );
  }

  private async createLaunchSession(): Promise<SessionRef> {
    const sessionRef = createSessionRef(`abp-${++this.sessionCounter}`);
    const userDataDir =
      this.launchOptions?.userDataDir ??
      (await mkdtemp(join(tmpdir(), "opensteer-abp-user-data-")));
    const sessionDir =
      this.launchOptions?.sessionDir ?? (await mkdtemp(join(tmpdir(), "opensteer-abp-session-")));
    const restPort = await allocatePort();
    const launchArgs = [...(this.launchOptions?.args ?? [])];
    if (!launchArgs.some((arg) => arg.startsWith("--remote-debugging-port"))) {
      launchArgs.push("--remote-debugging-port=0");
    }

    const launched = await launchAbpProcess({
      port: restPort,
      userDataDir,
      sessionDir,
      ...(this.launchOptions?.abpExecutablePath === undefined
        ? {}
        : { abpExecutablePath: this.launchOptions.abpExecutablePath }),
      ...(this.launchOptions?.browserExecutablePath === undefined
        ? {}
        : { browserExecutablePath: this.launchOptions.browserExecutablePath }),
      headless: this.launchOptions?.headless ?? true,
      args: launchArgs,
      verbose: this.launchOptions?.verbose ?? false,
    });

    try {
      const browserWebSocketUrl = await fetchBrowserWebSocketUrl(launched.remoteDebuggingUrl);
      const browserCdp = await CdpClient.connect({
        url: browserWebSocketUrl,
        allowedMethods: BROWSER_CDP_METHOD_ALLOWLIST,
      });
      const session: SessionState = {
        sessionRef,
        mode: "launch",
        baseUrl: launched.baseUrl,
        remoteDebuggingUrl: launched.remoteDebuggingUrl,
        browserWebSocketUrl,
        closeBrowserOnDispose: true,
        rest: new AbpRestClient(launched.baseUrl, this.extraHTTPHeaders),
        browserCdp,
        pageRefs: new Set(),
        controllersByPageRef: new Map(),
        pageRefByTabId: new Map(),
        userDataDir,
        sessionDir,
        ownedUserDataDir: this.launchOptions?.userDataDir === undefined,
        ownedSessionDir: this.launchOptions?.sessionDir === undefined,
        process: launched.process,
        bootstrapTabId: undefined,
        activePageRef: undefined,
        closed: false,
      };
      this.sessions.set(sessionRef, session);

      const tabs = await session.rest.listTabs();
      if (tabs.length > 0) {
        session.bootstrapTabId = tabs[0]?.id;
      }
      return sessionRef;
    } catch (error) {
      launched.process.kill("SIGKILL");
      await waitForProcessExit(launched.process);
      if (this.launchOptions?.userDataDir === undefined) {
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (this.launchOptions?.sessionDir === undefined) {
        await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  private async createAdoptedSession(): Promise<SessionRef> {
    if (!this.adoptedBrowser) {
      throw createBrowserCoreError(
        "operation-failed",
        "adopted browser options are not configured",
      );
    }

    const sessionRef = createSessionRef(`abp-${++this.sessionCounter}`);
    const browserWebSocketUrl = await fetchBrowserWebSocketUrl(
      this.adoptedBrowser.remoteDebuggingUrl,
    );
    const browserCdp = await CdpClient.connect({
      url: browserWebSocketUrl,
      allowedMethods: BROWSER_CDP_METHOD_ALLOWLIST,
    });
    const session: SessionState = {
      sessionRef,
      mode: "browser",
      baseUrl: this.adoptedBrowser.baseUrl,
      remoteDebuggingUrl: this.adoptedBrowser.remoteDebuggingUrl,
      browserWebSocketUrl,
      closeBrowserOnDispose: false,
      rest: new AbpRestClient(this.adoptedBrowser.baseUrl, this.extraHTTPHeaders),
      browserCdp,
      pageRefs: new Set(),
      controllersByPageRef: new Map(),
      pageRefByTabId: new Map(),
      ownedUserDataDir: false,
      ownedSessionDir: false,
      process: undefined,
      bootstrapTabId: undefined,
      activePageRef: undefined,
      closed: false,
    };
    this.sessions.set(sessionRef, session);

    const [tabs, targets] = await Promise.all([
      session.rest.listTabs(),
      session.browserCdp.send<{ readonly targetInfos: readonly AbpCdpTargetInfo[] }>(
        "Target.getTargets",
      ),
    ]);

    for (const tab of tabs) {
      const controller = await this.initializePageController(session, tab.id, {
        metadata: {
          url: tab.url,
          title: tab.title,
        },
      });
      if (tab.active) {
        session.activePageRef = controller.pageRef;
      }
    }

    const openerByTabId = resolveTabOpeners(targets.targetInfos, session.pageRefByTabId);
    for (const [tabId, openerPageRef] of openerByTabId) {
      const pageRef = session.pageRefByTabId.get(tabId);
      if (pageRef === undefined) {
        continue;
      }
      this.requirePage(pageRef).openerPageRef = openerPageRef;
    }

    session.activePageRef ??= chooseNextActivePageRef(Array.from(session.pageRefs));
    return sessionRef;
  }

  private async initializePageController(
    session: SessionState,
    tabId: string,
    options: {
      readonly openerPageRef?: PageRef;
      readonly metadata?: {
        readonly url?: string;
        readonly title?: string;
      };
      readonly installSettleTracker?: boolean;
    } = {},
  ): Promise<PageController> {
    const existingPageRef = session.pageRefByTabId.get(tabId);
    if (existingPageRef) {
      const existing = this.requirePage(existingPageRef);
      if (options.openerPageRef !== undefined) {
        existing.openerPageRef = options.openerPageRef;
      }
      return existing;
    }

    const targetInfo = await this.waitForPageTargetInfo(session, tabId, options.metadata);
    const cdp = await CdpClient.connect({
      url: derivePageWebSocketUrl(session.browserWebSocketUrl, targetInfo.targetId),
      allowedMethods: PAGE_CDP_METHOD_ALLOWLIST,
    });
    const pageRef = createPageRef(`abp-${++this.pageCounter}`);
    const controller: PageController = {
      sessionRef: session.sessionRef,
      pageRef,
      tabId,
      cdp,
      queuedEvents: [],
      framesByCdpId: new Map(),
      documentsByRef: new Map(),
      lifecycleState: "open",
      openerPageRef: options.openerPageRef,
      mainFrameRef: undefined,
      lastKnownTitle: "",
      explicitCloseInFlight: false,
      domUpdateTask: undefined,
      backgroundError: undefined,
      executionPaused: false,
      settleTrackerRegistered: false,
    };

    this.pages.set(pageRef, controller);
    session.pageRefs.add(pageRef);
    session.controllersByPageRef.set(pageRef, controller);
    session.pageRefByTabId.set(tabId, pageRef);

    cdp.on("Page.frameAttached", (payload) => {
      const frameId = typeof payload.frameId === "string" ? payload.frameId : undefined;
      const parentFrameId =
        typeof payload.parentFrameId === "string" ? payload.parentFrameId : undefined;
      if (frameId && parentFrameId) {
        this.handleFrameAttached(controller, frameId, parentFrameId);
      }
    });
    cdp.on("Page.frameDetached", (payload) => {
      const frameId = typeof payload.frameId === "string" ? payload.frameId : undefined;
      if (frameId) {
        this.handleFrameDetached(controller, frameId);
      }
    });
    cdp.on("Page.frameNavigated", (payload) => {
      const frame = parseFrameDescriptor(payload.frame);
      if (frame) {
        this.handleFrameNavigated(controller, frame);
      }
    });
    cdp.on("Page.navigatedWithinDocument", (payload) => {
      const frameId = typeof payload.frameId === "string" ? payload.frameId : undefined;
      const url = typeof payload.url === "string" ? payload.url : undefined;
      if (frameId && url) {
        this.handleNavigatedWithinDocument(controller, frameId, url);
      }
    });
    cdp.on("DOM.documentUpdated", () => {
      this.handleDocumentUpdated(controller);
    });
    cdp.onClose((error) => {
      if (controller.explicitCloseInFlight) {
        return;
      }
      controller.backgroundError = error ?? closedPageError(controller.pageRef);
      this.cleanupPageController(controller);
      session.activePageRef = chooseNextActivePageRef(Array.from(session.pageRefs));
    });

    try {
      await cdp.send("Page.enable", {
        enableFileChooserOpenedEvent: true,
      });
      await cdp.send("DOM.enable", {
        includeWhitespace: "none",
      });
      await cdp.send("DOMStorage.enable");
      const executionState = await session.rest.getExecutionState(tabId).catch(() => undefined);
      const shouldRestorePaused = executionState?.paused ?? false;
      controller.executionPaused = shouldRestorePaused;
      if (shouldRestorePaused) {
        await this.setControllerExecutionPaused(controller, false);
      }
      if (options.installSettleTracker !== false) {
        await this.actionSettler.installTracker(controller);
      }
      const frameTree = await cdp.send<{ readonly frameTree: FrameTreeNode }>("Page.getFrameTree");
      this.syncFrameTree(controller, frameTree.frameTree);
      await this.reconcileDocumentEpochs(controller);
      controller.lastKnownTitle = await this.refreshTabTitle(controller);
      if (!shouldRestorePaused) {
        return controller;
      }
      try {
        await this.setControllerExecutionPaused(controller, true);
      } catch (error) {
        if (!isPageClosedApiError(error)) {
          throw error;
        }
      }
      return controller;
    } catch (error) {
      await cdp.close().catch(() => undefined);
      this.cleanupPageController(controller);
      throw normalizeAbpError(error, pageRef);
    }
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
    const frameRef = createFrameRef(`abp-${++this.frameCounter}`);
    const documentRef = createDocumentRef(`abp-${++this.documentCounter}`);
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
  }

  private handleFrameDetached(controller: PageController, frameId: string): void {
    const root = controller.framesByCdpId.get(frameId);
    if (!root) {
      return;
    }
    const descendants = Array.from(controller.framesByCdpId.values()).filter((frame) =>
      this.isDescendantFrame(frame, root.frameRef),
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
  }

  private handleFrameNavigated(controller: PageController, frame: FrameDescriptor): void {
    if (!controller.framesByCdpId.has(frame.id)) {
      this.handleFrameAttached(controller, frame.id, frame.parentId ?? "");
    }
    const frameState = controller.framesByCdpId.get(frame.id);
    if (!frameState) {
      return;
    }

    const nextDocumentRef = createDocumentRef(`abp-${++this.documentCounter}`);
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
        const frameRef = createFrameRef(`abp-${++this.frameCounter}`);
        const documentRef = createDocumentRef(`abp-${++this.documentCounter}`);
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

  private async waitForPageTargetInfo(
    session: SessionState,
    tabId: string,
    tabMetadata?: {
      readonly url?: string;
      readonly title?: string;
    },
  ): Promise<AbpCdpTargetInfo> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 30_000) {
      const targets = await session.browserCdp.send<{
        readonly targetInfos: readonly AbpCdpTargetInfo[];
      }>("Target.getTargets");
      const pageTargets = targets.targetInfos.filter((target) => target.type === "page");
      const exactMatch = pageTargets.find(
        (target) => target.type === "page" && target.targetId === tabId,
      );
      if (exactMatch) {
        return exactMatch;
      }

      const fallbackMatch = resolveFallbackPageTarget(pageTargets, tabMetadata);
      if (fallbackMatch) {
        return fallbackMatch;
      }
      await delay(100);
    }

    throw createBrowserCoreError(
      "timeout",
      `CDP target ${tabId} did not become reachable within 30000ms`,
    );
  }

  private async waitForMainFrame(
    controller: PageController,
    timeoutMs: number,
  ): Promise<FrameState> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (controller.mainFrameRef) {
        return this.requireFrame(controller.mainFrameRef);
      }
      await delay(25);
    }

    throw createBrowserCoreError(
      "timeout",
      `page ${controller.pageRef} did not expose a main frame within ${String(timeoutMs)}ms`,
    );
  }

  private async waitForNavigationObservation(
    controller: PageController,
    before: MainFrameSnapshot,
    options: {
      readonly timeoutMs: number;
      readonly requireDocumentChange: boolean;
      readonly observeTitle: boolean;
      readonly allowFallback?: boolean;
    },
  ): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < options.timeoutMs) {
      this.throwBackgroundError(controller);
      if (controller.lifecycleState === "closed") {
        throw closedPageError(controller.pageRef);
      }
      const frame = controller.mainFrameRef ? this.frames.get(controller.mainFrameRef) : undefined;
      if (frame) {
        if (frame.currentDocument.documentRef !== before.documentRef) {
          await this.flushDomUpdateTask(controller);
          return;
        }
        if (!options.requireDocumentChange && frame.currentDocument.url !== before.url) {
          await this.flushDomUpdateTask(controller);
          return;
        }
        if (options.observeTitle) {
          const title = await this.refreshTabTitle(controller);
          if (title !== before.title) {
            await this.flushDomUpdateTask(controller);
            return;
          }
        }
      }
      await delay(50);
    }

    if (options.allowFallback) {
      await delay(150);
      await this.flushDomUpdateTask(controller);
      return;
    }

    throw createBrowserCoreError(
      "timeout",
      `page ${controller.pageRef} did not observe navigation within ${String(options.timeoutMs)}ms`,
      {
        details: {
          pageRef: controller.pageRef,
        },
      },
    );
  }

  private async captureMainFrameSnapshot(controller: PageController): Promise<MainFrameSnapshot> {
    await this.flushDomUpdateTask(controller);
    const mainFrame = await this.waitForMainFrame(controller, 10_000);
    const title = await this.refreshTabTitle(controller);
    return {
      documentRef: mainFrame.currentDocument.documentRef,
      documentEpoch: mainFrame.currentDocument.documentEpoch,
      url: mainFrame.currentDocument.url,
      title,
    };
  }

  private async setControllerExecutionPaused(
    controller: PageController,
    paused: boolean,
  ): Promise<void> {
    const session = this.requireSession(controller.sessionRef);
    try {
      const state = await session.rest.setExecutionState(controller.tabId, {
        paused,
      });
      controller.executionPaused = state.paused;
    } catch (error) {
      throw normalizeAbpError(error, controller.pageRef);
    }
  }

  private async syncControllerExecutionPaused(controller: PageController): Promise<boolean> {
    const session = this.requireSession(controller.sessionRef);
    try {
      const state = await session.rest.getExecutionState(controller.tabId);
      controller.executionPaused = state.paused;
      return state.paused;
    } catch (error) {
      throw normalizeAbpError(error, controller.pageRef);
    }
  }

  private async normalizeActionEvents(
    controller: PageController,
    response: AbpActionResponse,
  ): Promise<readonly StepEvent[]> {
    const session = this.requireSession(controller.sessionRef);
    const mainFrame = controller.mainFrameRef
      ? this.frames.get(controller.mainFrameRef)
      : undefined;
    const document = mainFrame?.currentDocument;
    const events: StepEvent[] = [];

    for (const event of response.events ?? []) {
      switch (event.type) {
        case "popup": {
          const popupTabId =
            this.readString(event.data.targetId) ?? this.readString(event.data.new_tab_id);
          if (!popupTabId) {
            break;
          }
          const openerPageRef =
            (this.readString(event.data.openerId)
              ? session.pageRefByTabId.get(this.readString(event.data.openerId)!)
              : undefined) ?? controller.pageRef;
          const popupController = await this.initializePageController(session, popupTabId, {
            openerPageRef,
            installSettleTracker: false,
          });
          this.queueEvent(
            popupController.pageRef,
            this.createEvent({
              kind: "page-created",
              sessionRef: session.sessionRef,
              pageRef: popupController.pageRef,
            }),
          );
          events.push(
            this.createEvent({
              kind: "popup-opened",
              sessionRef: session.sessionRef,
              pageRef: popupController.pageRef,
              openerPageRef,
            }),
          );
          break;
        }
        case "dialog": {
          events.push(
            this.createEvent({
              kind: "dialog-opened",
              sessionRef: session.sessionRef,
              pageRef: controller.pageRef,
              ...(mainFrame === undefined ? {} : { frameRef: mainFrame.frameRef }),
              ...(document === undefined ? {} : { documentRef: document.documentRef }),
              ...(document === undefined ? {} : { documentEpoch: document.documentEpoch }),
              dialogRef: createDialogRef(`abp-${++this.dialogCounter}`),
              dialogType: normalizeDialogType(
                this.readString(event.data.dialogType) ?? this.readString(event.data.dialog_type),
              ),
              message: this.readString(event.data.message) ?? "",
              ...(this.readString(event.data.default_prompt) === undefined
                ? {}
                : { defaultValue: this.readString(event.data.default_prompt)! }),
            }),
          );
          break;
        }
        case "file_chooser": {
          const mode = this.readString(event.data.mode);
          events.push(
            this.createEvent({
              kind: "chooser-opened",
              sessionRef: session.sessionRef,
              pageRef: controller.pageRef,
              ...(mainFrame === undefined ? {} : { frameRef: mainFrame.frameRef }),
              ...(document === undefined ? {} : { documentRef: document.documentRef }),
              ...(document === undefined ? {} : { documentEpoch: document.documentEpoch }),
              chooserRef: createChooserRef(`abp-${++this.chooserCounter}`),
              chooserType: "file",
              multiple:
                this.readBoolean(event.data.multipleFilesAllowed) ??
                this.readBoolean(event.data.multiple) ??
                mode === "selectMultiple",
            }),
          );
          break;
        }
        case "select_open": {
          const chooser = normalizeSelectChooserEventData(event.data);
          if (chooser === undefined) {
            break;
          }
          events.push(
            this.createEvent({
              kind: "chooser-opened",
              sessionRef: session.sessionRef,
              pageRef: controller.pageRef,
              ...(mainFrame === undefined ? {} : { frameRef: mainFrame.frameRef }),
              ...(document === undefined ? {} : { documentRef: document.documentRef }),
              ...(document === undefined ? {} : { documentEpoch: document.documentEpoch }),
              chooserRef: createChooserRef(`abp-${++this.chooserCounter}`),
              chooserType: "select",
              multiple: chooser.multiple,
              ...(chooser.options === undefined ? {} : { options: chooser.options }),
            }),
          );
          break;
        }
        case "download_started": {
          const downloadId =
            this.readString(event.data.downloadId) ??
            this.readString(event.data.download_id) ??
            `abp-download-${++this.downloadCounter}`;
          let downloadRef = this.downloadRefsByAbpId.get(downloadId);
          if (!downloadRef) {
            downloadRef = createDownloadRef(`abp-${++this.downloadCounter}`);
            this.downloadRefsByAbpId.set(downloadId, downloadRef);
          }
          events.push(
            this.createEvent({
              kind: "download-started",
              sessionRef: session.sessionRef,
              pageRef: controller.pageRef,
              ...(mainFrame === undefined ? {} : { frameRef: mainFrame.frameRef }),
              ...(document === undefined ? {} : { documentRef: document.documentRef }),
              ...(document === undefined ? {} : { documentEpoch: document.documentEpoch }),
              downloadRef,
              url: this.readString(event.data.url) ?? "",
              ...(this.readString(event.data.suggestedFilename) === undefined
                ? {}
                : { suggestedFilename: this.readString(event.data.suggestedFilename)! }),
            }),
          );
          break;
        }
        case "download_completed":
        case "download_cancelled": {
          const downloadId =
            this.readString(event.data.downloadId) ??
            this.readString(event.data.download_id) ??
            `abp-download-${++this.downloadCounter}`;
          let downloadRef = this.downloadRefsByAbpId.get(downloadId);
          if (!downloadRef) {
            downloadRef = createDownloadRef(`abp-${++this.downloadCounter}`);
            this.downloadRefsByAbpId.set(downloadId, downloadRef);
          }
          events.push(
            this.createEvent({
              kind: "download-finished",
              sessionRef: session.sessionRef,
              pageRef: controller.pageRef,
              ...(mainFrame === undefined ? {} : { frameRef: mainFrame.frameRef }),
              ...(document === undefined ? {} : { documentRef: document.documentRef }),
              ...(document === undefined ? {} : { documentEpoch: document.documentEpoch }),
              downloadRef,
              state: event.type === "download_completed" ? "completed" : "canceled",
            }),
          );
          break;
        }
      }
    }

    return events;
  }

  private async executeInputAction(
    session: SessionState,
    controller: PageController,
    execute: () => Promise<AbpActionResponse>,
  ): Promise<{
    readonly response: AbpActionResponse;
    readonly dialogEvents: readonly StepEvent[];
  }> {
    try {
      const response = await execute();
      return { response, dialogEvents: [] };
    } catch (error) {
      if (!isActionTimeoutError(error)) {
        throw normalizeAbpError(error, controller.pageRef);
      }
      const dialogInfo = await session.rest.getDialog(controller.tabId).catch(() => undefined);
      if (!dialogInfo) {
        throw normalizeAbpError(error, controller.pageRef);
      }
      await session.rest.acceptDialog(controller.tabId).catch(() => undefined);
      const mainFrame = controller.mainFrameRef
        ? this.frames.get(controller.mainFrameRef)
        : undefined;
      const document = mainFrame?.currentDocument;
      const dialogEvents: StepEvent[] = [
        this.createEvent({
          kind: "dialog-opened",
          sessionRef: session.sessionRef,
          pageRef: controller.pageRef,
          ...(mainFrame === undefined ? {} : { frameRef: mainFrame.frameRef }),
          ...(document === undefined ? {} : { documentRef: document.documentRef }),
          ...(document === undefined ? {} : { documentEpoch: document.documentEpoch }),
          dialogRef: createDialogRef(`abp-${++this.dialogCounter}`),
          dialogType: normalizeDialogType(dialogInfo.dialogType),
          message: dialogInfo.message,
          ...(dialogInfo.defaultPrompt === undefined
            ? {}
            : { defaultPrompt: dialogInfo.defaultPrompt }),
        }),
      ];
      return { response: { events: [], result: {} }, dialogEvents };
    }
  }

  private async detectNewTabs(
    session: SessionState,
    openerController: PageController,
  ): Promise<DiscoveredTabEffects> {
    const events: StepEvent[] = [];
    let activePageRef: PageRef | undefined;
    let tabs: readonly AbpTab[];
    try {
      tabs = await session.rest.listTabs();
    } catch {
      return {
        events,
      };
    }

    for (const tab of tabs) {
      if (session.pageRefByTabId.has(tab.id)) {
        continue;
      }
      const popupController = await this.initializePageController(
        session,
        tab.id,
        {
          openerPageRef: openerController.pageRef,
          metadata: {
            url: tab.url,
            title: tab.title,
          },
          installSettleTracker: false,
        },
      );
      this.queueEvent(
        popupController.pageRef,
        this.createEvent({
          kind: "page-created",
          sessionRef: session.sessionRef,
          pageRef: popupController.pageRef,
        }),
      );
      events.push(
        this.createEvent({
          kind: "popup-opened",
          sessionRef: session.sessionRef,
          pageRef: popupController.pageRef,
          openerPageRef: openerController.pageRef,
        }),
      );
      if (tab.active) {
        activePageRef = popupController.pageRef;
      }
    }

    return {
      events,
      ...(activePageRef === undefined ? {} : { activePageRef }),
    };
  }

  private applyActionTabChange(
    session: SessionState,
    controllerPageRef: PageRef,
    response: AbpActionResponse,
    actionEvents: readonly StepEvent[],
    discoveredTabs: DiscoveredTabEffects,
  ): void {
    const pageRef = resolveTabChangePageRef({
      controllerPageRef,
      response,
      actionEvents,
      discoveredTabs,
      activePageRef: session.activePageRef,
    });
    if (response.tab_changed) {
      session.activePageRef = pageRef;
    }
  }

  private normalizeNetworkRecord(
    session: SessionState,
    pageRef: PageRef,
    call: AbpNetworkCall,
  ): NetworkRecord {
    const requestHeaders = parseHeaderJson(call.request_headers);
    const responseHeaders = parseHeaderJson(call.response_headers);
    const responseContentType = headerValue(responseHeaders, "content-type");
    const requestContentType = headerValue(requestHeaders, "content-type");

    return {
      kind: "http",
      requestId: createNetworkRequestId(call.request_id ?? `abp-${++this.requestCounter}`),
      sessionRef: session.sessionRef,
      pageRef,
      method: call.method,
      url: call.url,
      requestHeaders,
      responseHeaders,
      ...(call.status === undefined ? {} : { status: call.status }),
      resourceType: normalizeResourceType(call.resource_type),
      navigationRequest: normalizeResourceType(call.resource_type) === "document",
      ...(call.request_body === undefined
        ? {}
        : {
            requestBody: bodyPayloadFromUtf8(call.request_body, parseMimeType(requestContentType)),
          }),
      ...(call.response_body === undefined
        ? {}
        : {
            responseBody:
              call.response_body_encoding === "base64"
                ? createBodyPayload(new Uint8Array(Buffer.from(call.response_body, "base64")), {
                    encoding: "base64",
                    ...parseMimeType(responseContentType),
                  })
                : bodyPayloadFromUtf8(call.response_body, parseMimeType(responseContentType)),
          }),
    };
  }

  private async readStorageEntriesForOrigin(
    session: SessionState,
    storageKey: string,
    isLocalStorage: boolean,
  ): Promise<readonly StorageEntry[]> {
    const pageRef = session.activePageRef ?? chooseNextActivePageRef(Array.from(session.pageRefs));
    if (!pageRef) {
      return [];
    }
    const controller = this.requirePage(pageRef);
    try {
      const storage = await controller.cdp.send<AbpDomStorageItemsResult>(
        "DOMStorage.getDOMStorageItems",
        {
          storageId: {
            storageKey,
            isLocalStorage,
          },
        },
      );
      return storage.entries.map(([key, value]) => ({ key, value }));
    } catch {
      return [];
    }
  }

  private async readIndexedDbSnapshotForOrigin(
    session: SessionState,
    origin: string,
    storageKey: string,
  ): Promise<readonly IndexedDbDatabaseSnapshot[] | undefined> {
    const pageRef = session.activePageRef ?? chooseNextActivePageRef(Array.from(session.pageRefs));
    if (!pageRef) {
      return undefined;
    }
    const controller = this.requirePage(pageRef);

    let databaseNames: readonly string[];
    try {
      const names = await controller.cdp.send<AbpIndexedDbDatabaseNamesResult>(
        "IndexedDB.requestDatabaseNames",
        {
          securityOrigin: origin,
          storageKey,
        },
      );
      databaseNames = names.databaseNames;
    } catch {
      return undefined;
    }

    const databases: IndexedDbDatabaseSnapshot[] = [];
    for (const databaseName of databaseNames) {
      try {
        const database = await controller.cdp.send<AbpIndexedDbDatabaseResult>(
          "IndexedDB.requestDatabase",
          {
            securityOrigin: origin,
            storageKey,
            databaseName,
          },
        );
        const stores: IndexedDbObjectStoreSnapshot[] = [];
        for (const store of database.databaseWithObjectStores.objectStores) {
          const records: {
            key: unknown;
            primaryKey?: unknown;
            value: unknown;
          }[] = [];
          let skipCount = 0;
          while (true) {
            const data = await controller.cdp.send<AbpIndexedDbDataResult>(
              "IndexedDB.requestData",
              {
                securityOrigin: origin,
                storageKey,
                databaseName,
                objectStoreName: store.name,
                indexName: "",
                skipCount,
                pageSize: 250,
                keyRange: undefined,
              },
            );
            for (const entry of data.objectStoreDataEntries) {
              records.push({
                key: entry.key ?? null,
                ...(entry.primaryKey === undefined ? {} : { primaryKey: entry.primaryKey }),
                value: entry.value ?? null,
              });
            }
            if (!data.hasMore) {
              break;
            }
            skipCount += data.objectStoreDataEntries.length;
          }
          stores.push({
            name: store.name,
            ...(store.keyPathArray && store.keyPathArray.length > 0
              ? { keyPath: [...store.keyPathArray] }
              : store.keyPath === undefined
                ? {}
                : { keyPath: store.keyPath }),
            autoIncrement: store.autoIncrement ?? false,
            records,
          });
        }
        databases.push({
          name: database.databaseWithObjectStores.name,
          version: database.databaseWithObjectStores.version,
          objectStores: stores,
        });
      } catch {}
    }

    return databases;
  }

  private async collectSessionStorageSnapshots(
    session: SessionState,
  ): Promise<readonly SessionStorageSnapshot[]> {
    const snapshots: SessionStorageSnapshot[] = [];
    for (const pageRef of session.pageRefs) {
      const controller = this.requirePage(pageRef);
      await this.flushDomUpdateTask(controller);
      for (const frame of controller.framesByCdpId.values()) {
        const origin = parseOrigin(frame.currentDocument.url);
        if (origin === undefined) {
          continue;
        }
        if (origin === "null") {
          continue;
        }
        try {
          const storageKey = await controller.cdp.send<AbpStorageKeyResult>(
            "Storage.getStorageKey",
            {
              frameId: frame.cdpFrameId,
            },
          );
          const storage = await controller.cdp.send<AbpDomStorageItemsResult>(
            "DOMStorage.getDOMStorageItems",
            {
              storageId: {
                storageKey: storageKey.storageKey,
                isLocalStorage: false,
              },
            },
          );
          snapshots.push({
            pageRef: controller.pageRef,
            frameRef: frame.frameRef,
            origin,
            entries: storage.entries.map(([key, value]) => ({ key, value })),
          });
        } catch {}
      }
    }
    return snapshots;
  }

  private async buildPageInfo(controller: PageController): Promise<PageInfo> {
    const mainFrame = this.requireMainFrame(controller);
    controller.lastKnownTitle = await this.refreshTabTitle(controller);
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

  private async refreshTabTitle(controller: PageController): Promise<string> {
    try {
      const tab = await this.requireSession(controller.sessionRef).rest.getTab(controller.tabId);
      controller.lastKnownTitle = tab.title;
      return tab.title;
    } catch (error) {
      if (isPageClosedApiError(error)) {
        throw closedPageError(controller.pageRef);
      }
      return controller.lastKnownTitle;
    }
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
    const queued = (controller.domUpdateTask ?? Promise.resolve()).then(async () => {
      await this.reconcileDocumentEpochs(controller);
    });
    const settled = queued
      .catch((error) => {
        controller.backgroundError ??= normalizeAbpError(error, controller.pageRef);
      })
      .finally(() => {
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
    const nodeRef = createNodeRef(`abp-${++this.nodeCounter}`);
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
      document,
      backendNodeId,
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
    if (!session || session.closed) {
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
    if (controller.lifecycleState === "closed") {
      return;
    }
    controller.lifecycleState = "closed";
    this.pages.delete(controller.pageRef);
    const session = this.sessions.get(controller.sessionRef);
    session?.pageRefs.delete(controller.pageRef);
    session?.controllersByPageRef.delete(controller.pageRef);
    session?.pageRefByTabId.delete(controller.tabId);
    if (session?.activePageRef === controller.pageRef) {
      session.activePageRef = chooseNextActivePageRef(Array.from(session.pageRefs));
    }
    for (const frame of controller.framesByCdpId.values()) {
      this.frames.delete(frame.frameRef);
      this.documents.delete(frame.currentDocument.documentRef);
      this.retiredDocuments.add(frame.currentDocument.documentRef);
    }
    controller.framesByCdpId.clear();
    controller.documentsByRef.clear();
    controller.queuedEvents.length = 0;
  }

  private throwBackgroundError(controller: PageController): void {
    if (controller.backgroundError) {
      throw controller.backgroundError;
    }
  }

  private createEvent<TKind extends StepEvent["kind"]>(
    value: { readonly kind: TKind } & Omit<
      Extract<StepEvent, { readonly kind: TKind }>,
      "eventId" | "timestamp"
    >,
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

  private retireDocument(documentRef: DocumentRef): void {
    this.documents.delete(documentRef);
    this.retiredDocuments.add(documentRef);
  }

  private isDescendantFrame(frame: FrameState, ancestorFrameRef: FrameRef): boolean {
    let current = frame.parentFrameRef;
    while (current) {
      if (current === ancestorFrameRef) {
        return true;
      }
      current = this.frames.get(current)?.parentFrameRef;
    }
    return false;
  }

  private isHistoryBoundaryError(error: unknown, direction: "back" | "forward"): boolean {
    return (
      error instanceof AbpApiError &&
      error.status === 400 &&
      new RegExp(`Cannot go ${direction}`, "i").test(error.message)
    );
  }

  private readString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
  }

  private readBoolean(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw createBrowserCoreError("operation-failed", "engine has been disposed");
    }
  }
}

export async function createAbpBrowserCoreEngine(
  options: AbpBrowserCoreEngineOptions = {},
): Promise<AbpBrowserCoreEngine> {
  return AbpBrowserCoreEngine.create(options);
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

function resolveFallbackPageTarget(
  targets: readonly AbpCdpTargetInfo[],
  tabMetadata:
    | {
        readonly url?: string;
        readonly title?: string;
      }
    | undefined,
): AbpCdpTargetInfo | undefined {
  if (tabMetadata?.url) {
    const urlMatches = targets.filter((target) => target.url === tabMetadata.url);
    if (urlMatches.length === 1) {
      return urlMatches[0];
    }
  }

  if (tabMetadata?.title) {
    const titleMatches = targets.filter((target) => target.title === tabMetadata.title);
    if (titleMatches.length === 1) {
      return titleMatches[0];
    }
  }

  return undefined;
}
