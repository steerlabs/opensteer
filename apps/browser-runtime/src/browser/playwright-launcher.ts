/// <reference lib="dom" />
import {
  SessionCdpRouterError,
  contextScopedCdpMethods,
  reducedUserAgentMetadata,
  type BrowserCdpBackend,
  type CdpChannel,
  type CdpParameters,
} from "@opensteer/browser-core";
import { type BrowserCookie } from "@opensteer/browser-profile/cookies";
import { BrowserSurfaceIdSchema, type BrowserSurfaceId } from "@opensteer/protocol/browser";
import {
  BrowserRuntimeError,
  pageUnnameableReason,
  pageWithTarget,
  siteCookieReplacementBatch,
  type BrowserContext,
  type BrowserLaunchRequest,
  type BrowserLauncher,
  type BrowserPage,
  type BrowserMemoryPressure,
  type BrowserRendererUsage,
  type BrowserSessionRestore,
  type CdpSession,
  type LaunchedBrowser,
  type LocalProfileEngine,
  type PageEndReason,
  type PageGoneCause,
  type RendererGoneCause,
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
import { delay } from "@opensteer/shared/delay";
import { isRecord } from "@opensteer/shared/isRecord";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import {
  collectLinuxMemoryPressure,
  collectLinuxRendererUsage,
  type LinuxProcFs,
} from "./linux-renderer-usage.js";
import {
  ChromiumTabLifecycleBridge,
  ensureTabLifecycleExtension,
  isInternalExtensionUrl,
  tabNameBound,
  type ChromiumTabEntry,
} from "./tab-lifecycle-extension.js";

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
  linuxProcFs?: LinuxProcFs;
  platform?: NodeJS.Platform;
  proxyUrl?: string;
  preserveLoopbackBypass?: boolean;
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
  readonly rendererUsage?: () => BrowserRendererUsage | Promise<BrowserRendererUsage>;
  readonly memoryPressure?: () =>
    BrowserMemoryPressure | null | Promise<BrowserMemoryPressure | null>;
  private preparation: Promise<void> | undefined;
  private readonly ownedBrowserPids = new Set<number>();
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
  private readonly preserveLoopbackBypass: boolean;

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
    this.preserveLoopbackBypass = options.preserveLoopbackBypass === true;
    const platform = options.platform ?? process.platform;
    if (platform === "linux") {
      const proc = options.linuxProcFs;
      this.rendererUsage = () => collectLinuxRendererUsage(this.ownedBrowserPids, proc);
      this.memoryPressure = () => collectLinuxMemoryPressure(proc);
    }
  }

  private trackBrowserProcess(child: ChildProcess | null | undefined): () => void {
    const pid = child?.pid;
    if (
      !child ||
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return () => undefined;
    }
    this.ownedBrowserPids.add(pid);
    const untrack = () => {
      this.ownedBrowserPids.delete(pid);
    };
    child.once("exit", untrack);
    return () => {
      child.off("exit", untrack);
      this.ownedBrowserPids.delete(pid);
    };
  }

  private proxyTrafficArgs(): readonly string[] {
    return [
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ...(this.preserveLoopbackBypass ? [] : ["--proxy-bypass-list=<-loopback>"]),
    ];
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
              // Playwright's proxy option injects <-loopback> even without a bypass list.
              ...(this.preserveLoopbackBypass ? [`--proxy-server=${this.proxyUrl}`] : []),
              ...this.proxyTrafficArgs(),
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
      ...(this.proxyUrl && !this.preserveLoopbackBypass
        ? { proxy: { server: this.proxyUrl } }
        : {}),
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
    const untrackGuestProcess = this.trackBrowserProcess(
      typeof browserServer.process === "function" ? browserServer.process() : null,
    );
    let stopped: Promise<void> | undefined;
    const owner = {
      close: () => {
        stopped ??= browserServer.kill().finally(() => {
          untrackGuestProcess();
          signal?.removeEventListener("abort", abort);
        });
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
      // frozen "10_15_7" platform version and x86 on Apple Silicon. Read the
      // engine's own high-entropy values from a throwaway context instead of
      // deriving them, then override each Guest page with those.
      const nativeSystem = await (async () => {
        try {
          const probe = await browser.newContext();
          try {
            const page = await probe.newPage();
            return await page.evaluate(async () => {
              const data = (
                navigator as {
                  userAgentData?: {
                    getHighEntropyValues: (hints: readonly string[]) => Promise<{
                      architecture?: string;
                      bitness?: string;
                      platform?: string;
                      platformVersion?: string;
                    }>;
                  };
                }
              ).userAgentData;
              if (!data) return undefined;
              const high = await data.getHighEntropyValues([
                "architecture",
                "bitness",
                "platform",
                "platformVersion",
              ]);
              return {
                architecture: high.architecture ?? "",
                bitness: high.bitness ?? "",
                platform: high.platform ?? "",
                platformVersion: high.platformVersion ?? "",
              };
            });
          } finally {
            await probe.close();
          }
        } catch {
          return undefined;
        }
      })();
      const guestMetadata = reducedUserAgentMetadata(
        browser.version(),
        nativeSystem?.platform ||
          (process.platform === "win32"
            ? "Windows"
            : process.platform === "darwin"
              ? "macOS"
              : "Linux"),
        {
          architecture:
            nativeSystem?.architecture ||
            (process.arch === "arm64" ? "arm" : process.arch === "x64" ? "x86" : ""),
          bitness:
            nativeSystem?.bitness ||
            (process.arch === "arm64" || process.arch === "x64" ? "64" : ""),
          platformVersion: nativeSystem?.platformVersion ?? "",
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

  /** Exactly how a native profile's Chromium is launched; real-Chromium probes reuse it. */
  nativeLaunchOptions(
    directory: string,
    lifecycleExtensionDir: string,
    deadline: number,
    restoreLastSession = true,
  ): Parameters<typeof chromium.launchPersistentContext>[1] {
    return {
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
        // ignoreDefaultArgs drops Playwright's --disable-field-trial-config; without it
        // Chrome for Testing enables TrackEmptyRendererProcessesForReuse and holds closed
        // tab renderers alive past TabSleeper's settle window.
        "--disable-field-trial-config",
        // Load only Opensteer's minimal internal tab-lifecycle helper (zero host permissions)
        // for native profiles; every other extension stays disabled.
        `--disable-extensions-except=${lifecycleExtensionDir}`,
        `--load-extension=${lifecycleExtensionDir}`,
        "--disable-component-extensions-with-background-pages",
        "--disable-component-update",
        "--disable-background-networking",
        ...(restoreLastSession ? ["--restore-last-session"] : []),
        "--no-first-run",
        "--no-default-browser-check",
        `--disable-blink-features=${browserPageDisabledBlinkFeatures},AutomationControlled`,
        ...(this.headless ? ["--headless=new"] : []),
        ...(this.chromiumSandbox ? [] : ["--no-sandbox"]),
        ...(this.proxyUrl ? [`--proxy-server=${this.proxyUrl}`, ...this.proxyTrafficArgs()] : []),
      ],
      chromiumSandbox: this.chromiumSandbox,
      headless: this.headless,
      env: { ...this.childEnvironment },
      handleSIGHUP: false,
      handleSIGINT: false,
      handleSIGTERM: false,
      acceptDownloads: false,
      viewport: null,
    };
  }

  private async launchNative(
    directory: string,
    deadline: number,
    signal?: AbortSignal,
    requestedAuthenticator?: PasskeyAuthenticator,
    restoreLastSession = true,
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
    await initializeNativePreferences(directory, restoreLastSession);
    const lifecycleExtensionDir = await ensureTabLifecycleExtension(directory);
    timing("preferences");
    signal?.throwIfAborted();
    const context = await chromium.launchPersistentContext(
      directory,
      this.nativeLaunchOptions(directory, lifecycleExtensionDir, deadline, restoreLastSession),
    );
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
    const ownedPid = ownedProcess.pid;
    const exited = new Promise<void>((resolve) => {
      if (ownedProcess.exitCode !== null || ownedProcess.signalCode !== null) {
        resolve();
      } else {
        if (typeof ownedPid === "number" && Number.isSafeInteger(ownedPid) && ownedPid > 0) {
          this.ownedBrowserPids.add(ownedPid);
        }
        ownedProcess.once("exit", () => {
          if (typeof ownedPid === "number") this.ownedBrowserPids.delete(ownedPid);
          resolve();
        });
      }
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
    /** Set when this launch hands the directory straight to a relaunch (K4). */
    let keepDirectory = false;
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
            if (exitProven) {
              if (!keepDirectory) release();
            } else {
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
      // Keep one private blank target only while this bounded profile host is warm.
      // Without it, closing the last tab also discards Chromium's warm renderer.
      const helper = await context.newPage();
      timing("cookie-target");
      const browserCdp = await browser.newBrowserCDPSession();
      timing("cdp");
      const candidateLifecycle =
        typeof context.serviceWorkers === "function"
          ? new ChromiumTabLifecycleBridge(context, browserCdp, helper)
          : undefined;
      let lifecycle: ChromiumTabLifecycleBridge | undefined;
      const helperTargetId = candidateLifecycle
        ? await lookupTargetId(context, helper, deadline)
        : syncTargetIdOfPage(helper);
      const restoredRows: ChromiumTabEntry[] = [];
      const closeTarget = (targetId: string) =>
        withTimeout(browserCdp.send("Target.closeTarget", { targetId }), nameTargetMs, {
          timeoutError: () => new Error("Launch Target.closeTarget timed out."),
        }).then(() => undefined);
      const rows = candidateLifecycle
        ? await readRows(
            candidateLifecycle,
            restoreLastSession ? (performance.now() + deadline) / 2 : deadline,
          )
        : null;
      if (candidateLifecycle && !rows && restoreLastSession) {
        // K4: no read that agrees with itself, so no restored session. Chromium starts once more
        // without its last session, and the Home's tabs come back as fresh pages at their addresses.
        process.stderr.write(
          '{"event":"browser-runtime.tab-restore-skipped","reason":"inventory-unknown"}\n',
        );
        keepDirectory = true;
        await owner.close();
        return await this.launchNative(directory, deadline, signal, requestedAuthenticator, false);
      }
      if (candidateLifecycle && rows) {
        lifecycle = candidateLifecycle;
        const launchRows = rows.filter(
          (row) =>
            !(row.targetId !== null && row.targetId === helperTargetId) &&
            !isInternalExtensionUrl(row.url),
        );
        // A restored tab is the Home tab its own group title alone names, and nothing else is.
        const orphans: ChromiumTabEntry[] = [];
        for (const row of launchRows) (keptTitleOf(row, rows) ? restoredRows : orphans).push(row);
        reportRestoreLaunch(launchRows, restoredRows.length);
        // K6: an orphan not proven removed stays hidden (K3) and is reported, never assumed gone.
        const removeBy = Math.min(deadline, performance.now() + nameTargetMs);
        const removed = await Promise.all(
          orphans.map((orphan) => removeTabById(candidateLifecycle, orphan, removeBy, closeTarget)),
        );
        for (const outcome of removed) if (outcome === "unknown") reportUnconfirmedRemoval(1);
      } else if (candidateLifecycle) {
        // Fail closed when no read is known even without a last session: no tab survives launch.
        process.stderr.write(
          '{"event":"browser-runtime.tab-lifecycle-unavailable","stage":"launch-inventory"}\n',
        );
        let confirmedClean = false;
        for (let attempt = 0; attempt < 3 && !confirmedClean; attempt++) {
          const targets = (await withTimeout(browserCdp.send("Target.getTargets"), nameTargetMs, {
            timeoutError: () => new Error("Launch Target.getTargets timed out."),
          }).catch(() => null)) as {
            targetInfos?: readonly { targetId?: unknown; type?: unknown }[];
          } | null;
          if (!targets) break;
          const survivors = (targets.targetInfos ?? []).filter(
            (info): info is { targetId: string; type: string } =>
              info.type === "page" &&
              typeof info.targetId === "string" &&
              info.targetId !== helperTargetId,
          );
          confirmedClean = survivors.length === 0;
          for (const info of survivors) await closeTarget(info.targetId).catch(() => undefined);
          if (!confirmedClean) await delay(40);
        }
        if (!confirmedClean)
          throw new Error("Chromium restored unauthorized tabs that could not be removed.");
      }
      // Snapshot every non-helper page present after inventory (including any restored
      // tabs Chromium finished initializing during launch) so none leak before claiming.
      const preHelperPages = new Set(context.pages().filter((page) => page !== helper));
      const launched = new PlaywrightLaunchedBrowser(
        owner,
        context,
        browserCdp,
        undefined,
        openDialogs,
        authenticator,
        providerConfig,
        helper,
        true,
        lifecycle,
        restoredRows,
        preHelperPages,
        helperTargetId ?? undefined,
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
    dedicatedContext = false,
    lifecycle?: ChromiumTabLifecycleBridge,
    restoredRows: readonly ChromiumTabEntry[] = [],
    preHelperPages: ReadonlySet<Page> = new Set(),
    privatePageTargetId?: string,
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
      lifecycle,
      restoredRows,
      preHelperPages,
      dedicatedContext,
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
    this.contextHandle.closeTarget = async (targetId) => {
      await withTimeout(browserCdp.send("Target.closeTarget", { targetId }), nameTargetMs, {
        timeoutError: () => new Error("Target.closeTarget timed out."),
      });
    };
    this.contextHandle.browserAlive = () =>
      withTimeout(browserCdp.send("Browser.getVersion"), nameTargetMs, {
        timeoutError: () => new Error("The browser did not answer."),
      }).then(
        () => true,
        () => false,
      );
    this.cdp = new PlaywrightBrowserCdpBackend(
      browserCdp,
      this.contextHandle,
      browserContextId,
      dedicatedContext,
      privatePageTargetId,
    );
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
    // Tabs still being named finish first, so Chromium's own session carries their names.
    await this.contextHandle.settleNaming();
    this.contextHandle.markClosed();
    const detached = await Promise.allSettled([
      withTimeout((this.cdp as PlaywrightBrowserCdpBackend).close(), 500, {
        timeoutError: () => new Error("Browser CDP detach did not finish."),
      }),
    ]);
    const stopped = await Promise.allSettled([this.owner.close()]);
    const results = [...detached, ...stopped];
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(failures, "Browser close did not complete cleanly.");
  }
}

/** A raw target is looked up briefly; the router reports a miss rather than waiting on it. */
const targetLookupMs = 5_000;
/** One debugger round trip to a page or browser that may be dying. */
const nameTargetMs = 2_000;

/** Opaque restore token for a Chromium tab discarded by `chrome.tabs.discard`. */
const chromiumDiscardRestoreSchema = z.object({
  kind: z.literal("chromium-discard"),
  tokenId: z.string().min(1),
  url: z.string(),
});

type ChromiumDiscardRestore = z.infer<typeof chromiumDiscardRestoreSchema>;

function parseChromiumDiscardRestore(value: unknown): ChromiumDiscardRestore | null {
  const parsed = chromiumDiscardRestoreSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** One bound for a claim or a wake: its queue wait, the activation and the arrival together. */
const wakeDiscardedTabMs = 10_000;
/** How long a park waits for the page of a tab Chromium is loading, before freezing it. */
const parkPageWaitMs = 1_000;
/** How long a page with no provenance is classified, once no open of ours can be its creator. */
const arrivalIdentifyMs = 2_000;
/** How long the runtime's own new page may take; a page with no opener waits inside it (K3). */
const openPageMs = 10_000;
/** How long an orderly close waits for tabs still being named. */
const namingSettleMs = 1_500;
/** Attempts per name, removing it in the background or naming a saved tab, before giving up. */
const removalRetryBound = 8;
/** The group title a tab that is not a saved Home tab carries while it sleeps. */
const sleepTitlePrefix = "opensteer-sleep:";

const remainingMs = (deadline: number) => Math.max(1, deadline - performance.now());

/**
 * Reads a Playwright Chromium page's CDP targetId synchronously from its
 * in-process CRPage delegate, avoiding async CDP round trips inside `handOff`.
 */
function syncTargetIdOfPage(page: Page): string | null {
  try {
    const impl = (
      page as unknown as {
        _connection?: {
          toImpl?: (
            obj: unknown,
          ) =>
            { delegate?: { _targetId?: unknown }; _delegate?: { _targetId?: unknown } } | undefined;
        };
      }
    )._connection?.toImpl?.(page);
    const candidate = impl?.delegate?._targetId ?? impl?._delegate?._targetId;
    return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
  } catch {
    return null;
  }
}

function syncOpenerOfPage(page: Page): Page | null {
  const opener = (page as unknown as { _opener?: Page | null })._opener;
  return opener && !opener.isClosed() ? opener : null;
}

/** A page's target, in memory or through one debugger round trip, inside `deadline`. */
async function lookupTargetId(
  context: PlaywrightBrowserContext,
  page: Page,
  deadline: number,
): Promise<string | null> {
  const synced = syncTargetIdOfPage(page);
  if (synced || page.isClosed()) return synced;
  let session: PlaywrightCdpSession | undefined;
  try {
    session = await withTimeout(context.newCDPSession(page), remainingMs(deadline), {
      timeoutError: () => new Error("Target lookup CDP attach timed out."),
    });
    const response = (await withTimeout(
      session.send("Target.getTargetInfo"),
      remainingMs(deadline),
      {
        timeoutError: () => new Error("Target lookup getTargetInfo timed out."),
      },
    )) as { targetInfo?: { targetId?: unknown } };
    return typeof response.targetInfo?.targetId === "string" ? response.targetInfo.targetId : null;
  } catch {
    return null;
  } finally {
    if (session)
      void withTimeout(session.detach(), nameTargetMs, {
        timeoutError: () => new Error("Target lookup detach timed out."),
      }).catch(() => undefined);
  }
}

/** A name the runtime writes and keeps (K10): a Home surface id within the bound, never a sleep name. */
function isHomeTabName(title: string): boolean {
  return (
    title.length <= tabNameBound &&
    !title.startsWith(sleepTitlePrefix) &&
    BrowserSurfaceIdSchema.safeParse(title).success
  );
}

type Named =
  | { readonly kind: "none" }
  | { readonly kind: "one"; readonly row: ChromiumTabEntry }
  | { readonly kind: "many" };

/** K2: the one lookup of a name, in a read that agrees with itself. `many` is never a match. */
function findNamed(rows: readonly ChromiumTabEntry[], name: string): Named {
  let found: ChromiumTabEntry | undefined;
  for (const row of rows) {
    if (row.identity !== name) continue;
    if (found) return { kind: "many" };
    found = row;
  }
  return found ? { kind: "one", row: found } : { kind: "none" };
}

/**
 * K3's classifier, the same for a launch row and for any page that arrives later: the Home name
 * the row's tab alone carries, or null (the tab is nobody's).
 */
function keptTitleOf(row: ChromiumTabEntry, rows: readonly ChromiumTabEntry[]): string | null {
  const title = row.identity;
  if (!title || isBlankAddress(row.url) || !isHomeTabName(title)) return null;
  return findNamed(rows, title).kind === "one" ? title : null;
}

/** K1: one read that agrees with itself inside `deadline`, or null: not known. */
function readRows(
  lifecycle: ChromiumTabLifecycleBridge,
  deadline: number,
): Promise<readonly ChromiumTabEntry[] | null> {
  return withTimeout(lifecycle.inventory(deadline), remainingMs(deadline), {
    timeoutError: () => new Error("Tab inventory timed out."),
  }).catch(() => null);
}

/**
 * K6 for a tab no name identifies: `removed` only when the remove resolved and a read that agrees
 * with itself has no row with that tab id. A missing id alone proves nothing.
 */
async function removeTabById(
  lifecycle: ChromiumTabLifecycleBridge,
  row: ChromiumTabEntry,
  deadline: number,
  closeTarget: ((targetId: string) => Promise<void>) | undefined,
): Promise<"removed" | "unknown"> {
  let asked = false;
  for (;;) {
    let resolved = await lifecycle.removeByTabId(row.tabId).catch(() => false);
    if (!resolved && row.targetId && closeTarget)
      resolved = await closeTarget(row.targetId).then(
        () => true,
        () => false,
      );
    asked ||= resolved;
    if (asked) {
      const rows = await readRows(lifecycle, deadline);
      if (rows && !rows.some((entry) => entry.tabId === row.tabId)) return "removed";
    }
    if (performance.now() + 40 >= deadline) return "unknown";
    await delay(40);
  }
}

/**
 * One line per native launch: what Chromium restored and what its group titles said. Every
 * restored tab is a Home tab by its own title or is closed, so this tells a lost restore apart:
 * Chromium restored nothing, or tabs came back without a title, with a title no Home tab id has,
 * or with a title two tabs carry.
 */
function reportRestoreLaunch(rows: readonly ChromiumTabEntry[], named: number): void {
  let untitled = 0;
  let unknownTitle = 0;
  let duplicateTitle = 0;
  for (const row of rows) {
    if (!row.identity) untitled++;
    else if (findNamed(rows, row.identity).kind === "many") duplicateTitle++;
    else if (!isHomeTabName(row.identity)) unknownTitle++;
  }
  process.stderr.write(
    `${JSON.stringify({
      event: "browser-runtime.tab-restore-launch",
      restored: rows.length,
      named,
      untitled,
      unknownTitle,
      duplicateTitle,
    })}\n`,
  );
}

function reportUnconfirmedRemoval(attempts: number): void {
  process.stderr.write(
    `${JSON.stringify({ event: "browser-runtime.tab-removal-unconfirmed", attempts })}\n`,
  );
}

function isBlankAddress(url: string): boolean {
  return url === "" || url === "about:blank" || url === "chrome://newtab/";
}

/** A Home tab Chromium restored with its group title, not yet claimed by a session. */
interface RestoredTab {
  /** Its page, once Chromium loaded it; hidden until a claim takes it. */
  page: Page | undefined;
}

/** A tab put to sleep by discard; it is found again by its group title, never by its id. */
interface SleepingTab {
  readonly title: string;
  readonly url: string;
  readonly surfaceId?: BrowserSurfaceId;
  /** Resolves when the discard (or the close it fell back to) has finished. */
  readonly settled: Promise<void>;
}

/** A wake waiting for its tab's page: it takes only the one tab carrying its name (K2). */
interface ArmedWake {
  readonly title: string;
  arrive(page: Page, row: ChromiumTabEntry): void;
  giveUp(): void;
}

/**
 * Chromium carries each saved Home tab's identity itself: the helper puts the tab in its own tab
 * group whose title is the tab's Home surface id. The title survives discard and session restore
 * after a clean exit or a crash, and no page can read or change it. A page is published only with
 * positive provenance (K3): the runtime's own new page, a page its published opener opened, or the
 * tab a claim or wake took by its name. Every other page is classified by its tab's name like a
 * launch row: a kept Home name waits hidden for its claim, anything else is closed with evidence.
 */
class PlaywrightContextHandle implements BrowserContext {
  private closed = false;
  isConnected(): boolean {
    return !this.closed && this.context.browser()?.isConnected() === true;
  }
  private readonly context: PlaywrightBrowserContext;
  private readonly openDialogs: Map<Page, Dialog>;
  private readonly pagesByPlaywrightPage = new Map<Page, PlaywrightPageHandle>();
  private readonly pageListeners = new Set<(page: BrowserPage) => void>();
  private readonly handOffs = new Set<(page: BrowserPage, opener: BrowserPage | null) => void>();
  /** Closes one page target through the browser's own debugger, around Playwright. */
  closeTarget: ((targetId: string) => Promise<void>) | undefined;
  /** Whether the browser behind this context still answers its own debugger. */
  browserAlive: (() => Promise<boolean>) | undefined;
  beforeCreatePage: (() => Promise<void>) | undefined;

  readonly authenticator: PasskeyAuthenticator | undefined;
  readonly providerConfig: BrowserPagePolicyConfig;
  readonly lifecycle: ChromiumTabLifecycleBridge | undefined;
  readonly sessionRestore: BrowserSessionRestore | undefined;
  /** A native profile's context: K3 holds for every page, and no root is taken from `pages()`. */
  readonly nativeProfile: boolean;
  private readonly privatePage: Page | undefined;

  /** Restored Home tabs nobody has claimed, by the surface id their group title names. */
  private readonly restored = new Map<BrowserSurfaceId, RestoredTab>();
  /** The Home's saved tabs once it named them (reconcile); until then any Home name is kept. */
  private keepList: ReadonlySet<BrowserSurfaceId> | null = null;
  /** Names being claimed right now: a page carrying one waits, hidden, for its claim. */
  private readonly claimingTitles = new Set<string>();
  private readonly sleepingByToken = new Map<string, SleepingTab>();
  private readonly sleepingTitles = new Map<string, string>();
  /** Names given up and being removed from Chromium, with their background attempts. */
  private readonly removals = new Map<string, { attempts: number }>();
  /** Names whose removal could not be confirmed within the bound; still never handed off. */
  private readonly unremovable = new Set<string>();
  private removalTimer: ReturnType<typeof setTimeout> | undefined;
  private removalDrain: Promise<void> | null = null;
  /** Saved tabs whose naming waits for another tab still carrying the same name to go. */
  private readonly deferredNames = new Map<BrowserSurfaceId, PlaywrightPageHandle>();
  private readonly naming = new Set<Promise<void>>();
  /** Saved pages waiting for their first real navigation before they are named. */
  private readonly awaitingFirstNavigation = new Map<Page, { done(): void }>();
  private readonly savedSurfaceByPage = new WeakMap<PlaywrightPageHandle, BrowserSurfaceId>();
  /** The page each saved surface is bound to now; a live binding is never a restored tab. */
  private readonly boundPages = new Map<BrowserSurfaceId, PlaywrightPageHandle>();
  private readonly unnameable = new Set<BrowserSurfaceId>();
  private readonly published = new WeakSet<Page>();
  private readonly hiddenPages = new WeakSet<Page>();
  /** Pages being closed: never published, whatever answers later. */
  private readonly ending = new WeakSet<Page>();
  private readonly frozenPages = new WeakSet<Page>();
  private readonly identifyingPages = new WeakSet<Page>();
  /** The name a hidden page was last seen with, so its name's removal closes it first. */
  private readonly pageTitles = new WeakMap<Page, string>();
  /** `newPage` calls in flight; a page they create is published by their answer. */
  private readonly openingPages = new Set<Promise<Page>>();
  /** One lane per name, and so per page: naming, sleep, release, parking and removal. */
  private readonly laneTails = new Map<string, Promise<void>>();
  private parkingArmed = false;
  private parkedActive = 0;
  private readonly parkedWaiters: Array<() => void> = [];
  private reconcileTail: Promise<void> = Promise.resolve();
  private reconcileAbort: AbortController | undefined;
  private reconcileFallbackTimer: ReturnType<typeof setTimeout> | undefined;
  private wakeTail: Promise<void> = Promise.resolve();
  private activeWake: ArmedWake | null = null;

  constructor(
    context: PlaywrightBrowserContext,
    openDialogs: Map<Page, Dialog>,
    authenticator?: PasskeyAuthenticator,
    providerConfig?: BrowserPagePolicyConfig,
    privatePage?: Page,
    lifecycle?: ChromiumTabLifecycleBridge,
    restoredRows: readonly ChromiumTabEntry[] = [],
    preHelperPages: ReadonlySet<Page> = new Set(),
    nativeProfile = false,
  ) {
    this.privatePage = privatePage;
    this.lifecycle = lifecycle;
    this.authenticator = authenticator;
    this.providerConfig = providerConfig;
    this.context = context;
    this.openDialogs = openDialogs;
    this.nativeProfile = nativeProfile;
    const restoredByTarget = new Map<string, BrowserSurfaceId>();
    for (const row of restoredRows) {
      const surfaceId = row.identity as BrowserSurfaceId;
      this.restored.set(surfaceId, { page: undefined });
      if (row.targetId) restoredByTarget.set(row.targetId, surfaceId);
    }
    if (!nativeProfile)
      for (const page of context.pages()) if (!this.isHiddenPage(page)) this.published.add(page);
    for (const page of preHelperPages) {
      const targetId = syncTargetIdOfPage(page);
      const surfaceId = targetId ? restoredByTarget.get(targetId) : undefined;
      if (surfaceId && page !== privatePage) {
        this.hiddenPages.add(page);
        this.pageTitles.set(page, surfaceId);
        this.restored.get(surfaceId)!.page = page;
      } else this.arrive(page);
    }
    if (lifecycle) {
      this.sessionRestore = {
        claim: (surfaceId, _url, own, signal) => this.claimRestored(surfaceId, own, signal),
        reconcile: (savedTabIds) => this.reconcileSavedTabs(savedTabIds),
        armFallbackReconcile: (keepIds, delayMs = 5_000) =>
          this.armFallbackReconcile(keepIds, delayMs),
        trackSavedTab: (surfaceId, page) => this.trackSavedTab(surfaceId, page),
        flush: () => this.settleNaming(),
      };
    }
    context.on("close", () => {
      this.markClosed();
      // A context's end ends its pages even when Playwright reports no page close.
      for (const handle of this.pagesByPlaywrightPage.values()) handle.confirmGone("context");
    });
    context.on("page", (page) => this.arrive(page));
  }

  /** K3: published with provenance (b) at once; with none, hidden and classified by its name. */
  private arrive(page: Page): void {
    if (this.isHiddenPage(page) || this.published.has(page) || this.ending.has(page)) return;
    const opener = syncOpenerOfPage(page);
    if (opener && (this.published.has(opener) || !this.nativeProfile)) {
      const handle = this.wrap(page);
      handle.openerHandle ??= this.wrap(opener);
      this.publish(page, true);
      return;
    }
    if (opener) {
      // A tab opened by a page nobody holds (restored, sleeping or unknown) is nobody's.
      void this.closePageWithEvidence(page);
      return;
    }
    if (!this.nativeProfile) {
      // A fresh context restores nothing: every page in it is its sessions' own.
      const handle = this.wrap(page);
      this.published.add(page);
      queueMicrotask(() => {
        if (!page.isClosed()) for (const listener of this.handOffs) listener(handle, null);
      });
      for (const listener of this.pageListeners) listener(handle);
      return;
    }
    this.hiddenPages.add(page);
    this.identifyingPages.add(page);
    void this.classify(page).catch(() => undefined);
  }

  /** The one publication of a page with provenance; a page being closed is never published. */
  private publish(page: Page, announce: boolean): boolean {
    if (this.closed || page.isClosed() || this.ending.has(page)) return false;
    this.identifyingPages.delete(page);
    this.hiddenPages.delete(page);
    if (this.published.has(page)) return true;
    this.published.add(page);
    if (!announce) return true;
    const handle = this.wrap(page);
    for (const listener of this.handOffs) listener(handle, handle.openerHandle);
    for (const listener of this.pageListeners) listener(handle);
    return true;
  }

  private isHiddenPage(page: Page): boolean {
    if (page === this.privatePage) return true;
    const url = typeof page.url === "function" ? page.url() : "";
    return isInternalExtensionUrl(url);
  }

  private isVisible(page: Page): boolean {
    return this.published.has(page) && !this.isHiddenPage(page);
  }

  /**
   * K3 for a page with no provenance. One the runtime's own open may have made waits for that
   * open to settle, inside that open's deadline, and is published if it is its answer. Otherwise
   * its tab's row in a read that agrees with itself decides; past the bound it is closed.
   */
  private async classify(page: Page): Promise<void> {
    const taken = () => this.closed || page.isClosed() || !this.identifyingPages.has(page);
    if (this.openingPages.size > 0) await Promise.allSettled(this.openingPages);
    const deadline = performance.now() + arrivalIdentifyMs;
    for (let attempt = 0; ; attempt++) {
      if (taken()) return;
      const targetId = await lookupTargetId(this.context, page, deadline);
      const rows = targetId && !taken() ? await this.read(deadline) : null;
      if (taken()) return;
      const row = rows?.find((entry) => entry.targetId === targetId);
      if (rows && row) return this.place(page, row, rows);
      if (performance.now() + 25 >= deadline) break;
      await delay(Math.min(100 * (attempt + 1), remainingMs(deadline)));
    }
    if (taken()) return;
    if (await this.closePageWithEvidence(page))
      process.stderr.write('{"event":"browser-runtime.unidentified-page-closed"}\n');
  }

  /** The classifier's answer for a page whose tab's row is known. */
  private place(page: Page, row: ChromiumTabEntry, rows: readonly ChromiumTabEntry[]): void {
    this.identifyingPages.delete(page);
    const title = row.identity ?? null;
    if (title !== null) this.pageTitles.set(page, title);
    const one = title !== null && findNamed(rows, title).kind === "one";
    const wake = this.activeWake;
    if (wake && title === wake.title) {
      // K2: the wake takes only the one tab carrying its name; otherwise it gives up and the page
      // stays hidden until its name's removal closes it.
      if (one) wake.arrive(page, row);
      else wake.giveUp();
      return;
    }
    if (one && title !== null && !this.removals.has(title) && !this.unremovable.has(title)) {
      if (this.claimingTitles.has(title)) return;
      if (this.sleepingTitles.has(title)) {
        // A sleeping tab Chromium loaded by itself goes back to sleep, unseen. A discarded tab's own
        // placeholder page is left alone: discarding it again would rewrite its saved entry.
        if (!row.discarded && row.status !== "unloaded")
          void this.onLane(title, () => this.lifecycle!.discardByTabId(row.tabId)).catch(
            () => undefined,
          );
        return;
      }
      const surfaceId = title as BrowserSurfaceId;
      let entry = this.restored.get(surfaceId);
      if (!entry && keptTitleOf(row, rows) && this.isKept(surfaceId)) {
        entry = { page: undefined };
        this.restored.set(surfaceId, entry);
      }
      if (entry) {
        entry.page = page;
        if (this.parkingArmed)
          void this.parkRestored(surfaceId, entry, { waitForLoad: true }).catch(() => undefined);
        return;
      }
    }
    void this.closePageWithEvidence(page);
  }

  /** In the keep list (any Home name before the Home said it), and bound to no live page. */
  private isKept(surfaceId: BrowserSurfaceId): boolean {
    const bound = this.boundPages.get(surfaceId);
    return (this.keepList?.has(surfaceId) ?? true) && (!bound || bound.isClosed());
  }

  private isGuardedName(title: string): boolean {
    return (
      this.restored.has(title as BrowserSurfaceId) ||
      this.claimingTitles.has(title) ||
      this.sleepingTitles.has(title) ||
      this.removals.has(title) ||
      this.unremovable.has(title)
    );
  }

  /**
   * The one bounded close with evidence: Playwright's close, then the target's own close. The page
   * is unpublished at once and stays hidden whether or not the close is confirmed.
   */
  private async closePageWithEvidence(
    page: Page,
    deadline = performance.now() + 2 * nameTargetMs,
  ): Promise<boolean> {
    this.ending.add(page);
    this.published.delete(page);
    this.hiddenPages.add(page);
    this.identifyingPages.delete(page);
    if (!page.isClosed())
      await withTimeout(page.close({ runBeforeUnload: false }), remainingMs(deadline) / 2, {
        timeoutError: () => new Error("Page close timed out."),
      }).catch(() => undefined);
    const targetId = page.isClosed() ? null : syncTargetIdOfPage(page);
    if (targetId && this.closeTarget)
      await withTimeout(this.closeTarget(targetId), remainingMs(deadline), {
        timeoutError: () => new Error("Target close timed out."),
      }).catch(() => undefined);
    if (page.isClosed()) return true;
    process.stderr.write('{"event":"browser-runtime.page-close-unconfirmed"}\n');
    return false;
  }

  /** K1: one read that agrees with itself inside `deadline`, or null. */
  private read(deadline: number): Promise<readonly ChromiumTabEntry[] | null> {
    if (!this.lifecycle || this.closed) return Promise.resolve(null);
    return readRows(this.lifecycle, deadline);
  }

  /** Runs `fn` after every earlier task on the same name; tasks on one name never overlap. */
  private onLane<T>(title: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.laneTails.get(title) ?? Promise.resolve();
    const run = previous.then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.laneTails.set(title, tail);
    void tail.then(() => {
      if (this.laneTails.get(title) === tail) this.laneTails.delete(title);
    });
    return run;
  }

  /**
   * K6, on the name's lane: the tab carrying `title` is removed only when a read that agrees with
   * itself finds no tab carrying it, within `attempts`. Its hidden pages close first; `many` is not
   * removed by name.
   */
  private async removeNamed(title: string, attempts: number): Promise<boolean> {
    const lifecycle = this.lifecycle;
    if (!lifecycle) return false;
    const deadline = performance.now() + attempts * nameTargetMs;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (this.closed) return false;
      for (const page of this.context.pages())
        if (!this.published.has(page) && this.pageTitles.get(page) === title)
          await this.closePageWithEvidence(page, deadline);
      const rows = await this.read(deadline);
      if (this.closed) return false;
      const named = rows ? findNamed(rows, title) : null;
      if (named?.kind === "none") return true;
      if (named?.kind === "one") {
        const { row } = named;
        const asked = await lifecycle.removeByTabId(row.tabId).catch(() => false);
        if (!asked && row.targetId && this.closeTarget)
          await this.closeTarget(row.targetId).catch(() => undefined);
        const after = await this.read(deadline);
        if (after && findNamed(after, title).kind === "none") return true;
      }
      if (attempt < attempts - 1) await delay(40);
    }
    return false;
  }

  /** Gives `title` up: guarded at once, removed in the background until proven, or reported. */
  private giveUpName(title: string): void {
    if (this.closed || this.removals.has(title) || this.unremovable.has(title)) return;
    this.removals.set(title, { attempts: 0 });
    this.scheduleRemovalDrain(0);
  }

  private scheduleRemovalDrain(delayMs?: number): void {
    if (this.closed || this.removalTimer || this.removalDrain || this.removals.size === 0) return;
    let attempts = 0;
    for (const tracker of this.removals.values()) attempts = Math.max(attempts, tracker.attempts);
    this.removalTimer = setTimeout(
      () => {
        this.removalTimer = undefined;
        // One drain at a time: a give-up while it runs is picked up by its next pass.
        this.removalDrain = this.drainRemovals().finally(() => {
          this.removalDrain = null;
          this.scheduleRemovalDrain();
        });
      },
      delayMs ?? Math.min(2_000, 100 * 2 ** Math.min(attempts, 4)),
    );
    this.removalTimer.unref?.();
  }

  private async drainRemovals(): Promise<void> {
    for (const [title, tracker] of Array.from(this.removals)) {
      if (this.closed) return;
      await this.onLane(title, async () => {
        if (this.removals.get(title) !== tracker) return;
        tracker.attempts++;
        if (await this.removeNamed(title, 1)) {
          this.removals.delete(title);
          this.retryDeferredName(title);
        } else if (tracker.attempts >= removalRetryBound) {
          // Rule A: recorded as not removed, never retried silently forever; still guarded.
          this.removals.delete(title);
          this.unremovable.add(title);
          reportUnconfirmedRemoval(tracker.attempts);
        }
      });
    }
  }

  /**
   * Takes a restored tab from every claim at once and removes it on its lane; its page stays
   * hidden and its name guarded until its removal is proven.
   */
  private evictRestored(surfaceId: BrowserSurfaceId): Promise<boolean> {
    const entry = this.restored.get(surfaceId);
    this.restored.delete(surfaceId);
    if (entry?.page) this.pageTitles.set(entry.page, surfaceId);
    this.removals.set(surfaceId, this.removals.get(surfaceId) ?? { attempts: 0 });
    return this.onLane(surfaceId, async () => {
      if (this.closed) return false;
      if (entry?.page) await this.closePageWithEvidence(entry.page);
      const removed = await this.removeNamed(surfaceId, 3);
      if (removed) {
        this.removals.delete(surfaceId);
        this.retryDeferredName(surfaceId);
      } else this.scheduleRemovalDrain();
      return removed;
    });
  }

  private armFallbackReconcile(keepIds: ReadonlySet<BrowserSurfaceId>, delayMs: number): void {
    if (this.closed || this.restored.size === 0) return;
    if (this.reconcileFallbackTimer) clearTimeout(this.reconcileFallbackTimer);
    this.reconcileFallbackTimer = setTimeout(() => {
      this.reconcileFallbackTimer = undefined;
      if (this.closed) return;
      void this.reconcileSavedTabs(keepIds).catch(() => undefined);
    }, delayMs);
    this.reconcileFallbackTimer.unref?.();
  }

  private reconcileSavedTabs(savedTabIds: ReadonlySet<BrowserSurfaceId>): Promise<void> {
    if (this.reconcileFallbackTimer) {
      clearTimeout(this.reconcileFallbackTimer);
      this.reconcileFallbackTimer = undefined;
    }
    this.reconcileAbort?.abort();
    const abort = new AbortController();
    this.reconcileAbort = abort;
    const work = this.reconcileTail.then(() =>
      this.reconcileSavedTabsOnce(savedTabIds, abort.signal),
    );
    this.reconcileTail = work.then(
      () => undefined,
      () => undefined,
    );
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Deadline passed (Rule B): the body is fenced and every restored tab nobody is claiming
        // is given up, so the session goes on opening tabs by address.
        abort.abort();
        for (const surfaceId of Array.from(this.restored.keys())) {
          if (!this.claimingTitles.has(surfaceId))
            void this.evictRestored(surfaceId).catch(() => undefined);
        }
        this.parkingArmed = true;
        resolve();
      }, 6_000);
      timer.unref?.();
      work.then(
        () => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve();
          }
        },
        (error: unknown) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(error);
          }
        },
      );
    });
  }

  /**
   * Closes every restored tab whose name is outside `savedTabIds` and that no session is
   * claiming, then parks the rest: a loaded one is discarded so no unowned page runs, a
   * never-loaded one is left untouched so its `sessionStorage` survives.
   */
  private async reconcileSavedTabsOnce(
    savedTabIds: ReadonlySet<BrowserSurfaceId>,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.lifecycle || signal.aborted || this.closed) return;
    this.keepList = savedTabIds;
    // Removals finish (or are left guarded, K6) before the caller goes on; none is assumed done.
    await Promise.all(
      Array.from(this.restored.keys())
        .filter((surfaceId) => !savedTabIds.has(surfaceId) && !this.claimingTitles.has(surfaceId))
        .map((surfaceId) => this.evictRestored(surfaceId).catch(() => false)),
    );
    const rows =
      this.restored.size > 0 ? await this.read(performance.now() + 2 * nameTargetMs) : [];
    if (signal.aborted || this.closed) return;
    this.parkingArmed = true;
    for (const [surfaceId, entry] of Array.from(this.restored)) {
      if (this.claimingTitles.has(surfaceId)) continue;
      // Not known is never "absent" (Rule A): the tab is given up.
      if (!rows) {
        void this.evictRestored(surfaceId).catch(() => undefined);
        continue;
      }
      const named = findNamed(rows, surfaceId);
      if (
        named.kind === "one" &&
        (named.row.discarded || (named.row.status === "unloaded" && !entry.page))
      )
        continue;
      // Off the path to ready: parking a loaded tab waits for a discard slot.
      void this.parkRestored(surfaceId, entry, { waitForLoad: false }).catch(() => undefined);
    }
  }

  private async withParkingSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.parkedActive >= 4 && !this.closed) {
      await new Promise<void>((resolve) => this.parkedWaiters.push(resolve));
    }
    this.parkedActive++;
    try {
      return await fn();
    } finally {
      this.parkedActive--;
      this.parkedWaiters.shift()?.();
    }
  }

  /**
   * Discards a restored tab Chromium has loaded before any session claimed it. Runs on the tab's
   * lane and acts only while the entry it was given is still the tab's unclaimed entry.
   */
  private parkRestored(
    surfaceId: BrowserSurfaceId,
    entry: RestoredTab,
    options: { readonly waitForLoad: boolean },
  ): Promise<void> {
    const current = () =>
      !this.closed &&
      this.lifecycle !== undefined &&
      this.restored.get(surfaceId) === entry &&
      !this.claimingTitles.has(surfaceId);
    if (!current()) return Promise.resolve();
    return this.onLane(surfaceId, () =>
      this.withParkingSlot(() => this.parkOnLane(surfaceId, entry, options, current)),
    );
  }

  private async parkOnLane(
    surfaceId: BrowserSurfaceId,
    entry: RestoredTab,
    options: { readonly waitForLoad: boolean },
    current: () => boolean,
  ): Promise<void> {
    if (!current()) return;
    const deadline = performance.now() + 2 * nameTargetMs;
    const rows = await this.read(deadline);
    if (!current()) return;
    const named = rows ? findNamed(rows, surfaceId) : null;
    if (named?.kind === "none") {
      // K6: a read that agrees with itself and no tab carries the name, on its lane: removed.
      this.restored.delete(surfaceId);
      return;
    }
    if (named?.kind !== "one") {
      // Not known, or not one tab: given up.
      void this.evictRestored(surfaceId);
      return;
    }
    const { row } = named;
    if (row.discarded) return;
    // The tab's page, as cached or as the target its named row names: frozen before the discard,
    // or its page state (scroll, form fields) would not reach Chromium's own record.
    const findPage = () =>
      entry.page && !entry.page.isClosed()
        ? entry.page
        : this.context
            .pages()
            .find(
              (candidate) =>
                !candidate.isClosed() &&
                !this.published.has(candidate) &&
                row.targetId !== null &&
                syncTargetIdOfPage(candidate) === row.targetId,
            );
    let page = findPage();
    // A tab Chromium is loading may not have its page yet: wait for it briefly, since a discard
    // mid-load without a freeze would save a half-restored state over the tab's own.
    const pageDeadline = performance.now() + parkPageWaitMs;
    while (
      !page &&
      row.targetId &&
      row.status !== "unloaded" &&
      performance.now() < pageDeadline &&
      current()
    ) {
      await delay(25);
      page = findPage();
    }
    if (page && page !== entry.page) {
      this.hiddenPages.add(page);
      this.pageTitles.set(page, surfaceId);
      entry.page = page;
    }
    if (page && (options.waitForLoad || row.status !== "complete")) {
      // Let Chromium finish restoring page state before it is frozen and discarded.
      await page.waitForLoadState("load", { timeout: 1_000 }).catch(() => undefined);
    }
    if (!current()) return;
    if (row.active) await this.activatePrivateAnchor();
    const frozen = page && !page.isClosed() ? await this.freezeBeforeDiscard(page) : undefined;
    if (!current()) {
      // Claimed, given up or removed meanwhile: what this run froze it unfreezes.
      if (frozen && !this.closed) await this.unfreezeRestoredPage(frozen);
      return;
    }
    await this.lifecycle!.discardByTabId(row.tabId).catch(() => null);
    if (!current()) return;
    const after = await this.read(performance.now() + 2 * nameTargetMs);
    if (!current()) return;
    const afterNamed = after ? findNamed(after, surfaceId) : null;
    if (afterNamed?.kind === "one" && afterNamed.row.discarded) {
      if (entry.page?.isClosed()) entry.page = undefined;
      return;
    }
    if (afterNamed?.kind === "none") {
      this.restored.delete(surfaceId);
      return;
    }
    // Still loaded, ambiguous or not known: given up, so it opens by address when claimed.
    void this.evictRestored(surfaceId);
  }

  /**
   * Flushes Blink's page state (scroll, form controls) into Chromium's navigation entry before a
   * discard. The page is marked before the request, so even a freeze that timed out is undone.
   */
  private async freezeBeforeDiscard(page: Page): Promise<Page | undefined> {
    this.frozenPages.add(page);
    let session: PlaywrightCdpSession | undefined;
    try {
      session = await withTimeout(this.context.newCDPSession(page), 1_000, {
        timeoutError: () => new Error("Freeze CDP attach timed out."),
      });
      await withTimeout(session.send("Page.setWebLifecycleState", { state: "frozen" }), 1_000, {
        timeoutError: () => new Error("Freeze timed out."),
      });
    } catch {
      // Best-effort flush; the discard still proceeds so no unowned page stays live.
    } finally {
      if (session)
        await withTimeout(session.detach(), 500, {
          timeoutError: () => new Error("Freeze detach timed out."),
        }).catch(() => undefined);
    }
    return page;
  }

  private async unfreezeRestoredPage(page: Page): Promise<boolean> {
    if (page.isClosed()) {
      this.frozenPages.delete(page);
      return false;
    }
    let session: PlaywrightCdpSession | undefined;
    try {
      session = await withTimeout(this.context.newCDPSession(page), 1_000, {
        timeoutError: () => new Error("Unfreeze CDP attach timed out."),
      });
      await withTimeout(session.send("Page.setWebLifecycleState", { state: "active" }), 1_000, {
        timeoutError: () => new Error("Unfreeze timed out."),
      });
      this.frozenPages.delete(page);
      return true;
    } catch {
      return false;
    } finally {
      if (session)
        await withTimeout(session.detach(), 500, {
          timeoutError: () => new Error("Unfreeze detach timed out."),
        }).catch(() => undefined);
    }
  }

  /**
   * A session's claim of its own restored tab: the tab whose group title is `surfaceId`, or
   * nothing (the caller opens the tab by address). One deadline bounds the lane wait and the wake.
   */
  private async claimRestored(
    surfaceId: BrowserSurfaceId,
    own?: (page: BrowserPage) => void,
    signal?: AbortSignal,
  ): Promise<BrowserPage | null> {
    if (!this.lifecycle || !this.restored.has(surfaceId)) return null;
    const deadline = performance.now() + wakeDiscardedTabMs;
    this.claimingTitles.add(surfaceId);
    try {
      const lane = this.laneTails.get(surfaceId);
      if (lane) {
        const settled = await withTimeout(
          lane.then(() => true),
          remainingMs(deadline),
          {
            timeoutError: () => new Error("Pending parked discard wait timed out."),
          },
        ).catch(() => false);
        if (!settled) {
          // Rule B: the run on this tab is still in its freeze or discard, so the claim gives the
          // tab up instead of taking it beside that run.
          if (this.restored.has(surfaceId)) void this.evictRestored(surfaceId);
          return null;
        }
      }
      const entry = this.restored.get(surfaceId);
      if (!entry) return null;
      this.restored.delete(surfaceId);
      try {
        // Always through the named tab: a cached page may be a discarded tab's placeholder, which
        // only activation loads with its own history and state.
        const page = await this.wakeNamed(surfaceId, deadline, signal);
        if (this.frozenPages.has(page) && !(await this.unfreezeRestoredPage(page))) {
          throw new Error("Restored tab remained frozen and could not be unfrozen.");
        }
        await this.ensurePagePolicyOnRestoredPage(page);
        if (!this.publish(page, false)) throw new Error("The restored tab closed.");
        const handle = this.wrap(page);
        handle.restoredFromSession = true;
        this.trackSavedTab(surfaceId, handle);
        own?.(handle);
        return handle;
      } catch {
        // The restored tab is given up; its page stays hidden until its removal is proven.
        this.restored.set(surfaceId, entry);
        void this.evictRestored(surfaceId);
        return null;
      }
    } finally {
      this.claimingTitles.delete(surfaceId);
    }
  }

  /**
   * Gives a saved page's tab its Home surface id as its name, on that name's lane (K7). A page
   * still at its first blank entry is named after its first real navigation (naming it earlier
   * makes Chromium save a broken history for it); a name another tab still carries waits.
   */
  private trackSavedTab(surfaceId: BrowserSurfaceId, page: BrowserPage | null): void {
    if (page === null) {
      this.deferredNames.delete(surfaceId);
      this.boundPages.delete(surfaceId);
      return;
    }
    if (!(page instanceof PlaywrightPageHandle) || !this.lifecycle) return;
    this.savedSurfaceByPage.set(page, surfaceId);
    this.boundPages.set(surfaceId, page);
    this.deferredNames.delete(surfaceId);
    if (!isHomeTabName(surfaceId)) {
      // K10: never written, so the tab comes back as a fresh page at its address.
      if (!this.unnameable.has(surfaceId))
        process.stderr.write('{"event":"browser-runtime.tab-name-unusable"}\n');
      this.unnameable.add(surfaceId);
      return;
    }
    const raw = page.rawPage;
    if (isBlankAddress(page.url())) {
      if (this.awaitingFirstNavigation.has(raw)) return;
      const onNavigated = (frame: Frame) => {
        if (frame !== raw.mainFrame() || isBlankAddress(frame.url())) return;
        done();
        // The binding now, not the one this callback was made for.
        const current = this.savedSurfaceByPage.get(page);
        if (current) this.trackSavedTab(current, page);
      };
      const done = () => {
        raw.off("framenavigated", onNavigated);
        this.awaitingFirstNavigation.delete(raw);
      };
      this.awaitingFirstNavigation.set(raw, { done });
      raw.on("framenavigated", onNavigated);
      return;
    }
    const bound = () =>
      !this.closed &&
      !page.isClosed() &&
      !page.closeRequested &&
      this.savedSurfaceByPage.get(page) === surfaceId;
    const naming = this.onLane(surfaceId, async () => {
      const deadline = performance.now() + targetLookupMs;
      for (let attempt = 0; attempt < removalRetryBound && bound(); attempt++) {
        const targetId = await lookupTargetId(this.context, raw, deadline);
        const rows = targetId && bound() ? await this.read(deadline) : null;
        const row = rows?.find((entry) => entry.targetId === targetId);
        if (rows && row) {
          const named = findNamed(rows, surfaceId);
          const ours = named.kind === "one" && named.row.tabId === row.tabId;
          if (!ours && (named.kind !== "none" || this.isGuardedName(surfaceId))) {
            this.deferredNames.set(surfaceId, page);
            return;
          }
          // The binding is checked immediately before the write (K7, K8).
          if (!bound()) return;
          if (await this.lifecycle!.nameTab(row.tabId, surfaceId).catch(() => false)) return;
        }
        if (performance.now() + 100 >= deadline) return;
        await delay(100 * (attempt + 1));
      }
    }).catch(() => undefined);
    this.naming.add(naming);
    void naming.finally(() => this.naming.delete(naming));
  }

  private retryDeferredName(surfaceId: string): void {
    const page = this.deferredNames.get(surfaceId as BrowserSurfaceId);
    if (page) this.trackSavedTab(surfaceId as BrowserSurfaceId, page);
  }

  /** Before an orderly close: tabs being named finish, so Chromium's session carries them. */
  async settleNaming(): Promise<void> {
    const deadline = performance.now() + namingSettleMs;
    // A saved tab still waiting for its first real navigation is named now if Chromium already
    // has an address for it: its navigation commits within the bound, so Chromium's session
    // carries its name. A tab Chromium shows blank has nothing to restore.
    if (this.awaitingFirstNavigation.size > 0) {
      const rows = await this.read(deadline);
      for (const [raw, waiting] of Array.from(this.awaitingFirstNavigation)) {
        const targetId = syncTargetIdOfPage(raw);
        const row = rows?.find((entry) => targetId !== null && entry.targetId === targetId);
        if (!row || isBlankAddress(row.url)) continue;
        const page = this.wrap(raw);
        while (isBlankAddress(page.url()) && performance.now() < deadline) await delay(50);
        const current = this.savedSurfaceByPage.get(page);
        if (isBlankAddress(page.url()) || !current) continue;
        waiting.done();
        this.trackSavedTab(current, page);
      }
    }
    if (this.naming.size === 0) return;
    await withTimeout(Promise.allSettled(this.naming), remainingMs(deadline), {
      timeoutError: () => new Error("Tab naming did not settle."),
    }).catch(() => undefined);
  }

  markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.reconcileAbort?.abort();
    this.reconcileAbort = undefined;
    this.activeWake?.giveUp();
    for (const wake of this.parkedWaiters.splice(0)) wake();
    if (this.reconcileFallbackTimer) {
      clearTimeout(this.reconcileFallbackTimer);
      this.reconcileFallbackTimer = undefined;
    }
    if (this.removalTimer) {
      clearTimeout(this.removalTimer);
      this.removalTimer = undefined;
    }
    this.restored.clear();
    this.claimingTitles.clear();
    this.sleepingByToken.clear();
    this.sleepingTitles.clear();
    this.removals.clear();
    this.unremovable.clear();
    this.deferredNames.clear();
    this.boundPages.clear();
    for (const waiting of Array.from(this.awaitingFirstNavigation.values())) waiting.done();
    this.laneTails.clear();
    this.parkingArmed = false;
  }

  private async ensurePagePolicyOnRestoredPage(page: Page): Promise<void> {
    if (page.isClosed()) return;
    const script = browserPagePolicyScriptFor(this.providerConfig);
    if (typeof page.addInitScript === "function") {
      await withTimeout(page.addInitScript({ content: script }), 1_000, {
        timeoutError: () => new Error("Page policy initScript timed out."),
      }).catch(() => undefined);
    }
    const frames = typeof page.frames === "function" ? page.frames() : [];
    await withTimeout(
      Promise.allSettled(
        frames.map((frame) =>
          typeof frame.evaluate === "function"
            ? frame.evaluate((source: string) => {
                globalThis.eval(source);
              }, script)
            : Promise.resolve(),
        ),
      ),
      1_000,
      { timeoutError: () => new Error("Page policy sync timed out.") },
    ).catch(() => undefined);
  }

  async activatePrivateAnchor(): Promise<void> {
    if (!this.privatePage || this.privatePage.isClosed()) return;
    await withTimeout(this.privatePage.bringToFront(), nameTargetMs, {
      timeoutError: () => new Error("Private anchor bringToFront timed out."),
    }).catch(() => undefined);
  }

  /**
   * Puts a page's tab to sleep by discard, on its name's lane (K7). The tab is named first (a
   * saved tab keeps its Home surface id, any other tab gets its token's name), the name is guarded
   * before Chromium is asked, and afterwards the tab is found by that name alone.
   */
  async sleepTab(
    handle: PlaywrightPageHandle,
    page: Page,
    token: { readonly tokenId: string; readonly targetId: string; readonly url: string },
    detach: () => Promise<void>,
  ): Promise<void> {
    const saved = this.savedSurfaceByPage.get(handle);
    const surfaceId = saved && isHomeTabName(saved) ? saved : undefined;
    const title = surfaceId ?? `${sleepTitlePrefix}${token.tokenId}`;
    const settled = Promise.withResolvers<void>();
    this.sleepingByToken.set(token.tokenId, {
      title,
      url: token.url,
      settled: settled.promise,
      ...(surfaceId ? { surfaceId } : {}),
    });
    this.sleepingTitles.set(title, token.tokenId);
    const forget = () => {
      this.sleepingByToken.delete(token.tokenId);
      if (this.sleepingTitles.get(title) === token.tokenId) this.sleepingTitles.delete(title);
    };
    try {
      await this.onLane(title, async () => {
        const deadline = performance.now() + 2 * nameTargetMs;
        const rows = await this.read(deadline);
        const row = rows?.find((entry) => entry.targetId === token.targetId);
        const named = rows ? findNamed(rows, title) : null;
        // A name is never given to a second tab: one another tab carries, or one being restored or
        // removed, leaves this tab unnamed. A blank tab is not named (see trackSavedTab).
        const free =
          (named?.kind === "one" && named.row.tabId === row?.tabId) ||
          (named?.kind === "none" &&
            !this.restored.has(title as BrowserSurfaceId) &&
            !this.removals.has(title) &&
            !this.unremovable.has(title));
        const live = () => !this.closed && !page.isClosed();
        if (
          !row ||
          !free ||
          isBlankAddress(token.url) ||
          !live() ||
          !(await this.lifecycle!.nameTab(row.tabId, title).catch(() => false))
        ) {
          // The tab cannot be named, so it could not be found again: it closes and wakes by address.
          forget();
          await withTimeout(detach(), nameTargetMs, {
            timeoutError: () => new Error("Sleep detach timed out."),
          }).catch(() => undefined);
          await this.closePageWithEvidence(page);
          return;
        }
        if (row.active) await this.activatePrivateAnchor();
        await this.freezeBeforeDiscard(page);
        await withTimeout(detach(), nameTargetMs, {
          timeoutError: () => new Error("Sleep detach timed out."),
        }).catch(() => undefined);
        await this.lifecycle!.discardByTabId(row.tabId).catch(() => null);
        const after = await this.read(performance.now() + 2 * nameTargetMs);
        const asleep = after ? findNamed(after, title) : null;
        if (asleep?.kind === "one" && asleep.row.discarded) return;
        // Still loaded, gone, ambiguous or not known: the page closes. The name stays guarded
        // until a wake or release proves what became of the tab.
        await this.closePageWithEvidence(page);
      });
    } finally {
      settled.resolve();
    }
  }

  async releaseRestore(restore: unknown): Promise<boolean> {
    const discardRestore = parseChromiumDiscardRestore(restore);
    if (!discardRestore || !this.lifecycle) return true;
    const sleeping = this.sleepingByToken.get(discardRestore.tokenId);
    if (!sleeping) return true;
    await sleeping.settled;
    const removed = await this.onLane(sleeping.title, () => this.removeNamed(sleeping.title, 1));
    if (!removed) {
      // K6: not proven gone. The token stays, so a later release asks again, and the background
      // drain retries within its bound or reports the removal unconfirmed; the name stays guarded.
      this.giveUpName(sleeping.title);
      return false;
    }
    this.sleepingByToken.delete(discardRestore.tokenId);
    if (this.sleepingTitles.get(sleeping.title) === discardRestore.tokenId)
      this.sleepingTitles.delete(sleeping.title);
    this.removals.delete(sleeping.title);
    this.retryDeferredName(sleeping.title);
    return true;
  }

  /**
   * Wakes the one tab carrying `title`; its page is returned hidden, for the caller to take. One
   * deadline covers the queue wait and the arrival; a wake whose creation was abandoned, or whose
   * deadline passed in the queue, does not run (K8).
   */
  private wakeNamed(title: string, deadline: number, signal?: AbortSignal): Promise<Page> {
    const run = this.wakeTail.then(() => {
      if (signal?.aborted || performance.now() >= deadline || this.closed)
        throw new Error("The wake was abandoned.");
      return this.wakeNamedOnce(title, deadline);
    });
    this.wakeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return withTimeout(run, remainingMs(deadline), {
      timeoutError: () => new Error("Waking sleeping Chromium tab timed out."),
    });
  }

  private async wakeNamedOnce(title: string, deadline: number): Promise<Page> {
    const lifecycle = this.lifecycle;
    if (!lifecycle) throw new Error("Tab lifecycle helper is unavailable.");
    const rows = await this.read(deadline);
    const named = rows ? findNamed(rows, title) : null;
    if (named?.kind !== "one") throw new Error("The named tab is not exactly one tab.");
    const { row } = named;
    const activate = async () => {
      const reply = await withTimeout(lifecycle.activateByTabId(row.tabId), remainingMs(deadline), {
        timeoutError: () => new Error("Activating sleeping Chromium tab timed out."),
      });
      // K2: Chromium's own answer names the tab the read named, loaded (seen on real Chromium).
      if (!reply.ok || reply.tabId !== row.tabId || reply.discarded)
        throw new Error("Chromium did not activate the named tab.");
      return reply;
    };
    const candidate = row.targetId
      ? this.context
          .pages()
          .find(
            (page) =>
              page !== this.privatePage &&
              !page.isClosed() &&
              !this.published.has(page) &&
              !this.ending.has(page) &&
              syncTargetIdOfPage(page) === row.targetId,
          )
      : undefined;
    if (candidate) {
      this.identifyingPages.delete(candidate);
      // A discarded or never-loaded tab loads its own entry only when activated.
      if (row.discarded || row.status === "unloaded") await activate();
      return candidate;
    }
    const arrival = Promise.withResolvers<{ page: Page; row: ChromiumTabEntry } | null>();
    const wake: ArmedWake = {
      title,
      arrive: (page, arrived) => arrival.resolve({ page, row: arrived }),
      giveUp: () => arrival.resolve(null),
    };
    // The guard is in place before Chromium is asked to activate the tab.
    this.activeWake = wake;
    try {
      const reply = await activate();
      const arrived = await withTimeout(arrival.promise, remainingMs(deadline), {
        timeoutError: () => new Error("Waking sleeping Chromium tab timed out."),
      });
      // Otherwise the arriving page stays hidden: its name's removal closes it.
      if (!arrived || arrived.row.tabId !== reply.tabId)
        throw new Error("The woken tab was not the one tab carrying its name.");
      return arrived.page;
    } finally {
      if (this.activeWake === wake) this.activeWake = null;
    }
  }

  handOff(listener: (page: BrowserPage, opener: BrowserPage | null) => void): () => void {
    this.handOffs.add(listener);
    for (const page of this.context.pages()) {
      if (!this.isVisible(page) || page.isClosed()) continue;
      const handle = this.wrap(page);
      listener(handle, handle.openerHandle);
    }
    return () => this.handOffs.delete(listener);
  }

  pages(): BrowserPage[] {
    return this.context
      .pages()
      .filter((page) => this.isVisible(page))
      .map((page) => this.wrap(page));
  }

  /** K3 (a): the runtime's own new page, published by Playwright's answer to this call. */
  private async openFreshPage(): Promise<Page> {
    const opening = withTimeout(this.context.newPage(), openPageMs, {
      timeoutError: () => new Error("Opening a page timed out."),
    });
    this.openingPages.add(opening);
    try {
      const page = await opening;
      if (!this.publish(page, true)) throw new Error("The new page closed.");
      return page;
    } finally {
      this.openingPages.delete(opening);
    }
  }

  async createPage(options?: {
    readonly restore?: unknown;
    readonly own?: (page: BrowserPage) => void;
    readonly signal?: AbortSignal;
  }): Promise<BrowserPage> {
    await this.beforeCreatePage?.().catch(() => undefined);
    const discardRestore = parseChromiumDiscardRestore(options?.restore);
    if (discardRestore && this.lifecycle) {
      const sleeping = this.sleepingByToken.get(discardRestore.tokenId);
      if (sleeping) {
        const deadline = performance.now() + wakeDiscardedTabMs;
        await withTimeout(sleeping.settled, remainingMs(deadline), {
          timeoutError: () => new Error("The tab's sleep did not settle."),
        }).catch(() => undefined);
        try {
          const woken = await this.wakeNamed(sleeping.title, deadline, options?.signal);
          if (!this.publish(woken, false)) throw new Error("The woken tab closed.");
          this.sleepingByToken.delete(discardRestore.tokenId);
          if (this.sleepingTitles.get(sleeping.title) === discardRestore.tokenId)
            this.sleepingTitles.delete(sleeping.title);
          const handle = this.wrap(woken);
          if (sleeping.surfaceId) this.trackSavedTab(sleeping.surfaceId, handle);
          options?.own?.(handle);
          return handle;
        } catch {
          // Rule B: the wake gave its tab up. The token stays for its release; the name stays
          // guarded until its removal is proven (K6).
          if (this.sleepingTitles.get(sleeping.title) === discardRestore.tokenId)
            this.sleepingTitles.delete(sleeping.title);
          this.giveUpName(sleeping.title);
        }
      }
      const fallback = this.wrap(await this.openFreshPage());
      if (sleeping?.surfaceId) this.trackSavedTab(sleeping.surfaceId, fallback);
      options?.own?.(fallback);
      if (discardRestore.url && discardRestore.url !== "about:blank") {
        void fallback
          .cdp()
          .then((cdp) => cdp.send("Page.navigate", { url: discardRestore.url }))
          .catch(() => undefined);
      }
      return fallback;
    }
    const handle = this.wrap(await this.openFreshPage());
    options?.own?.(handle);
    return handle;
  }

  onPage(listener: (page: BrowserPage) => void): void {
    this.pageListeners.add(listener);
  }

  offPage(listener: (page: BrowserPage) => void): void {
    this.pageListeners.delete(listener);
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

  /** A page asked to close is never found, and no page's target lookup delays another's. */
  pageByTargetId(targetId: string): Promise<PlaywrightPageHandle | null> {
    return pageWithTarget(
      this.context
        .pages()
        .filter((page) => this.isVisible(page))
        .map((page) => this.wrap(page)),
      targetId,
      targetLookupMs,
      (handle) => !handle.isClosed() && !handle.closeRequested,
    );
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
  readonly captureRestore?: () => Promise<unknown | null>;
  restoredFromSession = false;
  private pendingDiscard: {
    readonly tokenId: string;
    readonly targetId: string;
    readonly url: string;
  } | null = null;
  private requestMethod = "GET";
  private documentMethod = "GET";
  private readonly uploads = new Set<Request>();
  private captureSession: Promise<PlaywrightCdpSession> | undefined;
  private captureWorld: number | undefined;
  private cdpPromise: Promise<CdpSession> | null = null;
  private cdpChannel: CdpSession | null = null;
  private closing = false;
  private closeAttempts = 0;
  /** This page's target once known, for a close that goes around Playwright. */
  private knownTargetId: string | undefined;
  /** The confirmation: Playwright's page close event, or its context ending. */
  private gone = false;
  private readonly goneListeners = new Set<(cause?: PageGoneCause) => void>();
  /** The page whose script opened this one, from Playwright's popup event. */
  openerHandle: PlaywrightPageHandle | null = null;
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
  get rawPage(): Page {
    return this.page;
  }
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
    if (contextHandle.lifecycle) {
      this.captureRestore = () => this.captureDiscardRestore();
    }
    page.on("request", (request) => {
      if (!["GET", "HEAD"].includes(request.method())) this.uploads.add(request);
      if (request.isNavigationRequest() && request.frame() === page.mainFrame())
        this.requestMethod = request.method();
    });
    page.on("requestfinished", (request) => this.uploads.delete(request));
    page.on("requestfailed", (request) => this.uploads.delete(request));
    page.once("close", () => this.uploads.clear());
    page.once("close", () => void this.endedBy().then((cause) => this.confirmGone(cause)));
    page.on("popup", (popup) => {
      contextHandle.wrap(popup).openerHandle = this;
    });
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
    maxImageBytes,
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
    const decodedBytes =
      (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    if (maxImageBytes !== undefined && decodedBytes > maxImageBytes && !clip && direct === format)
      throw new BrowserRuntimeError("bad_message", "Screenshot exceeds its image budget.", {
        reason: "browser-reply-limit",
      });
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
    const encoded = await this.inCaptureWorld(
      session,
      viewportImageScript(data, plan, {
        ...encoding,
        ...(maxImageBytes === undefined ? {} : { maxImageBytes }),
      }),
    );
    if (encoded === null)
      throw new BrowserRuntimeError("bad_message", "Screenshot exceeds its image budget.", {
        reason: "browser-reply-limit",
      });
    return { data: encoded };
  }

  /** A world page scripts and agents never reach, lending the page's own image codecs. */
  private async inCaptureWorld(
    session: PlaywrightCdpSession,
    expression: string,
  ): Promise<string | null> {
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
        return z.string().nullable().parse(result.value);
      } catch (error) {
        // A navigation takes the world with it.
        this.captureWorld = undefined;
        if (attempt > 0) throw error;
      }
    }
  }

  agentCdp(): Promise<CdpSession> {
    if (this.closing)
      return Promise.reject(new BrowserRuntimeError("not_found", "The browser page closed."));
    return this.context.newCDPSession(this.page).then(async (session) => {
      const channel = new PlaywrightCdpHandle(session);
      if (this.closing) {
        await channel.detach();
        throw new BrowserRuntimeError("not_found", "The browser page closed.");
      }
      return channel;
    });
  }

  cdp(): Promise<CdpSession> {
    if (this.closing)
      return Promise.reject(new BrowserRuntimeError("not_found", "The browser page closed."));
    this.cdpPromise ??= this.context.newCDPSession(this.page).then(async (session) => {
      const channel = new PlaywrightPageCdpHandle(
        session,
        this.page,
        this.openDialogs,
        this.contextHandle.authenticator ? ["Network", "Security"] : [],
      );
      this.cdpChannel = channel;
      if (this.closing) {
        await channel.detach();
        throw new BrowserRuntimeError("not_found", "The browser page closed.");
      }
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

  private async captureDiscardRestore(): Promise<ChromiumDiscardRestore> {
    const targetId = this.knownTargetId ?? (await this.targetId());
    const tokenId = randomUUID();
    const url = this.url();
    this.pendingDiscard = { tokenId, targetId, url };
    return { kind: "chromium-discard", tokenId, url };
  }

  /**
   * Each call is a new attempt; a page asked to close never returns to service.
   * The first closes through Playwright, which waits on its own first request
   * forever once that hangs, so later attempts go around it: they retire this
   * page's debugger again and close the one target from the browser itself.
   * Nothing wider than this page is ever closed.
   */
  close(options?: { readonly reason?: PageEndReason }): Promise<void> {
    if (this.isClosed()) return Promise.resolve();
    this.closing = true;
    const first = this.closeAttempts++ === 0;
    const sleepDiscard = first && options?.reason === "slept" ? this.pendingDiscard : null;
    this.pendingDiscard = null;
    const operation = (async () => {
      if (sleepDiscard && this.contextHandle.lifecycle) {
        await this.contextHandle.sleepTab(this, this.page, sleepDiscard, async () => {
          await this.cdpChannel?.detach();
        });
        return;
      }
      if (first) {
        // Native close can wait on a navigation still held by this private debugger.
        await this.cdpChannel?.detach();
        if (!this.page.isClosed()) await this.page.close({ runBeforeUnload: false });
        return;
      }
      await this.cdpChannel?.detach().catch(() => undefined);
      if (this.page.isClosed()) return;
      const closeTarget = this.contextHandle.closeTarget;
      if (!closeTarget) {
        if (!this.page.isClosed()) await this.page.close({ runBeforeUnload: false });
        return;
      }
      const targetId = this.knownTargetId ?? (await this.nameTarget());
      if (!targetId)
        throw new BrowserRuntimeError("conflict", "This page cannot be named to close it.", {
          reason: pageUnnameableReason,
        });
      await closeTarget(targetId);
    })();
    return operation;
  }

  /** This exact page's target, read through a debugger opened for it alone; null if it cannot be named. */
  private async nameTarget(): Promise<string | null> {
    const opening = this.context.newCDPSession(this.page);
    let session: PlaywrightCdpSession | undefined;
    try {
      session = await withTimeout(opening, nameTargetMs, {
        timeoutError: () => new Error("The page's debugger did not attach."),
      });
    } catch {
      void opening.then((late) => late?.detach()).catch(() => undefined);
      return null;
    }
    if (!session) return null;
    try {
      const response = await withTimeout(session.send("Target.getTargetInfo"), nameTargetMs, {
        timeoutError: () => new Error("The page did not name its target."),
      });
      const targetId = response.targetInfo?.targetId;
      if (typeof targetId !== "string" || targetId.length < 1 || targetId.length > 512) return null;
      this.knownTargetId = targetId;
      return targetId;
    } catch {
      return null;
    } finally {
      void session.detach()?.catch(() => undefined);
    }
  }

  /**
   * Playwright reports each page's close before its context's when Chromium
   * dies, so a page's own close event is the browser's end unless the browser
   * still answers.
   */
  private async endedBy(): Promise<PageGoneCause> {
    const alive = this.contextHandle.browserAlive;
    return alive && !(await alive()) ? "context" : "page";
  }

  /** Closing refuses new debugger sessions; only the confirmation, with its cause, makes the page closed. */
  isClosed(): boolean {
    return this.gone;
  }

  /** A close was asked for; the page may still exist until it is confirmed gone. */
  get closeRequested(): boolean {
    return this.closing;
  }

  confirmGone(cause: PageGoneCause): void {
    if (this.gone) return;
    this.gone = true;
    for (const listener of this.goneListeners) listener(cause);
  }

  onClose(listener: (cause?: PageGoneCause) => void): void {
    this.goneListeners.add(listener);
  }

  offClose(listener: (cause?: PageGoneCause) => void): void {
    this.goneListeners.delete(listener);
  }

  onRendererGone(listener: (cause: RendererGoneCause) => void): () => void {
    // Playwright reports only crashes; an orderly renderer exit has no event.
    const crashed = () => listener("crashed");
    this.page.on("crash", crashed);
    return () => this.page.off("crash", crashed);
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
      this.knownTargetId = targetId;
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
  readonly dedicatedContext: boolean;
  private readonly browserContextId: string | undefined;
  private closed = false;
  private readonly context: PlaywrightContextHandle;
  private readonly handle: PlaywrightCdpHandle;
  private readonly hiddenTargetIds = new Set<string>();

  constructor(
    session: PlaywrightCdpSession,
    context: PlaywrightContextHandle,
    browserContextId: string | undefined,
    dedicatedContext: boolean,
    privatePageTargetId?: string,
  ) {
    this.dedicatedContext = dedicatedContext;
    this.browserContextId = browserContextId;
    this.context = context;
    if (privatePageTargetId) this.hiddenTargetIds.add(privatePageTargetId);
    this.handle = new PlaywrightCdpHandle(session);
    this.handle.eventRelay.observeDomain("Target.getTargets");
  }

  private isHiddenTargetEvent(method: string, parameters: CdpParameters): boolean {
    if (!method.startsWith("Target.")) return false;
    const info = isRecord(parameters.targetInfo) ? parameters.targetInfo : null;
    const targetId =
      typeof parameters.targetId === "string"
        ? parameters.targetId
        : typeof info?.targetId === "string"
          ? info.targetId
          : null;
    const url = typeof info?.url === "string" ? info.url : undefined;
    if (isInternalExtensionUrl(url)) {
      if (targetId) this.hiddenTargetIds.add(targetId);
      return true;
    }
    if (targetId && this.hiddenTargetIds.has(targetId)) {
      if (method === "Target.targetDestroyed") this.hiddenTargetIds.delete(targetId);
      return true;
    }
    return false;
  }

  async attach(targetId: string, waitForPage = false, signal?: AbortSignal): Promise<CdpChannel> {
    if (this.closed) throw new Error("Browser CDP backend is closed.");
    const missingPage = () =>
      new Error("CDP target is not an attachable page in this Profile Host.");
    if (!waitForPage) {
      const page = await this.context.pageByTargetId(targetId);
      if (!page) throw missingPage();
      return page.agentCdp();
    }
    const found = Promise.withResolvers<PlaywrightPageHandle>();
    const onPage = (page: BrowserPage) => {
      if (page instanceof PlaywrightPageHandle) {
        void page.targetId().then(
          (id) => {
            if (id === targetId && !page.isClosed() && !page.closeRequested) found.resolve(page);
          },
          () => undefined,
        );
      }
    };
    // Chromium can announce a popup before Playwright exposes the initialized page.
    this.context.onPage(onPage);
    try {
      const page = await withTimeout(
        this.context.pageByTargetId(targetId).then((page) => page ?? found.promise),
        targetLookupMs,
        { timeoutError: missingPage, ...(signal ? { signal } : {}) },
      );
      return page.agentCdp();
    } finally {
      this.context.offPage(onPage);
    }
  }

  assertScope(_method: string, parameters: CdpParameters): void {
    if (
      parameters.browserContextId !== undefined &&
      parameters.browserContextId !== this.browserContextId
    )
      throw new SessionCdpRouterError(
        "forbidden",
        "CDP command requested another browser context.",
      );
    if (parameters.windowId !== undefined)
      throw new SessionCdpRouterError(
        "forbidden",
        "Native browser windows are outside this page context.",
      );
  }

  async scopeParameters(method: string, parameters: CdpParameters): Promise<CdpParameters> {
    if (!contextScopedCdpMethods.has(method) || !this.browserContextId) return parameters;
    return { ...parameters, browserContextId: this.browserContextId };
  }

  onEvent(listener: (method: string, parameters: CdpParameters) => void): () => void {
    return this.handle.onEvent((method, parameters) => {
      if (this.isHiddenTargetEvent(method, parameters)) return;
      listener(method, parameters);
    });
  }

  send(method: string, parameters?: CdpParameters): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Browser CDP backend is closed."));
    try {
      this.assertScope(method, parameters ?? {});
    } catch (error) {
      return Promise.reject(error);
    }
    if (
      method.startsWith("Target.") &&
      typeof parameters?.targetId === "string" &&
      this.hiddenTargetIds.has(parameters.targetId)
    ) {
      return Promise.reject(
        new Error("CDP target is not an attachable page in this Profile Host."),
      );
    }
    if (method === "Target.getTargets") {
      return this.handle
        .send<{ targetInfos?: readonly Record<string, unknown>[] }>(method, parameters)
        .then((result) => {
          if (!Array.isArray(result?.targetInfos)) return result;
          const visible = result.targetInfos.filter((target) => {
            const url = typeof target.url === "string" ? target.url : undefined;
            const targetId = typeof target.targetId === "string" ? target.targetId : null;
            if (isInternalExtensionUrl(url)) {
              if (targetId) this.hiddenTargetIds.add(targetId);
              return false;
            }
            return true;
          });
          return { ...result, targetInfos: visible };
        });
    }
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
    if (contextScopedCdpMethods.has(method)) {
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
