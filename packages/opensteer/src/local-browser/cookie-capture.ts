import { execFile as execFileCallback, spawn } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import {
  type BrowserBrandId,
  type BrowserBrandRecord,
  detectInstalledBrowserBrands,
  findBrandProcess,
  getAllBrowserBrands,
  getBrowserBrand,
  resolveBrandExecutablePath,
  resolveBrandPlatformConfig,
  resolveBrandUserDataDir,
} from "./browser-brands.js";
import { clearChromeSingletonEntries } from "./chrome-singletons.js";
import { inspectCdpEndpoint } from "./cdp-discovery.js";
import { expandHome, readDevToolsActivePort } from "./chrome-discovery.js";
import { isProcessRunning } from "./process-owner.js";

const execFile = promisify(execFileCallback);

const DEFAULT_CAPTURE_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const DEVTOOLS_POLL_INTERVAL_MS = 50;
const PROCESS_LIST_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export type CookieCaptureStrategy = "attach" | "headless" | "managed-relaunch";

export interface CookieCaptureSourceInput {
  readonly brandId?: BrowserBrandId;
  readonly userDataDir?: string;
  readonly profileDirectory?: string;
  readonly executablePath?: string;
  readonly attachEndpoint?: string;
  readonly strategy?: CookieCaptureStrategy;
  readonly timeoutMs?: number;
}

export interface ResolvedCookieCaptureStrategy {
  readonly strategy: CookieCaptureStrategy;
  readonly brandId?: BrowserBrandId;
  readonly brandDisplayName?: string;
  readonly executablePath?: string;
  readonly userDataDir?: string;
  readonly profileDirectory?: string;
  readonly attachEndpoint?: string;
  readonly runningPid?: number;
  readonly timeoutMs: number;
}

export interface ResolvedCookieCaptureSource {
  readonly strategy: CookieCaptureStrategy;
  readonly cdpEndpoint: string;
  readonly brandId?: BrowserBrandId;
  readonly brandDisplayName?: string;
  readonly userDataDir?: string;
  readonly profileDirectory?: string;
  readonly cleanup: () => Promise<void>;
}

export async function resolveCookieCaptureStrategy(
  input: CookieCaptureSourceInput = {},
): Promise<ResolvedCookieCaptureStrategy> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;

  if (input.attachEndpoint !== undefined) {
    if (input.strategy !== undefined && input.strategy !== "attach") {
      throw new Error(
        `Strategy "${input.strategy}" is incompatible with an explicit attach endpoint.`,
      );
    }

    return {
      strategy: "attach",
      attachEndpoint: input.attachEndpoint,
      ...(input.profileDirectory === undefined ? {} : { profileDirectory: input.profileDirectory }),
      timeoutMs,
    };
  }

  const brand = resolveRequestedBrand(input);
  const executablePath = resolveBrandExecutablePath(brand, input.executablePath);
  const userDataDir = resolveBrandUserDataDir(brand, input.userDataDir);
  const profileDirectory = input.profileDirectory;

  const attachEndpoint = await resolveReachableAttachEndpoint(userDataDir, timeoutMs);
  const runningProcess = findBrandProcess(brand);
  const autoStrategy: CookieCaptureStrategy =
    attachEndpoint !== undefined
      ? "attach"
      : runningProcess !== null
        ? "managed-relaunch"
        : "headless";
  const strategy = input.strategy ?? autoStrategy;

  validateRequestedStrategy({
    strategy,
    brand,
    ...(attachEndpoint === undefined ? {} : { attachEndpoint }),
    ...(runningProcess?.pid === undefined ? {} : { runningPid: runningProcess.pid }),
  });

  return {
    strategy,
    brandId: brand.id,
    brandDisplayName: brand.displayName,
    executablePath,
    userDataDir,
    ...(profileDirectory === undefined ? {} : { profileDirectory }),
    ...(attachEndpoint === undefined ? {} : { attachEndpoint }),
    ...(runningProcess === null ? {} : { runningPid: runningProcess.pid }),
    timeoutMs,
  };
}

export async function acquireCdpEndpoint(
  resolved: ResolvedCookieCaptureStrategy,
): Promise<ResolvedCookieCaptureSource> {
  if (resolved.strategy === "attach") {
    if (!resolved.attachEndpoint) {
      throw new Error("Attach capture requires a debuggable browser endpoint.");
    }

    const inspected = await inspectCdpEndpoint({
      endpoint: resolved.attachEndpoint,
      timeoutMs: Math.min(2_000, resolved.timeoutMs),
    });
    return {
      strategy: "attach",
      cdpEndpoint: inspected.endpoint,
      ...(resolved.brandId === undefined ? {} : { brandId: resolved.brandId }),
      ...(resolved.brandDisplayName === undefined
        ? {}
        : { brandDisplayName: resolved.brandDisplayName }),
      ...(resolved.userDataDir === undefined ? {} : { userDataDir: resolved.userDataDir }),
      ...(resolved.profileDirectory === undefined
        ? {}
        : { profileDirectory: resolved.profileDirectory }),
      cleanup: async () => undefined,
    };
  }

  if (
    !resolved.brandId ||
    !resolved.brandDisplayName ||
    !resolved.executablePath ||
    !resolved.userDataDir
  ) {
    throw new Error(
      "Headless cookie capture requires a resolved browser brand, executable, and user-data-dir.",
    );
  }
  const userDataDir = resolved.userDataDir;

  if (resolved.strategy === "managed-relaunch") {
    if (resolved.runningPid === undefined) {
      throw new Error("Managed relaunch requires a running browser process.");
    }

    await gracefullyStopBrowser(
      getBrowserBrand(resolved.brandId),
      resolved.runningPid,
      resolved.timeoutMs,
    );
  }

  await clearChromeSingletonEntries(userDataDir);

  try {
    const capture = await launchCaptureChrome({
      brandDisplayName: resolved.brandDisplayName,
      executablePath: resolved.executablePath,
      userDataDir,
      ...(resolved.profileDirectory === undefined
        ? {}
        : { profileDirectory: resolved.profileDirectory }),
      timeoutMs: resolved.timeoutMs,
    });

    return {
      strategy: resolved.strategy,
      cdpEndpoint: capture.endpoint,
      brandId: resolved.brandId,
      brandDisplayName: resolved.brandDisplayName,
      userDataDir: resolved.userDataDir,
      ...(resolved.profileDirectory === undefined
        ? {}
        : { profileDirectory: resolved.profileDirectory }),
      cleanup: async () => {
        await capture.kill().catch(() => undefined);
        await clearChromeSingletonEntries(userDataDir).catch(() => undefined);
      },
    };
  } catch (error) {
    await clearChromeSingletonEntries(userDataDir).catch(() => undefined);
    throw error;
  }
}

export async function gracefullyStopBrowser(
  brand: BrowserBrandRecord,
  pid: number,
  timeoutMs = DEFAULT_STOP_TIMEOUT_MS,
): Promise<void> {
  if (pid <= 0) {
    return;
  }

  const platformConfig = resolveBrandPlatformConfig(brand);

  if (process.platform === "darwin" && platformConfig?.bundleId) {
    await execFile(
      "osascript",
      ["-e", `tell application id "${platformConfig.bundleId}" to quit`],
      {
        maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
      },
    ).catch(() => undefined);
  } else if (process.platform === "win32") {
    await execFile("taskkill", ["/PID", String(pid)], {
      maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
    }).catch(() => undefined);
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }

  if (await waitForProcessExit(pid, timeoutMs)) {
    return;
  }

  if (process.platform === "win32") {
    await execFile("taskkill", ["/F", "/PID", String(pid)], {
      maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
    }).catch(() => undefined);
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }

  await waitForProcessExit(pid, Math.min(5_000, timeoutMs));
}

export async function launchCaptureChrome(input: {
  readonly brandDisplayName: string;
  readonly executablePath: string;
  readonly userDataDir: string;
  readonly profileDirectory?: string;
  readonly timeoutMs: number;
}): Promise<{
  readonly endpoint: string;
  readonly kill: () => Promise<void>;
}> {
  const stderrLines: string[] = [];
  const child = spawn(input.executablePath, buildCaptureChromeArgs(input), {
    detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "pipe"],
  });

  child.unref();
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderrLines.push(String(chunk));
  });

  try {
    const endpoint = await waitForCaptureEndpoint({
      brandDisplayName: input.brandDisplayName,
      child,
      stderrLines,
      timeoutMs: input.timeoutMs,
      userDataDir: input.userDataDir,
    });

    return {
      endpoint,
      kill: async () => {
        await terminateChild(child);
      },
    };
  } catch (error) {
    await terminateChild(child).catch(() => undefined);
    throw error;
  }
}

export function relaunchBrowserNormally(executablePath: string): void {
  const child = spawn(executablePath, [], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function resolveRequestedBrand(input: CookieCaptureSourceInput): BrowserBrandRecord {
  if (input.brandId !== undefined) {
    return getBrowserBrand(input.brandId);
  }

  if (input.userDataDir !== undefined) {
    const inferred = inferBrandFromUserDataDir(input.userDataDir);
    if (!inferred) {
      throw new Error(
        `Could not infer a browser brand from user-data-dir "${input.userDataDir}". Pass --browser explicitly.`,
      );
    }
    return inferred;
  }

  if (input.executablePath !== undefined) {
    const inferred = inferBrandFromExecutablePath(input.executablePath);
    if (!inferred) {
      throw new Error(
        `Could not infer a browser brand from executable path "${input.executablePath}". Pass --browser explicitly.`,
      );
    }
    return inferred;
  }

  const installed = detectInstalledBrowserBrands()[0];
  if (!installed) {
    throw new Error(
      "No Chromium browser found. Install a supported browser or pass --browser explicitly.",
    );
  }
  return installed.brand;
}

async function resolveReachableAttachEndpoint(
  userDataDir: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const activePort = readDevToolsActivePort(userDataDir);
  if (!activePort) {
    return undefined;
  }

  try {
    return (
      await inspectCdpEndpoint({
        endpoint: `http://127.0.0.1:${String(activePort.port)}`,
        timeoutMs: Math.min(2_000, timeoutMs),
      })
    ).endpoint;
  } catch {
    return undefined;
  }
}

function validateRequestedStrategy(input: {
  readonly strategy: CookieCaptureStrategy;
  readonly attachEndpoint?: string;
  readonly brand: BrowserBrandRecord;
  readonly runningPid?: number;
}): void {
  if (input.strategy === "attach" && input.attachEndpoint === undefined) {
    throw new Error(
      `${input.brand.displayName} is not currently exposing a debuggable CDP endpoint for attach mode.`,
    );
  }

  if (input.strategy === "headless" && input.runningPid !== undefined) {
    throw new Error(
      `${input.brand.displayName} is already running. Close it first or use managed-relaunch.`,
    );
  }

  if (input.strategy === "managed-relaunch" && input.runningPid === undefined) {
    throw new Error(
      `${input.brand.displayName} is not currently running, so managed-relaunch is not available.`,
    );
  }
}

function inferBrandFromUserDataDir(userDataDir: string): BrowserBrandRecord | undefined {
  const normalized = normalizePath(userDataDir);

  return getAllBrowserBrands().find((brand) => {
    const config = resolveBrandPlatformConfig(brand);
    if (!config) {
      return false;
    }

    const defaultDir = normalizePath(config.userDataDir);
    return normalized === defaultDir || normalized.startsWith(`${defaultDir}/`);
  });
}

function inferBrandFromExecutablePath(executablePath: string): BrowserBrandRecord | undefined {
  const normalized = normalizePath(executablePath);

  return getAllBrowserBrands().find((brand) => {
    const config = resolveBrandPlatformConfig(brand);
    if (!config) {
      return false;
    }

    return config.executableCandidates.some(
      (candidate) => candidate !== null && normalizePath(candidate) === normalized,
    );
  });
}

function buildCaptureChromeArgs(input: {
  readonly userDataDir: string;
  readonly profileDirectory?: string;
}): readonly string[] {
  const args = [
    "--remote-debugging-port=0",
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    `--user-data-dir=${input.userDataDir}`,
  ];

  if (input.profileDirectory !== undefined) {
    args.push(`--profile-directory=${input.profileDirectory}`);
  }

  return args;
}

async function waitForCaptureEndpoint(input: {
  readonly brandDisplayName: string;
  readonly child: ReturnType<typeof spawn>;
  readonly stderrLines: readonly string[];
  readonly timeoutMs: number;
  readonly userDataDir: string;
}): Promise<string> {
  const deadline = Date.now() + input.timeoutMs;

  while (Date.now() < deadline) {
    const activePort = readDevToolsActivePort(input.userDataDir);
    if (activePort) {
      try {
        return (
          await inspectCdpEndpoint({
            endpoint: `http://127.0.0.1:${String(activePort.port)}`,
            timeoutMs: Math.min(2_000, input.timeoutMs),
          })
        ).endpoint;
      } catch {
        return `ws://127.0.0.1:${String(activePort.port)}${activePort.webSocketPath}`;
      }
    }

    if (input.child.exitCode !== null) {
      break;
    }

    await sleep(DEVTOOLS_POLL_INTERVAL_MS);
  }

  throw new Error(formatCaptureLaunchError(input.brandDisplayName, input.stderrLines));
}

function formatCaptureLaunchError(
  brandDisplayName: string,
  stderrLines: readonly string[],
): string {
  const relevantLines = stderrLines
    .join("")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (relevantLines.length === 0) {
    return `${brandDisplayName} failed to launch before exposing a DevTools endpoint.`;
  }

  const focusedLines = relevantLines.filter((line) =>
    /(error|fatal|sandbox|namespace|permission|cannot|failed|abort)/i.test(line),
  );

  return `${brandDisplayName} failed to launch before exposing a DevTools endpoint.\n${(focusedLines.length >
  0
    ? focusedLines
    : relevantLines
  )
    .slice(-5)
    .join("\n")}`;
}

async function terminateChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  try {
    child.kill("SIGKILL");
  } catch {
    return;
  }

  await sleep(50);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await sleep(50);
  }
  return !isProcessRunning(pid);
}

function normalizePath(value: string): string {
  return resolve(expandHome(value)).replaceAll("\\", "/").toLowerCase();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
