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
import type { BrowserSurfaceId } from "@opensteer/protocol/browser";
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

import {
  deleteTabRestoreSidecar,
  flushNativeCookies,
  initializeNativePreferences,
  matchRestoredTabs,
  readTabRestoreSidecar,
  writeTabRestoreSidecar,
  type MatchedRestoredTab,
  type TabRestoreSidecarEntry,
} from "./native-profile-storage.js";

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
        // ignoreDefaultArgs drops Playwright's --disable-field-trial-config; without it
        // Chrome for Testing enables TrackEmptyRendererProcessesForReuse and holds closed
        // tab renderers alive past TabSleeper's settle window.
        "--disable-field-trial-config",
        // Load only Opensteer's minimal internal tab-lifecycle helper (tabs + debugger,
        // zero host permissions) for native profiles; every other extension stays disabled.
        `--disable-extensions-except=${lifecycleExtensionDir}`,
        `--load-extension=${lifecycleExtensionDir}`,
        "--disable-component-extensions-with-background-pages",
        "--disable-component-update",
        "--disable-background-networking",
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
      let helperTargetId: string | null = syncTargetIdOfPage(helper);
      const matchedRestored = new Map<BrowserSurfaceId, MatchedRestoredTab>();
      if (candidateLifecycle) {
        if (!helperTargetId) {
          try {
            const helperCdp = await context.newCDPSession(helper);
            try {
              const info = (await helperCdp.send("Target.getTargetInfo")) as {
                targetInfo?: { targetId?: unknown };
              };
              helperTargetId =
                typeof info.targetInfo?.targetId === "string" ? info.targetInfo.targetId : null;
            } finally {
              await helperCdp.detach().catch(() => undefined);
            }
          } catch {
            helperTargetId = null;
          }
        }
        const removeLaunchTabWithEvidence = async (
          lc: ChromiumTabLifecycleBridge,
          tabId: number,
          targetId: string | null,
        ): Promise<boolean> => {
          for (let attempt = 0; attempt < 3; attempt++) {
            const removed = await lc.removeByTabId(tabId).catch(() => false);
            if (removed) {
              const check = await lc.inventory().catch(() => null);
              if (check && !check.some((entry) => entry.tabId === tabId)) return true;
            } else {
              const check = await lc.inventory().catch(() => null);
              if (check && !check.some((entry) => entry.tabId === tabId)) return true;
            }
            if (targetId) {
              const closed = await withTimeout(
                browserCdp.send("Target.closeTarget", { targetId }),
                2_000,
                { timeoutError: () => new Error("Launch Target.closeTarget timed out.") },
              ).then(
                () => true,
                () => false,
              );
              if (closed) {
                const check = await lc.inventory().catch(() => null);
                if (check && !check.some((entry) => entry.tabId === tabId)) return true;
              }
            }
            if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 40));
          }
          return false;
        };
        const initialInventory = await candidateLifecycle.inventory().catch(() => null);
        if (initialInventory !== null) {
          lifecycle = candidateLifecycle;
          const rawRestored: ChromiumTabEntry[] = [];
          for (const tab of initialInventory) {
            if (tab.targetId !== null && tab.targetId === helperTargetId) continue;
            if (isInternalExtensionUrl(tab.url)) continue;
            if (tab.url === "" || tab.url === "about:blank" || tab.url === "chrome://newtab/") {
              const confirmed = await removeLaunchTabWithEvidence(
                lifecycle,
                tab.tabId,
                tab.targetId,
              );
              if (!confirmed) {
                throw new Error("Chromium restored unauthorized tabs that could not be removed.");
              }
              continue;
            }
            rawRestored.push(tab);
          }
          if (rawRestored.length > 0) {
            const sidecar = await readTabRestoreSidecar(directory);
            const { matched, orphans } = matchRestoredTabs(rawRestored, sidecar);
            for (const orphan of orphans) {
              const confirmed = await removeLaunchTabWithEvidence(
                lifecycle,
                orphan.tabId,
                orphan.targetId,
              );
              if (!confirmed) {
                throw new Error("Chromium restored unauthorized tabs that could not be removed.");
              }
            }
            for (const [surfaceId, entry] of matched) {
              matchedRestored.set(surfaceId as BrowserSurfaceId, entry);
            }
          }
        } else {
          // Fail closed when launch inventory fails: never leave unowned restored tabs alive.
          process.stderr.write(
            '{"event":"browser-runtime.tab-lifecycle-unavailable","stage":"launch-inventory"}\n',
          );
          // This run cannot keep the map current, so no later start may bind by it.
          await deleteTabRestoreSidecar(directory).catch(() => {
            process.stderr.write('{"event":"browser-runtime.tab-map-delete-failed"}\n');
          });
          for (const page of context.pages()) {
            if (page === helper || page.isClosed()) continue;
            await page.close({ runBeforeUnload: false }).catch(() => undefined);
          }
          let confirmedClean = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            const targets = (await withTimeout(browserCdp.send("Target.getTargets"), 2_000, {
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
            if (survivors.length === 0) {
              confirmedClean = true;
              break;
            }
            for (const info of survivors) {
              await withTimeout(
                browserCdp.send("Target.closeTarget", { targetId: info.targetId }),
                2_000,
                { timeoutError: () => new Error("Launch Target.closeTarget timed out.") },
              ).catch(() => undefined);
            }
            if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 40));
          }
          if (!confirmedClean) {
            throw new Error("Chromium restored unauthorized tabs that could not be removed.");
          }
        }
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
        directory,
        matchedRestored,
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
    profileDirectory?: string,
    matchedRestored: ReadonlyMap<BrowserSurfaceId, MatchedRestoredTab> = new Map(),
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
      profileDirectory,
      matchedRestored,
      preHelperPages,
      privatePageTargetId,
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
    this.contextHandle.markClosed();
    // Before Chromium writes its clean session: a map that is not current must not survive it.
    await this.contextHandle.retireSidecarBeforeClose();
    const detached = await Promise.allSettled([
      withTimeout((this.cdp as PlaywrightBrowserCdpBackend).close(), 500, {
        timeoutError: () => new Error("Browser CDP detach did not finish."),
      }),
    ]);
    const stopped = await Promise.allSettled([this.owner.close()]);
    // Best-effort drain of any in-flight sidecar write after the browser stops so
    // temp-dir cleanup never races a write, without failing close on a crashed helper.
    await withTimeout(this.contextHandle.drainSidecar(), 500, {
      timeoutError: () => new Error("Sidecar flush did not finish."),
    }).catch(() => undefined);
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

const wakeDiscardedTabMs = 10_000;
/** Consecutive failed map writes, since the last success, after which the map is deleted. */
const sidecarFailureBound = 3;
/** How long close waits for a map write in flight before deleting the map. */
const sidecarCloseWaitMs = 500;
/** How long a claim waits for a parked run on its surface before giving the tab up. */
const claimQueueWaitMs = 6_000;

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

type TabWhereabouts =
  | { readonly status: "found"; readonly row: ChromiumTabEntry }
  | { readonly status: "gone" }
  | { readonly status: "unknown" };

/**
 * Where the tab last seen as `tabId` (in a row the helper answered at `epoch`) is now. A discard
 * can replace a tab, so a row replaced from it any number of times is that tab. "Gone" needs the
 * same helper worker: a restarted one has forgotten earlier replacements, so its silence is
 * "not known" (Rule A), never "gone".
 */
function locateTab(
  inventory: readonly ChromiumTabEntry[],
  tabId: number,
  epoch: string | undefined,
): TabWhereabouts {
  const row = inventory.find(
    (entry) => entry.tabId === tabId || entry.replacedFromTabIds?.includes(tabId) === true,
  );
  if (row) return { status: "found", row };
  return inventory[0]?.helperEpoch === epoch ? { status: "gone" } : { status: "unknown" };
}

function syncOpenerOfPage(page: Page): Page | null {
  const opener = (page as unknown as { _opener?: Page | null })._opener;
  return opener && !opener.isClosed() ? opener : null;
}

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

  readonly authenticator: PasskeyAuthenticator | undefined;
  readonly providerConfig: BrowserPagePolicyConfig;
  readonly lifecycle: ChromiumTabLifecycleBridge | undefined;
  readonly sessionRestore: BrowserSessionRestore | undefined;
  private readonly profileDirectory: string | undefined;
  private readonly privatePage: Page | undefined;
  private readonly helperTargetId: string | undefined;
  private readonly sleepingTabs = new Map<
    string,
    | {
        readonly state: "discarding";
        readonly url: string;
        readonly surfaceId?: BrowserSurfaceId;
        readonly settled: Promise<number | null>;
      }
    | {
        readonly state: "discarded";
        readonly tabId: number;
        readonly url: string;
        readonly surfaceId?: BrowserSurfaceId;
      }
    | {
        readonly state: "unknown";
        readonly originalTabId: number;
        /** The helper worker that saw `originalTabId` before the discard. */
        readonly epoch: string | undefined;
        readonly url: string;
        readonly surfaceId?: BrowserSurfaceId;
      }
  >();
  private readonly pendingSleepingRemovals = new Map<string, { attempts: number }>();
  private pendingRemovalTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pendingRestoredRemovals = new Map<
    number,
    { targetId: string | null; epoch: string | undefined; attempts: number }
  >();
  private pendingRestoredRemovalTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly claimedWakePages = new WeakSet<Page>();
  private readonly hiddenRestoredPages = new WeakSet<Page>();
  private readonly frozenRestoredPages = new WeakSet<Page>();
  private readonly unclaimedRestoredTabs = new Map<number, ChromiumTabEntry>();
  private readonly unclaimedRestoredTargetIds = new Set<string>();
  /** Targets from session restore that must NEVER be handed off unless explicitly claimed or confirmed gone. */
  private readonly neverHandOffTargetIds = new Set<string>();
  /** Restored tabs whose targetId was initially null so arrivals are still hidden by tabId. */
  private readonly neverHandOffTabIds = new Set<number>();
  private readonly restoredPagesByTabId = new Map<number, Page>();
  private readonly restoredBySurfaceId = new Map<BrowserSurfaceId, MatchedRestoredTab>();
  private readonly claimingSurfaceIds = new Set<BrowserSurfaceId>();
  private readonly removingSurfaceIds = new Set<BrowserSurfaceId>();
  private readonly parkedDiscardTails = new Map<BrowserSurfaceId, Promise<void>>();
  private parkedDiscardActive = 0;
  private readonly parkedDiscardWaiters: Array<() => void> = [];
  private parkedAutoDiscardArmed = false;
  private readonly savedTabsBySurfaceId = new Map<
    BrowserSurfaceId,
    { page: PlaywrightPageHandle | null; sleepingTokenId?: string }
  >();
  private readonly savedSurfaceByPage = new WeakMap<PlaywrightPageHandle, BrowserSurfaceId>();
  private readonly trackedNavigationPages = new WeakSet<Page>();
  private readonly inFlightDiscards = new Set<Promise<void>>();
  private reconcileTail: Promise<void> = Promise.resolve();
  private reconcileAbort: AbortController | undefined;
  private reconcileFallbackTimer: ReturnType<typeof setTimeout> | undefined;
  private sidecarTail: Promise<void> = Promise.resolve();
  private sidecarDirty = false;
  private sidecarScheduled = false;
  private sidecarVersion = 0;
  private sidecarFailures = 0;
  private sidecarRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private creatingNewPage = 0;
  private wakeTail: Promise<void> = Promise.resolve();
  private activeWake: {
    readonly tabId: number;
    readonly expectedTargetId: string | null;
    readonly resolve: (page: Page) => void;
  } | null = null;

  constructor(
    context: PlaywrightBrowserContext,
    openDialogs: Map<Page, Dialog>,
    authenticator?: PasskeyAuthenticator,
    providerConfig?: BrowserPagePolicyConfig,
    privatePage?: Page,
    lifecycle?: ChromiumTabLifecycleBridge,
    profileDirectory?: string,
    matchedRestored: ReadonlyMap<BrowserSurfaceId, MatchedRestoredTab> = new Map(),
    preHelperPages: ReadonlySet<Page> = new Set(),
    helperTargetId?: string,
  ) {
    this.privatePage = privatePage;
    this.helperTargetId = helperTargetId;
    this.lifecycle = lifecycle;
    this.profileDirectory = profileDirectory;
    this.authenticator = authenticator;
    this.providerConfig = providerConfig;
    this.context = context;
    for (const page of preHelperPages) {
      if (page !== privatePage) {
        this.hiddenRestoredPages.add(page);
        const preTargetId = syncTargetIdOfPage(page);
        if (preTargetId) this.neverHandOffTargetIds.add(preTargetId);
      }
    }
    for (const [surfaceId, entry] of matchedRestored) {
      this.restoredBySurfaceId.set(surfaceId, entry);
      this.unclaimedRestoredTabs.set(entry.tab.tabId, entry.tab);
      if (entry.tab.targetId) {
        this.unclaimedRestoredTargetIds.add(entry.tab.targetId);
        this.neverHandOffTargetIds.add(entry.tab.targetId);
      } else {
        this.neverHandOffTabIds.add(entry.tab.tabId);
      }
    }
    if (lifecycle && profileDirectory) {
      this.sessionRestore = {
        claim: (surfaceId, url, own) => this.claimSavedRestoredTab(surfaceId, url, own),
        reconcile: (savedTabIds) => this.reconcileSavedTabs(savedTabIds),
        armFallbackReconcile: (keepIds, delayMs = 5_000) =>
          this.armFallbackReconcile(keepIds, delayMs),
        trackSavedTab: (surfaceId, page) => this.trackSavedTab(surfaceId, page),
        flush: () => this.flushSavedTabsOrDeleteMap(),
      };
      // The map on disk was written by an earlier run and is not yet confirmed for this one.
      this.sidecarDirty = true;
    }
    context.on("close", () => {
      this.markClosed();
      // A context's end ends its pages even when Playwright reports no page close.
      for (const handle of this.pagesByPlaywrightPage.values()) handle.confirmGone("context");
    });
    context.on("page", (page) => {
      if (this.isHiddenPage(page)) return;
      const targetId = syncTargetIdOfPage(page);
      const opener = syncOpenerOfPage(page);
      if (opener) {
        const openerTargetId = syncTargetIdOfPage(opener);
        if (
          this.isHiddenPage(opener) ||
          (openerTargetId !== null && this.neverHandOffTargetIds.has(openerTargetId))
        ) {
          this.hiddenRestoredPages.add(page);
          if (targetId) this.neverHandOffTargetIds.add(targetId);
          void page.close({ runBeforeUnload: false }).catch(() => undefined);
          return;
        }
      }
      if (this.activeWake && opener === null && this.creatingNewPage === 0) {
        const waiter = this.activeWake;
        if (waiter.expectedTargetId !== null && targetId === waiter.expectedTargetId) {
          this.activeWake = null;
          this.hiddenRestoredPages.delete(page);
          this.claimedWakePages.add(page);
          waiter.resolve(page);
          return;
        }
        if (waiter.expectedTargetId === null || targetId === null) {
          // Verify identity strictly against expectedTargetId or Chromium's tabId inventory
          // before claiming, so a concurrent unrelated page is never stolen by activeWake.
          void (async () => {
            const resolvedTargetId = targetId ?? (await this.targetIdOfPage(page));
            let matched = false;
            if (this.activeWake === waiter && resolvedTargetId) {
              if (waiter.expectedTargetId !== null) {
                matched = resolvedTargetId === waiter.expectedTargetId;
              } else if (this.lifecycle) {
                const inv = await this.lifecycle.inventory().catch(() => null);
                const tabEntry = inv?.find((entry) => entry.tabId === waiter.tabId);
                matched = tabEntry?.targetId === resolvedTargetId;
              }
            }
            if (matched && this.activeWake === waiter) {
              this.activeWake = null;
              this.hiddenRestoredPages.delete(page);
              this.claimedWakePages.add(page);
              waiter.resolve(page);
              return;
            }
            if (resolvedTargetId && this.neverHandOffTargetIds.has(resolvedTargetId)) {
              this.handleHiddenRestoredPageArrival(page, resolvedTargetId);
              return;
            }
            if (this.claimedWakePages.has(page) || this.hiddenRestoredPages.has(page)) return;
            const delayedHandle = this.wrap(page);
            for (const listener of this.handOffs)
              listener(delayedHandle, delayedHandle.openerHandle);
            for (const listener of this.pageListeners) listener(delayedHandle);
          })();
          return;
        }
      }
      if (targetId && this.neverHandOffTargetIds.has(targetId)) {
        this.handleHiddenRestoredPageArrival(page, targetId);
        return;
      }
      if (opener === null && this.creatingNewPage === 0 && this.neverHandOffTabIds.size > 0) {
        // Guard restored tabs whose initial inventory row had no targetId: hide synchronously
        // until inventory confirms whether this page belongs to an unclaimed restored tab.
        this.hiddenRestoredPages.add(page);
        void (async () => {
          const resolvedTargetId = targetId ?? (await this.targetIdOfPage(page));
          if (this.claimedWakePages.has(page) || this.closed) return;
          if (resolvedTargetId && this.neverHandOffTargetIds.has(resolvedTargetId)) {
            this.handleHiddenRestoredPageArrival(page, resolvedTargetId);
            return;
          }
          if (resolvedTargetId && this.lifecycle) {
            const inv = await this.lifecycle.inventory().catch(() => null);
            const matchedTab = inv?.find((entry) => entry.targetId === resolvedTargetId);
            if (
              matchedTab &&
              (this.neverHandOffTabIds.has(matchedTab.tabId) ||
                this.unclaimedRestoredTabs.has(matchedTab.tabId))
            ) {
              this.neverHandOffTabIds.delete(matchedTab.tabId);
              this.neverHandOffTargetIds.add(resolvedTargetId);
              if (this.unclaimedRestoredTabs.has(matchedTab.tabId)) {
                this.unclaimedRestoredTabs.set(matchedTab.tabId, matchedTab);
                this.unclaimedRestoredTargetIds.add(resolvedTargetId);
              }
              for (const [surfaceId, entry] of this.restoredBySurfaceId) {
                if (entry.tab.tabId === matchedTab.tabId) {
                  this.restoredBySurfaceId.set(surfaceId, { ...entry, tab: matchedTab });
                  break;
                }
              }
              this.handleHiddenRestoredPageArrival(page, resolvedTargetId);
              return;
            }
          }
          if (this.claimedWakePages.has(page) || this.closed) return;
          this.hiddenRestoredPages.delete(page);
          const delayedHandle = this.wrap(page);
          for (const listener of this.handOffs) listener(delayedHandle, delayedHandle.openerHandle);
          for (const listener of this.pageListeners) listener(delayedHandle);
        })();
        return;
      }
      const handle = this.wrap(page);
      if (opener) {
        if (!handle.openerHandle) handle.openerHandle = this.wrap(opener);
        for (const listener of this.handOffs) listener(handle, handle.openerHandle);
      } else {
        queueMicrotask(() => {
          if (this.claimedWakePages.has(page) || this.hiddenRestoredPages.has(page)) return;
          if (!targetId && this.neverHandOffTargetIds.size > 0) {
            void this.targetIdOfPage(page).then((resolved) => {
              if (this.claimedWakePages.has(page) || this.hiddenRestoredPages.has(page)) return;
              if (resolved && this.neverHandOffTargetIds.has(resolved)) {
                this.handleHiddenRestoredPageArrival(page, resolved);
                return;
              }
              for (const listener of this.handOffs) listener(handle, handle.openerHandle);
            });
            return;
          }
          for (const listener of this.handOffs) listener(handle, handle.openerHandle);
        });
      }
      for (const listener of this.pageListeners) listener(handle);
    });
    this.openDialogs = openDialogs;
  }

  private isHiddenPage(page: Page): boolean {
    if (page === this.privatePage) return true;
    if (this.hiddenRestoredPages.has(page)) return true;
    const url = typeof page.url === "function" ? page.url() : "";
    return isInternalExtensionUrl(url);
  }

  private async targetIdOfPage(page: Page): Promise<string | null> {
    const synced = syncTargetIdOfPage(page);
    if (synced) return synced;
    if (page.isClosed()) return null;
    let session: PlaywrightCdpSession | undefined;
    try {
      session = await withTimeout(this.context.newCDPSession(page), nameTargetMs, {
        timeoutError: () => new Error("Target lookup CDP attach timed out."),
      });
      const response = (await withTimeout(session.send("Target.getTargetInfo"), nameTargetMs, {
        timeoutError: () => new Error("Target lookup getTargetInfo timed out."),
      })) as { targetInfo?: { targetId?: unknown } };
      return typeof response.targetInfo?.targetId === "string"
        ? response.targetInfo.targetId
        : null;
    } catch {
      return null;
    } finally {
      await session?.detach().catch(() => undefined);
    }
  }

  /**
   * Removes the tab last seen as `tabId` and proves it gone. Where a discard may have replaced
   * it (`replaceable`, with the helper epoch of that sighting), the tab is followed through its
   * replacements, and "no row has that id" is evidence only from the same helper worker or right
   * after this removal of the tab itself succeeded.
   */
  private async removeTabWithEvidence(
    tabId: number,
    targetId: string | null,
    attempts = 3,
    replaceable?: { readonly epoch: string | undefined },
  ): Promise<boolean> {
    if (!this.lifecycle) return false;
    let currentId = tabId;
    let currentTargetId = targetId;
    const where = (check: readonly ChromiumTabEntry[]): TabWhereabouts =>
      replaceable
        ? locateTab(check, tabId, replaceable.epoch)
        : locateTab(check, tabId, check[0]?.helperEpoch);
    // Following a replacement is not a failed attempt; a chain is short, and this bounds it.
    let follows = 4;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const removed = await this.lifecycle.removeByTabId(currentId).catch(() => false);
      const check = await this.lifecycle.inventory().catch(() => null);
      if (check) {
        const found = where(check);
        if (found.status === "gone") return true;
        // Removing this id succeeded, so it was not replaced before the removal.
        if (found.status === "unknown" && removed) return true;
        if (found.status === "found" && found.row.tabId !== currentId && follows-- > 0) {
          currentId = found.row.tabId;
          currentTargetId = found.row.targetId ?? currentTargetId;
          attempt--;
          continue;
        }
      }
      if (currentTargetId && this.closeTarget) {
        const targetClosed = await this.closeTarget(currentTargetId).then(
          () => true,
          () => false,
        );
        if (targetClosed) {
          const after = await this.lifecycle.inventory().catch(() => null);
          if (after && where(after).status === "gone") return true;
        }
      }
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    }
    return false;
  }

  private armFallbackReconcile(keepIds: ReadonlySet<BrowserSurfaceId>, delayMs: number): void {
    if (this.closed || this.restoredBySurfaceId.size === 0) return;
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
        // Deadline passed (R5/B3, Rule B): fence the timed-out body and give up every restored tab
        // nobody is claiming, so the session goes on opening tabs by address. Each one stays
        // hidden and is removed on its own surface's queue, after any run there; a removal the
        // body already started finishes inside that queue and records its own failure.
        abort.abort();
        for (const [surfaceId, entry] of Array.from(this.restoredBySurfaceId)) {
          if (this.claimingSurfaceIds.has(surfaceId)) continue;
          void this.queueEviction(surfaceId, entry).catch(() => undefined);
        }
        this.parkedAutoDiscardArmed = true;
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

  private async reconcileSavedTabsOnce(
    savedTabIds: ReadonlySet<BrowserSurfaceId>,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.lifecycle || !this.profileDirectory || signal.aborted || this.closed) return;
    let failedRemovals = 0;
    for (const [surfaceId] of Array.from(this.restoredBySurfaceId)) {
      if (signal.aborted || this.closed) return;
      if (savedTabIds.has(surfaceId) || this.claimingSurfaceIds.has(surfaceId)) continue;
      this.removingSurfaceIds.add(surfaceId);
      try {
        const confirmed = await this.runOnParkedSurfaceQueue(surfaceId, async () => {
          if (signal.aborted || this.closed || this.claimingSurfaceIds.has(surfaceId)) return true;
          const latest = this.restoredBySurfaceId.get(surfaceId);
          if (!latest) return true;
          return (await this.evictUnparkableRestoredTab(surfaceId, latest)) === 0;
        });
        if (!confirmed) failedRemovals++;
      } finally {
        this.removingSurfaceIds.delete(surfaceId);
      }
    }
    if (signal.aborted || this.closed) return;
    if (this.restoredBySurfaceId.size > 0) {
      const parkFailed = await this.parkUnclaimedRestoredTabs(signal);
      failedRemovals += parkFailed;
    }
    if (signal.aborted || this.closed) return;
    this.scheduleSidecarWrite();
    if (failedRemovals > 0) {
      throw new Error("Chromium restored unauthorized tabs that could not be removed.");
    }
  }

  /**
   * Keeps never-loaded `status: "unloaded"` parked tabs untouched so their
   * `sessionStorage` survives, and schedules background bounded-concurrency
   * discards for any kept parked tab Chromium has already loaded (off the
   * critical path to ready so slow guests never trip the reconcile deadline).
   * Arms automatic discard whenever an unloaded parked tab comes alive later.
   */
  private async parkUnclaimedRestoredTabs(signal: AbortSignal): Promise<number> {
    if (!this.lifecycle || this.restoredBySurfaceId.size === 0 || signal.aborted || this.closed) {
      return 0;
    }
    let failedRemovals = 0;
    const inventory = await this.lifecycle.inventory().catch(() => null);
    if (signal.aborted || this.closed) return 0;
    if (!inventory) {
      // Not known is never "absent" (B2): give every unclaimed tab up now, remove on its queue.
      this.parkedAutoDiscardArmed = true;
      const evictions: Promise<number>[] = [];
      for (const [surfaceId, entry] of Array.from(this.restoredBySurfaceId)) {
        if (this.claimingSurfaceIds.has(surfaceId)) continue;
        evictions.push(this.queueEviction(surfaceId, entry));
      }
      for (const failed of await Promise.all(evictions)) failedRemovals += failed;
      return failedRemovals;
    }
    for (const [surfaceId, entry] of Array.from(this.restoredBySurfaceId)) {
      if (signal.aborted || this.closed) return 0;
      if (this.claimingSurfaceIds.has(surfaceId)) continue;
      const where = locateTab(inventory, entry.tab.tabId, entry.tab.helperEpoch);
      if (where.status === "unknown") {
        failedRemovals += await this.queueEviction(surfaceId, entry);
        continue;
      }
      const current = where.status === "found" ? where.row : undefined;
      if (!current) {
        this.restoredBySurfaceId.delete(surfaceId);
        this.unclaimedRestoredTabs.delete(entry.tab.tabId);
        if (entry.tab.targetId) {
          this.unclaimedRestoredTargetIds.delete(entry.tab.targetId);
          this.neverHandOffTargetIds.delete(entry.tab.targetId);
        }
        this.restoredPagesByTabId.delete(entry.tab.tabId);
        continue;
      }
      if (current.targetId) {
        this.neverHandOffTargetIds.add(current.targetId);
        this.unclaimedRestoredTargetIds.add(current.targetId);
      }
      if (current.discarded) {
        this.restoredBySurfaceId.set(surfaceId, { ...entry, tab: current });
        this.unclaimedRestoredTabs.set(current.tabId, current);
        this.restoredPagesByTabId.delete(current.tabId);
        continue;
      }
      const hasLivePage =
        this.restoredPagesByTabId.has(current.tabId) ||
        (current.targetId !== null &&
          this.context
            .pages()
            .some(
              (candidate) =>
                candidate !== this.privatePage &&
                !candidate.isClosed() &&
                syncTargetIdOfPage(candidate) === current.targetId,
            ));
      if (current.status === "unloaded" && !current.active && !hasLivePage) {
        // Inert unloaded tab: leave untouched so Chromium keeps its SessionStorageNamespace
        // intact. If Chromium's background loader brings it alive later before a session claims
        // it, handleHiddenRestoredPageArrival discards it immediately.
        this.restoredBySurfaceId.set(surfaceId, { ...entry, tab: current });
        this.unclaimedRestoredTabs.set(current.tabId, current);
        continue;
      }
      // Take already-loaded parked tab discards off the path to ready with bounded concurrency.
      void this.enqueueParkedDiscard(surfaceId, { initialCurrent: current });
    }
    this.parkedAutoDiscardArmed = true;
    // Sweep any parked tab whose Playwright Page arrived while the loop above ran.
    for (const [surfaceId, entry] of Array.from(this.restoredBySurfaceId)) {
      if (this.claimingSurfaceIds.has(surfaceId) || entry.tab.discarded) continue;
      const arrivedPage = this.restoredPagesByTabId.get(entry.tab.tabId);
      if (arrivedPage && !arrivedPage.isClosed()) {
        void this.enqueueParkedDiscard(surfaceId, { page: arrivedPage, waitForLoad: true });
      }
    }
    return failedRemovals;
  }

  private async withParkedDiscardSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.parkedDiscardActive >= 4 && !this.closed) {
      await new Promise<void>((resolve) => {
        this.parkedDiscardWaiters.push(resolve);
      });
    }
    this.parkedDiscardActive++;
    try {
      return await fn();
    } finally {
      this.parkedDiscardActive--;
      const next = this.parkedDiscardWaiters.shift();
      next?.();
    }
  }

  private handleHiddenRestoredPageArrival(page: Page, targetId: string): void {
    this.hiddenRestoredPages.add(page);
    if (!this.unclaimedRestoredTargetIds.has(targetId)) {
      // A surviving orphan or failed-removal tab arrived late: close it and never hand it off.
      void page.close({ runBeforeUnload: false }).catch(() => undefined);
      return;
    }
    let matchedSurfaceId: BrowserSurfaceId | undefined;
    for (const [surfaceId, entry] of this.restoredBySurfaceId) {
      if (entry.tab.targetId === targetId) {
        matchedSurfaceId = surfaceId;
        this.restoredPagesByTabId.set(entry.tab.tabId, page);
        break;
      }
    }
    if (!matchedSurfaceId) {
      for (const tab of this.unclaimedRestoredTabs.values()) {
        if (tab.targetId === targetId) {
          this.restoredPagesByTabId.set(tab.tabId, page);
          break;
        }
      }
      return;
    }
    if (this.parkedAutoDiscardArmed && !this.claimingSurfaceIds.has(matchedSurfaceId)) {
      void this.enqueueParkedDiscard(matchedSurfaceId, { page, waitForLoad: true });
    }
  }

  /**
   * Serializes every discard or reconcile removal for one parked `surfaceId` so
   * reconcile, background-loader arrivals, and `claimSavedRestoredTab` never race
   * on the same tabId or replacement tabId.
   */
  private runOnParkedSurfaceQueue<T>(
    surfaceId: BrowserSurfaceId,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.parkedDiscardTails.get(surfaceId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    const tracked = tail.finally(() => {
      if (this.parkedDiscardTails.get(surfaceId) === tracked) {
        this.parkedDiscardTails.delete(surfaceId);
      }
    });
    this.parkedDiscardTails.set(surfaceId, tracked);
    return run;
  }

  private enqueueParkedDiscard(
    surfaceId: BrowserSurfaceId,
    options?: {
      readonly page?: Page;
      readonly waitForLoad?: boolean;
      readonly initialCurrent?: ChromiumTabEntry;
    },
  ): Promise<number> {
    if (
      this.closed ||
      !this.lifecycle ||
      this.claimingSurfaceIds.has(surfaceId) ||
      this.removingSurfaceIds.has(surfaceId)
    ) {
      return Promise.resolve(0);
    }
    const hadPriorTail = this.parkedDiscardTails.has(surfaceId);
    return this.runOnParkedSurfaceQueue(surfaceId, () =>
      this.withParkedDiscardSlot(async (): Promise<number> => {
        if (
          this.closed ||
          !this.lifecycle ||
          this.claimingSurfaceIds.has(surfaceId) ||
          this.removingSurfaceIds.has(surfaceId) ||
          !this.restoredBySurfaceId.has(surfaceId)
        ) {
          return 0;
        }
        const page = options?.page;
        if (
          options?.waitForLoad &&
          page &&
          !page.isClosed() &&
          typeof page.waitForLoadState === "function"
        ) {
          // Let Chromium finish restoring PageState and attaching SessionStorageNamespace
          // (bounded tightly) so discarding keeps scroll, form controls, and sessionStorage.
          await page.waitForLoadState("load", { timeout: 1_000 }).catch(() => undefined);
        }
        if (
          this.closed ||
          !this.lifecycle ||
          this.claimingSurfaceIds.has(surfaceId) ||
          this.removingSurfaceIds.has(surfaceId) ||
          !this.restoredBySurfaceId.has(surfaceId)
        ) {
          return 0;
        }
        const entry = this.restoredBySurfaceId.get(surfaceId);
        if (!entry) return 0;
        let current: ChromiumTabEntry | undefined;
        if (
          !hadPriorTail &&
          !options?.waitForLoad &&
          options?.initialCurrent &&
          options.initialCurrent.tabId === entry.tab.tabId
        ) {
          current = options.initialCurrent;
        } else {
          const inv = await this.readInventoryWithRetry(surfaceId, 3);
          if (
            this.closed ||
            !this.lifecycle ||
            this.claimingSurfaceIds.has(surfaceId) ||
            this.removingSurfaceIds.has(surfaceId) ||
            !this.restoredBySurfaceId.has(surfaceId)
          ) {
            return 0;
          }
          if (inv === null) {
            // Unreadable inventory is "unknown", never "absent": close any live Playwright page
            // directly, keep the target in neverHandOffTargetIds, and retry removal in background.
            return await this.evictUnparkableRestoredTab(
              surfaceId,
              entry,
              page ? { page } : undefined,
            );
          }
          const where = locateTab(inv, entry.tab.tabId, entry.tab.helperEpoch);
          if (where.status === "unknown") {
            return await this.evictUnparkableRestoredTab(
              surfaceId,
              entry,
              page ? { page } : undefined,
            );
          }
          current = where.status === "found" ? where.row : undefined;
        }
        if (!current) {
          if (this.restoredBySurfaceId.get(surfaceId)?.tab.tabId === entry.tab.tabId) {
            this.restoredBySurfaceId.delete(surfaceId);
            this.unclaimedRestoredTabs.delete(entry.tab.tabId);
            if (entry.tab.targetId) {
              this.unclaimedRestoredTargetIds.delete(entry.tab.targetId);
              this.neverHandOffTargetIds.delete(entry.tab.targetId);
            }
            this.restoredPagesByTabId.delete(entry.tab.tabId);
          }
          return 0;
        }
        if (current.discarded) {
          if (current.targetId) {
            this.unclaimedRestoredTargetIds.add(current.targetId);
            this.neverHandOffTargetIds.add(current.targetId);
          }
          this.restoredBySurfaceId.set(surfaceId, { ...entry, tab: current });
          this.unclaimedRestoredTabs.set(current.tabId, current);
          this.restoredPagesByTabId.delete(current.tabId);
          return 0;
        }
        return await this.discardParkedRestoredTab(surfaceId, entry, current, {
          skipLoadWait: Boolean(options?.waitForLoad),
          ...(page ? { page } : {}),
        });
      }),
    );
  }

  private async readInventoryWithRetry(
    surfaceId: BrowserSurfaceId,
    attempts = 3,
  ): Promise<readonly ChromiumTabEntry[] | null> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (
        this.closed ||
        !this.lifecycle ||
        this.claimingSurfaceIds.has(surfaceId) ||
        !this.restoredBySurfaceId.has(surfaceId)
      ) {
        return null;
      }
      const inv = await this.lifecycle.inventory().catch(() => null);
      if (inv !== null) return inv;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
    return null;
  }

  private findLivePageForRestoredTab(
    tabId: number,
    targetId: string | null,
    preferred?: Page,
  ): Page | undefined {
    if (preferred && !preferred.isClosed()) return preferred;
    const cached = this.restoredPagesByTabId.get(tabId);
    if (cached && !cached.isClosed()) return cached;
    if (targetId) {
      for (const candidate of this.context.pages()) {
        if (candidate === this.privatePage || candidate.isClosed()) continue;
        if (syncTargetIdOfPage(candidate) === targetId) return candidate;
      }
    }
    return undefined;
  }

  private enqueuePendingRestoredRemoval(
    tabId: number,
    targetId: string | null,
    epoch: string | undefined,
  ): void {
    if (this.closed) return;
    if (targetId) this.neverHandOffTargetIds.add(targetId);
    if (!this.pendingRestoredRemovals.has(tabId)) {
      this.pendingRestoredRemovals.set(tabId, { targetId, epoch, attempts: 0 });
    }
    this.schedulePendingRestoredRemovalRetry();
  }

  private schedulePendingRestoredRemovalRetry(): void {
    if (
      this.closed ||
      this.pendingRestoredRemovalTimer ||
      this.pendingRestoredRemovals.size === 0
    ) {
      return;
    }
    let maxAttempts = 0;
    for (const item of this.pendingRestoredRemovals.values()) {
      maxAttempts = Math.max(maxAttempts, item.attempts);
    }
    const delayMs = Math.min(2_000, 100 * 2 ** Math.min(maxAttempts, 4));
    this.pendingRestoredRemovalTimer = setTimeout(() => {
      this.pendingRestoredRemovalTimer = undefined;
      void this.drainPendingRestoredRemovals().catch(() => undefined);
    }, delayMs);
    this.pendingRestoredRemovalTimer.unref?.();
  }

  private async drainPendingRestoredRemovals(): Promise<void> {
    if (this.closed || !this.lifecycle) return;
    for (const [tabId, tracker] of Array.from(this.pendingRestoredRemovals)) {
      if (this.closed) return;
      tracker.attempts++;
      const livePage = this.findLivePageForRestoredTab(tabId, tracker.targetId);
      if (livePage) {
        await livePage.close({ runBeforeUnload: false }).catch(() => undefined);
      }
      const confirmed = await this.removeTabWithEvidence(tabId, tracker.targetId, 1, {
        epoch: tracker.epoch,
      });
      if (confirmed) {
        if (tracker.targetId) this.neverHandOffTargetIds.delete(tracker.targetId);
        this.pendingRestoredRemovals.delete(tabId);
      }
    }
    if (this.pendingRestoredRemovals.size > 0 && !this.closed) {
      this.schedulePendingRestoredRemovalRetry();
    }
  }

  /**
   * Takes the entry from every claim at once; its page stays hidden and its targets stay
   * never-hand-off, and the close and removal run on the surface's queue, after any run there.
   */
  private queueEviction(
    surfaceId: BrowserSurfaceId,
    entry: MatchedRestoredTab,
    options?: Parameters<PlaywrightContextHandle["evictUnparkableRestoredTab"]>[2],
  ): Promise<number> {
    this.restoredBySurfaceId.delete(surfaceId);
    if (entry.tab.targetId) this.neverHandOffTargetIds.add(entry.tab.targetId);
    else this.neverHandOffTabIds.add(entry.tab.tabId);
    return this.runOnParkedSurfaceQueue(surfaceId, () =>
      this.evictUnparkableRestoredTab(surfaceId, entry, options),
    );
  }

  private async evictUnparkableRestoredTab(
    surfaceId: BrowserSurfaceId,
    entry: MatchedRestoredTab,
    options?: {
      readonly page?: Page;
      readonly latestTabId?: number;
      readonly latestTargetId?: string | null;
      readonly latestEpoch?: string | undefined;
    },
  ): Promise<number> {
    const tabId = options?.latestTabId ?? entry.tab.tabId;
    const targetId = options?.latestTargetId ?? entry.tab.targetId;
    const epoch = options?.latestTabId !== undefined ? options.latestEpoch : entry.tab.helperEpoch;
    if (entry.tab.targetId) this.neverHandOffTargetIds.add(entry.tab.targetId);
    if (targetId) this.neverHandOffTargetIds.add(targetId);

    const livePage =
      this.findLivePageForRestoredTab(tabId, targetId, options?.page) ??
      this.findLivePageForRestoredTab(entry.tab.tabId, entry.tab.targetId, options?.page);

    this.restoredBySurfaceId.delete(surfaceId);
    this.unclaimedRestoredTabs.delete(entry.tab.tabId);
    this.unclaimedRestoredTabs.delete(tabId);
    if (entry.tab.targetId) this.unclaimedRestoredTargetIds.delete(entry.tab.targetId);
    if (targetId) this.unclaimedRestoredTargetIds.delete(targetId);
    this.restoredPagesByTabId.delete(entry.tab.tabId);
    this.restoredPagesByTabId.delete(tabId);

    if (livePage && !livePage.isClosed()) {
      await livePage.close({ runBeforeUnload: false }).catch(() => undefined);
    }

    const confirmed = await this.removeTabWithEvidence(tabId, targetId, 3, { epoch });
    if (confirmed) {
      if (entry.tab.targetId) this.neverHandOffTargetIds.delete(entry.tab.targetId);
      if (targetId) this.neverHandOffTargetIds.delete(targetId);
      this.scheduleSidecarWrite();
      return 0;
    }
    this.enqueuePendingRestoredRemoval(tabId, targetId, epoch);
    return 1;
  }

  private async discardParkedRestoredTab(
    surfaceId: BrowserSurfaceId,
    entry: MatchedRestoredTab,
    current: ChromiumTabEntry,
    options?: { readonly skipLoadWait?: boolean; readonly page?: Page },
  ): Promise<number> {
    if (!this.lifecycle || this.closed) return 0;
    if (this.claimingSurfaceIds.has(surfaceId) || !this.restoredBySurfaceId.has(surfaceId)) {
      return 0;
    }
    if (current.active) {
      await this.activatePrivateAnchor();
    }
    let frozePage: Page | undefined;
    if (current.status !== "unloaded" && current.targetId) {
      frozePage = await this.freezeRestoredTabBeforeDiscard(
        current.tabId,
        current.targetId,
        current.status,
        options?.skipLoadWait,
      );
    }
    if (
      this.closed ||
      this.claimingSurfaceIds.has(surfaceId) ||
      this.removingSurfaceIds.has(surfaceId) ||
      !this.restoredBySurfaceId.has(surfaceId)
    ) {
      // The entry was claimed, given up or removed meanwhile: what this run froze it unfreezes,
      // whoever holds the page now.
      if (frozePage && !frozePage.isClosed() && !this.closed) {
        await this.unfreezeRestoredPage(frozePage);
      }
      return 0;
    }
    const discardResult =
      typeof this.lifecycle.discardByTabIdDetailed === "function"
        ? await this.lifecycle.discardByTabIdDetailed(current.tabId).catch(() => null)
        : await this.lifecycle
            .discardByTabId(current.tabId)
            .then((newTabId) => (newTabId !== null ? { newTabId, newTargetId: null } : null))
            .catch(() => null);
    if (discardResult !== null) {
      const { newTabId, newTargetId } = discardResult;
      this.unclaimedRestoredTabs.delete(entry.tab.tabId);
      if (entry.tab.targetId) {
        this.unclaimedRestoredTargetIds.delete(entry.tab.targetId);
        this.neverHandOffTargetIds.delete(entry.tab.targetId);
      }
      if (current.targetId) {
        this.unclaimedRestoredTargetIds.delete(current.targetId);
        this.neverHandOffTargetIds.delete(current.targetId);
      }
      this.restoredPagesByTabId.delete(entry.tab.tabId);
      const stillTracked = this.restoredBySurfaceId.has(surfaceId);
      if (!stillTracked) {
        // Entry was evicted (e.g., deadline timeout) while discard was in flight: do not
        // resurrect it; remove the replacement tabId with evidence instead.
        if (newTargetId) this.neverHandOffTargetIds.add(newTargetId);
        const removed = await this.removeTabWithEvidence(newTabId, newTargetId, 3, {
          epoch: current.helperEpoch,
        });
        if (removed) {
          if (newTargetId) this.neverHandOffTargetIds.delete(newTargetId);
        } else {
          this.enqueuePendingRestoredRemoval(newTabId, newTargetId, current.helperEpoch);
        }
        return 0;
      }
      if (newTargetId) {
        this.unclaimedRestoredTargetIds.add(newTargetId);
        this.neverHandOffTargetIds.add(newTargetId);
      }
      const parked: ChromiumTabEntry = {
        ...current,
        tabId: newTabId,
        active: false,
        discarded: true,
        status: "unloaded",
        targetId: newTargetId,
      };
      this.restoredBySurfaceId.set(surfaceId, { ...entry, tab: parked });
      this.unclaimedRestoredTabs.set(newTabId, parked);
      this.scheduleSidecarWrite();
      return 0;
    }
    const recheck = await this.readInventoryWithRetry(surfaceId, 3);
    if (
      this.closed ||
      this.claimingSurfaceIds.has(surfaceId) ||
      !this.restoredBySurfaceId.has(surfaceId)
    ) {
      return 0;
    }
    if (recheck === null) {
      return await this.evictUnparkableRestoredTab(surfaceId, entry, {
        ...(options?.page ? { page: options.page } : {}),
        latestTabId: current.tabId,
        latestTargetId: current.targetId,
      });
    }
    // The discard may have committed and replaced the tab before the helper failed.
    const where = locateTab(recheck, current.tabId, current.helperEpoch);
    if (where.status === "unknown") {
      return await this.evictUnparkableRestoredTab(surfaceId, entry, {
        ...(options?.page ? { page: options.page } : {}),
        latestTabId: current.tabId,
        latestTargetId: current.targetId,
        latestEpoch: current.helperEpoch,
      });
    }
    const after = where.status === "found" ? where.row : undefined;
    if (!after) {
      if (this.restoredBySurfaceId.get(surfaceId)?.tab.tabId === entry.tab.tabId) {
        this.restoredBySurfaceId.delete(surfaceId);
        this.unclaimedRestoredTabs.delete(entry.tab.tabId);
        if (entry.tab.targetId) {
          this.unclaimedRestoredTargetIds.delete(entry.tab.targetId);
          this.neverHandOffTargetIds.delete(entry.tab.targetId);
        }
        if (current.targetId) this.neverHandOffTargetIds.delete(current.targetId);
        this.restoredPagesByTabId.delete(entry.tab.tabId);
      }
      return 0;
    }
    if (after.discarded || (after.targetId === null && after.status === "unloaded")) {
      if (after.targetId) {
        this.unclaimedRestoredTargetIds.add(after.targetId);
        this.neverHandOffTargetIds.add(after.targetId);
      }
      this.restoredBySurfaceId.set(surfaceId, { ...entry, tab: after });
      this.unclaimedRestoredTabs.set(after.tabId, after);
      this.restoredPagesByTabId.delete(after.tabId);
      return 0;
    }
    // Still live and could not be discarded: close so it opens by address when claimed.
    return await this.evictUnparkableRestoredTab(surfaceId, entry, {
      ...(options?.page ? { page: options.page } : {}),
      latestTabId: after.tabId,
      latestTargetId: after.targetId,
    });
  }

  /**
   * Flushes Blink's restored PageState (scroll, form controls) back into
   * Chromium's NavigationEntry before discarding an already-loaded parked tab.
   */
  private async freezeRestoredTabBeforeDiscard(
    tabId: number,
    targetId: string,
    status: string,
    skipLoadWait = false,
  ): Promise<Page | undefined> {
    const findPage = (): Page | undefined => {
      const cached = this.restoredPagesByTabId.get(tabId);
      if (cached && !cached.isClosed()) return cached;
      for (const candidate of this.context.pages()) {
        if (candidate === this.privatePage || candidate.isClosed()) continue;
        if (syncTargetIdOfPage(candidate) === targetId) return candidate;
      }
      return undefined;
    };
    let page = findPage();
    if (!skipLoadWait && (status === "loading" || !page)) {
      // Chromium's BackgroundTabLoadingPolicy may have started loading a few restored tabs
      // before reconcile runs. Bound the wait tightly so slow remote sites never stall
      // reconciliation while fast pages finish restoring Blink FormController state before freeze.
      const deadline = performance.now() + 500;
      while (performance.now() < deadline) {
        page = findPage();
        if (page) {
          const remaining = Math.max(25, Math.floor(deadline - performance.now()));
          if (typeof page.waitForLoadState === "function") {
            await page.waitForLoadState("load", { timeout: remaining }).catch(() => undefined);
          }
          break;
        }
        const inv = await this.lifecycle?.inventory().catch(() => null);
        const entry = inv?.find((tab) => tab.tabId === tabId);
        if (!entry || entry.discarded || entry.status === "unloaded") return undefined;
        if (entry.status === "complete") {
          page = findPage();
          if (page) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    page ??= findPage();
    if (!page || page.isClosed()) return undefined;
    let session: PlaywrightCdpSession | undefined;
    try {
      session = await withTimeout(this.context.newCDPSession(page), 1_000, {
        timeoutError: () => new Error("Freeze parked tab CDP attach timed out."),
      });
      // Mark before sending freeze so even an uncertain/timed-out freeze must be explicitly unfrozen on claim.
      this.frozenRestoredPages.add(page);
      await withTimeout(session.send("Page.setWebLifecycleState", { state: "frozen" }), 1_000, {
        timeoutError: () => new Error("Freeze parked tab timed out."),
      });
      return page;
    } catch {
      // Best-effort flush; discard still proceeds so no unowned page stays live.
      return undefined;
    } finally {
      await session?.detach().catch(() => undefined);
    }
  }

  private async unfreezeRestoredPage(page: Page): Promise<boolean> {
    if (page.isClosed()) {
      this.frozenRestoredPages.delete(page);
      return false;
    }
    let session: PlaywrightCdpSession | undefined;
    try {
      session = await withTimeout(this.context.newCDPSession(page), 1_000, {
        timeoutError: () => new Error("Unfreeze parked tab CDP attach timed out."),
      });
      await withTimeout(session.send("Page.setWebLifecycleState", { state: "active" }), 1_000, {
        timeoutError: () => new Error("Unfreeze parked tab timed out."),
      });
      this.frozenRestoredPages.delete(page);
      return true;
    } catch {
      return false;
    } finally {
      await session?.detach().catch(() => undefined);
    }
  }

  private async claimSavedRestoredTab(
    surfaceId: BrowserSurfaceId,
    url?: string,
    own?: (page: BrowserPage) => void,
  ): Promise<BrowserPage | null> {
    if (!this.lifecycle || !this.restoredBySurfaceId.has(surfaceId)) return null;
    this.claimingSurfaceIds.add(surfaceId);
    try {
      const pendingPark = this.parkedDiscardTails.get(surfaceId);
      if (pendingPark) {
        const settled = await withTimeout(
          pendingPark.then(() => true),
          claimQueueWaitMs,
          { timeoutError: () => new Error("Pending parked discard wait timed out.") },
        ).catch(() => false);
        if (!settled) {
          // Rule B: the run on this surface is still in its freeze or discard, so the claim gives
          // the tab up instead of taking it beside that run. The tab opens by address; its
          // restored page stays hidden and is removed after the run, on the same queue.
          const abandoned = this.restoredBySurfaceId.get(surfaceId);
          if (abandoned) void this.queueEviction(surfaceId, abandoned).catch(() => undefined);
          return null;
        }
      }
      const entry = this.restoredBySurfaceId.get(surfaceId);
      if (!entry) return null;
      this.restoredBySurfaceId.delete(surfaceId);
      if (url !== undefined && entry.tab.url !== url) {
        void this.queueEviction(surfaceId, entry).catch(() => undefined);
        return null;
      }
      try {
        const restoredPage = await this.claimRestoredTab(entry.tab);
        this.neverHandOffTabIds.delete(entry.tab.tabId);
        if (entry.tab.targetId) this.neverHandOffTargetIds.delete(entry.tab.targetId);
        const handle = this.wrap(restoredPage);
        handle.restoredFromSession = true;
        this.trackSavedTab(surfaceId, handle);
        own?.(handle);
        return handle;
      } catch {
        void this.queueEviction(surfaceId, entry).catch(() => undefined);
        return null;
      }
    } finally {
      this.claimingSurfaceIds.delete(surfaceId);
    }
  }

  private trackSavedTab(surfaceId: BrowserSurfaceId, page: BrowserPage | null): void {
    if (page === null) {
      const existing = this.savedTabsBySurfaceId.get(surfaceId);
      if (existing?.page) this.savedSurfaceByPage.delete(existing.page);
      this.savedTabsBySurfaceId.delete(surfaceId);
      this.restoredBySurfaceId.delete(surfaceId);
      this.scheduleSidecarWrite();
      return;
    }
    if (!(page instanceof PlaywrightPageHandle)) return;
    const existing = this.savedTabsBySurfaceId.get(surfaceId);
    if (existing?.page && existing.page !== page) {
      this.savedSurfaceByPage.delete(existing.page);
    }
    this.savedTabsBySurfaceId.set(surfaceId, { page });
    this.savedSurfaceByPage.set(page, surfaceId);
    const rawPage = page.rawPage;
    if (!this.trackedNavigationPages.has(rawPage)) {
      this.trackedNavigationPages.add(rawPage);
      rawPage.on("framenavigated", (frame) => {
        if (frame === rawPage.mainFrame()) this.scheduleSidecarWrite();
      });
    }
    this.scheduleSidecarWrite();
  }

  markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.reconcileAbort?.abort();
    this.reconcileAbort = undefined;
    for (const wake of this.parkedDiscardWaiters.splice(0)) wake();
    if (this.reconcileFallbackTimer) {
      clearTimeout(this.reconcileFallbackTimer);
      this.reconcileFallbackTimer = undefined;
    }
    if (this.pendingRemovalTimer) {
      clearTimeout(this.pendingRemovalTimer);
      this.pendingRemovalTimer = undefined;
    }
    if (this.pendingRestoredRemovalTimer) {
      clearTimeout(this.pendingRestoredRemovalTimer);
      this.pendingRestoredRemovalTimer = undefined;
    }
    if (this.sidecarRetryTimer) {
      clearTimeout(this.sidecarRetryTimer);
      this.sidecarRetryTimer = undefined;
    }
    this.pendingSleepingRemovals.clear();
    this.pendingRestoredRemovals.clear();
    this.sleepingTabs.clear();
    this.unclaimedRestoredTabs.clear();
    this.unclaimedRestoredTargetIds.clear();
    this.neverHandOffTargetIds.clear();
    this.neverHandOffTabIds.clear();
    this.restoredPagesByTabId.clear();
    this.restoredBySurfaceId.clear();
    this.claimingSurfaceIds.clear();
    this.removingSurfaceIds.clear();
    this.parkedDiscardTails.clear();
    this.parkedAutoDiscardArmed = false;
    this.savedTabsBySurfaceId.clear();
  }

  drainSidecar(): Promise<void> {
    return this.sidecarTail;
  }

  private scheduleSidecarWrite(): void {
    if (!this.lifecycle || !this.profileDirectory || this.closed) return;
    this.sidecarVersion++;
    this.sidecarDirty = true;
    // The failure count is not reset here: only a successful write resets it (Rule C).
    if (this.sidecarRetryTimer) {
      clearTimeout(this.sidecarRetryTimer);
      this.sidecarRetryTimer = undefined;
    }
    if (this.sidecarScheduled) return;
    this.sidecarScheduled = true;
    queueMicrotask(() => {
      this.sidecarScheduled = false;
      void this.flushSavedTabs().catch(() => undefined);
    });
  }

  /** The map is gone, so nothing stale is on disk; a later change makes it dirty again. */
  private async deleteSidecarMap(): Promise<void> {
    if (!this.profileDirectory) return;
    try {
      await deleteTabRestoreSidecar(this.profileDirectory);
      this.sidecarDirty = false;
    } catch {
      process.stderr.write('{"event":"browser-runtime.tab-map-delete-failed"}\n');
    }
  }

  /**
   * The Home's orderly flush before Chromium closes: the map is brought current, or deleted.
   * A second attempt covers a change that landed during the first write.
   */
  private async flushSavedTabsOrDeleteMap(): Promise<void> {
    if (!this.lifecycle || !this.profileDirectory || this.closed) return;
    for (let attempt = 0; attempt < 2 && this.sidecarDirty && !this.closed; attempt++) {
      await this.flushSavedTabs().catch(() => undefined);
    }
    if (this.sidecarDirty && !this.closed) await this.deleteSidecarMap();
  }

  /**
   * Runs after `markClosed` and before Chromium closes: a map that is not current is deleted,
   * so Chromium's clean session file never sits beside a stale map. A write that was already
   * past its last check may still land; a second delete is chained behind it for that case.
   */
  async retireSidecarBeforeClose(): Promise<void> {
    if (!this.lifecycle || !this.profileDirectory) return;
    let writeInFlight = false;
    const dirty = await withTimeout(
      this.sidecarTail.then(() => this.sidecarDirty),
      sidecarCloseWaitMs,
      { timeoutError: () => new Error("Tab map write did not settle before close.") },
    ).catch(() => {
      writeInFlight = true;
      return true;
    });
    if (!dirty) return;
    await this.deleteSidecarMap();
    if (!writeInFlight) return;
    // The late write clears this only if it succeeds, and versions no longer move once closed.
    this.sidecarDirty = true;
    this.sidecarTail = this.sidecarTail.then(async () => {
      if (this.sidecarDirty) await this.deleteSidecarMap();
    });
  }

  private scheduleSidecarRetry(): void {
    if (this.closed || this.sidecarRetryTimer) return;
    const delayMs = 100 * this.sidecarFailures;
    this.sidecarRetryTimer = setTimeout(() => {
      this.sidecarRetryTimer = undefined;
      if (this.closed || !this.sidecarDirty) return;
      void this.flushSavedTabs().catch(() => undefined);
    }, delayMs);
    this.sidecarRetryTimer.unref?.();
  }

  trackInFlightDiscard(operation: Promise<void>): void {
    this.inFlightDiscards.add(operation);
    void operation.finally(() => {
      this.inFlightDiscards.delete(operation);
    });
  }

  private flushSavedTabs(): Promise<void> {
    if (!this.lifecycle || !this.profileDirectory || this.closed) return this.sidecarTail;
    this.sidecarDirty = true;
    const write = this.sidecarTail.then(async () => {
      if (this.inFlightDiscards.size > 0) {
        await Promise.allSettled(this.inFlightDiscards);
      }
      if (!this.sidecarDirty || this.closed || !this.lifecycle || !this.profileDirectory) return;
      const writeVersion = this.sidecarVersion;
      const handleFailure = async (): Promise<void> => {
        if (this.closed || !this.profileDirectory) return;
        this.sidecarDirty = true;
        this.sidecarFailures++;
        if (this.sidecarFailures < sidecarFailureBound) {
          this.scheduleSidecarRetry();
          return;
        }
        // Cannot bring the sidecar current: delete the stale map so a later cold start matches
        // nothing and opens by address instead of binding a stale slot. The count stays until a
        // write succeeds, so every further failure deletes again (an absent map stays absent).
        await this.deleteSidecarMap();
      };
      const inventory = await this.lifecycle.inventory().catch(() => null);
      if (this.closed) return;
      if (!inventory) {
        await handleFailure();
        return;
      }
      const byTargetId = new Map<string, { surfaceId: string; url: string }>();
      const byTabId = new Map<number, { surfaceId: string; url: string }>();
      for (const [surfaceId, saved] of this.savedTabsBySurfaceId) {
        if (saved.page && !saved.page.isClosed()) {
          const targetId = await saved.page.targetId().catch(() => null);
          if (targetId) {
            byTargetId.set(targetId, {
              surfaceId,
              url: saved.page.url() || "",
            });
          }
        } else if (saved.sleepingTokenId) {
          const sleeping = this.sleepingTabs.get(saved.sleepingTokenId);
          if (sleeping?.state === "discarded") {
            byTabId.set(sleeping.tabId, {
              surfaceId,
              url: sleeping.url,
            });
          }
        }
      }
      for (const [surfaceId, parked] of this.restoredBySurfaceId) {
        if (!byTabId.has(parked.tab.tabId)) {
          byTabId.set(parked.tab.tabId, {
            surfaceId,
            url: parked.tab.url,
          });
        }
      }
      const orderedInventory = [...inventory].sort(
        (a, b) => a.windowId - b.windowId || a.index - b.index,
      );
      const entries: TabRestoreSidecarEntry[] = [];
      const seenSurfaceIds = new Set<string>();
      for (const tab of orderedInventory) {
        if (tab.targetId !== null && tab.targetId === this.helperTargetId) continue;
        if (isInternalExtensionUrl(tab.url)) continue;
        if (tab.url === "" || tab.url === "about:blank" || tab.url === "chrome://newtab/") continue;
        const matched =
          (tab.targetId ? byTargetId.get(tab.targetId) : undefined) ?? byTabId.get(tab.tabId);
        if (matched && !seenSurfaceIds.has(matched.surfaceId)) {
          seenSurfaceIds.add(matched.surfaceId);
          entries.push({
            index: entries.length,
            surfaceId: matched.surfaceId,
            url: tab.url || matched.url,
          });
        } else {
          // Record unsaved/agent tabs as strip-order placeholders so crash drift can never bind them to saved tabs.
          entries.push({
            index: entries.length,
            surfaceId: null,
            url: tab.url,
          });
        }
      }
      if (this.closed) return;
      try {
        await writeTabRestoreSidecar(this.profileDirectory, entries);
        this.sidecarFailures = 0;
        if (this.sidecarVersion === writeVersion) {
          this.sidecarDirty = false;
        } else {
          this.scheduleSidecarWrite();
        }
      } catch {
        await handleFailure();
      }
    });
    this.sidecarTail = write.catch(() => undefined);
    return write;
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

  private async claimRestoredTab(tab: ChromiumTabEntry): Promise<Page> {
    const ensureUnfrozen = async (page: Page): Promise<void> => {
      if (!this.frozenRestoredPages.has(page)) return;
      const unfrozen = await this.unfreezeRestoredPage(page);
      if (!unfrozen) {
        await page.close({ runBeforeUnload: false }).catch(() => undefined);
        throw new Error("Restored tab remained frozen and could not be unfrozen.");
      }
    };
    try {
      const cached = this.restoredPagesByTabId.get(tab.tabId);
      this.restoredPagesByTabId.delete(tab.tabId);
      if (cached && !cached.isClosed()) {
        await ensureUnfrozen(cached);
        this.hiddenRestoredPages.delete(cached);
        this.claimedWakePages.add(cached);
        await this.ensurePagePolicyOnRestoredPage(cached);
        return cached;
      }
      if (tab.targetId) {
        for (const candidate of this.context.pages()) {
          if (candidate === this.privatePage || candidate.isClosed()) continue;
          const candidateTargetId = await this.targetIdOfPage(candidate);
          if (candidateTargetId === tab.targetId) {
            await ensureUnfrozen(candidate);
            this.hiddenRestoredPages.delete(candidate);
            this.claimedWakePages.add(candidate);
            await this.ensurePagePolicyOnRestoredPage(candidate);
            return candidate;
          }
        }
      }
      const woken = await this.wakeDiscardedTab(tab.tabId);
      await ensureUnfrozen(woken);
      this.hiddenRestoredPages.delete(woken);
      this.claimedWakePages.add(woken);
      await this.ensurePagePolicyOnRestoredPage(woken);
      return woken;
    } finally {
      this.unclaimedRestoredTabs.delete(tab.tabId);
      this.neverHandOffTabIds.delete(tab.tabId);
      if (tab.targetId) this.unclaimedRestoredTargetIds.delete(tab.targetId);
      this.restoredPagesByTabId.delete(tab.tabId);
    }
  }

  async activatePrivateAnchor(): Promise<void> {
    if (!this.privatePage || this.privatePage.isClosed()) return;
    await withTimeout(this.privatePage.bringToFront(), nameTargetMs, {
      timeoutError: () => new Error("Private anchor bringToFront timed out."),
    }).catch(() => undefined);
  }

  beginSleepingTab(
    tokenId: string,
    url: string,
    pageHandle: PlaywrightPageHandle | undefined,
    settled: Promise<number | null>,
  ): void {
    const surfaceId = pageHandle ? this.savedSurfaceByPage.get(pageHandle) : undefined;
    this.sleepingTabs.set(tokenId, {
      state: "discarding",
      url,
      settled,
      ...(surfaceId ? { surfaceId } : {}),
    });
    this.trackInFlightDiscard(
      settled.then(
        () => undefined,
        () => undefined,
      ),
    );
    if (surfaceId) {
      this.savedTabsBySurfaceId.set(surfaceId, {
        page: null,
        sleepingTokenId: tokenId,
      });
      this.scheduleSidecarWrite();
    }
  }

  finishSleepingTab(
    tokenId: string,
    newTabId: number | null,
    unknownOutcome?: {
      readonly originalTabId: number;
      readonly epoch: string | undefined;
    },
  ): void {
    const current = this.sleepingTabs.get(tokenId);
    if (!current) return;
    if (newTabId === null) {
      if (unknownOutcome) {
        // Unknown discard outcome: keep tracking the token by tabId only so release/wake
        // reconciles and removes any surviving tab without ever matching another owner's tab.
        this.sleepingTabs.set(tokenId, {
          state: "unknown",
          originalTabId: unknownOutcome.originalTabId,
          epoch: unknownOutcome.epoch,
          url: current.url,
          ...(current.surfaceId ? { surfaceId: current.surfaceId } : {}),
        });
        return;
      }
      this.sleepingTabs.delete(tokenId);
      return;
    }
    this.sleepingTabs.set(tokenId, {
      state: "discarded",
      tabId: newTabId,
      url: current.url,
      ...(current.surfaceId ? { surfaceId: current.surfaceId } : {}),
    });
    if (current.surfaceId) this.scheduleSidecarWrite();
  }

  private async resolveUnknownSleepingTabId(probe: {
    readonly originalTabId: number;
    readonly epoch: string | undefined;
  }): Promise<TabWhereabouts> {
    if (!this.lifecycle) return { status: "unknown" };
    const after = await this.lifecycle.inventory().catch(() => null);
    if (!after) return { status: "unknown" };
    return locateTab(after, probe.originalTabId, probe.epoch);
  }

  private enqueuePendingSleepingRemoval(tokenId: string): void {
    if (this.closed) return;
    if (!this.pendingSleepingRemovals.has(tokenId)) {
      this.pendingSleepingRemovals.set(tokenId, { attempts: 0 });
    }
    this.schedulePendingRemovalRetry();
  }

  private schedulePendingRemovalRetry(): void {
    if (this.closed || this.pendingRemovalTimer || this.pendingSleepingRemovals.size === 0) return;
    let maxAttempts = 0;
    for (const item of this.pendingSleepingRemovals.values()) {
      maxAttempts = Math.max(maxAttempts, item.attempts);
    }
    const delayMs = Math.min(2_000, 100 * 2 ** Math.min(maxAttempts, 4));
    this.pendingRemovalTimer = setTimeout(() => {
      this.pendingRemovalTimer = undefined;
      void this.drainPendingSleepingRemovals().catch(() => undefined);
    }, delayMs);
    this.pendingRemovalTimer.unref?.();
  }

  private async drainPendingSleepingRemovals(): Promise<void> {
    if (this.closed || !this.lifecycle) return;
    for (const [tokenId, tracker] of this.pendingSleepingRemovals) {
      if (this.closed) return;
      const sleeping = this.sleepingTabs.get(tokenId);
      if (!sleeping) {
        this.pendingSleepingRemovals.delete(tokenId);
        continue;
      }
      tracker.attempts++;
      const removed = await this.attemptSleepingRemoval(tokenId, sleeping);
      if (removed) {
        this.sleepingTabs.delete(tokenId);
        this.pendingSleepingRemovals.delete(tokenId);
      }
    }
    if (this.pendingSleepingRemovals.size > 0 && !this.closed) {
      this.schedulePendingRemovalRetry();
    }
  }

  private async attemptSleepingRemoval(
    _tokenId: string,
    sleeping:
      | { readonly state: "discarded"; readonly tabId: number }
      | {
          readonly state: "unknown";
          readonly originalTabId: number;
          readonly epoch: string | undefined;
        }
      | { readonly state: "discarding"; readonly settled: Promise<number | null> },
  ): Promise<boolean> {
    if (sleeping.state === "discarding") {
      const tabId = await sleeping.settled;
      if (tabId === null) {
        const refreshed = this.sleepingTabs.get(_tokenId);
        if (refreshed?.state === "unknown") {
          return this.attemptSleepingRemoval(_tokenId, refreshed);
        }
        return true;
      }
      return this.removeTabWithEvidence(tabId, null, 1);
    }
    if (sleeping.state === "unknown") {
      const probed = await this.resolveUnknownSleepingTabId(sleeping);
      if (probed.status === "gone") return true;
      if (probed.status === "unknown") return false;
      return this.removeTabWithEvidence(probed.row.tabId, probed.row.targetId, 1, {
        epoch: probed.row.helperEpoch,
      });
    }
    return this.removeTabWithEvidence(sleeping.tabId, null, 1);
  }

  async releaseRestore(restore: unknown): Promise<boolean> {
    const discardRestore = parseChromiumDiscardRestore(restore);
    if (!discardRestore || !this.lifecycle) return true;
    const sleeping = this.sleepingTabs.get(discardRestore.tokenId);
    if (!sleeping) return true;
    if (sleeping.surfaceId) {
      this.savedTabsBySurfaceId.delete(sleeping.surfaceId);
      this.scheduleSidecarWrite();
    }
    const removed = await this.attemptSleepingRemoval(discardRestore.tokenId, sleeping);
    if (removed) {
      this.sleepingTabs.delete(discardRestore.tokenId);
      this.pendingSleepingRemovals.delete(discardRestore.tokenId);
      return true;
    }
    // Keep the tab owned and keep retrying in the background until confirmed gone.
    this.enqueuePendingSleepingRemoval(discardRestore.tokenId);
    return false;
  }

  private wakeDiscardedTab(tabId: number): Promise<Page> {
    const run = this.wakeTail.then(() => this.wakeDiscardedTabOnce(tabId));
    this.wakeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async wakeDiscardedTabOnce(tabId: number): Promise<Page> {
    const lifecycle = this.lifecycle;
    if (!lifecycle) throw new Error("Tab lifecycle helper is unavailable.");
    const inventory = await lifecycle.inventory();
    const entry = inventory.find((tab) => tab.tabId === tabId);
    if (!entry) throw new Error("Sleeping Chromium tab no longer exists.");

    const cached = this.restoredPagesByTabId.get(tabId);
    if (cached && !cached.isClosed()) {
      this.hiddenRestoredPages.delete(cached);
      this.claimedWakePages.add(cached);
      await lifecycle.activateByTabId(tabId).catch(() => undefined);
      return cached;
    }
    if (entry.targetId) {
      for (const candidate of this.context.pages()) {
        if (candidate === this.privatePage || candidate.isClosed()) continue;
        if (isInternalExtensionUrl(typeof candidate.url === "function" ? candidate.url() : "")) {
          continue;
        }
        const candidateTargetId = await this.targetIdOfPage(candidate);
        if (candidateTargetId && candidateTargetId === entry.targetId) {
          this.hiddenRestoredPages.delete(candidate);
          this.claimedWakePages.add(candidate);
          await lifecycle.activateByTabId(tabId).catch(() => undefined);
          return candidate;
        }
      }
    }

    const waiterPromise = Promise.withResolvers<Page>();
    const waiter = {
      tabId,
      expectedTargetId: entry.targetId,
      resolve: (page: Page) => waiterPromise.resolve(page),
    };
    this.activeWake = waiter;
    try {
      const activated = await lifecycle.activateByTabId(tabId);
      if (!activated) throw new Error("Chromium could not activate sleeping tab.");

      return await withTimeout(waiterPromise.promise, wakeDiscardedTabMs, {
        timeoutError: () => new Error("Waking sleeping Chromium tab timed out."),
      });
    } finally {
      if (this.activeWake === waiter) this.activeWake = null;
    }
  }

  handOff(listener: (page: BrowserPage, opener: BrowserPage | null) => void): () => void {
    this.handOffs.add(listener);
    for (const page of this.context.pages()) {
      if (this.isHiddenPage(page) || page.isClosed()) continue;
      const handle = this.wrap(page);
      listener(handle, handle.openerHandle);
    }
    return () => this.handOffs.delete(listener);
  }

  pages(): BrowserPage[] {
    return this.context
      .pages()
      .filter((page) => !this.isHiddenPage(page))
      .map((page) => this.wrap(page));
  }

  private async openFreshPage(): Promise<Page> {
    this.creatingNewPage++;
    try {
      return await this.context.newPage();
    } finally {
      this.creatingNewPage--;
    }
  }

  async createPage(options?: {
    readonly restore?: unknown;
    readonly own?: (page: BrowserPage) => void;
  }): Promise<BrowserPage> {
    const discardRestore = parseChromiumDiscardRestore(options?.restore);
    if (discardRestore && this.lifecycle) {
      const sleeping = this.sleepingTabs.get(discardRestore.tokenId);
      if (sleeping) {
        let tabId: number | null = null;
        let currentSleeping = sleeping;
        if (currentSleeping.state === "discarding") {
          tabId = await currentSleeping.settled;
          currentSleeping = this.sleepingTabs.get(discardRestore.tokenId) ?? currentSleeping;
        } else if (currentSleeping.state === "discarded") {
          tabId = currentSleeping.tabId;
        }
        if (currentSleeping.state === "unknown") {
          const removed = await this.attemptSleepingRemoval(
            discardRestore.tokenId,
            currentSleeping,
          );
          if (removed) {
            this.sleepingTabs.delete(discardRestore.tokenId);
            this.pendingSleepingRemovals.delete(discardRestore.tokenId);
          } else {
            this.enqueuePendingSleepingRemoval(discardRestore.tokenId);
          }
        } else if (tabId !== null) {
          this.sleepingTabs.delete(discardRestore.tokenId);
          this.pendingSleepingRemovals.delete(discardRestore.tokenId);
          try {
            const wokenPage = await this.wakeDiscardedTab(tabId);
            const handle = this.wrap(wokenPage);
            if (currentSleeping.surfaceId) {
              this.trackSavedTab(currentSleeping.surfaceId, handle);
            }
            options?.own?.(handle);
            return handle;
          } catch {
            const removed = await this.removeTabWithEvidence(tabId, null);
            if (!removed) {
              this.sleepingTabs.set(discardRestore.tokenId, {
                state: "discarded",
                tabId,
                url: currentSleeping.url,
              });
              this.enqueuePendingSleepingRemoval(discardRestore.tokenId);
            }
          }
        } else {
          this.sleepingTabs.delete(discardRestore.tokenId);
        }
      }
      const fallback = this.wrap(await this.openFreshPage());
      if (sleeping?.surfaceId) {
        this.trackSavedTab(sleeping.surfaceId, fallback);
      }
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
      if (this.lifecycle && this.profileDirectory && !this.trackedNavigationPages.has(page)) {
        this.trackedNavigationPages.add(page);
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) this.scheduleSidecarWrite();
        });
      }
      page.once("close", () => {
        this.pagesByPlaywrightPage.delete(page);
        if (this.lifecycle && this.profileDirectory) {
          const savedSurfaceId = this.savedSurfaceByPage.get(handle!);
          if (savedSurfaceId) {
            const current = this.savedTabsBySurfaceId.get(savedSurfaceId);
            if (current && current.page === handle) {
              this.savedTabsBySurfaceId.delete(savedSurfaceId);
            }
          }
          this.scheduleSidecarWrite();
        }
      });
    }
    return handle;
  }

  /** A page asked to close is never found, and no page's target lookup delays another's. */
  pageByTargetId(targetId: string): Promise<PlaywrightPageHandle | null> {
    return pageWithTarget(
      this.context
        .pages()
        .filter((page) => !this.isHiddenPage(page))
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

  private async freezeBeforeDiscard(): Promise<void> {
    if (this.page.isClosed()) return;
    let session: PlaywrightCdpSession | undefined;
    try {
      session = await withTimeout(this.context.newCDPSession(this.page), 1_500, {
        timeoutError: () => new Error("Freeze CDP attach timed out."),
      });
      // Freezing synchronously triggers RenderFrameImpl::SendUpdateState so Blink
      // flushes recent scroll/form PageState before AttemptFastKillForDiscard.
      await withTimeout(session.send("Page.setWebLifecycleState", { state: "frozen" }), 1_500, {
        timeoutError: () => new Error("Freeze before discard timed out."),
      });
    } catch {
      // Best-effort flush; discard still proceeds if the renderer already exited.
    } finally {
      await session?.detach().catch(() => undefined);
    }
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
        const settled = Promise.withResolvers<number | null>();
        this.contextHandle.beginSleepingTab(
          sleepDiscard.tokenId,
          sleepDiscard.url,
          this,
          settled.promise,
        );
        let newTabId: number | null = null;
        let unknownOutcome:
          | {
              readonly originalTabId: number;
              readonly epoch: string | undefined;
            }
          | undefined;
        try {
          const inventory = await this.contextHandle.lifecycle.inventory().catch(() => null);
          const tab = inventory?.find((entry) => entry.targetId === sleepDiscard.targetId);
          if (tab && inventory) {
            // Only activate the private anchor when Chromium considers this exact tab active,
            // so sleeping a background tab never steals focus or visibility from the foreground tab.
            if (tab.active) await this.contextHandle.activatePrivateAnchor();
            await this.freezeBeforeDiscard();
            await this.cdpChannel?.detach();
            if (!this.page.isClosed()) {
              let discardThrew = false;
              try {
                newTabId = await this.contextHandle.lifecycle.discardByTabId(tab.tabId);
              } catch {
                discardThrew = true;
                // Unknown outcome: follow this tab by its id through any replacement, never by
                // another tab's URL.
                const after = await this.contextHandle.lifecycle.inventory().catch(() => null);
                const where = after ? locateTab(after, tab.tabId, tab.helperEpoch) : null;
                if (where?.status === "found" && where.row.discarded) {
                  newTabId = where.row.tabId;
                }
              }
              if (newTabId === null && !this.page.isClosed()) {
                await this.page.close({ runBeforeUnload: false });
              } else if (newTabId === null && discardThrew && this.page.isClosed()) {
                // Page vanished during an errored discard without a confirmed tabId outcome:
                // retain unknown-outcome tabId so release/wake can clean it up if it survives.
                unknownOutcome = {
                  originalTabId: tab.tabId,
                  epoch: tab.helperEpoch,
                };
              }
            }
          } else {
            await this.cdpChannel?.detach();
            if (!this.page.isClosed()) {
              await this.page.close({ runBeforeUnload: false });
            }
          }
        } finally {
          this.contextHandle.finishSleepingTab(sleepDiscard.tokenId, newTabId, unknownOutcome);
          settled.resolve(newTabId);
        }
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
    if (sleepDiscard && this.contextHandle.lifecycle) {
      this.contextHandle.trackInFlightDiscard(operation.catch(() => undefined));
    }
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
