import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import type {
  LocalChromeInstallation,
  LocalChromeProfileDescriptor,
  ResolvedAutoConnectBrowserLaunch,
  ResolvedCdpBrowserLaunch,
  ResolvedManagedBrowserLaunch,
  ResolvedProfileBrowserLaunch,
} from "./types.js";
import type {
  OpensteerAutoConnectBrowserLaunchOptions,
  OpensteerCdpBrowserLaunchOptions,
  OpensteerManagedBrowserLaunchOptions,
  OpensteerProfileBrowserLaunchOptions,
} from "@opensteer/protocol";

const DEFAULT_PROFILE_DIRECTORY = "Default";
const DEFAULT_TIMEOUT_MS = 30_000;
const AUTO_CONNECT_PORT_CANDIDATES = [9222, 9229] as const;

export function expandHome(value: string): string {
  if (value === "~" || value.startsWith("~/")) {
    return join(homedir(), value.slice(1));
  }
  return value;
}

export function resolveManagedBrowserLaunch(
  input: OpensteerManagedBrowserLaunchOptions = {},
): ResolvedManagedBrowserLaunch {
  return {
    executablePath: resolveChromeExecutablePath(input.executablePath),
    headless: input.headless ?? true,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    args: [...(input.args ?? [])],
  };
}

export function resolveProfileBrowserLaunch(
  input: OpensteerProfileBrowserLaunchOptions,
): ResolvedProfileBrowserLaunch {
  return {
    executablePath: resolveChromeExecutablePath(input.executablePath),
    headless: input.headless ?? true,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    args: [...(input.args ?? [])],
    userDataDir: resolve(expandHome(input.userDataDir)),
    profileDirectory: input.profileDirectory?.trim() || DEFAULT_PROFILE_DIRECTORY,
  };
}

export function resolveCdpBrowserLaunch(
  input: OpensteerCdpBrowserLaunchOptions,
): ResolvedCdpBrowserLaunch {
  const endpoint = input.endpoint.trim();
  if (!endpoint) {
    throw new Error("browser.endpoint must be a non-empty CDP port or URL.");
  }

  return {
    endpoint,
    freshTab: input.freshTab ?? true,
    ...(input.headers === undefined ? {} : { headers: input.headers }),
  };
}

export function resolveAutoConnectBrowserLaunch(
  input: OpensteerAutoConnectBrowserLaunchOptions,
): ResolvedAutoConnectBrowserLaunch {
  return {
    freshTab: input.freshTab ?? true,
  };
}

export function resolveChromeUserDataDir(userDataDir: string | undefined): string {
  if (userDataDir !== undefined) {
    return resolve(expandHome(userDataDir));
  }

  const installation = detectLocalChromeInstallations().find((candidate) =>
    existsSync(join(candidate.userDataDir, "Local State")) || candidate.executablePath !== null,
  );
  if (!installation) {
    throw new Error("Could not find a local Chrome or Chromium profile directory.");
  }
  return installation.userDataDir;
}

export function resolveChromeExecutablePath(executablePath: string | undefined): string {
  if (executablePath !== undefined) {
    const resolvedPath = resolve(expandHome(executablePath));
    if (!existsSync(resolvedPath)) {
      throw new Error(`Chrome executable was not found at "${resolvedPath}".`);
    }
    return resolvedPath;
  }

  for (const installation of detectLocalChromeInstallations()) {
    if (installation.executablePath) {
      return installation.executablePath;
    }
  }

  throw new Error(
    "Could not find a Chrome or Chromium executable. Pass browser.executablePath or --executable-path.",
  );
}

export function detectLocalChromeInstallations(): readonly LocalChromeInstallation[] {
  if (process.platform === "darwin") {
    return [
      {
        brand: "chrome",
        executablePath: firstExistingPath([
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        ]),
        userDataDir: join(homedir(), "Library", "Application Support", "Google", "Chrome"),
      },
      {
        brand: "chromium",
        executablePath: firstExistingPath([
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]),
        userDataDir: join(homedir(), "Library", "Application Support", "Chromium"),
      },
    ];
  }

  if (process.platform === "win32") {
    const programFiles = process.env.PROGRAMFILES ?? "C:\\Program Files";
    const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return [
      {
        brand: "chrome",
        executablePath: firstExistingPath([
          join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
          join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
          join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
        ]),
        userDataDir: join(localAppData, "Google", "Chrome", "User Data"),
      },
      {
        brand: "chromium",
        executablePath: firstExistingPath([
          join(programFiles, "Chromium", "Application", "chrome.exe"),
          join(programFilesX86, "Chromium", "Application", "chrome.exe"),
          join(localAppData, "Chromium", "Application", "chrome.exe"),
        ]),
        userDataDir: join(localAppData, "Chromium", "User Data"),
      },
    ];
  }

  return [
    {
      brand: "chrome",
      executablePath: firstExistingPath([
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        resolveBinaryFromPath("google-chrome"),
        resolveBinaryFromPath("google-chrome-stable"),
      ]),
      userDataDir: join(homedir(), ".config", "google-chrome"),
    },
    {
      brand: "chromium",
      executablePath: firstExistingPath([
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        resolveBinaryFromPath("chromium"),
        resolveBinaryFromPath("chromium-browser"),
      ]),
      userDataDir: join(homedir(), ".config", "chromium"),
    },
  ];
}

export function listLocalChromeProfiles(
  userDataDir = resolveChromeUserDataDir(undefined),
): readonly LocalChromeProfileDescriptor[] {
  const resolvedUserDataDir = resolve(expandHome(userDataDir));
  const localStatePath = join(resolvedUserDataDir, "Local State");
  if (!existsSync(localStatePath)) {
    return [];
  }

  try {
    const raw = JSON.parse(readFileSync(localStatePath, "utf8")) as {
      readonly profile?: {
        readonly info_cache?: Record<string, unknown>;
      };
    };
    const infoCache = raw.profile?.info_cache;
    if (!infoCache || typeof infoCache !== "object") {
      return [];
    }

    return Object.entries(infoCache)
      .map(([directory, info]) => {
        const record =
          info && typeof info === "object" && !Array.isArray(info)
            ? (info as Record<string, unknown>)
            : {};
        const name =
          typeof record.name === "string" && record.name.trim().length > 0
            ? record.name.trim()
            : directory || basename(directory);
        return {
          directory,
          name,
          userDataDir: resolvedUserDataDir,
        };
      })
      .filter((profile) => profile.directory.trim().length > 0)
      .sort((left, right) => left.directory.localeCompare(right.directory));
  } catch {
    return [];
  }
}

export function readDevToolsActivePort(userDataDir: string): {
  readonly port: number;
  readonly webSocketPath: string;
} | null {
  const devToolsPath = join(userDataDir, "DevToolsActivePort");
  if (!existsSync(devToolsPath)) {
    return null;
  }

  try {
    const lines = readFileSync(devToolsPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const port = Number.parseInt(lines[0] ?? "", 10);
    if (!Number.isInteger(port) || port <= 0) {
      return null;
    }

    return {
      port,
      webSocketPath: lines[1] ?? "/devtools/browser",
    };
  } catch {
    return null;
  }
}

export async function discoverAutoConnectCdpEndpoint(): Promise<string> {
  for (const installation of detectLocalChromeInstallations()) {
    const activePort = readDevToolsActivePort(installation.userDataDir);
    if (!activePort) {
      continue;
    }

    const discovered = await discoverBrowserWebSocketUrl(`http://127.0.0.1:${String(activePort.port)}`);
    if (discovered) {
      return discovered;
    }

    if (await isPortReachable(activePort.port)) {
      return `ws://127.0.0.1:${String(activePort.port)}${activePort.webSocketPath}`;
    }
  }

  for (const port of AUTO_CONNECT_PORT_CANDIDATES) {
    const discovered = await discoverBrowserWebSocketUrl(`http://127.0.0.1:${String(port)}`);
    if (discovered) {
      return discovered;
    }
  }

  throw new Error(
    "No running Chrome instance found. Enable remote debugging and use --auto-connect or pass --cdp.",
  );
}

export async function discoverBrowserWebSocketUrl(
  endpoint: string,
  headers?: Readonly<Record<string, string>>,
): Promise<string | null> {
  const trimmedEndpoint = endpoint.trim();
  if (!trimmedEndpoint) {
    return null;
  }

  if (/^\d+$/.test(trimmedEndpoint)) {
    return discoverBrowserWebSocketUrl(`http://127.0.0.1:${trimmedEndpoint}`, headers);
  }

  if (trimmedEndpoint.startsWith("ws://") || trimmedEndpoint.startsWith("wss://")) {
    return trimmedEndpoint;
  }

  let url: URL;
  try {
    url = trimmedEndpoint.startsWith("http://") || trimmedEndpoint.startsWith("https://")
      ? new URL(trimmedEndpoint)
      : new URL(`http://${trimmedEndpoint}`);
  } catch {
    throw new Error(`Invalid CDP endpoint "${endpoint}".`);
  }

  const versionUrl = new URL("/json/version", url);
  const response = await fetch(versionUrl, {
    ...(headers === undefined ? {} : { headers }),
    signal: AbortSignal.timeout(2_000),
  }).catch(() => null);
  if (response?.ok) {
    const payload = (await response.json()) as {
      readonly webSocketDebuggerUrl?: unknown;
    };
    if (typeof payload.webSocketDebuggerUrl === "string" && payload.webSocketDebuggerUrl.length > 0) {
      return rewriteBrowserWebSocketHost(payload.webSocketDebuggerUrl, url);
    }
  }

  const listUrl = new URL("/json/list", url);
  const listResponse = await fetch(listUrl, {
    ...(headers === undefined ? {} : { headers }),
    signal: AbortSignal.timeout(2_000),
  }).catch(() => null);
  if (!listResponse?.ok) {
    return null;
  }

  const targets = (await listResponse.json()) as readonly {
    readonly type?: unknown;
    readonly webSocketDebuggerUrl?: unknown;
  }[];
  const browserTarget =
    targets.find((target) => target.type === "browser")
    ?? targets.find((target) => typeof target.webSocketDebuggerUrl === "string");
  return typeof browserTarget?.webSocketDebuggerUrl === "string"
    ? rewriteBrowserWebSocketHost(browserTarget.webSocketDebuggerUrl, url)
    : null;
}

function rewriteBrowserWebSocketHost(browserWsUrl: string, requestedUrl: URL): string {
  try {
    const parsed = new URL(browserWsUrl);
    parsed.protocol = requestedUrl.protocol === "https:" ? "wss:" : "ws:";
    parsed.hostname = requestedUrl.hostname;
    parsed.port = requestedUrl.port;
    return parsed.toString();
  } catch {
    return browserWsUrl;
  }
}

async function isPortReachable(port: number): Promise<boolean> {
  const result = await fetch(`http://127.0.0.1:${String(port)}/json/version`, {
    signal: AbortSignal.timeout(500),
  }).catch(() => null);
  return result !== null;
}

function firstExistingPath(candidates: readonly (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveBinaryFromPath(name: string): string | null {
  try {
    const output = execFileSync("which", [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}
