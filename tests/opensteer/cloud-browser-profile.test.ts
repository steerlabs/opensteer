import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createErrorEnvelope,
  createOpensteerError,
  createSuccessEnvelope,
  type OpensteerRequestEnvelope,
} from "@opensteer/protocol";
import { defaultPolicy } from "../../packages/opensteer/src/index.js";
import {
  OpensteerCloudClient,
  OpensteerCloudRequestError,
} from "../../packages/opensteer/src/cloud/client.js";
const syncLocalWorkspaceToCloudMock = vi.fn();
vi.mock("../../packages/opensteer/src/cloud/workspace-sync.js", () => ({
  syncLocalWorkspaceToCloud: (...args: unknown[]) => syncLocalWorkspaceToCloudMock(...args),
}));
import {
  CloudSessionProxy,
  readPersistedCloudSessionRecord,
} from "../../packages/opensteer/src/cloud/session-proxy.js";
import { resolveOpensteerRuntimeConfig } from "../../packages/opensteer/src/sdk/runtime-resolution.js";

const readBrowserCookiesMock = vi.fn();

vi.mock("../../packages/opensteer/src/local-browser/cookie-reader.js", () => ({
  readBrowserCookies: (...args: unknown[]) => readBrowserCookiesMock(...args),
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

  test("OpensteerCloudClient imports descriptor batches through the public endpoint", async () => {
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

    await client.importDescriptors([
      {
        workspace: "work",
        recordId: "descriptor:1",
        key: "dom.click.submit",
        version: "1.0.0",
        contentHash: "b".repeat(64),
        tags: ["dom"],
        payload: {
          kind: "other",
        },
        createdAt: 10,
        updatedAt: 20,
      },
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.opensteer.dev/registry/descriptors/import",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  test("OpensteerCloudClient imports request-plan batches through the public endpoint", async () => {
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

    await client.importRequestPlans({
      entries: [
        {
          workspace: "work",
          recordId: "request-plan:1",
          key: "bestbuy.search",
          version: "v1",
          contentHash: "c".repeat(64),
          tags: ["reverse"],
          payload: {
            transport: {
              kind: "direct-http",
            },
            endpoint: {
              method: "GET",
              urlTemplate: "https://example.com/data",
            },
          },
          createdAt: 10,
          updatedAt: 10,
        },
      ],
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.opensteer.dev/registry/request-plans/import",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  test("OpensteerCloudClient preserves structured cloud request errors", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({
        error: "Session has expired.",
        code: "CLOUD_SESSION_STALE",
        details: {
          reason: "expired",
        },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpensteerCloudClient({
      apiKey: "osk_test",
      baseUrl: "https://api.opensteer.dev",
    });

    try {
      await client.issueAccess("session_123", ["semantic"]);
      throw new Error("expected issueAccess to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(OpensteerCloudRequestError);
      expect(error).toMatchObject({
        message: "Session has expired.",
        statusCode: 409,
        code: "CLOUD_SESSION_STALE",
        details: {
          reason: "expired",
        },
      });
    }
  });

  test("OpensteerCloudClient syncs cookies into a cloud browser profile", async () => {
    readBrowserCookiesMock.mockResolvedValueOnce({
      cookies: [
        {
          name: "session",
          value: "abc",
          domain: ".example.com",
          path: "/",
          secure: true,
          httpOnly: true,
        },
      ],
      brandId: "chrome",
      brandDisplayName: "Google Chrome",
      userDataDir: "/mock/chrome",
      profileDirectory: "Default",
    });

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
      domains: ["example.com"],
      profileId: "bp_456",
    });

    expect(result).toMatchObject({
      importId: "bpi_456",
      status: "ready",
      revision: 7,
    });
    expect(readBrowserCookiesMock).toHaveBeenCalledWith({});
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
    const semanticGrant = {
      kind: "semantic" as const,
      transport: "http" as const,
      url: semanticBaseUrl,
      token: "semantic-token",
      expiresAt: 4_102_444_800_000,
    };
    let createSessionCalls = 0;
    let accessCalls = 0;
    let getSessionCalls = 0;
    let closeSessionCalls = 0;
    let semanticOpenCalls = 0;
    const events: string[] = [];

    syncLocalWorkspaceToCloudMock.mockImplementation(async () => {
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
            status: "active",
            initialGrants: {
              semantic: semanticGrant,
            },
            initialGrantExpiresAt: semanticGrant.expiresAt,
          }),
        };
      }

      if (
        url === "https://api.opensteer.dev/v1/sessions/session_123/access" &&
        init?.method === "POST"
      ) {
        accessCalls += 1;
        events.push("access");
        return {
          ok: true,
          json: async () => ({
            sessionId: "session_123",
            expiresAt: semanticGrant.expiresAt,
            grants: {
              semantic: semanticGrant,
            },
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
      expect(accessCalls).toBe(0);

      await first.disconnect();

      expect(await readPersistedCloudSessionRecord(workspaceRoot)).toMatchObject({
        provider: "cloud",
        sessionId: "session_123",
      });

      const second = new CloudSessionProxy(client, {
        rootDir,
        workspace,
      });
      await second.open({
        url: "https://example.com",
      });

      expect(events.slice(3)).toEqual(["get-session", "sync", "access", "semantic-open"]);
      expect(createSessionCalls).toBe(1);
      expect(getSessionCalls).toBe(1);
      expect(accessCalls).toBe(1);
      expect(semanticOpenCalls).toBe(2);

      await second.close();

      expect(closeSessionCalls).toBe(1);
      expect(await readPersistedCloudSessionRecord(workspaceRoot)).toBeUndefined();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("CloudSessionProxy does not reuse persisted workspace sessions that are already expired", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-cloud-session-"));
    const workspace = "cloud-workspace";
    const workspaceRoot = path.join(rootDir, ".opensteer", "workspaces", workspace);
    const firstSemanticBaseUrl = "https://cloud.example/runtime/session_123";
    const secondSemanticBaseUrl = "https://cloud.example/runtime/session_456";
    const firstSemanticGrant = {
      kind: "semantic" as const,
      transport: "http" as const,
      url: firstSemanticBaseUrl,
      token: "semantic-token-1",
      expiresAt: 4_102_444_800_000,
    };
    const secondSemanticGrant = {
      kind: "semantic" as const,
      transport: "http" as const,
      url: secondSemanticBaseUrl,
      token: "semantic-token-2",
      expiresAt: 4_102_444_800_000,
    };
    let createSessionCalls = 0;
    let getSessionCalls = 0;
    let staleAccessCalls = 0;
    let closeSessionCalls = 0;
    const events: string[] = [];

    syncLocalWorkspaceToCloudMock.mockResolvedValue(undefined);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.opensteer.dev/v1/sessions" && init?.method === "POST") {
        createSessionCalls += 1;
        events.push(`create-session-${createSessionCalls}`);
        if (createSessionCalls === 1) {
          return {
            ok: true,
            json: async () => ({
              sessionId: "session_123",
              status: "active",
              initialGrants: {
                semantic: firstSemanticGrant,
              },
              initialGrantExpiresAt: firstSemanticGrant.expiresAt,
            }),
          };
        }

        return {
          ok: true,
          json: async () => ({
            sessionId: "session_456",
            status: "active",
            initialGrants: {
              semantic: secondSemanticGrant,
            },
            initialGrantExpiresAt: secondSemanticGrant.expiresAt,
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
            expiresAt: Date.now() - 1,
          }),
        };
      }

      if (
        url === "https://api.opensteer.dev/v1/sessions/session_123/access" &&
        init?.method === "POST"
      ) {
        staleAccessCalls += 1;
        events.push("stale-access");
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: "Session has expired.",
            code: "CLOUD_SESSION_STALE",
          }),
        };
      }

      if (
        url === "https://api.opensteer.dev/v1/sessions/session_456" &&
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
        url === `${firstSemanticBaseUrl}/api/v2/semantic/operations/session/open` &&
        init?.method === "POST"
      ) {
        const request = JSON.parse(String(init.body)) as OpensteerRequestEnvelope<unknown>;
        events.push("semantic-open-1");
        return {
          ok: true,
          json: async () =>
            createSuccessEnvelope(request, {
              sessionRef: "session:cloud-1",
              pageRef: "page:cloud-1",
              url: "https://example.com",
              title: "Cloud Workspace",
            }),
        };
      }

      if (
        url === `${secondSemanticBaseUrl}/api/v2/semantic/operations/session/open` &&
        init?.method === "POST"
      ) {
        const request = JSON.parse(String(init.body)) as OpensteerRequestEnvelope<unknown>;
        events.push("semantic-open-2");
        return {
          ok: true,
          json: async () =>
            createSuccessEnvelope(request, {
              sessionRef: "session:cloud-2",
              pageRef: "page:cloud-2",
              url: "https://example.com",
              title: "Recovered Cloud Workspace",
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
      await first.open({
        url: "https://example.com",
      });
      await first.disconnect();

      expect(await readPersistedCloudSessionRecord(workspaceRoot)).toMatchObject({
        sessionId: "session_123",
      });

      const second = new CloudSessionProxy(client, {
        rootDir,
        workspace,
      });
      const reopened = await second.open({
        url: "https://example.com",
      });

      expect(reopened).toMatchObject({
        title: "Recovered Cloud Workspace",
      });
      expect(events).toEqual([
        "create-session-1",
        "semantic-open-1",
        "get-session",
        "create-session-2",
        "semantic-open-2",
      ]);
      expect(createSessionCalls).toBe(2);
      expect(getSessionCalls).toBe(1);
      expect(staleAccessCalls).toBe(0);
      expect(await readPersistedCloudSessionRecord(workspaceRoot)).toMatchObject({
        sessionId: "session_456",
      });

      await second.close();

      expect(closeSessionCalls).toBe(1);
      expect(await readPersistedCloudSessionRecord(workspaceRoot)).toBeUndefined();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("CloudSessionProxy recreates a persisted workspace session when access is stale", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-cloud-session-"));
    const workspace = "cloud-workspace";
    const workspaceRoot = path.join(rootDir, ".opensteer", "workspaces", workspace);
    const firstSemanticBaseUrl = "https://cloud.example/runtime/session_123";
    const secondSemanticBaseUrl = "https://cloud.example/runtime/session_456";
    const firstSemanticGrant = {
      kind: "semantic" as const,
      transport: "http" as const,
      url: firstSemanticBaseUrl,
      token: "semantic-token-1",
      expiresAt: 4_102_444_800_000,
    };
    const secondSemanticGrant = {
      kind: "semantic" as const,
      transport: "http" as const,
      url: secondSemanticBaseUrl,
      token: "semantic-token-2",
      expiresAt: 4_102_444_800_000,
    };
    let createSessionCalls = 0;
    let getSessionCalls = 0;
    let staleAccessCalls = 0;
    let closeSessionCalls = 0;
    const events: string[] = [];

    syncLocalWorkspaceToCloudMock.mockResolvedValue(undefined);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.opensteer.dev/v1/sessions" && init?.method === "POST") {
        createSessionCalls += 1;
        events.push(`create-session-${createSessionCalls}`);
        if (createSessionCalls === 1) {
          return {
            ok: true,
            json: async () => ({
              sessionId: "session_123",
              status: "active",
              initialGrants: {
                semantic: firstSemanticGrant,
              },
              initialGrantExpiresAt: firstSemanticGrant.expiresAt,
            }),
          };
        }

        return {
          ok: true,
          json: async () => ({
            sessionId: "session_456",
            status: "active",
            initialGrants: {
              semantic: secondSemanticGrant,
            },
            initialGrantExpiresAt: secondSemanticGrant.expiresAt,
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
            expiresAt: Date.now() + 60_000,
          }),
        };
      }

      if (
        url === "https://api.opensteer.dev/v1/sessions/session_123/access" &&
        init?.method === "POST"
      ) {
        staleAccessCalls += 1;
        events.push("stale-access");
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: "Session has expired.",
            code: "CLOUD_SESSION_STALE",
          }),
        };
      }

      if (
        url === "https://api.opensteer.dev/v1/sessions/session_456" &&
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
        url === `${firstSemanticBaseUrl}/api/v2/semantic/operations/session/open` &&
        init?.method === "POST"
      ) {
        const request = JSON.parse(String(init.body)) as OpensteerRequestEnvelope<unknown>;
        events.push("semantic-open-1");
        return {
          ok: true,
          json: async () =>
            createSuccessEnvelope(request, {
              sessionRef: "session:cloud-1",
              pageRef: "page:cloud-1",
              url: "https://example.com",
              title: "Cloud Workspace",
            }),
        };
      }

      if (
        url === `${secondSemanticBaseUrl}/api/v2/semantic/operations/session/open` &&
        init?.method === "POST"
      ) {
        const request = JSON.parse(String(init.body)) as OpensteerRequestEnvelope<unknown>;
        events.push("semantic-open-2");
        return {
          ok: true,
          json: async () =>
            createSuccessEnvelope(request, {
              sessionRef: "session:cloud-2",
              pageRef: "page:cloud-2",
              url: "https://example.com",
              title: "Recovered Cloud Workspace",
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
      await first.open({
        url: "https://example.com",
      });
      await first.disconnect();

      expect(await readPersistedCloudSessionRecord(workspaceRoot)).toMatchObject({
        sessionId: "session_123",
      });

      const second = new CloudSessionProxy(client, {
        rootDir,
        workspace,
      });
      const reopened = await second.open({
        url: "https://example.com",
      });

      expect(reopened).toMatchObject({
        title: "Recovered Cloud Workspace",
      });
      expect(events).toEqual([
        "create-session-1",
        "semantic-open-1",
        "get-session",
        "stale-access",
        "create-session-2",
        "semantic-open-2",
      ]);
      expect(createSessionCalls).toBe(2);
      expect(getSessionCalls).toBe(1);
      expect(staleAccessCalls).toBe(1);
      expect(await readPersistedCloudSessionRecord(workspaceRoot)).toMatchObject({
        sessionId: "session_456",
      });

      await second.close();

      expect(closeSessionCalls).toBe(1);
      expect(await readPersistedCloudSessionRecord(workspaceRoot)).toBeUndefined();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("CloudSessionProxy recreates a bound session when grant refresh reports a stale session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const firstSemanticBaseUrl = "https://cloud.example/runtime/session_123";
    const secondSemanticBaseUrl = "https://cloud.example/runtime/session_456";
    const firstSemanticGrant = {
      kind: "semantic" as const,
      transport: "http" as const,
      url: firstSemanticBaseUrl,
      token: "semantic-token-1",
      expiresAt: Date.now() + 60_000,
    };
    const secondSemanticGrant = {
      kind: "semantic" as const,
      transport: "http" as const,
      url: secondSemanticBaseUrl,
      token: "semantic-token-2",
      expiresAt: Date.now() + 120_000,
    };
    let createSessionCalls = 0;
    let staleAccessCalls = 0;
    let closeSessionCalls = 0;
    const events: string[] = [];

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.opensteer.dev/v1/sessions" && init?.method === "POST") {
        createSessionCalls += 1;
        events.push(`create-session-${createSessionCalls}`);
        if (createSessionCalls === 1) {
          return {
            ok: true,
            json: async () => ({
              sessionId: "session_123",
              status: "active",
              initialGrants: {
                semantic: firstSemanticGrant,
              },
              initialGrantExpiresAt: firstSemanticGrant.expiresAt,
            }),
          };
        }

        return {
          ok: true,
          json: async () => ({
            sessionId: "session_456",
            status: "active",
            initialGrants: {
              semantic: secondSemanticGrant,
            },
            initialGrantExpiresAt: secondSemanticGrant.expiresAt,
          }),
        };
      }

      if (
        url === "https://api.opensteer.dev/v1/sessions/session_123/access" &&
        init?.method === "POST"
      ) {
        staleAccessCalls += 1;
        events.push("stale-access");
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: "Session has expired.",
            code: "CLOUD_SESSION_STALE",
          }),
        };
      }

      if (
        url === "https://api.opensteer.dev/v1/sessions/session_456" &&
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
        url === `${firstSemanticBaseUrl}/api/v2/semantic/operations/session/open` &&
        init?.method === "POST"
      ) {
        const request = JSON.parse(String(init.body)) as OpensteerRequestEnvelope<unknown>;
        events.push("semantic-open-1");
        return {
          ok: true,
          json: async () =>
            createSuccessEnvelope(request, {
              sessionRef: "session:cloud-1",
              pageRef: "page:cloud-1",
              url: "https://example.com",
              title: "Cloud Workspace",
            }),
        };
      }

      if (
        url === `${secondSemanticBaseUrl}/api/v2/semantic/operations/page/list` &&
        init?.method === "POST"
      ) {
        const request = JSON.parse(String(init.body)) as OpensteerRequestEnvelope<unknown>;
        events.push("page-list-2");
        return {
          ok: true,
          json: async () =>
            createSuccessEnvelope(request, {
              activePageRef: "page:cloud-2",
              pages: [
                {
                  pageRef: "page:cloud-2",
                  url: "https://example.com",
                  title: "Recovered Cloud Workspace",
                },
              ],
            }),
        };
      }

      throw new Error(`Unexpected fetch ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const proxy = new CloudSessionProxy(
      new OpensteerCloudClient({
        apiKey: "osk_test",
        baseUrl: "https://api.opensteer.dev",
      }),
    );

    const opened = await proxy.open({
      url: "https://example.com",
    });

    expect(opened).toMatchObject({
      title: "Cloud Workspace",
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:55.000Z"));

    const pages = await proxy.listPages();

    expect(pages).toMatchObject({
      activePageRef: "page:cloud-2",
      pages: [
        {
          pageRef: "page:cloud-2",
          url: "https://example.com",
          title: "Recovered Cloud Workspace",
        },
      ],
    });
    expect(events).toEqual([
      "create-session-1",
      "semantic-open-1",
      "stale-access",
      "create-session-2",
      "page-list-2",
    ]);
    expect(createSessionCalls).toBe(2);
    expect(staleAccessCalls).toBe(1);

    await proxy.close();

    expect(closeSessionCalls).toBe(1);
  });

  test("CloudSessionProxy fails creating a new session when workspace sync fails", async () => {
    syncLocalWorkspaceToCloudMock.mockRejectedValueOnce(new Error("sync failed"));
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-cloud-session-"));
    const semanticBaseUrl = "https://cloud.example/runtime/session_123";
    const semanticGrant = {
      kind: "semantic" as const,
      transport: "http" as const,
      url: semanticBaseUrl,
      token: "semantic-token",
      expiresAt: 4_102_444_800_000,
    };

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.opensteer.dev/v1/sessions" && init?.method === "POST") {
        return {
          ok: true,
          json: async () => ({
            sessionId: "session_123",
            status: "active",
            initialGrants: {
              semantic: semanticGrant,
            },
            initialGrantExpiresAt: semanticGrant.expiresAt,
          }),
        };
      }

      if (
        url === `${semanticBaseUrl}/api/v2/semantic/operations/session/open` &&
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
      ).rejects.toThrow("sync failed");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("CloudSessionProxy fails reusing a persisted session when workspace sync fails", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-cloud-session-"));
    const workspace = "cloud-workspace";
    const semanticBaseUrl = "https://cloud.example/runtime/session_123";
    const semanticGrant = {
      kind: "semantic" as const,
      transport: "http" as const,
      url: semanticBaseUrl,
      token: "semantic-token",
      expiresAt: 4_102_444_800_000,
    };

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.opensteer.dev/v1/sessions" && init?.method === "POST") {
        return {
          ok: true,
          json: async () => ({
            sessionId: "session_123",
            status: "active",
            initialGrants: {
              semantic: semanticGrant,
            },
            initialGrantExpiresAt: semanticGrant.expiresAt,
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
        url === "https://api.opensteer.dev/v1/sessions/session_123/access" &&
        init?.method === "POST"
      ) {
        return {
          ok: true,
          json: async () => ({
            sessionId: "session_123",
            expiresAt: semanticGrant.expiresAt,
            grants: {
              semantic: semanticGrant,
            },
          }),
        };
      }

      if (
        url === `${semanticBaseUrl}/api/v2/semantic/operations/session/open` &&
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

      syncLocalWorkspaceToCloudMock.mockResolvedValueOnce(undefined);
      const first = new CloudSessionProxy(client, {
        rootDir,
        workspace,
      });
      await first.open({
        url: "https://example.com",
      });
      await first.disconnect();

      syncLocalWorkspaceToCloudMock.mockRejectedValueOnce(new Error("sync failed"));
      const second = new CloudSessionProxy(client, {
        rootDir,
        workspace,
      });
      await expect(
        second.open({
          url: "https://example.com",
        }),
      ).rejects.toThrow("sync failed");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("CloudSessionProxy surfaces semantic 409 conflicts without refreshing the grant", async () => {
    const semanticBaseUrl = "https://cloud.example/runtime/session_123";
    const semanticGrant = {
      kind: "semantic" as const,
      transport: "http" as const,
      url: semanticBaseUrl,
      token: "semantic-token",
      expiresAt: 4_102_444_800_000,
    };
    let accessCalls = 0;

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.opensteer.dev/v1/sessions" && init?.method === "POST") {
        return {
          ok: true,
          json: async () => ({
            sessionId: "session_123",
            status: "active",
            initialGrants: {
              semantic: semanticGrant,
            },
            initialGrantExpiresAt: semanticGrant.expiresAt,
          }),
        };
      }

      if (
        url === "https://api.opensteer.dev/v1/sessions/session_123/access" &&
        init?.method === "POST"
      ) {
        accessCalls += 1;
        return {
          ok: true,
          json: async () => ({
            sessionId: "session_123",
            expiresAt: semanticGrant.expiresAt,
            grants: {
              semantic: semanticGrant,
            },
          }),
        };
      }

      if (
        url === `${semanticBaseUrl}/api/v2/semantic/operations/session/open` &&
        init?.method === "POST"
      ) {
        const request = JSON.parse(String(init.body)) as OpensteerRequestEnvelope<unknown>;
        return {
          ok: false,
          status: 409,
          json: async () =>
            createErrorEnvelope(
              request,
              createOpensteerError("conflict", "session state conflict"),
            ),
        };
      }

      throw new Error(`Unexpected fetch ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const proxy = new CloudSessionProxy(
      new OpensteerCloudClient({
        apiKey: "osk_test",
        baseUrl: "https://api.opensteer.dev",
      }),
    );

    await expect(
      proxy.open({
        url: "https://example.com",
      }),
    ).rejects.toMatchObject({
      name: "OpensteerSemanticRestError",
      statusCode: 409,
      opensteerError: expect.objectContaining({
        code: "conflict",
      }),
    });
    expect(accessCalls).toBe(0);
  });

  test("CloudSessionProxy applies custom timeout policy to cloud operations", async () => {
    const semanticBaseUrl = "https://cloud.example/runtime/session_123";
    const semanticGrant = {
      kind: "semantic" as const,
      transport: "http" as const,
      url: semanticBaseUrl,
      token: "semantic-token",
      expiresAt: 4_102_444_800_000,
    };
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.opensteer.dev/v1/sessions" && init?.method === "POST") {
        return {
          ok: true,
          json: async () => ({
            sessionId: "session_123",
            status: "active",
            initialGrants: {
              semantic: semanticGrant,
            },
            initialGrantExpiresAt: semanticGrant.expiresAt,
          }),
        };
      }

      if (
        url === `${semanticBaseUrl}/api/v2/semantic/operations/network/detail` &&
        init?.method === "POST"
      ) {
        const request = JSON.parse(String(init.body)) as OpensteerRequestEnvelope<unknown>;
        return {
          ok: true,
          json: async () =>
            createSuccessEnvelope(request, {
              recordId: "record:test",
              summary: {
                recordId: "record:test",
                method: "GET",
                url: "https://example.com/data",
              },
              requestHeaders: [],
              responseHeaders: [],
            }),
        };
      }

      throw new Error(`Unexpected fetch ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const basePolicy = defaultPolicy();
    const proxy = new CloudSessionProxy(
      new OpensteerCloudClient({
        apiKey: "osk_test",
        baseUrl: "https://api.opensteer.dev",
      }),
      {
        policy: {
          ...basePolicy,
          timeout: {
            resolveTimeoutMs(input) {
              if (input.operation === "network.detail") {
                return 60_000;
              }
              return basePolicy.timeout.resolveTimeoutMs(input);
            },
          },
        },
      },
    );

    await proxy.getNetworkDetail({
      recordId: "record:test",
      probe: true,
    });

    const lastFetch = fetchMock.mock.calls.at(-1);
    expect(lastFetch?.[0]).toBe(`${semanticBaseUrl}/api/v2/semantic/operations/network/detail`);
    expect(lastFetch?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-opensteer-timeout-ms": expect.stringMatching(/^59\d{3}$|^60000$/),
        }),
      }),
    );
    expect(
      timeoutSpy.mock.calls.some(
        ([budgetMs]) => typeof budgetMs === "number" && budgetMs >= 59_000,
      ),
    ).toBe(true);
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
