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
        // Chromium never loads a last session (L1): its session records are deleted before launch
        // and no window opens by itself, so a restarted Home's tabs open fresh at their addresses.
        // "Continue where you left off" stays on only so Chromium keeps session cookies (sign-ins).
        "--no-startup-window",
        "--restore-last-session",
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
    const lifecycleExtensionDir = await ensureTabLifecycleExtension(directory);
    timing("preferences");
    signal?.throwIfAborted();
    const context = await chromium.launchPersistentContext(
      directory,
      this.nativeLaunchOptions(directory, lifecycleExtensionDir, deadline),
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
      const helper = await withTimeout(context.newPage(), remainingMs(deadline), {
        timeoutError: () => new Error("The private page did not open."),
      });
      timing("cookie-target");
      const browserCdp = await withTimeout(browser.newBrowserCDPSession(), remainingMs(deadline), {
        timeoutError: () => new Error("The browser debugger did not attach."),
      });
      timing("cdp");
      // The helper that sleeps tabs by discard, if it answers; otherwise tabs sleep by closing.
      const candidate =
        typeof context.serviceWorkers === "function"
          ? new ChromiumTabLifecycleBridge(context, browserCdp, helper)
          : undefined;
      const lifecycle = candidate && (await readRows(candidate, deadline)) ? candidate : undefined;
      if (candidate && !lifecycle)
        process.stderr.write(
          '{"event":"browser-runtime.tab-lifecycle-unavailable","stage":"launch-inventory"}\n',
        );
      const helperTargetId = lifecycle ? await lookupTargetId(context, helper, deadline) : null;
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
      const reply = (await withTimeout(
        browserCdp.send("Target.closeTarget", { targetId }),
        nameTargetMs,
        { timeoutError: () => new Error("Target.closeTarget timed out.") },
      )) as { success?: unknown } | undefined;
      // A resolved answer that says it did not close is no evidence of a close.
      if (reply?.success === false) throw new Error("Chromium did not close the target.");
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

/** One bound for a wake: its lane wait, the activation and the arrival together. */
const wakeDiscardedTabMs = 10_000;
/** How long an arriving page's tab name is looked up while some tab is asleep. */
const arrivalIdentifyMs = 2_000;
/** How long the runtime's own new page may take; a page with no opener waits inside it (K3). */
const openPageMs = 10_000;
/** Background removal attempts per sleeping tab, since it was given up, before it is reported. */
const removalRetryBound = 8;
/** The group title a tab carries while it sleeps, and only then (L2). */
const sleepTitlePrefix = "opensteer-sleep:";

const remainingMs = (deadline: number) => Math.max(1, deadline - performance.now());
const notWanted = () => new Error("The page is no longer wanted.");

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
      { timeoutError: () => new Error("Target lookup getTargetInfo timed out.") },
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

/** K1: one read that agrees with itself inside `deadline`, or null: not known. */
function readRows(
  lifecycle: ChromiumTabLifecycleBridge,
  deadline: number,
): Promise<readonly ChromiumTabEntry[] | null> {
  return withTimeout(lifecycle.inventory(deadline), remainingMs(deadline), {
    timeoutError: () => new Error("Tab inventory timed out."),
  }).catch(() => null);
}

function reportUnconfirmedRemoval(attempts: number): void {
  process.stderr.write(
    `${JSON.stringify({ event: "browser-runtime.tab-removal-unconfirmed", attempts })}\n`,
  );
}

function isBlankAddress(url: string): boolean {
  return url === "" || url === "about:blank" || url === "chrome://newtab/";
}

/** One sleep of one tab: discarded, then named by its token, and found again by that name alone. */
interface SleepingTab {
  readonly title: string;
  readonly url: string;
  /**
   * The tab as last known: its id from Chromium's answer to the discard (a discard gives a tab a
   * new id, and may give it a new target too, seen on real Chromium), and its target then.
   */
  tabId: number;
  targetId: string | null;
  /** Whether the name was asked of Chromium; then the name, too, must be gone for a removal. */
  named: boolean;
  /** Whether a remove (or the close of its page) was answered; an unnamed tab needs one. */
  removeAsked: boolean;
  /** Resolves when the sleep (or the close it fell back to) has finished. */
  readonly settled: Promise<void>;
}

/** A wake waiting for its tab's page: it takes only the one tab carrying its name (K2, L4). */
interface ArmedWake {
  arrived: { readonly page: Page; readonly row: ChromiumTabEntry } | null;
  /** A second carrier, or a second arrival, was seen: the wake gives up. */
  spoiled: boolean;
  readonly settled: Promise<void>;
  arrive(page: Page, row: ChromiumTabEntry): void;
  spoil(): void;
}

function armWake(): ArmedWake {
  const settled = Promise.withResolvers<void>();
  const wake: ArmedWake = {
    arrived: null,
    spoiled: false,
    settled: settled.promise,
    arrive: (page, row) => {
      if (wake.arrived) wake.spoiled = true;
      else wake.arrived = { page, row };
      settled.resolve();
    },
    spoil: () => {
      wake.spoiled = true;
      settled.resolve();
    },
  };
  return wake;
}

/**
 * A page is published only with positive provenance (K3): the runtime's own new page, a page its
 * published opener opened, or the tab a wake took by its name. Every other page is classified by
 * its tab's group title: the page of a sleeping tab stays hidden, anything else is closed with
 * evidence. A tab carries a title only while it sleeps (L2): the helper names it after Chromium
 * discarded it, and the wake removes the name once it takes the tab.
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
  /** A native profile's context: K3 holds for every page. */
  private readonly nativeProfile: boolean;
  private readonly privatePage: Page | undefined;

  /** Sleeping tabs by token. A token is one sleep of one tab, and the key of that tab's lane. */
  private readonly sleeping = new Map<string, SleepingTab>();
  /** The token of the tab carrying each sleep name. */
  private readonly sleepingTitles = new Map<string, string>();
  /** Tokens given up: their tabs are removed in the background until proven, then forgotten. */
  private readonly removals = new Map<string, { attempts: number }>();
  /** Tokens whose removal could not be confirmed within the bound; still guarded. */
  private readonly unremovable = new Set<string>();
  private removalTimer: ReturnType<typeof setTimeout> | undefined;
  private removalDrain: Promise<void> | null = null;
  /** Wakes waiting for their tab's page, by the tab's sleep name. */
  private readonly wakes = new Map<string, ArmedWake>();
  private readonly published = new WeakSet<Page>();
  /** Pages being closed: never published, whatever answers later. */
  private readonly ending = new WeakSet<Page>();
  private readonly identifyingPages = new WeakSet<Page>();
  /** The name a hidden page was seen with, so its tab's removal closes it first. */
  private readonly pageTitles = new WeakMap<Page, string>();
  /** `newPage` calls in flight; a page they create is published by their answer. */
  private readonly openingPages = new Set<Promise<Page>>();
  private readonly laneTails = new Map<string, Promise<void>>();
  /** Discard-and-name calls in flight: until each is answered, its tab may be discarded unnamed. */
  private discarding = 0;

  constructor(
    context: PlaywrightBrowserContext,
    openDialogs: Map<Page, Dialog>,
    authenticator?: PasskeyAuthenticator,
    providerConfig?: BrowserPagePolicyConfig,
    privatePage?: Page,
    lifecycle?: ChromiumTabLifecycleBridge,
    nativeProfile = false,
  ) {
    this.privatePage = privatePage;
    this.lifecycle = lifecycle;
    this.authenticator = authenticator;
    this.providerConfig = providerConfig;
    this.context = context;
    this.openDialogs = openDialogs;
    this.nativeProfile = nativeProfile;
    for (const page of context.pages()) {
      if (this.isHiddenPage(page)) continue;
      if (nativeProfile) this.arrive(page);
      else this.published.add(page);
    }
    context.on("close", () => {
      this.markClosed();
      // A context's end ends its pages even when Playwright reports no page close.
      for (const handle of this.pagesByPlaywrightPage.values()) handle.confirmGone("context");
    });
    context.on("page", (page) => this.arrive(page));
  }

  /**
   * M1: a page whose tab carries no sleep name is an ordinary page, handed off as the base does,
   * opener or not. While some tab is asleep, its tab's name is read first, so a sleeping tab's
   * page is never handed out, also not as a popup; while none is, an arrival reads nothing.
   */
  private arrive(page: Page): void {
    if (this.isHiddenPage(page) || this.published.has(page) || this.ending.has(page)) return;
    const handle = this.wrap(page);
    // Its opener as Playwright recorded it, also when that page has closed since (M1).
    const known = (page as unknown as { _opener?: Page | null })._opener;
    if (known && known !== this.privatePage && this.published.has(known))
      handle.openerHandle ??= this.wrap(known);
    if (!this.nativeProfile || !this.lifecycle || this.sleeping.size === 0) {
      this.handOutOrdinary(page);
      return;
    }
    this.identifyingPages.add(page);
    void this.classify(page).catch(() => this.settleUnknown(page));
  }

  /**
   * Hands an ordinary page off as the base does, with its opener read from Playwright's own
   * record, at once: a page that has already closed itself is still handed off, so its end is seen.
   */
  private handOutOrdinary(page: Page): void {
    if (this.closed || this.ending.has(page) || this.published.has(page)) return;
    this.identifyingPages.delete(page);
    this.published.add(page);
    const handle = this.wrap(page);
    for (const listener of this.handOffs) listener(handle, handle.openerHandle);
    for (const listener of this.pageListeners) listener(handle);
  }

  /**
   * A page whose tab's name could not be read: ordinary, unless a wake is armed, when it may be
   * the waking tab's own page and is closed rather than handed out (lost, never wrong).
   */
  private settleUnknown(page: Page): void {
    if (this.closed || !this.identifyingPages.has(page)) return;
    if (this.wakes.size > 0) void this.closePageWithEvidence(page);
    else this.handOutOrdinary(page);
  }

  /** The one publication of a page with provenance. */
  private publish(page: Page, announce: boolean): boolean {
    // A page that closed itself is still handed off, so its end is seen; one we close is not.
    if (this.closed || this.ending.has(page)) return false;
    this.identifyingPages.delete(page);
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
   * While some tab is asleep, an arriving page's tab is looked up by its name, after any open of
   * the runtime's own settled (its answer publishes its page). A sleep name decides; no name is
   * an ordinary page; a name that cannot be read within the bound is settled as unknown.
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
    this.settleUnknown(page);
  }

  /** The answer for a page whose tab's row is known. */
  private place(page: Page, row: ChromiumTabEntry, rows: readonly ChromiumTabEntry[]): void {
    const title = row.identity ?? null;
    const wake = title === null ? undefined : this.wakes.get(title);
    const tokenId = title === null ? undefined : this.sleepingTitles.get(title);
    if (!wake && !tokenId) {
      // No sleep name: an ordinary page (M1).
      this.handOutOrdinary(page);
      return;
    }
    this.identifyingPages.delete(page);
    this.pageTitles.set(page, title!);
    const one = findNamed(rows, title!).kind === "one";
    if (wake) {
      // K2, L4: the wake takes only the one tab carrying its name, seen once; a second carrier
      // or a second arrival makes it give up. The page stays hidden either way.
      if (one) wake.arrive(page, row);
      else wake.spoil();
      return;
    }
    if (one && !this.removals.has(tokenId!) && !this.unremovable.has(tokenId!)) {
      // A sleeping tab Chromium loaded by itself goes back to sleep, unseen, on its own lane.
      if (!row.discarded && row.status !== "unloaded")
        void this.onLane(tokenId!, () => this.sleepAgain(tokenId!)).catch(() => undefined);
      return;
    }
    // A page of a sleeping tab given up, or of a name two tabs carry: closed with evidence.
    void this.closePageWithEvidence(page);
  }

  /**
   * On the tab's lane: still this token's sleep, still loaded, and no wake for it, it sleeps again
   * under its name, verified; a tab that does not is removed with evidence (or stays guarded).
   */
  private async sleepAgain(tokenId: string): Promise<void> {
    const record = this.sleeping.get(tokenId);
    if (!record || this.closed || this.wakes.has(record.title)) return;
    const deadline = performance.now() + 2 * nameTargetMs;
    const rows = await this.read(deadline);
    const named = rows ? findNamed(rows, record.title) : null;
    if (this.sleeping.get(tokenId) !== record || this.wakes.has(record.title)) return;
    if (named?.kind !== "one" || named.row.discarded || named.row.status === "unloaded") return;
    const discardedId = await this.lifecycle?.discardByTabId(named.row.tabId).catch(() => null);
    const after = await this.read(deadline);
    const again = after ? findNamed(after, record.title) : null;
    if (again?.kind === "one" && again.row.discarded) {
      record.tabId = again.row.tabId;
      record.targetId = again.row.targetId;
      return;
    }
    if (discardedId != null) record.tabId = discardedId;
    if (await this.removeSleeping(record, 1)) this.forget(tokenId, record);
    else this.giveUp(tokenId);
  }

  /**
   * The one bounded close with evidence: Playwright's close, then the target's own close. The page
   * is unpublished at once and stays out of reach whether or not the close is confirmed.
   */
  private async closePageWithEvidence(
    page: Page,
    deadline = performance.now() + 2 * nameTargetMs,
  ): Promise<boolean> {
    this.ending.add(page);
    this.published.delete(page);
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

  /** A page's later close attempt, on the lane of the sleep it was put to (M3). */
  onSleepLane(tokenId: string, fn: () => Promise<void>): Promise<void> {
    return this.onLane(tokenId, fn);
  }

  /** Runs `fn` after every earlier task of the same sleeping tab; they never overlap. */
  private onLane<T>(tokenId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.laneTails.get(tokenId) ?? Promise.resolve();
    const run = previous.then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.laneTails.set(tokenId, tail);
    void tail.then(() => {
      if (this.laneTails.get(tokenId) === tail) this.laneTails.delete(tokenId);
    });
    return run;
  }

  /**
   * K6, on the tab's lane: a sleeping tab is removed only on evidence, a read that agrees with
   * itself in which no tab carries its name and none has its id or target, after a remove
   * resolved when it was never named. M3: Opensteer alone discards and names in the same call, so
   * a discarded tab with no name is nobody's; every such tab is removed too, and the sleep counts
   * as removed only when none is left (never while another tab's discard is in flight). Its
   * hidden pages close first; `many` is not removed by name.
   */
  private async removeSleeping(record: SleepingTab, attempts: number): Promise<boolean> {
    const lifecycle = this.lifecycle;
    if (!lifecycle) return false;
    const deadline = performance.now() + attempts * nameTargetMs;
    const ours = (row: ChromiumTabEntry) =>
      row.tabId === record.tabId || (record.targetId !== null && row.targetId === record.targetId);
    const nobodys = (row: ChromiumTabEntry) => row.discarded && !row.identity;
    const gone = (rows: readonly ChromiumTabEntry[] | null) =>
      rows !== null &&
      findNamed(rows, record.title).kind === "none" &&
      !rows.some(ours) &&
      (record.named || record.removeAsked) &&
      this.discarding === 0 &&
      !rows.some(nobodys);
    const remove = async (tab: ChromiumTabEntry) => {
      let resolved = await lifecycle.removeByTabId(tab.tabId).catch(() => false);
      if (!resolved && tab.targetId && this.closeTarget)
        resolved = await this.closeTarget(tab.targetId).then(
          () => true,
          () => false,
        );
      return resolved;
    };
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (this.closed) return false;
      for (const page of this.context.pages())
        if (!this.published.has(page) && this.pageTitles.get(page) === record.title)
          await this.closePageWithEvidence(page, deadline);
      const rows = await this.read(deadline);
      if (this.closed) return false;
      if (gone(rows)) return true;
      if (rows) {
        const named = findNamed(rows, record.title);
        const tab =
          named.kind === "one" ? named.row : named.kind === "none" ? rows.find(ours) : undefined;
        if (tab && (await remove(tab))) record.removeAsked = true;
        if (this.discarding === 0) for (const orphan of rows.filter(nobodys)) await remove(orphan);
        if (gone(await this.read(deadline))) return true;
      }
      if (attempt < attempts - 1) await delay(40);
    }
    return false;
  }

  /** Forgets one sleep, only once its tab woke or is proven removed. */
  private forget(tokenId: string, record: SleepingTab): void {
    if (this.sleeping.get(tokenId) === record) this.sleeping.delete(tokenId);
    if (this.sleepingTitles.get(record.title) === tokenId) this.sleepingTitles.delete(record.title);
    this.removals.delete(tokenId);
    this.unremovable.delete(tokenId);
  }

  /** Gives a sleep up: guarded at once, removed in the background until proven, or reported. */
  private giveUp(tokenId: string): void {
    if (this.closed || this.removals.has(tokenId) || this.unremovable.has(tokenId)) return;
    this.removals.set(tokenId, { attempts: 0 });
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
    for (const [tokenId, tracker] of Array.from(this.removals)) {
      if (this.closed) return;
      await this.onLane(tokenId, async () => {
        if (this.removals.get(tokenId) !== tracker) return;
        const record = this.sleeping.get(tokenId);
        if (!record) {
          this.removals.delete(tokenId);
          return;
        }
        tracker.attempts++;
        if (await this.removeSleeping(record, 1)) this.forget(tokenId, record);
        else if (tracker.attempts >= removalRetryBound) {
          // Rule A: recorded as not removed, never retried silently forever; still guarded.
          this.removals.delete(tokenId);
          this.unremovable.add(tokenId);
          reportUnconfirmedRemoval(tracker.attempts);
        }
      });
    }
  }

  markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const wake of this.wakes.values()) wake.spoil();
    clearTimeout(this.removalTimer);
    this.removalTimer = undefined;
    this.sleeping.clear();
    this.sleepingTitles.clear();
    this.removals.clear();
    this.unremovable.clear();
    this.wakes.clear();
    this.laneTails.clear();
  }

  /**
   * Flushes Blink's page state (scroll, form controls) into Chromium's navigation entry before a
   * discard. Best effort: the discard still goes on, so no page stays running unowned.
   */
  private async freezeBeforeDiscard(page: Page): Promise<void> {
    let session: PlaywrightCdpSession | undefined;
    try {
      session = await withTimeout(this.context.newCDPSession(page), 1_000, {
        timeoutError: () => new Error("Freeze CDP attach timed out."),
      });
      await withTimeout(session.send("Page.setWebLifecycleState", { state: "frozen" }), 1_000, {
        timeoutError: () => new Error("Freeze timed out."),
      });
    } catch {
      // Best-effort flush.
    } finally {
      if (session)
        await withTimeout(session.detach(), 500, {
          timeoutError: () => new Error("Freeze detach timed out."),
        }).catch(() => undefined);
    }
  }

  async activatePrivateAnchor(): Promise<void> {
    if (!this.privatePage || this.privatePage.isClosed()) return;
    await withTimeout(this.privatePage.bringToFront(), nameTargetMs, {
      timeoutError: () => new Error("Private anchor bringToFront timed out."),
    }).catch(() => undefined);
  }

  /**
   * Puts a page's tab to sleep by discard, on that sleep's own lane (L2): Chromium discards the
   * tab first, then the helper names the tab Chromium returns with the token's name. A discarded
   * tab runs no script, so nothing it opens can inherit the name. A tab that cannot be put to
   * sleep under its name is closed, or removed with evidence, and wakes by address; until that
   * evidence its token and guard stay (L4).
   */
  async sleepTab(
    _handle: PlaywrightPageHandle,
    page: Page,
    token: { readonly tokenId: string; readonly targetId: string; readonly url: string },
    detach: () => Promise<void>,
  ): Promise<void> {
    const lifecycle = this.lifecycle!;
    const { tokenId } = token;
    const settled = Promise.withResolvers<void>();
    const record: SleepingTab = {
      title: `${sleepTitlePrefix}${tokenId}`,
      url: token.url,
      tabId: -1,
      targetId: token.targetId,
      named: false,
      removeAsked: false,
      settled: settled.promise,
    };
    // The name is guarded before Chromium is asked anything.
    this.sleeping.set(tokenId, record);
    this.sleepingTitles.set(record.title, tokenId);
    const detachBounded = () =>
      withTimeout(detach(), nameTargetMs, {
        timeoutError: () => new Error("Sleep detach timed out."),
      }).catch(() => undefined);
    try {
      await this.onLane(tokenId, async () => {
        const deadline = performance.now() + 3 * nameTargetMs;
        const rows = await this.read(deadline);
        const row = rows?.find((entry) => entry.targetId === token.targetId);
        if (row) record.tabId = row.tabId;
        if (!row || isBlankAddress(token.url) || this.closed || page.isClosed()) {
          // Not found, or nothing to keep: the tab sleeps by closing and wakes by address.
          await detachBounded();
          if (await this.closePageWithEvidence(page, deadline)) this.forget(tokenId, record);
          else this.giveUp(tokenId);
          return;
        }
        if (row.active) await this.activatePrivateAnchor();
        await this.freezeBeforeDiscard(page);
        await detachBounded();
        // L2 in one helper call: discard first, then name the tab Chromium returns. Asked, it may
        // be named even when the answer is lost, so the name must be gone too for a removal.
        record.named = true;
        this.discarding++;
        const asleepId = await lifecycle
          .discardAndName(row.tabId, record.title)
          .catch(() => null)
          .finally(() => this.discarding--);
        if (asleepId !== null) record.tabId = asleepId;
        const check = await this.read(deadline);
        const named = check ? findNamed(check, record.title) : null;
        if (named?.kind === "one" && named.row.discarded && !this.closed) {
          record.tabId = named.row.tabId;
          record.targetId = named.row.targetId;
          return;
        }
        // Not asleep under its name: closed and removed with evidence, it wakes by address. Its
        // page still open proves the tab was not discarded, so closing it closes the tab.
        if (!page.isClosed() && (await this.closePageWithEvidence(page, deadline)))
          record.removeAsked = true;
        if (await this.removeSleeping(record, 1)) this.forget(tokenId, record);
        else this.giveUp(tokenId);
      });
    } finally {
      settled.resolve();
    }
  }

  async releaseRestore(restore: unknown): Promise<boolean> {
    const discardRestore = parseChromiumDiscardRestore(restore);
    if (!discardRestore || !this.lifecycle) return true;
    const { tokenId } = discardRestore;
    const record = this.sleeping.get(tokenId);
    if (!record) return true;
    await record.settled;
    const removed = await this.onLane(
      tokenId,
      async () => this.sleeping.get(tokenId) !== record || (await this.removeSleeping(record, 1)),
    );
    if (!removed) {
      // K6: not proven gone. The token stays, so a later release asks again, and the background
      // drain retries within its bound or reports the removal unconfirmed; the name stays guarded.
      this.giveUp(tokenId);
      return false;
    }
    this.forget(tokenId, record);
    return true;
  }

  /**
   * M2: the lane owns a wake to its end. It wakes the one tab carrying the sleep's name, inside
   * one deadline, and takes its page (ownership and publication) only right after checking that
   * the wake is still wanted, the name is still on exactly one tab, and that tab is this live
   * page's exact target; nothing is awaited between that check and the take. Then the name goes.
   * Abandoned, the tab is left asleep under its name (put back to sleep if it loaded). Failed, the
   * tab is removed with evidence and `null` returned, so the caller opens it by address; a removal
   * not proven throws instead, and the tab stays guarded. No wake leaves a page nobody owns.
   */
  private async wakeOnLane(
    tokenId: string,
    record: SleepingTab,
    deadline: number,
    signal: AbortSignal | undefined,
    own: ((page: BrowserPage) => void) | undefined,
  ): Promise<BrowserPage | null> {
    const lifecycle = this.lifecycle!;
    const current = () =>
      this.sleeping.get(tokenId) === record &&
      !this.removals.has(tokenId) &&
      !this.unremovable.has(tokenId) &&
      !this.closed;
    const abandoned = () => signal?.aborted === true || this.closed;
    if (abandoned()) throw notWanted();
    if (!current()) {
      // A sleep already given up: opened by address only once its tab is proven removed.
      if (this.sleeping.get(tokenId) !== record) return null;
      if (!(await this.removeSleeping(record, 1)))
        throw new Error("The sleeping tab is not proven removed yet.");
      this.forget(tokenId, record);
      return null;
    }
    const wake = armWake();
    try {
      if (!record.named || performance.now() >= deadline) throw new Error("The wake ran out.");
      const rows = await this.read(deadline);
      const named = rows ? findNamed(rows, record.title) : null;
      if (named?.kind !== "one") throw new Error("The named tab is not exactly one tab.");
      const { row } = named;
      this.wakes.set(record.title, wake);
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
      if (candidate) wake.arrive(candidate, row);
      if (abandoned() || !current()) throw notWanted();
      if (!candidate || row.discarded || row.status === "unloaded") {
        const reply = await withTimeout(
          lifecycle.activateByTabId(row.tabId),
          remainingMs(deadline),
          { timeoutError: () => new Error("Activating sleeping Chromium tab timed out.") },
        );
        // K2: Chromium's own answer names the tab the read named, loaded (seen on real Chromium).
        if (!reply.ok || reply.tabId !== row.tabId || reply.discarded)
          throw new Error("Chromium did not activate the named tab.");
      }
      await withTimeout(wake.settled, remainingMs(deadline), {
        timeoutError: () => new Error("Waking sleeping Chromium tab timed out."),
      });
      const arrived = wake.arrived;
      if (!arrived || wake.spoiled) throw new Error("The woken tab was not the one tab named.");
      const targetId = await lookupTargetId(this.context, arrived.page, deadline);
      const last = await this.read(deadline);
      const now = last ? findNamed(last, record.title) : null;
      if (abandoned() || !current()) throw notWanted();
      // The last check at the take, on the candidate shortcut too; the take follows at once.
      if (
        wake.spoiled ||
        now?.kind !== "one" ||
        targetId === null ||
        now.row.targetId !== targetId ||
        now.row.tabId !== row.tabId ||
        arrived.page.isClosed() ||
        this.ending.has(arrived.page) ||
        performance.now() >= deadline
      )
        throw new Error("The woken tab was not the one tab named.");
      this.forget(tokenId, record);
      this.publish(arrived.page, false);
      const handle = this.wrap(arrived.page);
      own?.(handle);
      // L2: the name goes once the tab is taken. Kept, it is harmless: the tab is awake and named
      // until its next sleep names it anew.
      if (!(await lifecycle.unnameTab(now.row.tabId).catch(() => false)))
        process.stderr.write('{"event":"browser-runtime.sleep-name-kept"}\n');
      return handle;
    } catch (error) {
      if (this.wakes.get(record.title) === wake) this.wakes.delete(record.title);
      if (!current()) throw error;
      if (abandoned()) {
        // Left asleep under its name; a tab that loaded meanwhile is put back to sleep.
        await this.sleepAgain(tokenId);
        throw error;
      }
      // Failed: the tab is removed with evidence before anything opens it by address.
      if (await this.removeSleeping(record, 3)) {
        this.forget(tokenId, record);
        return null;
      }
      this.giveUp(tokenId);
      throw error;
    } finally {
      if (this.wakes.get(record.title) === wake) this.wakes.delete(record.title);
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
  private async openFreshPage(signal: AbortSignal | undefined): Promise<Page> {
    const opening = withTimeout(this.context.newPage(), openPageMs, {
      timeoutError: () => new Error("Opening a page timed out."),
    });
    this.openingPages.add(opening);
    try {
      const page = await opening;
      if (signal?.aborted) {
        // Abandoned while it opened: nobody takes it, so it is closed here.
        void this.closePageWithEvidence(page);
        throw notWanted();
      }
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
    const signal = options?.signal;
    await this.beforeCreatePage?.().catch(() => undefined);
    if (signal?.aborted) throw notWanted();
    const discardRestore = parseChromiumDiscardRestore(options?.restore);
    if (discardRestore && this.lifecycle) {
      const { tokenId } = discardRestore;
      const record = this.sleeping.get(tokenId);
      if (record) {
        // M2: this waits for the lane's own outcome; it opens nothing while the lane may take.
        const deadline = performance.now() + wakeDiscardedTabMs;
        const woken = await this.onLane(tokenId, () =>
          this.wakeOnLane(tokenId, record, deadline, signal, options?.own),
        );
        if (woken) return woken;
      }
      if (signal?.aborted) throw notWanted();
      // The tab could not be woken and is proven gone: a fresh page, which the ledger navigates
      // to the tab's address on its awaited path.
      const fallback = this.wrap(await this.openFreshPage(signal));
      fallback.openedFresh = true;
      options?.own?.(fallback);
      return fallback;
    }
    const handle = this.wrap(await this.openFreshPage(signal));
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
  /** A wake could not bring the tab back; this fresh page is navigated to its address. */
  openedFresh = false;
  /** The sleep this page was put to, whose lane a later close attempt waits on. */
  private sleepToken: string | null = null;
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
    if (sleepDiscard && this.contextHandle.lifecycle) this.sleepToken = sleepDiscard.tokenId;
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
      // M3: a page put to sleep is closed again only on its sleep's lane, after the sleep.
      if (this.sleepToken)
        return this.contextHandle.onSleepLane(this.sleepToken, () => this.closeAround());
      await this.closeAround();
    })();
    return operation;
  }

  /** A later close attempt goes around Playwright, to the browser's own target close. */
  private async closeAround(): Promise<void> {
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
