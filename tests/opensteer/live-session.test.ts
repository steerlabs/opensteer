import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  readPersistedCloudSessionRecord,
  resolveCloudSessionRecordPath,
} from "../../packages/opensteer/src/cloud/session-proxy.js";
import {
  clearPersistedSessionRecord,
  readPersistedLocalBrowserSessionRecord,
  resolveLocalSessionRecordPath,
  resolveLiveSessionRecordPath,
  writePersistedSessionRecord,
} from "../../packages/opensteer/src/live-session.js";

describe("live session records", () => {
  test("stores cloud live sessions in the cloud lane", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "opensteer-live-session-cloud-"));
    await mkdir(path.join(rootPath, "live"), { recursive: true });
    await writePersistedSessionRecord(rootPath, {
      layout: "opensteer-session",
      version: 1,
      provider: "cloud",
      workspace: "docs",
      sessionId: "session_123",
      baseUrl: "https://cloud.example/runtime/session_123",
      startedAt: 100,
      updatedAt: 200,
    });

    await expect(readPersistedCloudSessionRecord(rootPath)).resolves.toMatchObject({
      provider: "cloud",
      workspace: "docs",
      sessionId: "session_123",
      baseUrl: "https://cloud.example/runtime/session_123",
      startedAt: 100,
      updatedAt: 200,
    });
    expect(resolveCloudSessionRecordPath(rootPath)).toBe(
      resolveLiveSessionRecordPath(rootPath, "cloud"),
    );
  });

  test("stores local live sessions in the local lane", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "opensteer-live-session-local-"));
    await mkdir(path.join(rootPath, "live"), { recursive: true });
    await writePersistedSessionRecord(rootPath, {
      layout: "opensteer-session",
      version: 1,
      provider: "local",
      workspace: "docs",
      engine: "playwright",
      endpoint: "ws://127.0.0.1:9222/devtools/browser/root",
      pid: 4321,
      startedAt: 123,
      updatedAt: 124,
      userDataDir: "/tmp/profile",
    });

    await expect(readPersistedLocalBrowserSessionRecord(rootPath)).resolves.toMatchObject({
      provider: "local",
      engine: "playwright",
      endpoint: "ws://127.0.0.1:9222/devtools/browser/root",
      pid: 4321,
      startedAt: 123,
      userDataDir: "/tmp/profile",
    });
    expect(resolveLocalSessionRecordPath(rootPath)).toBe(
      resolveLiveSessionRecordPath(rootPath, "local"),
    );
  });

  test("writes provider-scoped live session files without clobbering the other lane", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "opensteer-live-session-write-"));
    await mkdir(path.join(rootPath, "live"), { recursive: true });
    await writePersistedSessionRecord(rootPath, {
      layout: "opensteer-session",
      version: 1,
      provider: "local",
      engine: "playwright",
      endpoint: "ws://127.0.0.1:9222/devtools/browser/root",
      pid: 111,
      startedAt: 1,
      updatedAt: 2,
      userDataDir: "/tmp/profile",
    });

    await writePersistedSessionRecord(rootPath, {
      layout: "opensteer-session",
      version: 1,
      provider: "cloud",
      sessionId: "session_456",
      baseUrl: "https://cloud.example/runtime/session_456",
      startedAt: 1,
      updatedAt: 2,
    });

    await expect(readPersistedCloudSessionRecord(rootPath)).resolves.toMatchObject({
      sessionId: "session_456",
      baseUrl: "https://cloud.example/runtime/session_456",
    });
    await expect(readFile(resolveCloudSessionRecordPath(rootPath), "utf8")).resolves.toContain(
      "\"provider\": \"cloud\"",
    );
    await expect(readFile(resolveLocalSessionRecordPath(rootPath), "utf8")).resolves.toContain(
      "\"provider\": \"local\"",
    );
  });

  test("clears only the requested provider lane", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "opensteer-live-session-clear-"));
    await mkdir(path.join(rootPath, "live"), { recursive: true });
    await writePersistedSessionRecord(rootPath, {
      layout: "opensteer-session",
      version: 1,
      provider: "local",
      engine: "playwright",
      pid: 1,
      startedAt: 1,
      updatedAt: 1,
      userDataDir: "/tmp/profile",
    });
    await writePersistedSessionRecord(rootPath, {
      layout: "opensteer-session",
      version: 1,
      provider: "cloud",
      sessionId: "session_789",
      baseUrl: "https://cloud.example/runtime/session_789",
      startedAt: 1,
      updatedAt: 1,
    });

    await clearPersistedSessionRecord(rootPath, "local");

    await expect(readPersistedLocalBrowserSessionRecord(rootPath)).resolves.toBeUndefined();
    await expect(readPersistedCloudSessionRecord(rootPath)).resolves.toMatchObject({
      sessionId: "session_789",
    });
  });
});
