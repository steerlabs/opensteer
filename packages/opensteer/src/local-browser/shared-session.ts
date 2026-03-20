import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { clearChromeSingletonEntries } from "./chrome-singletons.js";
import { inspectCdpEndpoint, selectAttachBrowserCandidate } from "./cdp-discovery.js";
import { readDevToolsActivePort } from "./chrome-discovery.js";
import {
  OpensteerLocalProfileUnavailableError,
  inspectLocalBrowserProfile,
} from "./profile-inspection.js";
import { registerProfileLaunch, withProfileLaunchLock } from "./profile-launch-metadata.js";
import { createBrowserProfileSnapshot } from "./profile-clone.js";
import { injectBrowserStealthScripts } from "./stealth.js";
import type {
  ConnectAttachBrowserOptions,
  ConnectCdpBrowserOptions,
  LaunchOwnedBrowserOptions,
  LocalBrowserLease,
  OwnedLocalChromeProcess,
  PreparedOwnedBrowserLaunch,
} from "./types.js";

const DEVTOOLS_POLL_INTERVAL_MS = 50;
const PROFILE_DIRECTORY_DEFAULT = "Default";

export async function launchManagedBrowserSession(
  options: LaunchOwnedBrowserOptions & {
    readonly connectBrowser: ConnectCdpBrowserOptions["connectBrowser"];
  },
): Promise<LocalBrowserLease> {
  return launchPreparedOwnedBrowserSession(
    await prepareManagedOwnedBrowserLaunch(options),
    options.connectBrowser,
  );
}

export async function launchProfileBrowserSession(
  options: LaunchOwnedBrowserOptions & {
    readonly profileDirectory?: string;
    readonly userDataDir: string;
    readonly connectBrowser: ConnectCdpBrowserOptions["connectBrowser"];
  },
): Promise<LocalBrowserLease> {
  return launchPreparedOwnedBrowserSession(
    await prepareProfileOwnedBrowserLaunch(options),
    options.connectBrowser,
  );
}

export async function launchClonedBrowserSession(
  options: LaunchOwnedBrowserOptions & {
    readonly sourceProfileDirectory: string;
    readonly sourceUserDataDir: string;
    readonly connectBrowser: ConnectCdpBrowserOptions["connectBrowser"];
  },
): Promise<LocalBrowserLease> {
  return launchPreparedOwnedBrowserSession(
    await prepareClonedOwnedBrowserLaunch(options),
    options.connectBrowser,
  );
}

export async function connectAttachBrowserSession(
  options: ConnectAttachBrowserOptions,
): Promise<LocalBrowserLease> {
  if (options.endpoint !== undefined) {
    return connectBrowserSession({
      ...options,
      endpoint: options.endpoint,
    });
  }

  const selection = await selectAttachBrowserCandidate({
    timeoutMs: options.timeoutMs,
  });

  try {
    return await connectBrowserSessionWithEndpoint(options, selection.endpoint);
  } catch (error) {
    const retrySelection = await retryAutoConnectCandidate(selection.endpoint, options.timeoutMs);
    if (retrySelection === null) {
      throw new Error(
        "Attach target disappeared or selection changed before attach. Re-run discovery or use --browser attach --attach-endpoint <endpoint>.",
        {
          cause: error,
        },
      );
    }

    try {
      return await connectBrowserSessionWithEndpoint(options, retrySelection.endpoint);
    } catch (retryError) {
      throw new Error(
        "Attach target disappeared before attach. Re-run discovery or use --browser attach --attach-endpoint <endpoint>.",
        {
          cause: retryError,
        },
      );
    }
  }
}

async function prepareManagedOwnedBrowserLaunch(
  options: LaunchOwnedBrowserOptions,
): Promise<PreparedOwnedBrowserLaunch> {
  const userDataDir = await mkdtemp(join(tmpdir(), "opensteer-managed-chrome-"));
  await clearChromeSingletonEntries(userDataDir);
  return {
    ...options,
    userDataDir,
    cleanupUserDataDir: userDataDir,
    useRealKeychain: options.useRealKeychain ?? false,
  };
}

async function prepareProfileOwnedBrowserLaunch(
  options: LaunchOwnedBrowserOptions & {
    readonly profileDirectory?: string;
    readonly userDataDir: string;
  },
): Promise<PreparedOwnedBrowserLaunch> {
  const userDataDir = resolve(options.userDataDir);
  await assertProfileLaunchAllowed(userDataDir);

  const profileDirectory = options.profileDirectory ?? PROFILE_DIRECTORY_DEFAULT;
  const release = await registerProfileLaunch({
    args: options.args,
    executablePath: options.executablePath,
    headless: options.headless,
    profileDirectory,
    userDataDir,
  });

  return {
    ...options,
    userDataDir,
    profileDirectory,
    release,
    useRealKeychain: options.useRealKeychain ?? true,
  };
}

async function prepareClonedOwnedBrowserLaunch(
  options: LaunchOwnedBrowserOptions & {
    readonly sourceProfileDirectory: string;
    readonly sourceUserDataDir: string;
  },
): Promise<PreparedOwnedBrowserLaunch> {
  const userDataDir = await mkdtemp(join(tmpdir(), "opensteer-cloned-chrome-"));
  await clearChromeSingletonEntries(userDataDir);

  try {
    await createBrowserProfileSnapshot({
      sourceUserDataDir: options.sourceUserDataDir,
      targetUserDataDir: userDataDir,
      profileDirectory: options.sourceProfileDirectory,
      copyMode: "session",
    });
    return {
      ...options,
      userDataDir,
      profileDirectory: options.sourceProfileDirectory,
      cleanupUserDataDir: userDataDir,
      useRealKeychain: options.useRealKeychain ?? false,
    };
  } catch (error) {
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function launchPreparedOwnedBrowserSession(
  options: PreparedOwnedBrowserLaunch,
  connectBrowser: ConnectCdpBrowserOptions["connectBrowser"],
): Promise<LocalBrowserLease> {
  try {
    const ownedBrowser = await launchOwnedChrome(options);
    const lease = await connectBrowserSession({
      connectBrowser,
      endpoint: ownedBrowser.browserEndpoint,
      freshTab: false,
      ownedBrowser,
      timeoutMs: options.timeoutMs,
    });

    return wrapLeaseClose(lease, async () => {
      await options.release?.();
    });
  } catch (error) {
    await options.release?.().catch(() => undefined);
    if (options.cleanupUserDataDir !== undefined) {
      await rm(options.cleanupUserDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function connectBrowserSession(
  options: ConnectCdpBrowserOptions,
): Promise<LocalBrowserLease> {
  const browserWsUrl = await resolveConnectBrowserUrl(options);
  const browser = await options.connectBrowser({
    url: browserWsUrl,
    timeoutMs: options.timeoutMs,
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });

  try {
    const context = getPrimaryContext(browser);
    await injectBrowserStealthScripts(context);
    const page = await getSessionPage(context, options.freshTab);

    return {
      browser,
      context,
      page,
      close: async () => {
        await closeBrowserSession({
          browser,
          ...(options.ownedBrowser === undefined ? {} : { ownedBrowser: options.ownedBrowser }),
        });
      },
    };
  } catch (error) {
    await closeBrowserSession({
      browser,
      ...(options.ownedBrowser === undefined ? {} : { ownedBrowser: options.ownedBrowser }),
    }).catch(() => undefined);
    throw error;
  }
}

function connectBrowserSessionWithEndpoint(
  options: Omit<ConnectAttachBrowserOptions, "endpoint" | "headers">,
  endpoint: string,
): Promise<LocalBrowserLease> {
  return connectBrowserSession({
    ...options,
    endpoint,
  });
}

async function launchOwnedChrome(
  options: PreparedOwnedBrowserLaunch,
): Promise<OwnedLocalChromeProcess & { readonly browserEndpoint: string }> {
  const args = buildChromeArgs(options);
  const stderrLines: string[] = [];

  const child = spawn(options.executablePath, args, {
    stdio: ["ignore", "ignore", "pipe"],
    detached: process.platform !== "win32",
  });

  child.unref();
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderrLines.push(String(chunk));
  });

  const browserEndpoint = await waitForDevToolsEndpoint({
    childExited: async () => {
      const status = child.exitCode;
      return status !== null ? status : null;
    },
    stderrLines,
    timeoutMs: options.timeoutMs,
    userDataDir: options.userDataDir ?? "",
  }).catch(async (error) => {
    child.kill("SIGKILL");
    throw error;
  });

  return {
    browserEndpoint,
    pid: child.pid ?? 0,
    ...(options.cleanupUserDataDir === undefined
      ? {}
      : { cleanupUserDataDir: options.cleanupUserDataDir }),
    close: async () => {
      await waitForProcessExitOrKill(child);
    },
    kill: async () => {
      child.kill("SIGKILL");
    },
  };
}

function buildChromeArgs(options: PreparedOwnedBrowserLaunch): readonly string[] {
  const args = [
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--disable-background-networking",
    "--disable-backgrounding-occluded-windows",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-hang-monitor",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-sync",
    "--disable-features=Translate",
    "--enable-features=NetworkService,NetworkServiceInProcess",
    ...(options.useRealKeychain ? [] : ["--password-store=basic", "--use-mock-keychain"]),
    `--user-data-dir=${options.userDataDir}`,
  ];

  if (options.profileDirectory) {
    args.push(`--profile-directory=${options.profileDirectory}`);
  }

  if (options.headless) {
    args.push("--headless=new");
    if (!options.args.some((arg) => arg.startsWith("--window-size"))) {
      args.push("--window-size=1280,800");
    }
  }

  args.push(...options.args);
  return args;
}

async function waitForDevToolsEndpoint(input: {
  readonly childExited: () => Promise<number | null>;
  readonly stderrLines: readonly string[];
  readonly timeoutMs: number;
  readonly userDataDir: string;
}): Promise<string> {
  const deadline = Date.now() + input.timeoutMs;

  while (Date.now() < deadline) {
    const activePort = readDevToolsActivePort(input.userDataDir);
    if (activePort) {
      try {
        const inspected = await inspectCdpEndpoint({
          endpoint: `http://127.0.0.1:${String(activePort.port)}`,
          timeoutMs: Math.min(2_000, input.timeoutMs),
        });
        return inspected.endpoint;
      } catch {
        return `ws://127.0.0.1:${String(activePort.port)}${activePort.webSocketPath}`;
      }
    }

    const exitCode = await input.childExited();
    if (exitCode !== null) {
      throw new Error(formatChromeLaunchError(input.stderrLines));
    }

    await sleep(DEVTOOLS_POLL_INTERVAL_MS);
  }

  throw new Error(formatChromeLaunchError(input.stderrLines));
}

async function resolveConnectBrowserUrl(options: ConnectCdpBrowserOptions): Promise<string> {
  if (options.endpoint.startsWith("ws://") || options.endpoint.startsWith("wss://")) {
    return options.endpoint;
  }

  const inspected = await inspectCdpEndpoint({
    endpoint: options.endpoint,
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    timeoutMs: Math.min(2_000, options.timeoutMs),
  });
  return inspected.endpoint;
}

async function retryAutoConnectCandidate(
  previousEndpoint: string,
  timeoutMs: number,
): Promise<{ readonly endpoint: string } | null> {
  try {
    const selection = await selectAttachBrowserCandidate({ timeoutMs });
    return selection.endpoint === previousEndpoint ? selection : null;
  } catch {
    return null;
  }
}

function formatChromeLaunchError(stderrLines: readonly string[]): string {
  const collapsed = stderrLines
    .join("")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (collapsed.length === 0) {
    return "Chrome failed to launch before exposing a DevTools endpoint.";
  }

  const relevant = collapsed.filter((line) =>
    /(error|fatal|sandbox|namespace|permission|cannot|failed|abort)/i.test(line),
  );
  const lines = (relevant.length > 0 ? relevant : collapsed).slice(-5);
  return `Chrome failed to launch before exposing a DevTools endpoint.\n${lines.join("\n")}`;
}

function getPrimaryContext(browser: LocalBrowserLease["browser"]): LocalBrowserLease["context"] {
  const existing = browser.contexts()[0];
  if (!existing) {
    throw new Error("Connected browser does not expose a Chromium browser context.");
  }
  return existing;
}

async function getSessionPage(
  context: LocalBrowserLease["context"],
  freshTab: boolean,
): Promise<LocalBrowserLease["page"]> {
  if (freshTab) {
    const page = await context.newPage();
    await page.bringToFront?.();
    return page;
  }

  const existing = context.pages()[0];
  if (existing) {
    await existing.bringToFront?.();
    return existing;
  }

  const page = await context.newPage();
  await page.bringToFront?.();
  return page;
}

async function closeBrowserSession(input: {
  readonly browser: LocalBrowserLease["browser"];
  readonly ownedBrowser?: OwnedLocalChromeProcess;
}): Promise<void> {
  if (input.ownedBrowser) {
    await requestBrowserShutdown(input.browser).catch(() => undefined);
  }

  await input.browser.close().catch(() => undefined);
  if (input.ownedBrowser) {
    await input.ownedBrowser.close().catch(() => undefined);
    if (input.ownedBrowser.cleanupUserDataDir !== undefined) {
      await rm(input.ownedBrowser.cleanupUserDataDir, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
  }
}

async function requestBrowserShutdown(browser: LocalBrowserLease["browser"]): Promise<void> {
  const session = await browser.newBrowserCDPSession();
  try {
    await session.send("Browser.close");
  } finally {
    await session.detach().catch(() => undefined);
  }
}

async function waitForProcessExitOrKill(child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const exitCode = child.exitCode;
    if (exitCode !== null) {
      return;
    }
    await sleep(50);
  }

  child.kill("SIGKILL");
}

async function assertProfileLaunchAllowed(userDataDir: string): Promise<void> {
  await withProfileLaunchLock(userDataDir, async () => {
    const inspection = await inspectLocalBrowserProfile({
      userDataDir,
    });
    if (inspection.status !== "available") {
      throw new OpensteerLocalProfileUnavailableError(inspection);
    }
  });
}

function wrapLeaseClose(
  lease: LocalBrowserLease,
  afterClose: () => Promise<void>,
): LocalBrowserLease {
  let closed = false;
  return {
    ...lease,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        await lease.close();
      } finally {
        await afterClose();
      }
    },
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
