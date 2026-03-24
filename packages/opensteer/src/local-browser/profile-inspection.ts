import { execFile as execFileCallback } from "node:child_process";
import { lstat, readlink, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  detectLocalBrowserInstallations,
  expandHome,
  readDevToolsActivePort,
  resolveChromeUserDataDir,
} from "./chrome-discovery.js";
import { type BrowserBrandId, getAllBrowserBrands, isBrandProcess } from "./browser-brands.js";
import { inspectCdpEndpoint } from "./cdp-discovery.js";
import { CHROME_SINGLETON_ARTIFACTS, type ChromeSingletonArtifact } from "./chrome-singletons.js";
import { readLiveProfileLaunchMetadata, withProfileLaunchLock } from "./profile-launch-metadata.js";
import { isProcessRunning } from "./process-owner.js";
import type { LaunchMetadataRecord } from "./types.js";

const execFile = promisify(execFileCallback);
const PROCESS_LIST_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const PS_COMMAND_ENV = { ...process.env, LC_ALL: "C" };

export type OpensteerLocalProfileInspection =
  | {
      readonly status: "available";
      readonly userDataDir: string;
    }
  | {
      readonly status: "unsupported_default_user_data_dir";
      readonly userDataDir: string;
      readonly installationBrand: BrowserBrandId | "unknown";
    }
  | {
      readonly status: "opensteer_owned";
      readonly userDataDir: string;
      readonly launchMetadata: LaunchMetadataRecord;
      readonly owner:
        | {
            readonly pid: number;
            readonly processStartedAtMs: number;
          }
        | undefined;
    }
  | {
      readonly status: "browser_owned";
      readonly userDataDir: string;
      readonly evidence: "devtools" | "singleton_owner" | "singleton_artifacts";
      readonly ownerPid?: number;
      readonly cdpEndpoint?: string;
      readonly attachMode: "attach" | null;
    }
  | {
      readonly status: "stale_lock";
      readonly userDataDir: string;
      readonly artifacts: readonly ChromeSingletonArtifact[];
      readonly staleOwnerPid?: number;
    };

export interface OpensteerLocalProfileUnlockResult {
  readonly userDataDir: string;
  readonly removed: readonly ChromeSingletonArtifact[];
}

export class OpensteerLocalProfileUnavailableError extends Error {
  readonly code = "profile-unavailable";

  constructor(readonly inspection: OpensteerLocalProfileInspection) {
    super(formatLocalProfileInspectionMessage(inspection));
    this.name = "OpensteerLocalProfileUnavailableError";
  }
}

export async function inspectLocalBrowserProfile(
  input: {
    readonly userDataDir?: string;
  } = {},
): Promise<OpensteerLocalProfileInspection> {
  const userDataDir = resolveChromeUserDataDir(input.userDataDir);
  const defaultInstallation = findDefaultBrowserInstallation(userDataDir);
  if (defaultInstallation) {
    return {
      status: "unsupported_default_user_data_dir",
      userDataDir,
      installationBrand: defaultInstallation.brand,
    };
  }

  const liveLaunch = await readLiveProfileLaunchMetadata(userDataDir);
  if (liveLaunch) {
    return {
      status: "opensteer_owned",
      userDataDir,
      launchMetadata: liveLaunch.launchMetadata,
      owner: liveLaunch.owner,
    };
  }

  const cdpInspection = await discoverActivePortBrowserEndpoint(userDataDir);
  if (cdpInspection) {
    return {
      status: "browser_owned",
      userDataDir,
      evidence: "devtools",
      cdpEndpoint: cdpInspection.endpoint,
      attachMode: cdpInspection.attachMode,
    };
  }

  const singletonArtifacts = await listSingletonArtifacts(userDataDir);
  if (singletonArtifacts.length === 0) {
    return {
      status: "available",
      userDataDir,
    };
  }

  const singletonOwner = await inspectSingletonOwner(userDataDir);
  if (singletonOwner?.kind === "live") {
    return {
      status: "browser_owned",
      userDataDir,
      evidence: "singleton_owner",
      ownerPid: singletonOwner.pid,
      attachMode: null,
    };
  }

  if (singletonOwner?.kind === "stale") {
    return {
      status: "stale_lock",
      userDataDir,
      artifacts: singletonArtifacts,
      staleOwnerPid: singletonOwner.pid,
    };
  }

  return {
    status: "browser_owned",
    userDataDir,
    evidence: "singleton_artifacts",
    attachMode: null,
  };
}

export async function unlockLocalBrowserProfile(input: {
  readonly userDataDir: string;
}): Promise<OpensteerLocalProfileUnlockResult> {
  const userDataDir = resolve(expandHome(input.userDataDir));
  return withProfileLaunchLock(userDataDir, async () => {
    const inspection = await inspectLocalBrowserProfile({ userDataDir });
    if (inspection.status !== "stale_lock") {
      throw new OpensteerLocalProfileUnavailableError(inspection);
    }

    await Promise.all(
      inspection.artifacts.map((artifact) =>
        rm(join(userDataDir, artifact), {
          recursive: true,
          force: true,
        }),
      ),
    );

    return {
      userDataDir,
      removed: inspection.artifacts,
    };
  });
}

function formatLocalProfileInspectionMessage(inspection: OpensteerLocalProfileInspection): string {
  switch (inspection.status) {
    case "unsupported_default_user_data_dir":
      return 'The selected user-data-dir is a default Chromium-family browser profile. Use browser.kind="snapshot-session" or browser.kind="snapshot-authenticated" to launch from a copy, or browser.kind="attach-live" to connect to an already-debuggable browser.';
    case "opensteer_owned":
      return "This profile is already owned by Opensteer. Reuse the existing session with Opensteer.attach(...) or the named CLI session.";
    case "browser_owned":
      if (inspection.attachMode === "attach") {
        return 'The browser is already running with remote debugging. Attach with --browser attach-live or browser.kind="attach-live".';
      }
      return 'The browser appears to own this profile, but it is not exposing CDP. Close it or start it with remote debugging, then attach with browser.kind="attach-live".';
    case "stale_lock":
      return `This profile has stale Chrome lock artifacts. Run opensteer local-profile unlock --user-data-dir ${JSON.stringify(inspection.userDataDir)} and retry.`;
    case "available":
      return `Profile ${inspection.userDataDir} is available.`;
  }
}

async function discoverActivePortBrowserEndpoint(userDataDir: string): Promise<
  | {
      readonly endpoint: string;
      readonly attachMode: "attach";
    }
  | undefined
> {
  const activePort = readDevToolsActivePort(userDataDir);
  if (!activePort) {
    return undefined;
  }

  let endpoint = `ws://127.0.0.1:${String(activePort.port)}${activePort.webSocketPath}`;
  try {
    endpoint = (
      await inspectCdpEndpoint({
        endpoint: `http://127.0.0.1:${String(activePort.port)}`,
      })
    ).endpoint;
  } catch {}

  return {
    endpoint,
    attachMode: "attach",
  };
}

function findDefaultBrowserInstallation(userDataDir: string):
  | {
      readonly brand: BrowserBrandId;
    }
  | undefined {
  const normalized = resolve(userDataDir);
  const installation = detectLocalBrowserInstallations().find(
    (candidate) => resolve(candidate.userDataDir) === normalized,
  );
  return installation ? { brand: installation.brand } : undefined;
}

async function listSingletonArtifacts(userDataDir: string): Promise<ChromeSingletonArtifact[]> {
  const artifacts = await Promise.all(
    CHROME_SINGLETON_ARTIFACTS.map(async (artifact) => {
      try {
        await lstat(join(userDataDir, artifact));
        return artifact;
      } catch {
        return null;
      }
    }),
  );

  return artifacts.filter((artifact): artifact is ChromeSingletonArtifact => artifact !== null);
}

async function inspectSingletonOwner(userDataDir: string): Promise<
  | {
      readonly kind: "live";
      readonly pid: number;
    }
  | {
      readonly kind: "stale";
      readonly pid: number;
    }
  | undefined
> {
  if (process.platform === "win32") {
    return undefined;
  }

  const owner = await readSingletonLockOwner(userDataDir);
  if (!owner) {
    return undefined;
  }
  if (!isLocalHostname(owner.host)) {
    return undefined;
  }

  if (!isProcessRunning(owner.pid)) {
    return {
      kind: "stale",
      pid: owner.pid,
    };
  }

  if (await isKnownBrowserProcess(owner.pid)) {
    return {
      kind: "live",
      pid: owner.pid,
    };
  }

  return undefined;
}

async function readSingletonLockOwner(userDataDir: string): Promise<
  | {
      readonly host: string;
      readonly pid: number;
    }
  | undefined
> {
  const singletonLockPath = join(userDataDir, "SingletonLock");
  let stats;
  try {
    stats = await lstat(singletonLockPath);
  } catch {
    return undefined;
  }
  if (!stats.isSymbolicLink()) {
    return undefined;
  }

  let target: string;
  try {
    target = await readlink(singletonLockPath);
  } catch {
    return undefined;
  }

  const parsed = parseSingletonLockTarget(target);
  return parsed ?? undefined;
}

function parseSingletonLockTarget(target: string): {
  readonly host: string;
  readonly pid: number;
} | null {
  const normalizedTarget = basename(target);
  const match = /^(.*)-(\d+)$/.exec(normalizedTarget);
  if (!match) {
    return null;
  }

  const pid = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  return {
    host: match[1] ?? "",
    pid,
  };
}

function isLocalHostname(candidate: string): boolean {
  return normalizeHostname(candidate) === normalizeHostname(hostname());
}

function normalizeHostname(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.local$/, "");
}

async function isKnownBrowserProcess(pid: number): Promise<boolean> {
  const command = await readProcessCommandLine(pid);
  if (!command) {
    return false;
  }

  return getAllBrowserBrands().some((brand) => isBrandProcess(brand, command));
}

async function readProcessCommandLine(pid: number): Promise<string | null> {
  if (pid <= 0) {
    return null;
  }

  if (process.platform === "win32") {
    try {
      const { stdout } = await execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${String(pid)}").CommandLine`,
        ],
        {
          encoding: "utf8",
          maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
        },
      );
      const command = stdout.trim();
      return command.length > 0 ? command : null;
    } catch {
      return null;
    }
  }

  try {
    const { stdout } = await execFile("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      env: PS_COMMAND_ENV,
      maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
    });
    const command = stdout.trim();
    return command.length > 0 ? command : null;
  } catch {
    return null;
  }
}
