import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { expandHome, firstExistingPath, resolveBinaryFromPath } from "./chrome-discovery.js";

const PROCESS_LIST_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const PS_COMMAND_ENV = { ...process.env, LC_ALL: "C" };
const WINDOWS_PROGRAM_FILES = process.env.PROGRAMFILES ?? "C:\\Program Files";
const WINDOWS_PROGRAM_FILES_X86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";

export type BrowserBrandId =
  | "chrome"
  | "chrome-canary"
  | "chromium"
  | "brave"
  | "edge"
  | "vivaldi"
  | "helium";

export interface BrowserBrandPlatformConfig {
  readonly executableCandidates: readonly (string | null)[];
  readonly userDataDir: string;
  readonly bundleId?: string;
  readonly processNames: readonly string[];
}

export interface BrowserBrandRecord {
  readonly id: BrowserBrandId;
  readonly displayName: string;
  readonly darwin?: BrowserBrandPlatformConfig;
  readonly win32?: BrowserBrandPlatformConfig;
  readonly linux?: BrowserBrandPlatformConfig;
}

export interface InstalledBrowserBrand {
  readonly brand: BrowserBrandRecord;
  readonly brandId: BrowserBrandId;
  readonly displayName: string;
  readonly executablePath: string;
  readonly userDataDir: string;
}

const BROWSER_BRANDS: readonly BrowserBrandRecord[] = [
  {
    id: "chrome",
    displayName: "Google Chrome",
    darwin: {
      executableCandidates: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
      userDataDir: "~/Library/Application Support/Google/Chrome",
      bundleId: "com.google.Chrome",
      processNames: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    },
    win32: {
      executableCandidates: [
        join(WINDOWS_PROGRAM_FILES, "Google", "Chrome", "Application", "chrome.exe"),
        join(WINDOWS_PROGRAM_FILES_X86, "Google", "Chrome", "Application", "chrome.exe"),
        join("~", "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
      ],
      userDataDir: "~/AppData/Local/Google/Chrome/User Data",
      processNames: ["/google/chrome/application/chrome.exe"],
    },
    linux: {
      executableCandidates: [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/opt/google/chrome/chrome",
        resolveBinaryFromPath("google-chrome"),
        resolveBinaryFromPath("google-chrome-stable"),
      ],
      userDataDir: "~/.config/google-chrome",
      processNames: ["/google-chrome", "/google-chrome-stable", "/opt/google/chrome/chrome"],
    },
  },
  {
    id: "chrome-canary",
    displayName: "Google Chrome Canary",
    darwin: {
      executableCandidates: [
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      ],
      userDataDir: "~/Library/Application Support/Google/Chrome Canary",
      bundleId: "com.google.Chrome.canary",
      processNames: ["/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"],
    },
    win32: {
      executableCandidates: [
        join("~", "AppData", "Local", "Google", "Chrome SxS", "Application", "chrome.exe"),
      ],
      userDataDir: "~/AppData/Local/Google/Chrome SxS/User Data",
      processNames: ["/google/chrome sxs/application/chrome.exe"],
    },
  },
  {
    id: "chromium",
    displayName: "Chromium",
    darwin: {
      executableCandidates: ["/Applications/Chromium.app/Contents/MacOS/Chromium"],
      userDataDir: "~/Library/Application Support/Chromium",
      bundleId: "org.chromium.Chromium",
      processNames: ["/Applications/Chromium.app/Contents/MacOS/Chromium"],
    },
    win32: {
      executableCandidates: [
        join(WINDOWS_PROGRAM_FILES, "Chromium", "Application", "chrome.exe"),
        join(WINDOWS_PROGRAM_FILES_X86, "Chromium", "Application", "chrome.exe"),
        join("~", "AppData", "Local", "Chromium", "Application", "chrome.exe"),
      ],
      userDataDir: "~/AppData/Local/Chromium/User Data",
      processNames: ["/chromium/application/chrome.exe"],
    },
    linux: {
      executableCandidates: [
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        resolveBinaryFromPath("chromium"),
        resolveBinaryFromPath("chromium-browser"),
      ],
      userDataDir: "~/.config/chromium",
      processNames: ["/chromium", "/chromium-browser"],
    },
  },
  {
    id: "brave",
    displayName: "Brave Browser",
    darwin: {
      executableCandidates: ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
      userDataDir: "~/Library/Application Support/BraveSoftware/Brave-Browser",
      bundleId: "com.brave.Browser",
      processNames: ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
    },
    win32: {
      executableCandidates: [
        join(WINDOWS_PROGRAM_FILES, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        join(
          WINDOWS_PROGRAM_FILES_X86,
          "BraveSoftware",
          "Brave-Browser",
          "Application",
          "brave.exe",
        ),
        join("~", "AppData", "Local", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      ],
      userDataDir: "~/AppData/Local/BraveSoftware/Brave-Browser/User Data",
      processNames: ["/bravesoftware/brave-browser/application/brave.exe"],
    },
    linux: {
      executableCandidates: [
        "/usr/bin/brave-browser",
        "/opt/brave.com/brave/brave-browser",
        resolveBinaryFromPath("brave-browser"),
      ],
      userDataDir: "~/.config/BraveSoftware/Brave-Browser",
      processNames: ["/brave-browser", "/opt/brave.com/brave/brave-browser"],
    },
  },
  {
    id: "edge",
    displayName: "Microsoft Edge",
    darwin: {
      executableCandidates: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
      userDataDir: "~/Library/Application Support/Microsoft Edge",
      bundleId: "com.microsoft.edgemac",
      processNames: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    },
    win32: {
      executableCandidates: [
        join(WINDOWS_PROGRAM_FILES, "Microsoft", "Edge", "Application", "msedge.exe"),
        join(WINDOWS_PROGRAM_FILES_X86, "Microsoft", "Edge", "Application", "msedge.exe"),
        join("~", "AppData", "Local", "Microsoft", "Edge", "Application", "msedge.exe"),
      ],
      userDataDir: "~/AppData/Local/Microsoft/Edge/User Data",
      processNames: ["/microsoft/edge/application/msedge.exe"],
    },
    linux: {
      executableCandidates: [
        "/usr/bin/microsoft-edge",
        "/usr/bin/microsoft-edge-stable",
        "/opt/microsoft/msedge/msedge",
        resolveBinaryFromPath("microsoft-edge"),
        resolveBinaryFromPath("microsoft-edge-stable"),
      ],
      userDataDir: "~/.config/microsoft-edge",
      processNames: ["/microsoft-edge", "/microsoft-edge-stable", "/opt/microsoft/msedge/msedge"],
    },
  },
  {
    id: "vivaldi",
    displayName: "Vivaldi",
    darwin: {
      executableCandidates: ["/Applications/Vivaldi.app/Contents/MacOS/Vivaldi"],
      userDataDir: "~/Library/Application Support/Vivaldi",
      bundleId: "com.vivaldi.Vivaldi",
      processNames: ["/Applications/Vivaldi.app/Contents/MacOS/Vivaldi"],
    },
    win32: {
      executableCandidates: [
        join(WINDOWS_PROGRAM_FILES, "Vivaldi", "Application", "vivaldi.exe"),
        join(WINDOWS_PROGRAM_FILES_X86, "Vivaldi", "Application", "vivaldi.exe"),
        join("~", "AppData", "Local", "Vivaldi", "Application", "vivaldi.exe"),
      ],
      userDataDir: "~/AppData/Local/Vivaldi/User Data",
      processNames: ["/vivaldi/application/vivaldi.exe"],
    },
    linux: {
      executableCandidates: [
        "/usr/bin/vivaldi",
        "/usr/bin/vivaldi-stable",
        "/opt/vivaldi/vivaldi",
        resolveBinaryFromPath("vivaldi"),
        resolveBinaryFromPath("vivaldi-stable"),
      ],
      userDataDir: "~/.config/vivaldi",
      processNames: ["/vivaldi", "/vivaldi-stable", "/opt/vivaldi/vivaldi"],
    },
  },
  {
    id: "helium",
    displayName: "Helium",
    darwin: {
      executableCandidates: ["/Applications/Helium.app/Contents/MacOS/Helium"],
      userDataDir: "~/Library/Application Support/Helium",
      processNames: ["/Applications/Helium.app/Contents/MacOS/Helium"],
    },
  },
] as const;

export function getAllBrowserBrands(): readonly BrowserBrandRecord[] {
  return BROWSER_BRANDS;
}

export function getBrowserBrand(id: BrowserBrandId): BrowserBrandRecord {
  const brand = BROWSER_BRANDS.find((candidate) => candidate.id === id);
  if (!brand) {
    throw new Error(`Unknown browser brand "${id}".`);
  }
  return brand;
}

export function resolveBrandPlatformConfig(
  brand: BrowserBrandRecord,
  platform: NodeJS.Platform = process.platform,
): BrowserBrandPlatformConfig | undefined {
  if (platform === "darwin") {
    return brand.darwin;
  }
  if (platform === "win32") {
    return brand.win32;
  }
  if (platform === "linux") {
    return brand.linux;
  }
  return undefined;
}

export function detectInstalledBrowserBrands(): readonly InstalledBrowserBrand[] {
  const installations: InstalledBrowserBrand[] = [];

  for (const brand of BROWSER_BRANDS) {
    const platformConfig = resolveBrandPlatformConfig(brand);
    if (!platformConfig) {
      continue;
    }

    const executablePath = firstExistingPath(
      resolveExecutableCandidates(platformConfig.executableCandidates),
    );
    if (!executablePath) {
      continue;
    }

    installations.push({
      brand,
      brandId: brand.id,
      displayName: brand.displayName,
      executablePath,
      userDataDir: resolve(expandHome(platformConfig.userDataDir)),
    });
  }

  return installations;
}

export function resolveBrandExecutablePath(
  brand: BrowserBrandRecord,
  explicitPath?: string,
): string {
  if (explicitPath !== undefined) {
    const resolvedPath = resolve(expandHome(explicitPath));
    if (!existsSync(resolvedPath)) {
      throw new Error(`${brand.displayName} executable was not found at "${resolvedPath}".`);
    }
    return resolvedPath;
  }

  const platformConfig = resolveBrandPlatformConfig(brand);
  if (!platformConfig) {
    throw new Error(`${brand.displayName} is not supported on ${process.platform}.`);
  }

  const resolvedPath = firstExistingPath(
    resolveExecutableCandidates(platformConfig.executableCandidates),
  );
  if (!resolvedPath) {
    throw new Error(
      `Could not find a ${brand.displayName} executable. Pass --executable-path or browser.executablePath.`,
    );
  }
  return resolvedPath;
}

export function resolveBrandUserDataDir(brand: BrowserBrandRecord, explicitDir?: string): string {
  if (explicitDir !== undefined) {
    return resolve(expandHome(explicitDir));
  }

  const platformConfig = resolveBrandPlatformConfig(brand);
  if (!platformConfig) {
    throw new Error(`${brand.displayName} is not supported on ${process.platform}.`);
  }

  return resolve(expandHome(platformConfig.userDataDir));
}

export function isBrandProcess(brand: BrowserBrandRecord, commandLine: string): boolean {
  const normalizedCommand = normalizeCommand(commandLine);
  if (!normalizedCommand) {
    return false;
  }
  if (normalizedCommand.includes("crashpad_handler")) {
    return false;
  }
  if (/\s--type=/.test(normalizedCommand)) {
    return false;
  }

  return getBrandProcessMarkers(brand).some((marker) => normalizedCommand.includes(marker));
}

export function findBrandProcess(brand: BrowserBrandRecord): {
  readonly pid: number;
} | null {
  for (const processEntry of listProcesses()) {
    if (isBrandProcess(brand, processEntry.commandLine)) {
      return { pid: processEntry.pid };
    }
  }

  return null;
}

function getBrandProcessMarkers(brand: BrowserBrandRecord): readonly string[] {
  const markers = new Set<string>();

  for (const config of [brand.darwin, brand.win32, brand.linux]) {
    if (!config) {
      continue;
    }

    for (const processName of config.processNames) {
      const normalized = normalizeCommand(processName);
      if (normalized) {
        markers.add(normalized);
      }
    }

    for (const candidate of config.executableCandidates) {
      if (!candidate) {
        continue;
      }

      const normalized = normalizeCommand(resolve(expandHome(candidate)));
      if (normalized) {
        markers.add(normalized);
      }
    }
  }

  return [...markers];
}

function resolveExecutableCandidates(
  candidates: readonly (string | null)[],
): readonly (string | null)[] {
  return candidates.map((candidate) => (candidate ? resolve(expandHome(candidate)) : null));
}

function listProcesses(): readonly {
  readonly pid: number;
  readonly commandLine: string;
}[] {
  if (process.platform === "win32") {
    return listWindowsProcesses();
  }
  return listUnixProcesses();
}

function listUnixProcesses(): readonly {
  readonly pid: number;
  readonly commandLine: string;
}[] {
  try {
    const output = execFileSync("ps", ["-A", "-o", "pid=,command="], {
      encoding: "utf8",
      env: PS_COMMAND_ENV,
      maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
    });

    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const match = /^(\d+)\s+(.*)$/.exec(line);
        if (!match) {
          return null;
        }

        const pid = Number.parseInt(match[1] ?? "", 10);
        const commandLine = match[2]?.trim() ?? "";
        if (!Number.isInteger(pid) || pid <= 0 || commandLine.length === 0) {
          return null;
        }

        return {
          pid,
          commandLine,
        };
      })
      .filter(
        (entry): entry is { readonly pid: number; readonly commandLine: string } => entry !== null,
      )
      .sort((left, right) => left.pid - right.pid);
  } catch {
    return [];
  }
}

function listWindowsProcesses(): readonly {
  readonly pid: number;
  readonly commandLine: string;
}[] {
  try {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
      ],
      {
        encoding: "utf8",
        maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    if (!output) {
      return [];
    }

    const parsed = JSON.parse(output) as
      | {
          readonly ProcessId?: unknown;
          readonly CommandLine?: unknown;
        }
      | readonly {
          readonly ProcessId?: unknown;
          readonly CommandLine?: unknown;
        }[];
    const records = Array.isArray(parsed) ? parsed : [parsed];

    return records
      .map((record) => {
        const pid = Number(record.ProcessId);
        const commandLine = typeof record.CommandLine === "string" ? record.CommandLine.trim() : "";
        if (!Number.isInteger(pid) || pid <= 0 || commandLine.length === 0) {
          return null;
        }

        return {
          pid,
          commandLine,
        };
      })
      .filter(
        (entry): entry is { readonly pid: number; readonly commandLine: string } => entry !== null,
      )
      .sort((left, right) => left.pid - right.pid);
  } catch {
    return [];
  }
}

function normalizeCommand(value: string): string {
  return value.trim().replaceAll("\\", "/").toLowerCase();
}
