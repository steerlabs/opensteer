import { createBrowserCoreError } from "@opensteer/browser-core";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

import type { LaunchRequestOptions } from "./options.js";
import type { AbpBrowserStatus } from "./types.js";

export interface LaunchedAbpProcess {
  readonly process: ChildProcess;
  readonly baseUrl: string;
  readonly remoteDebuggingUrl: string;
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

export async function launchAbpProcess(options: LaunchRequestOptions): Promise<LaunchedAbpProcess> {
  await Promise.all([
    fs.mkdir(options.userDataDir, { recursive: true }),
    fs.mkdir(options.sessionDir, { recursive: true }),
  ]);

  const executablePath = options.executablePath ?? "agent-browser-protocol";
  const args = [
    "--port",
    String(options.port),
    ...(options.headless ? ["--headless"] : []),
    "--user-data-dir",
    options.userDataDir,
    "--session-dir",
    options.sessionDir,
    ...(options.args.length === 0 ? [] : ["--", ...options.args]),
  ];

  const child = spawn(executablePath, args, {
    stdio: options.verbose ? ["ignore", "pipe", "pipe"] : "ignore",
  });

  const spawnError = new Promise<never>((_, reject) => {
    child.once("error", (error) => {
      reject(
        createBrowserCoreError(
          "operation-failed",
          `failed to launch ABP executable ${executablePath}: ${error.message}`,
          {
            cause: error,
          },
        ),
      );
    });
  });

  if (options.verbose && child.stdout) {
    child.stdout.pipe(process.stderr);
  }
  if (options.verbose && child.stderr) {
    child.stderr.pipe(process.stderr);
  }

  const baseUrl = `http://127.0.0.1:${String(options.port)}/api/v1`;
  await Promise.race([waitForReady(baseUrl), spawnError]);
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
