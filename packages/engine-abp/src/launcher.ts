import { createBrowserCoreError } from "@opensteer/browser-core";
import { promises as fs } from "node:fs";
import { accessSync, constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

import type { LaunchRequestOptions } from "./options.js";
import type { AbpBrowserStatus } from "./types.js";

export interface LaunchedAbpProcess {
  readonly process: ChildProcess;
  readonly baseUrl: string;
  readonly remoteDebuggingUrl: string;
}

interface AbpLaunchCommand {
  readonly executablePath: string;
  readonly args: readonly string[];
}

const require = createRequire(import.meta.url);

function resolveAgentBrowserProtocolRoot(): string | undefined {
  try {
    return join(dirname(require.resolve("agent-browser-protocol")), "..");
  } catch {
    return undefined;
  }
}

function resolveExecutablePath(candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }

  return undefined;
}

export async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  server.close();
  if (!address || typeof address === "string") {
    throw createBrowserCoreError("operation-failed", "failed to allocate a free TCP port");
  }
  return address.port;
}

function normalizeBrowserArgs(args: readonly string[]): readonly string[] {
  return args.map((arg) => (arg === "--headless" ? "--headless=new" : arg));
}

function ensureRemoteDebuggingPortArg(args: readonly string[]): readonly string[] {
  if (args.some((arg) => arg.startsWith("--remote-debugging-port="))) {
    return args;
  }

  return ["--remote-debugging-port=0", ...args];
}

export function resolveDefaultAbpBrowserExecutablePath(): string | undefined {
  const root = resolveAgentBrowserProtocolRoot();
  if (root === undefined) {
    return undefined;
  }

  return resolveExecutablePath([join(root, "browsers", "ABP.app", "Contents", "MacOS", "ABP")]);
}

export function resolveDefaultAbpWrapperExecutablePath(): string | undefined {
  const root = resolveAgentBrowserProtocolRoot();
  if (root === undefined) {
    return undefined;
  }

  return resolveExecutablePath([join(root, "dist", "bin", "abp.js")]);
}

export function resolveDefaultAbpExecutablePath(): string | undefined {
  return resolveDefaultAbpBrowserExecutablePath() ?? resolveDefaultAbpWrapperExecutablePath();
}

export function buildAbpLaunchCommand(options: LaunchRequestOptions): AbpLaunchCommand {
  if (options.abpExecutablePath !== undefined && options.browserExecutablePath !== undefined) {
    throw createBrowserCoreError(
      "invalid-argument",
      "provide either an ABP wrapper executable path or a browser executable path, not both",
    );
  }

  const browserArgs = normalizeBrowserArgs(options.args);
  const browserExecutablePath =
    options.browserExecutablePath ??
    (options.abpExecutablePath === undefined
      ? resolveDefaultAbpBrowserExecutablePath()
      : undefined);

  if (browserExecutablePath !== undefined) {
    return {
      executablePath: browserExecutablePath,
      args: [
        `--abp-port=${String(options.port)}`,
        "--use-mock-keychain",
        ...(options.headless ? ["--headless=new"] : []),
        `--user-data-dir=${options.userDataDir}`,
        `--abp-session-dir=${options.sessionDir}`,
        ...ensureRemoteDebuggingPortArg(browserArgs),
      ],
    };
  }

  return {
    executablePath:
      options.abpExecutablePath ??
      resolveDefaultAbpWrapperExecutablePath() ??
      "agent-browser-protocol",
    args: [
      "--port",
      String(options.port),
      ...(options.headless ? ["--headless"] : []),
      "--user-data-dir",
      options.userDataDir,
      "--session-dir",
      options.sessionDir,
      "--",
      ...ensureRemoteDebuggingPortArg(browserArgs),
    ],
  };
}

export async function launchAbpProcess(options: LaunchRequestOptions): Promise<LaunchedAbpProcess> {
  await Promise.all([
    fs.mkdir(options.userDataDir, { recursive: true }),
    fs.mkdir(options.sessionDir, { recursive: true }),
  ]);

  const command = buildAbpLaunchCommand(options);

  const child = spawn(command.executablePath, command.args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const outputBuffer: string[] = [];
  const appendOutput = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    outputBuffer.push(text);
    if (outputBuffer.length > 20) {
      outputBuffer.shift();
    }
  };

  const spawnError = new Promise<never>((_, reject) => {
    child.once("error", (error) => {
      reject(
        createBrowserCoreError(
          "operation-failed",
          `failed to launch ABP executable ${command.executablePath}: ${error.message}`,
          {
            cause: error,
          },
        ),
      );
    });
  });
  const exitError = new Promise<never>((_, reject) => {
    child.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGTERM" || signal === "SIGKILL") {
        return;
      }
      const details =
        outputBuffer.length === 0
          ? undefined
          : {
              output: outputBuffer.join(""),
            };
      reject(
        createBrowserCoreError(
          "operation-failed",
          `ABP exited before becoming ready (code=${String(code)}, signal=${String(signal)})`,
          details === undefined ? {} : { details },
        ),
      );
    });
  });

  if (options.verbose && child.stdout) {
    child.stdout.pipe(process.stdout);
  }
  if (options.verbose && child.stderr) {
    child.stderr.pipe(process.stderr);
  }
  child.stdout?.on("data", appendOutput);
  child.stderr?.on("data", appendOutput);

  const baseUrl = `http://127.0.0.1:${String(options.port)}/api/v1`;
  await Promise.race([waitForReady(baseUrl), spawnError, exitError]);
  const remoteDebuggingPort = await waitForDevToolsPort(options.userDataDir);
  return {
    process: child,
    baseUrl,
    remoteDebuggingUrl: `http://127.0.0.1:${String(remoteDebuggingPort)}`,
  };
}

async function waitForReady(baseUrl: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    try {
      const response = await fetch(`${baseUrl}/browser/status`);
      if (response.ok) {
        const body = (await response.json()) as AbpBrowserStatus;
        if (body.success && body.data.ready) {
          return;
        }
      }
    } catch {}

    await delay(200);
  }

  throw createBrowserCoreError("timeout", `ABP did not become ready within 30000ms at ${baseUrl}`);
}

async function waitForDevToolsPort(userDataDir: string): Promise<number> {
  const path = join(userDataDir, "DevToolsActivePort");
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    try {
      const content = await fs.readFile(path, "utf8");
      const [line] = content.split(/\r?\n/, 1);
      const port = Number(line);
      if (Number.isInteger(port) && port > 0) {
        return port;
      }
    } catch {}

    await delay(200);
  }

  throw createBrowserCoreError(
    "timeout",
    `CDP port file was not written to ${userDataDir} within 30000ms`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
