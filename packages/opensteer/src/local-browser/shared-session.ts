import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  CURRENT_PROCESS_OWNER,
  getProcessLiveness,
  parseProcessOwner,
  processOwnersEqual,
} from "./process-owner.js";
import { withDirLock } from "./dir-lock.js";
import {
  clearChromeSingletonEntries,
} from "./profile-clone.js";
import {
  discoverAutoConnectCdpEndpoint,
  discoverBrowserWebSocketUrl,
  readDevToolsActivePort,
} from "./chrome-discovery.js";
import type {
  ConnectCdpBrowserOptions,
  LaunchMetadataRecord,
  LaunchOwnedBrowserOptions,
  LocalBrowserLease,
  OwnedLocalChromeProcess,
} from "./types.js";

const DEVTOOLS_POLL_INTERVAL_MS = 50;
const PROFILE_DIRECTORY_DEFAULT = "Default";
const PROFILE_IN_USE_ERROR =
  "The selected Chrome user-data-dir appears to be in use. Attach with --auto-connect or --cdp instead of launching it again.";

export async function launchManagedBrowserSession(
  options: LaunchOwnedBrowserOptions & {
    readonly connectBrowser: ConnectCdpBrowserOptions["connectBrowser"];
  },
): Promise<LocalBrowserLease> {
  const tempUserDataDir = await mkdtemp(join(tmpdir(), "opensteer-managed-chrome-"));
  await clearChromeSingletonEntries(tempUserDataDir);

  try {
    const ownedBrowser = await launchOwnedChrome({
      ...options,
      userDataDir: tempUserDataDir,
    });
    return await connectBrowserSession({
      connectBrowser: options.connectBrowser,
      endpoint: ownedBrowser.browserEndpoint,
      freshTab: false,
      ownedBrowser,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    await rm(tempUserDataDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function launchProfileBrowserSession(
  options: LaunchOwnedBrowserOptions & {
    readonly profileDirectory?: string;
    readonly userDataDir: string;
    readonly connectBrowser: ConnectCdpBrowserOptions["connectBrowser"];
  },
): Promise<LocalBrowserLease> {
  const userDataDir = resolve(options.userDataDir);
  await assertProfileLaunchAllowed(userDataDir);

  const releaseLaunchRegistration = await registerProfileLaunch({
    args: options.args,
    executablePath: options.executablePath,
    headless: options.headless,
    ...(options.profileDirectory === undefined
      ? {}
      : { profileDirectory: options.profileDirectory }),
    userDataDir,
  });

  try {
    const ownedBrowser = await launchOwnedChrome({
      ...options,
      profileDirectory: options.profileDirectory ?? PROFILE_DIRECTORY_DEFAULT,
      userDataDir,
    });
    const lease = await connectBrowserSession({
      connectBrowser: options.connectBrowser,
      endpoint: ownedBrowser.browserEndpoint,
      freshTab: false,
      ownedBrowser,
      timeoutMs: options.timeoutMs,
    });

    return wrapLeaseClose(lease, async () => {
      await releaseLaunchRegistration();
    });
  } catch (error) {
    await releaseLaunchRegistration().catch(() => undefined);
    throw error;
  }
}

export async function connectCdpBrowserSession(
  options: ConnectCdpBrowserOptions,
): Promise<LocalBrowserLease> {
  return connectBrowserSession(options);
}

export async function connectAutoBrowserSession(
  options: Omit<ConnectCdpBrowserOptions, "endpoint" | "headers">,
): Promise<LocalBrowserLease> {
  return connectBrowserSession({
    ...options,
    endpoint: await discoverAutoConnectCdpEndpoint(),
  });
}

async function connectBrowserSession(
  options: ConnectCdpBrowserOptions,
): Promise<LocalBrowserLease> {
  const browserWsUrl =
    (await discoverBrowserWebSocketUrl(options.endpoint, options.headers))
    ?? options.endpoint;
  const browser = await options.connectBrowser({
    url: browserWsUrl,
    timeoutMs: options.timeoutMs,
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });

  try {
    const context = getPrimaryContext(browser);
    const page = await getSessionPage(context, options.freshTab);

    return {
      browser,
      context,
      page,
      close: async () => {
        await closeBrowserSession({
          browser,
          ...(options.ownedBrowser === undefined
            ? {}
            : { ownedBrowser: options.ownedBrowser }),
        });
      },
    };
  } catch (error) {
    await closeBrowserSession({
      browser,
      ...(options.ownedBrowser === undefined
        ? {}
        : { ownedBrowser: options.ownedBrowser }),
    }).catch(() => undefined);
    throw error;
  }
}

async function launchOwnedChrome(
  options: LaunchOwnedBrowserOptions,
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
    ...(options.userDataDir !== undefined
      && options.userDataDir.startsWith(join(tmpdir(), "opensteer-managed-chrome-"))
      ? { cleanupUserDataDir: options.userDataDir }
      : {}),
    close: async () => {
      await waitForProcessExitOrKill(child);
    },
    kill: async () => {
      child.kill("SIGKILL");
    },
  };
}

function buildChromeArgs(options: LaunchOwnedBrowserOptions): readonly string[] {
  const args = [
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
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
    "--metrics-recording-only",
    "--password-store=basic",
    "--use-mock-keychain",
    `--user-data-dir=${options.userDataDir ?? ""}`,
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
      const discovered = await discoverBrowserWebSocketUrl(`http://127.0.0.1:${String(activePort.port)}`);
      if (discovered) {
        return discovered;
      }
      return `ws://127.0.0.1:${String(activePort.port)}${activePort.webSocketPath}`;
    }

    const exitCode = await input.childExited();
    if (exitCode !== null) {
      throw new Error(formatChromeLaunchError(input.stderrLines));
    }

    await sleep(DEVTOOLS_POLL_INTERVAL_MS);
  }

  throw new Error(formatChromeLaunchError(input.stderrLines));
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

async function waitForProcessExitOrKill(
  child: ReturnType<typeof spawn>,
): Promise<void> {
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
    const existing = await readLaunchMetadata(userDataDir);
    if (existing?.owner && (await getProcessLiveness(existing.owner)) === "live") {
      throw new Error(PROFILE_IN_USE_ERROR);
    }

    const activePort = readDevToolsActivePort(userDataDir);
    if (activePort) {
      const discovered = await discoverBrowserWebSocketUrl(`http://127.0.0.1:${String(activePort.port)}`);
      if (discovered) {
        throw new Error(PROFILE_IN_USE_ERROR);
      }
    }

    if (hasActiveSingletonArtifacts(userDataDir)) {
      throw new Error(PROFILE_IN_USE_ERROR);
    }
  });
}

async function registerProfileLaunch(input: Omit<LaunchMetadataRecord, "owner">): Promise<() => Promise<void>> {
  await withProfileLaunchLock(input.userDataDir, async () => {
    await mkdir(join(getLaunchMetadataDir(input.userDataDir)), { recursive: true });
    await writeFile(
      getLaunchMetadataPath(input.userDataDir),
      JSON.stringify({
        ...input,
        owner: CURRENT_PROCESS_OWNER,
      } satisfies LaunchMetadataRecord),
    );
  });

  return async () => {
    await withProfileLaunchLock(input.userDataDir, async () => {
      const metadata = await readLaunchMetadata(input.userDataDir);
      if (!metadata?.owner || !processOwnersEqual(metadata.owner, CURRENT_PROCESS_OWNER)) {
        return;
      }
      await rm(getLaunchMetadataPath(input.userDataDir), { force: true }).catch(() => undefined);
    });
  };
}

function hasActiveSingletonArtifacts(userDataDir: string): boolean {
  return [
    "SingletonLock",
    "SingletonSocket",
    "lockfile",
  ].some((entry) => existsSync(join(userDataDir, entry)));
}

async function readLaunchMetadata(userDataDir: string): Promise<LaunchMetadataRecord | null> {
  try {
    const raw = JSON.parse(
      await readFile(getLaunchMetadataPath(userDataDir), "utf8"),
    ) as Partial<LaunchMetadataRecord>;
    const owner = parseProcessOwner(raw.owner);
    return {
      args: Array.isArray(raw.args) ? raw.args.filter((entry): entry is string => typeof entry === "string") : [],
      executablePath: typeof raw.executablePath === "string" ? raw.executablePath : "",
      headless: raw.headless === true,
      owner: owner ?? undefined,
      ...(typeof raw.profileDirectory === "string" ? { profileDirectory: raw.profileDirectory } : {}),
      userDataDir: typeof raw.userDataDir === "string" ? raw.userDataDir : userDataDir,
    };
  } catch {
    return null;
  }
}

async function withProfileLaunchLock<T>(userDataDir: string, action: () => Promise<T>): Promise<T> {
  return withDirLock(getLaunchLockPath(userDataDir), action);
}

function getLaunchMetadataDir(userDataDir: string): string {
  return join(homedir(), ".opensteer", "local-browser", "launches", buildLaunchKey(userDataDir));
}

function getLaunchMetadataPath(userDataDir: string): string {
  return join(getLaunchMetadataDir(userDataDir), "launch.json");
}

function getLaunchLockPath(userDataDir: string): string {
  return join(getLaunchMetadataDir(userDataDir), "lock");
}

function buildLaunchKey(userDataDir: string): string {
  return createHash("sha256").update(resolve(userDataDir)).digest("hex").slice(0, 16);
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
