import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isRecord } from "@opensteer/shared/isRecord";
import {
  BrowserAttachTicketClaimsSchema,
  type BrowserAttachTicketClaims,
  type BrowserAttachTicketIdentity,
  type BrowserServerMessage,
} from "@opensteer/protocol";
import type { BrowserCdpBackend, CdpChannel, CdpParameters } from "@opensteer/browser-core";
import type { BrowserCookie, BrowserProfileSnapshot } from "@opensteer/browser-profile/snapshot";
import type {
  BrowserContext,
  BrowserLaunchRequest,
  BrowserLauncher,
  BrowserPage,
  CdpSession,
  LaunchedBrowser,
} from "../browser/backend.js";
import type { BrowserControllerSink } from "../browser/controller.js";
import type { AttachTicketVerifier } from "../security/attach-ticket.js";
import type { BrowserFrame } from "../stream/frame.js";
import type {
  BrowserProfileAttachTicketClaims,
  BrowserProfileStateClient,
} from "../profile-state-client.js";

interface SentCdpCommand {
  method: string;
  parameters: Record<string, unknown> | undefined;
}

/**
 * What a page was asked to do, without the ledger's background title samples,
 * which run whenever the page answers and are covered by their own tests.
 */
export function withoutTitleSamples(sent: readonly SentCdpCommand[]): SentCdpCommand[] {
  return sent.filter(
    (command) =>
      command.method !== "Page.getFrameTree" &&
      !(command.method === "Runtime.evaluate" && command.parameters?.uniqueContextId !== undefined),
  );
}

export class FakeCdpSession implements CdpSession {
  detachCount = 0;
  readonly eventListeners = new Set<(method: string, parameters: CdpParameters) => void>();
  readonly listeners = new Map<string, Set<(parameters: unknown) => void>>();
  readonly responses = new Map<
    string,
    unknown | ((parameters: Record<string, unknown> | undefined) => unknown | Promise<unknown>)
  >();
  readonly sent: SentCdpCommand[] = [];

  async detach(): Promise<void> {
    this.detachCount += 1;
  }

  close(): Promise<void> {
    return this.detach();
  }

  onEvent(listener: (method: string, parameters: CdpParameters) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  on(event: string, listener: (parameters: unknown) => void): void {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener);
  }

  off(event: string, listener: (parameters: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  async send<Result = unknown>(
    method: string,
    parameters?: Record<string, unknown>,
  ): Promise<Result> {
    this.sent.push({ method, parameters });
    const response = this.responses.get(method);
    if (typeof response === "function") return (await response(parameters)) as Result;
    if (response !== undefined) return response as Result;
    if (method === "Page.getLayoutMetrics") {
      return {
        layoutViewport: { clientWidth: 1_280 },
        cssLayoutViewport: { clientWidth: 1_280 },
        cssVisualViewport: { clientHeight: 720, clientWidth: 1_280 },
      } as Result;
    }
    if (method === "Page.captureScreenshot") {
      return { data: jpeg(32, 24).toString("base64") } as Result;
    }
    if (method === "Page.getNavigationHistory") {
      return { currentIndex: 1, entries: [{ id: 10 }, { id: 11 }, { id: 12 }] } as Result;
    }
    return {} as Result;
  }

  emit(event: string, parameters: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(parameters);
    if (isRecord(parameters)) {
      for (const listener of this.eventListeners) listener(event, parameters);
    }
  }
}

/**
 * A page's document as its own CDP session sees it, in the order Chromium
 * reports it (measured on Chromium 151): a cross-document commit clears the
 * session's contexts, then reports `Page.frameNavigated` with a new loader,
 * then the new document's main world. `Runtime.enable` replays the main world
 * of the current document, and an evaluation by `uniqueContextId` answers only
 * in that live context.
 */
export class FakePage implements BrowserPage {
  readonly cdpSession: FakeCdpSession;
  closeCount = 0;
  private closed = false;
  private readonly closeListeners = new Set<() => void>();
  private readonly metadataListeners = new Set<() => void>();
  private openerPage: BrowserPage | null;
  private pageTitle: string;
  private pageUrl: string;
  private readonly pageTargetId: string;
  /** The current document's loader and main world; replaced on every commit. */
  private document = { loaderId: "", contextId: 0, uniqueId: "" };
  private nextDocument = 1;

  constructor(
    options: {
      cdp?: FakeCdpSession;
      opener?: BrowserPage | null;
      targetId?: string;
      title?: string;
      url?: string;
    } = {},
  ) {
    this.cdpSession = options.cdp ?? new FakeCdpSession();
    this.openerPage = options.opener ?? null;
    this.pageTitle = options.title ?? "New tab";
    this.pageUrl = options.url ?? "about:blank";
    this.pageTargetId = options.targetId ?? `target-${nextFakeTargetId++}`;
    this.document = this.newDocument();
    this.answer("Runtime.enable", () => {
      this.cdpSession.emit("Runtime.executionContextCreated", { context: this.mainWorld() });
      return {};
    });
    this.answer("Page.getFrameTree", () => ({
      frameTree: {
        frame: { id: this.pageTargetId, loaderId: this.document.loaderId, url: this.pageUrl },
      },
    }));
    this.answer("Runtime.evaluate", (parameters) => {
      if (parameters?.uniqueContextId === undefined) return {};
      if (parameters.uniqueContextId !== this.document.uniqueId)
        throw new Error("uniqueContextId not found");
      return { result: { value: { href: this.pageUrl, title: this.pageTitle } } };
    });
  }

  /** The loader of the document the page shows now. */
  get loaderId(): string {
    return this.document.loaderId;
  }

  /**
   * Commits a new document (a navigation, redirect or reload), reporting it as
   * Chromium does. The title is the new document's own.
   */
  navigate(url: string, title: string): void {
    this.cdpSession.emit("Runtime.executionContextsCleared", {});
    this.document = this.newDocument();
    this.pageUrl = url;
    this.pageTitle = title;
    this.cdpSession.emit("Page.frameNavigated", {
      frame: { id: this.pageTargetId, loaderId: this.document.loaderId, url },
      type: "Navigation",
    });
    this.cdpSession.emit("Runtime.executionContextCreated", { context: this.mainWorld() });
    for (const listener of this.metadataListeners) listener();
  }

  /**
   * Restores a cached document as Chromium reports a back/forward-cache
   * restore: its contexts come back after the clear and before the commit.
   */
  restore(url: string, title: string): void {
    this.cdpSession.emit("Runtime.executionContextsCleared", {});
    this.document = this.newDocument();
    this.pageUrl = url;
    this.pageTitle = title;
    this.cdpSession.emit("Runtime.executionContextCreated", { context: this.mainWorld() });
    this.cdpSession.emit("Page.frameNavigated", {
      frame: { id: this.pageTargetId, loaderId: this.document.loaderId, url },
      type: "BackForwardCacheRestore",
    });
  }

  /**
   * Forgets and replays the current document's contexts with no navigation,
   * as Electron's debugger hub does when it resubscribes.
   */
  replayContexts(): void {
    this.cdpSession.emit("Runtime.executionContextsCleared", {});
    this.cdpSession.emit("Runtime.executionContextCreated", { context: this.mainWorld() });
  }

  private newDocument() {
    const index = this.nextDocument++;
    return {
      loaderId: `${this.pageTargetId}-loader-${index}`,
      contextId: index,
      uniqueId: `${this.pageTargetId}-world-${index}`,
    };
  }

  private mainWorld() {
    return {
      id: this.document.contextId,
      uniqueId: this.document.uniqueId,
      origin: "",
      name: "",
      auxData: { frameId: this.pageTargetId, isDefault: true, type: "default" },
    };
  }

  /** Default answers; a test's own `cdpSession.responses` entry wins. */
  private answer(
    method: string,
    respond: (parameters: Record<string, unknown> | undefined) => unknown,
  ): void {
    const ownResponse = this.cdpSession.responses.get(method);
    if (ownResponse === undefined) this.cdpSession.responses.set(method, respond);
  }

  async agentCdp(): Promise<CdpSession> {
    return this.cdpSession;
  }

  async cdp(): Promise<CdpSession> {
    return this.cdpSession;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.crash();
  }

  crash(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }

  isClosed(): boolean {
    return this.closed;
  }

  onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  offClose(listener: () => void): void {
    this.closeListeners.delete(listener);
  }

  onMetadataChanged(listener: () => void): void {
    this.metadataListeners.add(listener);
  }

  offMetadataChanged(listener: () => void): void {
    this.metadataListeners.delete(listener);
  }

  async opener(): Promise<BrowserPage | null> {
    return this.openerPage;
  }

  async title(): Promise<string> {
    return this.pageTitle;
  }

  targetId(): Promise<string> {
    return Promise.resolve(this.pageTargetId);
  }

  url(): string {
    return this.pageUrl;
  }

  setMetadata(title: string, url: string): void {
    const navigated = this.pageUrl !== url;
    this.pageTitle = title;
    this.pageUrl = url;
    if (navigated)
      this.cdpSession.emit("Page.navigatedWithinDocument", { frameId: this.pageTargetId, url });
    for (const listener of this.metadataListeners) listener();
  }
}

export class FakeContext implements BrowserContext {
  private readonly pageListeners = new Set<(page: BrowserPage) => void>();
  private readonly pageList: BrowserPage[];

  constructor(pages: BrowserPage[] = []) {
    this.pageList = [...pages];
  }

  pages(): BrowserPage[] {
    return [...this.pageList];
  }

  async createPage(): Promise<BrowserPage> {
    const page = new FakePage();
    this.addPage(page);
    return page;
  }

  onPage(listener: (page: BrowserPage) => void): void {
    this.pageListeners.add(listener);
  }

  offPage(listener: (page: BrowserPage) => void): void {
    this.pageListeners.delete(listener);
  }

  addPage(page: BrowserPage): void {
    this.pageList.push(page);
    for (const listener of this.pageListeners) listener(page);
  }
}

export class FakeLaunchedBrowser implements LaunchedBrowser {
  readonly cdp: BrowserCdpBackend;
  readonly closeError: Error | null;
  closeCount = 0;
  readonly context: BrowserContext;
  snapshot: BrowserProfileSnapshot = { cookies: [], origins: [] };
  private closed = false;
  private readonly closeListeners = new Set<() => void>();

  constructor(context: BrowserContext, closeError: Error | null = null) {
    this.context = context;
    this.closeError = closeError;
    this.cdp = new FakeBrowserCdpBackend(context);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.crash();
    if (this.closeError) throw this.closeError;
  }

  exportSnapshot(): Promise<BrowserProfileSnapshot> {
    return Promise.resolve(this.snapshot);
  }

  async replaceSiteCookies(
    _site: string,
    _cookies: readonly BrowserCookie[],
    _deadline: AbortSignal,
  ): Promise<void> {}

  crash(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }

  onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  offClose(listener: () => void): void {
    this.closeListeners.delete(listener);
  }
}

export class FakeBrowserCdpBackend implements BrowserCdpBackend {
  readonly #context: BrowserContext;
  readonly #listeners = new Set<(method: string, parameters: CdpParameters) => void>();

  constructor(context: BrowserContext) {
    this.#context = context;
  }

  async attach(targetId: string): Promise<CdpChannel> {
    for (const page of this.#context.pages()) {
      if ((await page.targetId()) === targetId) return page.agentCdp();
    }
    throw new Error("Unknown fake target.");
  }

  onEvent(listener: (method: string, parameters: CdpParameters) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async send(method: string, parameters?: CdpParameters): Promise<unknown> {
    if (method === "Target.createTarget") {
      const page = await this.#context.createPage();
      if (page instanceof FakePage && typeof parameters?.url === "string") {
        page.setMetadata("", parameters.url);
      }
      return { targetId: await page.targetId() };
    }
    if (method === "Target.getTargets") {
      return {
        targetInfos: await Promise.all(
          this.#context.pages().map(async (page) => ({
            targetId: await page.targetId(),
            title: await page.title(),
            type: "page",
            url: page.url(),
          })),
        ),
      };
    }
    if (method === "Target.getTargetInfo") {
      const targetId = parameters?.targetId;
      if (typeof targetId !== "string") return {};
      for (const page of this.#context.pages()) {
        if ((await page.targetId()) === targetId) {
          return {
            targetInfo: { targetId, title: await page.title(), type: "page", url: page.url() },
          };
        }
      }
    }
    return {};
  }
}

let nextFakeTargetId = 1;

export class FakeLauncher implements BrowserLauncher {
  readonly browser: FakeLaunchedBrowser;
  launchCount = 0;
  lastRequest: BrowserLaunchRequest | null = null;
  readonly requests: BrowserLaunchRequest[] = [];

  constructor(browser = new FakeLaunchedBrowser(new FakeContext([new FakePage()]))) {
    this.browser = browser;
  }

  async launch(request: BrowserLaunchRequest): Promise<LaunchedBrowser> {
    this.launchCount += 1;
    this.lastRequest = request;
    this.requests.push(request);
    return this.browser;
  }
}

/** Launches a distinct browser per partition key, so hosts stay isolated. */
export class FakeIsolatingLauncher implements BrowserLauncher {
  readonly browsersByPartition = new Map<string, FakeLaunchedBrowser>();
  launchCount = 0;
  readonly requests: BrowserLaunchRequest[] = [];

  async launch(request: BrowserLaunchRequest): Promise<LaunchedBrowser> {
    this.launchCount += 1;
    this.requests.push(request);
    const browser = new FakeLaunchedBrowser(new FakeContext([new FakePage()]));
    this.browsersByPartition.set(request.partitionKey, browser);
    return browser;
  }
}

export class FakeSink implements BrowserControllerSink {
  readonly frames: BrowserFrame[] = [];
  readonly messages: BrowserServerMessage[] = [];
  sendFrameImplementation: ((frame: BrowserFrame) => Promise<void>) | null = null;
  sendServerImplementation: ((message: BrowserServerMessage) => Promise<void>) | null = null;

  async sendFrame(frame: BrowserFrame): Promise<void> {
    this.frames.push(frame);
    await this.sendFrameImplementation?.(frame);
  }

  async sendServer(message: BrowserServerMessage): Promise<void> {
    this.messages.push(message);
    await this.sendServerImplementation?.(message);
  }
}

export class FakeTicketVerifier implements AttachTicketVerifier {
  claims: BrowserAttachTicketClaims;
  readonly #claimsByToken = new Map<string, BrowserAttachTicketClaims>();
  readonly tokens: string[] = [];

  constructor(claims = validClaims()) {
    this.claims = claims;
  }

  async verify(token: string): Promise<BrowserAttachTicketClaims> {
    this.tokens.push(token);
    return this.#claimsByToken.get(token) ?? this.claims;
  }

  setClaims(token: string, claims: BrowserAttachTicketClaims): void {
    this.#claimsByToken.set(token, claims);
  }
}

export class FakeProfileStateClient implements BrowserProfileStateClient {
  commits: Array<{ expectedRevision: number; snapshot: BrowserProfileSnapshot }> = [];
  loads = 0;
  revision = 0;
  snapshot: BrowserProfileSnapshot = { cookies: [], origins: [] };

  async load(): Promise<{ revision: number; snapshot: BrowserProfileSnapshot }> {
    this.loads += 1;
    return { revision: this.revision, snapshot: this.snapshot };
  }

  async commit(
    _claims: BrowserProfileAttachTicketClaims,
    expectedRevision: number,
    snapshot: BrowserProfileSnapshot,
  ): Promise<number> {
    if (expectedRevision !== this.revision) throw new Error("stale profile revision");
    this.commits.push({ expectedRevision, snapshot });
    this.snapshot = snapshot;
    this.revision += 1;
    return this.revision;
  }
}

export function validClaims(
  overrides: Partial<BrowserAttachTicketClaims> = {},
): BrowserAttachTicketClaims {
  return BrowserAttachTicketClaimsSchema.parse({
    audience: "opensteer-browser-runtime",
    access: "full-control",
    expiresAt: "2030-01-01T00:05:00.000Z",
    issuedAt: "2030-01-01T00:00:00.000Z",
    identity: {
      kind: "profile",
      profileLeaseToken: "a".repeat(43),
      profileId: "bpr_00000000-0000-4000-8000-000000000001",
      profileStateUrl:
        "https://host.test/v1/browser-profile-state/bpr_00000000-0000-4000-8000-000000000001/bsn_00000000-0000-4000-8000-000000000002",
    },
    nonce: "nonce_0123456789abcdef",
    runtimeId: "runtime_test",
    sessionId: "bsn_00000000-0000-4000-8000-000000000002",
    subject: "host_test",
    ...overrides,
  });
}

/** Claims for a fresh Browser Session: no profile, no lease, no state URL. */
export function freshClaims(
  overrides: Partial<BrowserAttachTicketClaims> = {},
): BrowserAttachTicketClaims {
  return validClaims({ identity: { kind: "fresh" }, ...overrides });
}

/** Claims narrowed to a profile identity, for profile-state client tests. */
export function validProfileClaims(
  identityOverrides: Partial<Omit<ProfileIdentity, "kind">> = {},
  overrides: Partial<BrowserAttachTicketClaims> = {},
): BrowserProfileAttachTicketClaims {
  const base = validClaims();
  if (base.identity.kind !== "profile") throw new Error("Expected profile claims.");
  const claims = BrowserAttachTicketClaimsSchema.parse({
    ...base,
    ...overrides,
    identity: { ...base.identity, ...identityOverrides },
  });
  if (claims.identity.kind !== "profile") throw new Error("Expected profile claims.");
  return { ...claims, identity: claims.identity };
}

type ProfileIdentity = Extract<BrowserAttachTicketIdentity, { kind: "profile" }>;

export function jpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0xff,
    0xd9,
  ]);
}

export async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A private, empty folder for one test runtime's staged session files. */
export function testSessionFilesRoot(): string {
  return path.resolve(mkdtempSync(path.join(tmpdir(), "opensteer-session-files-")));
}
