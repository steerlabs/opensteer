import type {
  OpensteerAttachBrowserLaunchOptions,
  OpensteerClonedBrowserLaunchOptions,
  OpensteerManagedBrowserLaunchOptions,
  OpensteerProfileBrowserLaunchOptions,
} from "@opensteer/protocol";

import { expandHome, resolveChromeExecutablePath } from "./chrome-discovery.js";
import type {
  ResolvedAttachBrowserLaunch,
  ResolvedClonedBrowserLaunch,
  ResolvedManagedBrowserLaunch,
  ResolvedProfileBrowserLaunch,
} from "./types.js";
import { resolve } from "node:path";

const DEFAULT_PROFILE_DIRECTORY = "Default";
const DEFAULT_TIMEOUT_MS = 30_000;

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

export function resolveClonedBrowserLaunch(
  input: OpensteerClonedBrowserLaunchOptions,
): ResolvedClonedBrowserLaunch {
  return {
    executablePath: resolveChromeExecutablePath(input.executablePath),
    headless: input.headless ?? true,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    args: [...(input.args ?? [])],
    sourceUserDataDir: resolve(expandHome(input.sourceUserDataDir)),
    sourceProfileDirectory: input.sourceProfileDirectory?.trim() || DEFAULT_PROFILE_DIRECTORY,
  };
}

export function resolveAttachBrowserLaunch(
  input: OpensteerAttachBrowserLaunchOptions,
): ResolvedAttachBrowserLaunch {
  const endpoint = input.endpoint?.trim();
  if (endpoint !== undefined && endpoint.length === 0) {
    throw new Error("browser.endpoint must be a non-empty CDP port or URL.");
  }
  if (endpoint === undefined && input.headers !== undefined) {
    throw new Error("browser.headers requires browser.endpoint.");
  }

  return {
    ...(endpoint === undefined ? {} : { endpoint }),
    freshTab: input.freshTab ?? true,
    ...(input.headers === undefined ? {} : { headers: input.headers }),
  };
}
