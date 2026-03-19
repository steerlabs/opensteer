import type {
  OpensteerAutoConnectBrowserLaunchOptions,
  OpensteerCdpBrowserLaunchOptions,
  OpensteerManagedBrowserLaunchOptions,
  OpensteerProfileBrowserLaunchOptions,
} from "@opensteer/protocol";

import {
  expandHome,
  resolveChromeExecutablePath,
} from "./chrome-discovery.js";
import type {
  ResolvedAutoConnectBrowserLaunch,
  ResolvedCdpBrowserLaunch,
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
