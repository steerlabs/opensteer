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
      expect(rendered).toMatch(/\* cloud\s+connected/u);
      expect(rendered).toMatch(/\s local\s+active/u);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
