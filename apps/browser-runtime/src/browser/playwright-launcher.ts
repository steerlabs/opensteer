import { ChromiumClipboard } from "./chromium-clipboard.js";
import { isRecord } from "@opensteer/shared/isRecord";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { BrowserCdpBackend, CdpChannel, CdpParameters } from "@opensteer/browser-core";
import { browserCookieFromCdp, browserCookieToCdp } from "@opensteer/browser-profile/cookies";
import {
  captureBrowserProfileSnapshot,
  type BrowserOriginCaptureFailure,
  type BrowserCookie,
  type BrowserProfileSnapshot,
} from "@opensteer/browser-profile/snapshot";
import {
  chromium,
  type BrowserServer as PlaywrightBrowserServer,
  type BrowserContext as PlaywrightBrowserContext,
  type CDPSession as PlaywrightCdpSession,
  type Dialog,
  type Frame,
  type Page,
} from "playwright-core";
import {
  browserPageDisabledBlinkFeatures,
  browserPagePolicyScript,
} from "@opensteer/browser-runtime-core/page-policy";
import {
  siteCookieReplacementBatch,
  type BrowserContext,
  type BrowserLaunchRequest,
  type BrowserLauncher,
  type BrowserPage,
  type CdpSession,
  type LaunchedBrowser,
} from "@opensteer/browser-runtime-core";

interface PlaywrightChromiumLauncherOptions {
  chromiumSandbox: boolean;
  environment?: Readonly<NodeJS.ProcessEnv>;
  executablePath: string;
  headless: boolean;
  proxyUrl?: string;
}

const commonChromiumEnvironmentVariables = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
] as const;

const platformChromiumEnvironmentVariables: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ["HOME", "__CF_USER_TEXT_ENCODING"],
  linux: ["HOME", "LANGUAGE"],
  win32: ["HOMEDRIVE", "HOMEPATH", "SystemRoot", "USERPROFILE", "WINDIR"],
};

const headedLinuxEnvironmentVariables = ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"];

/**
 * Chromium is an untrusted child boundary. Keep this an allowlist: service
 * configuration, credentials, proxy variables, auth sockets, and dynamic-loader
 * controls must not flow from the Runtime process into the browser process.
 */
export function createChromiumChildEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
  headless: boolean,
): Record<string, string> {
  const variableNames = [
    ...commonChromiumEnvironmentVariables,
    ...(platformChromiumEnvironmentVariables[platform] ?? []),
    ...(platform === "linux" && !headless ? headedLinuxEnvironmentVariables : []),
  ];
  const childEnvironment: Record<string, string> = {};
  for (const name of variableNames) {
    const value = environmentValue(environment, name, platform === "win32");
    if (value !== undefined && value.length > 0) childEnvironment[name] = value;
  }
  return childEnvironment;
}

function environmentValue(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
  caseInsensitive: boolean,
): string | undefined {
  const exact = environment[name];
  if (exact !== undefined || !caseInsensitive) return exact;
  const canonicalName = name.toLowerCase();
  for (const [candidate, value] of Object.entries(environment)) {
    if (candidate.toLowerCase() === canonicalName) return value;
  }
  return undefined;
}

export class PlaywrightChromiumLauncher implements BrowserLauncher {
  private readonly childEnvironment: Readonly<Record<string, string>>;
  private readonly chromiumSandbox: boolean;
  private readonly executablePath: string;
  private readonly headless: boolean;
  private readonly proxyUrl: string | undefined;

  constructor(options: PlaywrightChromiumLauncherOptions) {
    if (!path.isAbsolute(options.executablePath)) {
      throw new Error("Chromium executablePath must be absolute.");
    }
    this.chromiumSandbox = options.chromiumSandbox;
    this.childEnvironment = createChromiumChildEnvironment(
      options.environment ?? process.env,
      process.platform,
      options.headless,
    );
    this.executablePath = options.executablePath;
    this.headless = options.headless;
    this.proxyUrl = options.proxyUrl;
  }

  async launch(request: BrowserLaunchRequest, signal?: AbortSignal): Promise<LaunchedBrowser> {
    signal?.throwIfAborted();
    await access(this.executablePath, constants.X_OK);
    const browserServer = await chromium.launchServer({
      args: [
        `--disable-blink-features=${browserPageDisabledBlinkFeatures}`,
        ...(this.proxyUrl
          ? [
              "--disable-background-networking",
              "--disable-quic",
              "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
              "--proxy-bypass-list=<-loopback>",
            ]
          : []),
      ],
      chromiumSandbox: this.chromiumSandbox,
      env: { ...this.childEnvironment },
      executablePath: this.executablePath,
      handleSIGHUP: false,
      handleSIGINT: false,
      handleSIGTERM: false,
      headless: this.headless,
      host: "127.0.0.1",
      ...(this.proxyUrl ? { proxy: { server: this.proxyUrl } } : {}),
    });
    let stopped: Promise<void> | undefined;
    const owner = {
      kill: () => {
        stopped ??= browserServer.kill().finally(() => signal?.removeEventListener("abort", abort));
        return stopped;
      },
    };
    const abort = () => {
      void owner.kill().catch(() => undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      const browser = await chromium.connect(browserServer.wsEndpoint());
      const openDialogs = new Map<Page, Dialog>();
      const context = await browser.newContext({
        acceptDownloads: false,
        storageState: { cookies: [], origins: request.snapshot.origins },
        // The Runtime's ledger alone sizes pages. A Playwright viewport would
        // be a second emulator that Playwright re-applies on its own, such as
        // around a screenshot, putting a page back to the size it opened at.
        viewport: null,
      });
      // Before the first page: Playwright installs it in every later page,
      // popup and frame ahead of the page's own scripts.
      await context.addInitScript({ content: browserPagePolicyScript });
      // Subscribe before creating pages: an inline popup dialog can precede
      // the client's per-page listener, especially over Playwright's transport.
      // Without this context subscription Playwright dismisses it at once.
      context.on("dialog", (dialog) => {
        const page = dialog.page();
        if (page) openDialogs.set(page, dialog);
      });
      context.on("page", (page) => {
        page.on("close", () => openDialogs.delete(page));
      });
      if (context.pages().length === 0) await context.newPage();
      const browserCdp = await browser.newBrowserCDPSession();
      const contexts = await browserCdp.send("Target.getBrowserContexts");
      if (
        !Array.isArray(contexts.browserContextIds) ||
        contexts.browserContextIds.length !== 1 ||
        typeof contexts.browserContextIds[0] !== "string" ||
        contexts.browserContextIds[0].length < 1
      ) {
        throw new Error("Chromium did not expose one isolated browser context.");
      }
      const browserContextId = contexts.browserContextIds[0];
      if (request.snapshot.cookies.length > 0) {
        await browserCdp.send("Storage.setCookies", {
          browserContextId,
          cookies: request.snapshot.cookies.map(browserCookieToCdp),
        });
      }
      const launched = new PlaywrightLaunchedBrowser(
        owner,
        context,
        browserCdp,
        browserContextId,
        openDialogs,
        request.snapshot,
      );
      if (this.headless) launched.clipboard = await ChromiumClipboard.create(browser);
      // Sessions' agents hear of the pages they own as Chromium announces
      // them. The relay listens before discovery starts.
      await browserCdp.send("Target.setDiscoverTargets", { discover: true });
      signal?.throwIfAborted();
      return launched;
    } catch (error) {
      await owner.kill();
      throw error;
    }
  }
}

class PlaywrightLaunchedBrowser implements LaunchedBrowser {
  clipboard?: ChromiumClipboard;
  private readonly browserServer: Pick<PlaywrightBrowserServer, "kill">;
  private readonly browserCdp: PlaywrightCdpSession;
  private readonly browserContextId: string;
  private closePromise: Promise<void> | null = null;
  readonly cdp: BrowserCdpBackend;
  readonly context: BrowserContext;
  private lastSnapshot: BrowserProfileSnapshot;
  private readonly contextHandle: PlaywrightContextHandle;
  private readonly playwrightContext: PlaywrightBrowserContext;

  constructor(
    browserServer: Pick<PlaywrightBrowserServer, "kill">,
    context: PlaywrightBrowserContext,
    browserCdp: PlaywrightCdpSession,
    browserContextId: string,
    openDialogs: Map<Page, Dialog>,
    lastSnapshot: BrowserProfileSnapshot,
  ) {
    this.browserServer = browserServer;
    this.lastSnapshot = lastSnapshot;
    this.browserCdp = browserCdp;
    this.browserContextId = browserContextId;
    this.playwrightContext = context;
    this.contextHandle = new PlaywrightContextHandle(context, openDialogs);
    this.context = this.contextHandle;
    this.cdp = new PlaywrightBrowserCdpBackend(browserCdp, this.contextHandle, browserContextId);
  }

  onClose(listener: () => void): void {
    this.playwrightContext.on("close", listener);
  }

  offClose(listener: () => void): void {
    this.playwrightContext.off("close", listener);
  }

  async exportSnapshot(
    onOriginFailure?: (failure: BrowserOriginCaptureFailure) => void,
  ): Promise<BrowserProfileSnapshot> {
    const state = await this.playwrightContext.storageState({
      indexedDB: true,
    });
    const { cookies } = await this.browserCdp.send("Storage.getCookies", {
      browserContextId: this.browserContextId,
    });
    const snapshot = captureBrowserProfileSnapshot({
      cookies: cookies.map(browserCookieFromCdp),
      origins: state.origins,
      previous: this.lastSnapshot,
      ...(onOriginFailure ? { onOriginFailure } : {}),
    });
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  async replaceSiteCookies(
    site: string,
    cookies: readonly BrowserCookie[],
    deadline: AbortSignal,
  ): Promise<void> {
    const { cookies: live } = await this.browserCdp.send("Storage.getCookies", {
      browserContextId: this.browserContextId,
    });
    const batch = siteCookieReplacementBatch(site, live, cookies);
    if (batch.length === 0) return;
    deadline.throwIfAborted();
    await this.browserCdp.send("Storage.setCookies", {
      browserContextId: this.browserContextId,
      cookies: batch,
    });
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  /**
   * Snapshots are exported before close; Chromium's disk profile is disposable.
   * Native graceful shutdown waits for NetworkService's disk flush, so end the
   * owned process group directly. Playwright waits for exit and removes its
   * temporary directories. No remote detach or dialog answer can hold it up.
   */
  private async closeOnce(): Promise<void> {
    const stopped = this.browserServer.kill();
    await (this.cdp as PlaywrightBrowserCdpBackend).close();
    await stopped;
  }
}

class PlaywrightContextHandle implements BrowserContext {
  private closed = false;
  isConnected(): boolean {
    return !this.closed && this.context.browser()?.isConnected() === true;
  }
  private readonly context: PlaywrightBrowserContext;
  private readonly openDialogs: Map<Page, Dialog>;
  private readonly pagesByPlaywrightPage = new Map<Page, PlaywrightPageHandle>();
  private readonly pageListeners = new Map<(page: BrowserPage) => void, (page: Page) => void>();

  constructor(context: PlaywrightBrowserContext, openDialogs: Map<Page, Dialog>) {
    this.context = context;
    context.on("close", () => {
      this.closed = true;
    });
    this.openDialogs = openDialogs;
  }

  pages(): BrowserPage[] {
    return this.context.pages().map((page) => this.wrap(page));
  }

  async createPage(): Promise<BrowserPage> {
    return this.wrap(await this.context.newPage());
  }

  onPage(listener: (page: BrowserPage) => void): void {
    const existing = this.pageListeners.get(listener);
    if (existing) return;
    const wrappedListener = (page: Page) => listener(this.wrap(page));
    this.pageListeners.set(listener, wrappedListener);
    this.context.on("page", wrappedListener);
  }

  offPage(listener: (page: BrowserPage) => void): void {
    const wrappedListener = this.pageListeners.get(listener);
    if (!wrappedListener) return;
    this.pageListeners.delete(listener);
    this.context.off("page", wrappedListener);
  }

  isClosed(): boolean {
    return this.context.isClosed();
  }

  wrap(page: Page): PlaywrightPageHandle {
    let handle = this.pagesByPlaywrightPage.get(page);
    if (!handle) {
      handle = new PlaywrightPageHandle(this, this.context, page, this.openDialogs);
      this.pagesByPlaywrightPage.set(page, handle);
    }
    return handle;
  }

  async pageByTargetId(targetId: string): Promise<PlaywrightPageHandle | null> {
    for (const page of this.context.pages()) {
      const handle = this.wrap(page);
      if ((await handle.targetId()) === targetId) return handle;
    }
    return null;
  }
}

class PlaywrightPageHandle implements BrowserPage {
  private cdpPromise: Promise<CdpSession> | null = null;
  private targetIdPromise: Promise<string> | null = null;
  private readonly context: PlaywrightBrowserContext;
  private readonly contextHandle: PlaywrightContextHandle;
  private readonly metadataListeners = new Map<
    () => void,
    {
      domContentLoaded: () => void;
      frameNavigated: (frame: Frame) => void;
      load: () => void;
    }
  >();
  private readonly page: Page;
  private readonly openDialogs: Map<Page, Dialog>;

  constructor(
    contextHandle: PlaywrightContextHandle,
    context: PlaywrightBrowserContext,
    page: Page,
    openDialogs: Map<Page, Dialog>,
  ) {
    this.openDialogs = openDialogs;
    this.contextHandle = contextHandle;
    this.context = context;
    this.page = page;
  }

  agentCdp(): Promise<CdpSession> {
    return this.context
      .newCDPSession(this.page)
      .then((session) => new PlaywrightCdpHandle(session));
  }

  cdp(): Promise<CdpSession> {
    this.cdpPromise ??= this.context
      .newCDPSession(this.page)
      .then((session) => new PlaywrightPageCdpHandle(session, this.page, this.openDialogs));
    return this.cdpPromise;
  }

  async close(): Promise<void> {
    if (!this.page.isClosed()) await this.page.close({ runBeforeUnload: false });
  }

  isClosed(): boolean {
    return this.page.isClosed();
  }

  onClose(listener: () => void): void {
    this.page.on("close", listener);
  }

  offClose(listener: () => void): void {
    this.page.off("close", listener);
  }

  onMetadataChanged(listener: () => void): void {
    if (this.metadataListeners.has(listener)) return;
    const callbacks = {
      domContentLoaded: listener,
      frameNavigated: (frame: Frame) => {
        if (frame === this.page.mainFrame()) listener();
      },
      load: listener,
    };
    this.metadataListeners.set(listener, callbacks);
    this.page.on("domcontentloaded", callbacks.domContentLoaded);
    this.page.on("framenavigated", callbacks.frameNavigated);
    this.page.on("load", callbacks.load);
  }

  offMetadataChanged(listener: () => void): void {
    const callbacks = this.metadataListeners.get(listener);
    if (!callbacks) return;
    this.metadataListeners.delete(listener);
    this.page.off("domcontentloaded", callbacks.domContentLoaded);
    this.page.off("framenavigated", callbacks.frameNavigated);
    this.page.off("load", callbacks.load);
  }

  async opener(): Promise<BrowserPage | null> {
    const opener = await this.page.opener();
    return opener ? this.contextHandle.wrap(opener) : null;
  }

  targetId(): Promise<string> {
    this.targetIdPromise ??= this.cdp().then(async (cdp) => {
      const response = await cdp.send<{ targetInfo?: { targetId?: unknown } }>(
        "Target.getTargetInfo",
      );
      const targetId = response.targetInfo?.targetId;
      if (typeof targetId !== "string" || targetId.length < 1 || targetId.length > 512) {
        throw new Error("Chromium page did not expose a valid target ID.");
      }
      return targetId;
    });
    return this.targetIdPromise;
  }

  async title(): Promise<string> {
    // Target metadata lives in the browser; evaluating document.title waits
    // forever when the first document has already opened a dialog.
    const cdp = await this.cdp();
    const response = await cdp.send<{ targetInfo?: { title?: unknown } }>("Target.getTargetInfo");
    const title = response.targetInfo?.title;
    if (typeof title !== "string") throw new Error("Chromium page did not expose a valid title.");
    return title;
  }

  url(): string {
    return this.page.url();
  }
}

class PlaywrightCdpHandle implements CdpSession {
  protected detached = false;
  readonly eventRelay: PlaywrightCdpEventRelay;
  private readonly session: PlaywrightCdpSession;
  private readonly subscriptions = new Map<
    string,
    Map<(parameters: unknown) => void, (parameters: unknown) => void>
  >();

  constructor(session: PlaywrightCdpSession) {
    this.session = session;
    this.eventRelay = new PlaywrightCdpEventRelay(session);
  }

  close(): Promise<void> {
    return this.detach();
  }

  async detach(): Promise<void> {
    if (this.detached) return;
    this.detached = true;
    this.eventRelay.close();
    for (const [event, listeners] of this.subscriptions) {
      for (const listener of listeners.values()) untypedCdp(this.session).off(event, listener);
    }
    this.subscriptions.clear();
    // Playwright first sends Runtime.runIfWaitingForDebugger to the page;
    // a modal or unresponsive renderer can withhold its answer indefinitely.
    // Retire this channel locally; detaching remotely is best effort, and
    // ending the owning browser never depends on that answer.
    void this.session.detach().catch(() => undefined);
  }

  onEvent(listener: (method: string, parameters: CdpParameters) => void): () => void {
    return this.eventRelay.subscribe(listener);
  }

  on(event: string, listener: (parameters: unknown) => void): void {
    if (this.detached) throw new Error("CDP session is closed.");
    let listeners = this.subscriptions.get(event);
    if (!listeners) {
      listeners = new Map();
      this.subscriptions.set(event, listeners);
    }
    if (listeners.has(listener)) return;
    const owned = (parameters: unknown) => {
      if (!this.detached) listener(parameters);
    };
    listeners.set(listener, owned);
    untypedCdp(this.session).on(event, owned);
  }

  off(event: string, listener: (parameters: unknown) => void): void {
    const listeners = this.subscriptions.get(event);
    const owned = listeners?.get(listener);
    if (!listeners || !owned) return;
    untypedCdp(this.session).off(event, owned);
    listeners.delete(listener);
    if (listeners.size === 0) this.subscriptions.delete(event);
  }

  send<Result = unknown>(method: string, parameters?: Record<string, unknown>): Promise<Result> {
    if (this.detached) return Promise.reject(new Error("CDP session is closed."));
    this.eventRelay.observeDomain(method);
    return untypedCdp(this.session).send<Result>(method, parameters);
  }
}

/**
 * Playwright already hears dialogs before a popup is surfaced. A later CDP
 * session cannot recover that opening with Page.enable or answer it through
 * its own Page handler, so the platform channel uses that original handle.
 */
class PlaywrightPageCdpHandle extends PlaywrightCdpHandle {
  private readonly page: Page;
  private readonly openDialogs: Map<Page, Dialog>;
  private readonly dialogListeners = new Map<
    (parameters: unknown) => void,
    (dialog: Dialog) => void
  >();
  private readonly clearDialog = () => this.openDialogs.delete(this.page);

  constructor(session: PlaywrightCdpSession, page: Page, openDialogs: Map<Page, Dialog>) {
    super(session);
    this.page = page;
    this.openDialogs = openDialogs;
    super.on("Page.javascriptDialogClosed", this.clearDialog);
  }

  override on(event: string, listener: (parameters: unknown) => void): void {
    if (this.detached) throw new Error("CDP session is closed.");
    if (event !== "Page.javascriptDialogOpening") {
      super.on(event, listener);
      return;
    }
    if (this.dialogListeners.has(listener)) return;
    const opened = (dialog: Dialog) => listener({ type: dialog.type(), message: dialog.message() });
    this.dialogListeners.set(listener, opened);
    this.page.on("dialog", opened);
    const dialog = this.openDialogs.get(this.page);
    if (dialog) opened(dialog);
  }

  override off(event: string, listener: (parameters: unknown) => void): void {
    if (event !== "Page.javascriptDialogOpening") {
      super.off(event, listener);
      return;
    }
    const opened = this.dialogListeners.get(listener);
    if (!opened) return;
    this.dialogListeners.delete(listener);
    this.page.off("dialog", opened);
  }

  override async send<Result = unknown>(
    method: string,
    parameters?: Record<string, unknown>,
  ): Promise<Result> {
    if (this.detached) throw new Error("CDP session is closed.");
    if (method !== "Page.handleJavaScriptDialog") return super.send<Result>(method, parameters);
    const dialog = this.openDialogs.get(this.page);
    if (!dialog) throw new Error("There is no active browser dialog.");
    if (parameters?.accept === true) {
      await dialog.accept(
        typeof parameters.promptText === "string" ? parameters.promptText : undefined,
      );
    } else {
      await dialog.dismiss();
    }
    if (this.openDialogs.get(this.page) === dialog) this.openDialogs.delete(this.page);
    return {} as Result;
  }

  override async detach(): Promise<void> {
    for (const listener of this.dialogListeners.keys())
      this.off("Page.javascriptDialogOpening", listener);
    super.off("Page.javascriptDialogClosed", this.clearDialog);
    await super.detach();
  }
}

class PlaywrightBrowserCdpBackend implements BrowserCdpBackend {
  private readonly browserContextId: string;
  private closed = false;
  private readonly context: PlaywrightContextHandle;
  private readonly handle: PlaywrightCdpHandle;

  constructor(
    session: PlaywrightCdpSession,
    context: PlaywrightContextHandle,
    browserContextId: string,
  ) {
    this.browserContextId = browserContextId;
    this.context = context;
    this.handle = new PlaywrightCdpHandle(session);
    this.handle.eventRelay.observeDomain("Target.getTargets");
  }

  async attach(targetId: string): Promise<CdpChannel> {
    if (this.closed) throw new Error("Browser CDP backend is closed.");
    const page = await this.context.pageByTargetId(targetId);
    if (!page) throw new Error("CDP target is not an attachable page in this Profile Host.");
    return page.agentCdp();
  }

  onEvent(listener: (method: string, parameters: CdpParameters) => void): () => void {
    return this.handle.onEvent(listener);
  }

  send(method: string, parameters?: CdpParameters): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Browser CDP backend is closed."));
    if (method === "Target.createTarget") {
      const requestedContext = parameters?.browserContextId;
      if (requestedContext !== undefined && requestedContext !== this.browserContextId) {
        return Promise.reject(new Error("CDP target requested another browser context."));
      }
      return this.createTarget(parameters?.url);
    }
    if (method === "Target.getBrowserContexts") {
      return Promise.resolve({ browserContextIds: [this.browserContextId] });
    }
    if (contextScopedBrowserMethods.has(method)) {
      const requestedContext = parameters?.browserContextId;
      if (requestedContext !== undefined && requestedContext !== this.browserContextId) {
        return Promise.reject(new Error("CDP command requested another browser context."));
      }
      return this.handle.send(method, {
        ...parameters,
        browserContextId: this.browserContextId,
      });
    }
    return this.handle.send(method, parameters);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.detach();
  }

  /**
   * Opens the tab through Playwright, which installs the page policy in a page
   * before it runs; a target created over raw CDP can load its first document
   * first. As in Electron, a tab is a surface of this one context, so window
   * placement parameters do not apply.
   */
  private async createTarget(url: unknown): Promise<{ targetId: string }> {
    const page = await this.context.createPage();
    const targetId = await page.targetId();
    if (typeof url === "string" && url !== "about:blank") {
      // As CDP's own createTarget does, the tab navigates in the background; a
      // failed navigation stays visible in the tab as its error page.
      void page
        .cdp()
        .then((cdp) => cdp.send("Page.navigate", { url }))
        .catch(() => undefined);
    }
    return { targetId };
  }
}

const contextScopedBrowserMethods = new Set([
  "Browser.grantPermissions",
  "Browser.resetPermissions",
  "Browser.setPermission",
  "Storage.clearCookies",
  "Storage.getCookies",
  "Storage.setCookies",
]);

type ProtocolJson = {
  readonly domains?: readonly {
    readonly domain?: unknown;
    readonly events?: readonly { readonly name?: unknown }[];
  }[];
};

const protocolEventsByDomain = loadProtocolEvents();

class PlaywrightCdpEventRelay {
  private closed = false;
  readonly #installed = new Map<string, (parameters: unknown) => void>();
  readonly #listeners = new Set<(method: string, parameters: CdpParameters) => void>();
  readonly #session: PlaywrightCdpSession;

  constructor(session: PlaywrightCdpSession) {
    this.#session = session;
  }

  subscribe(listener: (method: string, parameters: CdpParameters) => void): () => void {
    if (this.closed) throw new Error("CDP event relay is closed.");
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  observeDomain(method: string): void {
    if (this.closed) return;
    const separator = method.indexOf(".");
    if (separator < 1) return;
    const domain = method.slice(0, separator);
    for (const eventName of protocolEventsByDomain.get(domain) ?? []) {
      const fullName = `${domain}.${eventName}`;
      if (this.#installed.has(fullName)) continue;
      const handler = (parameters: unknown) => {
        if (!isRecord(parameters)) return;
        for (const listener of this.#listeners) listener(fullName, parameters);
      };
      this.#installed.set(fullName, handler);
      untypedCdp(this.#session).on(fullName, handler);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [eventName, handler] of this.#installed) {
      untypedCdp(this.#session).off(eventName, handler);
    }
    this.#installed.clear();
    this.#listeners.clear();
  }
}

function loadProtocolEvents(): ReadonlyMap<string, readonly string[]> {
  const require = createRequire(import.meta.url);
  const files = [
    "devtools-protocol/json/browser_protocol.json",
    "devtools-protocol/json/js_protocol.json",
  ];
  const events = new Map<string, Set<string>>();
  for (const file of files) {
    const protocol = require(file) as ProtocolJson;
    for (const domain of protocol.domains ?? []) {
      if (typeof domain.domain !== "string") continue;
      const names = events.get(domain.domain) ?? new Set<string>();
      for (const event of domain.events ?? []) {
        if (typeof event.name === "string") names.add(event.name);
      }
      events.set(domain.domain, names);
    }
  }
  return new Map([...events].map(([domain, names]) => [domain, [...names]]));
}

function untypedCdp(session: PlaywrightCdpSession): {
  off(event: string, listener: (parameters: unknown) => void): void;
  on(event: string, listener: (parameters: unknown) => void): void;
  send<Result>(method: string, parameters?: Record<string, unknown>): Promise<Result>;
} {
  return session as unknown as {
    off(event: string, listener: (parameters: unknown) => void): void;
    on(event: string, listener: (parameters: unknown) => void): void;
    send<Result>(method: string, parameters?: Record<string, unknown>): Promise<Result>;
  };
}
