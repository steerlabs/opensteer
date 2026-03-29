import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  readPersistedCloudSessionRecord,
  resolveCloudSessionRecordPath,
} from "../../packages/opensteer/src/cloud/session-proxy.js";
import {
  readPersistedLocalBrowserSessionRecord,
  resolveLiveSessionRecordPath,
  writePersistedSessionRecord,
} from "../../packages/opensteer/src/live-session.js";

describe("live session records", () => {
  test("reads legacy cloud-session.json records through the unified session path", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "opensteer-live-session-cloud-"));
    const legacyPath = path.join(rootPath, "live", "cloud-session.json");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(
      legacyPath,
      JSON.stringify({
        layout: "opensteer-cloud-session",
        version: 1,
        mode: "cloud",
        workspace: "docs",
        sessionId: "session_123",
        baseUrl: "https://cloud.example/runtime/session_123",
        startedAt: 100,
        updatedAt: 200,
      }),
      "utf8",
    );

    await expect(readPersistedCloudSessionRecord(rootPath)).resolves.toMatchObject({
      provider: "cloud",
      mode: "cloud",
      workspace: "docs",
      sessionId: "session_123",
      baseUrl: "https://cloud.example/runtime/session_123",
      startedAt: 100,
      updatedAt: 200,
    });
    expect(resolveCloudSessionRecordPath(rootPath)).toBe(resolveLiveSessionRecordPath(rootPath));
  });

  test("reads legacy browser.json records through the unified session path", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "opensteer-live-session-local-"));
    const legacyPath = path.join(rootPath, "live", "browser.json");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(
      legacyPath,
      JSON.stringify({
        mode: "persistent",
        engine: "playwright",
        endpoint: "ws://127.0.0.1:9222/devtools/browser/root",
        pid: 4321,
        startedAt: 123,
        userDataDir: "/tmp/profile",
      }),
      "utf8",
    );

    await expect(readPersistedLocalBrowserSessionRecord(rootPath)).resolves.toMatchObject({
      provider: "local",
      mode: "browser",
      engine: "playwright",
      endpoint: "ws://127.0.0.1:9222/devtools/browser/root",
      pid: 4321,
      startedAt: 123,
      userDataDir: "/tmp/profile",
    });
  });

  test("writes live/session.json and removes legacy session files", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "opensteer-live-session-write-"));
    const legacyCloudPath = path.join(rootPath, "live", "cloud-session.json");
    const legacyBrowserPath = path.join(rootPath, "live", "browser.json");
    await mkdir(path.join(rootPath, "live"), { recursive: true });
    await writeFile(legacyCloudPath, "{}", "utf8");
    await writeFile(legacyBrowserPath, "{}", "utf8");

    await writePersistedSessionRecord(rootPath, {
      layout: "opensteer-session",
      version: 1,
      provider: "cloud",
      mode: "cloud",
      sessionId: "session_456",
      baseUrl: "https://cloud.example/runtime/session_456",
      startedAt: 1,
      updatedAt: 2,
    });

    await expect(readPersistedCloudSessionRecord(rootPath)).resolves.toMatchObject({
      sessionId: "session_456",
      baseUrl: "https://cloud.example/runtime/session_456",
    });
    await expect(readFile(resolveLiveSessionRecordPath(rootPath), "utf8")).resolves.toContain(
      "\"provider\": \"cloud\"",
    );
    await expect(readFile(legacyCloudPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(legacyBrowserPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
