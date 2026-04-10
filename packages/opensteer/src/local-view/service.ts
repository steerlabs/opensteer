import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { acquireDirLock } from "../local-browser/dir-lock.js";
import {
  clearLocalViewServiceState,
  getLocalViewServiceStateLiveness,
  isLocalViewServiceStateLive,
  readLocalViewServiceState,
  type PersistedLocalViewServiceState,
} from "./service-state.js";
import { resolveLocalViewServiceLockDir } from "./runtime-dir.js";

const LOCAL_VIEW_STARTUP_TIMEOUT_MS = 10_000;
const LOCAL_VIEW_STARTUP_POLL_MS = 100;
const LOCAL_VIEW_STOP_TIMEOUT_MS = 10_000;

export async function ensureLocalViewServiceRunning(): Promise<{
  readonly url: string;
  readonly token: string;
}> {
  const current = await readReachableLocalViewServiceState();
  if (current !== undefined) {
    return current;
  }

  const releaseLock = await acquireDirLock(resolveLocalViewServiceLockDir());
  try {
    const lockedState = await readReachableLocalViewServiceState();
    if (lockedState !== undefined) {
      return lockedState;
    }

    await spawnLocalViewService();
    const started = await waitForLocalViewService();
    if (!started) {
      throw new Error("Timed out while starting the local view service.");
    }
    return started;
  } finally {
    await releaseLock();
  }
}

export async function stopLocalViewService(): Promise<boolean> {
  const state = await readLocalViewServiceState();
  if (state === undefined || !(await isLocalViewServiceStateLive(state))) {
    await clearLocalViewServiceState(
      state === undefined ? undefined : { pid: state.pid, token: state.token },
    );
    return false;
  }

  const liveState = state;
  const stopRequested = await requestLocalViewServiceStop(liveState).catch(() => false);
  if (!stopRequested && (await getLocalViewServiceStateLiveness(liveState)) !== "dead") {
    process.kill(liveState.pid);
  }

  await waitForLocalViewServiceStop(liveState);
  await clearLocalViewServiceState({ pid: liveState.pid, token: liveState.token });
  return true;
}

export async function readLocalViewDashboardUrl(): Promise<string | undefined> {
  return (await readReachableLocalViewServiceState())?.url;
}

export function buildLocalViewSessionUrl(args: {
  readonly baseUrl: string;
  readonly sessionId?: string;
}): string {
  if (!args.sessionId) {
    return args.baseUrl;
  }
  return `${args.baseUrl}#session=${encodeURIComponent(args.sessionId)}`;
}

async function requestLocalViewServiceStop(
  state: PersistedLocalViewServiceState,
): Promise<boolean> {
  const response = await fetch(new URL("/api/service/stop", state.url), {
    method: "POST",
    headers: {
      "x-opensteer-local-token": state.token,
    },
  });
  return response.ok;
}

async function waitForLocalViewServiceStop(state: PersistedLocalViewServiceState): Promise<void> {
  const deadline = Date.now() + LOCAL_VIEW_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await getLocalViewServiceStateLiveness(state)) === "dead") {
      return;
    }
    await delay(LOCAL_VIEW_STARTUP_POLL_MS);
  }

  throw new Error("Timed out while stopping the local view service.");
}

function spawnLocalViewService(): void {
  const command = resolveLocalViewSpawnCommand();
  const child = spawn(command.executable, command.args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(command.env ?? {}),
      OPENSTEER_LOCAL_VIEW_BOOT_TOKEN:
        process.env.OPENSTEER_LOCAL_VIEW_BOOT_TOKEN ?? randomBytes(24).toString("hex"),
    },
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  child.unref();
}

async function waitForLocalViewService(): Promise<
  | {
      readonly url: string;
      readonly token: string;
    }
  | undefined
> {
  const deadline = Date.now() + LOCAL_VIEW_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await readReachableLocalViewServiceState();
    if (state !== undefined) {
      return state;
    }
    await delay(LOCAL_VIEW_STARTUP_POLL_MS);
  }
  return undefined;
}

async function readReachableLocalViewServiceState(): Promise<
  PersistedLocalViewServiceState | undefined
> {
  const state = await readLocalViewServiceState();
  if (state === undefined || !(await isLocalViewServiceStateLive(state))) {
    return undefined;
  }
  return (await isLocalViewServiceReachable(state.url, state.token)) ? state : undefined;
}

async function isLocalViewServiceReachable(baseUrl: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/api/health", baseUrl), {
      headers: {
        "x-opensteer-local-token": token,
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

function resolveLocalViewSpawnCommand(): {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
} {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const distServicePath = findExistingPath([
    path.join(moduleDir, "local-view", "serve-entry.js"),
    path.join(moduleDir, "serve-entry.js"),
    path.join(moduleDir, "..", "local-view", "serve-entry.js"),
  ]);
  if (distServicePath) {
    return {
      executable: process.execPath,
      args: [distServicePath],
    };
  }

  const distCliPath = findExistingPath([
    path.join(moduleDir, "cli", "bin.js"),
    path.join(moduleDir, "..", "cli", "bin.js"),
  ]);
  if (distCliPath) {
    return {
      executable: process.execPath,
      args: [distCliPath, "view", "serve"],
    };
  }

  const srcServicePath = findExistingPath([
    path.join(moduleDir, "serve-entry.ts"),
    path.join(moduleDir, "..", "local-view", "serve-entry.ts"),
    path.join(moduleDir, "..", "src", "local-view", "serve-entry.ts"),
  ]);
  if (srcServicePath) {
    const require = createRequire(import.meta.url);
    const tsxLoaderPath = require.resolve("tsx");
    const tsconfigPath = findNearestTsconfig(path.resolve(moduleDir, "..", "..", ".."));
    return {
      executable: process.execPath,
      args: ["--import", tsxLoaderPath, srcServicePath],
      ...(tsconfigPath ? { env: { TSX_TSCONFIG_PATH: tsconfigPath } } : {}),
    };
  }

  const srcCliPath = findExistingPath([
    path.join(moduleDir, "..", "cli", "bin.ts"),
    path.join(moduleDir, "..", "src", "cli", "bin.ts"),
  ]);
  if (srcCliPath) {
    const require = createRequire(import.meta.url);
    const tsxLoaderPath = require.resolve("tsx");
    const tsconfigPath = findNearestTsconfig(path.resolve(moduleDir, "..", "..", ".."));
    return {
      executable: process.execPath,
      args: ["--import", tsxLoaderPath, srcCliPath, "view", "serve"],
      ...(tsconfigPath ? { env: { TSX_TSCONFIG_PATH: tsconfigPath } } : {}),
    };
  }

  throw new Error(`Could not resolve the Opensteer CLI entrypoint from ${moduleDir}.`);
}

function findExistingPath(candidates: readonly string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate));
}

function findNearestTsconfig(startDir: string): string | undefined {
  let currentDir = startDir;
  while (true) {
    const candidate = path.join(currentDir, "tsconfig.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return undefined;
    }
    currentDir = parentDir;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
