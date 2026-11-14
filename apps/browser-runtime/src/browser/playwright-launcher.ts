import {
  reducedUserAgentMetadata,
  type BrowserCdpBackend,
  type CdpChannel,
  type CdpParameters,
} from "@opensteer/browser-core";
import { type BrowserCookie } from "@opensteer/browser-profile/cookies";
import {
  BrowserRuntimeError,
  siteCookieReplacementBatch,
  type BrowserContext,
  type BrowserLaunchRequest,
  type BrowserLauncher,
  type BrowserPage,
  type CdpSession,
  type LaunchedBrowser,
  type LocalProfileEngine,
  readImageDimensions,
  viewportCapturePlan,
  viewportImageScript,
  type ViewportCapture,
  type ViewportCaptureRequest,
} from "@opensteer/browser-runtime-core";
import {
  browserPageDisabledBlinkFeatures,
  browserPagePolicyScriptFor,
} from "@opensteer/browser-runtime-core/page-policy";
import { isRecord } from "@opensteer/shared/isRecord";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { release as osRelease } from "node:os";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
  chromium,
  type Dialog,
  type Frame,
  type Page,
  type Request,
  type BrowserContext as PlaywrightBrowserContext,
  type BrowserServer as PlaywrightBrowserServer,
  type CDPSession as PlaywrightCdpSession,
} from "playwright-core";
import { z } from "zod";
import { ChromiumClipboard } from "./chromium-clipboard.js";

import { flushNativeCookies, initializeNativePreferences } from "./native-profile-storage.js";

import type { BrowserPagePolicyConfig } from "@opensteer/browser-runtime-core/page-policy";
import {
  PasskeyBridge,
  createPasskeyProviderConfig,
} from "@opensteer/browser-runtime-core/passkey-bridge";
import type { PasskeyAuthenticator } from "@opensteer/browser-runtime-core/passkeys";

export interface NativeProfileOpenTiming {
  readonly correlationId: string;
  readonly stage:
    | "prepare"
    | "preferences"
    | "chromium-launch"
    | "page-policy"
    | "cookie-target"
    | "cdp"
    | "import"
    | "clipboard"
    | "target-discovery";
  readonly elapsedMs: number;
  readonly elapsedSinceStartMs: number;
}

interface PlaywrightChromiumLauncherOptions {
  authenticator?: PasskeyAuthenticator;
  onNativeOpenTiming?: (timing: NativeProfileOpenTiming) => void;
  probePasskeys?: boolean;
  args?: readonly string[];
  chromiumSandbox: boolean;
  environment?: Readonly<NodeJS.ProcessEnv>;
  executablePath: string;
  headless: boolean;
  proxyUrl?: string;
}

/** macOS marketing version from the Darwin kernel major, as UA-CH reports it. */
function darwinPlatformVersion(): string {
  if (process.platform !== "darwin") return "";
  const major = Number(osRelease().split(".")[0]);
  if (!Number.isInteger(major) || major < 20) return "";
  return `${major >= 25 ? major + 1 : major - 9}.0.0`;
}

/** Reduced Chrome UA at the shipped engine major; stock headless announces itself. */
export function reducedChromeUserAgent(version: string): string {
  const major = version.split(".")[0] ?? version;
  const platform =
    process.platform === "win32"
      ? "Windows NT 10.0; Win64; x64"
      : process.platform === "darwin"
        ? "Macintosh; Intel Mac OS X 10_15_7"
        : "X11; Linux x86_64";
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
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
  linux: [
    "HOME",
    "LANGUAGE",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "XDG_CURRENT_DESKTOP",
    "DESKTOP_SESSION",
  ],
  win32: ["HOMEDRIVE", "HOMEPATH", "SystemRoot", "USERPROFILE", "WINDIR"],
};

const headedLinuxEnvironmentVariables = ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"];

/**
 * Chromium is an untrusted child boundary. Keep this an allowlist: service
 * configuration, credentials, proxy variables, SSH sockets, and dynamic-loader
 * controls must not flow into the browser. Linux's desktop bus/runtime selectors
 * are needed for Chromium's OS-backed Secret Service encryption.
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

/** Tests support for browser-owned current Security state, without navigating. */
export async function probePasskeySecurityState(
  session: Pick<CdpSession, "on" | "off" | "send">,
): Promise<boolean> {
  const state = z.object({
    visibleSecurityState: z.object({
      securityState: z.enum([
        "unknown",
        "neutral",
        "insecure",
        "secure",
        "info",
        "insecure-broken",
      ]),
    }),
  });
  const observed = Promise.withResolvers<boolean>();
  const listener = (value: unknown) => {
    if (state.safeParse(value).success) observed.resolve(true);
  };
  session.on("Security.visibleSecurityStateChanged", listener);
  try {
    return await withTimeout(
      Promise.all([session.send("Security.enable"), observed.promise]).then(() => true),
      500,
      { timeoutError: () => new Error("Browser Security state unavailable.") },
    ).catch(() => false);
  } finally {
    session.off("Security.visibleSecurityStateChanged", listener);
  }
}

export class PlaywrightChromiumLauncher implements BrowserLauncher {
  readonly hostCost = "process" as const;
  private preparation: Promise<void> | undefined;
  private readonly nativeBrowsers = new Map<string, Promise<LaunchedBrowser>>();
  private readonly nativeCloseFailures = new Set<string>();
  readonly localProfiles: LocalProfileEngine = {
    engine: "chromium",
    createFiles: async () => {},
    release: async (directory) => {
      const pending = this.nativeBrowsers.get(directory);
      if (pending) {
        const browser = await pending.catch((error) => {
          if (this.nativeCloseFailures.has(directory)) throw error;
          return undefined;
        });
        await browser?.close();
      }
      return "released";
    },
  };
  private readonly onNativeOpenTiming: ((timing: NativeProfileOpenTiming) => void) | undefined;
  private readonly probePasskeys: boolean;
  private securityStateAvailable = false;
  get passkeys(): 1 | undefined {
    return this.securityStateAvailable ? 1 : undefined;
  }
  private readonly authenticator: PasskeyAuthenticator | undefined;
  private readonly args: readonly string[];
  private readonly childEnvironment: Readonly<Record<string, string>>;
  private readonly chromiumSandbox: boolean;
  private readonly executablePath: string;
  private readonly headless: boolean;
  private readonly proxyUrl: string | undefined;

  constructor(options: PlaywrightChromiumLauncherOptions) {
    if (!path.isAbsolute(options.executablePath)) {
      throw new Error("Chromium executablePath must be absolute.");
    }
    this.onNativeOpenTiming = options.onNativeOpenTiming;
    this.probePasskeys = options.probePasskeys === true || options.authenticator !== undefined;
    this.authenticator = options.authenticator;
    this.args = options.args ?? [];
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

  private startServer(timeout?: number): Promise<PlaywrightBrowserServer> {
    return chromium.launchServer({
      ...(timeout === undefined ? {} : { timeout }),
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        ...this.args,
        `--disable-blink-features=${browserPageDisabledBlinkFeatures},AutomationControlled`,
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
  }

  prepare(): Promise<void> {
    this.preparation ??= (async () => {
      if (!this.probePasskeys) return;
      let server: PlaywrightBrowserServer | undefined;
      try {
        server = await this.startServer(2000);
        const current = server;
        this.securityStateAvailable = await withTimeout(
          (async () => {
            const browser = await chromium.connect(current.wsEndpoint());
            const context = await browser.newContext();
            const page = await context.newPage();
            const session = await context.newCDPSession(page);
            return probePasskeySecurityState(new PlaywrightCdpHandle(session));
          })(),
          2000,
          { timeoutError: () => new Error("Browser Security probe timed out.") },
        );
      } catch {
        this.securityStateAvailable = false;
      } finally {
        if (server) {
          const owned = server;
          await withTimeout(owned.kill(), 1500, {
            timeoutError: () => new Error("Browser probe cleanup timed out."),
          }).catch(() => {
            this.securityStateAvailable = false;
            try {
              owned.process().kill("SIGKILL");
            } catch {
              /* An exited child needs no further cleanup. */
            }
          });
        }
      }
      if (!this.securityStateAvailable)
        process.stderr.write(
          '{"event":"browser-runtime.passkeys-unavailable","reason":"Browser did not provide visible Security state; using absent policy."}\n',
        );
    })();
    return this.preparation;
  }

  async launch(request: BrowserLaunchRequest, signal?: AbortSignal): Promise<LaunchedBrowser> {
    if (request.storage.kind === "local") {
      return this.acquireNative(
        request.storage,
        signal,
        request.authenticator,
        request.remainingBudgetMs,
      );
    }
    signal?.throwIfAborted();
    await access(this.executablePath, constants.X_OK);
    await this.prepare();
    const browserServer = await this.startServer();
    let stopped: Promise<void> | undefined;
    const owner = {
      close: () => {
        stopped ??= browserServer.kill().finally(() => signal?.removeEventListener("abort", abort));
        return stopped;
      },
    };
    const abort = () => {
      void owner.close().catch(() => undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      const browser = await chromium.connect(browserServer.wsEndpoint());
      const openDialogs = new Map<Page, Dialog>();
      const guestUserAgent = reducedChromeUserAgent(browser.version());
      // Playwright derives UA metadata from the UA string, which reports the
      // frozen "10_15_7" platform version and x86 on Apple Silicon. Override
      // each page with metadata built from the real system instead.
      const guestMetadata = reducedUserAgentMetadata(
        browser.version(),
        process.platform === "win32"
          ? "Windows"
          : process.platform === "darwin"
            ? "macOS"
            : "Linux",
        {
          architecture: process.arch === "arm64" ? "arm" : process.arch === "x64" ? "x86" : "",
          bitness: process.arch === "arm64" || process.arch === "x64" ? "64" : "",
          platformVersion: darwinPlatformVersion(),
        },
      );
      const context = await browser.newContext({
        userAgent: guestUserAgent,
        acceptDownloads: false,
        // The Runtime's ledger alone sizes pages. A Playwright viewport would
        // be a second emulator that Playwright re-applies on its own, such as
        // around a screenshot, putting a page back to the size it opened at.
        viewport: null,
      });
      // Before the first page: Playwright installs it in every later page,
      // popup and frame ahead of the page's own scripts.
      // Context init scripts precede popup page events. One random binding per
      // isolated context lets those first scripts queue until their page attaches.
      const authenticator = this.passkeys
        ? (request.authenticator ?? this.authenticator)
        : undefined;
      const providerConfig = authenticator ? createPasskeyProviderConfig() : undefined;
      await context.addInitScript({
        content: browserPagePolicyScriptFor(providerConfig),
      });
      // Subscribe before creating pages: an inline popup dialog can precede
      // the client's per-page listener, especially over Playwright's transport.
      // Without this context subscription Playwright dismisses it at once.
      context.on("dialog", (dialog) => {
        const page = dialog.page();
        if (page) openDialogs.set(page, dialog);
      });
      context.on("page", (page) => {
        page.on("close", () => openDialogs.delete(page));
        if (guestMetadata)
          void context
            .newCDPSession(page)
            .then((cdp) =>
              cdp.send("Emulation.setUserAgentOverride", {
                userAgent: guestUserAgent,
                userAgentMetadata: {
                  brands: guestMetadata.brands.map((entry) => ({ ...entry })),
                  fullVersionList: guestMetadata.fullVersionList.map((entry) => ({ ...entry })),
                  fullVersion: guestMetadata.fullVersion,
                  platform: guestMetadata.platform,
                  platformVersion: guestMetadata.platformVersion,
                  architecture: guestMetadata.architecture,
                  model: guestMetadata.model,
                  mobile: guestMetadata.mobile,
                  bitness: guestMetadata.bitness,
                },
              }),
            )
            .catch(() => undefined);
      });
      const anchor = await context.newPage();
      if (context.pages().every((page) => page === anchor)) await context.newPage();
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
      const launched = new PlaywrightLaunchedBrowser(
        owner,
        context,
        browserCdp,
        browserContextId,
        openDialogs,
        authenticator,
        providerConfig,
        anchor,
      );
      if (this.headless) launched.clipboard = await ChromiumClipboard.create(browser);
      // Sessions' agents hear of the pages they own as Chromium announces
      // them. The relay listens before discovery starts.
      await browserCdp.send("Target.setDiscoverTargets", { discover: true });
      signal?.throwIfAborted();
      // The runtime now owns the host; ending its first attachment must not
      // tear down sibling sessions or the native warm host.
      signal?.removeEventListener("abort", abort);
      return launched;
    } catch (error) {
      await owner.close();
      throw error;
    }
  }
  private acquireNative(
    storage: Extract<BrowserLaunchRequest["storage"], { kind: "local" }>,
    signal?: AbortSignal,
    authenticator?: PasskeyAuthenticator,
    remainingBudgetMs = 18_000,
  ): Promise<LaunchedBrowser> {
    if (storage.binding.engine !== "chromium" || !path.isAbsolute(storage.directory)) {
      return Promise.reject(
        new BrowserRuntimeError(
          "conflict",
          "Native profile belongs to another engine or directory.",
        ),
      );
    }
    if (this.nativeBrowsers.has(storage.directory)) {
      return Promise.reject(
        new BrowserRuntimeError("conflict", "Native profile is already owned by this engine."),
      );
    }
    if (
      /headless[_-]shell/iu.test(this.executablePath) ||
      this.args.some((arg) =>
        /^(?:--password-store=basic|--use-mock-keychain|--profile-directory|--user-data-dir|--incognito|--guest)(?:=|$)/u.test(
          arg,
        ),
      )
    ) {
      return Promise.reject(
        new Error("Native profiles require full Chromium and its OS-backed key store."),
      );
    }
    const pending = this.launchNative(
      storage.directory,
      performance.now() + Math.min(remainingBudgetMs, 18_000),
      signal,
      authenticator,
    );
    this.nativeBrowsers.set(storage.directory, pending);
    void pending.catch(() => {
      if (
        this.nativeBrowsers.get(storage.directory) === pending &&
        !this.nativeCloseFailures.has(storage.directory)
      )
        this.nativeBrowsers.delete(storage.directory);
    });
    return pending;
  }

  private async launchNative(
    directory: string,
    deadline: number,
    signal?: AbortSignal,
    requestedAuthenticator?: PasskeyAuthenticator,
  ): Promise<LaunchedBrowser> {
    const started = performance.now();
    const correlationId = randomUUID();
    let previous = started;
    const timing = (stage: NativeProfileOpenTiming["stage"]) => {
      const now = performance.now();
      try {
        this.onNativeOpenTiming?.({
          correlationId,
          stage,
          elapsedMs: now - previous,
          elapsedSinceStartMs: now - started,
        });
      } catch {
        /* Diagnostics cannot change profile readiness. */
      }
      previous = now;
    };
    signal?.throwIfAborted();
    await access(this.executablePath, constants.X_OK);
    await this.prepare();
    timing("prepare");
    await initializeNativePreferences(directory);
    timing("preferences");
    signal?.throwIfAborted();
    const context = await chromium.launchPersistentContext(directory, {
      // Playwright owns the child before returning the context and reaps it on
      // launch timeout. A Promise race alone would strand that owned process.
      timeout: Math.max(1, Math.ceil(deadline - performance.now())),
      executablePath: this.executablePath,
      // Explicit arguments bypass Playwright's initial-page wait and test key stores.
      ignoreDefaultArgs: true,
      args: [
        ...this.args,
        `--user-data-dir=${directory}`,
        "--remote-debugging-pipe",
        // Guest already receives these from Playwright's defaults. Native launches
        // must not start Chromium's bundled extension workers on every cold open.
        "--disable-extensions",
        "--disable-component-extensions-with-background-pages",
        "--disable-component-update",
        "--disable-background-networking",
        "--no-startup-window",
        "--restore-last-session",
        "--no-first-run",
        "--no-default-browser-check",
        `--disable-blink-features=${browserPageDisabledBlinkFeatures},AutomationControlled`,
        ...(this.headless ? ["--headless=new"] : []),
        ...(this.chromiumSandbox ? [] : ["--no-sandbox"]),
        ...(this.proxyUrl
          ? [
              `--proxy-server=${this.proxyUrl}`,
              "--disable-quic",
              "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
              "--proxy-bypass-list=<-loopback>",
            ]
          : []),
      ],
      chromiumSandbox: this.chromiumSandbox,
      headless: this.headless,
      env: { ...this.childEnvironment },
      handleSIGHUP: false,
      handleSIGINT: false,
      handleSIGTERM: false,
      acceptDownloads: false,
      viewport: null,
    });
    let ownedProcess: ChildProcess;
    try {
      // The pinned Playwright patch exposes the same owner as BrowserServer.process().
      const handle = (
        context as PlaywrightBrowserContext & { process?(): ChildProcess }
      ).process?.();
      if (
        !(handle instanceof ChildProcess) ||
        typeof handle.pid !== "number" ||
        !Number.isSafeInteger(handle.pid) ||
        handle.pid <= 0
      )
        throw new Error("Persistent Chromium did not expose its owned process.");
      ownedProcess = handle;
    } catch (cause) {
      this.nativeCloseFailures.add(directory);
      await context.close().catch(() => undefined);
      throw new BrowserRuntimeError(
        "conflict",
        "Native Chromium process ownership is unavailable. The profile was preserved.",
        { cause },
      );
    }
    const exited = new Promise<void>((resolve) => {
      if (ownedProcess.exitCode !== null || ownedProcess.signalCode !== null) resolve();
      else ownedProcess.once("exit", () => resolve());
    });
    timing("chromium-launch");
    const browser = context.browser();
    if (!browser) {
      this.nativeCloseFailures.add(directory);
      await context.close();
      await exited;
      throw new Error("Persistent Chromium has no browser owner.");
    }
    let stopped: Promise<void> | undefined;
    const owner = {
      close: () => {
        // Ask Chromium to close normally; the cleanup deadline must also contain
        // its background shutdown work. Never release its directory before exit.
        stopped ??= (async () => {
          // Chromium can retain background shutdown work after Browser.close.
          // Only its captured child may be forced, and the directory remains
          // owned until the OS confirms that child exited.
          const registered = this.nativeBrowsers.get(directory);
          let exitProven = false;
          const closing = (async () => {
            try {
              await context.close();
            } finally {
              await browser.close();
            }
          })();
          const protocolClosed = closing.then(
            () => ({ status: "fulfilled" as const }),
            (reason: unknown) => ({ status: "rejected" as const, reason }),
          );
          const force = setTimeout(() => {
            if (ownedProcess.exitCode !== null || ownedProcess.signalCode !== null) return;
            try {
              // Pinned Playwright starts POSIX browsers as process-group leaders.
              if (process.platform === "win32") ownedProcess.kill("SIGKILL");
              else process.kill(-ownedProcess.pid!, "SIGKILL");
            } catch (error) {
              if (nodeErrorCode(error) !== "ESRCH") this.nativeCloseFailures.add(directory);
            }
          }, 1_000);
          force.unref?.();
          try {
            await withTimeout(
              (async () => {
                await exited;
                exitProven = true;
                const result = await protocolClosed;
                if (result.status === "rejected") throw result.reason;
              })(),
              1_800,
              {
                timeoutError: () =>
                  new Error(
                    exitProven
                      ? "Native Chromium protocol close did not finish after process exit."
                      : "Native Chromium did not exit after owned-process shutdown.",
                  ),
              },
            );
          } finally {
            clearTimeout(force);
            const release = () => {
              if (this.nativeBrowsers.get(directory) !== registered) return;
              this.nativeBrowsers.delete(directory);
              this.nativeCloseFailures.delete(directory);
            };
            if (exitProven) release();
            else {
              this.nativeCloseFailures.add(directory);
              void exited.then(release);
            }
          }
        })().finally(() => signal?.removeEventListener("abort", abort));
        return stopped;
      },
    };
    const abort = () => {
      void owner.close().catch(() => undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      const openDialogs = new Map<Page, Dialog>();
      const authenticator = this.passkeys
        ? (requestedAuthenticator ?? this.authenticator)
        : undefined;
      const providerConfig = authenticator ? createPasskeyProviderConfig() : undefined;
      await context.addInitScript({ content: browserPagePolicyScriptFor(providerConfig) });
      timing("page-policy");
      context.on("dialog", (dialog) => {
        const page = dialog.page();
        if (page) openDialogs.set(page, dialog);
      });
      context.on("page", (page) => {
        page.on("close", () => openDialogs.delete(page));
      });
      if (context.pages().length) throw new Error("Chromium restored unauthorized tabs.");
      // Keep one private blank target only while this bounded profile host is warm.
      // Without it, closing the last tab also discards Chromium's warm renderer.
      const helper = await context.newPage();
      timing("cookie-target");
      const browserCdp = await browser.newBrowserCDPSession();
      timing("cdp");
      const launched = new PlaywrightLaunchedBrowser(
        owner,
        context,
        browserCdp,
        undefined,
        openDialogs,
        authenticator,
        providerConfig,
        helper,
      );
      if (this.headless) launched.clipboard = ChromiumClipboard.lazy(browser);
      timing("clipboard");
      await browserCdp.send("Target.setDiscoverTargets", { discover: true });
      timing("target-discovery");
      signal?.throwIfAborted();
      // The runtime now owns the host; ending its first attachment must not
      // tear down sibling sessions or the native warm host.
      signal?.removeEventListener("abort", abort);
      return launched;
    } catch (error) {
      await owner.close();
      throw error;
    }
  }
}

class PlaywrightLaunchedBrowser implements LaunchedBrowser {
  clipboard?: ReturnType<typeof ChromiumClipboard.lazy>;
  private readonly owner: { close(): Promise<void> };
  private readonly browserCdp: PlaywrightCdpSession;
  private readonly browserContextId: string | undefined;
  private closePromise: Promise<void> | null = null;
  readonly cdp: BrowserCdpBackend;
  readonly context: BrowserContext;
  private readonly contextHandle: PlaywrightContextHandle;
  private readonly playwrightContext: PlaywrightBrowserContext;
  private readonly persistencePage: Page | undefined;

  constructor(
    owner: { close(): Promise<void> },
    context: PlaywrightBrowserContext,
    browserCdp: PlaywrightCdpSession,
    browserContextId: string | undefined,
    openDialogs: Map<Page, Dialog>,
    authenticator?: PasskeyAuthenticator,
    providerConfig?: BrowserPagePolicyConfig,
    privatePage?: Page,
  ) {
    this.persistencePage = privatePage;
    this.owner = owner;
    this.browserCdp = browserCdp;
    this.browserContextId = browserContextId;
    this.playwrightContext = context;
    this.contextHandle = new PlaywrightContextHandle(
      context,
      openDialogs,
      authenticator,
      providerConfig,
      privatePage,
    );
    if (authenticator) {
      for (const page of context.pages())
        void this.contextHandle
          .wrap(page)
          .cdp()
          .catch(() => page.close());
      context.on("page", (page) => {
        void this.contextHandle
          .wrap(page)
          .cdp()
          .catch(() => page.close());
      });
    }
    this.context = this.contextHandle;
    this.cdp = new PlaywrightBrowserCdpBackend(browserCdp, this.contextHandle, browserContextId);
  }

  onClose(listener: () => void): void {
    this.playwrightContext.on("close", listener);
  }

  offClose(listener: () => void): void {
    this.playwrightContext.off("close", listener);
  }

  async replaceSiteCookies(
    site: string,
    cookies: readonly BrowserCookie[],
    deadline: AbortSignal,
  ): Promise<void> {
    const { cookies: live } = await this.browserCdp.send(
      "Storage.getCookies",
      this.browserContextId ? { browserContextId: this.browserContextId } : {},
    );
    const batch = siteCookieReplacementBatch(site, live, cookies);
    if (batch.length === 0) return;
    deadline.throwIfAborted();
    await this.browserCdp.send("Storage.setCookies", {
      ...(this.browserContextId ? { browserContextId: this.browserContextId } : {}),
      cookies: batch,
    });
    if (this.browserContextId === undefined) {
      const page = this.persistencePage ?? this.playwrightContext.pages()[0];
      if (!page) throw new Error("Native cookie persistence requires a live profile page.");
      const channel = await this.playwrightContext.newCDPSession(page);
      try {
        await flushNativeCookies(channel);
      } finally {
        await channel.detach();
      }
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  /**
   * The owner closes persistent contexts normally and joins process exit;
   * disposable Guest owners kill only their own child.
   */
  private async closeOnce(): Promise<void> {
    const stopped = this.owner.close();
    const results = await Promise.allSettled([
      withTimeout((this.cdp as PlaywrightBrowserCdpBackend).close(), 500, {
        timeoutError: () => new Error("Browser CDP detach did not finish."),
      }),
      stopped,
    ]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(failures, "Browser close did not complete cleanly.");
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

  readonly authenticator: PasskeyAuthenticator | undefined;
  readonly providerConfig: BrowserPagePolicyConfig;
  private readonly privatePage: Page | undefined;

  constructor(
    context: PlaywrightBrowserContext,
    openDialogs: Map<Page, Dialog>,
    authenticator?: PasskeyAuthenticator,
    providerConfig?: BrowserPagePolicyConfig,
    privatePage?: Page,
  ) {
    this.privatePage = privatePage;
    this.authenticator = authenticator;
    this.providerConfig = providerConfig;
    this.context = context;
    context.on("close", () => {
      this.closed = true;
    });
    this.openDialogs = openDialogs;
  }

  pages(): BrowserPage[] {
    return this.context
      .pages()
      .filter((page) => page !== this.privatePage)
      .map((page) => this.wrap(page));
  }

  async createPage(): Promise<BrowserPage> {
    return this.wrap(await this.context.newPage());
  }

  onPage(listener: (page: BrowserPage) => void): void {
    const existing = this.pageListeners.get(listener);
    if (existing) return;
    const wrappedListener = (page: Page) => {
      if (page !== this.privatePage) listener(this.wrap(page));
    };
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
      page.once("close", () => this.pagesByPlaywrightPage.delete(page));
    }
    return handle;
  }

  async pageByTargetId(targetId: string): Promise<PlaywrightPageHandle | null> {
    for (const page of this.context.pages().filter((page) => page !== this.privatePage)) {
      const handle = this.wrap(page);
      if ((await handle.targetId()) === targetId) return handle;
    }
    return null;
  }
}

const documentMediaScript = `(() => {
  const roots = [document];
  for (const root of roots) {
    if ([...root.querySelectorAll('audio,video')].some(media => !media.paused && !media.ended)) return true;
    for (const node of root.querySelectorAll('*')) if (node.shadowRoot) roots.push(node.shadowRoot);
  }
  return false;
})()`;

// null: the frame detached. A navigation can replace the document mid-check; read its successor.
async function documentMediaPlaying(frame: Frame): Promise<boolean | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await frame.evaluate<boolean>(documentMediaScript);
    } catch (error) {
      if (frame.isDetached()) return null;
      if (
        attempt === 3 ||
        !(error instanceof Error && error.message.includes("Execution context was destroyed"))
      )
        throw error;
    }
  }
}

class PlaywrightPageHandle implements BrowserPage {
  private requestMethod = "GET";
  private documentMethod = "GET";
  private readonly uploads = new Set<Request>();
  private captureSession: Promise<PlaywrightCdpSession> | undefined;
  private captureWorld: number | undefined;
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
    page.on("request", (request) => {
      if (!["GET", "HEAD"].includes(request.method())) this.uploads.add(request);
      if (request.isNavigationRequest() && request.frame() === page.mainFrame())
        this.requestMethod = request.method();
    });
    page.on("requestfinished", (request) => this.uploads.delete(request));
    page.on("requestfailed", (request) => this.uploads.delete(request));
    page.once("close", () => this.uploads.clear());
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.documentMethod = this.requestMethod;
    });
  }

  async keepAwake(): Promise<"upload" | "post" | "media" | null> {
    if (this.uploads.size) return "upload";
    if (!["GET", "HEAD"].includes(this.documentMethod)) return "post";
    for (const frame of this.page.frames()) {
      const playing = await documentMediaPlaying(frame);
      if (playing === null) continue;
      if (playing) return "media";
      let session: PlaywrightCdpSession;
      try {
        session = await this.context.newCDPSession(frame);
      } catch (error) {
        // Same-process frames share their local root's Web Audio graph.
        if (error instanceof Error && error.message.includes("part of the parent frame's session"))
          continue;
        throw error;
      }
      const players = new Map<string, boolean>();
      const contexts = new Set<string>();
      session.on("Media.playerCreated", ({ player }) => players.set(player.playerId, true));
      session.on("Media.playerPropertiesChanged", ({ playerId }) => {
        if (!players.has(playerId)) players.set(playerId, true);
      });
      session.on("Media.playerEventsAdded", ({ playerId, events }) => {
        for (const event of events) {
          let value: unknown;
          try {
            value = JSON.parse(event.value);
          } catch {
            players.set(playerId, true);
            continue;
          }
          if (!isRecord(value)) continue;
          if (value.event === "kPlay") players.set(playerId, true);
          else if (
            ["kPause", "kEnded", "kSuspended", "kWebMediaPlayerDestroyed"].includes(
              String(value.event),
            )
          )
            players.set(playerId, false);
        }
      });
      const contextChanged = ({
        context,
      }: {
        context: { contextId: string; contextType: string; contextState: string };
      }) => {
        if (context.contextType === "realtime" && context.contextState === "running")
          contexts.add(context.contextId);
        else contexts.delete(context.contextId);
      };
      session.on("WebAudio.contextCreated", contextChanged);
      session.on("WebAudio.contextChanged", contextChanged);
      session.on("WebAudio.contextWillBeDestroyed", ({ contextId }) => contexts.delete(contextId));
      try {
        // Enabling replays existing native players and Web Audio contexts.
        await session.send("Media.enable");
        await session.send("WebAudio.enable");
        if ([...players.values()].some(Boolean) || contexts.size) return "media";
      } finally {
        await session.detach();
      }
    }
    return this.uploads.size ? "upload" : null;
  }

  async hasOpenerAccess(): Promise<boolean> {
    const info = z
      .object({ targetInfo: z.object({ canAccessOpener: z.boolean().optional() }) })
      .parse(await (await this.cdp()).send("Target.getTargetInfo"));
    return info.targetInfo.canAccessOpener === true;
  }

  async captureViewport({
    clip,
    format,
    layout,
    pageScale,
    quality,
  }: ViewportCaptureRequest): Promise<ViewportCapture> {
    // This session must never enable emulation: an unclipped capture would then resize the page too.
    const session = await (this.captureSession ??= this.context
      .newCDPSession(this.page)
      .catch((error: unknown) => {
        this.captureSession = undefined;
        throw error;
      }));
    const encoding = { format, ...(quality === undefined ? {} : { quality }) };
    const direct = format === "jpeg" && !clip ? "jpeg" : "png";
    const { data } = await session.send(
      "Page.captureScreenshot",
      direct === format ? encoding : { format: direct },
    );
    const bitmap = readImageDimensions(Buffer.from(data, "base64"), direct);
    if (!bitmap) throw new Error("Chromium returned an unreadable screenshot.");
    const visible = {
      height: Math.round(layout.height / pageScale),
      width: Math.round(layout.width / pageScale),
    };
    if (
      !clip &&
      direct === format &&
      bitmap.width === visible.width &&
      bitmap.height === visible.height
    )
      return { data };
    const plan = viewportCapturePlan(bitmap, visible, clip);
    return { data: await this.inCaptureWorld(session, viewportImageScript(data, plan, encoding)) };
  }

  /** A world page scripts and agents never reach, lending the page's own image codecs. */
  private async inCaptureWorld(session: PlaywrightCdpSession, expression: string): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        const { frameTree } = await session.send("Page.getFrameTree");
        this.captureWorld ??= (
          await session.send("Page.createIsolatedWorld", {
            frameId: frameTree.frame.id,
            worldName: "opensteer-capture",
          })
        ).executionContextId;
        const { exceptionDetails, result } = await session.send("Runtime.evaluate", {
          awaitPromise: true,
          contextId: this.captureWorld,
          expression,
          returnByValue: true,
        });
        if (exceptionDetails) throw new Error("The page could not encode the screenshot.");
        return z.string().parse(result.value);
      } catch (error) {
        // A navigation takes the world with it.
        this.captureWorld = undefined;
        if (attempt > 0) throw error;
      }
    }
  }

  agentCdp(): Promise<CdpSession> {
    return this.context
      .newCDPSession(this.page)
      .then((session) => new PlaywrightCdpHandle(session));
  }

  cdp(): Promise<CdpSession> {
    this.cdpPromise ??= this.context.newCDPSession(this.page).then(async (session) => {
      const channel = new PlaywrightPageCdpHandle(
        session,
        this.page,
        this.openDialogs,
        this.contextHandle.authenticator ? ["Network", "Security"] : [],
      );
      if (this.contextHandle.authenticator) {
        const bridge = new PasskeyBridge(channel, this.contextHandle.authenticator, {
          lateBootstrap: true,
          targetId: () => this.targetId(),
          ...(this.contextHandle.providerConfig
            ? { config: this.contextHandle.providerConfig }
            : {}),
        });

        this.page.once("close", () => bridge.close());
        untypedCdp(session).on("close", () => bridge.close());
        try {
          await bridge.start();
        } catch (error) {
          bridge.close();
          throw error;
        }
      }
      return channel;
    });
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
    for (const listener of this.subscriptions.get("close")?.keys() ?? []) listener({});
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
  private readonly persistentDomains: ReadonlySet<string>;
  private readonly page: Page;
  private readonly openDialogs: Map<Page, Dialog>;
  private readonly dialogListeners = new Map<
    (parameters: unknown) => void,
    (dialog: Dialog) => void
  >();
  private readonly clearDialog = () => this.openDialogs.delete(this.page);

  constructor(
    session: PlaywrightCdpSession,
    page: Page,
    openDialogs: Map<Page, Dialog>,
    persistentDomains: readonly string[] = [],
  ) {
    super(session);
    this.persistentDomains = new Set(persistentDomains);
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
    // Short platform leases cannot stop the provider's document observations.
    // Detaching this same session releases the domains for the owning page.
    if (
      method.endsWith(".disable") &&
      this.persistentDomains.has(method.slice(0, method.indexOf(".")))
    )
      return {} as Result;
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
  private readonly browserContextId: string | undefined;
  private closed = false;
  private readonly context: PlaywrightContextHandle;
  private readonly handle: PlaywrightCdpHandle;

  constructor(
    session: PlaywrightCdpSession,
    context: PlaywrightContextHandle,
    browserContextId: string | undefined,
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
      return Promise.resolve({
        browserContextIds: this.browserContextId ? [this.browserContextId] : [],
      });
    }
    if (contextScopedBrowserMethods.has(method)) {
      const requestedContext = parameters?.browserContextId;
      if (requestedContext !== undefined && requestedContext !== this.browserContextId) {
        return Promise.reject(new Error("CDP command requested another browser context."));
      }
      return this.handle.send(method, {
        ...parameters,
        ...(this.browserContextId ? { browserContextId: this.browserContextId } : {}),
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
