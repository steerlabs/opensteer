import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  OPENSTEER_PROTOCOL_REST_BASE_PATH,
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
import { DEFAULT_OPENSTEER_CLOUD_BASE_URL } from "../../packages/opensteer/src/cloud/config.js";
import { OpensteerCloudAutomationClient } from "../../packages/opensteer/src/cloud/automation-client.js";
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
  vi.restoreAllMocks();
});

const CLOUD_API_KEY = "osk_test";
const CLOUD_BASE_URL = DEFAULT_OPENSTEER_CLOUD_BASE_URL;
const CLOUD_WORKSPACE = "cloud-workspace";
const EXAMPLE_URL = "https://example.com";

type TemporaryCloudWorkspace = {
  readonly rootDir: string;
  readonly workspace: string;
  readonly workspaceRoot: string;
};

function createCloudClient(
  overrides: Partial<ConstructorParameters<typeof OpensteerCloudClient>[0]> = {},
): OpensteerCloudClient {
  return new OpensteerCloudClient({
    apiKey: CLOUD_API_KEY,
    baseUrl: CLOUD_BASE_URL,
    ...overrides,
  });
}

function createSemanticGrant(input: {
  readonly url: string;
  readonly token: string;
  readonly expiresAt: number;
}) {
  return {
    kind: "semantic" as const,
    transport: "http" as const,
    url: input.url,
    token: input.token,
    expiresAt: input.expiresAt,
  };
}

function createActiveSessionDescriptor(
  sessionId: string,
  semanticGrant?: ReturnType<typeof createSemanticGrant>,
) {
  return {
    sessionId,
    status: "active" as const,
    initialGrants: semanticGrant === undefined ? {} : { semantic: semanticGrant },
    ...(semanticGrant === undefined ? {} : { initialGrantExpiresAt: semanticGrant.expiresAt }),
  };
}

function createClosedSessionDescriptor() {
  return {
    status: "closed" as const,
  };
}

function createStaleSessionPayload(details?: unknown) {
  return {
    error: "Session has expired.",
    code: "CLOUD_SESSION_STALE",
    ...(details === undefined ? {} : { details }),
  };
}

function createStaleSessionResponse(details?: unknown) {
  return {
    ok: false,
    status: 409,
    json: async () => createStaleSessionPayload(details),
  };
}

function createStaleSessionError(sessionId: string): OpensteerCloudRequestError {
  return new OpensteerCloudRequestError({
    statusCode: 409,
    code: "CLOUD_SESSION_STALE",
    method: "POST",
    pathname: `/v1/sessions/${sessionId}/access`,
    url: `${CLOUD_BASE_URL}/v1/sessions/${sessionId}/access`,
    message: "Session has expired.",
  });
}

function parseRequestEnvelope(init?: RequestInit): OpensteerRequestEnvelope<unknown> {
  return JSON.parse(String(init?.body)) as OpensteerRequestEnvelope<unknown>;
}

async function withTemporaryCloudWorkspace(
  run: (workspace: TemporaryCloudWorkspace) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-cloud-session-"));
  const workspace = CLOUD_WORKSPACE;
  const workspaceRoot = path.join(rootDir, ".opensteer", "workspaces", workspace);

  try {
    await run({ rootDir, workspace, workspaceRoot });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

describe("cloud browser-profile integration", () => {
  test("resolves cloud runtime config with a default browser profile preference", () => {
    vi.stubEnv("OPENSTEER_PROVIDER", "cloud");
    vi.stubEnv("OPENSTEER_API_KEY", "osk_test");

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
        baseUrl: DEFAULT_OPENSTEER_CLOUD_BASE_URL,
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
      baseUrl: "https://api.opensteer.com",
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
      "https://api.opensteer.com/v1/sessions",
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
      baseUrl: "https://api.opensteer.com",
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
      "https://api.opensteer.com/registry/descriptors/import",
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
      baseUrl: "https://api.opensteer.com",
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
      "https://api.opensteer.com/registry/request-plans/import",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  test("OpensteerCloudClient preserves structured cloud request errors", async () => {
    const fetchMock = vi.fn(async () =>
      createStaleSessionResponse({
        reason: "expired",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createCloudClient();

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
      baseUrl: "https://api.opensteer.com",
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
      "https://api.opensteer.com/v1/browser-profiles/imports",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          profileId: "bp_456",
        }),
      }),
    );
  });

  test("CloudSessionProxy reuses persisted workspace cloud sessions", async () => {
    await withTemporaryCloudWorkspace(async ({ rootDir, workspace, workspaceRoot }) => {
      const semanticBaseUrl = "https://cloud.example/runtime/session_123";
      const semanticGrant = createSemanticGrant({
        url: semanticBaseUrl,
        token: "semantic-token",
        expiresAt: 4_102_444_800_000,
      });
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
        if (url === `${CLOUD_BASE_URL}/v1/sessions` && init?.method === "POST") {
          createSessionCalls += 1;
          events.push("create-session");
          return {
            ok: true,
            json: async () => createActiveSessionDescriptor("session_123", semanticGrant),
          };
        }

        if (url === `${CLOUD_BASE_URL}/v1/sessions/session_123/access` && init?.method === "POST") {
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

        if (url === `${CLOUD_BASE_URL}/v1/sessions/session_123` && init?.method === "GET") {
          getSessionCalls += 1;
          events.push("get-session");
          return {
            ok: true,
            json: async () => ({
              status: "active",
            }),
          };
        }

        if (url === `${CLOUD_BASE_URL}/v1/sessions/session_123` && init?.method === "DELETE") {
          closeSessionCalls += 1;
          return {
            ok: true,
            json: async () => createClosedSessionDescriptor(),
          };
        }

        if (
          url ===
            `${semanticBaseUrl}${OPENSTEER_PROTOCOL_REST_BASE_PATH}/semantic/operations/session/open` &&
          init?.method === "POST"
        ) {
          semanticOpenCalls += 1;
          events.push("semantic-open");
          return {
            ok: true,
            json: async () =>
              createSuccessEnvelope(parseRequestEnvelope(init), {
                sessionRef: "session:cloud",
                pageRef: "page:cloud",
                url: EXAMPLE_URL,
                title: "Cloud Workspace",
              }),
          };
        }

        throw new Error(`Unexpected fetch ${init?.method ?? "GET"} ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const client = createCloudClient();
      const first = new CloudSessionProxy(client, {
        rootDir,
        workspace,
      });
      const openedFirst = await first.open({
        url: EXAMPLE_URL,
        browser: "persistent",
        launch: {
          headless: true,
        },
      });

      expect(openedFirst).toMatchObject({
        url: EXAMPLE_URL,
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
        url: EXAMPLE_URL,
      });

      expect(events.slice(3)).toEqual(["get-session", "sync", "access", "semantic-open"]);
      expect(createSessionCalls).toBe(1);
      expect(getSessionCalls).toBe(1);
      expect(accessCalls).toBe(1);
      expect(semanticOpenCalls).toBe(2);

      await second.close();

      expect(closeSessionCalls).toBe(1);
      expect(await readPersistedCloudSessionRecord(workspaceRoot)).toBeUndefined();
    });
  });

  test("CloudSessionProxy does not reuse persisted workspace sessions that are already expired", async () => {
    await withTemporaryCloudWorkspace(async ({ rootDir, workspace, workspaceRoot }) => {
      const firstSemanticBaseUrl = "https://cloud.example/runtime/session_123";
      const secondSemanticBaseUrl = "https://cloud.example/runtime/session_456";
      const firstSemanticGrant = createSemanticGrant({
        url: firstSemanticBaseUrl,
        token: "semantic-token-1",
        expiresAt: 4_102_444_800_000,
      });
      const secondSemanticGrant = createSemanticGrant({
        url: secondSemanticBaseUrl,
        token: "semantic-token-2",
        expiresAt: 4_102_444_800_000,
      });
      let createSessionCalls = 0;
      let getSessionCalls = 0;
      let staleAccessCalls = 0;
      let closeSessionCalls = 0;
      const events: string[] = [];

      syncLocalWorkspaceToCloudMock.mockResolvedValue(undefined);

      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === `${CLOUD_BASE_URL}/v1/sessions` && init?.method === "POST") {
          createSessionCalls += 1;
          events.push(`create-session-${createSessionCalls}`);
          return {
            ok: true,
            json: async () =>
              createActiveSessionDescriptor(
                createSessionCalls === 1 ? "session_123" : "session_456",
                createSessionCalls === 1 ? firstSemanticGrant : secondSemanticGrant,
              ),
          };
        }

        if (url === `${CLOUD_BASE_URL}/v1/sessions/session_123` && init?.method === "GET") {
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

        if (url === `${CLOUD_BASE_URL}/v1/sessions/session_123/access` && init?.method === "POST") {
          staleAccessCalls += 1;
          events.push("stale-access");
          return createStaleSessionResponse();
        }

        if (url === `${CLOUD_BASE_URL}/v1/sessions/session_456` && init?.method === "DELETE") {
          closeSessionCalls += 1;
          return {
            ok: true,
            json: async () => createClosedSessionDescriptor(),
          };
        }

        if (
          url ===
            `${firstSemanticBaseUrl}${OPENSTEER_PROTOCOL_REST_BASE_PATH}/semantic/operations/session/open` &&
          init?.method === "POST"
        ) {
          events.push("semantic-open-1");
          return {
            ok: true,
            json: async () =>
              createSuccessEnvelope(parseRequestEnvelope(init), {
                sessionRef: "session:cloud-1",
                pageRef: "page:cloud-1",
                url: EXAMPLE_URL,
                title: "Cloud Workspace",
              }),
          };
        }

        if (
          url ===
            `${secondSemanticBaseUrl}${OPENSTEER_PROTOCOL_REST_BASE_PATH}/semantic/operations/session/open` &&
          init?.method === "POST"
        ) {
          events.push("semantic-open-2");
          return {
            ok: true,
            json: async () =>
              createSuccessEnvelope(parseRequestEnvelope(init), {
                sessionRef: "session:cloud-2",
                pageRef: "page:cloud-2",
                url: EXAMPLE_URL,
                title: "Recovered Cloud Workspace",
              }),
          };
        }

        throw new Error(`Unexpected fetch ${init?.method ?? "GET"} ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const client = createCloudClient();
      const first = new CloudSessionProxy(client, {
        rootDir,
        workspace,
      });
      await first.open({
        url: EXAMPLE_URL,
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
        url: EXAMPLE_URL,
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
    });
  });

  test("CloudSessionProxy recreates a persisted workspace session when access is stale", async () => {
    await withTemporaryCloudWorkspace(async ({ rootDir, workspace, workspaceRoot }) => {
      const firstSemanticBaseUrl = "https://cloud.example/runtime/session_123";
      const secondSemanticBaseUrl = "https://cloud.example/runtime/session_456";
      const firstSemanticGrant = createSemanticGrant({
        url: firstSemanticBaseUrl,
        token: "semantic-token-1",
        expiresAt: 4_102_444_800_000,
      });
      const secondSemanticGrant = createSemanticGrant({
        url: secondSemanticBaseUrl,
        token: "semantic-token-2",
        expiresAt: 4_102_444_800_000,
      });
      let createSessionCalls = 0;
      let getSessionCalls = 0;
      let staleAccessCalls = 0;
      let closeSessionCalls = 0;
      const events: string[] = [];

      syncLocalWorkspaceToCloudMock.mockResolvedValue(undefined);

      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === `${CLOUD_BASE_URL}/v1/sessions` && init?.method === "POST") {
          createSessionCalls += 1;
          events.push(`create-session-${createSessionCalls}`);
          return {
            ok: true,
            json: async () =>
              createActiveSessionDescriptor(
                createSessionCalls === 1 ? "session_123" : "session_456",
                createSessionCalls === 1 ? firstSemanticGrant : secondSemanticGrant,
              ),
          };
        }

        if (url === `${CLOUD_BASE_URL}/v1/sessions/session_123` && init?.method === "GET") {
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

        if (url === `${CLOUD_BASE_URL}/v1/sessions/session_123/access` && init?.method === "POST") {
          staleAccessCalls += 1;
          events.push("stale-access");
          return createStaleSessionResponse();
        }

        if (url === `${CLOUD_BASE_URL}/v1/sessions/session_456` && init?.method === "DELETE") {
          closeSessionCalls += 1;
          return {
            ok: true,
            json: async () => createClosedSessionDescriptor(),
          };
        }

        if (
          url ===
            `${firstSemanticBaseUrl}${OPENSTEER_PROTOCOL_REST_BASE_PATH}/semantic/operations/session/open` &&
          init?.method === "POST"
        ) {
          events.push("semantic-open-1");
          return {
            ok: true,
            json: async () =>
              createSuccessEnvelope(parseRequestEnvelope(init), {
                sessionRef: "session:cloud-1",
                pageRef: "page:cloud-1",
                url: EXAMPLE_URL,
                title: "Cloud Workspace",
              }),
          };
        }

        if (
          url ===
            `${secondSemanticBaseUrl}${OPENSTEER_PROTOCOL_REST_BASE_PATH}/semantic/operations/session/open` &&
          init?.method === "POST"
        ) {
          events.push("semantic-open-2");
          return {
            ok: true,
            json: async () =>
              createSuccessEnvelope(parseRequestEnvelope(init), {
                sessionRef: "session:cloud-2",
                pageRef: "page:cloud-2",
                url: EXAMPLE_URL,
                title: "Recovered Cloud Workspace",
              }),
          };
        }

        throw new Error(`Unexpected fetch ${init?.method ?? "GET"} ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const client = createCloudClient();
      const first = new CloudSessionProxy(client, {
        rootDir,
        workspace,
      });
      await first.open({
        url: EXAMPLE_URL,
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
        url: EXAMPLE_URL,
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
    });
  });

  test("CloudSessionProxy invalidates a live bound session instead of recreating it on stale grant refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const firstSemanticBaseUrl = "https://cloud.example/runtime/session_123";
    const firstSemanticGrant = createSemanticGrant({
      url: firstSemanticBaseUrl,
      token: "semantic-token-1",
      expiresAt: Date.now() + 60_000,
    });
    let createSessionCalls = 0;
    let staleAccessCalls = 0;
    const events: string[] = [];

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `${CLOUD_BASE_URL}/v1/sessions` && init?.method === "POST") {
        createSessionCalls += 1;
        events.push(`create-session-${createSessionCalls}`);
        return {
          ok: true,
          json: async () => createActiveSessionDescriptor("session_123", firstSemanticGrant),
        };
      }

      if (url === `${CLOUD_BASE_URL}/v1/sessions/session_123/access` && init?.method === "POST") {
        staleAccessCalls += 1;
        events.push("stale-access");
        return createStaleSessionResponse();
      }

      if (
        url ===
          `${firstSemanticBaseUrl}${OPENSTEER_PROTOCOL_REST_BASE_PATH}/semantic/operations/session/open` &&
        init?.method === "POST"
      ) {
        events.push("semantic-open-1");
        return {
          ok: true,
          json: async () =>
            createSuccessEnvelope(parseRequestEnvelope(init), {
              sessionRef: "session:cloud-1",
              pageRef: "page:cloud-1",
              url: EXAMPLE_URL,
              title: "Cloud Workspace",
            }),
        };
      }

      throw new Error(`Unexpected fetch ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const proxy = new CloudSessionProxy(createCloudClient());

    const opened = await proxy.open({
      url: EXAMPLE_URL,
    });

    expect(opened).toMatchObject({
      title: "Cloud Workspace",
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:55.000Z"));

    await expect(proxy.listPages()).rejects.toMatchObject({
      statusCode: 409,
      code: "CLOUD_SESSION_STALE",
    });
    expect(events).toEqual(["create-session-1", "semantic-open-1", "stale-access"]);
    expect(createSessionCalls).toBe(1);
    expect(staleAccessCalls).toBe(1);

    await expect(proxy.close()).resolves.toMatchObject({
      closed: true,
    });
  });

  test("CloudSessionProxy recovers bootstrap route registration when the automation session is stale", async () => {
    const events: string[] = [];
    let createSessionCalls = 0;

    const routeSpy = vi
      .spyOn(OpensteerCloudAutomationClient.prototype, "route")
      .mockImplementation(async function (input) {
        const sessionId = (this as { sessionId: string }).sessionId;
        events.push(`route:${sessionId}`);
        if (sessionId === "session_123") {
          throw createStaleSessionError(sessionId);
        }
        return {
          routeId: `route:${sessionId}`,
          sessionRef: `session:${sessionId}`,
          urlPattern: input.urlPattern,
        };
      });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.opensteer.com/v1/sessions" && init?.method === "POST") {
        createSessionCalls += 1;
        events.push(`create-session-${createSessionCalls}`);
        return {
          ok: true,
          json: async () => ({
            sessionId: createSessionCalls === 1 ? "session_123" : "session_456",
            status: "active",
            initialGrants: {},
          }),
        };
      }

      throw new Error(`Unexpected fetch ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const proxy = new CloudSessionProxy(
      new OpensteerCloudClient({
        apiKey: "osk_test",
        baseUrl: "https://api.opensteer.com",
      }),
    );

    const registration = await proxy.route({
      urlPattern: "**/*",
      handler: async () => ({ kind: "continue" }),
    });

    expect(registration).toMatchObject({
      routeId: "route:session_456",
      sessionRef: "session:session_456",
      urlPattern: "**/*",
    });
    expect(events).toEqual([
      "create-session-1",
      "route:session_123",
      "create-session-2",
      "route:session_456",
    ]);
    expect(createSessionCalls).toBe(2);
    expect(routeSpy).toHaveBeenCalledTimes(2);
  });

  test("CloudSessionProxy recovers bootstrap script interception when the automation session is stale", async () => {
    const events: string[] = [];
    let createSessionCalls = 0;

    const interceptSpy = vi
      .spyOn(OpensteerCloudAutomationClient.prototype, "interceptScript")
      .mockImplementation(async function (input) {
        const sessionId = (this as { sessionId: string }).sessionId;
        events.push(`intercept:${sessionId}`);
        if (sessionId === "session_123") {
          throw createStaleSessionError(sessionId);
        }
        return {
          routeId: `route:${sessionId}`,
          sessionRef: `session:${sessionId}`,
          urlPattern: input.urlPattern,
        };
      });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.opensteer.com/v1/sessions" && init?.method === "POST") {
        createSessionCalls += 1;
        events.push(`create-session-${createSessionCalls}`);
        return {
          ok: true,
          json: async () => ({
            sessionId: createSessionCalls === 1 ? "session_123" : "session_456",
            status: "active",
            initialGrants: {},
          }),
        };
      }

      throw new Error(`Unexpected fetch ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const proxy = new CloudSessionProxy(
      new OpensteerCloudClient({
        apiKey: "osk_test",
        baseUrl: "https://api.opensteer.com",
      }),
    );

    const registration = await proxy.interceptScript({
      urlPattern: "**/*.js",
      handler: async ({ content }) => content,
    });

    expect(registration).toMatchObject({
      routeId: "route:session_456",
      sessionRef: "session:session_456",
      urlPattern: "**/*.js",
    });
    expect(events).toEqual([
      "create-session-1",
      "intercept:session_123",
      "create-session-2",
      "intercept:session_456",
    ]);
    expect(createSessionCalls).toBe(2);
    expect(interceptSpy).toHaveBeenCalledTimes(2);
  });

  test("CloudSessionProxy reapplies stored route registrations before retrying session.open on a fresh session", async () => {
    const firstSemanticBaseUrl = "https://cloud.example/runtime/session_123";
    const secondSemanticBaseUrl = "https://cloud.example/runtime/session_456";
    const firstSemanticGrant = {
      kind: "semantic" as const,
      transport: "http" as const,
      url: firstSemanticBaseUrl,
      token: "semantic-token-1",
      expiresAt: Date.now() + 1_000,
    };
    const secondSemanticGrant = {
      kind: "semantic" as const,
      transport: "http" as const,
      url: secondSemanticBaseUrl,
      token: "semantic-token-2",
      expiresAt: Date.now() + 60_000,
    };
    let createSessionCalls = 0;
    let staleAccessCalls = 0;
    const events: string[] = [];

    const routeSpy = vi
      .spyOn(OpensteerCloudAutomationClient.prototype, "route")
      .mockImplementation(async function (input) {
        const sessionId = (this as { sessionId: string }).sessionId;
        events.push(`route:${sessionId}`);
        return {
          routeId: `route:${sessionId}`,
          sessionRef: `session:${sessionId}`,
          urlPattern: input.urlPattern,
        };
      });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.opensteer.com/v1/sessions" && init?.method === "POST") {
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
        url === "https://api.opensteer.com/v1/sessions/session_123/access" &&
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
        url ===
          `${secondSemanticBaseUrl}${OPENSTEER_PROTOCOL_REST_BASE_PATH}/semantic/operations/session/open` &&
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

    const proxy = new CloudSessionProxy(
      new OpensteerCloudClient({
        apiKey: "osk_test",
        baseUrl: "https://api.opensteer.com",
      }),
    );

    await proxy.route({
      urlPattern: "**/*",
      handler: async () => ({ kind: "continue" }),
    });

    const opened = await proxy.open({
      url: "https://example.com",
    });

    expect(opened).toMatchObject({
      title: "Recovered Cloud Workspace",
    });
    expect(events).toEqual([
      "create-session-1",
      "route:session_123",
      "stale-access",
      "create-session-2",
      "route:session_456",
      "semantic-open-2",
    ]);
    expect(createSessionCalls).toBe(2);
    expect(staleAccessCalls).toBe(1);
    expect(routeSpy).toHaveBeenCalledTimes(2);
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
      if (url === "https://api.opensteer.com/v1/sessions" && init?.method === "POST") {
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
        url ===
          `${semanticBaseUrl}${OPENSTEER_PROTOCOL_REST_BASE_PATH}/semantic/operations/session/open` &&
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
          baseUrl: "https://api.opensteer.com",
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
      if (url === "https://api.opensteer.com/v1/sessions" && init?.method === "POST") {
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

      if (url === "https://api.opensteer.com/v1/sessions/session_123" && init?.method === "GET") {
        return {
          ok: true,
          json: async () => ({
            status: "active",
          }),
        };
      }

      if (
        url === "https://api.opensteer.com/v1/sessions/session_123/access" &&
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
        url ===
          `${semanticBaseUrl}${OPENSTEER_PROTOCOL_REST_BASE_PATH}/semantic/operations/session/open` &&
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
        baseUrl: "https://api.opensteer.com",
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
      if (url === "https://api.opensteer.com/v1/sessions" && init?.method === "POST") {
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
        url === "https://api.opensteer.com/v1/sessions/session_123/access" &&
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
        url ===
          `${semanticBaseUrl}${OPENSTEER_PROTOCOL_REST_BASE_PATH}/semantic/operations/session/open` &&
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
        baseUrl: "https://api.opensteer.com",
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
      if (url === "https://api.opensteer.com/v1/sessions" && init?.method === "POST") {
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
        url ===
          `${semanticBaseUrl}${OPENSTEER_PROTOCOL_REST_BASE_PATH}/semantic/operations/network/detail` &&
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
        baseUrl: "https://api.opensteer.com",
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
    expect(lastFetch?.[0]).toBe(
      `${semanticBaseUrl}${OPENSTEER_PROTOCOL_REST_BASE_PATH}/semantic/operations/network/detail`,
    );
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
        baseUrl: "https://api.opensteer.com",
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
