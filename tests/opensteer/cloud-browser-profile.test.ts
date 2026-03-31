import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createSuccessEnvelope, type OpensteerRequestEnvelope } from "@opensteer/protocol";
import { OpensteerCloudClient } from "../../packages/opensteer/src/cloud/client.js";
const syncLocalRegistryToCloudMock = vi.fn();
vi.mock("../../packages/opensteer/src/cloud/registry-sync.js", () => ({
  syncLocalRegistryToCloud: (...args: unknown[]) => syncLocalRegistryToCloudMock(...args),
}));
import {
  CloudSessionProxy,
  readPersistedCloudSessionRecord,
} from "../../packages/opensteer/src/cloud/session-proxy.js";
import { resolveOpensteerRuntimeConfig } from "../../packages/opensteer/src/sdk/runtime-resolution.js";

const capturePortableBrowserProfileSnapshotMock = vi.fn();
const encodePortableBrowserProfileSnapshotMock = vi.fn();
const resolveCookieCaptureStrategyMock = vi.fn();
const acquireCdpEndpointMock = vi.fn();
const relaunchBrowserNormallyMock = vi.fn();

vi.mock("../../packages/opensteer/src/cloud/portable-cookie-snapshot.js", () => ({
  capturePortableBrowserProfileSnapshot: (...args: unknown[]) =>
    capturePortableBrowserProfileSnapshotMock(...args),
  encodePortableBrowserProfileSnapshot: (...args: unknown[]) =>
    encodePortableBrowserProfileSnapshotMock(...args),
}));

vi.mock("../../packages/opensteer/src/local-browser/cookie-capture.js", () => ({
  resolveCookieCaptureStrategy: (...args: unknown[]) => resolveCookieCaptureStrategyMock(...args),
  acquireCdpEndpoint: (...args: unknown[]) => acquireCdpEndpointMock(...args),
  relaunchBrowserNormally: (...args: unknown[]) => relaunchBrowserNormallyMock(...args),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("cloud browser-profile integration", () => {
  test("resolves cloud runtime config with a default browser profile preference", () => {
    vi.stubEnv("OPENSTEER_PROVIDER", "cloud");
    vi.stubEnv("OPENSTEER_API_KEY", "osk_test");
    vi.stubEnv("OPENSTEER_BASE_URL", "https://api.opensteer.dev");

    expect(
      resolveOpensteerRuntimeConfig({
        provider: {
          mode: "cloud",
          browserProfile: {
            profileId: "bp_123",
            reuseIfActive: true,
          },
        },
      }),
    ).toEqual({
      provider: {
        mode: "cloud",
        source: "explicit",
      },
      cloud: {
        apiKey: "osk_test",
        baseUrl: "https://api.opensteer.dev",
        browserProfile: {
          profileId: "bp_123",
          reuseIfActive: true,
        },
      },
    });
  });

  test("OpensteerCloudClient sends browserProfile with session creation", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        sessionId: "session_123",
        baseUrl: "https://cloud.example/runtime/session_123",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpensteerCloudClient({
      apiKey: "osk_test",
      baseUrl: "https://api.opensteer.dev",
      browserProfile: {
        profileId: "bp_default",
      },
    });

    await client.createSession({
      name: "work",
      browserProfile: {
        profileId: "bp_123",
        reuseIfActive: true,
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.opensteer.dev/v1/sessions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "work",
          browserProfile: {
            profileId: "bp_123",
            reuseIfActive: true,
          },
        }),
      }),
    );
  });

  test("OpensteerCloudClient imports registry batches through public endpoints", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        imported: 1,
        inserted: 1,
        updated: 0,
        skipped: 0,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpensteerCloudClient({
      apiKey: "osk_test",
      baseUrl: "https://api.opensteer.dev",
    });

    await client.importSelectorCache([
      {
        workspace: "work",
        method: "dom.click",
        descriptionHash: "a".repeat(64),
        description: "Submit",
        path: { resolution: "deterministic", context: [], nodes: [{ tag: "button" }] },
        createdAt: 10,
        updatedAt: 20,
      },
    ]);
    await client.importRequestPlans([
      {
        workspace: "work",
        recordId: "request-plan:1",
        key: "request.login",
        version: "1.0.0",
        contentHash: "b".repeat(64),
        tags: ["auth"],
        payload: {
          transport: {
            kind: "session-http",
            requiresBrowser: true,
          },
          endpoint: {
            method: "GET",
            urlTemplate: "https://example.com/login",
          },
        },
        freshness: {
          lastValidatedAt: 30,
        },
        createdAt: 10,
        updatedAt: 20,
      },
    ]);
    await client.importRecipes([
      {
        workspace: "work",
        recordId: "recipe:1",
        key: "recipe.login",
        version: "1.0.0",
        contentHash: "c".repeat(64),
        tags: ["auth"],
        payload: {
          steps: [],
        },
        createdAt: 10,
        updatedAt: 20,
      },
    ]);
    await client.importAuthRecipes([
      {
        workspace: "work",
        recordId: "auth-recipe:1",
        key: "auth.refresh",
        version: "1.0.0",
        contentHash: "d".repeat(64),
        tags: ["auth"],
        payload: {
          steps: [],
        },
        createdAt: 10,
        updatedAt: 20,
      },
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.opensteer.dev/selector-cache/import",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          entries: [
            {
              workspace: "work",
              method: "dom.click",
              descriptionHash: "a".repeat(64),
              description: "Submit",
              path: {
                resolution: "deterministic",
                context: [],
                nodes: [{ tag: "button" }],
              },
              createdAt: 10,
              updatedAt: 20,
            },
          ],
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.opensteer.dev/registry/request-plans/import",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://api.opensteer.dev/registry/recipes/import",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://api.opensteer.dev/registry/auth-recipes/import",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  test("OpensteerCloudClient syncs cookies into a cloud browser profile", async () => {
    resolveCookieCaptureStrategyMock.mockResolvedValueOnce({
      strategy: "attach",
      attachEndpoint: "9222",
      timeoutMs: 30_000,
    });
    acquireCdpEndpointMock.mockResolvedValueOnce({
      strategy: "attach",
      cdpEndpoint: "ws://127.0.0.1:9222/devtools/browser/root",
      cleanup: vi.fn(async () => undefined),
    });
    capturePortableBrowserProfileSnapshotMock.mockResolvedValueOnce({
      version: "portable-cookies-v1",
      source: {
        browserFamily: "chromium",
        browserName: "Chromium",
        browserMajor: "136",
        platform: "macos",
        capturedAt: 123,
      },
      cookies: [
        {
          name: "session",
          value: "abc",
          domain: ".example.com",
          path: "/",
          secure: true,
          httpOnly: true,
          session: true,
          expiresAt: null,
        },
      ],
    });
    encodePortableBrowserProfileSnapshotMock.mockResolvedValueOnce(Buffer.from("compressed-state"));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          importId: "bpi_456",
          profileId: "bp_456",
          status: "awaiting_upload",
          uploadUrl: "https://storage.example/upload",
          uploadMethod: "PUT",
          uploadFormat: "portable-cookies-v1+json.gz",
          maxUploadBytes: 1024 * 1024,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          importId: "bpi_456",
          profileId: "bp_456",
          status: "ready",
          uploadFormat: "portable-cookies-v1+json.gz",
          storageId: "storage_456",
          revision: 7,
          createdAt: 1,
          updatedAt: 2,
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpensteerCloudClient({
      apiKey: "osk_test",
      baseUrl: "https://api.opensteer.dev",
    });

    const result = await client.syncBrowserProfileCookies({
      attachEndpoint: "9222",
      domains: ["example.com"],
      profileId: "bp_456",
    });

    expect(result).toMatchObject({
      importId: "bpi_456",
      status: "ready",
      revision: 7,
    });
    expect(resolveCookieCaptureStrategyMock).toHaveBeenCalledWith({
      attachEndpoint: "9222",
    });
    expect(capturePortableBrowserProfileSnapshotMock).toHaveBeenCalledWith({
      attachEndpoint: "ws://127.0.0.1:9222/devtools/browser/root",
      captureMethod: "attach",
      domains: ["example.com"],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.opensteer.dev/v1/browser-profiles/imports",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          profileId: "bp_456",
        }),
      }),
    );
  });

  test("CloudSessionProxy reuses persisted workspace cloud sessions", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-cloud-session-"));
    const workspace = "cloud-workspace";
    const workspaceRoot = path.join(rootDir, ".opensteer", "workspaces", workspace);
    const semanticBaseUrl = "https://cloud.example/runtime/session_123";
    let createSessionCalls = 0;
    let getSessionCalls = 0;
    let closeSessionCalls = 0;
    let semanticOpenCalls = 0;
    const events: string[] = [];

    syncLocalRegistryToCloudMock.mockImplementation(async () => {
      events.push("sync");
    });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.opensteer.dev/v1/sessions" && init?.method === "POST") {
        createSessionCalls += 1;
        events.push("create-session");
        return {
          ok: true,
          json: async () => ({
            sessionId: "session_123",
            baseUrl: semanticBaseUrl,
            status: "active",
          }),
        };
      }

      if (url === "https://api.opensteer.dev/v1/sessions/session_123" && init?.method === "GET") {
        getSessionCalls += 1;
        events.push("get-session");
        return {
          ok: true,
          json: async () => ({
            status: "active",
          }),
        };
      }

      if (
        url === "https://api.opensteer.dev/v1/sessions/session_123" &&
        init?.method === "DELETE"
      ) {
        closeSessionCalls += 1;
        return {
          ok: true,
          json: async () => ({
            status: "closed",
          }),
        };
      }

      if (
        url === `${semanticBaseUrl}/api/v2/semantic/operations/session/open` &&
        init?.method === "POST"
      ) {
        semanticOpenCalls += 1;
        events.push("semantic-open");
        const request = JSON.parse(String(init.body)) as OpensteerRequestEnvelope<unknown>;
        return {
          ok: true,
          json: async () =>
            createSuccessEnvelope(request, {
              sessionRef: "session:cloud",
              pageRef: "page:cloud",
              url: "https://example.com",
              title: "Cloud Workspace",
            }),
        };
      }

      throw new Error(`Unexpected fetch ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const client = new OpensteerCloudClient({
        apiKey: "osk_test",
        baseUrl: "https://api.opensteer.dev",
      });

      const first = new CloudSessionProxy(client, {
        rootDir,
        workspace,
      });
      const openedFirst = await first.open({
        url: "https://example.com",
        browser: "persistent",
        launch: {
          headless: true,
        },
      });

      expect(openedFirst).toMatchObject({
        url: "https://example.com",
        title: "Cloud Workspace",
      });
      expect(events.slice(0, 3)).toEqual(["sync", "create-session", "semantic-open"]);
      expect(createSessionCalls).toBe(1);
      expect(semanticOpenCalls).toBe(1);

      await first.disconnect();

      expect(await readPersistedCloudSessionRecord(workspaceRoot)).toMatchObject({
        provider: "cloud",
        sessionId: "session_123",
        baseUrl: semanticBaseUrl,
      });

      const second = new CloudSessionProxy(client, {
        rootDir,
        workspace,
      });
      await second.open({
        url: "https://example.com",
      });

      expect(events.slice(3)).toEqual(["get-session", "sync", "semantic-open"]);
      expect(createSessionCalls).toBe(1);
      expect(getSessionCalls).toBe(1);
      expect(semanticOpenCalls).toBe(2);

      await second.close();

      expect(closeSessionCalls).toBe(1);
      expect(await readPersistedCloudSessionRecord(workspaceRoot)).toBeUndefined();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("CloudSessionProxy continues creating a new session when sync fails", async () => {
    syncLocalRegistryToCloudMock.mockRejectedValueOnce(new Error("sync failed"));
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-cloud-session-"));

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.opensteer.dev/v1/sessions" && init?.method === "POST") {
        return {
          ok: true,
          json: async () => ({
            sessionId: "session_123",
            baseUrl: "https://cloud.example/runtime/session_123",
            status: "active",
          }),
        };
      }

      if (
        url ===
          "https://cloud.example/runtime/session_123/api/v2/semantic/operations/session/open" &&
        init?.method === "POST"
      ) {
        const request = JSON.parse(String(init.body)) as OpensteerRequestEnvelope<unknown>;
        return {
          ok: true,
          json: async () =>
            createSuccessEnvelope(request, {
              sessionRef: "session:cloud",
              pageRef: "page:cloud",
              url: "https://example.com",
              title: "Cloud Workspace",
            }),
        };
      }

      throw new Error(`Unexpected fetch ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const proxy = new CloudSessionProxy(
        new OpensteerCloudClient({
          apiKey: "osk_test",
          baseUrl: "https://api.opensteer.dev",
        }),
        {
          rootDir,
          workspace: "cloud-workspace",
        },
      );

      await expect(
        proxy.open({
          url: "https://example.com",
        }),
      ).resolves.toMatchObject({
        url: "https://example.com",
        title: "Cloud Workspace",
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("CloudSessionProxy continues reusing a persisted session when sync fails", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-cloud-session-"));
    const workspace = "cloud-workspace";

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.opensteer.dev/v1/sessions" && init?.method === "POST") {
        return {
          ok: true,
          json: async () => ({
            sessionId: "session_123",
            baseUrl: "https://cloud.example/runtime/session_123",
            status: "active",
          }),
        };
      }

      if (url === "https://api.opensteer.dev/v1/sessions/session_123" && init?.method === "GET") {
        return {
          ok: true,
          json: async () => ({
            status: "active",
          }),
        };
      }

      if (
        url ===
          "https://cloud.example/runtime/session_123/api/v2/semantic/operations/session/open" &&
        init?.method === "POST"
      ) {
        const request = JSON.parse(String(init.body)) as OpensteerRequestEnvelope<unknown>;
        return {
          ok: true,
          json: async () =>
            createSuccessEnvelope(request, {
              sessionRef: "session:cloud",
              pageRef: "page:cloud",
              url: "https://example.com",
              title: "Cloud Workspace",
            }),
        };
      }

      throw new Error(`Unexpected fetch ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const client = new OpensteerCloudClient({
        apiKey: "osk_test",
        baseUrl: "https://api.opensteer.dev",
      });

      syncLocalRegistryToCloudMock.mockResolvedValueOnce(undefined);
      const first = new CloudSessionProxy(client, {
        rootDir,
        workspace,
      });
      await first.open({
        url: "https://example.com",
      });
      await first.disconnect();

      syncLocalRegistryToCloudMock.mockRejectedValueOnce(new Error("sync failed"));
      const second = new CloudSessionProxy(client, {
        rootDir,
        workspace,
      });
      await expect(
        second.open({
          url: "https://example.com",
        }),
      ).resolves.toMatchObject({
        url: "https://example.com",
        title: "Cloud Workspace",
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("CloudSessionProxy rejects attach browser mode before creating a session", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const proxy = new CloudSessionProxy(
      new OpensteerCloudClient({
        apiKey: "osk_test",
        baseUrl: "https://api.opensteer.dev",
      }),
    );

    await expect(
      proxy.open({
        browser: {
          mode: "attach",
          endpoint: "ws://127.0.0.1:9222/devtools/browser/root",
        },
      }),
    ).rejects.toThrow('Cloud mode does not support browser.mode="attach".');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
