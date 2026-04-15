import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  collectOpensteerStatus,
  renderOpensteerStatus,
} from "../../packages/opensteer/src/cli/status.js";
import { OpensteerCloudClient } from "../../packages/opensteer/src/cloud/client.js";
import { resolveFilesystemWorkspacePath } from "../../packages/opensteer/src/root.js";
import { writePersistedSessionRecord } from "../../packages/opensteer/src/live-session.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("opensteer status", () => {
  test("reports provider resolution and both workspace lanes independently", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-status-"));
    const workspace = "docs";
    const rootPath = resolveFilesystemWorkspacePath({
      rootDir,
      workspace,
    });

    try {
      vi.spyOn(OpensteerCloudClient.prototype, "getSession").mockResolvedValue({
        status: "active",
      } satisfies Awaited<ReturnType<OpensteerCloudClient["getSession"]>>);

      await writePersistedSessionRecord(rootPath, {
        layout: "opensteer-session",
        version: 1,
        provider: "local",
        workspace,
        engine: "playwright",
        executablePath: "/Applications/Chromium.app/Contents/MacOS/Chromium",
        pid: process.pid,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        userDataDir: "/tmp/local-profile",
      });
      await writePersistedSessionRecord(rootPath, {
        layout: "opensteer-session",
        version: 1,
        provider: "cloud",
        workspace,
        sessionId: "session_123",
        startedAt: Date.now(),
        updatedAt: Date.now(),
      });

      const status = await collectOpensteerStatus({
        rootDir,
        workspace,
        provider: {
          mode: "cloud",
          source: "env",
        },
        cloudConfig: {
          apiKey: "osk_test",
          baseUrl: "https://api.opensteer.dev",
        },
      });

      expect(status).toMatchObject({
        provider: {
          current: "cloud",
          source: "env",
        },
        workspace,
        rootPath,
        lanes: {
          local: {
            provider: "local",
            status: "active",
            current: false,
            pid: process.pid,
            engine: "playwright",
            browser: "Chromium",
          },
          cloud: {
            provider: "cloud",
            status: "connected",
            current: true,
            sessionId: "session_123",
            baseUrl: "https://api.opensteer.dev",
          },
        },
      });

      const rendered = renderOpensteerStatus(status);
      expect(rendered).toContain("Provider resolution");
      expect(rendered).toContain("current: cloud");
      expect(rendered).toMatch(/session_123\s+https:\/\/api\.opensteer\.dev/u);
      expect(rendered).toMatch(/\* cloud\s+connected/u);
      expect(rendered).toMatch(/\s local\s+active/u);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("reports attached local browsers without requiring a PID", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-status-attached-"));
    const workspace = "attached-status";
    const rootPath = resolveFilesystemWorkspacePath({
      rootDir,
      workspace,
    });
    const endpointServer = await startAttachedEndpointServer();
    const endpoint = `ws://127.0.0.1:${String(endpointServer.port)}/devtools/browser/attached-status`;

    try {
      await writePersistedSessionRecord(rootPath, {
        layout: "opensteer-session",
        version: 1,
        provider: "local",
        workspace,
        ownership: "attached",
        engine: "playwright",
        endpoint,
        pid: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        userDataDir: "/tmp/attached-profile",
      });

      const status = await collectOpensteerStatus({
        rootDir,
        workspace,
        provider: {
          mode: "local",
          source: "default",
        },
      });

      expect(status.lanes?.local).toMatchObject({
        provider: "local",
        status: "active",
        current: true,
        summary: "attached browser",
        engine: "playwright",
      });
      expect(status.lanes?.local.pid).toBeUndefined();

      const rendered = renderOpensteerStatus(status);
      expect(rendered).toMatch(/\* local\s+active/u);
      expect(rendered).toContain("attached browser");
    } finally {
      await endpointServer.close();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

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
          )}/devtools/browser/attached-status`,
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
