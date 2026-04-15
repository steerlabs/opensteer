import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { parseCommandLine } from "../../packages/opensteer/src/cli/parse.js";
import { handleViewCommand } from "../../packages/opensteer/src/cli/view.js";
import { writePersistedSessionRecord } from "../../packages/opensteer/src/live-session.js";
import { bestEffortRegisterLocalViewSession } from "../../packages/opensteer/src/local-view/registration.js";
import {
  resolveLocalViewMode,
  setLocalViewMode,
} from "../../packages/opensteer/src/local-view/preferences.js";
import { stopLocalViewService } from "../../packages/opensteer/src/local-view/service.js";
import { readLocalViewServiceState } from "../../packages/opensteer/src/local-view/service-state.js";
import { resolveFilesystemWorkspacePath } from "../../packages/opensteer/src/root.js";

describe("view command", () => {
  test("updates the local-view preference without starting the service", async () => {
    const previousOpensteerHome = process.env.OPENSTEER_HOME;
    const stateHome = await mkdtemp(path.join(tmpdir(), "opensteer-view-command-pref-"));
    process.env.OPENSTEER_HOME = stateHome;

    try {
      const manualOutput = await captureStdout(async () => {
        await handleViewCommand(parseCommandLine(["view", "--no-auto"]));
      });
      expect(manualOutput).toContain("manual");
      expect(await resolveLocalViewMode()).toBe("manual");
      expect(await readLocalViewServiceState()).toBeUndefined();

      const autoOutput = await captureStdout(async () => {
        await handleViewCommand(parseCommandLine(["view", "--auto"]));
      });
      expect(autoOutput).toContain("auto");
      expect(await resolveLocalViewMode()).toBe("auto");
      expect(await readLocalViewServiceState()).toBeUndefined();
    } finally {
      await stopLocalViewService().catch(() => undefined);
      await rm(stateHome, { recursive: true, force: true }).catch(() => undefined);
      if (previousOpensteerHome === undefined) {
        delete process.env.OPENSTEER_HOME;
      } else {
        process.env.OPENSTEER_HOME = previousOpensteerHome;
      }
    }
  });

  test("starts and stops the service without changing a manual preference", async () => {
    const previousOpensteerHome = process.env.OPENSTEER_HOME;
    const stateHome = await mkdtemp(path.join(tmpdir(), "opensteer-view-command-stop-"));
    process.env.OPENSTEER_HOME = stateHome;

    try {
      await setLocalViewMode("manual");

      const started = JSON.parse(
        await captureStdout(async () => {
          await handleViewCommand(parseCommandLine(["view", "--json"]));
        }),
      ) as { readonly url: string };

      expect(started.url).toContain("127.0.0.1");
      expect(await resolveLocalViewMode()).toBe("manual");

      const runningState = await waitFor(async () => {
        const current = await readLocalViewServiceState();
        if (!current) {
          return null;
        }
        const health = await fetch(new URL("/api/health", current.url), {
          headers: {
            "x-opensteer-local-token": current.token,
          },
        }).catch(() => null);
        return health?.ok === true ? current : null;
      });
      expect(runningState.url).toBe(started.url);

      const stopped = JSON.parse(
        await captureStdout(async () => {
          await handleViewCommand(parseCommandLine(["view", "stop", "--json"]));
        }),
      ) as { readonly stopped: boolean };
      expect(stopped).toEqual({ stopped: true });
      expect(await resolveLocalViewMode()).toBe("manual");
      await waitFor(async () => ((await readLocalViewServiceState()) === undefined ? true : null));
    } finally {
      await stopLocalViewService().catch(() => undefined);
      await rm(stateHome, { recursive: true, force: true }).catch(() => undefined);
      if (previousOpensteerHome === undefined) {
        delete process.env.OPENSTEER_HOME;
      } else {
        process.env.OPENSTEER_HOME = previousOpensteerHome;
      }
    }
  });

  test("opens the local view URL in a browser for non-json output", async () => {
    const previousOpensteerHome = process.env.OPENSTEER_HOME;
    const stateHome = await mkdtemp(path.join(tmpdir(), "opensteer-view-command-open-"));
    process.env.OPENSTEER_HOME = stateHome;

    try {
      let openedUrl: string | undefined;
      const output = await captureStdout(async () => {
        await handleViewCommand(parseCommandLine(["view"]), {
          openUrl: async (url) => {
            openedUrl = url;
          },
        });
      });

      expect(openedUrl).toBeDefined();
      expect(openedUrl).toContain("127.0.0.1");
      expect(output).toBe(`${openedUrl}\n`);
    } finally {
      await stopLocalViewService().catch(() => undefined);
      await rm(stateHome, { recursive: true, force: true }).catch(() => undefined);
      if (previousOpensteerHome === undefined) {
        delete process.env.OPENSTEER_HOME;
      } else {
        process.env.OPENSTEER_HOME = previousOpensteerHome;
      }
    }
  });

  test("does not auto-open the local view for json output", async () => {
    const previousOpensteerHome = process.env.OPENSTEER_HOME;
    const stateHome = await mkdtemp(path.join(tmpdir(), "opensteer-view-command-json-"));
    process.env.OPENSTEER_HOME = stateHome;

    try {
      let opened = false;
      const output = JSON.parse(
        await captureStdout(async () => {
          await handleViewCommand(parseCommandLine(["view", "--json"]), {
            openUrl: async () => {
              opened = true;
            },
          });
        }),
      ) as { readonly url: string };

      expect(output.url).toContain("127.0.0.1");
      expect(opened).toBe(false);
    } finally {
      await stopLocalViewService().catch(() => undefined);
      await rm(stateHome, { recursive: true, force: true }).catch(() => undefined);
      if (previousOpensteerHome === undefined) {
        delete process.env.OPENSTEER_HOME;
      } else {
        process.env.OPENSTEER_HOME = previousOpensteerHome;
      }
    }
  });

  test("continues when automatically opening the local view fails", async () => {
    const previousOpensteerHome = process.env.OPENSTEER_HOME;
    const stateHome = await mkdtemp(path.join(tmpdir(), "opensteer-view-command-open-fail-"));
    process.env.OPENSTEER_HOME = stateHome;

    try {
      const stderr = await captureStderr(async () => {
        const stdout = await captureStdout(async () => {
          await handleViewCommand(parseCommandLine(["view"]), {
            openUrl: async () => {
              throw new Error("open failed");
            },
          });
        });
        expect(stdout).toContain("127.0.0.1");
      });

      expect(stderr).toContain("Could not automatically open the local view.");
    } finally {
      await stopLocalViewService().catch(() => undefined);
      await rm(stateHome, { recursive: true, force: true }).catch(() => undefined);
      if (previousOpensteerHome === undefined) {
        delete process.env.OPENSTEER_HOME;
      } else {
        process.env.OPENSTEER_HOME = previousOpensteerHome;
      }
    }
  });

  test("reports stop=false when the service is already stopped", async () => {
    const previousOpensteerHome = process.env.OPENSTEER_HOME;
    const stateHome = await mkdtemp(path.join(tmpdir(), "opensteer-view-command-idle-"));
    process.env.OPENSTEER_HOME = stateHome;

    try {
      await setLocalViewMode("auto");
      const output = JSON.parse(
        await captureStdout(async () => {
          await handleViewCommand(parseCommandLine(["view", "stop", "--json"]));
        }),
      ) as { readonly stopped: boolean };
      expect(output).toEqual({ stopped: false });
      expect(await resolveLocalViewMode()).toBe("auto");
    } finally {
      await stopLocalViewService().catch(() => undefined);
      await rm(stateHome, { recursive: true, force: true }).catch(() => undefined);
      if (previousOpensteerHome === undefined) {
        delete process.env.OPENSTEER_HOME;
      } else {
        process.env.OPENSTEER_HOME = previousOpensteerHome;
      }
    }
  });

  test("deep-links to attached workspace sessions", async () => {
    const previousOpensteerHome = process.env.OPENSTEER_HOME;
    const previousCwd = process.cwd();
    const stateHome = await mkdtemp(path.join(tmpdir(), "opensteer-view-command-attached-"));
    process.env.OPENSTEER_HOME = stateHome;
    process.chdir(stateHome);
    const workspace = "attached-workspace";
    const rootPath = resolveFilesystemWorkspacePath({
      rootDir: process.cwd(),
      workspace,
    });
    const endpointServer = await startAttachedEndpointServer();
    const endpoint = `ws://127.0.0.1:${String(endpointServer.port)}/devtools/browser/attached-view`;

    try {
      await setLocalViewMode("manual");
      const startedAt = Date.now();
      const liveRecord = {
        layout: "opensteer-session" as const,
        version: 1 as const,
        provider: "local" as const,
        workspace,
        ownership: "attached" as const,
        engine: "playwright" as const,
        endpoint,
        pid: 0,
        startedAt,
        updatedAt: startedAt,
        userDataDir: path.join(rootPath, "browser", "user-data"),
      };
      await writePersistedSessionRecord(rootPath, liveRecord);
      await bestEffortRegisterLocalViewSession({
        rootPath,
        workspace,
        live: liveRecord,
        ownership: "attached",
      });

      const output = JSON.parse(
        await captureStdout(async () => {
          await handleViewCommand(parseCommandLine(["view", "--workspace", workspace, "--json"]));
        }),
      ) as { readonly url: string; readonly sessionId?: string };

      expect(output.sessionId).toMatch(/^local_/u);
      expect(output.url).toContain("127.0.0.1");
      expect(output.url).toContain(`#session=${encodeURIComponent(output.sessionId!)}`);
    } finally {
      await endpointServer.close();
      await stopLocalViewService().catch(() => undefined);
      await rm(stateHome, { recursive: true, force: true }).catch(() => undefined);
      if (previousOpensteerHome === undefined) {
        delete process.env.OPENSTEER_HOME;
      } else {
        process.env.OPENSTEER_HOME = previousOpensteerHome;
      }
      process.chdir(previousCwd);
    }
  });
});

async function captureStdout(task: () => Promise<void>): Promise<string> {
  return captureWrite(process.stdout, task);
}

async function captureStderr(task: () => Promise<void>): Promise<string> {
  return captureWrite(process.stderr, task);
}

async function captureWrite(
  stream: Pick<NodeJS.WriteStream, "write">,
  task: () => Promise<void>,
): Promise<string> {
  let output = "";
  const originalWrite = stream.write.bind(stream);
  stream.write = ((chunk) => {
    output += String(chunk);
    return true;
  }) as typeof stream.write;

  try {
    await task();
    return output;
  } finally {
    stream.write = originalWrite;
  }
}

async function waitFor<T>(task: () => Promise<T | null>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await task();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for condition.");
}

async function startAttachedEndpointServer(): Promise<{
  readonly port: number;
  readonly close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    if (request.url === "/json/version") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          Browser: "Chromium",
          "Protocol-Version": "1.3",
          webSocketDebuggerUrl: `ws://127.0.0.1:${String(
            (server.address() as { port: number }).port,
          )}/devtools/browser/attached-view`,
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  return {
    port: (server.address() as { port: number }).port,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}
