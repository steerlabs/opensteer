import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { detectInstalledBrowserBrands } from "./browser-brands.js";
import type {
  LocalBrowserInstallation,
  LocalChromeInstallation,
  LocalChromeProfileDescriptor,
} from "./types.js";

export function expandHome(value: string): string {
  if (value === "~" || value.startsWith("~/")) {
    return join(homedir(), value.slice(1));
  }
  return value;
}

export function resolveChromeUserDataDir(userDataDir: string | undefined): string {
  if (userDataDir !== undefined) {
    return resolve(expandHome(userDataDir));
  }

  const installation = detectLocalChromeInstallations().find(
    (candidate) =>
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
        executablePath: firstExistingPath(["/Applications/Chromium.app/Contents/MacOS/Chromium"]),
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

export function detectLocalBrowserInstallations(): readonly LocalBrowserInstallation[] {
  return detectInstalledBrowserBrands().map((installation) => ({
    brand: installation.brandId,
    executablePath: installation.executablePath,
    userDataDir: installation.userDataDir,
  }));
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

export function firstExistingPath(
  candidates: readonly (string | null | undefined)[],
): string | null {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function resolveBinaryFromPath(name: string): string | null {
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
