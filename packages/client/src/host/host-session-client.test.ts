import {
  BootstrapReadDiagnostics,
  bootstrapDiagnosticHeader,
} from "@opensteer/shared/bootstrapDiagnostics";
import { bootstrapReadDiagnostics } from "./bootstrap-diagnostics.js";
import {
  SequenceSchema,
  ThreadIdSchema,
  WorkspaceIdSchema,
  ModelSelectionSchema,
  ThreadAccessModeSchema,
  createId,
  BrowserTabGroupIdSchema,
  emptyExecutionPreferences,
  type AgentEventView as AgentEvent,
  type Message,
  type NotificationView,
  type Request as OpensteerRequest,
  type Thread,
} from "@opensteer/core";
import {
  hostApi,
  createBrowserSessionId,
  BrowserSurfaceIdSchema,
  HostToClientMessageSchema,
  HostedBrowserBootstrapSchema,
  ComputerViewSchema,
  type WorkspaceTabLineage,
  type HostedBrowserBootstrap,
  type HostToClientMessage,
  type WorkspaceView,
} from "@opensteer/protocol";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { createIntegrationId } from "@opensteer/integration-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HttpHostClient,
  type HttpHostClientOptions,
  type WebSocketClient,
} from "./host-session-client.js";
import type { ExecutionSelection } from "./execution-preferences.js";
import { HostClientRequestError, type ThreadSummary } from "./client.js";
import { MockHostClient } from "../mock/mock-host-client.js";
import type { ClientLifecycle, ClientLifecycleSnapshot, ClientNetworkState } from "./lifecycle.js";
import { threadActivity, threadStopTarget } from "./thread-activity.js";
import { taskList, workspaceTaskList, sameTaskListSource } from "./task-list.js";
import { liveWork, sameLiveWorkSource } from "./surfaces.js";
import { threadMark } from "./task-marks.js";
import { assignmentMark } from "./assignment-presentation.js";
import { filterThreads } from "./thread-list-model.js";
import { browserTabStrip } from "./browser-tab-strip.js";
import { placeList } from "./places.js";
import { visibleTranscript } from "./transcript.js";
import { conversationRows, groupTranscriptEntries } from "./agent-activity-model.js";
import { projectSavedHome, type SavedViewReadiness } from "./saved-host-view.js";

const now = "2026-08-09T20:00:00.000Z";
const ownerId = createId("user");
const runnerId = createId("runner");
const environmentId = createId("environment");
const harnessInstanceId = createId("harnessInstance");

afterEach(() => {
  vi.useRealTimers();
});

/** Every test addresses the same notional Host, so only the cases about the
 * origin itself say which one. */
type TestHostClientOptions = Omit<HttpHostClientOptions, "baseUrl"> & {
  readonly baseUrl?: string | URL;
  /** Whether the case's own fetch sees the time zone report every bootstrap sends. */
  readonly timeZoneReports?: "answered" | "observed";
  readonly browserUsageReads?: "answered" | "observed";
  /** Whether the case's own fetch sees the task list reads that follow bootstrap and sync. */
  readonly taskReads?: "answered" | "observed";
  readonly browserCatalogReads?: "answered" | "observed";
};

function createHttpHostClient({
  timeZoneReports = "answered",
  browserUsageReads = "answered",
  taskReads = "answered",
  browserCatalogReads = "answered",
  ...options
}: TestHostClientOptions = {}): HttpHostClient {
  return new HttpHostClient({
    baseUrl: "http://127.0.0.1",
    ...options,
    ...(options.fetch
      ? {
          fetch: rpcContractFetch(
            options.fetch,
            timeZoneReports,
            browserUsageReads,
            taskReads,
            browserCatalogReads,
          ),
        }
      : {}),
  });
}

function rpcContractFetch(
  fetch: typeof globalThis.fetch,
  timeZoneReports: "answered" | "observed",
  browserUsageReads: "answered" | "observed",
  taskReads: "answered" | "observed",
  browserCatalogReads: "answered" | "observed",
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const prefix = "/v1/rpc/";
    if (!url.pathname.startsWith(prefix)) return fetch(input, init);
    const name = url.pathname.slice(prefix.length);
    // Legacy browser fixtures describe no authoritative tabs; deferred reads are empty.
    if (name === "browser.tabs.get" && browserCatalogReads === "answered")
      return json({ data: { generation: 0, revision: 0, tabs: [] }, ok: true });
    // Nothing waits on this notional Host's reader: the read follows every
    // bootstrap, and no case here is about it.
    if (name === "requests.list") {
      return json({
        data: {
          requests: [],
          window: { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 },
        },
        ok: true,
      });
    }
    // The reader has no tasks here unless the case is about them.
    if (name === "tasks.list" && taskReads === "answered") {
      return json({
        data: {
          readStates: [],
          tasks: [],
          window: { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 },
        },
        ok: true,
      });
    }
    const payload = rpcPayload(url, init);
    if (name === "thread.browserUsage.get" && browserUsageReads === "answered")
      return json({ data: { threadId: payload.threadId, uses: [] }, ok: true });
    // Likewise the time zone report that follows a bootstrap, except in the
    // cases about that report.
    if (
      timeZoneReports === "answered" &&
      name === "commands.dispatch" &&
      payload.type === "viewer.timeZone.update"
    ) {
      return json({ data: { timeZone: payload.timeZone, type: payload.type }, ok: true });
    }
    const response = await fetch(input, init);
    if (name === "workspace.files.preview" && response.ok) return response;
    const responseBody: unknown = response.status === 204 ? {} : await response.json();
    if (!response.ok) {
      const error = objectValue(responseBody, "error");
      const reason = stringValue(error, "reason");
      return json(
        {
          error: {
            code: stringValue(error, "code") ?? "internal",
            message: stringValue(error, "message") ?? "Request failed",
            retryable: booleanValue(error, "retryable") ?? false,
            ...(reason === null ? {} : { reason }),
          },
          ok: false,
        },
        response.status,
      );
    }
    const body = asObject(responseBody);
    const data =
      name === "commands.dispatch"
        ? { asOfSequence: "0", ...body, type: requiredString(payload, "type") }
        : name === "thread.events.list"
          ? {
              ...body,
              readState: body.readState ?? defaultReadState(requiredString(payload, "threadId")),
            }
          : name === "workspace.catalog.list"
            ? { ...body, notificationPreferences: preferencesForWorkspaces(body.workspaces) }
            : responseBody;
    return json({ data, ok: true }, response.status);
  };
}

function rpcPayload(url: URL, init: RequestInit | undefined): Readonly<Record<string, unknown>> {
  const raw = url.searchParams.has("input") ? url.searchParams.get("input") : init?.body;
  const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError("RPC input");
  return parsed as Readonly<Record<string, unknown>>;
}

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function objectValue(value: unknown, key: string): unknown {
  return asObject(value)[key];
}

function stringValue(value: unknown, key: string): string | null {
  const candidate = objectValue(value, key);
  return typeof candidate === "string" ? candidate : null;
}

function booleanValue(value: unknown, key: string): boolean | null {
  const candidate = objectValue(value, key);
  return typeof candidate === "boolean" ? candidate : null;
}

function requiredString(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new TypeError(`Missing ${key}`);
  return value;
}

function defaultReadState(threadId: string) {
  return {
    asOfSequence: SequenceSchema.parse("0"),
    readSequence: null,
    threadId: ThreadIdSchema.parse(threadId),
    unreadSequence: null,
  };
}

function preferencesForWorkspaces(value: unknown) {
  return Array.isArray(value)
    ? value.map((workspace) => ({
        muted: false,
        revision: SequenceSchema.parse("0"),
        workspaceId: WorkspaceIdSchema.parse(requiredString(asObject(workspace), "id")),
      }))
    : [];
}

describe("saved-view readiness", () => {
  it("distinguishes unknown Main, explicitly absent Home, and accepted latest/around windows", async () => {
    const main = makeWorkspace();
    const thread = makeThread(main.id);
    main.homeThreadId = thread.id;
    const client = createHttpHostClient({
      prefetchHome: true,
      refreshIntervalMs: 0,
      fetch: async (input) =>
        new URL(String(input)).pathname.endsWith("thread.events.list")
          ? json({
              thread,
              threadId: thread.id,
              events: [],
              window: {
                threadId: thread.id,
                byteCount: 2,
                hasMore: false,
                itemCount: 0,
                nextBefore: null,
                totalItems: 0,
              },
            })
          : json(bootstrap([main])),
    });
    expect(client.getSnapshot().savedViewReadiness?.home.status).toBe("unknown");
    await client.load();
    await vi.waitFor(() =>
      expect(client.getSnapshot().savedViewReadiness?.home.status).toBe("window"),
    );
    expect(client.getSnapshot().savedViewReadiness?.home).toMatchObject({
      status: "window",
      threadId: thread.id,
      latest: true,
    });
    await client.loadTranscriptAround(thread.id, createId("message"));
    expect(client.getSnapshot().savedViewReadiness?.home).toMatchObject({
      status: "window",
      latest: false,
    });
    client.dispose();
    for (const [workspaces, status] of [
      [[], "unknown"],
      [[makeWorkspace()], "absent"],
    ] as const) {
      const host = createHttpHostClient({
        refreshIntervalMs: 0,
        fetch: async () => json(bootstrap([...workspaces])),
      });
      await host.load();
      expect(host.getSnapshot().savedViewReadiness?.home.status).toBe(status);
      host.dispose();
    }
  });
});

describe("HttpHostClient Workspace files", () => {
  it("lists one directory on demand and decodes a bounded UTF-8 preview", async () => {
    const workspaceId = createId("workspace");
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/v1/rpc/workspace.files.list") {
        expect(init?.method).toBe("POST");
        expect(url.search).toBe("");
        const payload = rpcPayload(url, init);
        expect(payload.parentKey).toBe("");
        expect(payload.cursor).toBeUndefined();
        if (payload.knownRevision) {
          expect(payload.knownRevision).toBe("directory_revision_1");
          expect(payload.retainedCursor).toBe("retained_cursor_token_1");
        }
        return json({
          cursor: null,
          entries: [
            {
              executable: false,
              hidden: false,
              key: "UkVBRE1FLm1k",
              kind: "file",
              mode: 0o644,
              modifiedAt: null,
              name: "README.md",
              sizeBytes: 5,
            },
          ],
          parentKey: "",
          revision: "directory_revision_1",
        });
      }
      expect(url.pathname).toBe("/v1/rpc/workspace.files.preview");
      expect(init?.method).toBe("POST");
      expect(url.search).toBe("");
      expect(rpcPayload(url, init).fileKey).toBe("UkVBRE1FLm1k");
      return new Response("hello", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          etag: '"file-etag"',
          "last-modified": "Wed, 12 Aug 2026 12:00:00 GMT",
          "x-opensteer-file-size": "5",
          "x-opensteer-file-truncated": "false",
        },
      });
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      baseUrl: "https://opensteer.example/app/",
      fetch,
      refreshIntervalMs: 0,
    });

    await expect(client.listWorkspaceFiles(workspaceId, { parentKey: "" })).resolves.toMatchObject({
      entries: [{ name: "README.md" }],
    });
    await expect(
      client.listWorkspaceFiles(workspaceId, {
        knownRevision: "directory_revision_1",
        parentKey: "",
        retainedCursor: "retained_cursor_token_1",
      }),
    ).resolves.toMatchObject({ revision: "directory_revision_1" });
    await expect(client.previewWorkspaceFile(workspaceId, "UkVBRE1FLm1k")).resolves.toEqual({
      content: "hello",
      metadata: {
        contentType: "text/plain; charset=utf-8",
        etag: '"file-etag"',
        modifiedAt: "2026-08-12T12:00:00.000Z",
        sizeBytes: 5,
        truncated: false,
      },
    });
    expect(client.workspaceFileDownloadUrl(workspaceId, "UkVBRE1FLm1k")).toBe(
      `https://opensteer.example/v1/workspaces/${workspaceId}/files/download?file=UkVBRE1FLm1k`,
    );
    client.dispose();
  });

  it("does not decode arbitrary binary bytes into the preview", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(new Uint8Array([0xff, 0xfe, 0xfd]), {
          headers: {
            "content-type": "application/octet-stream",
            etag: '"binary-etag"',
            "x-opensteer-file-size": "3",
            "x-opensteer-file-truncated": "false",
          },
        }),
    ) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({ fetch, refreshIntervalMs: 0 });

    await expect(
      client.previewWorkspaceFile(createId("workspace"), "YmluYXJ5"),
    ).resolves.toMatchObject({ content: null });
    client.dispose();
  });

  it("rejects a preview whose declared body exceeds the client limit", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("small", {
          headers: {
            "content-length": String(512 * 1_024 + 1),
            "content-type": "text/plain",
          },
        }),
    ) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({ fetch, refreshIntervalMs: 0 });

    await expect(
      client.previewWorkspaceFile(createId("workspace"), "UkVBRE1FLm1k"),
    ).rejects.toThrow(/larger than this app accepts/);
    client.dispose();
  });
});

describe("profile preparation", () => {
  it.each([true, false])(
    "deduplicates per attach, never waits, and gates old Hosts: %s",
    async (supported) => {
      const requests: unknown[] = [];
      const pending = Promise.withResolvers<Response>();
      const client = createHttpHostClient({
        capabilities: supported ? ["browser-profile-prepare-v1"] : [],
        refreshIntervalMs: 0,
        fetch: async (input, init) => {
          if (String(input).endsWith("commands.dispatch")) {
            requests.push(JSON.parse(String(init?.body)));
            return pending.promise;
          }
          return json(
            bootstrap([makeWorkspace()], {
              profileGrants: [],
              available: true,
              placements: [],
              profiles: [],
              sessions: [],
            }),
          );
        },
      });
      try {
        await client.load();
        const identity = { kind: "profile" as const, profileId: createId("browserProfile") };
        expect(client.prepareBrowserProfile(identity)).toBeUndefined();
        client.prepareBrowserProfile(identity);
        client.prepareBrowserProfile({ kind: "guest" });
        await vi.waitFor(
          () =>
            expect(
              requests,
              `snapshot connection: ${client.getSnapshot().connection}`,
            ).toHaveLength(supported ? 1 : 0),
          { timeout: 1000 },
        );
        expect(client.getSnapshot().session).toBe("authenticated");
        const other = { kind: "profile" as const, profileId: createId("browserProfile") };
        client.prepareBrowserProfile(other);
        await client.refresh();
        client.prepareBrowserProfile(identity);
        await vi.waitFor(() => expect(requests).toHaveLength(supported ? 2 : 0), { timeout: 1000 });
      } finally {
        pending.resolve(json({ type: "browser.profile.prepare" }));
        client.dispose();
      }
    },
  );
});

describe("HttpHostClient authentication and onboarding", () => {
  it("projects, clears, and tolerates an absent authenticated session surface", async () => {
    const remoteBootstrap = { ...bootstrap([]), sessionSurface: "personal-remote" as const };
    let authenticated = true;
    const remote = createHttpHostClient({
      fetch: async (input) => {
        const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
        if (path === "/v1/rpc/auth.config") return json(remoteBootstrap.identityConfig);
        return authenticated ? json(remoteBootstrap) : json({ error: unauthorizedError() }, 401);
      },
      refreshIntervalMs: 0,
    });
    await remote.load();
    expect(remote.getSnapshot().sessionSurface).toBe("personal-remote");

    authenticated = false;
    await remote.refresh();
    expect(remote.getSnapshot()).toMatchObject({
      session: "authentication-required",
      sessionSurface: null,
    });
    remote.dispose();

    const legacy = createHttpHostClient({
      fetch: async () => json(bootstrap([])),
      refreshIntervalMs: 0,
    });
    await legacy.load();
    expect(legacy.getSnapshot().sessionSurface).toBeNull();
    legacy.dispose();
  });

  it("spends a password-recovery capability without retaining it or the new password", async () => {
    const token = `olpr_${"A".repeat(43)}`;
    const newPassword = "new password that must not persist";
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      expect(path).toBe("/v1/rpc/auth.password.recover");
      expect(init?.credentials).toBe("include");
      expect(JSON.parse(String(init?.body))).toEqual({ newPassword, token });
      return json({ reset: true });
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({ fetch, refreshIntervalMs: 0 });

    await client.rpc["auth.password.recover"]({ newPassword, token });
    expect(JSON.stringify(client)).not.toContain(token);
    expect(JSON.stringify(client)).not.toContain(newPassword);
    client.dispose();
  });

  it("creates a bounded local Runner enrollment without retaining its token", async () => {
    const token = "local-runner-one-use-token-with-sufficient-entropy";
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      expect(path).toBe("/v1/rpc/commands.dispatch");
      expect(JSON.parse(String(init?.body))).toEqual({
        allowedModules: ["agents"],
        idempotencyKey: "desktop-local-runner:test",
        name: "Test computer",
        type: "runner.enrollment.createLocal",
      });
      return json({
        enrollmentId: "ren_test-computer",
        expiresAt: "2026-08-09T20:10:00.000Z",
        token,
      });
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({ fetch, refreshIntervalMs: 0 });

    await expect(
      client.dispatch({
        allowedModules: ["agents"],
        idempotencyKey: "desktop-local-runner:test",
        name: "Test computer",
        type: "runner.enrollment.createLocal",
      }),
    ).resolves.toMatchObject({
      enrollmentId: "ren_test-computer",
      expiresAt: "2026-08-09T20:10:00.000Z",
      token,
    });
    expect(JSON.stringify(client)).not.toContain(token);
    client.dispose();
  });

  it("consumes first-owner setup without retaining the enrollment or password", async () => {
    const setupToken = "host-setup-secret-that-must-not-persist";
    const password = "correct-horse";
    const requests: Array<{
      body: string | null;
      credentials: RequestCredentials | undefined;
      path: string;
    }> = [];
    let authenticated = false;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push({
        body: typeof init?.body === "string" ? init.body : null,
        credentials: init?.credentials,
        path: url.pathname,
      });
      if (url.pathname === "/v1/rpc/auth.config") {
        return json({
          deployment: { cloud: false, kind: "self-hosted" as const, name: null },
          emailDeliveryAvailable: false,
          localPasswordEnabled: true,
          machineOwner: false,
          oidcProviders: [],
          passkeysEnabled: false,
          exposure: "loopback",
          portalOrigin: null,
          publicOrigin: "http://localhost:43100",
          setupState: "required",
          signupPolicy: "invite-only",
        });
      }
      if (url.pathname === "/v1/rpc/auth.setup.exchange") {
        expect(JSON.parse(String(init?.body))).toEqual({ token: setupToken });
        return json({ admitted: true });
      }
      if (url.pathname === "/v1/rpc/auth.setup.claim") {
        // No display name: the Host derives one from the address.
        expect(JSON.parse(String(init?.body))).toEqual({
          email: "alex@example.com",
          kind: "password",
          password,
        });
        authenticated = true;
        return json({ session: authenticatedSession() });
      }
      if (!authenticated) return json({ error: unauthorizedError() }, 401);
      return json(bootstrap([]));
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({ fetch, refreshIntervalMs: 0 });

    await client.load();
    expect(client.getSnapshot().session).toBe("authentication-required");

    await client.rpc["auth.setup.exchange"]({ token: setupToken });
    await client.rpc["auth.setup.claim"]({ email: "alex@example.com", kind: "password", password });
    await client.refresh();

    expect(client.getSnapshot()).toMatchObject({
      connection: "connected",
      ownerName: "Alex",
      session: "authenticated",
      workspaces: [],
    });
    // Claiming is a single call, so there is no window in which the account
    // exists while the Host is still unclaimed.
    expect(requests.map((request) => request.path)).toEqual([
      "/v1/rpc/bootstrap.get",
      "/v1/rpc/auth.config",
      "/v1/rpc/auth.setup.exchange",
      "/v1/rpc/auth.setup.claim",
      "/v1/rpc/bootstrap.get",
    ]);
    expect(requests.every((request) => request.credentials === "include")).toBe(true);
    expect(JSON.stringify(client)).not.toContain(setupToken);
    expect(JSON.stringify(client)).not.toContain(password);
    client.dispose();
  });

  it("re-reads a Host session that was restored outside the client", async () => {
    let authenticated = false;
    const paths: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      paths.push(url.pathname);
      if (url.pathname === "/v1/rpc/auth.config") {
        return json({
          deployment: { cloud: false, kind: "self-hosted" as const, name: null },
          emailDeliveryAvailable: false,
          exposure: "networked",
          localPasswordEnabled: false,
          machineOwner: false,
          oidcProviders: [{ id: "workos", label: "SSO", type: "oidc" }],
          passkeysEnabled: false,
          portalOrigin: null,
          publicOrigin: "https://opensteer.example",
          setupState: "complete",
          signupPolicy: "invite-only",
        });
      }
      if (!authenticated) return json({ error: unauthorizedError() }, 401);
      return json(bootstrap([]));
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({ fetch, refreshIntervalMs: 0 });

    await client.load();
    expect(client.getSnapshot().session).toBe("authentication-required");

    // Desktop main opened a Host session of its own; the latched client stopped
    // polling, so only an explicit re-authentication can observe it.
    authenticated = true;
    await client.reauthenticate();

    expect(client.getSnapshot()).toMatchObject({
      connection: "connected",
      session: "authenticated",
    });
    expect(paths).toEqual([
      "/v1/rpc/bootstrap.get",
      "/v1/rpc/auth.config",
      "/v1/rpc/bootstrap.get",
    ]);
    client.dispose();
  });

  it("recovers a selected group outside bootstrap and retains it across bounded rereads", async () => {
    const workspace = makeWorkspace();
    const groupId = createBrowserSessionId();
    const sessionId = createBrowserSessionId();
    const tabId = BrowserSurfaceIdSchema.parse("surface_old-selected");
    const group: WorkspaceTabLineage = {
      id: groupId,
      revision: 1,
      createdAt: now,
      session: {
        id: sessionId,
        access: "full-control",
        createdAt: now,
        updatedAt: now,
        origin: "workspace",
        placement: { kind: "runner", runnerId },
        profileId: null,
        runtimeId: "test",
        state: "failed",
        workspaceId: workspace.id,
      },
      tabs: [
        {
          kind: "browser",
          id: tabId,
          sessionId,
          title: "Old selected tab",
          site: "https://example.test",
          order: 0,
          openerId: null,
          state: "suspended",
        },
      ],
    };
    const browser: HostedBrowserBootstrap = {
      available: true,
      workspaceTabRestoreVersion: 1,
      workspaceTabs: [],
      profiles: [],
      placements: [],
      profileGrants: [],
      sessions: [],
    };
    const reads: string[] = [];
    const client = createHttpHostClient({
      refreshIntervalMs: 0,
      webSocketFactory: () => new FakeSocket(),
      fetch: async (input, init) => {
        const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
        if (path === "/v1/rpc/workspace.tabs.get") {
          reads.push(String(rpcPayload(new URL(input.toString()), init).groupId));
          return json(group);
        }
        return json(bootstrap([workspace], browser));
      },
    });
    try {
      await client.load();
      expect(client.getSnapshot().workspaceTabs).toEqual([]);
      expect(typeof client.readWorkspaceTabs).toBe("function");
      expect(await client.readWorkspaceTabs(sessionId)).toEqual(group);
      expect(client.getSnapshot().workspaceTabs).toEqual([group]);
      await client.refresh();
      expect(client.getSnapshot().workspaceTabs).toEqual([group]);
      expect(reads).toContain(sessionId);
    } finally {
      client.dispose();
    }
  });
  // Failure mode: a pending move materializes the old tab set, so a lineage read
  // inserts its new tab beside the moved opener instead of replaying the move.
  it("replays a pending move with tabs learned before the layout acknowledgement", async () => {
    const workspace = makeWorkspace();
    const sessionId = createBrowserSessionId();
    const [a, b, c, d] = ["a", "b", "c", "d"].map((id) =>
      BrowserSurfaceIdSchema.parse(`surface_pending_${id}`),
    );
    const lineage: WorkspaceTabLineage = {
      id: sessionId,
      revision: 1,
      createdAt: now,
      session: {
        id: sessionId,
        access: "full-control",
        createdAt: now,
        updatedAt: now,
        origin: "workspace",
        placement: { kind: "runner", runnerId },
        profileId: null,
        runtimeId: "test",
        state: "failed",
        workspaceId: workspace.id,
      },
      tabs: [a!, b!, c!].map((id, order) => ({
        kind: "browser",
        id,
        sessionId,
        title: id,
        site: "",
        order,
        openerId: null,
        state: "suspended",
        createdAt: now,
      })),
    };
    const browser: HostedBrowserBootstrap = {
      available: true,
      workspaceTabRestoreVersion: 1,
      workspaceTabs: [lineage],
      tabGroupsVersion: 1,
      tabGroups: { revision: 1, groups: [], order: [] },
      profiles: [],
      placements: [],
      profileGrants: [],
      sessions: [],
    };
    const newer: WorkspaceTabLineage = {
      ...lineage,
      revision: 2,
      tabs: [
        ...lineage.tabs!,
        {
          kind: "browser",
          id: d!,
          sessionId,
          title: "New child",
          site: "",
          order: 3,
          openerId: c!,
          state: "suspended",
          createdAt: now,
        },
      ],
    };
    let acknowledge: (response: Response) => void = () => {
      throw new Error("No pending command");
    };
    const client = createHttpHostClient({
      refreshIntervalMs: 0,
      webSocketFactory: () => new FakeSocket(),
      fetch: async (input) => {
        const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
        if (path === "/v1/rpc/commands.dispatch")
          return new Promise<Response>((resolve) => {
            acknowledge = resolve;
          });
        if (path === "/v1/rpc/workspace.tabs.get") return json(newer);
        return json(bootstrap([workspace], browser));
      },
    });
    let pending: Promise<void> | undefined;
    try {
      await client.load();
      pending = client.moveBrowserTabs({
        item: { tabIds: [c!] },
        to: { groupId: null, before: { tabId: a! } },
      });
      await client.readWorkspaceTabs(sessionId);
      const snapshot = client.getSnapshot();
      expect(
        browserTabStrip(placeList(snapshot), snapshot.browserTabGroups)
          .ordered.filter((p) => p.kind === "browser")
          .map((p) => p.workspaceTab!.id),
      ).toEqual([c, a, b, d]);
    } finally {
      acknowledge(
        json({
          type: "workspace.tabs.move",
          layout: { revision: 2, order: [c, a, b, d], groups: [] },
        }),
      );
      await pending;
      client.dispose();
    }
  });
  // Failure modes: a delayed command restores a closed member at the refresh's revision;
  // rejecting equal-revision refreshes instead leaves visibility changes stale.
  it("keeps an equal-revision refresh when an older command acknowledgement arrives later", async () => {
    const workspace = makeWorkspace();
    const a = BrowserSurfaceIdSchema.parse("surface_delayed-a");
    const b = BrowserSurfaceIdSchema.parse("surface_delayed-b");
    const group = {
      id: BrowserTabGroupIdSchema.parse(`btg_${crypto.randomUUID()}`),
      title: "Reading",
      color: "blue" as const,
      collapsed: false,
      tabIds: [a, b],
    };
    const browser: HostedBrowserBootstrap = {
      available: true,
      profiles: [],
      placements: [],
      profileGrants: [],
      sessions: [],
      tabGroupsVersion: 1,
      tabGroups: { revision: 1, groups: [group] },
    };
    let acknowledge: (response: Response) => void = () => {
      throw new Error("No pending command");
    };
    const client = createHttpHostClient({
      refreshIntervalMs: 0,
      webSocketFactory: () => new FakeSocket(),
      fetch: async (input) => {
        const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
        if (path === "/v1/rpc/commands.dispatch")
          return new Promise<Response>((resolve) => {
            acknowledge = resolve;
          });
        return json(bootstrap([workspace], browser));
      },
    });
    try {
      await client.load();
      const pending = client.updateBrowserTabGroup(group.id, { title: "Renamed" });
      await vi.waitFor(() =>
        expect(client.getSnapshot().browserTabGroups?.groups[0]?.title).toBe("Renamed"),
      );
      const committed = { revision: 2, groups: [{ ...group, title: "Renamed" }] };
      browser.tabGroups = { revision: 2, groups: [{ ...committed.groups[0]!, tabIds: [b] }] };
      await client.refresh();
      expect(client.getSnapshot().browserTabGroups?.groups[0]?.tabIds).toEqual([b]);
      acknowledge(json({ type: "workspace.tabGroup.update", layout: committed }));
      await pending;
      expect(client.getSnapshot().browserTabGroups?.groups[0]?.tabIds).toEqual([b]);
      browser.tabGroups = { revision: 2, groups: [] };
      await client.refresh();
      expect(client.getSnapshot().browserTabGroups?.groups).toEqual([]);
    } finally {
      client.dispose();
    }
  });
  // Failure modes: a batch close invents a live catalog revision, changes unrelated
  // lineages, or requests a redundant bootstrap instead of using the Host notice.
  it("batch close updates only durable membership and leaves catalog reconciliation to Host notices", async () => {
    const workspace = makeWorkspace();
    const sessionId = createBrowserSessionId();
    const tabId = BrowserSurfaceIdSchema.parse("surface_batch-close");
    const lineage: WorkspaceTabLineage = {
      id: sessionId,
      revision: 1,
      createdAt: now,
      session: {
        id: sessionId,
        access: "full-control",
        createdAt: now,
        updatedAt: now,
        origin: "workspace",
        placement: { kind: "runner", runnerId },
        profileId: null,
        runtimeId: "test",
        state: "failed",
        workspaceId: workspace.id,
      },
      tabs: [
        {
          kind: "browser",
          id: tabId,
          sessionId,
          title: "Closing",
          site: "https://example.test",
          order: 0,
          openerId: null,
          state: "suspended",
        },
      ],
    };
    const browser: HostedBrowserBootstrap = {
      available: true,
      workspaceTabRestoreVersion: 1,
      workspaceTabs: [lineage],
      profiles: [],
      placements: [],
      profileGrants: [],
      sessions: [],
    };
    const calls: string[] = [];
    const client = createHttpHostClient({
      refreshIntervalMs: 0,
      webSocketFactory: () => new FakeSocket(),
      fetch: async (input) => {
        const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
        calls.push(path);
        if (path === "/v1/rpc/commands.dispatch")
          return json({ type: "workspace.tabs.close", closed: [tabId], failed: [] });
        return json(bootstrap([workspace], browser));
      },
    });
    try {
      await client.load();
      const before = client.getSnapshot();
      expect(await client.closeWorkspaceTabs([tabId])).toMatchObject({
        closed: [tabId],
        failed: [],
      });
      expect(client.getSnapshot().browserSessions).toBe(before.browserSessions);
      expect(client.getSnapshot().workspaceTabs?.[0]).toMatchObject({ revision: 1, tabs: [] });
      expect(calls.filter((path) => path === "/v1/rpc/bootstrap.get")).toHaveLength(1);
    } finally {
      client.dispose();
    }
  });
  it("creates the first durable Workspace and immediately opens its realtime channel", async () => {
    const workspace = makeWorkspace("Client work");
    const sockets: FakeSocket[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/v1/rpc/bootstrap.get") return json(bootstrap([]));
      expect(path).toBe("/v1/rpc/commands.dispatch");
      expect(JSON.parse(String(init?.body))).toEqual({
        idempotencyKey: "workspace:test",
        name: "Client work",
        type: "workspace.create",
      });
      return json({ workspace }, 201);
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    await client.load();
    const created = await client.dispatch({
      idempotencyKey: "workspace:test",
      name: "Client work",
      type: "workspace.create",
    });

    expect(created).toMatchObject({ workspace: { name: "Client work", status: "ready" } });
    expect(client.getSnapshot().workspaces).toHaveLength(1);
    expect(sockets).toHaveLength(1);
    sockets[0]?.open();
    expect(parseSent(sockets[0]!, 0)).toMatchObject({
      afterSequence: "0",
      // The realtime stream negotiates the same epoch the rpc header states.
      apiVersion: hostApiVersion,
      type: "client.subscribe",
      workspaceId: workspace.id,
    });
    client.dispose();
  });

  it("retries storage through the Host and projects the returned Workspace state", async () => {
    const unavailable = {
      ...makeWorkspace("Client work"),
      status: "unavailable" as const,
      storageIssue: {
        code: "manager-unavailable" as const,
        message: "Storage is offline.",
        occurredAt: now,
        retryable: true,
      },
    };
    const ready = { ...unavailable, status: "ready" as const, storageIssue: null };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/v1/rpc/bootstrap.get") return json(bootstrap([unavailable]));
      expect(path).toBe("/v1/rpc/commands.dispatch");
      return json({ workspace: ready });
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      webSocketFactory: () => new FakeSocket(),
    });

    await client.load();
    const result = await client.dispatch({
      idempotencyKey: "workspace-storage:test",
      type: "workspace.storage.retry",
      workspaceId: unavailable.id,
    });

    expect(result).toMatchObject({ workspace: { status: "ready", storageIssue: null } });
    expect(client.getSnapshot().workspaces[0]).toMatchObject({
      status: "ready",
      storageIssue: null,
    });
    client.dispose();
  });

  it("sends the execution tuple it was given and remembers it once the Host accepts", async () => {
    const workspace = makeWorkspace("Placement work");
    const localEnvironmentId = createId("environment");
    const localRunnerId = createId("runner");
    const codexHarnessId = createId("harnessInstance");
    const payload = {
      ...bootstrap([workspace]),
      environments: [
        {
          capabilities: ["filesystem"],
          connected: true,
          harnessAuthenticationAllowed: true,
          workspaceBackings: ["local-directory"],
          harnessCatalogs: [
            {
              continuationIdentity: {
                continuationKey: "runner:v1:XBFO4gDBdSg2fXioCLyTd-RGpc_Zcz838BvyfVUY5d0",
                driverKind: "claude",
              },
              driverKind: "claude",
              harnessInstanceId: codexHarnessId,
              models: [
                {
                  displayName: "Claude Sonnet",
                  isDefault: true,
                  modelId: "sonnet",
                  options: [],
                  providerId: "anthropic",
                },
              ],
              status: "ready",
            },
          ],
          harnessDrivers: [
            {
              accessModes: [...ThreadAccessModeSchema.options],
              driverKind: "claude",
              readiness: "runtime-check" as const,
              sources: [
                {
                  fields: [],
                  kind: "first-party",
                  label: "Anthropic",
                  quota: "none",
                  sourceId: "anthropic",
                  stateKinds: ["ambient", "isolated"],
                },
              ],
            },
          ],
          providerStateModes: ["ambient", "isolated"] as const,
          id: localEnvironmentId,
          kind: "local" as const,
          name: "Alex’s Mac",
          runnerId: localRunnerId,
          status: "connected" as const,
        },
        {
          capabilities: ["filesystem"],
          connected: true,
          harnessAuthenticationAllowed: true,
          workspaceBackings: ["local-directory"],
          harnessCatalogs: [codexCatalog(harnessInstanceId)],
          harnessDrivers: [
            {
              accessModes: [...ThreadAccessModeSchema.options],
              driverKind: "codex",
              readiness: "runtime-check" as const,
              sources: [
                {
                  fields: [],
                  kind: "first-party",
                  label: "OpenAI",
                  quota: "windows",
                  sourceId: "openai",
                  stateKinds: ["ambient", "isolated"],
                },
              ],
            },
          ],
          providerStateModes: ["ambient", "isolated"] as const,
          id: environmentId,
          kind: "main" as const,
          name: "Main runner",
          runnerId,
          status: "connected" as const,
        },
      ],
      harnesses: [
        {
          config: { model: "gpt-5.6-sol" },
          driverKind: "codex",
          enabled: true,
          environmentId,
          id: harnessInstanceId,
          isDefault: true,
          name: "Codex",
          runtimeRevision: 1,
          sourceId: "openai",
          stateKind: "ambient" as const,
        },
        {
          config: {},
          driverKind: "claude",
          enabled: true,
          environmentId: localEnvironmentId,
          id: codexHarnessId,
          isDefault: true,
          name: "Claude Code",
          runtimeRevision: 1,
          sourceId: "anthropic",
          stateKind: "ambient" as const,
        },
      ],
    };
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/v1/rpc/bootstrap.get") return json(payload);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> & {
        environmentId: Thread["environmentId"];
        harnessInstanceId: Thread["harnessInstanceId"];
        modelSelection: Thread["modelSelection"];
        selection?: ExecutionSelection;
      };
      bodies.push(body);
      if (body.type === "execution.preferences.remember") {
        return json({
          preferences: {
            accessMode: body.accessMode ?? "auto",
            history: body.selection ? [body.selection] : [],
          },
        });
      }
      return json(
        {
          thread: {
            ...makeThread(workspace.id),
            environmentId: body.environmentId,
            harnessInstanceId: body.harnessInstanceId,
            modelSelection: body.modelSelection,
          },
          wasDuplicate: false,
        },
        201,
      );
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({ fetch, refreshIntervalMs: 0 });
    await client.load();

    const modelSelection = ModelSelectionSchema.parse({
      modelId: "sonnet",
      options: {},
      providerId: "anthropic",
    });
    await client.createThread({
      accessMode: "full-access",
      environmentId: localEnvironmentId,
      harnessInstanceId: codexHarnessId,
      modelSelection,
      workspaceId: workspace.id,
    });

    expect(bodies).toEqual([
      expect.objectContaining({
        accessMode: "full-access",
        environmentId: localEnvironmentId,
        harnessInstanceId: codexHarnessId,
        modelSelection,
        type: "thread.create",
      }),
      expect.objectContaining({
        accessMode: "full-access",
        selection: {
          environmentId: localEnvironmentId,
          harnessInstanceId: codexHarnessId,
          modelSelection,
        },
        type: "execution.preferences.remember",
      }),
    ]);
    expect(client.getSnapshot().executionPreferences).toEqual({
      accessMode: "full-access",
      history: [
        { environmentId: localEnvironmentId, harnessInstanceId: codexHarnessId, modelSelection },
      ],
    });
    client.dispose();
  });

  it("rejects a bootstrap response without the required work location status", async () => {
    const workspace = makeWorkspace("Strict contract");
    const attached = bootstrap([workspace]);
    const invalid = {
      ...attached,
      environments: attached.environments.map(({ status: _status, ...environment }) => environment),
    };
    const client = createHttpHostClient({
      fetch: async () => json(invalid),
      refreshIntervalMs: 0,
      webSocketFactory: () => new FakeSocket(),
    });

    await expect(client.load()).rejects.toThrow(/incompatible response/u);
    client.dispose();
  });

  it("takes the Host's word on who may sign in a work location, over the instance role", async () => {
    const workspace = makeWorkspace("Bound cloud");
    const attached = bootstrap([workspace]);
    const payload = {
      ...attached,
      environments: [
        // Bound to this person: theirs to sign in even though the Host says
        // they are not an instance administrator.
        {
          ...attached.environments[0],
          harnessAuthenticationAllowed: true,
          workspaceBackings: ["local-directory"],
          id: createId("environment"),
          kind: "managed" as const,
          name: "Their managed Runner",
        },
        // Someone else's, on the same instance.
        {
          ...attached.environments[0],
          harnessAuthenticationAllowed: false,
          workspaceBackings: ["local-directory"],
          id: createId("environment"),
          kind: "managed" as const,
          name: "Another managed Runner",
        },
      ],
      user: { ...attached.user, instanceRole: "user" as const },
    };
    const client = createHttpHostClient({
      fetch: async () => json(payload),
      refreshIntervalMs: 0,
      webSocketFactory: () => new FakeSocket(),
    });

    await client.load();

    expect(
      client.getSnapshot().environments.map(({ harnessAuthenticationAllowed, name }) => ({
        harnessAuthenticationAllowed,
        name,
      })),
    ).toEqual([
      { harnessAuthenticationAllowed: true, name: "Their managed Runner" },
      { harnessAuthenticationAllowed: false, name: "Another managed Runner" },
    ]);
    client.dispose();
  });

  it("rejects a bootstrap response without an explicit sign-in permission", async () => {
    const workspace = makeWorkspace("Strict permission");
    const attached = bootstrap([workspace]);
    const invalid = {
      ...attached,
      environments: attached.environments.map(
        ({ harnessAuthenticationAllowed: _allowed, ...environment }) => environment,
      ),
    };
    const client = createHttpHostClient({
      fetch: async () => json(invalid),
      refreshIntervalMs: 0,
      webSocketFactory: () => new FakeSocket(),
    });

    await expect(client.load()).rejects.toThrow(/incompatible response/u);
    client.dispose();
  });

  it("remembers the account and model a Thread was moved onto", async () => {
    const workspace = makeWorkspace("Switch account");
    const thread = makeThread(workspace.id);
    const otherHarnessId = createId("harnessInstance");
    const sockets: FakeSocket[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/v1/rpc/bootstrap.get") return json(bootstrap([workspace]));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> & {
        selection?: ExecutionSelection;
      };
      bodies.push(body);
      if (body.type === "execution.preferences.remember") {
        return json({
          preferences: { accessMode: "auto", history: body.selection ? [body.selection] : [] },
        });
      }
      return json({
        thread: { ...thread, harnessInstanceId: otherHarnessId },
      });
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: { ...workspaceSnapshot(workspace, "0"), threads: [thread] },
      type: "host.snapshot",
    });
    const updated = await client.updateThreadExecution(thread.id, {
      harnessInstanceId: otherHarnessId,
      modelSelection: thread.modelSelection,
    });

    expect(updated.harnessInstanceId).toBe(otherHarnessId);
    expect(bodies.map((body) => body.type)).toEqual([
      "thread.execution.update",
      "execution.preferences.remember",
    ]);
    // The Thread keeps its own work location; only the account and model move.
    expect(bodies[1]?.selection).toEqual({
      environmentId: thread.environmentId,
      harnessInstanceId: otherHarnessId,
      modelSelection: thread.modelSelection,
    });
    expect(client.getSnapshot().executionPreferences.history).toHaveLength(1);
    client.dispose();
  });

  it("keeps a Thread mutation that succeeded when remembering it fails", async () => {
    const workspace = makeWorkspace("Quiet remember");
    const thread = makeThread(workspace.id);
    const sockets: FakeSocket[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/v1/rpc/bootstrap.get") return json(bootstrap([workspace]));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.type === "execution.preferences.remember") {
        return json({ error: { code: "internal", message: "no", retryable: true } }, 500);
      }
      return json({ thread: { ...thread, accessMode: "approval-required" } });
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: { ...workspaceSnapshot(workspace, "0"), threads: [thread] },
      type: "host.snapshot",
    });

    await expect(client.updateThreadAccess(thread.id, "approval-required")).resolves.toMatchObject({
      accessMode: "approval-required",
    });
    expect(client.getSnapshot().executionPreferences).toEqual(emptyExecutionPreferences);
    client.dispose();
  });

  it("reads a bootstrap without remembered choices as nothing remembered", async () => {
    const workspace = makeWorkspace("Older Host");
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      refreshIntervalMs: 0,
      webSocketFactory: () => new FakeSocket(),
    });

    await client.load();

    expect(client.getSnapshot().executionPreferences).toEqual(emptyExecutionPreferences);
    client.dispose();
  });
});

describe("HttpHostClient harness authentication", () => {
  it("rejects an envelope without the environment status rather than guessing one", async () => {
    const fetch = vi.fn(async () =>
      json({ authentication: { status: "not-started" } }),
    ) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({ fetch, refreshIntervalMs: 0 });

    await expect(
      client.rpc["harness.authentication.get"]({ environmentId, harnessInstanceId }),
    ).resolves.toMatchObject({ ok: false });
    client.dispose();
  });
});

describe("HttpHostClient durable realtime", () => {
  it("routes viewer-wide history notices to the history cache", async () => {
    const workspace = makeWorkspace();
    const socket = new FakeSocket();
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      refreshIntervalMs: 0,
      webSocketFactory: () => socket,
    });
    try {
      await client.load();
      socket.open();
      socket.receive({ snapshot: workspaceSnapshot(workspace, "0"), type: "host.snapshot" });
      const changed = vi.spyOn(client.browserHistory, "changed");
      const profileId = createId("browserProfile");
      socket.receive({ type: "host.browser-history-changed", profileId });
      expect(changed).toHaveBeenCalledExactlyOnceWith(profileId);
    } finally {
      client.dispose();
    }
  });

  it("invalidates Trigger reads when a program-only occurrence changes", async () => {
    const workspace = makeWorkspace();
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const listener = vi.fn();
    client.subscribe(listener);

    await client.load();
    sockets[0]!.open();
    sockets[0]!.receive({ snapshot: workspaceSnapshot(workspace, "0"), type: "host.snapshot" });
    const before = client.getSnapshot().triggerRevision;
    sockets[0]!.receive({ type: "host.triggers-changed", workspaceId: workspace.id });

    expect(client.getSnapshot().triggerRevision).toBe(before + 1);
    expect(listener).toHaveBeenCalled();
    client.dispose();
  });

  it.each([true, false])(
    "holds every open child however long the history, without paging settled history (family %s)",
    async (family) => {
      const workspace = makeWorkspace();
      const thread = makeThread(workspace.id);
      const mock = new MockHostClient({ latencyMs: 0 });
      const seed = Object.values(mock.getSnapshot().assignments).find((a) => a.status === "open")!;
      const older = { ...seed, parentThreadId: thread.id };
      const recent = Array.from({ length: 100 }, () => ({
        ...older,
        id: createId("delegation"),
        status: "completed" as const,
        finishedAt: now,
      }));
      const reads: { readonly open: unknown; readonly before: unknown }[] = [];
      const client = createHttpHostClient({
        capabilities: family ? ["task-family-v1"] : [],
        refreshIntervalMs: 0,
        webSocketFactory: () => new FakeSocket(),
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.pathname === "/v1/rpc/thread.assignments.list") {
            const payload = rpcPayload(url, init);
            reads.push({ open: payload.open, before: payload.before });
            // The open set spans two pages; history has more than the newest page.
            const assignments = payload.open ? (payload.before ? [older] : []) : recent;
            const more = payload.open ? !payload.before : true;
            return json({
              assignments,
              threadId: thread.id,
              window: {
                byteCount: 1,
                hasMore: more,
                itemCount: assignments.length,
                nextBefore: more ? "older" : null,
                totalItems: 101,
              },
            });
          }
          return json({ ...bootstrap([workspace]), threads: [thread] });
        },
      });
      await client.load();
      client.observeThread(thread.id);
      await vi.waitFor(() => expect(reads).toHaveLength(family ? 3 : 1), { timeout: 1000 });
      await vi.waitFor(
        () =>
          expect(Object.keys(client.getSnapshot().assignments)).toHaveLength(family ? 101 : 100),
        { timeout: 1000 },
      );
      expect(reads.filter(({ open }) => open === undefined)).toEqual([
        { open: undefined, before: undefined },
      ]);
      expect(client.getSnapshot().assignments[older.id] !== undefined).toBe(family);
      client.dispose();
      mock.dispose();
    },
  );

  it.each([true, false])(
    "loads task automations only with capability (%s), coalescing notices and preserving unchanged arrays",
    async (enabled) => {
      const workspace = makeWorkspace();
      const thread = makeThread(workspace.id);
      const socket = new FakeSocket();
      const mock = new MockHostClient({ latencyMs: 0 });
      const listed = await mock.rpc["triggers.list"]({});
      if (!listed.ok) throw new Error(listed.error.message);
      const triggers = listed.data.triggers
        .filter((t) => t.kind === "schedule" && t.status === "active")
        .slice(0, 1);
      let reads = 0;
      let hold: ReturnType<typeof Promise.withResolvers<Response>> | undefined;
      const client = createHttpHostClient({
        capabilities: enabled ? ["task-family-v1"] : [],
        refreshIntervalMs: 0,
        webSocketFactory: () => socket,
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.pathname === "/v1/rpc/triggers.list") {
            reads++;
            expect(rpcPayload(url, init)).toEqual({ anchorThreadId: thread.id });
            return hold ? hold.promise : json({ triggers });
          }
          return json(bootstrap([workspace]));
        },
      });
      await client.load();
      socket.open();
      socket.receive({
        type: "host.snapshot",
        snapshot: { ...workspaceSnapshot(workspace, "0"), threads: [thread] },
      });
      client.observeThread(thread.id);
      if (!enabled) {
        socket.receive({ type: "host.triggers-changed", workspaceId: workspace.id });
        await client.refresh();
        expect(reads).toBe(0);
      } else {
        await vi.waitFor(
          () => expect(client.getSnapshot().threadAutomations[thread.id]).toHaveLength(1),
          { timeout: 1000 },
        );
        const held = client.getSnapshot().threadAutomations[thread.id];
        hold = Promise.withResolvers<Response>();
        socket.receive({ type: "host.triggers-changed", workspaceId: workspace.id });
        socket.receive({ type: "host.triggers-changed", workspaceId: workspace.id });
        socket.receive({ type: "host.triggers-changed", workspaceId: workspace.id });
        expect(reads).toBe(2);
        const answer = hold;
        hold = undefined;
        answer.resolve(json({ triggers }));
        await vi.waitFor(() => expect(reads).toBe(3), { timeout: 1000 });
        expect(client.getSnapshot().threadAutomations[thread.id]).toBe(held);
        socket.receive({
          type: "host.snapshot",
          snapshot: { ...workspaceSnapshot(workspace, "1"), threads: [thread] },
        });
        await vi.waitFor(() => expect(reads).toBe(4), { timeout: 1000 });
      }
      client.dispose();
      mock.dispose();
    },
  );

  it("reads a conversation's automations afresh when it is opened again, after a failure, and after a replayed reconnect", async () => {
    const workspace = makeWorkspace();
    const a = makeThread(workspace.id);
    const b = makeThread(workspace.id);
    const mock = new MockHostClient({ latencyMs: 0 });
    const listed = await mock.rpc["triggers.list"]({});
    if (!listed.ok) throw new Error(listed.error.message);
    const trigger = listed.data.triggers.find((t) => t.kind === "schedule")!;
    const reads: string[] = [];
    let fail = false;
    let gate: Promise<void> | null = null;
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      capabilities: ["task-family-v1"],
      random: () => 0,
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 2,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/v1/rpc/triggers.list") {
          const anchor = String(rpcPayload(url, init).anchorThreadId);
          reads.push(anchor);
          if (gate !== null && anchor === a.id) {
            const held = gate;
            gate = null;
            await held;
          }
          if (fail) return json({ error: { code: "internal", message: "down" } }, 500);
          // Named for the read that answered, so a test can see which one it holds.
          return json({
            triggers:
              anchor === a.id
                ? [{ ...trigger, anchorThreadId: a.id, name: `Read ${reads.length}` }]
                : [],
          });
        }
        return json(bootstrap([workspace]));
      },
    });
    await client.load();
    sockets[0]!.open();
    sockets[0]!.receive({
      type: "host.snapshot",
      snapshot: { ...workspaceSnapshot(workspace, "0"), threads: [a, b] },
    });
    sockets[0]!.receive({
      sequence: sequence("0"),
      type: "host.synchronized",
      workspaceId: workspace.id,
    });
    const held = () => client.getSnapshot().threadAutomations[a.id]?.[0]?.name;
    const holds = async (name: string) =>
      vi.waitFor(() => expect(held(), `holds ${name}`).toBe(name), { timeout: 1000 });

    client.activateThread(a.id);
    await holds("Read 1");
    // Opened again after another conversation: read afresh.
    client.activateThread(b.id);
    client.activateThread(a.id);
    await vi.waitFor(() => expect(held()).toMatch(/^Read [2-9]/u), { timeout: 1000 });

    // A failed read keeps what was held and is retried when it is opened again.
    const readsOfA = () => reads.filter((id) => id === a.id).length;
    const beforeFailure = readsOfA();
    fail = true;
    client.activateThread(b.id);
    client.activateThread(a.id);
    await vi.waitFor(() => expect(readsOfA(), "the failing read").toBe(beforeFailure + 1), {
      timeout: 1000,
    });
    const failed = reads.length;
    expect(held()).toMatch(/^Read /u);
    fail = false;
    await vi.waitFor(
      () => {
        client.activateThread(b.id);
        client.activateThread(a.id);
        expect(Number(held()?.slice(5))).toBeGreaterThan(failed);
      },
      { timeout: 1000 },
    );

    // Opened again while a read from before is still out: that answer may
    // predate a change made meanwhile, so one more read follows it.
    const release = Promise.withResolvers<void>();
    gate = release.promise;
    const beforeReopen = readsOfA();
    client.activateThread(b.id);
    client.activateThread(a.id);
    await vi.waitFor(() => expect(readsOfA(), "the held read").toBe(beforeReopen + 1), {
      timeout: 1000,
    });
    client.activateThread(b.id);
    client.activateThread(a.id);
    release.resolve();
    await vi.waitFor(() => expect(readsOfA(), "the read after it").toBe(beforeReopen + 2), {
      timeout: 1000,
    });

    // A triggers notice lost while away is recovered when the stream replays.
    const before = held();
    sockets[0]!.serverClose();
    await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 1000 });
    sockets[1]!.open();
    sockets[1]!.receive({
      sequence: sequence("0"),
      type: "host.synchronized",
      workspaceId: workspace.id,
    });
    await vi.waitFor(() => expect(held()).not.toBe(before), { timeout: 1000 });
    client.dispose();
    mock.dispose();
  });

  it("loads conversation browser facts separately and preserves other scopes across bootstrap", async () => {
    const workspace = makeWorkspace();
    const sessionId = createBrowserSessionId();
    const a = createId("thread");
    const b = createId("thread");
    const sessions = [
      {
        access: "full-control" as const,
        createdAt: now,
        id: sessionId,
        origin: "agent" as const,
        placement: { kind: "runner" as const, runnerId },
        profileId: null,
        runtimeId: "runtime",
        state: "ready" as const,
        updatedAt: now,
        workspaceId: workspace.id,
      },
    ];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith("thread.browserUsage.get")) {
        const payload = rpcPayload(url, init);
        expect((payload.runIds as unknown[]).length).toBeLessThanOrEqual(16);
        return json({
          threadId: payload.threadId,
          uses: [
            {
              sessionId,
              threadId: payload.threadId,
              runId: null,
              tabId: null,
              firstUsedAt: now,
              lastUsedAt: now,
            },
          ],
        });
      }
      return json(
        bootstrap([workspace], {
          profileGrants: [],
          available: true,
          placements: [],
          profiles: [],
          sessions,
        }),
      );
    };
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      browserUsageReads: "observed",
    });
    await client.load();
    client.activateThread(a);
    await vi.waitFor(() =>
      expect(client.getSnapshot().browserSessions[0]?.uses?.some((use) => use.threadId === a)).toBe(
        true,
      ),
    );
    client.activateThread(b);
    await vi.waitFor(() =>
      expect(client.getSnapshot().browserSessions[0]?.uses?.some((use) => use.threadId === b)).toBe(
        true,
      ),
    );
    await client.refresh();
    expect(
      client
        .getSnapshot()
        .browserSessions[0]?.uses?.map((use) => use.threadId)
        .sort(),
    ).toEqual([a, b].sort());
    client.dispose();
  });

  it("carries one count-only summary after repeated loads recreate the client", async () => {
    const diagnostics = new BootstrapReadDiagnostics();
    const trigger = vi
      .spyOn(bootstrapReadDiagnostics, "trigger")
      .mockImplementation(diagnostics.trigger.bind(diagnostics));
    const start = vi
      .spyOn(bootstrapReadDiagnostics, "start")
      .mockImplementation(diagnostics.start.bind(diagnostics));
    const take = vi
      .spyOn(bootstrapReadDiagnostics, "takeSummary")
      .mockImplementation(diagnostics.takeSummary.bind(diagnostics));
    const summaries: (string | null)[] = [];
    try {
      for (let index = 0; index < 12; index++) {
        const client = createHttpHostClient({
          refreshIntervalMs: 0,
          webSocketFactory: () => new FakeSocket(),
          fetch: async (input, init) => {
            const request = new Request(input, init);
            if (new URL(request.url).pathname.endsWith("bootstrap.get"))
              summaries.push(request.headers.get(bootstrapDiagnosticHeader));
            return json(bootstrap([]));
          },
        });
        try {
          await client.load();
        } finally {
          client.dispose();
        }
      }
      expect(summaries).toHaveLength(12);
      expect(summaries.filter(Boolean)).toHaveLength(1);
      expect(JSON.parse(summaries[5]!)).toEqual({
        windowMs: expect.any(Number),
        triggers: { load: 6 },
        starts: { load: 6 },
      });
      expect(summaries.slice(0, 5)).toEqual(Array(5).fill(null));
      expect(summaries.slice(6)).toEqual(Array(6).fill(null));
    } finally {
      trigger.mockRestore();
      start.mockRestore();
      take.mockRestore();
    }
  });

  it.each(["host.browser-sessions-changed", "host.machines.changed"] as const)(
    "refreshes thread-visible bootstrap state on %s without a mounted Computers page",
    async (noticeType) => {
      const workspace = makeWorkspace();
      const sessionId = createBrowserSessionId();
      const now = new Date().toISOString();
      const sockets: FakeSocket[] = [];
      const sessions = [
        {
          access: "full-control" as const,
          createdAt: now,
          id: sessionId,
          origin: "agent" as const,
          placement: { kind: "runner" as const, runnerId },
          profileId: null,
          runtimeId: "runtime-1",
          state: "ready" as const,
          updatedAt: now,
          workspaceId: workspace.id,
        },
      ];
      // The agent's browser is only on the second read: the announcement is what
      // brings it forward, not the poll.
      let opened = false;
      const fetch = vi.fn(async () =>
        json(
          bootstrap([workspace], {
            profileGrants: [],
            available: true,
            placements: [],
            profiles: [],
            sessions: opened ? sessions : [],
          }),
        ),
      ) as unknown as typeof globalThis.fetch;
      const client = createHttpHostClient({
        fetch,
        refreshIntervalMs: 0,
        webSocketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      });

      await client.load();
      sockets[0]!.open();
      sockets[0]!.receive({ snapshot: workspaceSnapshot(workspace, "0"), type: "host.snapshot" });
      expect(client.getSnapshot().browserSessions).toEqual([]);

      opened = true;
      sockets[0]!.receive({
        type: noticeType,
        workspaceId:
          noticeType === "host.browser-sessions-changed" ? createId("workspace") : workspace.id,
      });
      await vi.waitUntil(() => client.getSnapshot().browserSessions.length === 1);

      expect(client.getSnapshot().browserSessions[0]).toMatchObject({
        id: sessionId,
        state: "ready",
      });
      client.dispose();
    },
  );

  it("refreshes the engine catalog after an older bootstrap has finished", async () => {
    let release!: () => void;
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let reads = 0;
    const client = createHttpHostClient({
      refreshIntervalMs: 0,
      webSocketFactory: () => new FakeSocket(),
      fetch: async () => {
        reads += 1;
        if (reads !== 2) return json(bootstrap([]));
        // A read taken after catalog discard but before inspection commits.
        const stale = bootstrap([]);
        stale.environments[0]!.harnessCatalogs = [];
        return new Promise<Response>((resolve) => {
          release = () => resolve(json(stale));
          entered();
        });
      },
    });
    try {
      await client.load();
      const olderRead = client.load();
      await withTimeout(reading, 1_000, {
        timeoutError: () =>
          new Error("The overlapping bootstrap did not reach its stale catalog read"),
      });
      // The CLI inspection has now committed. Its caller needs a new read,
      // even though the earlier bootstrap has not delivered its answer yet.
      const refreshed = client.refresh();
      release();
      await Promise.all([olderRead, refreshed]);
      expect(client.getSnapshot().environments[0]?.harnessCatalogs[0]?.status).toBe("ready");
      expect(reads).toBe(3);
    } finally {
      client.dispose();
    }
  });

  it("answers a notice that lands mid-read with exactly one more read", async () => {
    const workspace = makeWorkspace();
    const sessionId = createBrowserSessionId();
    const now = new Date().toISOString();
    const sockets: FakeSocket[] = [];
    const session = (state: "ready" | "starting") => ({
      access: "full-control" as const,
      createdAt: now,
      id: sessionId,
      origin: "agent" as const,
      placement: { kind: "runner" as const, runnerId },
      profileId: null,
      runtimeId: "runtime-1",
      state,
      updatedAt: now,
      workspaceId: workspace.id,
    });
    // Every read waits until the test releases it, so a notice can arrive
    // while one is still in flight. The Host's truth advances per read:
    // nothing, then starting, then ready.
    const releases: (() => void)[] = [];
    let reads = 0;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          reads += 1;
          const read = reads;
          releases.push(() =>
            resolve(
              json(
                bootstrap([workspace], {
                  profileGrants: [],
                  available: true,
                  placements: [],
                  profiles: [],
                  sessions:
                    read >= 3 ? [session("ready")] : read === 2 ? [session("starting")] : [],
                }),
              ),
            ),
          );
        }),
    ) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const loaded = client.load();
    await vi.waitUntil(() => releases.length === 1);
    releases.shift()!();
    await loaded;
    sockets[0]!.open();
    sockets[0]!.receive({ snapshot: workspaceSnapshot(workspace, "0"), type: "host.snapshot" });

    const triggers = vi.spyOn(bootstrapReadDiagnostics, "trigger");
    const starts = vi.spyOn(bootstrapReadDiagnostics, "start");
    // Starting: one read begins. Ready lands twice while it is still out.
    sockets[0]!.receive({ type: "host.browser-sessions-changed", workspaceId: workspace.id });
    await vi.waitUntil(() => releases.length === 1);
    sockets[0]!.receive({ type: "host.browser-sessions-changed", workspaceId: workspace.id });
    sockets[0]!.receive({ type: "host.browser-sessions-changed", workspaceId: workspace.id });
    expect(reads).toBe(2);

    releases.shift()!();
    await vi.waitUntil(() => client.getSnapshot().browserSessions[0]?.state === "starting");
    // The two notices that arrived mid-read collapse into one follow-up read.
    await vi.waitUntil(() => releases.length === 1);
    expect(reads).toBe(3);
    releases.shift()!();
    await vi.waitUntil(() => client.getSnapshot().browserSessions[0]?.state === "ready");

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toBe(3);
    expect(triggers.mock.calls.map(([reason]) => reason)).toEqual([
      "host.browser-sessions-changed",
      "host.browser-sessions-changed",
      "host.browser-sessions-changed",
    ]);
    expect(starts.mock.calls.map(([reason]) => reason)).toEqual([
      "host.browser-sessions-changed",
      "host.browser-sessions-changed",
    ]);
    triggers.mockRestore();
    starts.mockRestore();
    client.dispose();
  });

  it("leaves a notice for the foreground while the app is hidden", async () => {
    const workspace = makeWorkspace();
    const sessionId = createBrowserSessionId();
    const now = new Date().toISOString();
    const platform = fakeLifecycle({ network: "online", visibility: "foreground" });
    const sockets: FakeSocket[] = [];
    let reads = 0;
    const client = createHttpHostClient({
      fetch: async () => {
        reads += 1;
        return json(
          bootstrap([workspace], {
            profileGrants: [],
            available: true,
            placements: [],
            profiles: [],
            sessions:
              reads > 1
                ? [
                    {
                      access: "full-control" as const,
                      createdAt: now,
                      id: sessionId,
                      origin: "agent" as const,
                      placement: { kind: "runner" as const, runnerId },
                      profileId: null,
                      runtimeId: "runtime-1",
                      state: "ready" as const,
                      updatedAt: now,
                      workspaceId: workspace.id,
                    },
                  ]
                : [],
          }),
        );
      },
      lifecycle: platform.lifecycle,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    await client.load();
    sockets[0]!.open();
    sockets[0]!.receive({ snapshot: workspaceSnapshot(workspace, "0"), type: "host.snapshot" });
    expect(reads).toBe(1);

    platform.enterBackground();
    sockets[0]!.receive({ type: "host.browser-sessions-changed", workspaceId: workspace.id });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Nobody is looking, so nothing is fetched for them.
    expect(reads).toBe(1);
    expect(client.getSnapshot().browserSessions).toEqual([]);

    // The return already rereads; the notice needs nothing of its own.
    platform.enterForeground();
    await vi.waitUntil(() => client.getSnapshot().browserSessions.length === 1);
    expect(reads).toBe(2);
    client.dispose();
  });

  it("hydrates the explicit Main home when a specialized Workspace is more recent", async () => {
    const main = makeWorkspace("Opensteer");
    const specialized = {
      ...makeWorkspace("Gmail Briefing"),
      kind: "specialized" as const,
      updatedAt: "2026-08-09T20:01:00.000Z",
    };
    const mainThread = makeThread(main.id);
    const sockets: FakeSocket[] = [];
    const payload = bootstrap([specialized]);
    const client = createHttpHostClient({
      fetch: async () =>
        json({
          ...payload,
          homeWorkspace: main,
          workspaceWindow: { ...payload.workspaceWindow, hasMore: true, totalItems: 2 },
        }),
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    await client.load();

    expect(client.getSnapshot().homeWorkspaceId).toBe(main.id);
    expect(client.getSnapshot().workspaces.map(({ id }) => id)).toEqual([main.id, specialized.id]);
    // The supplemental Home entry does not exhaust the authoritative catalog cursor.
    expect(client.getSnapshot().workspaceWindow.hasMore).toBe(true);
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    expect(parseSent(sockets[0]!, 0)).toMatchObject({
      type: "client.subscribe",
      workspaceId: main.id,
    });

    sockets[0]!.receive({
      snapshot: {
        ...workspaceSnapshot(main, "1"),
        threads: [mainThread],
        threadWindow: {
          byteCount: new TextEncoder().encode(JSON.stringify([mainThread])).byteLength,
          hasMore: false,
          itemCount: 1,
          nextBefore: null,
          totalItems: 1,
        },
      },
      type: "host.snapshot",
    });
    expect(client.getSnapshot().threads.map(({ id }) => id)).toEqual([mainThread.id]);
    client.dispose();
  });

  it("paginates the Workspace catalog without opening a socket for every loaded Workspace", async () => {
    const recent = [makeWorkspace("Recent A"), makeWorkspace("Recent B")];
    const older = makeWorkspace("Older");
    const sockets: FakeSocket[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/rpc/workspace.catalog.list") {
        expect(rpcPayload(url, undefined).before).toBe("workspace_cursor");
        return json({
          window: {
            byteCount: new TextEncoder().encode(JSON.stringify([older])).byteLength,
            hasMore: false,
            itemCount: 1,
            nextBefore: null,
            totalItems: 3,
          },
          workspaces: [older],
        });
      }
      return json({
        ...bootstrap(recent),
        workspaceWindow: {
          byteCount: new TextEncoder().encode(JSON.stringify(recent)).byteLength,
          hasMore: true,
          itemCount: 2,
          nextBefore: "workspace_cursor",
          totalItems: 3,
        },
      });
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    await client.load();
    expect(sockets).toHaveLength(1);
    await client.loadEarlierWorkspaces();
    expect(client.getSnapshot().workspaces.map(({ id }) => id)).toEqual([
      ...recent.map(({ id }) => id),
      older.id,
    ]);
    expect(sockets).toHaveLength(1);
    client.activateWorkspace(older.id);
    expect(sockets).toHaveLength(2);
    client.dispose();
  });

  it("debounces active Workspace prefetch and shows restore progress", async () => {
    vi.useFakeTimers();
    const workspace = {
      ...makeWorkspace("Archived workspace"),
      restoreProgressPermille: 437,
      status: "provisioning" as const,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/rpc/workspace.prefetch") {
        return new Response(null, { status: 204 });
      }
      return json(bootstrap([workspace]));
    });
    const client = createHttpHostClient({
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      refreshIntervalMs: 0,
    });

    await client.load();
    expect(client.getSnapshot().workspaces[0]?.description).toBe("Waking… (43%)");
    client.activateWorkspace(workspace.id);
    client.activateWorkspace(workspace.id);
    await vi.advanceTimersByTimeAsync(150);

    expect(
      fetchMock.mock.calls.filter(
        ([input]) => new URL(String(input)).pathname === "/v1/rpc/workspace.prefetch",
      ),
    ).toHaveLength(1);
    client.dispose();
  });

  it("restores a pending Request from a zero-cursor snapshot", async () => {
    const workspace = makeWorkspace();
    const thread = {
      ...makeThread(workspace.id),
      pendingRequests: 1,
      status: "waiting" as const,
    };
    const runId = createId("run");
    const pending = pendingRequest({
      presentation: {
        fields: [{ id: "choice", multiSelect: false, prompt: "Which option?", secret: false }],
        kind: "form",
        title: "Input needed",
      },
      runId,
      threadId: thread.id,
      workspaceId: workspace.id,
    });
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    sockets[0]!.open();
    sockets[0]!.receive({
      snapshot: {
        ...workspaceSnapshot(workspace, "2"),
        pendingRequests: [pending],
        pendingRequestWindow: {
          byteCount: new TextEncoder().encode(JSON.stringify([pending])).byteLength,
          hasMore: false,
          itemCount: 1,
          nextBefore: null,
          totalItems: 1,
        },
        threads: [thread],
        threadWindow: {
          byteCount: new TextEncoder().encode(JSON.stringify([thread])).byteLength,
          hasMore: false,
          itemCount: 1,
          nextBefore: null,
          totalItems: 1,
        },
      },
      type: "host.snapshot",
    });

    expect(client.getSnapshot().requests[thread.id]).toEqual([
      expect.objectContaining({ id: pending.id, originatingRunId: runId }),
    ]);
    client.dispose();
  });

  it("follows the pending-only Request cursor until every pending item is reachable", async () => {
    const workspace = makeWorkspace();
    const thread = { ...makeThread(workspace.id), pendingRequests: 2 };
    const first = pendingRequest({
      presentation: { kind: "external", subject: { id: "one", kind: "test" }, title: "One" },
      runId: createId("run"),
      threadId: thread.id,
      workspaceId: workspace.id,
    });
    const second = pendingRequest({
      presentation: { kind: "external", subject: { id: "two", kind: "test" }, title: "Two" },
      runId: createId("run"),
      threadId: thread.id,
      workspaceId: workspace.id,
    });
    const requestPages: Readonly<Record<string, unknown>>[] = [];
    const sockets: FakeSocket[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/rpc/thread.requests.list") {
        const request = rpcPayload(url, undefined);
        requestPages.push(request);
        const older = request.before === "request_cursor";
        return json({
          requests: [older ? second : first],
          threadId: thread.id,
          window: {
            byteCount: 256,
            hasMore: !older,
            itemCount: 1,
            nextBefore: older ? null : "request_cursor",
            totalItems: 2,
          },
        });
      }
      if (url.pathname === "/v1/rpc/thread.events.list") {
        return json({
          thread,
          events: [],
          threadId: thread.id,
          window: {
            byteCount: 2,
            hasMore: false,
            itemCount: 0,
            nextBefore: null,
            threadId: thread.id,
            totalItems: 0,
          },
        });
      }
      return json(bootstrap([workspace]));
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    sockets[0]!.open();
    sockets[0]!.receive({
      snapshot: {
        ...workspaceSnapshot(workspace, "2"),
        threads: [thread],
        threadWindow: {
          byteCount: 128,
          hasMore: false,
          itemCount: 1,
          nextBefore: null,
          totalItems: 1,
        },
      },
      type: "host.snapshot",
    });

    client.activateThread(thread.id);
    await vi.waitFor(() => expect(client.getSnapshot().requests[thread.id]).toHaveLength(2));

    expect(client.getSnapshot().requests[thread.id]?.map(({ id }) => id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(requestPages).toEqual([
      { limit: 100, threadId: thread.id },
      { before: "request_cursor", limit: 100, threadId: thread.id },
    ]);
    client.dispose();
  });

  it("removes a provider-cancelled Request when the canonical cancellation event arrives", async () => {
    const workspace = makeWorkspace();
    const thread = {
      ...makeThread(workspace.id),
      pendingRequests: 1,
      status: "waiting" as const,
    };
    const runId = createId("run");
    const pending = pendingRequest({
      presentation: {
        detail: "Run a delegated check",
        kind: "choice",
        options: [{ hint: "allow-once", id: "allow", label: "Allow" }],
        title: "Worker permission",
      },
      runId,
      threadId: thread.id,
      workspaceId: workspace.id,
    });
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    client.activateThread(thread.id);
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: {
        ...workspaceSnapshot(workspace, "0"),
        pendingRequests: [pending],
        pendingRequestWindow: {
          byteCount: new TextEncoder().encode(JSON.stringify([pending])).byteLength,
          hasMore: false,
          itemCount: 1,
          nextBefore: null,
          totalItems: 1,
        },
        threads: [thread],
        threadWindow: {
          byteCount: new TextEncoder().encode(JSON.stringify([thread])).byteLength,
          hasMore: false,
          itemCount: 1,
          nextBefore: null,
          totalItems: 1,
        },
      },
      type: "host.snapshot",
    });

    socket.receive({
      events: [
        agentEvent(workspace.id, thread.id, runId, "1", "request.cancelled", {
          requestId: pending.id,
          reason: "source-closed",
        }),
        agentEvent(workspace.id, thread.id, null, "2", "thread.state-changed", {
          status: "running",
          inputQueuePaused: false,
          pendingRequests: 0,
        }),
      ],
      type: "host.events",
    });
    expect(client.getSnapshot().requests[thread.id]).toEqual([]);
    expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(0);
    expect(client.getSnapshot().transcripts[thread.id]).toEqual([
      expect.objectContaining({
        kind: "request",
        outcome: "Cancelled · source-closed",
        requestId: pending.id,
      }),
    ]);
    client.dispose();
  });

  it.each([true, false])(
    "loads an older durable message window through its continuation cursor (turn pages %s)",
    async (turnPages) => {
      const workspace = makeWorkspace();
      const thread = makeThread(workspace.id);
      const recent = makeMessage(thread.id, "assistant", "Recent");
      const internalResult: Message = {
        ...recent,
        content: [{ text: 'Delegated Thread result\n{"outcome":"completed"}', type: "text" }],
        id: createId("message"),
        kind: "run-result",
        sequence: SequenceSchema.parse("2"),
      };
      const earlier = makeMessage(thread.id, "input", "Earlier");
      const sockets: FakeSocket[] = [];
      const requestedUrls: string[] = [];
      const eventRequests: Record<string, unknown>[] = [];
      const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requestedUrls.push(String(input));
        const path = new URL(String(input)).pathname;
        if (path === "/v1/rpc/thread.events.list") {
          eventRequests.push(rpcPayload(new URL(String(input)), init));
          return json({
            thread,
            events: [
              agentEvent(workspace.id, thread.id, earlier.runId, "1", "message.created", {
                input: makeThreadInput(earlier),
                message: earlier,
              }),
            ],
            threadId: thread.id,
            window: {
              byteCount: 256,
              hasMore: false,
              itemCount: 1,
              nextBefore: null,
              threadId: thread.id,
              totalItems: 2,
            },
          });
        }
        return json(bootstrap([workspace]));
      }) as unknown as typeof globalThis.fetch;
      const client = createHttpHostClient({
        capabilities: async () => (turnPages ? ["history-turns-v1"] : []),
        fetch,
        refreshIntervalMs: 0,
        webSocketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      });
      await client.load();
      const socket = sockets[0]!;
      socket.open();
      socket.receive({
        snapshot: {
          ...workspaceSnapshot(workspace, "2"),
          messages: [recent, internalResult],
          messageWindows: [
            {
              byteCount: 256,
              hasMore: true,
              itemCount: 1,
              nextBefore: "message_cursor",
              threadId: thread.id,
              totalItems: 2,
            },
          ],
          threads: [thread],
        },
        type: "host.snapshot",
      });

      await client.loadEarlierTranscript(thread.id);

      expect(
        client
          .getSnapshot()
          .transcripts[thread.id]?.filter((entry) => entry.kind === "message")
          .map((entry) => entry.body),
      ).toEqual(["Earlier", "Recent"]);
      expect(client.getSnapshot().transcriptWindows[thread.id]?.hasMore).toBe(false);
      expect(requestedUrls).toEqual(
        expect.arrayContaining([expect.stringContaining("message_cursor")]),
      );
      expect(eventRequests).toEqual([
        { before: "message_cursor", threadId: thread.id, ...(turnPages ? { turns: 10 } : {}) },
      ]);
      client.dispose();
    },
  );

  describe("earlier visible history", () => {
    async function setupHistory(
      options: {
        role?: "conversation" | "work";
        turnPages?: boolean;
        steps?: boolean;
        exhausted?: boolean;
        stuck?: boolean;
        holdSecond?: boolean;
        holdFirst?: boolean;
        empty?: boolean;
        folded?: boolean;
        /** The newest page starts inside a Run a steer split, so no Run entry heads its first trace. */
        cut?: boolean;
        longScan?: boolean;
        shown?: "active" | "observed";
      } = {},
    ) {
      const workspace = makeWorkspace();
      const thread = { ...makeThread(workspace.id), role: options.role ?? "conversation" };
      const recent = {
        ...makeMessage(thread.id, options.folded || options.cut ? "assistant" : "input", "Recent"),
        runId: options.folded || options.cut ? createId("run") : null,
      };
      const steer = { ...makeMessage(thread.id, "input", "Steer"), runId: recent.runId };
      const earlier = makeMessage(thread.id, "input", "Earlier question");
      const reply = {
        ...makeMessage(thread.id, "assistant", "Earlier reply"),
        runId: earlier.runId,
      };
      const silentRun = createId("run");
      const startedBy = { cause: "task-return", kind: "platform" as const };
      const silent = [
        agentEvent(workspace.id, thread.id, silentRun, "4", "run.started", {
          status: "running",
          startedBy,
        }),
        agentEvent(workspace.id, thread.id, silentRun, "5", "run.completed", {
          status: "completed",
          replyMessageId: null,
        }),
      ];
      const visible = [
        agentEvent(workspace.id, thread.id, earlier.runId, "1", "message.created", {
          input: makeThreadInput(earlier),
          message: earlier,
        }),
        agentEvent(workspace.id, thread.id, earlier.runId, "2", "message.created", {
          input: null,
          message: reply,
        }),
        agentEvent(workspace.id, thread.id, earlier.runId, "3", "run.completed", {
          status: "completed",
          replyMessageId: reply.id,
        }),
      ];
      const firstAsked = Promise.withResolvers<void>();
      const firstAnswer = Promise.withResolvers<void>();
      const secondAsked = Promise.withResolvers<void>();
      const secondAnswer = Promise.withResolvers<void>();
      const requests: Record<string, unknown>[] = [];
      let viewerId = ownerId;
      let warming =
        options.empty === true ||
        options.folded === true ||
        options.cut === true ||
        options.shown !== undefined;
      const socket = new FakeSocket();
      const client = createHttpHostClient({
        capabilities: options.turnPages === false ? [] : ["history-turns-v1"],
        fetch: async (input, init) => {
          const url = new URL(String(input));
          if (url.pathname !== "/v1/rpc/thread.events.list") {
            const boot = bootstrap([workspace]);
            return json({ ...boot, user: { ...boot.user, id: viewerId } });
          }
          const request = rpcPayload(url, init);
          if (request.threadId !== thread.id)
            return json({
              thread: { ...thread, id: ThreadIdSchema.parse(request.threadId) },
              threadId: request.threadId,
              events: [],
              window: {
                byteCount: 0,
                itemCount: 0,
                totalItems: 0,
                hasMore: false,
                nextBefore: null,
                threadId: request.threadId,
              },
            });
          if (warming) {
            warming = false;
            const events = options.empty
              ? []
              : options.cut
                ? [
                    agentEvent(workspace.id, thread.id, recent.runId, "3", "reasoning.completed", {
                      blockId: "cut-step",
                      text: "Work before the steer",
                    }),
                    agentEvent(workspace.id, thread.id, recent.runId, "4", "message.created", {
                      input: makeThreadInput(steer),
                      message: steer,
                    }),
                    agentEvent(workspace.id, thread.id, recent.runId, "5", "run.completed", {
                      status: "completed",
                      replyMessageId: recent.id,
                    }),
                    agentEvent(workspace.id, thread.id, recent.runId, "6", "message.created", {
                      input: null,
                      message: recent,
                    }),
                  ]
                : [
                    ...(options.folded
                      ? [
                          agentEvent(workspace.id, thread.id, recent.runId, "5", "run.completed", {
                            status: "completed",
                            replyMessageId: recent.id,
                          }),
                        ]
                      : []),
                    agentEvent(workspace.id, thread.id, recent.runId, "6", "message.created", {
                      input: null,
                      message: recent,
                    }),
                  ];
            return json({
              thread,
              threadId: thread.id,
              events,
              window: {
                byteCount: 0,
                itemCount: 0,
                totalItems: 6,
                threadId: thread.id,
                hasMore: true,
                nextBefore: "recent",
              },
            });
          }
          requests.push(request);
          const first = requests.length === 1;
          if (first && options.holdFirst) {
            firstAsked.resolve();
            await firstAnswer.promise;
          }
          if (requests.length === 2 && options.holdSecond) {
            secondAsked.resolve();
            await secondAnswer.promise;
          }
          const navigating = !request.before;
          const events = navigating
            ? visible
            : options.longScan && !first
              ? []
              : first
                ? options.steps || options.folded || options.cut
                  ? [
                      agentEvent(
                        workspace.id,
                        thread.id,
                        options.folded || options.cut ? recent.runId : silentRun,
                        "4",
                        "reasoning.completed",
                        {
                          blockId: "older-step",
                          text: "Older work without a reply",
                        },
                      ),
                    ]
                  : silent
                : options.exhausted
                  ? []
                  : visible;
          return json({
            thread,
            threadId: thread.id,
            events,
            window: {
              byteCount: 256,
              itemCount: events.length,
              totalItems: 6,
              threadId: thread.id,
              hasMore:
                !navigating &&
                (first || (options.longScan ? requests.length < 5 : options.holdSecond === true)),
              nextBefore: navigating
                ? null
                : first
                  ? options.stuck
                    ? "recent"
                    : "silent"
                  : options.holdSecond
                    ? `oldest-${requests.length}`
                    : null,
            },
          });
        },
        refreshIntervalMs: 0,
        webSocketFactory: () => socket,
      });
      await client.load();
      socket.open();
      socket.receive({
        type: "host.snapshot",
        snapshot: {
          ...workspaceSnapshot(workspace, "6"),
          threads: [thread],
          messages: options.empty ? [] : [recent],
          messageWindows: [
            {
              byteCount: 256,
              hasMore: true,
              itemCount: 1,
              nextBefore: "recent",
              totalItems: 6,
              threadId: thread.id,
            },
          ],
        },
      });
      let release: (() => void) | undefined;
      if (warming) {
        await client.loadLatestTranscript(thread.id);
        if (options.shown === "observed") release = client.observeThread(thread.id);
        else client.activateThread(thread.id);
      }
      return {
        leave: () =>
          options.shown === "observed" ? release?.() : client.activateThread(createId("thread")),
        client,
        requests,
        thread,
        firstAsked,
        firstAnswer,
        secondAsked,
        secondAnswer,
        receiveHuman: () =>
          socket.receive({
            type: "host.events",
            events: [
              agentEvent(workspace.id, thread.id, null, "7", "message.created", {
                input: makeThreadInput(recent),
                message: { ...recent, sequence: sequence("7") },
              }),
            ],
          }),
        changeViewer: async () => {
          viewerId = createId("user");
          await client.refresh();
        },
        replaceWindow: (nextBefore: string) =>
          socket.receive({
            type: "host.snapshot",
            snapshot: {
              ...workspaceSnapshot(workspace, "7"),
              threads: [thread],
              messages: [recent],
              messageWindows: [
                {
                  byteCount: 256,
                  hasMore: true,
                  itemCount: 1,
                  nextBefore,
                  totalItems: 6,
                  threadId: thread.id,
                },
              ],
            },
          }),
        removeThread: () =>
          socket.receive({ type: "host.snapshot", snapshot: workspaceSnapshot(workspace, "7") }),
      };
    }

    it.each([
      [true, false],
      [false, false],
      [true, true],
      [false, true],
    ])(
      "reads past an invisible Chat page in one call (turn pages %s, only steps %s)",
      async (turnPages, steps) => {
        const { client, requests, thread } = await setupHistory({ turnPages, steps });
        try {
          await client.loadEarlierTranscript(thread.id);
          expect(requests.map((request) => request.before)).toEqual(["recent", "silent"]);
          const rows = conversationRows(
            groupTranscriptEntries(
              visibleTranscript(client.getSnapshot().transcripts[thread.id] ?? [], null, {
                conversation: true,
              }),
            ),
            { live: false, atComputer: () => false },
          );
          expect(
            rows.map(({ group }) =>
              group.kind === "turn"
                ? group.turn.reply?.body
                : group.kind === "message"
                  ? group.entry.body
                  : null,
            ),
          ).toEqual(["Earlier question", "Earlier reply", "Recent"]);
        } finally {
          client.dispose();
        }
      },
    );

    it("does not count a live human message as older-page progress", async () => {
      const f = await setupHistory({ empty: true, holdFirst: true });
      try {
        const loading = f.client.loadEarlierTranscript(f.thread.id);
        await withTimeout(f.firstAsked.promise, 1000, {
          timeoutError: () => new Error("The first page was never requested."),
        });
        f.receiveHuman();
        await vi.waitFor(
          () =>
            expect(
              f.client
                .getSnapshot()
                .transcripts[f.thread.id]?.some(
                  (entry) => entry.kind === "message" && entry.body === "Recent",
                ),
            ).toBe(true),
          { timeout: 1000 },
        );
        f.firstAnswer.resolve();
        await loading;
        expect(f.requests.map(({ before }) => before)).toEqual(["recent", "silent"]);
      } finally {
        f.firstAnswer.resolve();
        f.client.dispose();
      }
    });

    it.each([true, false])(
      "reads past a byte-cut page folded into the first drawn work turn (turn pages %s)",
      async (turnPages) => {
        const f = await setupHistory({ role: "work", folded: true, turnPages });
        try {
          await f.client.loadEarlierTranscript(f.thread.id);
          expect(f.requests.map(({ before }) => before)).toEqual(["recent", "silent"]);
        } finally {
          f.client.dispose();
        }
      },
    );

    it.each(["around", "latest"] as const)(
      "retires a long scan to load %s after its in-flight page",
      async (destination) => {
        const f = await setupHistory({ holdSecond: true, longScan: true });
        try {
          const loading = f.client.loadEarlierTranscript(f.thread.id);
          await withTimeout(f.secondAsked.promise, 1000, {
            timeoutError: () => new Error("The second page was never requested."),
          });
          const navigation =
            destination === "around"
              ? f.client.loadTranscriptAround(f.thread.id, createId("message"))
              : f.client.loadLatestTranscript(f.thread.id);
          f.secondAnswer.resolve();
          await withTimeout(Promise.all([loading, navigation]), 1000, {
            timeoutError: () => new Error("Navigation waited beyond the in-flight page."),
          });
          expect(f.requests.map(({ before }) => before)).toEqual(["recent", "silent", undefined]);
        } finally {
          f.secondAnswer.resolve();
          f.client.dispose();
        }
      },
    );

    it.each(["active", "observed"] as const)(
      "stops when the reader leaves the %s Thread",
      async (shown) => {
        const f = await setupHistory({ shown, holdSecond: true, longScan: true });
        try {
          const loading = f.client.loadEarlierTranscript(f.thread.id);
          await withTimeout(f.secondAsked.promise, 1000, {
            timeoutError: () => new Error("The second page was never requested."),
          });
          f.leave();
          const before = f.client.getSnapshot().transcripts[f.thread.id];
          f.secondAnswer.resolve();
          await loading;
          expect(f.requests.map(({ before }) => before)).toEqual(["recent", "silent"]);
          expect(f.client.getSnapshot().transcripts[f.thread.id]).toBe(before);
        } finally {
          f.secondAnswer.resolve();
          f.client.dispose();
        }
      },
    );

    it("keeps scanning an observed Thread when another Thread becomes active", async () => {
      const f = await setupHistory({ shown: "observed", holdSecond: true, longScan: true });
      try {
        const loading = f.client.loadEarlierTranscript(f.thread.id);
        await withTimeout(f.secondAsked.promise, 1000, {
          timeoutError: () => new Error("The second page was never requested."),
        });
        f.client.activateThread(createId("thread"));
        f.secondAnswer.resolve();
        await loading;
        expect(f.requests.length).toBeGreaterThan(2);
      } finally {
        f.secondAnswer.resolve();
        f.client.dispose();
      }
    });

    it("reads past older steps that only rename a split Run's first trace", async () => {
      const { client, requests, thread } = await setupHistory({ cut: true, role: "work" });
      try {
        await client.loadEarlierTranscript(thread.id);
        expect(requests).toHaveLength(2);
      } finally {
        client.dispose();
      }
    });

    it("starts afresh when asked again after its scan was retired", async () => {
      const f = await setupHistory({ shown: "active", holdSecond: true, longScan: true });
      try {
        const loading = f.client.loadEarlierTranscript(f.thread.id);
        await withTimeout(f.secondAsked.promise, 1000, {
          timeoutError: () => new Error("The second page was never requested."),
        });
        f.leave();
        f.client.activateThread(f.thread.id);
        const again = f.client.loadEarlierTranscript(f.thread.id);
        f.secondAnswer.resolve();
        await Promise.all([loading, again]);
        expect(f.requests.length).toBeGreaterThan(2);
      } finally {
        f.secondAnswer.resolve();
        f.client.dispose();
      }
    });

    it("exhausts an entirely invisible remainder", async () => {
      const { client, requests, thread } = await setupHistory({ exhausted: true });
      try {
        await client.loadEarlierTranscript(thread.id);
        expect(requests).toHaveLength(2);
        expect(client.getSnapshot().transcriptWindows[thread.id]?.hasMore).toBe(false);
      } finally {
        client.dispose();
      }
    });

    it("stops at the first added work trace", async () => {
      const { client, requests, thread } = await setupHistory({ role: "work" });
      try {
        await client.loadEarlierTranscript(thread.id);
        expect(requests).toHaveLength(1);
      } finally {
        client.dispose();
      }
    });

    it("rejects a continuation cursor that does not advance", async () => {
      const { client, thread } = await setupHistory({ stuck: true });
      try {
        await expect(client.loadEarlierTranscript(thread.id)).rejects.toThrow(
          "continuation cursor",
        );
      } finally {
        client.dispose();
      }
    });

    it.each(["replacement", "silent"])(
      "stops if a snapshot replaces the window during a read (cursor %s)",
      async (cursor) => {
        const { client, requests, thread, secondAsked, secondAnswer, replaceWindow } =
          await setupHistory({ holdSecond: true });
        try {
          const loading = client.loadEarlierTranscript(thread.id);
          await withTimeout(secondAsked.promise, 1000, {
            timeoutError: () => new Error("The continuation was never requested."),
          });
          replaceWindow(cursor);
          secondAnswer.resolve();
          await loading;
          expect(requests.map(({ before }) => before)).toEqual(["recent", "silent"]);
          expect(client.getSnapshot().transcriptWindows[thread.id]?.nextBefore).toBe(cursor);
        } finally {
          secondAnswer.resolve();
          client.dispose();
        }
      },
    );

    it.each(["dispose", "viewer", "thread"] as const)(
      "stops a pending page after %s changes",
      async (change) => {
        const { client, requests, thread, secondAsked, secondAnswer, changeViewer, removeThread } =
          await setupHistory({ holdSecond: true });
        try {
          const loading = client.loadEarlierTranscript(thread.id);
          const concurrent = client.loadEarlierTranscript(thread.id);
          await withTimeout(secondAsked.promise, 1000, {
            timeoutError: () => new Error("The invisible page never requested its continuation."),
          });
          expect(client.getSnapshot().transcriptWindows[thread.id]?.nextBefore).toBe("silent");
          expect(
            client.getSnapshot().transcripts[thread.id]?.some((entry) => entry.kind === "run"),
          ).toBe(true);
          if (change === "dispose") client.dispose();
          else if (change === "viewer") await changeViewer();
          else removeThread();
          const before = client.getSnapshot().transcripts[thread.id];
          secondAnswer.resolve();
          await Promise.all([loading, concurrent]);
          expect(requests).toHaveLength(2);
          expect(client.getSnapshot().transcripts[thread.id]).toBe(before);
        } finally {
          secondAnswer.resolve();
          client.dispose();
        }
      },
    );
  });

  /*
   * History is read over HTTP while the realtime channel keeps delivering. A
   * status the Host published after the history was read must survive the
   * history replacing the Thread's summary; the Host sends no second status
   * event while the status stays the same, so a stale one would stick.
   */
  it("keeps a status the Host published while the Thread's history was loading", async () => {
    const workspace = makeWorkspace();
    const thread = { ...makeThread(workspace.id), status: "running" as const };
    const runId = createId("run");
    let answerHistory!: () => void;
    const historyRequested = new Promise<void>((resolve) => {
      answerHistory = resolve;
    });
    let historyAsked!: () => void;
    const askedForHistory = new Promise<void>((resolve) => {
      historyAsked = resolve;
    });
    const sockets: FakeSocket[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/rpc/thread.requests.list") {
        return json({ nextCursor: null, requests: [], threadId: thread.id });
      }
      if (url.pathname === "/v1/rpc/thread.events.list") {
        historyAsked();
        await historyRequested;
        return json({
          events: [
            agentEvent(workspace.id, thread.id, runId, "1", "run.started", { status: "running" }),
          ],
          thread,
          threadId: thread.id,
          window: {
            byteCount: 64,
            hasMore: false,
            itemCount: 1,
            nextBefore: null,
            threadId: thread.id,
            totalItems: 1,
          },
        });
      }
      return json(bootstrap([workspace]));
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: { ...workspaceSnapshot(workspace, "1"), threads: [thread] },
      type: "host.snapshot",
    });
    client.activateThread(thread.id);
    await askedForHistory;
    socket.receive({
      events: [
        agentEvent(workspace.id, thread.id, runId, "2", "run.completed", {
          replyMessageId: null,
          status: "completed",
        }),
        agentEvent(workspace.id, thread.id, null, "3", "thread.state-changed", {
          inputQueuePaused: false,
          pendingRequests: 0,
          status: "idle",
        }),
      ],
      type: "host.events",
    });
    answerHistory();
    await vi.waitFor(() => expect(client.getSnapshot().transcriptWindows[thread.id]).toBeDefined());
    expect(client.getSnapshot().threads.find(({ id }) => id === thread.id)?.status).toBe("idle");

    socket.receive({
      events: [
        agentEvent(workspace.id, thread.id, null, "4", "thread.input-queue-updated", {
          paused: true,
        }),
      ],
      type: "host.events",
    });
    expect(client.getSnapshot().threads.find(({ id }) => id === thread.id)?.status).toBe("idle");
    client.dispose();
  });

  /*
   * A command's answer can reach the client after realtime events committed
   * later. Its Thread is current as of the command, so it must not take back a
   * status or queue pause the Host has published since.
   */
  it("keeps a later Host status when a Thread command's answer arrives late", async () => {
    const workspace = makeWorkspace();
    const thread = { ...makeThread(workspace.id), status: "running" as const };
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    let asked!: () => void;
    const commandSent = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const sockets: FakeSocket[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/rpc/commands.dispatch") {
        asked();
        await answered;
        return json({
          thread: { ...thread, accessMode: "full-access" },
          type: "thread.access.update",
        });
      }
      return json(bootstrap([workspace]));
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: { ...workspaceSnapshot(workspace, "1"), threads: [thread] },
      type: "host.snapshot",
    });
    const updating = client.updateThreadAccess(thread.id, "full-access");
    await commandSent;
    socket.receive({
      events: [
        agentEvent(workspace.id, thread.id, null, "2", "thread.state-changed", {
          inputQueuePaused: false,
          pendingRequests: 0,
          status: "idle",
        }),
      ],
      type: "host.events",
    });
    answer();
    await updating;

    const current = client.getSnapshot().threads.find(({ id }) => id === thread.id);
    expect(current?.status).toBe("idle");
    expect(current?.accessMode).toBe("full-access");
    client.dispose();
  });

  it.each([true, false])(
    "rebuilds the transcript from durable event history when a Thread is activated (turn pages %s)",
    async (turnPages) => {
      const workspace = makeWorkspace();
      const thread = makeThread(workspace.id);
      const runId = createId("run");
      const userMessage = makeMessage(thread.id, "input", "Do the work");
      const eventRequests: Record<string, unknown>[] = [];
      const sockets: FakeSocket[] = [];
      const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/rpc/thread.requests.list") {
          return json({ nextCursor: null, requests: [], threadId: thread.id });
        }
        if (url.pathname === "/v1/rpc/thread.events.list") {
          eventRequests.push(rpcPayload(url, init));
          return json({
            thread,
            events: [
              agentEvent(workspace.id, thread.id, runId, "1", "message.created", {
                input: makeThreadInput(userMessage),
                message: userMessage,
              }),
              agentEvent(workspace.id, thread.id, runId, "2", "run.started", { status: "running" }),
              agentEvent(workspace.id, thread.id, runId, "4", "reasoning.completed", {
                blockId: "block-1",
                text: "Weighing the options carefully.",
              }),
              agentEvent(workspace.id, thread.id, runId, "5", "tool.started", {
                arguments: { command: "pnpm test" },
                callId: "shell-1",
                tool: { name: "shell", namespace: "codex" },
              }),
              agentEvent(workspace.id, thread.id, runId, "7", "tool.completed", {
                callId: "shell-1",
                isError: false,
                output: { text: "42 passed\n" },
              }),
              agentEvent(workspace.id, thread.id, runId, "8", "assistant.message", {
                content: [{ text: "All checks pass.", type: "text" }],
                messageId: createId("message"),
              }),
              agentEvent(workspace.id, thread.id, runId, "9", "run.completed", {
                replyMessageId: null,
                status: "completed",
              }),
            ],
            threadId: thread.id,
            window: {
              byteCount: 512,
              hasMore: false,
              itemCount: 7,
              nextBefore: null,
              threadId: thread.id,
              totalItems: 7,
            },
          });
        }
        return json(bootstrap([workspace]));
      }) as unknown as typeof globalThis.fetch;
      const client = createHttpHostClient({
        capabilities: async () => (turnPages ? ["history-turns-v1"] : []),
        fetch,
        refreshIntervalMs: 0,
        webSocketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      });
      await client.load();
      const socket = sockets[0]!;
      socket.open();
      socket.receive({
        snapshot: {
          ...workspaceSnapshot(workspace, "9"),
          threads: [thread],
          threadWindow: {
            byteCount: 256,
            hasMore: false,
            itemCount: 1,
            nextBefore: null,
            totalItems: 1,
          },
        },
        type: "host.snapshot",
      });

      client.activateThread(thread.id);
      await vi.waitFor(() =>
        expect(client.getSnapshot().transcripts[thread.id]?.length).toBeGreaterThan(0),
      );

      const entries = client.getSnapshot().transcripts[thread.id] ?? [];
      expect(entries.map((entry) => entry.kind)).toEqual([
        "message",
        "run",
        "reasoning",
        "tool",
        "message",
      ]);
      expect(entries[1]).toMatchObject({ kind: "run", runId, status: "completed" });
      expect(entries[2]).toMatchObject({
        id: `reasoning:${runId}:block-1`,
        kind: "reasoning",
        state: "done",
        text: "Weighing the options carefully.",
      });
      expect(entries[3]).toMatchObject({
        arguments: { command: "pnpm test" },
        id: `tool:${runId}:shell-1`,
        integration: null,
        isError: false,
        kind: "tool",
        tool: { name: "shell", namespace: "codex" },
        output: { text: "42 passed\n" },
        state: "done",
      });
      expect(entries[4]).toMatchObject({
        body: "All checks pass.",
        kind: "message",
        messageKind: "assistant",
      });
      expect(eventRequests).toEqual([{ threadId: thread.id, ...(turnPages ? { turns: 10 } : {}) }]);

      // Re-activating a hydrated Thread must not refetch the history.
      client.activateThread(thread.id);
      await Promise.resolve();
      expect(eventRequests).toHaveLength(1);
      client.dispose();
    },
  );

  it("surfaces a failed deep-link lookup and retries it on the next activation", async () => {
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    let eventReads = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === "/v1/rpc/thread.events.list") {
        eventReads += 1;
        if (eventReads === 1) throw new Error("The Host is temporarily unavailable.");
        return json({
          thread,
          events: [agentEvent(workspace.id, thread.id, null, "1", "thread.created", { thread })],
          threadId: thread.id,
          window: {
            byteCount: 128,
            hasMore: false,
            itemCount: 1,
            nextBefore: null,
            threadId: thread.id,
            totalItems: 1,
          },
        });
      }
      return json(bootstrap([workspace]));
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({ fetch, refreshIntervalMs: 0 });
    await client.load();

    client.activateThread(thread.id);
    await vi.waitFor(() => expect(client.getSnapshot().threadLookups[thread.id]).toBe("failed"));

    client.activateThread(thread.id);
    await vi.waitFor(() =>
      expect(client.getSnapshot().threads).toContainEqual(
        expect.objectContaining({ id: thread.id, title: thread.title }),
      ),
    );
    expect(client.getSnapshot().threadLookups[thread.id]).toBeUndefined();
    expect(eventReads).toBe(2);
    client.dispose();
  });

  it("keeps a historical page pinned after a failed latest read and includes live events on retry", async () => {
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    const runId = createId("run");
    const historical = agentEvent(workspace.id, thread.id, runId, "1", "assistant.message", {
      content: [{ text: "Historical answer", type: "text" }],
      messageId: createId("message"),
    });
    const live = agentEvent(workspace.id, thread.id, runId, "2", "assistant.message", {
      content: [{ text: "New answer", type: "text" }],
      messageId: createId("message"),
    });
    const duringRetry = agentEvent(workspace.id, thread.id, runId, "3", "assistant.message", {
      content: [{ text: "Answer during refresh", type: "text" }],
      messageId: createId("message"),
    });
    const page = (events: AgentEvent[]) => ({
      thread,
      events,
      threadId: thread.id,
      window: {
        byteCount: 256,
        hasMore: false,
        itemCount: events.length,
        nextBefore: null,
        threadId: thread.id,
        totalItems: events.length,
      },
    });
    let reads = 0;
    let finishLatest: ((response: Response) => void) | undefined;
    const pendingLatest = new Promise<Response>((resolve) => {
      finishLatest = resolve;
    });
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname !== "/v1/rpc/thread.events.list") return json(bootstrap([workspace]));
        reads += 1;
        if (reads === 1) return json(page([historical]));
        if (reads === 2) throw new Error("Latest page is temporarily unavailable");
        return pendingLatest;
      },
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: { ...workspaceSnapshot(workspace, "0"), threads: [thread] },
      type: "host.snapshot",
    });
    await client.loadTranscriptAround(thread.id, historical.data.messageId);
    await expect(client.loadLatestTranscript(thread.id)).rejects.toThrow();
    socket.receive({ events: [live], type: "host.events" });
    expect(
      client
        .getSnapshot()
        .transcripts[thread.id]?.flatMap((entry) => (entry.kind === "message" ? [entry.body] : [])),
    ).toEqual(["Historical answer"]);

    const restored = client.loadLatestTranscript(thread.id);
    socket.receive({ events: [duringRetry], type: "host.events" });
    finishLatest?.(json(page([historical, live])));
    await restored;
    expect(
      client
        .getSnapshot()
        .transcripts[thread.id]?.flatMap((entry) => (entry.kind === "message" ? [entry.body] : [])),
    ).toEqual(["Historical answer", "New answer", "Answer during refresh"]);
    client.dispose();
  });

  it("keeps a definitive missing deep-link lookup distinct from a transient failure", async () => {
    const workspace = makeWorkspace();
    const missingThreadId = createId("thread");
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === "/v1/rpc/thread.events.list") {
        return json(
          { error: { code: "not_found", message: "Thread not found", retryable: false } },
          404,
        );
      }
      return json(bootstrap([workspace]));
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({ fetch, refreshIntervalMs: 0 });
    await client.load();

    client.activateThread(missingThreadId);
    await vi.waitFor(() =>
      expect(client.getSnapshot().threadLookups[missingThreadId]).toBe("missing"),
    );
    client.dispose();
  });

  it("keeps an unchanged Thread's identity when another Thread's work arrives", async () => {
    const workspace = makeWorkspace();
    const open = makeThread(workspace.id);
    const busy = makeThread(workspace.id);
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    try {
      await client.load();
      const socket = sockets[0]!;
      socket.open();
      socket.receive({
        snapshot: {
          ...workspaceSnapshot(workspace, "0"),
          readStates: [
            {
              asOfSequence: sequence("0"),
              readSequence: null,
              threadId: open.id,
              unreadSequence: null,
            },
          ],
          threads: [open, busy],
        },
        type: "host.snapshot",
      });
      const revision = client.getSnapshot().revision;
      const before = client.getSnapshot().threads.find(({ id }) => id === open.id);
      expect(before?.unread).toBe(false);
      socket.receive({
        events: [
          agentEvent(workspace.id, busy.id, createId("run"), "1", "run.started", {
            status: "running",
          }),
        ],
        type: "host.events",
      });
      await vi.waitFor(() => expect(client.getSnapshot().revision).toBeGreaterThan(revision));
      // Screens compare Thread records by identity; a copy redraws the open conversation.
      expect(client.getSnapshot().threads.find(({ id }) => id === open.id)).toBe(before);
    } finally {
      client.dispose();
    }
  });

  it("applies a reread stream only after the durable events it follows", async () => {
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    const runId = createId("run");
    const sockets: FakeSocket[] = [];
    let liveReads = 0;
    const client = createHttpHostClient({
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/rpc/thread.live.get") {
          liveReads += 1;
          // The Host answers with the next answer's stream, which follows the
          // completion of the first answer at sequence 2.
          return json({
            runs: [
              {
                afterSequence: "3",
                progress: {
                  items: [{ length: 4, op: "replace", stream: "assistant", text: "Beta" }],
                  runId,
                  threadId: thread.id,
                  workspaceId: workspace.id,
                },
              },
            ],
            threadId: thread.id,
          });
        }
        return json(bootstrap([workspace]));
      },
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    client.activateThread(thread.id);
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: { ...workspaceSnapshot(workspace, "0"), threads: [thread] },
      type: "host.snapshot",
    });
    socket.receive({
      events: [
        agentEvent(workspace.id, thread.id, runId, "1", "run.started", { status: "running" }),
      ],
      type: "host.events",
    });
    const live = (at: number, text: string) =>
      socket.receive({
        afterSequence: sequence("1"),
        progress: {
          items: [{ at, op: "append", stream: "assistant", text }],
          runId,
          threadId: thread.id,
          workspaceId: workspace.id,
        },
        type: "host.live",
        workspaceId: workspace.id,
      });
    live(0, "Alpha ");
    // A frame went missing, so the client rereads the Thread's streams.
    live(100, "lost");
    await vi.waitFor(() => expect(liveReads).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const messageId = createId("message");
    socket.receive({
      events: [
        agentEvent(workspace.id, thread.id, runId, "2", "assistant.message", {
          content: [{ text: "Alpha done.", type: "text" }],
          messageId,
        }),
        agentEvent(workspace.id, thread.id, runId, "3", "run.status", { status: "running" }),
      ],
      type: "host.events",
    });
    const entries = client.getSnapshot().transcripts[thread.id] ?? [];
    expect(entries).toContainEqual(expect.objectContaining({ body: "Alpha done.", id: messageId }));
    expect(entries).toContainEqual(
      expect.objectContaining({ body: "Beta", id: `stream:${runId}`, streaming: true }),
    );
    client.dispose();
  });

  it("ignores a stream reread that answers after the subscription started over", async () => {
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    const runId = createId("run");
    const sockets: FakeSocket[] = [];
    let answerRead!: () => void;
    const answered = new Promise<void>((resolve) => {
      answerRead = resolve;
    });
    let liveReads = 0;
    const client = createHttpHostClient({
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/rpc/thread.live.get") {
          liveReads += 1;
          await answered;
          // A read taken before the first answer completed.
          return json({
            runs: [
              {
                afterSequence: "1",
                progress: {
                  items: [{ length: 6, op: "replace", stream: "assistant", text: "Alpha " }],
                  runId,
                  threadId: thread.id,
                  workspaceId: workspace.id,
                },
              },
            ],
            threadId: thread.id,
          });
        }
        return json(bootstrap([workspace]));
      },
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 5,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const first = sockets[0]!;
    first.open();
    first.receive({
      snapshot: { ...workspaceSnapshot(workspace, "0"), threads: [thread] },
      type: "host.snapshot",
    });
    first.receive({
      events: [
        agentEvent(workspace.id, thread.id, runId, "1", "run.started", { status: "running" }),
      ],
      type: "host.events",
    });
    first.receive({
      afterSequence: sequence("1"),
      progress: {
        items: [{ at: 50, op: "append", stream: "assistant", text: "gap" }],
        runId,
        threadId: thread.id,
        workspaceId: workspace.id,
      },
      type: "host.live",
      workspaceId: workspace.id,
    });
    await vi.waitFor(() => expect(liveReads).toBe(1));

    // The connection drops and resubscribes; the answer completed meanwhile.
    first.close(1006, "lost");
    await vi.waitFor(() => expect(sockets.length).toBe(2));
    const second = sockets[1]!;
    second.open();
    const messageId = createId("message");
    second.receive({
      events: [
        agentEvent(workspace.id, thread.id, runId, "2", "assistant.message", {
          content: [{ text: "Alpha done.", type: "text" }],
          messageId,
        }),
      ],
      type: "host.events",
    });
    second.receive({
      sequence: sequence("2"),
      type: "host.synchronized",
      workspaceId: workspace.id,
    });
    answerRead();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const entries = client.getSnapshot().transcripts[thread.id] ?? [];
    expect(entries.filter((entry) => entry.id === `stream:${runId}`)).toEqual([]);
    client.dispose();
  });

  it("ignores a stream reread that answers between a resubscription's snapshot and its end", async () => {
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    const runId = createId("run");
    const sockets: FakeSocket[] = [];
    let answerRead!: () => void;
    const answered = new Promise<void>((resolve) => {
      answerRead = resolve;
    });
    let liveReads = 0;
    const client = createHttpHostClient({
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/rpc/thread.live.get") {
          liveReads += 1;
          await answered;
          return json({
            runs: [
              {
                afterSequence: "1",
                progress: {
                  items: [{ length: 6, op: "replace", stream: "assistant", text: "Alpha " }],
                  runId,
                  threadId: thread.id,
                  workspaceId: workspace.id,
                },
              },
            ],
            threadId: thread.id,
          });
        }
        return json(bootstrap([workspace]));
      },
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 5,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const first = sockets[0]!;
    first.open();
    first.receive({
      snapshot: { ...workspaceSnapshot(workspace, "0"), threads: [thread] },
      type: "host.snapshot",
    });
    first.receive({
      events: [
        agentEvent(workspace.id, thread.id, runId, "1", "run.started", { status: "running" }),
      ],
      type: "host.events",
    });
    first.receive({
      afterSequence: sequence("1"),
      progress: {
        items: [{ at: 50, op: "append", stream: "assistant", text: "gap" }],
        runId,
        threadId: thread.id,
        workspaceId: workspace.id,
      },
      type: "host.live",
      workspaceId: workspace.id,
    });
    await vi.waitFor(() => expect(liveReads).toBe(1));

    // The new subscription's snapshot already holds the completed answer; the
    // old read answers before the subscription has finished synchronizing.
    first.close(1006, "lost");
    await vi.waitFor(() => expect(sockets.length).toBe(2));
    const second = sockets[1]!;
    second.open();
    second.receive({
      snapshot: { ...workspaceSnapshot(workspace, "2"), threads: [thread] },
      type: "host.snapshot",
    });
    answerRead();
    await new Promise((resolve) => setTimeout(resolve, 20));
    second.receive({
      sequence: sequence("2"),
      type: "host.synchronized",
      workspaceId: workspace.id,
    });

    const entries = client.getSnapshot().transcripts[thread.id] ?? [];
    expect(entries.filter((entry) => entry.id === `stream:${runId}`)).toEqual([]);
    client.dispose();
  });

  it("does not redraw a stream the history it reads has already completed", async () => {
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    const runId = createId("run");
    const messageId = createId("message");
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/rpc/thread.requests.list") {
          return json({ nextCursor: null, requests: [], threadId: thread.id });
        }
        if (url.pathname === "/v1/rpc/thread.events.list") {
          // History answers ahead of the event stream: the answer completed.
          return json({
            events: [
              agentEvent(workspace.id, thread.id, runId, "1", "run.started", { status: "running" }),
              agentEvent(workspace.id, thread.id, runId, "2", "assistant.message", {
                content: [{ text: "Alpha done.", type: "text" }],
                messageId,
              }),
              agentEvent(workspace.id, thread.id, runId, "3", "run.completed", {
                replyMessageId: messageId,
                status: "completed",
              }),
            ],
            thread,
            threadId: thread.id,
            window: {
              byteCount: 256,
              hasMore: false,
              itemCount: 3,
              nextBefore: null,
              threadId: thread.id,
              totalItems: 3,
            },
          });
        }
        return json(bootstrap([workspace]));
      },
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: { ...workspaceSnapshot(workspace, "0"), threads: [thread] },
      type: "host.snapshot",
    });
    socket.receive({
      events: [
        agentEvent(workspace.id, thread.id, runId, "1", "run.started", { status: "running" }),
      ],
      type: "host.events",
    });
    socket.receive({
      afterSequence: sequence("1"),
      progress: {
        items: [{ at: 0, op: "append", stream: "assistant", text: "Alpha " }],
        runId,
        threadId: thread.id,
        workspaceId: workspace.id,
      },
      type: "host.live",
      workspaceId: workspace.id,
    });
    client.activateThread(thread.id);
    await vi.waitFor(() =>
      expect(
        (client.getSnapshot().transcripts[thread.id] ?? []).some((entry) => entry.id === messageId),
      ).toBe(true),
    );
    const entries = client.getSnapshot().transcripts[thread.id] ?? [];
    expect(entries.filter((entry) => entry.id === `stream:${runId}`)).toEqual([]);
    client.dispose();
  });

  it("replaces a streaming assistant draft in place when the final message arrives", async () => {
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    const runId = createId("run");
    const messageId = createId("message");
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    client.activateThread(thread.id);
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: {
        ...workspaceSnapshot(workspace, "0"),
        threads: [thread],
      },
      type: "host.snapshot",
    });

    socket.receive({
      events: [
        agentEvent(workspace.id, thread.id, runId, "1", "run.started", { status: "running" }),
      ],
      type: "host.events",
    });
    socket.receive({
      afterSequence: SequenceSchema.parse("1"),
      progress: {
        items: [
          { at: 0, op: "append", stream: "assistant", text: "Working" },
          { at: 7, op: "append", stream: "assistant", text: " on it." },
        ],
        runId,
        threadId: thread.id,
        workspaceId: workspace.id,
      },
      type: "host.live",
      workspaceId: workspace.id,
    });
    expect(client.getSnapshot().transcripts[thread.id]).toContainEqual(
      expect.objectContaining({
        body: "Working on it.",
        id: `stream:${runId}`,
        kind: "message",
        messageKind: "assistant",
        streaming: true,
      }),
    );

    socket.receive({
      events: [
        agentEvent(workspace.id, thread.id, runId, "2", "tool.started", {
          arguments: { command: "ls" },
          callId: "shell-1",
          tool: { name: "shell", namespace: "codex" },
        }),
        agentEvent(workspace.id, thread.id, runId, "3", "assistant.message", {
          content: [{ text: "Working on it. Done.", type: "text" }],
          messageId,
        }),
      ],
      type: "host.events",
    });

    const entries = client.getSnapshot().transcripts[thread.id] ?? [];
    // The final message keeps the draft's slot, before the later tool entry.
    expect(entries.map((entry) => entry.id)).toEqual([
      `run:${runId}`,
      messageId,
      `tool:${runId}:shell-1`,
    ]);
    expect(entries[1]).toMatchObject({
      body: "Working on it. Done.",
      kind: "message",
      messageKind: "assistant",
    });
    expect(entries[1]).not.toHaveProperty("streaming", true);
    client.dispose();
  });

  it("reconnects with its last durable cursor and caps exponential backoff", async () => {
    vi.useFakeTimers();
    const workspace = makeWorkspace();
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      random: () => 0,
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 40,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const first = sockets[0]!;
    first.open();
    first.receive({
      snapshot: workspaceSnapshot(workspace, "4"),
      type: "host.snapshot",
    });
    first.receive({
      sequence: sequence("4"),
      type: "host.synchronized",
      workspaceId: workspace.id,
    });
    expect(client.getSnapshot().connection).toBe("connected");

    first.serverClose();
    expect(client.getSnapshot().connection).toBe("connecting");
    await vi.advanceTimersByTimeAsync(8);
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();

    expect(parseSent(sockets[1]!, 0)).toMatchObject({
      afterSequence: "4",
      type: "client.subscribe",
      workspaceId: workspace.id,
    });
    client.dispose();
  });

  it("projects cross-client mutations and normalized run activity without duplicate messages", async () => {
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    const userMessage = makeMessage(thread.id, "input", "Do the work");
    const runId = userMessage.runId!;
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    client.activateThread(thread.id);
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: workspaceSnapshot(workspace, "0"),
      type: "host.snapshot",
    });
    socket.receive({
      sequence: sequence("0"),
      type: "host.synchronized",
      workspaceId: workspace.id,
    });

    socket.receive({
      events: [
        agentEvent(workspace.id, thread.id, null, "1", "thread.created", { thread }),
        agentEvent(workspace.id, thread.id, runId, "2", "message.created", {
          input: makeThreadInput(userMessage),
          message: userMessage,
        }),
        agentEvent(workspace.id, thread.id, runId, "3", "run.queued", {
          run: {
            createdAt: now,
            id: runId,
            status: "queued",
            threadId: thread.id,
            runOrdinal: 0,
          },
        }),
        agentEvent(workspace.id, thread.id, runId, "4", "run.started", {
          status: "running",
        }),
        agentEvent(workspace.id, thread.id, runId, "5", "tool.started", {
          arguments: { path: "docs/plan.md" },
          callId: "read-1",
          tool: { name: "workspace.read_file", namespace: "test" },
        }),
        agentEvent(workspace.id, thread.id, runId, "6", "tool.completed", {
          callId: "read-1",
          isError: false,
          output: { text: "# Plan" },
        }),
        agentEvent(workspace.id, thread.id, runId, "7", "assistant.message", {
          content: [{ text: "Finished.", type: "text" }],
          messageId: createId("message"),
        }),
        agentEvent(workspace.id, thread.id, runId, "8", "run.completed", {
          replyMessageId: null,
          status: "completed",
        }),
        agentEvent(workspace.id, thread.id, null, "9", "thread.input-queue-updated", {
          paused: true,
        }),
        agentEvent(workspace.id, thread.id, null, "10", "thread.input-queue-updated", {
          paused: false,
        }),
        agentEvent(workspace.id, thread.id, null, "11", "thread.access-mode-updated", {
          accessMode: "auto",
        }),
      ],
      type: "host.events",
    });
    // Replayed duplicate sequence and message ID must be ignored.
    socket.receive({
      events: [
        agentEvent(workspace.id, thread.id, runId, "2", "message.created", {
          input: makeThreadInput(userMessage),
          message: userMessage,
        }),
      ],
      type: "host.events",
    });

    const snapshot = client.getSnapshot();
    expect(snapshot.threads).toHaveLength(1);
    expect(snapshot.threads[0]).toMatchObject({
      accessMode: "auto",
      inputQueuePaused: false,
      status: "idle",
      title: "Do the work",
      icon: null,
    });
    expect(snapshot.runQueue).toEqual([]);
    const entries = snapshot.transcripts[thread.id] ?? [];
    expect(
      entries.filter((entry) => entry.kind === "message" && entry.id === userMessage.id),
    ).toHaveLength(1);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ body: "Finished.", kind: "message", messageKind: "assistant" }),
        expect.objectContaining({
          kind: "tool",
          state: "done",
          tool: { name: "workspace.read_file", namespace: "test" },
        }),
        expect.objectContaining({ kind: "run", status: "completed" }),
      ]),
    );
    expect(parseSent(socket, socket.sent.length - 1)).toMatchObject({
      sequence: "11",
      type: "client.ack",
    });
    client.dispose();
  });

  it("keeps a Thread running when one Run completes with a queued successor", async () => {
    const workspace = makeWorkspace();
    const thread = { ...makeThread(workspace.id), status: "running" as const };
    const firstRunId = createId("run");
    const secondRunId = createId("run");
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: {
        ...workspaceSnapshot(workspace, "0"),
        threads: [thread],
      },
      type: "host.snapshot",
    });
    socket.receive({
      events: [
        agentEvent(workspace.id, thread.id, firstRunId, "1", "run.queued", {
          run: {
            createdAt: now,
            id: firstRunId,
            status: "queued",
            threadId: thread.id,
            runOrdinal: 0,
          },
        }),
        agentEvent(workspace.id, thread.id, firstRunId, "2", "run.started", {
          status: "running",
        }),
        agentEvent(workspace.id, thread.id, secondRunId, "3", "run.queued", {
          run: {
            createdAt: now,
            id: secondRunId,
            status: "queued",
            threadId: thread.id,
            runOrdinal: 1,
          },
        }),
        agentEvent(workspace.id, thread.id, firstRunId, "4", "run.completed", {
          replyMessageId: null,
          status: "completed",
        }),
      ],
      type: "host.events",
    });

    expect(client.getSnapshot().threads[0]?.status).toBe("running");
    expect(client.getSnapshot().runQueue).toEqual([
      expect.objectContaining({ id: secondRunId, runOrdinal: 1, status: "queued" }),
    ]);
    client.dispose();
  });

  it("projects an accepted pending message without inventing a Run", async () => {
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    const pendingMessage = { ...makeMessage(thread.id, "input", "Queue this"), runId: null };
    const sockets: FakeSocket[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/v1/rpc/bootstrap.get") return json(bootstrap([workspace]));
      if (path === "/v1/rpc/commands.dispatch") {
        const acceptedInput = makeThreadInput(pendingMessage);
        return json(
          {
            input: { ...acceptedInput, deliveredAt: null, state: "pending" },
            message: pendingMessage,
            run: null,
            wasDuplicate: false,
          },
          202,
        );
      }
      return json({ wasDuplicate: false }, 202);
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: {
        ...workspaceSnapshot(workspace, "0"),
        threads: [thread],
      },
      type: "host.snapshot",
    });

    await client.dispatch({
      content: [{ text: "Queue this", type: "text" }],
      idempotencyKey: "message:test",
      threadId: thread.id,
      type: "thread.sendMessage",
    });

    expect(client.getSnapshot().runQueue).toEqual([]);
    expect(client.getSnapshot().transcripts[thread.id]).toContainEqual(
      expect.objectContaining({ body: "Queue this", messageKind: "input", runId: null }),
    );
    client.dispose();
  });

  /*
   * The client can miss Run admission or hold a Runner status that differs
   * from the Host while a live Request is pending. Only Host status facts
   * can keep those projections consistent across later batches.
   */
  it("retains a pending live Request's Host status when the Runner reports running", async () => {
    const workspace = makeWorkspace();
    const thread = { ...makeThread(workspace.id), status: "waiting" as const };
    const runId = createId("run");
    const request = pendingRequest({
      presentation: {
        detail: "Approve work",
        kind: "choice",
        options: [{ hint: "allow-once", id: "allow", label: "Allow" }],
        risk: "medium",
        title: "Approval",
      },
      runId,
      threadId: thread.id,
      workspaceId: workspace.id,
    });
    const socket = new FakeSocket();
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      refreshIntervalMs: 0,
      webSocketFactory: () => socket,
    });
    await client.load();
    socket.open();
    socket.receive({
      type: "host.snapshot",
      snapshot: { ...workspaceSnapshot(workspace, "0"), threads: [thread] },
    });
    socket.receive({
      type: "host.events",
      events: [
        agentEvent(workspace.id, thread.id, runId, "1", "request.opened", { request }),
        agentEvent(workspace.id, thread.id, runId, "2", "run.status", { status: "running" }),
      ],
    });
    expect(client.getSnapshot().threads[0]?.status).toBe("waiting");
    client.dispose();
  });

  it.each(["events", "snapshot"] as const)(
    "keeps Host status authoritative after %s hydration with incomplete Run facts",
    async (source) => {
      const workspace = makeWorkspace();
      const thread = makeThread(workspace.id);
      const runId = createId("run");
      const socket = new FakeSocket();
      const client = createHttpHostClient({
        fetch: async () => json(bootstrap([workspace])),
        refreshIntervalMs: 0,
        webSocketFactory: () => socket,
      });
      await client.load();
      socket.open();
      socket.receive({
        snapshot: {
          ...workspaceSnapshot(workspace, "0"),
          threads: [{ ...thread, status: source === "snapshot" ? "running" : "idle" }],
        },
        type: "host.snapshot",
      });
      socket.receive({
        type: "host.events",
        events: [
          agentEvent(workspace.id, thread.id, runId, "1", "run.status", { status: "running" }),
          ...(source === "events"
            ? [
                agentEvent(workspace.id, thread.id, null, "2", "thread.state-changed", {
                  inputQueuePaused: false,
                  pendingRequests: 0,
                  status: "running",
                }),
              ]
            : []),
        ],
      });
      expect(client.getSnapshot().threads[0]?.status).toBe("running");
      expect(client.getSnapshot().runQueue).toEqual([]);
      socket.receive({
        type: "host.events",
        events: [
          agentEvent(workspace.id, thread.id, null, "3", "thread.input-queue-updated", {
            paused: true,
          }),
        ],
      });
      // The Host remains running, so this batch contains no status change.
      expect(client.getSnapshot().threads[0]?.status).toBe("running");
      const request = pendingRequest({
        presentation: {
          detail: "Approve work",
          kind: "choice",
          options: [{ hint: "allow-once", id: "allow", label: "Allow" }],
          risk: "medium",
          title: "Approval",
        },
        runId,
        threadId: thread.id,
        workspaceId: workspace.id,
      });
      socket.receive({
        type: "host.events",
        events: [
          agentEvent(workspace.id, thread.id, runId, "4", "request.opened", { request }),
          agentEvent(workspace.id, thread.id, null, "5", "thread.state-changed", {
            inputQueuePaused: false,
            pendingRequests: 0,
            status: "waiting",
          }),
        ],
      });
      expect(client.getSnapshot().threads[0]?.status).toBe("waiting");
      socket.receive({
        type: "host.events",
        events: [
          agentEvent(workspace.id, thread.id, runId, "6", "run.status", { status: "running" }),
        ],
      });
      // A pending live Request keeps the Host waiting even when the Runner says running.
      expect(client.getSnapshot().threads[0]?.status).toBe("waiting");
      socket.receive({
        type: "host.events",
        events: [
          agentEvent(workspace.id, thread.id, runId, "7", "request.cancelled", {
            requestId: request.id,
            reason: "source-closed",
          }),
          agentEvent(workspace.id, thread.id, null, "8", "thread.state-changed", {
            inputQueuePaused: false,
            pendingRequests: 0,
            status: "running",
          }),
        ],
      });
      expect(client.getSnapshot().threads[0]?.status).toBe("running");
      client.dispose();
    },
  );

  it("applies Host status across paused work, resume, and archived Threads", async () => {
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    const archived = { ...makeThread(workspace.id), status: "archived" as const };
    const failing = createId("run");
    const successor = createId("run");
    const archivedRun = createId("run");
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: { ...workspaceSnapshot(workspace, "0"), threads: [thread, archived] },
      type: "host.snapshot",
    });
    const queued = (
      runId: ReturnType<typeof createId<"run">>,
      threadId: AgentEvent["threadId"],
      runOrdinal: number,
      sequence: string,
    ) =>
      agentEvent(workspace.id, threadId, runId, sequence, "run.queued", {
        run: { createdAt: now, id: runId, status: "queued", threadId, runOrdinal },
      });
    const status = (threadId: string) =>
      client.getSnapshot().threads.find(({ id }) => id === threadId)?.status;

    socket.receive({
      events: [
        queued(failing, thread.id, 0, "1"),
        agentEvent(workspace.id, thread.id, failing, "2", "run.started", { status: "running" }),
        queued(successor, thread.id, 1, "3"),
        agentEvent(workspace.id, thread.id, null, "4", "thread.input-queue-updated", {
          paused: true,
        }),
        agentEvent(workspace.id, thread.id, failing, "5", "run.failed", {
          code: "engine_failed",
          message: "The engine stopped",
          retryable: false,
          status: "failed",
        }),
        agentEvent(workspace.id, thread.id, null, "6", "thread.state-changed", {
          inputQueuePaused: false,
          pendingRequests: 0,
          status: "idle",
        }),
      ],
      type: "host.events",
    });
    expect(status(thread.id)).toBe("idle");

    socket.receive({
      events: [
        agentEvent(workspace.id, thread.id, null, "7", "thread.input-queue-updated", {
          paused: false,
        }),
        agentEvent(workspace.id, thread.id, null, "8", "thread.state-changed", {
          inputQueuePaused: false,
          pendingRequests: 0,
          status: "running",
        }),
      ],
      type: "host.events",
    });
    expect(status(thread.id)).toBe("running");

    socket.receive({
      events: [
        queued(archivedRun, archived.id, 0, "9"),
        agentEvent(workspace.id, archived.id, archivedRun, "10", "run.failed", {
          code: "engine_failed",
          message: "The engine stopped",
          retryable: false,
          status: "failed",
        }),
      ],
      type: "host.events",
    });
    expect(status(archived.id)).toBe("archived");
    client.dispose();
  });

  it("queues a follow-up through HTTP and interrupts only the executing Run", async () => {
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    const currentRunId = createId("run");
    const queuedRunId = createId("run");
    const queuedMessage = makeMessage(thread.id, "input", "Follow up next");
    const sockets: FakeSocket[] = [];
    const requestedTypes: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/v1/rpc/bootstrap.get") return json(bootstrap([workspace]));
      const type = requiredString(
        JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>,
        "type",
      );
      requestedTypes.push(type);
      if (type === "thread.sendMessage") {
        return json(
          {
            input: makeThreadInput({ ...queuedMessage, runId: queuedRunId }),
            message: { ...queuedMessage, runId: queuedRunId },
            run: {
              accessMode: thread.accessMode,
              activationInputId: queuedMessage.id,
              assignmentId: null,
              causalChainId: createId("causalChain"),
              completedAt: null,
              createdAt: now,
              environmentId: thread.environmentId,
              failure: null,
              harnessInstanceId: thread.harnessInstanceId,
              id: queuedRunId,
              providerSessionId: createId("providerSession"),
              modelSelection: thread.modelSelection,
              requestedBy: ownerId,
              replyTarget: null,
              runOrdinal: 1,
              startedAt: null,
              status: "queued",
              threadId: thread.id,
              seedInputId: queuedMessage.id,
            },
            wasDuplicate: false,
          },
          202,
        );
      }
      return json({ wasDuplicate: false }, 202);
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: {
        ...workspaceSnapshot(workspace, "1"),
        runQueue: [
          {
            createdAt: now,
            id: currentRunId,
            status: "running",
            threadId: thread.id,
            runOrdinal: 0,
          },
        ],
        threads: [{ ...thread, status: "running" }],
      },
      type: "host.snapshot",
    });

    await client.dispatch({
      content: [{ text: "Follow up next", type: "text" }],
      idempotencyKey: "message:test",
      threadId: thread.id,
      type: "thread.sendMessage",
    });
    await client.stopRun(thread.id);

    expect(client.getSnapshot().runQueue.map(({ id, status }) => [id, status])).toEqual([
      [currentRunId, "running"],
      [queuedRunId, "queued"],
    ]);
    expect(requestedTypes).toEqual(["thread.sendMessage", "run.interrupt"]);
    client.dispose();
  });

  it("does not let a slower queued HTTP acknowledgement overwrite realtime starting state", async () => {
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    const runId = createId("run");
    const message = makeMessage(thread.id, "input", "Start this next");
    const sockets: FakeSocket[] = [];
    let resolveMessage!: (response: Response) => void;
    const messageResponse = new Promise<Response>((resolve) => {
      resolveMessage = resolve;
    });
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/v1/rpc/bootstrap.get") return json(bootstrap([workspace]));
      if (path === "/v1/rpc/commands.dispatch") return messageResponse;
      return json({}, 202);
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: {
        ...workspaceSnapshot(workspace, "0"),
        threads: [thread],
      },
      type: "host.snapshot",
    });

    const sending = client.dispatch({
      content: [{ text: "Start this next", type: "text" }],
      idempotencyKey: "message:test",
      threadId: thread.id,
      type: "thread.sendMessage",
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    socket.receive({
      events: [
        agentEvent(workspace.id, thread.id, runId, "1", "run.queued", {
          run: {
            createdAt: now,
            id: runId,
            status: "queued",
            threadId: thread.id,
            runOrdinal: 0,
          },
        }),
        agentEvent(workspace.id, thread.id, runId, "2", "run.status", {
          status: "starting",
        }),
        agentEvent(workspace.id, thread.id, null, "3", "thread.state-changed", {
          inputQueuePaused: false,
          pendingRequests: 0,
          status: "running",
        }),
      ],
      type: "host.events",
    });
    resolveMessage(
      json(
        {
          input: makeThreadInput({ ...message, runId }),
          message: { ...message, runId },
          run: {
            accessMode: thread.accessMode,
            activationInputId: message.id,
            assignmentId: null,
            causalChainId: createId("causalChain"),
            completedAt: null,
            createdAt: now,
            environmentId: thread.environmentId,
            failure: null,
            harnessInstanceId: thread.harnessInstanceId,
            id: runId,
            providerSessionId: createId("providerSession"),
            modelSelection: thread.modelSelection,
            requestedBy: ownerId,
            replyTarget: null,
            runOrdinal: 0,
            startedAt: null,
            status: "queued",
            threadId: thread.id,
            seedInputId: message.id,
          },
          wasDuplicate: false,
        },
        202,
      ),
    );
    await sending;

    expect(client.getSnapshot().runQueue).toEqual([
      expect.objectContaining({ id: runId, status: "starting" }),
    ]);
    expect(client.getSnapshot().threads[0]?.status).toBe("running");
    client.dispose();
  });

  it("projects parent Threads and sends all Request responses through one Host route", async () => {
    const workspace = makeWorkspace();
    const parentThread = makeThread(workspace.id);
    const thread = { ...makeThread(workspace.id), parentThreadId: parentThread.id };
    const runId = createId("run");
    const approval = pendingRequest({
      presentation: {
        detail: "Publish the release",
        kind: "choice",
        options: [
          { hint: "reject-once", id: "reject", label: "Not now" },
          { hint: "confirm", id: "allow", label: "Publish" },
        ],
        risk: "high",
        title: "Publish externally",
      },
      runId,
      threadId: thread.id,
      workspaceId: workspace.id,
    });
    const sockets: FakeSocket[] = [];
    const requests: unknown[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/v1/rpc/bootstrap.get") return json(bootstrap([workspace]));
      expect(path).toBe("/v1/rpc/commands.dispatch");
      requests.push(JSON.parse(String(init?.body)));
      return json({}, 202);
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: workspaceSnapshot(workspace, "0"),
      type: "host.snapshot",
    });
    socket.receive({
      events: [
        agentEvent(workspace.id, thread.id, null, "1", "thread.created", { thread }),
        agentEvent(workspace.id, thread.id, runId, "2", "request.opened", {
          request: approval,
        }),
        agentEvent(workspace.id, thread.id, null, "3", "thread.state-changed", {
          inputQueuePaused: false,
          pendingRequests: 0,
          status: "waiting",
        }),
      ],
      type: "host.events",
    });

    expect(client.getSnapshot().threads[0]?.parentThreadId).toBe(parentThread.id);
    expect(client.getSnapshot().requests[thread.id]).toEqual([
      expect.objectContaining({ id: approval.id, originatingRunId: runId }),
    ]);
    await client.dispatch({
      idempotencyKey: `request-${approval.id}:test`,
      requestId: approval.id,
      response: { kind: "choice", optionId: "reject" },
      type: "request.respond",
    });

    const secret = pendingRequest({
      presentation: {
        fields: [
          {
            id: "token",
            multiSelect: false,
            prompt: "Enter the release token",
            secret: true,
          },
        ],
        kind: "form",
        title: "Token needed",
      },
      runId,
      threadId: thread.id,
      workspaceId: workspace.id,
    });
    socket.receive({
      events: [
        agentEvent(workspace.id, thread.id, runId, "4", "request.resolved", {
          request: {
            ...approval,
            resolvedAt: now,
            resolvedBy: ownerId,
            response: { kind: "choice", optionId: "reject" },
            status: "declined",
          },
        }),
        agentEvent(workspace.id, thread.id, runId, "5", "request.opened", {
          request: secret,
        }),
      ],
      type: "host.events",
    });
    await client.dispatch({
      idempotencyKey: `request-${secret.id}:test`,
      requestId: secret.id,
      response: { answers: { token: ["do-not-retain"] }, kind: "form" },
      type: "request.respond",
    });

    expect(requests).toEqual([
      {
        idempotencyKey: expect.stringMatching(/^request-/),
        requestId: approval.id,
        response: { kind: "choice", optionId: "reject" },
        type: "request.respond",
      },
      {
        idempotencyKey: expect.stringMatching(/^request-/),
        requestId: secret.id,
        response: { answers: { token: ["do-not-retain"] }, kind: "form" },
        type: "request.respond",
      },
    ]);
    expect(JSON.stringify(client.getSnapshot())).not.toContain("do-not-retain");
    expect(client.getSnapshot().threads[0]?.status).toBe("waiting");
    client.dispose();
  });

  it("resets an expired cursor and requests a fresh snapshot", async () => {
    vi.useFakeTimers();
    const workspace = makeWorkspace();
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      random: () => 0,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 20,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    sockets[0]?.open();
    sockets[0]?.receive({
      reason: "cursor-expired",
      type: "host.resync-required",
      workspaceId: workspace.id,
    });
    await vi.advanceTimersByTimeAsync(4);
    sockets[1]?.open();
    expect(parseSent(sockets[1]!, 0)).toMatchObject({ afterSequence: "0" });
    client.dispose();
  });
});

describe("HttpHostClient input queue", () => {
  it("reads the queue when a Thread is activated and reuses a read in flight", async () => {
    const host = await queueHost();
    host.client.activateThread(host.thread.id);
    host.client.activateThread(host.thread.id);
    await vi.waitFor(() =>
      expect(host.client.getSnapshot().inputQueues[host.thread.id]).toBeDefined(),
    );
    expect(host.reads()).toBe(1);
    expect(host.client.getSnapshot().inputQueues[host.thread.id]).toMatchObject({
      items: [
        {
          canCancel: true,
          canSteer: true,
          input: expect.objectContaining({ messageId: host.queued.id, state: "pending" }),
          message: expect.objectContaining({ id: host.queued.id }),
        },
      ],
      paused: false,
      steerRunId: host.runId,
    });

    // A queue already read is kept fresh by events, not by activation.
    host.client.activateThread(host.thread.id);
    await Promise.resolve();
    expect(host.reads()).toBe(1);
    host.client.dispose();
  });

  it("reads a loaded queue again after every event that can change it", async () => {
    const host = await queueHost();
    host.client.activateThread(host.thread.id);
    await vi.waitFor(() =>
      expect(host.client.getSnapshot().inputQueues[host.thread.id]).toBeDefined(),
    );
    const queuedRunId = createId("run");
    const later = { ...makeMessage(host.thread.id, "input", "And after that"), runId: null };
    host.items = [queueItem(host.queued, true), queueItem(later, true)];
    async function afterEvent(agent: AgentEvent): Promise<void> {
      const before = host.reads();
      host.socket.receive({ events: [agent], type: "host.events" });
      await vi.waitFor(() => expect(host.reads()).toBe(before + 1));
    }

    await afterEvent(
      agentEvent(host.workspace.id, host.thread.id, null, "1", "message.created", {
        input: pendingInput(later),
        message: later,
      }),
    );
    await vi.waitFor(() =>
      expect(host.client.getSnapshot().inputQueues[host.thread.id]?.items).toHaveLength(2),
    );
    await afterEvent(
      agentEvent(host.workspace.id, host.thread.id, host.runId, "2", "run.status", {
        status: "waiting",
      }),
    );
    await afterEvent(
      agentEvent(host.workspace.id, host.thread.id, host.runId, "3", "run.started", {
        status: "running",
      }),
    );
    host.paused = true;
    const before = host.reads();
    host.socket.receive({
      events: [
        agentEvent(host.workspace.id, host.thread.id, null, "4", "thread.input-queue-updated", {
          paused: true,
        }),
      ],
      type: "host.events",
    });
    // The pause is the event's own fact and lands before the read confirms it.
    expect(host.client.getSnapshot().inputQueues[host.thread.id]?.paused).toBe(true);
    await vi.waitFor(() => expect(host.reads()).toBe(before + 1));
    host.paused = false;
    await afterEvent(
      agentEvent(host.workspace.id, host.thread.id, null, "5", "thread.input-queue-updated", {
        paused: false,
      }),
    );
    await afterEvent(
      agentEvent(host.workspace.id, host.thread.id, host.runId, "6", "run.completed", {
        replyMessageId: null,
        status: "completed",
      }),
    );
    await afterEvent(
      agentEvent(host.workspace.id, host.thread.id, queuedRunId, "7", "run.queued", {
        run: {
          createdAt: now,
          id: queuedRunId,
          runOrdinal: 1,
          status: "queued",
          threadId: host.thread.id,
        },
      }),
    );
    await afterEvent(
      agentEvent(host.workspace.id, host.thread.id, queuedRunId, "8", "run.failed", {
        code: "engine",
        message: "The engine stopped.",
        retryable: false,
        status: "failed",
      }),
    );
    await afterEvent(
      agentEvent(host.workspace.id, host.thread.id, createId("run"), "9", "run.interrupted", {
        status: "interrupted",
      }),
    );

    // Not every event is about the queue, and a burst is one read.
    const settled = host.reads();
    host.socket.receive({
      events: [
        agentEvent(host.workspace.id, host.thread.id, null, "10", "thread.access-mode-updated", {
          accessMode: "auto",
        }),
      ],
      type: "host.events",
    });
    await Promise.resolve();
    expect(host.reads()).toBe(settled);
    host.socket.receive({
      events: [
        agentEvent(host.workspace.id, host.thread.id, host.runId, "11", "run.started", {
          status: "running",
        }),
        agentEvent(host.workspace.id, host.thread.id, null, "12", "thread.input-queue-updated", {
          paused: false,
        }),
      ],
      type: "host.events",
    });
    await vi.waitFor(() => expect(host.reads()).toBe(settled + 1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.reads()).toBe(settled + 1);
    host.client.dispose();
  });

  it("drops an input that left pending at once and answers a mid-read event with one more read", async () => {
    const host = await queueHost();
    host.client.activateThread(host.thread.id);
    await vi.waitFor(() =>
      expect(host.client.getSnapshot().inputQueues[host.thread.id]).toBeDefined(),
    );
    const later = { ...makeMessage(host.thread.id, "input", "And after that"), runId: null };
    host.items = [queueItem(host.queued, true), queueItem(later, true)];
    await host.client.loadThreadInputQueue(host.thread.id);
    const queuedIds = () =>
      host.client.getSnapshot().inputQueues[host.thread.id]?.items.map((item) => item.message.id);
    expect(queuedIds()).toEqual([host.queued.id, later.id]);

    host.items = [queueItem(later, true)];
    host.holdReads();
    host.socket.receive({
      events: [
        agentEvent(host.workspace.id, host.thread.id, host.runId, "1", "thread-input.updated", {
          input: { ...pendingInput(host.queued), runId: host.runId, state: "claimed" },
        }),
      ],
      type: "host.events",
    });
    // The tray stops offering a claimed message before the read confirms it.
    expect(queuedIds()).toEqual([later.id]);
    await vi.waitFor(() => expect(host.reads()).toBe(3));

    // Events that land while a read is in flight do not join it: the read may
    // predate them, so they earn exactly one more read once it settles.
    host.socket.receive({
      events: [
        agentEvent(host.workspace.id, host.thread.id, host.runId, "2", "run.started", {
          status: "running",
        }),
      ],
      type: "host.events",
    });
    host.socket.receive({
      events: [
        agentEvent(host.workspace.id, host.thread.id, null, "3", "thread.input-queue-updated", {
          paused: false,
        }),
      ],
      type: "host.events",
    });
    await Promise.resolve();
    expect(host.reads()).toBe(3);
    host.releaseReads();
    await vi.waitFor(() => expect(host.reads()).toBe(4));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.reads()).toBe(4);
    expect(queuedIds()).toEqual([later.id]);
    host.client.dispose();
  });

  it("queues an acknowledged send behind the running turn only when the Host started no Run", async () => {
    const host = await queueHost();
    host.items = [];
    host.client.activateThread(host.thread.id);
    await vi.waitFor(() =>
      expect(host.client.getSnapshot().inputQueues[host.thread.id]).toBeDefined(),
    );

    const held = { ...makeMessage(host.thread.id, "input", "Then rename the branch"), runId: null };
    host.answerWith(() =>
      json({ input: pendingInput(held), message: held, run: null, wasDuplicate: false }, 202),
    );
    // What the Host lists once it holds the message: the acknowledgement's
    // optimistic row is confirmed by a read, never left to stand on its own.
    host.items = [queueItem(held, true)];
    const send = {
      content: [{ text: "Then rename the branch", type: "text" as const }],
      idempotencyKey: "message:held",
      threadId: host.thread.id,
      type: "thread.sendMessage" as const,
    };
    const readsBefore = host.reads();
    await host.client.dispatch(send);
    await vi.waitFor(() => expect(host.reads()).toBe(readsBefore + 1));
    const queue = host.client.getSnapshot().inputQueues[host.thread.id] ?? null;
    expect(queue?.items).toEqual([
      {
        canCancel: true,
        canMove: true,
        canSteer: true,
        input: expect.objectContaining({ messageId: held.id, state: "pending" }),
        message: expect.objectContaining({ id: held.id }),
      },
    ]);
    // The message is in the transcript, as every send is, and the queue is
    // what keeps it out of the conversation until a Run takes it.
    const transcript = host.client.getSnapshot().transcripts[host.thread.id] ?? [];
    expect(transcript).toContainEqual(expect.objectContaining({ id: held.id }));
    expect(visibleTranscript(transcript, queue)).not.toContainEqual(
      expect.objectContaining({ id: held.id }),
    );

    // The same acknowledgement again adds nothing.
    await host.client.dispatch(send);
    expect(host.client.getSnapshot().inputQueues[host.thread.id]?.items).toHaveLength(1);

    // A send the Host started a Run for belongs to the conversation.
    const started = makeMessage(host.thread.id, "input", "Start now");
    host.answerWith(() =>
      json(
        {
          input: makeThreadInput(started),
          message: started,
          run: {
            accessMode: host.thread.accessMode,
            activationInputId: started.id,
            assignmentId: null,
            causalChainId: createId("causalChain"),
            completedAt: null,
            createdAt: now,
            environmentId: host.thread.environmentId,
            failure: null,
            harnessInstanceId: host.thread.harnessInstanceId,
            id: started.runId,
            providerSessionId: createId("providerSession"),
            modelSelection: host.thread.modelSelection,
            requestedBy: ownerId,
            replyTarget: null,
            runOrdinal: 1,
            seedInputId: started.id,
            startedAt: null,
            status: "queued",
            threadId: host.thread.id,
          },
          wasDuplicate: false,
        },
        202,
      ),
    );
    await host.client.dispatch({
      content: [{ text: "Start now", type: "text" }],
      idempotencyKey: "message:started",
      threadId: host.thread.id,
      type: "thread.sendMessage",
    });
    expect(
      host.client.getSnapshot().inputQueues[host.thread.id]?.items.map((item) => item.message.id),
    ).toEqual([held.id]);
    host.client.dispose();
  });

  it("steers under one key until the Host answers, and under a new one after", async () => {
    const host = await queueHost();
    host.client.activateThread(host.thread.id);
    await vi.waitFor(() =>
      expect(host.client.getSnapshot().inputQueues[host.thread.id]).toBeDefined(),
    );
    const queuedIds = () =>
      host.client.getSnapshot().inputQueues[host.thread.id]?.items.map((item) => item.message.id);
    const keys = () => host.dispatched.map((command) => String(command.idempotencyKey));
    const claimed = () =>
      json({ input: { ...pendingInput(host.queued), runId: host.runId, state: "claimed" } }, 202);

    // A lost answer keeps the key and rereads the queue; nothing is dropped.
    host.answerWith(() => {
      throw new Error("Socket hung up");
    });
    await expect(host.client.steerThreadInput(host.thread.id, host.queued.id)).rejects.toThrow();
    await vi.waitFor(() => expect(host.reads()).toBe(2));
    await host.client.loadThreadInputQueue(host.thread.id);
    expect(queuedIds()).toEqual([host.queued.id]);

    host.answerWith(claimed);
    await host.client.steerThreadInput(host.thread.id, host.queued.id);
    expect(host.dispatched.map((command) => command.type)).toEqual([
      "thread.input.steer",
      "thread.input.steer",
    ]);
    expect(host.dispatched[1]).toMatchObject({
      expectedRunId: host.runId,
      messageId: host.queued.id,
      threadId: host.thread.id,
    });
    expect(keys()[0]).toMatch(/^input-steer:/);
    expect(keys()[1]).toBe(keys()[0]);
    expect(queuedIds()).toEqual([]);

    // The Host restored the message after a refusal: promoting it again is a
    // new mutation, not a replay of the one it answered.
    await host.client.loadThreadInputQueue(host.thread.id);
    expect(queuedIds()).toEqual([host.queued.id]);
    await host.client.steerThreadInput(host.thread.id, host.queued.id);
    expect(keys()[2]).not.toBe(keys()[1]);

    // A refusal the Host states settles the attempt just as an acceptance does.
    await host.client.loadThreadInputQueue(host.thread.id);
    host.answerWith(() =>
      json({ error: { code: "conflict", message: "The Run moved on.", retryable: false } }, 409),
    );
    await expect(
      host.client.steerThreadInput(host.thread.id, host.queued.id),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(queuedIds()).toEqual([host.queued.id]);
    host.answerWith(claimed);
    await host.client.steerThreadInput(host.thread.id, host.queued.id);
    expect(keys()[4]).not.toBe(keys()[3]);

    // Without a Run the queue names as steerable there is nothing to send.
    host.steerRunId = null;
    await host.client.loadThreadInputQueue(host.thread.id);
    await expect(host.client.steerThreadInput(host.thread.id, host.queued.id)).rejects.toThrow(
      "This message cannot be steered right now.",
    );
    expect(host.dispatched).toHaveLength(5);
    host.client.dispose();
  });

  it("stops offering Steer into a Run the moment the stream says it ended", async () => {
    const host = await queueHost();
    host.client.activateThread(host.thread.id);
    await vi.waitFor(() =>
      expect(host.client.getSnapshot().inputQueues[host.thread.id]?.steerRunId).toBe(host.runId),
    );
    // The read that follows is held back: what the tray offers in between is
    // the projection's alone.
    host.holdReads();
    host.socket.receive({
      events: [
        agentEvent(host.workspace.id, host.thread.id, host.runId, "1", "run.completed", {
          replyMessageId: null,
          status: "completed",
        }),
      ],
      type: "host.events",
    });
    expect(host.client.getSnapshot().inputQueues[host.thread.id]?.steerRunId).toBeNull();
    host.steerRunId = null;
    host.releaseReads();
    await vi.waitFor(() => expect(host.reads()).toBe(2));
    host.client.dispose();
  });

  it("lets go of a Thread's queue the reader has left rather than reading it per event", async () => {
    const host = await queueHost();
    host.client.activateThread(host.thread.id);
    await vi.waitFor(() =>
      expect(host.client.getSnapshot().inputQueues[host.thread.id]).toBeDefined(),
    );
    expect(host.reads()).toBe(1);

    // Another Thread on screen: its own first read is not this queue's.
    host.client.activateThread(createId("thread"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = host.reads();
    host.socket.receive({
      events: [
        agentEvent(host.workspace.id, host.thread.id, null, "1", "thread.input-queue-updated", {
          paused: true,
        }),
      ],
      type: "host.events",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.client.getSnapshot().inputQueues[host.thread.id]).toBeUndefined();
    expect(host.reads()).toBe(before);

    // Coming back reads it afresh.
    host.paused = true;
    host.client.activateThread(host.thread.id);
    await vi.waitFor(() =>
      expect(host.client.getSnapshot().inputQueues[host.thread.id]?.paused).toBe(true),
    );
    expect(host.reads()).toBe(before + 1);
    host.client.dispose();
  });

  it("withdraws a queued message from the queue and the conversation together", async () => {
    const host = await queueHost();
    host.client.activateThread(host.thread.id);
    await vi.waitFor(() =>
      expect(host.client.getSnapshot().inputQueues[host.thread.id]).toBeDefined(),
    );
    const transcript = () => host.client.getSnapshot().transcripts[host.thread.id] ?? [];
    const queuedIds = () =>
      host.client.getSnapshot().inputQueues[host.thread.id]?.items.map((item) => item.message.id);

    // The message reached the conversation through the stream, as every send does.
    host.socket.receive({
      events: [
        agentEvent(host.workspace.id, host.thread.id, null, "1", "message.created", {
          input: pendingInput(host.queued),
          message: host.queued,
        }),
      ],
      type: "host.events",
    });
    expect(transcript()).toContainEqual(expect.objectContaining({ id: host.queued.id }));
    await vi.waitFor(() => expect(host.reads()).toBe(2));
    await host.client.loadThreadInputQueue(host.thread.id);

    // A lost answer is retried under the same key, never as a second withdrawal.
    host.answerWith(() => {
      throw new Error("Socket hung up");
    });
    await expect(host.client.cancelThreadInput(host.thread.id, host.queued.id)).rejects.toThrow();
    await vi.waitFor(() => expect(host.reads()).toBe(3));
    await host.client.loadThreadInputQueue(host.thread.id);
    expect(queuedIds()).toEqual([host.queued.id]);

    host.items = [];
    host.answerWith(() =>
      json(
        { input: { ...pendingInput(host.queued), cancelReason: "withdrawn", state: "cancelled" } },
        202,
      ),
    );
    await host.client.cancelThreadInput(host.thread.id, host.queued.id);
    expect(host.dispatched.map((command) => command.type)).toEqual([
      "thread.input.cancel",
      "thread.input.cancel",
    ]);
    expect(host.dispatched[1]).toMatchObject({
      idempotencyKey: host.dispatched[0]?.idempotencyKey,
      messageId: host.queued.id,
      threadId: host.thread.id,
    });
    expect(String(host.dispatched[0]?.idempotencyKey)).toMatch(/^input-cancel:/);
    expect(queuedIds()).toEqual([]);
    const withdrawn = () => transcript().filter((entry) => entry.id === host.queued.id);
    expect(withdrawn()).toEqual([expect.objectContaining({ kind: "withdrawn" })]);
    expect(visibleTranscript(transcript(), null)).not.toContainEqual(
      expect.objectContaining({ id: host.queued.id }),
    );

    // The stream's confirmation changes nothing.
    host.socket.receive({
      events: [
        agentEvent(host.workspace.id, host.thread.id, null, "2", "thread-input.updated", {
          input: { ...pendingInput(host.queued), cancelReason: "withdrawn", state: "cancelled" },
        }),
      ],
      type: "host.events",
    });
    await vi.waitFor(() => expect(host.reads()).toBe(4));
    expect(withdrawn()).toEqual([expect.objectContaining({ kind: "withdrawn" })]);
    expect(queuedIds()).toEqual([]);
    host.client.dispose();
  });
});

/**
 * A Host with one Thread mid-Run and one message waiting behind it. The
 * queue it answers with is whatever the test last said it holds, so a test
 * moves the Host's truth and watches the client follow.
 */
async function queueHost() {
  const workspace = makeWorkspace();
  const thread = makeThread(workspace.id);
  const runId = createId("run");
  const queued = { ...makeMessage(thread.id, "input", "Then rename the branch"), runId: null };
  const dispatched: Record<string, unknown>[] = [];
  const sockets: FakeSocket[] = [];
  let reads = 0;
  let gate: Promise<void> | null = null;
  let release: (() => void) | null = null;
  let answer: (body: Record<string, unknown>) => Response = () => json({}, 202);
  const state = {
    items: [queueItem(queued, true)] as ReturnType<typeof queueItem>[],
    paused: false,
    steerRunId: runId as string | null,
  };
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const path = url.pathname;
    switch (path) {
      case "/v1/rpc/thread.inputQueue.get": {
        const read = JSON.parse(url.searchParams.get("input") ?? "{}") as { threadId?: string };
        if (read.threadId !== thread.id) {
          return json(
            {
              error: { code: "not_found", message: "Thread not found", retryable: false },
              ok: false,
            },
            404,
          );
        }
        reads += 1;
        if (gate) await gate;
        return json({
          items: state.items,
          paused: state.paused,
          steerRunId: state.steerRunId,
          threadId: thread.id,
        });
      }
      case "/v1/rpc/thread.events.list":
        return json({
          thread,
          events: [],
          threadId: thread.id,
          window: {
            byteCount: 2,
            hasMore: false,
            itemCount: 0,
            nextBefore: null,
            threadId: thread.id,
            totalItems: 0,
          },
        });
      case "/v1/rpc/thread.requests.list":
        return json({
          requests: [],
          threadId: thread.id,
          window: { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 },
        });
      case "/v1/rpc/commands.dispatch": {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        dispatched.push(body);
        return answer(body);
      }
      default:
        return json(bootstrap([workspace]));
    }
  }) as unknown as typeof globalThis.fetch;
  const client = createHttpHostClient({
    fetch,
    refreshIntervalMs: 0,
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  await client.load();
  const socket = sockets[0]!;
  socket.open();
  socket.receive({
    snapshot: {
      ...workspaceSnapshot(workspace, "0"),
      runQueue: [
        { createdAt: now, id: runId, runOrdinal: 0, status: "running", threadId: thread.id },
      ],
      threads: [{ ...thread, status: "running" }],
    },
    type: "host.snapshot",
  });
  return {
    answerWith: (next: (body: Record<string, unknown>) => Response) => {
      answer = next;
    },
    client,
    dispatched,
    holdReads: () => {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    get items() {
      return state.items;
    },
    set items(items: ReturnType<typeof queueItem>[]) {
      state.items = items;
    },
    get paused() {
      return state.paused;
    },
    set paused(paused: boolean) {
      state.paused = paused;
    },
    queued,
    reads: () => reads,
    releaseReads: () => {
      gate = null;
      release?.();
      release = null;
    },
    runId,
    socket,
    get steerRunId() {
      return state.steerRunId;
    },
    set steerRunId(steerRunId: string | null) {
      state.steerRunId = steerRunId;
    },
    thread,
    workspace,
  };
}

function pendingInput(message: Message) {
  return { ...makeThreadInput(message), deliveredAt: null, runId: null, state: "pending" as const };
}

function queueItem(message: Message, canSteer: boolean) {
  return { canCancel: true, canMove: true, canSteer, input: pendingInput(message), message };
}

describe("HttpHostClient Home prefetch", () => {
  function homeStartup() {
    const workspace = makeWorkspace();
    const home: Thread = { ...makeThread(workspace.id), role: "conversation" };
    workspace.homeThreadId = home.id;
    const history: ReturnType<typeof Promise.withResolvers<Response>>[] = [];
    const operations: string[] = [];
    const commands: string[] = [];
    const sockets: FakeSocket[] = [];
    let refuse = false;
    const page = (title = "Home", asOfSequence = "7") => ({
      threadId: home.id,
      thread: { ...home, title },
      events: [],
      readState: {
        ...defaultReadState(home.id),
        asOfSequence,
        readSequence: "2",
        unreadSequence: "7",
      },
      window: {
        threadId: home.id,
        byteCount: 0,
        itemCount: 0,
        totalItems: 0,
        hasMore: false,
        nextBefore: null,
      },
    });
    const client = createHttpHostClient({
      prefetchHome: true,
      refreshIntervalMs: 0,
      browserUsageReads: "observed",
      timeZoneReports: "observed",
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const name = url.pathname.slice("/v1/rpc/".length);
        operations.push(name);
        if (name === "thread.events.list") {
          const read = Promise.withResolvers<Response>();
          history.push(read);
          return read.promise;
        }
        if (name === "auth.config" && refuse)
          return json(
            { error: { code: "unauthorized", message: "Sign in", retryable: false } },
            401,
          );
        if (name === "commands.dispatch") {
          const command = rpcPayload(url, init);
          commands.push(requiredString(command, "type"));
          if (command.type === "viewer.timeZone.update")
            return json({ timeZone: command.timeZone });
        }
        return json(bootstrap([workspace]));
      },
    });
    return {
      client,
      commands,
      history,
      home,
      operations,
      page,
      sockets,
      workspace,
      refuse: () => {
        refuse = true;
      },
      close: () => {
        client.dispose();
        for (const read of history) read.resolve(json(page()));
      },
    };
  }

  it("does not read Home's history before it opens when the client does not prefetch", async () => {
    const workspace = makeWorkspace();
    const home: Thread = { ...makeThread(workspace.id), role: "conversation" };
    workspace.homeThreadId = home.id;
    const operations: string[] = [];
    const client = createHttpHostClient({
      refreshIntervalMs: 0,
      webSocketFactory: () => new FakeSocket(),
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        operations.push(url.pathname.slice("/v1/rpc/".length));
        return json(bootstrap([workspace]));
      },
    });
    try {
      await client.load();
      // An unopened Home stays outside the Workspace's Thread page on clients
      // that do not open on Chat, so its Thread list never depends on timing.
      expect(operations).not.toContain("thread.events.list");
      expect(client.getSnapshot().threads.map(({ id }) => id)).not.toContain(home.id);
    } finally {
      client.dispose();
    }
  });

  it.each(["pending", "ready"] as const)(
    "starts Home history before activation, joins the %s prefetch and never marks reading",
    async (state) => {
      const run = homeStartup();
      try {
        await run.client.load();
        expect(run.history).toHaveLength(1);
        expect(run.client.getSnapshot().savedViewReadiness?.home.status).toBe("unknown");
        const accepted: string[] = [];
        run.client.subscribe(() => {
          const snapshot = run.client.getSnapshot();
          if (snapshot.savedViewReadiness?.home.status !== "window") return;
          expect(snapshot.threadReadStates[run.home.id]?.asOfSequence).toBe("7");
          expect(snapshot.transcriptWindows[run.home.id]).toEqual(run.page().window);
          accepted.push(snapshot.savedViewReadiness.home.threadId);
        });
        expect(run.operations).not.toContain("thread.browserUsage.get");
        expect(run.operations).not.toContain("thread.assignments.list");
        expect(run.commands).not.toContain("thread.read.mark");
        if (state === "ready") {
          run.history[0]!.resolve(json(run.page()));
          await vi.waitFor(() =>
            expect(run.client.getSnapshot().threadReadStates[run.home.id]?.readSequence).toBe("2"),
          );
        }
        run.client.activateThread(run.home.id);
        expect(run.history).toHaveLength(1);
        run.history[0]!.resolve(json(run.page()));
        await vi.waitFor(() =>
          expect(
            run.client.getSnapshot().threads.find(({ id }) => id === run.home.id)?.unread,
          ).toBe(true),
        );
        run.client.activateThread(run.home.id);
        expect(run.history).toHaveLength(1);
        expect(run.client.getSnapshot().threadReadStates[run.home.id]?.readSequence).toBe("2");
        expect(run.client.getSnapshot().savedViewReadiness?.home).toEqual({
          status: "window",
          threadId: run.home.id,
          workspaceId: run.workspace.id,
          latest: true,
        });
        expect(accepted).toContain(run.home.id);
        expect(run.commands).not.toContain("thread.read.mark");
      } finally {
        run.close();
      }
    },
  );

  it.each([
    ["pending", "5"],
    ["pending", "7"],
    ["ready", "5"],
    ["ready", "7"],
  ] as const)(
    "keeps the %s Home read when its coverage includes snapshot %s",
    async (state, sequence) => {
      const run = homeStartup();
      try {
        await run.client.load();
        run.client.activateThread(run.home.id);
        if (state === "ready") {
          run.history[0]!.resolve(json(run.page()));
          await vi.waitFor(() =>
            expect(run.client.getSnapshot().threadReadStates[run.home.id]?.asOfSequence).toBe("7"),
          );
        }
        const socket = run.sockets[0]!;
        socket.open();
        socket.receive({
          snapshot: { ...workspaceSnapshot(run.workspace, sequence), threads: [run.home] },
          type: "host.snapshot",
        });
        run.history[0]!.resolve(json(run.page()));
        await vi.waitFor(() => {
          expect(run.client.getSnapshot().threadLookups[run.home.id]).toBeUndefined();
          expect(run.history).toHaveLength(1);
        });
        run.client.activateThread(run.home.id);
        expect(run.history).toHaveLength(1);
      } finally {
        run.close();
      }
    },
  );

  it("reads Home again when a Workspace snapshot overtakes its prefetch", async () => {
    const run = homeStartup();
    try {
      await run.client.load();
      expect(run.history).toHaveLength(1);
      const socket = run.sockets[0]!;
      socket.open();
      socket.receive({
        snapshot: { ...workspaceSnapshot(run.workspace, "8"), threads: [run.home] },
        type: "host.snapshot",
      });
      run.history[0]!.resolve(json(run.page("Read before the snapshot")));
      await vi.waitFor(() => expect(run.history).toHaveLength(2));
      expect(run.client.getSnapshot().savedViewReadiness?.home.status).toBe("unknown");
      run.history[1]!.resolve(json(run.page("Read after the snapshot", "9")));
      await vi.waitFor(() =>
        expect(run.client.getSnapshot().threads.find(({ id }) => id === run.home.id)?.title).toBe(
          "Read after the snapshot",
        ),
      );
      expect(run.client.getSnapshot().savedViewReadiness?.home).toMatchObject({
        status: "window",
        threadId: run.home.id,
        latest: true,
      });
      run.client.activateThread(run.home.id);
      expect(run.history).toHaveLength(2);
      expect(run.commands).not.toContain("thread.read.mark");
    } finally {
      run.close();
    }
  });

  it.each([true, false])(
    "withdraws Home readiness before an unshown snapshot replaces its transcript (omitted=%s)",
    async (messagesOmitted) => {
      const run = homeStartup();
      const publications: { home: SavedViewReadiness["home"]; text: string | undefined }[] = [];
      try {
        await run.client.load();
        const message = makeMessage(run.home.id, "input", "Keep this useful tail");
        const acceptedPage = {
          ...run.page(),
          events: [
            agentEvent(run.workspace.id, run.home.id, message.runId, "7", "message.created", {
              input: makeThreadInput(message),
              message,
            }),
          ],
        };
        run.history[0]!.resolve(json(acceptedPage));
        await vi.waitFor(() =>
          expect(projectSavedHome(run.client.getSnapshot())?.messages).toEqual([
            { voice: "mine", text: "Keep this useful tail" },
          ]),
        );
        run.client.subscribe(() => {
          const snapshot = run.client.getSnapshot();
          publications.push({
            home: snapshot.savedViewReadiness!.home,
            text: projectSavedHome(snapshot)
              ?.messages.map(({ text }) => text)
              .join(""),
          });
        });
        const socket = run.sockets[0]!;
        socket.open();
        publications.length = 0;
        socket.receive({
          snapshot: {
            // Newer than the accepted page (7), so that history no longer covers it.
            ...workspaceSnapshot(run.workspace, "8"),
            threads: [run.home],
            ...(messagesOmitted ? { messagesOmitted: true } : {}),
          },
          type: "host.snapshot",
        });
        expect(publications.length).toBeGreaterThan(0);
        expect(
          publications.every(({ home, text }) => home.status === "unknown" && text === undefined),
        ).toBe(true);
        expect(run.client.getSnapshot().transcripts[run.home.id]).toEqual(
          messagesOmitted ? undefined : [],
        );
        run.client.activateThread(run.home.id);
        await vi.waitFor(() => expect(run.history).toHaveLength(2));
        expect(
          publications.every(({ home, text }) => home.status === "unknown" && text === undefined),
        ).toBe(true);
        run.history[1]!.resolve(
          json({ error: { code: "internal", message: "Lost history", retryable: true } }, 500),
        );
        await vi.waitFor(() =>
          expect(run.client.getSnapshot().threadLookups[run.home.id]).toBe("failed"),
        );
        expect(
          publications.every(({ home, text }) => home.status === "unknown" && text === undefined),
        ).toBe(true);
        // A successful replacement, including an explicitly empty one, certifies a new window.
        run.client.activateThread(run.home.id);
        await vi.waitFor(() => expect(run.history).toHaveLength(3));
        expect(run.client.getSnapshot().savedViewReadiness?.home.status).toBe("unknown");
        run.history[2]!.resolve(json(run.page()));
        await vi.waitFor(() =>
          expect(run.client.getSnapshot().savedViewReadiness?.home.status).toBe("window"),
        );
        expect(projectSavedHome(run.client.getSnapshot())?.messages).toEqual([]);
      } finally {
        run.close();
      }
    },
  );

  it("never publishes a historical Home window as an accepted latest tail", async () => {
    const run = homeStartup();
    try {
      await run.client.load();
      run.history[0]!.resolve(json(run.page()));
      await vi.waitFor(() =>
        expect(run.client.getSnapshot().savedViewReadiness?.home.status).toBe("window"),
      );
      const historicalReadiness: boolean[] = [];
      run.client.subscribe(() => {
        const snapshot = run.client.getSnapshot();
        const home = snapshot.savedViewReadiness?.home;
        if (snapshot.transcriptWindows[run.home.id]?.byteCount === 1 && home?.status === "window")
          historicalReadiness.push(home.latest);
      });
      const reading = run.client.loadTranscriptAround(run.home.id, createId("message"));
      await vi.waitFor(() => expect(run.history).toHaveLength(2));
      run.history[1]!.resolve(
        json({ ...run.page(), window: { ...run.page().window, byteCount: 1 } }),
      );
      await reading;
      expect(historicalReadiness.length).toBeGreaterThan(0);
      expect(historicalReadiness).not.toContain(true);
    } finally {
      run.close();
    }
  });

  it("accepts only the current Home when bootstrap replaces an in-flight prefetch", async () => {
    const run = homeStartup();
    try {
      await run.client.load();
      const replacement = { ...makeThread(run.workspace.id), role: "conversation" as const };
      run.workspace.homeThreadId = replacement.id;
      await run.client.refresh();
      expect(run.history).toHaveLength(2);
      expect(run.client.getSnapshot().homeThreadId).toBe(replacement.id);
      run.history[0]!.resolve(json(run.page("Previous Home")));
      await vi.waitFor(() =>
        expect(run.client.getSnapshot().threadLookups[run.home.id]).toBeUndefined(),
      );
      expect(run.client.getSnapshot().savedViewReadiness?.home.status).toBe("unknown");
      run.history[1]!.resolve(
        json({
          ...run.page(),
          thread: replacement,
          threadId: replacement.id,
          readState: { ...run.page().readState, threadId: replacement.id },
          window: { ...run.page().window, threadId: replacement.id },
        }),
      );
      await vi.waitFor(() =>
        expect(run.client.getSnapshot().savedViewReadiness?.home).toEqual({
          status: "window",
          threadId: replacement.id,
          workspaceId: run.workspace.id,
          latest: true,
        }),
      );
    } finally {
      run.close();
    }
  });

  it("retains a covered Home prefetch when its snapshot arrives before activation", async () => {
    const run = homeStartup();
    try {
      await run.client.load();
      run.history[0]!.resolve(json(run.page()));
      await vi.waitFor(() =>
        expect(run.client.getSnapshot().threadReadStates[run.home.id]?.asOfSequence).toBe("7"),
      );
      const socket = run.sockets[0]!;
      socket.open();
      socket.receive({
        snapshot: { ...workspaceSnapshot(run.workspace, "7"), threads: [run.home] },
        type: "host.snapshot",
      });
      // Covered history stays, and so does the readiness it certified.
      expect(run.client.getSnapshot().savedViewReadiness?.home.status).toBe("window");
      run.client.activateThread(run.home.id);
      expect(run.history).toHaveLength(1);
      expect(run.client.getSnapshot().threadLookups[run.home.id]).toBeUndefined();
    } finally {
      run.close();
    }
  });

  it("retries a failed prefetch through the hydration owner on activation", async () => {
    const run = homeStartup();
    try {
      await run.client.load();
      expect(run.history).toHaveLength(1);
      run.history[0]!.resolve(
        json({ error: { code: "internal", message: "Lost history", retryable: true } }, 500),
      );
      await vi.waitFor(() =>
        expect(run.client.getSnapshot().threadLookups[run.home.id]).toBe("failed"),
      );
      expect(run.client.getSnapshot().savedViewReadiness?.home.status).toBe("unknown");
      run.client.activateThread(run.home.id);
      expect(run.history).toHaveLength(2);
      run.history[1]!.resolve(json(run.page()));
      await vi.waitFor(() =>
        expect(run.client.getSnapshot().threadLookups[run.home.id]).toBeUndefined(),
      );
      expect(run.commands).not.toContain("thread.read.mark");
    } finally {
      run.close();
    }
  });

  it("starts fresh hydration after sign-out and fences the previous viewer's pending history", async () => {
    const run = homeStartup();
    try {
      await run.client.load();
      expect(run.history).toHaveLength(1);
      run.refuse();
      await run.client.rpc["auth.config"]({});
      expect(run.client.getSnapshot().homeThreadId).toBeNull();
      expect(run.client.getSnapshot().savedViewReadiness?.home.status).toBe("unknown");
      await run.client.reauthenticate();
      expect(run.history).toHaveLength(2);
      expect(run.client.getSnapshot().savedViewReadiness?.home.status).toBe("unknown");
      run.history[0]!.resolve(json(run.page("Old viewer")));
      run.history[1]!.resolve(json(run.page("Current viewer")));
      await vi.waitFor(() =>
        expect(run.client.getSnapshot().threads.find(({ id }) => id === run.home.id)?.title).toBe(
          "Current viewer",
        ),
      );
      expect(run.commands).not.toContain("thread.read.mark");
    } finally {
      run.close();
    }
  });
});

describe("HttpHostClient catalog startup", () => {
  function startup(options: { readonly failSession?: number } = {}) {
    const workspace = makeWorkspace();
    const seed = new MockHostClient();
    const saved = seed.getSnapshot().workspaceTabs!.find((group) => group.tabs?.length)!;
    seed.dispose();
    const group = { ...saved, session: { ...saved.session, workspaceId: workspace.id } };
    const sessions = Array.from({ length: 4 }, () => ({
      ...group.session,
      id: createBrowserSessionId(),
      tabCatalog: undefined,
      state: "ready" as const,
    }));
    const body = bootstrap([workspace], {
      available: true,
      profiles: [],
      profileGrants: [],
      placements: [],
      workspaceTabRestoreVersion: 1,
      workspaceTabs: [{ ...group, tabs: undefined }],
      sessions,
    });
    const socket = new FakeSocket();
    const sockets: FakeSocket[] = [];
    const pending: { answer: () => void }[] = [];
    const readSessions: string[] = [];
    let hold = true;
    let refuse = false;
    let concurrent = 0;
    let maximum = 0;
    let taskReads = 0;
    const client = createHttpHostClient({
      refreshIntervalMs: 0,
      browserCatalogReads: "observed",
      taskReads: "observed",
      webSocketFactory: () => {
        sockets.push(socket);
        return socket;
      },
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname.endsWith("/auth.config") && refuse)
          return json(
            { error: { code: "unauthorized", message: "Sign in", retryable: false } },
            401,
          );
        if (url.pathname.endsWith("/tasks.list")) {
          taskReads++;
          return json({
            tasks: [],
            readStates: [],
            window: { byteCount: 0, itemCount: 0, hasMore: false, nextBefore: null, totalItems: 0 },
          });
        }
        const isGroup = url.pathname.endsWith("/workspace.tabs.get");
        if (isGroup || url.pathname.endsWith("/browser.tabs.get")) {
          const sessionId = isGroup ? null : requiredString(rpcPayload(url, init), "sessionId");
          if (sessionId) readSessions.push(sessionId);
          if (options.failSession !== undefined && sessionId === sessions[options.failSession]!.id)
            return json(
              { error: { code: "internal", message: "Catalog unavailable", retryable: true } },
              500,
            );
          if (!hold)
            return json(
              isGroup ? { ...group, revision: 2 } : { generation: 1, revision: 1, tabs: [] },
            );
          concurrent++;
          maximum = Math.max(maximum, concurrent);
          try {
            await new Promise<void>((answer) => pending.push({ answer }));
            return json(
              isGroup ? { ...group, revision: 1 } : { generation: 1, revision: 1, tabs: [] },
            );
          } finally {
            concurrent--;
          }
        }
        return json(body);
      },
    });
    const loaded = client.load();
    return {
      body,
      client,
      group,
      loaded,
      pending,
      readSessions,
      sessions,
      socket,
      sockets,
      maximum: () => maximum,
      taskReads: () => taskReads,
      release: () => {
        hold = false;
        for (const request of pending) request.answer();
      },
      unhold: () => {
        hold = false;
      },
      refuse: () => {
        refuse = true;
      },
    };
  }

  it("starts realtime and tasks before bounded catalog recovery and keeps newer catalogs", async () => {
    const run = startup();
    try {
      await vi.waitFor(() => expect(run.pending.length).toBeGreaterThan(0));
      expect(run.sockets).toHaveLength(1);
      run.socket.open();
      expect(parseSent(run.socket, 0)).toMatchObject({ type: "client.subscribe" });
      expect(run.taskReads()).toBeGreaterThan(0);
      expect(run.pending).toHaveLength(3);
      // A newer lineage read and realtime catalog can win while recovery waits.
      run.unhold();
      await run.client.readWorkspaceTabs(run.group.id);
      run.socket.receive({
        type: "host.browser-tabs-changed",
        sessionId: run.sessions[0]!.id,
        catalog: { generation: 2, revision: 2, tabs: [] },
      });
      run.release();
      await run.loaded;
      expect(run.maximum()).toBe(3);
      expect(new Set(run.readSessions)).toEqual(new Set(run.sessions.map(({ id }) => id)));
      expect(run.client.getSnapshot().workspaceTabs?.[0]?.revision).toBe(2);
      expect(run.client.getSnapshot().browserSessions[0]?.tabCatalog).toMatchObject({
        generation: 2,
        revision: 2,
      });
      expect(
        run.client
          .getSnapshot()
          .browserSessions.slice(1)
          .every((session) => session.tabCatalog?.revision === 1),
      ).toBe(true);
    } finally {
      run.release();
      await run.loaded.catch(() => undefined);
      run.client.dispose();
    }
  });

  it("recovers every other catalog when one read fails, then reports that failure", async () => {
    const run = startup({ failSession: 0 });
    try {
      run.release();
      const outcome = await run.loaded.then(
        () => null,
        (error: unknown) => error,
      );
      // Five reads in batches of three: the failure is in the first batch.
      expect(new Set(run.readSessions)).toEqual(new Set(run.sessions.map(({ id }) => id)));
      expect(run.client.getSnapshot().workspaceTabs?.[0]?.revision).toBe(2);
      const catalogs = run.client.getSnapshot().browserSessions.map(({ tabCatalog }) => tabCatalog);
      expect(catalogs[0]).toBeUndefined();
      expect(catalogs.slice(1).every((catalog) => catalog?.revision === 1)).toBe(true);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain("Catalog unavailable");
    } finally {
      run.release();
      await run.loaded.catch(() => undefined);
      run.client.dispose();
    }
  });

  it("discards recovery from before sign-out even when the same viewer signs in again", async () => {
    const run = startup();
    try {
      await vi.waitFor(() => expect(run.pending.length).toBeGreaterThan(0));
      run.refuse();
      await run.client.rpc["auth.config"]({});
      expect(run.client.getSnapshot().session).toBe("authentication-required");
      run.body.browser.workspaceTabs = [{ ...run.group, revision: 0, tabs: [] }];
      run.body.browser.sessions = run.sessions.map((session) => ({
        ...session,
        tabCatalog: { generation: 0, revision: 0, tabs: [] },
      }));
      run.unhold();
      await run.client.reauthenticate();
      run.release();
      await run.loaded;
      expect(run.client.getSnapshot().workspaceTabs?.[0]?.revision).toBe(0);
      expect(
        run.client
          .getSnapshot()
          .browserSessions.every((session) => session.tabCatalog?.revision === 0),
      ).toBe(true);
    } finally {
      run.release();
      await run.loaded.catch(() => undefined);
      run.client.dispose();
    }
  });
});

describe("HttpHostClient hosted browser", () => {
  it("reconciles browser Watch targets learned over HTTP while realtime is disconnected", async () => {
    const workspace = makeWorkspace();
    const sessionId = createBrowserSessionId();
    const tabId = BrowserSurfaceIdSchema.parse("surface_http-outage");
    const browser: HostedBrowserBootstrap = {
      available: true,
      placements: [],
      profiles: [],
      profileGrants: [],
      sessions: [],
    };
    const connections: string[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace], browser)),
      refreshIntervalMs: 0,
      webSocketFactory: (url) => {
        connections.push(url);
        return new FakeSocket();
      },
    });
    try {
      await client.load();
      expect(client.getSnapshot().session).toBe("authenticated");
      const release = client.retainBrowserWatch(sessionId, tabId);
      expect(connections.some((url) => url.includes("/browser-sessions/"))).toBe(false);
      browser.sessions = [
        {
          id: sessionId,
          access: "full-control",
          origin: "workspace",
          state: "ready",
          createdAt: now,
          updatedAt: now,
          workspaceId: workspace.id,
          profileId: null,
          runtimeId: "runtime-1",
          placement: { kind: "runner", runnerId },
          tabCatalog: {
            generation: 1,
            revision: 1,
            tabs: [
              {
                id: tabId,
                title: "HTTP-discovered tab",
                site: "https://example.test",
                iconRef: null,
                order: 0,
                openerId: null,
                availability: "ready",
                documentId: null,
                occupants: [],
              },
            ],
          },
        },
      ];
      await client.refresh();
      expect(client.getSnapshot().connection).not.toBe("connected");
      expect(connections.filter((url) => url.includes("/browser-sessions/"))).toHaveLength(1);
      release();
    } finally {
      client.dispose();
    }
  });

  it("keeps hot Runtime frames outside the global snapshot and sends explicit commands", async () => {
    const workspace = makeWorkspace();
    const profileId = createId("browserProfile");
    const sessionId = createBrowserSessionId();
    const sockets: Array<{ socket: FakeSocket; url: string }> = [];
    const browser: HostedBrowserBootstrap = {
      profileGrants: [],
      available: true,
      placements: [
        {
          available: true,
          environmentIds: [],
          kind: "runner",
          label: "Main Host",
          runnerId: runnerId,
          runtimeId: "runtime-1",
        },
      ],
      profiles: [{ id: profileId, name: "Default browser", revision: 0 }],
      sessions: [],
    };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/v1/rpc/bootstrap.get") return json(bootstrap([workspace], browser));
      if (path === "/v1/rpc/commands.dispatch") {
        return json(
          {
            session: {
              access: "full-control",
              createdAt: now,
              id: sessionId,
              origin: "workspace",
              placement: { kind: "runner", runnerId: runnerId },
              profileId,
              runtimeId: "runtime-1",
              state: "ready",
              updatedAt: now,
              workspaceId: workspace.id,
            },
            wasExisting: false,
          },
          201,
        );
      }
      throw new Error(`Unexpected request ${path}`);
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      viewerPlatform: "mac",
      random: () => 0,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 5,
      refreshIntervalMs: 0,
      webSocketFactory: (url) => {
        const socket = new FakeSocket();
        sockets.push({ socket, url });
        return socket;
      },
    });
    await client.load();
    expect(client.getSnapshot().browserAvailable).toBe(true);

    await client.startBrowser(workspace.id, { kind: "profile", profileId });
    expect(sockets.some(({ url }) => url.includes("/browser-sessions/"))).toBe(false);
    const releaseViewer = client.retainBrowserViewer(sessionId);
    const releaseSecondViewer = client.retainBrowserViewer(sessionId);
    const browserSocket = sockets.find(({ url }) => url.includes("/browser-sessions/"))?.socket;
    expect(browserSocket).toBeDefined();
    expect(browserSocket?.binaryType).toBe("arraybuffer");
    browserSocket?.open();
    browserSocket?.receiveRaw({
      access: "full-control",
      dialog: {
        id: "00000000-0000-4000-8000-0000000000d1",
        message: "Continue?",
        surfaceId: "page-1",
        type: "confirm",
      },
      sessionId,
      state: "ready",
      surfaces: [
        {
          active: true,
          id: "page-1",
          title: "Example",
          url: "https://example.com/",
        },
      ],
      type: "browser.snapshot",
    });
    const target = client.browserFrames.editing!.target(sessionId, "page-1");
    await target.send({ kind: "command", command: "selectAll" });
    expect(parseSent(browserSocket!, browserSocket!.sent.length - 2)).toMatchObject({
      type: "input.key",
      action: "down",
      key: "a",
      modifiers: ["meta"],
    });
    const copy = target.send({ kind: "copy" });
    browserSocket!.receiveRaw({
      type: "clipboard.data",
      surfaceId: "page-1",
      text: "personal copy",
    });
    expect(await copy).toMatchObject({ outcome: "copied" });
    const snapshotBeforeFrame = client.getSnapshot();
    const snapshotListener = vi.fn();
    const frameListener = vi.fn();
    const unsubscribeSnapshot = client.subscribe(snapshotListener);
    const unsubscribeFrame = client.browserFrames.subscribe(sessionId, frameListener);
    browserSocket?.receiveBinary(browserFrame(9));

    expect(client.getSnapshot()).toBe(snapshotBeforeFrame);
    expect(snapshotListener).not.toHaveBeenCalled();
    expect(frameListener).toHaveBeenCalledTimes(1);
    expect(client.getSnapshot().browserSessions[0]).toMatchObject({
      id: sessionId,
      state: "ready",
      tabs: [{ active: true, title: "Example", url: "https://example.com/" }],
      viewerState: "synchronized",
    });
    expect(client.browserFrames.get(sessionId)?.header.frameId).toBe(9);

    client.sendBrowserCommand(sessionId, { type: "navigation.reload" });
    expect(JSON.parse(browserSocket?.sent.at(-1) ?? "{}")).toEqual({
      type: "navigation.reload",
    });
    client.sendBrowserCommand(sessionId, {
      accept: true,
      dialogId: "00000000-0000-4000-8000-0000000000d1",
      type: "dialog.respond",
    });
    expect(client.getSnapshot().browserSessions[0]?.dialog).toMatchObject({
      message: "Continue?",
    });
    browserSocket?.receiveRaw({
      dialog: null,
      type: "browser.dialog.changed",
    });
    expect(client.getSnapshot().browserSessions[0]?.dialog).toBeNull();
    releaseViewer();
    expect(browserSocket?.readyState).toBe(1);
    browserSocket?.close();
    expect(() =>
      client.sendBrowserCommand(sessionId, { type: "stream.unsubscribe" }),
    ).not.toThrow();
    expect(() => client.sendBrowserCommand(sessionId, { type: "navigation.reload" })).toThrow(
      "The browser view is not synchronized.",
    );
    expect(client.getSnapshot().browserSessions[0]).toMatchObject({
      state: "ready",
      viewerState: "connecting",
    });
    releaseSecondViewer();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(sockets.filter(({ url }) => url.includes("/browser-sessions/"))).toHaveLength(1);
    client.dispose();
    expect(client.browserFrames.get(sessionId)).toBeNull();
    expect(frameListener).toHaveBeenCalledTimes(2);
    unsubscribeFrame();
    unsubscribeSnapshot();
  });

  it("backs off until a viewer is synchronized and resets only after its snapshot", async () => {
    vi.useFakeTimers();
    const workspace = makeWorkspace();
    const profileId = createId("browserProfile");
    const sessionId = createBrowserSessionId();
    const sockets: Array<{ socket: FakeSocket; url: string }> = [];
    const client = createHttpHostClient({
      fetch: async () =>
        json(
          bootstrap([workspace], {
            available: true,
            placements: [
              {
                available: true,
                environmentIds: [],
                kind: "runner",
                label: "Main Host",
                runnerId: runnerId,
                runtimeId: "runtime-1",
              },
            ],
            profileGrants: [],
            profiles: [{ id: profileId, name: "Default browser", revision: 0 }],
            sessions: [
              {
                access: "full-control",
                createdAt: now,
                id: sessionId,
                origin: "workspace",
                placement: { kind: "runner", runnerId: runnerId },
                profileId,
                runtimeId: "runtime-1",
                state: "ready",
                updatedAt: now,
                workspaceId: workspace.id,
              },
            ],
          }),
        ),
      random: () => 0,
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 40,
      refreshIntervalMs: 0,
      webSocketFactory: (url) => {
        const socket = new FakeSocket();
        sockets.push({ socket, url });
        return socket;
      },
    });
    const browserSockets = () =>
      sockets.filter(({ url }) => url.includes("/browser-sessions/")).map(({ socket }) => socket);
    await client.load();
    const release = client.retainBrowserViewer(sessionId);

    browserSockets()[0]?.open();
    browserSockets()[0]?.serverClose();
    await vi.advanceTimersByTimeAsync(8);
    expect(browserSockets()).toHaveLength(2);
    browserSockets()[1]?.open();
    browserSockets()[1]?.serverClose();
    await vi.advanceTimersByTimeAsync(15);
    expect(browserSockets()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(browserSockets()).toHaveLength(3);

    browserSockets()[2]?.open();
    browserSockets()[2]?.receiveRaw({
      access: "full-control",
      dialog: null,
      sessionId,
      state: "ready",
      surfaces: [
        {
          active: true,
          id: "page-1",
          title: "Example",
          url: "https://example.com/",
        },
      ],
      type: "browser.snapshot",
    });
    browserSockets()[2]?.serverClose();
    await vi.advanceTimersByTimeAsync(8);
    expect(browserSockets()).toHaveLength(4);
    release();
    client.dispose();
  });

  it("rejects any incremental or binary event before the authoritative snapshot", async () => {
    const workspace = makeWorkspace();
    const profileId = createId("browserProfile");
    const sessionId = createBrowserSessionId();
    const sockets: Array<{ socket: FakeSocket; url: string }> = [];
    const client = createHttpHostClient({
      fetch: async () =>
        json(
          bootstrap([workspace], {
            available: true,
            placements: [
              {
                available: true,
                environmentIds: [],
                kind: "runner",
                label: "Main Host",
                runnerId: runnerId,
                runtimeId: "runtime-1",
              },
            ],
            profileGrants: [],
            profiles: [{ id: profileId, name: "Default browser", revision: 0 }],
            sessions: [
              {
                access: "full-control",
                createdAt: now,
                id: sessionId,
                origin: "workspace",
                placement: { kind: "runner", runnerId: runnerId },
                profileId,
                runtimeId: "runtime-1",
                state: "ready",
                updatedAt: now,
                workspaceId: workspace.id,
              },
            ],
          }),
        ),
      reconnectBaseDelayMs: 0,
      reconnectMaxDelayMs: 0,
      refreshIntervalMs: 0,
      webSocketFactory: (url) => {
        const socket = new FakeSocket();
        sockets.push({ socket, url });
        return socket;
      },
    });
    await client.load();
    const release = client.retainBrowserViewer(sessionId);
    const socket = sockets.find(({ url }) => url.includes("/browser-sessions/"))?.socket;
    socket?.open();
    socket?.receiveBinary(browserFrame(1));
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    expect(socket?.closeEvents).toEqual([{ code: 4002, reason: "Invalid browser protocol frame" }]);
    expect(sockets.filter(({ url }) => url.includes("/browser-sessions/"))).toHaveLength(1);
    expect(client.getSnapshot().browserSessions[0]).toMatchObject({
      state: "ready",
      viewerError: "Browser viewer frame arrived before its snapshot.",
      viewerState: "disconnected",
    });
    release();
    client.dispose();
  });

  it("closes viewer transport when the durable Host session becomes terminal", async () => {
    const workspace = makeWorkspace();
    const profileId = createId("browserProfile");
    const sessionId = createBrowserSessionId();
    const sockets: Array<{ socket: FakeSocket; url: string }> = [];
    let bootstrapReads = 0;
    const client = createHttpHostClient({
      fetch: async () => {
        bootstrapReads += 1;
        return json(
          bootstrap([workspace], {
            available: true,
            placements: [
              {
                available: true,
                environmentIds: [],
                kind: "runner",
                label: "Main Host",
                runnerId: runnerId,
                runtimeId: "runtime-1",
              },
            ],
            profileGrants: [],
            profiles: [{ id: profileId, name: "Default browser", revision: 0 }],
            sessions: [
              {
                access: "full-control",
                createdAt: now,
                id: sessionId,
                origin: "workspace",
                placement: { kind: "runner", runnerId: runnerId },
                profileId,
                runtimeId: "runtime-1",
                state: bootstrapReads === 1 ? "ready" : "failed",
                updatedAt: now,
                workspaceId: workspace.id,
              },
            ],
          }),
        );
      },
      refreshIntervalMs: 0,
      webSocketFactory: (url) => {
        const socket = new FakeSocket();
        sockets.push({ socket, url });
        return socket;
      },
    });
    await client.load();
    const release = client.retainBrowserViewer(sessionId);
    const socket = sockets.find(({ url }) => url.includes("/browser-sessions/"))?.socket;
    socket?.open();
    socket?.receiveRaw({
      access: "full-control",
      dialog: {
        id: "00000000-0000-4000-8000-0000000000d1",
        message: "Continue?",
        surfaceId: "page-1",
        type: "confirm",
      },
      sessionId,
      state: "ready",
      surfaces: [
        {
          active: true,
          id: "page-1",
          title: "Example",
          url: "https://example.com/",
        },
      ],
      type: "browser.snapshot",
    });
    expect(client.getSnapshot().browserSessions[0]).toMatchObject({
      viewerState: "synchronized",
    });

    await client.refresh();
    expect(socket?.closeEvents).toContainEqual({ code: 1000, reason: "Client closed" });
    expect(client.getSnapshot().browserSessions[0]).toMatchObject({
      dialog: null,
      state: "failed",
      viewerError: null,
      viewerState: "disconnected",
    });
    release();
    client.dispose();
  });
});

describe("HttpHostClient browser profiles", () => {
  it.each([true, false])("opens a fresh session with workspace cached: %s", async (cached) => {
    const workspace = makeWorkspace();
    const sessionId = createBrowserSessionId();
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/v1/rpc/bootstrap.get") {
        return json(
          bootstrap(cached ? [workspace] : [], {
            profileGrants: [],
            available: true,
            placements: [
              {
                available: true,
                environmentIds: [],
                kind: "runner",
                label: "Main Host",
                runnerId: runnerId,
                runtimeId: "runtime-1",
              },
            ],
            profiles: [],
            sessions: [],
          }),
        );
      }
      if (path === "/v1/rpc/commands.dispatch" && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toMatchObject({
          input: { fresh: true, placement: { kind: "runner", runnerId: runnerId } },
          type: "browser.session.start",
          workspaceId: workspace.id,
        });
        return json(
          {
            session: {
              access: "full-control",
              createdAt: now,
              id: sessionId,
              origin: "workspace",
              placement: { kind: "runner", runnerId: runnerId },
              profileId: null,
              runtimeId: "runtime-1",
              state: "ready",
              updatedAt: now,
              workspaceId: workspace.id,
            },
            wasExisting: false,
          },
          201,
        );
      }
      throw new Error(`Unexpected request ${path}`);
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      webSocketFactory: () => new FakeSocket(),
    });
    await client.load();

    const session = await client.startBrowser(
      workspace.id,
      { kind: "fresh" },
      {
        available: true,
        environmentIds: [],
        kind: "runner",
        label: "Main Host",
        runnerId: runnerId,
        runtimeId: "runtime-1",
      },
    );
    expect(session.profileId).toBeNull();
    expect(client.getSnapshot().browserSessions).toEqual([
      expect.objectContaining({ id: sessionId, profileId: null }),
    ]);
    client.dispose();
  });

  it("keeps pending erasure from delete receipts and bootstrap until completion, including older Hosts", async () => {
    const profileId = createId("browserProfile");
    const computerId = createId("runner");
    const deletion = { profileId, computerId, state: "pending-computer" as const };
    let browser: HostedBrowserBootstrap = {
      available: false,
      placements: [],
      profiles: [{ id: profileId, name: "Work", revision: 0 }],
      profileGrants: [],
      sessions: [],
    };
    const client = createHttpHostClient({
      refreshIntervalMs: 0,
      webSocketFactory: () => new FakeSocket(),
      fetch: async (input) => {
        const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
        if (path === "/v1/rpc/bootstrap.get") return json(bootstrap([makeWorkspace()], browser));
        if (path === "/v1/rpc/commands.dispatch")
          return json({ type: "browser.profile.delete", deletion });
        throw new Error(`Unexpected request ${path}`);
      },
    });
    try {
      await client.load();
      expect(client.getSnapshot().browserProfileDeletions).toBeUndefined();
      await client.dispatch({
        type: "browser.profile.delete",
        profileId,
        idempotencyKey: "delete-native-profile",
      });
      expect(client.getSnapshot().browserProfiles).toEqual([]);
      expect(client.getSnapshot().browserProfileDeletions).toEqual([deletion]);
      browser = {
        ...browser,
        profiles: [],
        profileDeletions: [{ ...deletion, state: "pending-restart" }],
      };
      await client.refresh();
      expect(client.getSnapshot().browserProfileDeletions).toEqual(browser.profileDeletions);
      browser = { ...browser, profileDeletions: [] };
      await client.refresh();
      expect(client.getSnapshot().browserProfileDeletions).toEqual([]);
      delete browser.profileDeletions;
      await client.refresh();
      expect(client.getSnapshot().browserProfileDeletions).toBeUndefined();
    } finally {
      client.dispose();
    }
  });

  it("makes a profile saved from a fresh session immediately selectable", async () => {
    const workspace = makeWorkspace();
    const sessionId = createBrowserSessionId();
    const savedProfileId = createId("browserProfile");
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/v1/rpc/bootstrap.get") return json(bootstrap([workspace]));
      if (path === "/v1/rpc/commands.dispatch" && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          idempotencyKey: "browser-session-save-test",
          input: { name: "Client account" },
          sessionId,
          type: "browser.session.profile.save",
        });
        return json({ profile: { id: savedProfileId, name: "Client account", revision: 1 } }, 201);
      }
      throw new Error(`Unexpected request ${path}`);
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      webSocketFactory: () => new FakeSocket(),
    });
    await client.load();

    await expect(
      client.dispatch({
        idempotencyKey: "browser-session-save-test",
        input: { name: "Client account" },
        sessionId,
        type: "browser.session.profile.save",
      }),
    ).resolves.toMatchObject({
      profile: { id: savedProfileId, name: "Client account", revision: 1 },
    });
    expect(client.getSnapshot().browserProfiles).toEqual([
      expect.objectContaining({ id: savedProfileId, name: "Client account" }),
    ]);
    client.dispose();
  });
});

describe("HttpHostClient attachment discovery", () => {
  it("uses cached evidence on periodic refresh and reverifies after a Host restart", async () => {
    vi.useFakeTimers();
    const workspace = makeWorkspace();
    const sockets: FakeSocket[] = [];
    const capabilities = vi.fn(async () => ["thread-titles-v1"] as const);
    const client = createHttpHostClient({
      capabilities,
      fetch: async () => json(bootstrap([workspace])),
      refreshIntervalMs: 15_000,
      reconnectBaseDelayMs: 10,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    try {
      await client.load();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(capabilities).toHaveBeenCalledTimes(2);
      expect(capabilities).not.toHaveBeenCalledWith({ revalidate: true });
      sockets[0]!.serverClose();
      await vi.advanceTimersByTimeAsync(10);
      expect(capabilities).toHaveBeenCalledWith({ revalidate: true });
      expect(sockets).toHaveLength(2);
      expect(client.getSnapshot().threadRenameAvailable).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it("reverifies discovery on refresh while a periodic bootstrap is still running", async () => {
    vi.useFakeTimers();
    const workspace = makeWorkspace();
    const capabilities = vi.fn(async () => [] as const);
    let held: ReturnType<typeof Promise.withResolvers<Response>> | null = null;
    let bootstraps = 0;
    const client = createHttpHostClient({
      capabilities,
      fetch: async () => {
        bootstraps += 1;
        if (bootstraps === 2) {
          held = Promise.withResolvers<Response>();
          return held.promise;
        }
        return json(bootstrap([workspace]));
      },
      refreshIntervalMs: 15_000,
      webSocketFactory: () => new FakeSocket(),
    });
    try {
      await client.load();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(held).not.toBeNull();
      const refreshed = client.refresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(capabilities).toHaveBeenCalledWith({ revalidate: true });
      held!.resolve(json(bootstrap([workspace])));
      await refreshed;
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["unauthorized", "unsupported-version"] as const)(
    "reverifies discovery on an RPC %s refusal",
    async (refusal) => {
      const capabilities = vi.fn(async () => []);
      let refuse = false;
      const client = createHttpHostClient({
        capabilities,
        fetch: async () =>
          refuse
            ? json(
                {
                  ok: false,
                  error: {
                    code: refusal === "unauthorized" ? "unauthorized" : "bad_request",
                    reason: refusal,
                    message: "Refused",
                    retryable: false,
                  },
                },
                refusal === "unauthorized" ? 401 : 400,
              )
            : json(bootstrap([])),
        refreshIntervalMs: 0,
      });
      try {
        await client.load();
        refuse = true;
        await client.rpc["workspace.catalog.list"]({ limit: 10 });
        await vi.waitFor(() => expect(capabilities).toHaveBeenCalledWith({ revalidate: true }));
      } finally {
        client.dispose();
      }
    },
  );
});

describe("HttpHostClient voice capability", () => {
  it("keeps voice hidden on an older Host and refreshes its advertisement", async () => {
    let enabled = false;
    const client = createHttpHostClient({
      capabilities: async () => (enabled ? ["voice-v1"] : []),
      refreshIntervalMs: 0,
      webSocketFactory: () => new FakeSocket(),
      fetch: async () => json(bootstrap([])),
    });
    try {
      await client.load();
      expect(client.getSnapshot().voiceAvailable).toBe(false);
      enabled = true;
      await client.refresh();
      expect(client.getSnapshot().voiceAvailable).toBe(true);
      enabled = false;
      await client.refresh();
      expect(client.getSnapshot().voiceAvailable).toBe(false);
    } finally {
      client.dispose();
    }
  });
});

describe("HttpHostClient title capability", () => {
  it("refreshes capability evidence, strips generation for older Hosts and refuses unavailable or invalid renames", async () => {
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    let available = false;
    const commands: Readonly<Record<string, unknown>>[] = [];
    const client = createHttpHostClient({
      capabilities: async () => (available ? ["thread-titles-v1"] : []),
      refreshIntervalMs: 0,
      webSocketFactory: () => new FakeSocket(),
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/v1/rpc/commands.dispatch") {
          const command = rpcPayload(url, init);
          commands.push(command);
          if (command.type === "execution.preferences.remember")
            return json({ preferences: emptyExecutionPreferences });
          return json({
            thread: { ...thread, title: command.title },
            asOfSequence: "10",
            wasDuplicate: false,
          });
        }
        return json(bootstrap([workspace]));
      },
    });
    try {
      await client.load();
      expect(client.getSnapshot().threadRenameAvailable).toBe(false);
      await expect(client.renameThread(thread.id, "Title")).rejects.toThrow("does not support");
      const creation = {
        accessMode: thread.accessMode,
        environmentId,
        harnessInstanceId,
        modelSelection: thread.modelSelection,
        workspaceId: workspace.id,
        title: "Seed",
        generateTitle: true as const,
      };
      await client.createThread(creation);
      expect(commands.find((command) => command.type === "thread.create")).not.toHaveProperty(
        "generateTitle",
      );
      available = true;
      await client.refresh();
      expect(client.getSnapshot().threadRenameAvailable).toBe(true);
      await client.createThread(creation);
      expect(commands.filter((command) => command.type === "thread.create").at(-1)).toMatchObject({
        generateTitle: true,
      });
      await expect(client.renameThread(thread.id, "  ")).rejects.toThrow();
      await expect(client.renameThread(thread.id, "x".repeat(241))).rejects.toThrow();
      await client.renameThread(thread.id, "  Trimmed name  ");
      expect(commands.filter((command) => command.type === "thread.rename")).toEqual([
        expect.objectContaining({ title: "Trimmed name", idempotencyKey: expect.any(String) }),
      ]);
      available = false;
      await client.refresh();
      expect(client.getSnapshot().threadRenameAvailable).toBe(false);
      await expect(client.renameThread(thread.id, "Another title")).rejects.toThrow(
        "does not support",
      );
    } finally {
      client.dispose();
    }
  });
});

describe("HttpHostClient Thread state reconciliation", () => {
  async function delayedRead(options: {
    readonly freshHistory?: unknown;
    readonly loaded?: boolean;
    readonly path: string;
    readonly response: unknown;
    readonly responseStatus?: number;
    readonly thread: Thread;
    readonly workspace: WorkspaceView;
  }) {
    const asked = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();
    const socket = new FakeSocket();
    let reads = 0;
    const reread = vi.fn();
    const client = createHttpHostClient({
      capabilities: ["thread-titles-v1", "task-marks-v1"],
      fetch: async (input) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path === options.path && reads++ === 0) {
          asked.resolve();
          await answer.promise;
          return json(options.response, options.responseStatus);
        }
        if (path === "/v1/rpc/thread.events.list" && options.freshHistory) {
          reread();
          return json(options.freshHistory);
        }
        if (path === options.path) return json(options.response);
        return json(bootstrap([options.workspace]));
      },
      refreshIntervalMs: 0,
      webSocketFactory: () => socket,
    });
    await client.load();
    socket.open();
    socket.receive({
      snapshot: {
        ...workspaceSnapshot(options.workspace, "0"),
        threads: options.loaded === false ? [] : [options.thread],
        threadWindow: {
          byteCount: 2,
          hasMore: true,
          itemCount: options.loaded === false ? 0 : 1,
          nextBefore: "older_threads",
          totalItems: 2,
        },
      },
      type: "host.snapshot",
    });
    return { answer: answer.resolve, asked: asked.promise, client, reread, socket };
  }

  function historyPage(thread: Thread, asOfSequence = "0", events: AgentEvent[] = []) {
    return {
      events,
      readState: { ...defaultReadState(thread.id), asOfSequence },
      thread,
      threadId: thread.id,
      window: {
        byteCount: 2,
        hasMore: false,
        itemCount: events.length,
        nextBefore: null,
        threadId: thread.id,
        totalItems: events.length,
      },
    };
  }

  function stateEvents(workspace: WorkspaceView, thread: Thread): AgentEvent[] {
    const request = pendingRequest({
      presentation: {
        detail: "Continue the work",
        kind: "choice",
        options: [{ hint: "confirm", id: "allow", label: "Continue" }],
        risk: "low",
        title: "Continue?",
      },
      runId: createId("run"),
      threadId: thread.id,
      workspaceId: workspace.id,
    });
    return [
      agentEvent(workspace.id, thread.id, null, "2", "thread.state-changed", {
        status: "waiting",
        inputQueuePaused: false,
        pendingRequests: 0,
      }),
      agentEvent(workspace.id, thread.id, null, "3", "thread.input-queue-updated", {
        paused: true,
      }),
      agentEvent(workspace.id, thread.id, request.originatingRunId, "4", "request.opened", {
        request,
      }),
      agentEvent(workspace.id, thread.id, null, "5", "thread.state-changed", {
        status: "waiting",
        inputQueuePaused: true,
        pendingRequests: 1,
        title: "Current title",
      }),
    ];
  }

  it.each(["history", "command", "history page"] as const)(
    "keeps a newer title across delayed %s and legacy state events",
    async (source) => {
      const workspace = makeWorkspace();
      const thread = makeThread(workspace.id);
      const path =
        source === "command" ? "/v1/rpc/commands.dispatch" : "/v1/rpc/thread.events.list";
      const { answer, asked, client, socket } = await delayedRead({
        path,
        response: source === "command" ? { thread } : historyPage(thread),
        thread,
        workspace,
      });
      try {
        const reading =
          source === "history"
            ? client.loadLatestTranscript(thread.id)
            : source === "command"
              ? client.dispatch({
                  type: "thread.rename",
                  threadId: thread.id,
                  title: "Earlier rename",
                  idempotencyKey: "earlier-title",
                })
              : client.loadEarlierTranscript(thread.id);
        await asked;
        socket.receive({
          type: "host.events",
          events: [
            agentEvent(workspace.id, thread.id, null, "5", "thread.state-changed", {
              status: "idle",
              inputQueuePaused: false,
              pendingRequests: 0,
              title: "Current title",
            }),
            agentEvent(workspace.id, thread.id, null, "6", "thread.state-changed", {
              status: "idle",
              inputQueuePaused: false,
              pendingRequests: 0,
            }),
          ],
        });
        expect(client.getSnapshot().threads.find(({ id }) => id === thread.id)?.title).toBe(
          "Current title",
        );
        answer();
        await reading;
        expect(client.getSnapshot().threads.find(({ id }) => id === thread.id)?.title).toBe(
          "Current title",
        );
      } finally {
        client.dispose();
      }
    },
  );

  it.each(["history", "older response", "failure"] as const)(
    "keeps a newer icon across delayed %s, legacy events and stale snapshots",
    async (source) => {
      const workspace = makeWorkspace();
      const thread = {
        ...makeThread(workspace.id),
        icon: "hotel" as const,
        color: "blue" as const,
      };
      const { answer, asked, client, socket } = await delayedRead({
        path: source === "history" ? "/v1/rpc/thread.events.list" : "/v1/rpc/commands.dispatch",
        response:
          source === "history"
            ? historyPage(thread)
            : source === "failure"
              ? { error: { code: "bad_request", message: "Icon refused", retryable: false } }
              : { thread: { ...thread, icon: "plane" }, asOfSequence: "2" },
        ...(source === "failure" ? { responseStatus: 400 } : {}),
        thread,
        workspace,
      });
      try {
        const pending =
          source === "history"
            ? client.loadLatestTranscript(thread.id)
            : client.dispatch({
                type: "thread.icon.set",
                threadId: thread.id,
                icon: "plane",
                idempotencyKey: "older-icon",
              });
        const settled = pending.then(
          () => null,
          (error: unknown) => error,
        );
        if (source !== "history") {
          expect(client.getSnapshot().threads[0]).toMatchObject({
            icon: "plane",
            title: thread.title,
            updatedAt: thread.updatedAt,
          });
        }
        await asked;
        socket.receive({
          type: "host.events",
          events: [
            agentEvent(workspace.id, thread.id, null, "5", "thread.state-changed", {
              status: "idle",
              inputQueuePaused: false,
              pendingRequests: 0,
              title: thread.title,
              icon: "gift",
            }),
            agentEvent(workspace.id, thread.id, null, "6", "thread.state-changed", {
              status: "idle",
              inputQueuePaused: false,
              pendingRequests: 0,
            }),
          ],
        });
        answer();
        const error = await settled;
        if (source === "failure") expect(error).toMatchObject({ message: "Icon refused" });
        else expect(error).toBeNull();
        expect(client.getSnapshot().threads[0]).toMatchObject({ icon: "gift", color: "blue" });
        socket.receive({
          type: "host.snapshot",
          snapshot: { ...workspaceSnapshot(workspace, "0"), threads: [thread] },
        });
        expect(client.getSnapshot().threads[0]?.icon).toBe("gift");
      } finally {
        answer();
        client.dispose();
      }
    },
  );

  it("rolls back an icon failure without a newer event and refuses mark commands on an old Host", async () => {
    const workspace = { ...makeWorkspace(), kind: "specialized" as const, color: "green" as const };
    const thread = { ...makeThread(workspace.id), icon: "hotel" as const };
    const { answer, asked, client } = await delayedRead({
      path: "/v1/rpc/commands.dispatch",
      response: { error: { code: "bad_request", message: "Icon refused", retryable: false } },
      responseStatus: 400,
      thread,
      workspace,
    });
    try {
      const setting = client.dispatch({
        type: "thread.icon.set",
        threadId: thread.id,
        icon: null,
        idempotencyKey: "default-icon",
      });
      const refused = expect(setting).rejects.toThrow("Icon refused");
      expect(client.getSnapshot().threads[0]?.icon).toBe("document");
      await asked;
      answer();
      await refused;
      expect(client.getSnapshot().threads[0]?.icon).toBe("hotel");
    } finally {
      answer();
      client.dispose();
    }
    const old = createHttpHostClient({
      capabilities: [],
      refreshIntervalMs: 0,
      webSocketFactory: () => new FakeSocket(),
      fetch: async () => json(bootstrap([workspace])),
    });
    try {
      await old.load();
      expect(old.getSnapshot().taskMarksAvailable).toBe(false);
      await expect(
        old.dispatch({
          type: "thread.icon.set",
          threadId: thread.id,
          icon: "plane",
          idempotencyKey: "old-icon",
        }),
      ).rejects.toThrow("does not support");
      await expect(
        old.dispatch({
          type: "workspace.color.set",
          workspaceId: workspace.id,
          color: "blue",
          idempotencyKey: "old-color",
        }),
      ).rejects.toThrow("does not support");
    } finally {
      old.dispose();
    }
  });

  it.each(["success", "failure"] as const)(
    "optimistically changes specialist colour and settles %s",
    async (outcome) => {
      const workspace = {
        ...makeWorkspace(),
        kind: "specialized" as const,
        color: "green" as const,
      };
      const { answer, asked, client } = await delayedRead({
        path: "/v1/rpc/commands.dispatch",
        thread: makeThread(workspace.id),
        workspace,
        response:
          outcome === "success"
            ? { workspace: { ...workspace, color: "purple" } }
            : { error: { code: "bad_request", message: "Colour refused", retryable: false } },
        ...(outcome === "failure" ? { responseStatus: 400 } : {}),
      });
      try {
        const setting = client.dispatch({
          type: "workspace.color.set",
          workspaceId: workspace.id,
          color: "purple",
          idempotencyKey: "color",
        });
        const settled = setting.then(
          () => null,
          (error: unknown) => error,
        );
        expect(client.getSnapshot().workspaces.find(({ id }) => id === workspace.id)?.color).toBe(
          "purple",
        );
        await asked;
        answer();
        const error = await settled;
        if (outcome === "failure") expect(error).toMatchObject({ message: "Colour refused" });
        expect(client.getSnapshot().workspaces.find(({ id }) => id === workspace.id)?.color).toBe(
          outcome === "success" ? "purple" : "green",
        );
      } finally {
        answer();
        client.dispose();
      }
    },
  );

  async function pendingMarks() {
    const workspace = { ...makeWorkspace(), kind: "specialized" as const, color: "green" as const };
    const thread = { ...makeThread(workspace.id), icon: "hotel" as const };
    const socket = new FakeSocket();
    const responses: ReturnType<typeof Promise.withResolvers<Response>>[] = [];
    const client = createHttpHostClient({
      capabilities: ["task-marks-v1"],
      refreshIntervalMs: 0,
      webSocketFactory: () => socket,
      fetch: async (input) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path === "/v1/rpc/commands.dispatch") {
          const response = Promise.withResolvers<Response>();
          responses.push(response);
          return response.promise;
        }
        return json(bootstrap([workspace]));
      },
    });
    await client.load();
    socket.open();
    socket.receive({
      type: "host.snapshot",
      snapshot: { ...workspaceSnapshot(workspace, "0"), threads: [thread] },
    });
    const refuse = (index: number) =>
      responses[index]!.resolve(
        json({ error: { code: "bad_request", message: "Mark refused", retryable: false } }, 400),
      );
    return { client, refuse, responses, socket, thread, workspace };
  }

  it.each(["colour", "icon"] as const)(
    "settles overlapping refused %s edits without retaining an optimistic value",
    async (field) => {
      const { client, refuse, responses, thread, workspace } = await pendingMarks();
      try {
        const edit = (second: boolean) =>
          client
            .dispatch(
              field === "colour"
                ? {
                    type: "workspace.color.set",
                    workspaceId: workspace.id,
                    color: second ? "purple" : "teal",
                    idempotencyKey: String(second),
                  }
                : {
                    type: "thread.icon.set",
                    threadId: thread.id,
                    icon: second ? "gift" : "plane",
                    idempotencyKey: String(second),
                  },
            )
            .catch((error: unknown) => error);
        const visible = () =>
          field === "colour"
            ? client.getSnapshot().workspaces.find(({ id }) => id === workspace.id)?.color
            : client.getSnapshot().threads.find(({ id }) => id === thread.id)?.icon;
        const first = edit(false);
        const second = edit(true);
        await vi.waitFor(() => expect(responses).toHaveLength(2));
        expect(visible()).toBe(field === "colour" ? "purple" : "gift");
        refuse(0);
        expect(await first).toMatchObject({ message: "Mark refused" });
        expect(visible()).toBe(field === "colour" ? "purple" : "gift");
        refuse(1);
        expect(await second).toMatchObject({ message: "Mark refused" });
        expect(visible()).toBe(field === "colour" ? "green" : "hotel");
      } finally {
        responses.forEach((_, index) => refuse(index));
        client.dispose();
      }
    },
  );

  it.each(["activity", "refresh"] as const)(
    "keeps pending marks through %s and restores authoritative marks on refusal",
    async (source) => {
      const { client, refuse, responses, socket, thread, workspace } = await pendingMarks();
      try {
        const colour = client.dispatch({
          type: "workspace.color.set",
          workspaceId: workspace.id,
          color: "teal",
          idempotencyKey: "pending-colour",
        });
        const icon = client.dispatch({
          type: "thread.icon.set",
          threadId: thread.id,
          icon: "plane",
          idempotencyKey: "pending-icon",
        });
        const settled = Promise.allSettled([colour, icon]);
        await vi.waitFor(() => expect(responses).toHaveLength(2));
        if (source === "refresh") await client.refresh();
        else {
          const event = agentEvent(workspace.id, thread.id, null, "1", "thread.state-changed", {
            status: "running",
            inputQueuePaused: false,
            pendingRequests: 0,
          });
          socket.receive({
            type: "host.events",
            events: [{ ...event, createdAt: "2026-08-10T00:00:00.000Z" }],
          });
        }
        expect(client.getSnapshot().workspaces.find(({ id }) => id === workspace.id)?.color).toBe(
          "teal",
        );
        expect(client.getSnapshot().threads.find(({ id }) => id === thread.id)?.icon).toBe("plane");
        refuse(0);
        refuse(1);
        expect((await settled).map(({ status }) => status)).toEqual(["rejected", "rejected"]);
        expect(client.getSnapshot().workspaces.find(({ id }) => id === workspace.id)?.color).toBe(
          "green",
        );
        expect(client.getSnapshot().threads.find(({ id }) => id === thread.id)?.icon).toBe("hotel");
      } finally {
        responses.forEach((_, index) => refuse(index));
        client.dispose();
      }
    },
  );

  it.each(["response", "failure"] as const)(
    "keeps a newer authoritative colour after an older %s and snapshot",
    async (outcome) => {
      const { client, refuse, responses, socket, workspace } = await pendingMarks();
      try {
        const pending = client.dispatch({
          type: "workspace.color.set",
          workspaceId: workspace.id,
          color: "teal",
          idempotencyKey: "older-colour",
        });
        const settled = pending.catch((error: unknown) => error);
        await vi.waitFor(() => expect(responses).toHaveLength(1));
        socket.receive({
          type: "host.snapshot",
          snapshot: workspaceSnapshot(
            { ...workspace, color: "magenta", updatedAt: "2026-08-10T00:00:00.000Z" },
            "5",
          ),
        });
        if (outcome === "failure") refuse(0);
        else responses[0]!.resolve(json({ workspace: { ...workspace, color: "teal" } }));
        const result = await settled;
        if (outcome === "failure") expect(result).toMatchObject({ message: "Mark refused" });
        expect(client.getSnapshot().workspaces.find(({ id }) => id === workspace.id)?.color).toBe(
          "magenta",
        );
        socket.receive({ type: "host.snapshot", snapshot: workspaceSnapshot(workspace, "0") });
        expect(client.getSnapshot().workspaces.find(({ id }) => id === workspace.id)?.color).toBe(
          "magenta",
        );
      } finally {
        responses.forEach((_, index) => refuse(index));
        client.dispose();
      }
    },
  );

  it("remembers a hydrated title when a legacy state event arrived before the Thread was loaded", async () => {
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    const { answer, asked, client, socket } = await delayedRead({
      loaded: false,
      path: "/v1/rpc/thread.events.list",
      response: historyPage({ ...thread, title: "Known title" }, "5"),
      thread,
      workspace,
    });
    try {
      const reading = client.loadLatestTranscript(thread.id);
      await asked;
      socket.receive({
        type: "host.events",
        events: [
          agentEvent(workspace.id, thread.id, null, "6", "thread.state-changed", {
            status: "idle",
            inputQueuePaused: false,
            pendingRequests: 0,
          }),
        ],
      });
      answer();
      await reading;
      expect(client.getSnapshot().threads[0]?.title).toBe("Known title");
      socket.receive({
        type: "host.snapshot",
        snapshot: { ...workspaceSnapshot(workspace, "0"), threads: [thread] },
      });
      expect(client.getSnapshot().threads[0]?.title).toBe("Known title");
    } finally {
      client.dispose();
    }
  });

  it.each([false, true])(
    "rolls an optimistic rename back to the latest authoritative title (new event: %s)",
    async (newer) => {
      const workspace = makeWorkspace();
      const thread = makeThread(workspace.id);
      const { answer, asked, client, socket } = await delayedRead({
        path: "/v1/rpc/commands.dispatch",
        response: { error: { code: "bad_request", message: "Rename refused", retryable: false } },
        responseStatus: 400,
        thread,
        workspace,
      });
      try {
        const renaming = client.renameThread(thread.id, "  Optimistic name  ");
        const refused = expect(renaming).rejects.toThrow("Rename refused");
        expect(client.getSnapshot().threads[0]?.title).toBe("Optimistic name");
        await asked;
        if (newer)
          socket.receive({
            type: "host.events",
            events: [
              agentEvent(workspace.id, thread.id, null, "5", "thread.state-changed", {
                status: "idle",
                inputQueuePaused: false,
                pendingRequests: 0,
                title: "New authoritative name",
              }),
            ],
          });
        answer();
        await refused;
        expect(client.getSnapshot().threads[0]?.title).toBe(
          newer ? "New authoritative name" : thread.title,
        );
      } finally {
        client.dispose();
      }
    },
  );

  it("does not restore a cancelled pending Request from delayed Thread history", async () => {
    const workspace = makeWorkspace();
    const thread = { ...makeThread(workspace.id), pendingRequests: 1 };
    const { answer, asked, client, socket } = await delayedRead({
      path: "/v1/rpc/thread.events.list",
      response: historyPage(thread),
      thread,
      workspace,
    });
    try {
      const reading = client.loadLatestTranscript(thread.id);
      await asked;
      socket.receive({
        events: [
          agentEvent(workspace.id, thread.id, null, "1", "request.cancelled", {
            reason: "source-closed",
            requestId: createId("request"),
          }),
          agentEvent(workspace.id, thread.id, null, "2", "thread.state-changed", {
            status: "idle",
            inputQueuePaused: false,
            pendingRequests: 0,
          }),
        ],
        type: "host.events",
      });
      expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(0);
      answer();
      await reading;
      expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(0);
    } finally {
      client.dispose();
    }
  });

  it.each(["thread.access.update", "thread.execution.update", "thread.inputQueue.resume"] as const)(
    "does not restore a cancelled pending Request from a delayed %s answer",
    async (type) => {
      const workspace = makeWorkspace();
      const thread = { ...makeThread(workspace.id), pendingRequests: 1 };
      const { answer, asked, client, socket } = await delayedRead({
        path: "/v1/rpc/commands.dispatch",
        response: { thread: { ...thread, title: "Command answer" } },
        thread,
        workspace,
      });
      try {
        const common = { idempotencyKey: "state-update", threadId: thread.id };
        const updating = client.dispatch(
          type === "thread.access.update"
            ? { ...common, accessMode: "full-access", type }
            : type === "thread.execution.update"
              ? { ...common, harnessInstanceId, modelSelection: thread.modelSelection, type }
              : { ...common, type },
        );
        await asked;
        socket.receive({
          events: [
            agentEvent(workspace.id, thread.id, null, "1", "request.cancelled", {
              reason: "source-closed",
              requestId: createId("request"),
            }),
            agentEvent(workspace.id, thread.id, null, "2", "thread.state-changed", {
              status: "idle",
              inputQueuePaused: false,
              pendingRequests: 0,
              title: "Current title",
            }),
          ],
          type: "host.events",
        });
        expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(0);
        answer();
        await updating;
        expect(client.getSnapshot().threads[0]).toMatchObject({
          pendingRequests: 0,
          title: "Current title",
        });
      } finally {
        client.dispose();
      }
    },
  );

  it.each([true, false])(
    "keeps realtime Thread state and transcript across a late create answer (created event: %s)",
    async (createdEvent) => {
      const workspace = makeWorkspace();
      const thread = makeThread(workspace.id);
      const message = makeMessage(thread.id, "assistant", "Already here");
      const { answer, asked, client, socket } = await delayedRead({
        loaded: false,
        path: "/v1/rpc/commands.dispatch",
        response: { thread: { ...thread, title: "Command answer" }, wasDuplicate: false },
        thread,
        workspace,
      });
      try {
        const creating = client.dispatch({
          accessMode: thread.accessMode,
          environmentId,
          harnessInstanceId,
          idempotencyKey: "state-create",
          modelSelection: thread.modelSelection,
          title: thread.title,
          type: "thread.create",
          workspaceId: workspace.id,
        });
        await asked;
        client.activateThread(thread.id);
        socket.receive({
          events: [
            ...(createdEvent
              ? [agentEvent(workspace.id, thread.id, null, "1", "thread.created", { thread })]
              : []),
            ...stateEvents(workspace, thread),
            agentEvent(workspace.id, thread.id, message.runId, "6", "message.created", {
              input: null,
              message,
            }),
          ],
          type: "host.events",
        });
        const transcript = client.getSnapshot().transcripts[thread.id];
        expect(transcript).toEqual(
          expect.arrayContaining([expect.objectContaining({ body: "Already here" })]),
        );
        answer();
        await creating;
        expect(client.getSnapshot().threads).toEqual([
          expect.objectContaining({
            id: thread.id,
            inputQueuePaused: true,
            pendingRequests: 1,
            status: "waiting",
            title: "Current title",
          }),
        ]);
        expect(client.getSnapshot().transcripts[thread.id]).toEqual(transcript);
      } finally {
        client.dispose();
      }
    },
  );

  it.each(["1", "4"])(
    "reconciles history at its read-state cut %s even when the last history event is older",
    async (asOfSequence) => {
      const workspace = makeWorkspace();
      const thread = makeThread(workspace.id);
      const pageThread = {
        ...thread,
        ...(asOfSequence === "4"
          ? { inputQueuePaused: true, pendingRequests: 1, status: "waiting" as const }
          : {}),
      };
      const { answer, asked, client, socket } = await delayedRead({
        path: "/v1/rpc/thread.events.list",
        response: historyPage(pageThread, asOfSequence, [
          agentEvent(workspace.id, thread.id, null, "1", "thread.created", { thread }),
        ]),
        thread,
        workspace,
      });
      try {
        socket.receive({ events: stateEvents(workspace, thread), type: "host.events" });
        const reading = client.loadLatestTranscript(thread.id);
        await asked;
        answer();
        await reading;
        expect(client.getSnapshot().threads[0]).toMatchObject({
          inputQueuePaused: true,
          pendingRequests: 1,
          status: "waiting",
        });
      } finally {
        client.dispose();
      }
    },
  );

  it("applies absolute state once while Request events leave the count unchanged", async () => {
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    const opened = stateEvents(workspace, thread).find((event) => event.type === "request.opened")!;
    if (opened.type !== "request.opened") throw new Error("Expected a Request event");
    const { answer, asked, client, socket } = await delayedRead({
      path: "/v1/rpc/thread.events.list",
      response: historyPage(thread),
      thread,
      workspace,
    });
    try {
      const reading = client.loadLatestTranscript(thread.id);
      await asked;
      const events = [
        agentEvent(workspace.id, thread.id, null, "1", "request.cancelled", {
          reason: "source-closed",
          requestId: createId("request"),
        }),
        agentEvent(workspace.id, thread.id, null, "2", "request.resolved", {
          request: {
            ...opened.data.request,
            resolvedAt: now,
            resolvedBy: ownerId,
            response: { kind: "choice", optionId: "allow" },
            status: "fulfilled",
          },
        }),
        opened,
      ];
      socket.receive({ events, type: "host.events" });
      socket.receive({ events, type: "host.events" });
      expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(0);
      socket.receive({
        events: [
          agentEvent(workspace.id, thread.id, null, "5", "thread.state-changed", {
            status: "waiting",
            inputQueuePaused: false,
            pendingRequests: 1,
          }),
        ],
        type: "host.events",
      });
      expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(1);
      answer();
      await reading;
      expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(1);
    } finally {
      client.dispose();
    }
  });

  it(
    "preserves loaded state after the unloaded state map evicts older Threads",
    { timeout: 30_000 },
    async () => {
      const workspace = makeWorkspace();
      const thread = { ...makeThread(workspace.id), pendingRequests: 2 };
      const loadedChange = "2026-08-09T20:01:00.000Z";
      const lastChange = "2026-08-09T20:02:00.000Z";
      const { answer, asked, client, socket } = await delayedRead({
        path: "/v1/rpc/thread.events.list",
        response: historyPage(thread),
        thread,
        workspace,
      });
      try {
        socket.receive({
          events: stateEvents(workspace, thread).map((event) =>
            event.sequence === "5" ? { ...event, createdAt: loadedChange } : event,
          ),
          type: "host.events",
        });
        const transcripts = client.getSnapshot().transcripts;
        expect(Object.keys(transcripts)).toEqual([thread.id]);
        for (let sequence = 6; sequence < 4103; sequence += 1) {
          socket.receive({
            events: [
              {
                ...agentEvent(
                  workspace.id,
                  createId("thread"),
                  null,
                  String(sequence),
                  "thread.state-changed",
                  {
                    status: "running",
                    inputQueuePaused: false,
                    pendingRequests: 0,
                  },
                ),
                createdAt: sequence === 4102 ? lastChange : now,
              },
            ],
            type: "host.events",
          });
        }
        // State is not transcript: an unloaded Thread's state change creates no
        // transcript, and copying the map for each one made this traffic quadratic.
        const evicted = client.getSnapshot();
        expect(Object.keys(evicted.transcripts)).toEqual([thread.id]);
        expect(evicted.transcripts).toBe(transcripts);
        expect(evicted.threads[0]?.updatedAt).toBe(loadedChange);
        expect(evicted.workspaces[0]?.updatedAt).toBe(lastChange);
        expect(parseSent(socket, socket.sent.length - 1)).toMatchObject({
          sequence: "4102",
          type: "client.ack",
        });
        const reading = client.loadLatestTranscript(thread.id);
        await asked;
        answer();
        await reading;
        expect(client.getSnapshot().threads[0]).toMatchObject({
          inputQueuePaused: true,
          pendingRequests: 1,
          status: "waiting",
        });
      } finally {
        client.dispose();
      }
    },
  );

  it("keeps an HTTP history page ahead of websocket state", async () => {
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    const current = {
      ...thread,
      pendingRequests: 1,
      inputQueuePaused: true,
      status: "waiting" as const,
    };
    const { answer, asked, client, socket } = await delayedRead({
      loaded: true,
      path: "/v1/rpc/thread.events.list",
      response: historyPage(current, "10"),
      thread,
      workspace,
    });
    try {
      const reading = client.loadLatestTranscript(thread.id);
      await asked;
      answer();
      await reading;
      socket.receive({ events: stateEvents(workspace, thread), type: "host.events" });
      socket.receive({
        events: [
          agentEvent(workspace.id, thread.id, null, "6", "thread.state-changed", {
            inputQueuePaused: false,
            pendingRequests: 0,
            status: "running",
          }),
        ],
        type: "host.events",
      });
      expect(client.getSnapshot().threads[0]).toMatchObject({
        inputQueuePaused: true,
        pendingRequests: 1,
        status: "waiting",
      });
      socket.receive({
        events: [
          agentEvent(workspace.id, thread.id, null, "11", "thread.state-changed", {
            inputQueuePaused: false,
            pendingRequests: 0,
            status: "running",
          }),
        ],
        type: "host.events",
      });
      expect(client.getSnapshot().threads[0]).toMatchObject({
        inputQueuePaused: false,
        pendingRequests: 0,
        status: "running",
      });
    } finally {
      client.dispose();
    }
  });

  it("keeps a reconnect snapshot newer than outstanding history", async () => {
    const workspace = makeWorkspace();
    const thread = { ...makeThread(workspace.id), status: "running" as const };
    const { answer, asked, client, reread, socket } = await delayedRead({
      freshHistory: historyPage(
        { ...thread, status: "waiting", pendingRequests: 1, inputQueuePaused: true },
        "10",
      ),
      path: "/v1/rpc/thread.events.list",
      response: historyPage(thread, "1"),
      thread,
      workspace,
    });
    try {
      const reading = client.loadLatestTranscript(thread.id);
      await asked;
      socket.receive({
        type: "host.snapshot",
        snapshot: {
          ...workspaceSnapshot(workspace, "10"),
          threads: [{ ...thread, status: "waiting", pendingRequests: 1, inputQueuePaused: true }],
        },
      });
      answer();
      await reading;
      expect(reread).toHaveBeenCalledOnce();
      expect(client.getSnapshot().threads[0]).toMatchObject({
        inputQueuePaused: true,
        pendingRequests: 1,
        status: "waiting",
      });
    } finally {
      client.dispose();
    }
  });

  it("rereads outstanding history for an observed Thread omitted by a reconnect snapshot", async () => {
    const workspace = makeWorkspace();
    const thread = { ...makeThread(workspace.id), status: "running" as const };
    const current = {
      ...thread,
      status: "waiting" as const,
      pendingRequests: 1,
      inputQueuePaused: true,
    };
    const { answer, asked, client, reread, socket } = await delayedRead({
      freshHistory: historyPage(current, "10"),
      loaded: false,
      path: "/v1/rpc/thread.events.list",
      response: historyPage(thread, "1"),
      thread,
      workspace,
    });
    const installed: ThreadSummary[] = [];
    client.subscribe(() => {
      const summary = client.getSnapshot().threads.find(({ id }) => id === thread.id);
      if (summary) installed.push(summary);
    });
    const stopObserving = client.observeThread(thread.id);
    try {
      await asked;
      socket.receive({ type: "host.snapshot", snapshot: workspaceSnapshot(workspace, "10") });
      answer();
      await vi.waitFor(() => {
        expect(client.getSnapshot().threads.find(({ id }) => id === thread.id)).toMatchObject({
          status: "waiting",
          inputQueuePaused: true,
          pendingRequests: 1,
        });
      });
      expect(reread).toHaveBeenCalledOnce();
      expect(
        installed.every(
          (summary) =>
            summary.status === "waiting" &&
            summary.inputQueuePaused &&
            summary.pendingRequests === 1,
        ),
      ).toBe(true);
    } finally {
      stopObserving();
      client.dispose();
    }
  });

  it("rereads retained state below the reconnect floor even when newer than history", async () => {
    const workspace = makeWorkspace();
    const thread = { ...makeThread(workspace.id), status: "running" as const };
    const current = {
      ...thread,
      status: "waiting" as const,
      pendingRequests: 1,
      inputQueuePaused: true,
    };
    const { answer, asked, client, reread, socket } = await delayedRead({
      freshHistory: historyPage(current, "10"),
      path: "/v1/rpc/thread.events.list",
      response: historyPage(thread, "1"),
      thread,
      workspace,
    });
    socket.receive({
      type: "host.snapshot",
      snapshot: { ...workspaceSnapshot(workspace, "2"), threads: [thread] },
    });
    const stop = client.observeThread(thread.id);
    try {
      await asked;
      socket.receive({ type: "host.snapshot", snapshot: workspaceSnapshot(workspace, "10") });
      answer();
      await vi.waitFor(() => expect(reread).toHaveBeenCalledOnce());
      expect(client.getSnapshot().threads.find(({ id }) => id === thread.id)).toMatchObject({
        status: current.status,
        pendingRequests: current.pendingRequests,
        inputQueuePaused: current.inputQueuePaused,
      });
    } finally {
      stop();
      client.dispose();
    }
  });

  it.each(["history", "command"] as const)(
    "caps %s rereads while coverage keeps advancing",
    async (source) => {
      const workspace = makeWorkspace();
      const thread = { ...makeThread(workspace.id), status: "running" as const };
      const socket = new FakeSocket();
      let reads = 0;
      const client = createHttpHostClient({
        fetch: async (input) => {
          const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
          if (path === "/v1/rpc/bootstrap.get") return json(bootstrap([workspace]));
          if (path === "/v1/rpc/commands.dispatch")
            return json({
              type: "thread.create",
              thread,
              asOfSequence: "1",
              wasDuplicate: false,
            });
          if (path === "/v1/rpc/thread.events.list") {
            reads += 1;
            if (reads > 5) throw new Error("uncapped Thread history reread");
            socket.receive({
              type: "host.snapshot",
              snapshot: workspaceSnapshot(workspace, String(10 + reads)),
            });
            return json(
              historyPage(
                { ...thread, status: "waiting", pendingRequests: reads, inputQueuePaused: true },
                String(1 + reads),
              ),
            );
          }
          throw new Error(`Unexpected request ${path}`);
        },
        refreshIntervalMs: 0,
        webSocketFactory: () => socket,
      });
      await client.load();
      socket.open();
      socket.receive({
        type: "host.snapshot",
        snapshot: {
          ...workspaceSnapshot(workspace, "10"),
          threads: [],
          threadWindow: {
            byteCount: 2,
            hasMore: true,
            itemCount: 0,
            nextBefore: "older_threads",
            totalItems: 2,
          },
        },
      });
      try {
        if (source === "history") await client.loadLatestTranscript(thread.id);
        else
          await client.dispatch({
            type: "thread.create",
            workspaceId: workspace.id,
            environmentId,
            harnessInstanceId,
            modelSelection: thread.modelSelection,
            title: thread.title,
            idempotencyKey: "reread-cap",
          });
        expect(reads).toBe(source === "history" ? 4 : 3);
        expect(client.getSnapshot().threads.find(({ id }) => id === thread.id)).toMatchObject({
          status: "waiting",
          pendingRequests: reads,
          inputQueuePaused: true,
        });
      } finally {
        client.dispose();
      }
    },
  );

  it("does not replay a Request already represented by an unloaded creation answer", async () => {
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    const { answer, asked, client, socket } = await delayedRead({
      loaded: false,
      path: "/v1/rpc/commands.dispatch",
      response: {
        asOfSequence: "10",
        thread: { ...thread, status: "waiting", inputQueuePaused: true, pendingRequests: 1 },
        wasDuplicate: true,
      },
      thread,
      workspace,
    });
    try {
      const creating = client.dispatch({
        type: "thread.create",
        idempotencyKey: "duplicate-cut",
        accessMode: thread.accessMode,
        environmentId,
        harnessInstanceId,
        modelSelection: thread.modelSelection,
        title: thread.title,
        workspaceId: workspace.id,
      });
      await asked;
      socket.receive({ type: "host.events", events: stateEvents(workspace, thread) });
      answer();
      await creating;
      expect(client.getSnapshot().threads[0]).toMatchObject({
        inputQueuePaused: true,
        pendingRequests: 1,
        status: "waiting",
      });
    } finally {
      client.dispose();
    }
  });

  it("keeps the visible order and transcript after a late creation answer", async () => {
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    const { answer, asked, client, socket } = await delayedRead({
      loaded: false,
      path: "/v1/rpc/commands.dispatch",
      response: { asOfSequence: "1", thread, wasDuplicate: false },
      thread,
      workspace,
    });
    try {
      const creating = client.dispatch({
        type: "thread.create",
        idempotencyKey: "late-order",
        accessMode: thread.accessMode,
        environmentId,
        harnessInstanceId,
        modelSelection: thread.modelSelection,
        title: thread.title,
        workspaceId: workspace.id,
      });
      await asked;
      const other = { ...makeThread(workspace.id), updatedAt: "2090-01-01T00:00:00.000Z" };
      const latest = { ...thread, updatedAt: "2091-01-01T00:00:00.000Z" };
      socket.receive({
        type: "host.events",
        events: [
          agentEvent(workspace.id, other.id, null, "1", "thread.created", { thread: other }),
          agentEvent(workspace.id, thread.id, null, "2", "thread.created", { thread: latest }),
          {
            ...agentEvent(workspace.id, thread.id, null, "3", "message.created", {
              input: null,
              message: makeMessage(thread.id, "assistant", "Keep this"),
            }),
            createdAt: latest.updatedAt,
          },
        ],
      });
      const before = client.getSnapshot();
      const order = (threads: typeof before.threads) =>
        [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ id }) => id);
      answer();
      await creating;
      expect(order(client.getSnapshot().threads)).toEqual(order(before.threads));
      expect(client.getSnapshot().threads.map(({ id }) => id)).toEqual(
        before.threads.map(({ id }) => id),
      );
      expect(client.getSnapshot().transcripts[thread.id]).toEqual(before.transcripts[thread.id]);
      expect(client.getSnapshot().threads.find(({ id }) => id === thread.id)?.updatedAt).toBe(
        before.threads.find(({ id }) => id === thread.id)?.updatedAt,
      );
    } finally {
      client.dispose();
    }
  });
});

describe("HttpHostClient command projection", () => {
  it("answers a Request without leaving the Thread owing the Host another page", async () => {
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    const runId = createId("run");
    const approval = pendingRequest({
      presentation: {
        detail: "Publish the release",
        kind: "choice",
        options: [{ hint: "confirm", id: "allow", label: "Publish" }],
        risk: "high",
        title: "Publish externally",
      },
      runId,
      threadId: thread.id,
      workspaceId: workspace.id,
    });
    const sockets: FakeSocket[] = [];
    const paths: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      paths.push(path);
      if (path === "/v1/rpc/thread.events.list") {
        return json({
          events: [],
          threadId: thread.id,
          window: {
            byteCount: 2,
            hasMore: false,
            itemCount: 0,
            nextBefore: null,
            threadId: thread.id,
            totalItems: 0,
          },
        });
      }
      if (path === "/v1/rpc/thread.requests.list") {
        return json({
          requests: [],
          threadId: thread.id,
          window: { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 },
        });
      }
      if (path === "/v1/rpc/commands.dispatch") return json({}, 202);
      return json(bootstrap([workspace]));
    });
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({ snapshot: workspaceSnapshot(workspace, "0"), type: "host.snapshot" });
    socket.receive({
      events: [
        agentEvent(workspace.id, thread.id, null, "1", "thread.created", { thread }),
        agentEvent(workspace.id, thread.id, runId, "2", "request.opened", { request: approval }),
        agentEvent(workspace.id, thread.id, null, "3", "thread.state-changed", {
          status: "waiting",
          inputQueuePaused: false,
          pendingRequests: 1,
        }),
      ],
      type: "host.events",
    });
    expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(1);
    socket.receive({
      events: [
        agentEvent(workspace.id, thread.id, runId, "4", "request.updated", {
          request: {
            ...approval,
            presentation: { ...approval.presentation, title: "Continue setup" },
          },
        }),
      ],
      type: "host.events",
    });
    expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(1);
    expect(client.getSnapshot().requests[thread.id]).toEqual([
      expect.objectContaining({
        id: approval.id,
        presentation: expect.objectContaining({ title: "Continue setup" }),
      }),
    ]);

    await client.dispatch({
      idempotencyKey: `request-${approval.id}:test`,
      requestId: approval.id,
      response: { kind: "choice", optionId: "allow" },
      type: "request.respond",
    });

    expect(client.getSnapshot().requests[thread.id]).toEqual([]);
    expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(1);
    socket.receive({
      events: [
        agentEvent(workspace.id, thread.id, null, "5", "thread.state-changed", {
          status: "running",
          inputQueuePaused: false,
          pendingRequests: 0,
        }),
      ],
      type: "host.events",
    });
    expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(0);

    // Only the Host's absolute state settles the count used for Request paging.
    paths.length = 0;
    client.activateThread(thread.id);
    await Promise.resolve();
    expect(paths).not.toContain("/v1/rpc/thread.requests.list");
    client.dispose();
  });

  it.each([
    { eventFirst: false, optionId: "installed" },
    { eventFirst: true, optionId: `server:${createIntegrationId("server")}` },
  ])(
    "keeps an integration access Request pending for intermediate choice $optionId",
    async ({ eventFirst, optionId }) => {
      const workspace = makeWorkspace();
      const thread = makeThread(workspace.id);
      const runId = createId("run");
      const request = pendingIntegrationAccessRequest({
        optionId,
        runId,
        threadId: thread.id,
        workspaceId: workspace.id,
      });
      const updated = {
        ...request,
        payload: {
          ...request.payload,
          installationId: request.payload.installationId ?? createIntegrationId("installation"),
          manifest: null,
          requestedServerId: optionId.startsWith("server:")
            ? optionId.slice("server:".length)
            : createIntegrationId("server"),
        },
      } as typeof request;
      const sockets: FakeSocket[] = [];
      let releaseResponse!: () => void;
      const responseGate = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      const fetch = vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path === "/v1/rpc/bootstrap.get") return json(bootstrap([workspace]));
        if (path === "/v1/rpc/commands.dispatch") {
          if (eventFirst) await responseGate;
          return json({}, 202);
        }
        throw new Error(`Unexpected request ${path}`);
      }) as unknown as typeof globalThis.fetch;
      const client = createHttpHostClient({
        fetch,
        refreshIntervalMs: 0,
        webSocketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      });
      await client.load();
      const socket = sockets[0]!;
      socket.open();
      socket.receive({ snapshot: workspaceSnapshot(workspace, "0"), type: "host.snapshot" });
      socket.receive({
        events: [
          agentEvent(workspace.id, thread.id, null, "1", "thread.created", { thread }),
          agentEvent(workspace.id, thread.id, runId, "2", "request.opened", { request }),
          agentEvent(workspace.id, thread.id, null, "3", "thread.state-changed", {
            status: "waiting",
            inputQueuePaused: false,
            pendingRequests: 1,
          }),
        ],
        type: "host.events",
      });

      const responding = client.dispatch({
        idempotencyKey: `request-${request.id}:intermediate`,
        requestId: request.id,
        response: { kind: "choice", optionId },
        type: "request.respond",
      });
      if (eventFirst) {
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
        socket.receive({
          events: [
            agentEvent(workspace.id, thread.id, runId, "4", "request.updated", {
              request: updated,
            }),
          ],
          type: "host.events",
        });
        releaseResponse();
      }
      await responding;

      expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(1);
      expect(client.getSnapshot().requests[thread.id]).toEqual([
        expect.objectContaining({ id: request.id, status: "pending" }),
      ]);
      if (!eventFirst) {
        socket.receive({
          events: [
            agentEvent(workspace.id, thread.id, runId, "4", "request.updated", {
              request: updated,
            }),
          ],
          type: "host.events",
        });
        await vi.waitFor(() => {
          expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(1);
          expect(client.getSnapshot().requests[thread.id]).toEqual([
            expect.objectContaining({
              id: request.id,
              payload: updated.payload,
              status: "pending",
            }),
          ]);
        });
      }
      expect(client.getSnapshot().transcripts[thread.id] ?? []).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "request" })]),
      );
      client.dispose();
    },
  );

  it("reads a created AI engine back from the Host instead of waiting for the refresh tick", async () => {
    const workspace = makeWorkspace();
    const addedHarnessId = createId("harnessInstance");
    const paths: string[] = [];
    let created = false;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      paths.push(path);
      if (path === "/v1/rpc/commands.dispatch") {
        created = true;
        return json({
          harness: {
            config: {},
            driverKind: "claude",
            enabled: true,
            environmentId,
            id: addedHarnessId,
            isDefault: false,
            name: "Claude",
            runtimeRevision: 1,
            sourceId: "anthropic",
            stateKind: "isolated",
          },
        });
      }
      const payload = bootstrap([workspace]);
      return json(
        created
          ? {
              ...payload,
              harnesses: [
                ...payload.harnesses,
                {
                  config: {},
                  driverKind: "claude",
                  enabled: true,
                  environmentId,
                  id: addedHarnessId,
                  isDefault: false,
                  name: "Claude",
                  runtimeRevision: 1,
                  sourceId: "anthropic",
                  stateKind: "isolated" as const,
                },
              ],
            }
          : payload,
      );
    });
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      webSocketFactory: () => new FakeSocket(),
    });
    await client.load();
    expect(client.getSnapshot().harnesses).toHaveLength(1);

    await client.dispatch({
      driverKind: "claude",
      environmentId,
      idempotencyKey: "harness-create:test",
      name: "Claude",
      sourceId: "anthropic",
      stateKind: "isolated",
      type: "harness.create",
    });

    expect(client.getSnapshot().harnesses).toEqual([
      expect.objectContaining({ id: harnessInstanceId }),
      expect.objectContaining({ id: addedHarnessId, name: "Claude" }),
    ]);
    client.dispose();
  });

  it("refreshes after enable and delete mutations that can move a sibling default", async () => {
    const workspace = makeWorkspace();
    const secondId = createId("harnessInstance");
    let phase: "initial" | "disabled" | "deleted" = "initial";
    let bootstrapReads = 0;
    const firstHarness = {
      config: {},
      driverKind: "codex",
      enabled: true,
      environmentId,
      id: harnessInstanceId,
      isDefault: true,
      name: "Codex",
      runtimeRevision: 1,
      sourceId: "openai",
      stateKind: "ambient" as const,
    };
    const secondHarness = {
      config: {},
      driverKind: "codex",
      enabled: true,
      environmentId,
      id: secondId,
      isDefault: false,
      name: "Codex Work",
      runtimeRevision: 1,
      sourceId: "openai",
      stateKind: "isolated" as const,
    };
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === "/v1/rpc/commands.dispatch") {
        const command = asObject(JSON.parse(String(init?.body)));
        if (requiredString(command, "type") === "harness.enabled.set") {
          phase = "disabled";
          return json({ harness: { ...firstHarness, enabled: false, isDefault: false } });
        }
        phase = "deleted";
        return json({}, 202);
      }
      bootstrapReads += 1;
      const payload = bootstrap([workspace]);
      return json({
        ...payload,
        harnesses:
          phase === "initial"
            ? [{ ...firstHarness, enabled: true, isDefault: true }, secondHarness]
            : phase === "disabled"
              ? [
                  { ...firstHarness, enabled: false, isDefault: false },
                  { ...secondHarness, isDefault: true },
                ]
              : [{ ...firstHarness, enabled: false, isDefault: false }],
      });
    });
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      webSocketFactory: () => new FakeSocket(),
    });
    await client.load();

    await client.dispatch({
      enabled: false,
      environmentId,
      harnessInstanceId,
      idempotencyKey: "harness-enabled:refresh",
      type: "harness.enabled.set",
    });
    expect(
      client.getSnapshot().harnesses.map(({ enabled, id, isDefault }) => ({
        enabled,
        id,
        isDefault,
      })),
    ).toEqual([
      { enabled: false, id: harnessInstanceId, isDefault: false },
      { enabled: true, id: secondId, isDefault: true },
    ]);

    await client.dispatch({
      environmentId,
      harnessInstanceId: secondId,
      idempotencyKey: "harness-delete:refresh",
      type: "harness.delete",
    });
    expect(client.getSnapshot().harnesses).toEqual([
      expect.objectContaining({ enabled: false, id: harnessInstanceId, isDefault: false }),
    ]);
    expect(bootstrapReads).toBe(3);
    client.dispose();
  });

  it("projects a renamed AI engine without carrying its driver configuration into the snapshot", async () => {
    const workspace = makeWorkspace();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path !== "/v1/rpc/commands.dispatch") return json(bootstrap([workspace]));
      const command: unknown = JSON.parse(String(init?.body));
      expect(requiredString(asObject(command), "type")).toBe("harness.rename");
      return json({
        harness: {
          config: { apiKey: "do-not-retain" },
          driverKind: "codex",
          enabled: true,
          environmentId,
          id: harnessInstanceId,
          isDefault: true,
          name: "Codex Prime",
          runtimeRevision: 2,
          sourceId: "openai",
          stateKind: "ambient",
        },
      });
    });
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      webSocketFactory: () => new FakeSocket(),
    });
    await client.load();

    await client.dispatch({
      environmentId,
      harnessInstanceId,
      idempotencyKey: "harness-rename:test",
      name: "Codex Prime",
      type: "harness.rename",
    });

    expect(client.getSnapshot().harnesses).toEqual([
      {
        driverKind: "codex",
        enabled: true,
        environmentId,
        id: harnessInstanceId,
        isDefault: true,
        name: "Codex Prime",
        runtimeRevision: 2,
        sourceId: "openai",
        stateKind: "ambient",
      },
    ]);
    expect(JSON.stringify(client.getSnapshot())).not.toContain("do-not-retain");
    client.dispose();
  });

  it("composes caller cancellation into the pending Host request", async () => {
    const workspace = makeWorkspace();
    const controller = new AbortController();
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path !== "/v1/rpc/workspace.files.list") return json(bootstrap([workspace]));
      signals.push(init?.signal);
      init?.signal?.throwIfAborted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      webSocketFactory: () => new FakeSocket(),
    });
    await client.load();

    const pending = client.listWorkspaceFiles(workspace.id, { parentKey: "" }, controller.signal);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]?.aborted).toBe(false);
    const reason = new DOMException("Left the folder", "AbortError");
    const cancelled = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[0]?.reason).toBe(reason);
    await cancelled;
    await expect(
      client.listWorkspaceFiles(workspace.id, { parentKey: "" }, controller.signal),
    ).rejects.toBe(reason);
    expect(signals).toHaveLength(1);
    client.dispose();
  });

  it("releases the viewer transport and its frame when a Browser Session is closed", async () => {
    const workspace = makeWorkspace();
    const profileId = createId("browserProfile");
    const sessionId = createBrowserSessionId();
    const sockets: Array<{ socket: FakeSocket; url: string }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path !== "/v1/rpc/commands.dispatch") {
        return json(
          bootstrap([workspace], {
            profileGrants: [],
            available: true,
            placements: [
              {
                available: true,
                environmentIds: [],
                kind: "runner",
                label: "Main Host",
                runnerId: runnerId,
                runtimeId: "runtime-1",
              },
            ],
            profiles: [{ id: profileId, name: "Default browser", revision: 0 }],
            sessions: [],
          }),
        );
      }
      const command = asObject(JSON.parse(String(init?.body)));
      if (requiredString(command, "type") === "browser.session.close") return json({}, 202);
      return json(
        {
          session: {
            access: "full-control",
            createdAt: now,
            id: sessionId,
            origin: "workspace",
            placement: { kind: "runner", runnerId: runnerId },
            profileId,
            runtimeId: "runtime-1",
            state: "ready",
            updatedAt: now,
            workspaceId: workspace.id,
          },
          wasExisting: false,
        },
        201,
      );
    });
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      webSocketFactory: (url) => {
        const socket = new FakeSocket();
        sockets.push({ socket, url });
        return socket;
      },
    });
    await client.load();
    await client.startBrowser(workspace.id, { kind: "profile", profileId });
    const release = client.retainBrowserViewer(sessionId);
    const viewer = sockets.find(({ url }) => url.includes("/browser-sessions/"))?.socket;
    expect(viewer).toBeDefined();
    viewer?.open();
    viewer?.receiveRaw({
      access: "full-control",
      dialog: null,
      sessionId,
      state: "ready",
      surfaces: [{ active: true, id: "page-1", title: "Example", url: "https://example.com/" }],
      type: "browser.snapshot",
    });
    viewer?.receiveBinary(browserFrame(1));
    expect(client.browserFrames.get(sessionId)).not.toBeNull();

    // Re-opening the same session must keep the viewer state only the client
    // holds; the Host record says nothing about tabs or socket health.
    await client.startBrowser(workspace.id, { kind: "profile", profileId });
    expect(client.getSnapshot().browserSessions[0]).toMatchObject({
      tabs: [expect.objectContaining({ title: "Example" })],
      viewerState: "synchronized",
    });

    await client.dispatch({
      idempotencyKey: "browser-close:test",
      sessionId,
      type: "browser.session.close",
    });

    expect(viewer?.closeEvents).toEqual([{ code: 1000, reason: "Client closed" }]);
    expect(client.browserFrames.get(sessionId)).toBeNull();
    expect(client.getSnapshot().browserSessions[0]?.state).toBe("closed");
    release();
    client.dispose();
  });
});

describe("HttpHostClient lifecycle", () => {
  it("stops polling and stops burning reconnect backoff while backgrounded", async () => {
    vi.useFakeTimers();
    const workspace = makeWorkspace();
    const platform = fakeLifecycle();
    const sockets: FakeSocket[] = [];
    let bootstrapCalls = 0;
    const client = createHttpHostClient({
      fetch: async () => {
        bootstrapCalls += 1;
        return json(bootstrap([workspace]));
      },
      lifecycle: platform.lifecycle,
      refreshIntervalMs: 1_000,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    sockets[0]?.open();
    await vi.advanceTimersByTimeAsync(2_500);
    const polledWhileVisible = bootstrapCalls;
    expect(polledWhileVisible).toBeGreaterThan(1);

    platform.enterBackground();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bootstrapCalls).toBe(polledWhileVisible);
    // The socket stays: the operating system decides whether it survives.
    expect(sockets[0]?.closeEvents).toEqual([]);

    // A socket lost while hidden waits for the return rather than backing off.
    sockets[0]?.serverClose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    client.dispose();
  });

  it("keeps reconnecting while hidden when it shows the person's notifications", async () => {
    vi.useFakeTimers();
    const workspace = makeWorkspace();
    const platform = fakeLifecycle();
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      lifecycle: platform.lifecycle,
      refreshIntervalMs: 1_000,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    sockets[0]?.open();
    const unsubscribe = client.subscribeNotifications(() => undefined);

    platform.enterBackground();
    // Hidden is when a notification is worth showing, so a lost socket returns.
    sockets[0]?.serverClose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets.length).toBeGreaterThan(1);
    const reopened = sockets.length;
    sockets.at(-1)?.open();

    // A network handover replaces it while hidden, too.
    platform.changeNetwork("online");
    expect(sockets.length).toBe(reopened + 1);

    // With nobody listening, hidden sockets wait for the return again.
    unsubscribe();
    sockets.at(-1)?.serverClose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets.length).toBe(reopened + 1);

    // A listener that arrives while hidden reopens what was left closed.
    client.subscribeNotifications(() => undefined);
    expect(sockets.length).toBe(reopened + 2);
    client.dispose();
  });

  it("keeps a briefly backgrounded socket that answers its correlated probe", async () => {
    vi.useFakeTimers();
    const workspace = makeWorkspace();
    const platform = fakeLifecycle();
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      lifecycle: platform.lifecycle,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({ snapshot: workspaceSnapshot(workspace, "4"), type: "host.snapshot" });
    socket.receive({
      sequence: sequence("4"),
      type: "host.synchronized",
      workspaceId: workspace.id,
    });

    platform.enterBackground();
    await vi.advanceTimersByTimeAsync(5_000);
    platform.enterForeground();

    const nonce = sentPingNonce(socket);
    expect(nonce).toBeTruthy();
    socket.receive({ nonce: nonce!, type: "host.pong" });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sockets).toHaveLength(1);
    expect(socket.closeEvents).toEqual([]);
    expect(client.getSnapshot().connection).toBe("connected");
    client.dispose();
  });

  it("replaces a socket that never answers its probe and resumes from its cursor", async () => {
    vi.useFakeTimers();
    const workspace = makeWorkspace();
    const platform = fakeLifecycle();
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      lifecycle: platform.lifecycle,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const dead = sockets[0]!;
    dead.open();
    dead.receive({ snapshot: workspaceSnapshot(workspace, "7"), type: "host.snapshot" });
    dead.receive({ sequence: sequence("7"), type: "host.synchronized", workspaceId: workspace.id });

    platform.enterBackground();
    await vi.advanceTimersByTimeAsync(5_000);
    platform.enterForeground();
    expect(sentPingNonce(dead)).toBeTruthy();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(dead.closeEvents).toEqual([{ code: 1000, reason: "Liveness probe unanswered" }]);
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();
    expect(parseSent(sockets[1]!, 0)).toMatchObject({
      afterSequence: "7",
      type: "client.subscribe",
      workspaceId: workspace.id,
    });
    client.dispose();
  });

  it("keeps a probed channel whose subscription delivers before the answer does", async () => {
    vi.useFakeTimers();
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      realtimeLiveness: { deadlineMs: 1_000, idleMs: 1_000 },
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({ snapshot: workspaceSnapshot(workspace, "4"), type: "host.snapshot" });
    socket.receive({
      sequence: sequence("4"),
      type: "host.synchronized",
      workspaceId: workspace.id,
    });

    await vi.advanceTimersByTimeAsync(1_500);
    expect(sentPingNonce(socket)).toBeTruthy();
    // A slow route can hold the answer behind frames that prove the socket works.
    socket.receive({
      events: [
        agentEvent(workspace.id, thread.id, null, "5", "thread.state-changed", {
          inputQueuePaused: false,
          pendingRequests: 0,
          status: "running",
        }),
      ],
      type: "host.events",
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sockets).toHaveLength(1);
    expect(socket.closeEvents).toEqual([]);
    client.dispose();
  });

  it("watches retained sockets again when a listener arrives while hidden", async () => {
    vi.useFakeTimers();
    const workspace = makeWorkspace();
    const platform = fakeLifecycle();
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      lifecycle: platform.lifecycle,
      realtimeLiveness: { deadlineMs: 1_000, idleMs: 1_000 },
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({ snapshot: workspaceSnapshot(workspace, "4"), type: "host.snapshot" });
    socket.receive({
      sequence: sequence("4"),
      type: "host.synchronized",
      workspaceId: workspace.id,
    });

    // Hidden with nobody listening, nothing is judged and the socket is kept.
    platform.enterBackground();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sentPingNonce(socket)).toBeUndefined();

    // A listener makes the hidden socket worth keeping alive, so it is watched again.
    client.subscribeNotifications(() => undefined);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sentPingNonce(socket)).toBeTruthy();
    expect(socket.closeEvents).toEqual([{ code: 1000, reason: "Liveness probe unanswered" }]);
    expect(sockets).toHaveLength(2);
    client.dispose();
  });

  it("replaces every socket without probing when the background outlived the trust window", async () => {
    vi.useFakeTimers();
    const workspace = makeWorkspace();
    const platform = fakeLifecycle();
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      lifecycle: platform.lifecycle,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const stale = sockets[0]!;
    stale.open();
    stale.receive({ snapshot: workspaceSnapshot(workspace, "9"), type: "host.snapshot" });
    stale.receive({
      sequence: sequence("9"),
      type: "host.synchronized",
      workspaceId: workspace.id,
    });

    platform.enterBackground();
    await vi.advanceTimersByTimeAsync(10_000);
    platform.enterForeground();

    expect(sentPingNonce(stale)).toBeUndefined();
    expect(stale.closeEvents).toEqual([{ code: 1000, reason: "Client closed" }]);
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();
    expect(parseSent(sockets[1]!, 0)).toMatchObject({
      afterSequence: "9",
      type: "client.subscribe",
      workspaceId: workspace.id,
    });
    client.dispose();
  });

  it("replaces sockets on a network handover and waits out an offline interface", async () => {
    vi.useFakeTimers();
    const workspace = makeWorkspace();
    const platform = fakeLifecycle({ network: "online", visibility: "foreground" });
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      lifecycle: platform.lifecycle,
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 40,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const first = sockets[0]!;
    first.open();
    first.receive({ snapshot: workspaceSnapshot(workspace, "3"), type: "host.snapshot" });
    first.receive({
      sequence: sequence("3"),
      type: "host.synchronized",
      workspaceId: workspace.id,
    });

    platform.changeNetwork("offline");
    expect(first.closeEvents).toEqual([{ code: 1000, reason: "Client closed" }]);
    expect(client.getSnapshot().connection).toBe("offline");
    expect(client.getSnapshot().network).toBe("offline");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);

    platform.changeNetwork("online");
    expect(sockets).toHaveLength(2);
    expect(client.getSnapshot().network).toBe("online");
    expect(client.getSnapshot().connection).toBe("connecting");
    sockets[1]?.open();
    expect(parseSent(sockets[1]!, 0)).toMatchObject({
      afterSequence: "3",
      type: "client.subscribe",
      workspaceId: workspace.id,
    });
    client.dispose();
  });

  it("replaces sockets on a handover that never leaves the online state", async () => {
    const workspace = makeWorkspace();
    const platform = fakeLifecycle({ network: "online", visibility: "foreground" });
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      lifecycle: platform.lifecycle,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const wifi = sockets[0]!;
    wifi.open();
    wifi.receive({ snapshot: workspaceSnapshot(workspace, "5"), type: "host.snapshot" });
    wifi.receive({ sequence: sequence("5"), type: "host.synchronized", workspaceId: workspace.id });

    // Wi-Fi to cellular reports "online" on both sides of the move, and the
    // interface it left never reports the socket dead.
    platform.changeNetwork("online");

    expect(wifi.closeEvents).toEqual([{ code: 1000, reason: "Client closed" }]);
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();
    expect(parseSent(sockets[1]!, 0)).toMatchObject({
      afterSequence: "5",
      type: "client.subscribe",
      workspaceId: workspace.id,
    });
    client.dispose();
  });

  it("opens no socket for a bootstrap that lands after the app was hidden", async () => {
    const workspace = makeWorkspace();
    const platform = fakeLifecycle();
    const sockets: FakeSocket[] = [];
    const gate: Array<() => void> = [];
    let gated = true;
    const client = createHttpHostClient({
      fetch: async () => {
        if (gated) {
          gated = false;
          await new Promise<void>((resolve) => gate.push(resolve));
        }
        return json(bootstrap([workspace]));
      },
      lifecycle: platform.lifecycle,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const loaded = client.load();
    platform.enterBackground();
    gate[0]?.();
    await loaded;

    // The Workspace channel exists and holds its cursor; only the socket waits.
    expect(sockets).toEqual([]);
    platform.enterForeground();
    expect(sockets).toHaveLength(1);
    sockets[0]?.open();
    expect(parseSent(sockets[0]!, 0)).toMatchObject({
      afterSequence: "0",
      type: "client.subscribe",
      workspaceId: workspace.id,
    });
    client.dispose();
  });

  it("opens no socket for a refresh that lands while the device is offline", async () => {
    const workspace = makeWorkspace();
    const platform = fakeLifecycle({ network: "online", visibility: "foreground" });
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      lifecycle: platform.lifecycle,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const first = sockets[0]!;
    first.open();
    first.receive({ snapshot: workspaceSnapshot(workspace, "2"), type: "host.snapshot" });
    first.receive({
      sequence: sequence("2"),
      type: "host.synchronized",
      workspaceId: workspace.id,
    });

    platform.changeNetwork("offline");
    await client.refresh();
    expect(sockets).toHaveLength(1);

    platform.changeNetwork("online");
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();
    expect(parseSent(sockets[1]!, 0)).toMatchObject({
      afterSequence: "2",
      type: "client.subscribe",
      workspaceId: workspace.id,
    });
    client.dispose();
  });

  it("keeps a briefly hidden browser viewer and replaces a long-hidden one", async () => {
    vi.useFakeTimers();
    const workspace = makeWorkspace();
    const profileId = createId("browserProfile");
    const sessionId = createBrowserSessionId();
    const platform = fakeLifecycle();
    const sockets: Array<{ socket: FakeSocket; url: string }> = [];
    const client = createHttpHostClient({
      fetch: async () =>
        json(
          bootstrap([workspace], {
            available: true,
            placements: [
              {
                available: true,
                environmentIds: [],
                kind: "runner",
                label: "Main Host",
                runnerId,
                runtimeId: "runtime-1",
              },
            ],
            profileGrants: [],
            profiles: [{ id: profileId, name: "Default browser", revision: 0 }],
            sessions: [
              {
                access: "full-control",
                createdAt: now,
                id: sessionId,
                origin: "workspace",
                placement: { kind: "runner", runnerId },
                profileId,
                runtimeId: "runtime-1",
                state: "ready",
                updatedAt: now,
                workspaceId: workspace.id,
              },
            ],
          }),
        ),
      lifecycle: platform.lifecycle,
      refreshIntervalMs: 0,
      webSocketFactory: (url) => {
        const socket = new FakeSocket();
        sockets.push({ socket, url });
        return socket;
      },
    });
    const browserSockets = () =>
      sockets.filter(({ url }) => url.includes("/browser-sessions/")).map(({ socket }) => socket);
    await client.load();
    const release = client.retainBrowserViewer(sessionId);
    browserSockets()[0]?.open();

    platform.enterBackground();
    await vi.advanceTimersByTimeAsync(5_000);
    platform.enterForeground();
    // The viewer protocol carries no probe, so a socket inside the trust
    // window is kept rather than guessed at.
    expect(browserSockets()).toHaveLength(1);
    expect(browserSockets()[0]?.sent).toEqual([]);

    platform.enterBackground();
    await vi.advanceTimersByTimeAsync(10_000);
    platform.enterForeground();
    expect(browserSockets()[0]?.closeEvents).toEqual([{ code: 1000, reason: "Client closed" }]);
    expect(browserSockets()).toHaveLength(2);
    release();
    client.dispose();
  });

  it("releases its platform listeners when it is disposed", async () => {
    const workspace = makeWorkspace();
    const platform = fakeLifecycle();
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      lifecycle: platform.lifecycle,
      refreshIntervalMs: 0,
      webSocketFactory: () => new FakeSocket(),
    });
    await client.load();
    expect(platform.listenerCount()).toBe(3);
    client.dispose();
    expect(platform.listenerCount()).toBe(0);
  });

  it("surfaces a Host channel error through the connection state", async () => {
    vi.useFakeTimers();
    const workspace = makeWorkspace();
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      random: () => 0,
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 40,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const retried = sockets[0]!;
    retried.open();
    retried.receive({ snapshot: workspaceSnapshot(workspace, "1"), type: "host.snapshot" });
    retried.receive({
      sequence: sequence("1"),
      type: "host.synchronized",
      workspaceId: workspace.id,
    });

    retried.receive({
      error: { code: "internal", message: "The Workspace stream faulted.", retryable: true },
      type: "host.error",
    });
    expect(client.getSnapshot().connection).toBe("connecting");
    await vi.advanceTimersByTimeAsync(40);
    expect(sockets).toHaveLength(2);

    sockets[1]!.open();
    sockets[1]!.receive({
      error: { code: "forbidden", message: "This Workspace is not yours.", retryable: false },
      type: "host.error",
    });
    expect(client.getSnapshot().connection).toBe("offline");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
    client.dispose();
  });

  it("retries a retained non-home workspace and waits for synchronization", async () => {
    const home = makeWorkspace("Main");
    const other = makeWorkspace("Research");
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([home, other])),
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    client.activateWorkspace(other.id);
    for (const [index, workspace] of [home, other].entries()) {
      sockets[index]!.open();
      sockets[index]!.receive({
        snapshot: workspaceSnapshot(workspace, "1"),
        type: "host.snapshot",
      });
      sockets[index]!.receive({
        sequence: sequence("1"),
        type: "host.synchronized",
        workspaceId: workspace.id,
      });
    }
    expect(client.getSnapshot().connection).toBe("connected");
    sockets[1]!.receive({
      type: "host.error",
      error: { code: "internal", message: "Unavailable", retryable: false },
    });
    expect(client.getSnapshot().connection).toBe("offline");
    await client.refresh({ retryConnection: true });
    expect(sockets).toHaveLength(3);
    sockets[2]!.open();
    expect(parseSent(sockets[2]!, 0)).toMatchObject({ workspaceId: other.id });
    sockets[2]!.receive({ snapshot: workspaceSnapshot(other, "2"), type: "host.snapshot" });
    expect(client.getSnapshot().connection).toBe("connecting");
    sockets[2]!.receive({
      sequence: sequence("2"),
      type: "host.synchronized",
      workspaceId: other.id,
    });
    expect(client.getSnapshot().connection).toBe("connected");
    client.dispose();
  });
});

describe("HttpHostClient notifications", () => {
  function replyNotification(workspaceId: string): NotificationView {
    return {
      body: "Your flight moved to 8 pm.",
      id: createId("notification"),
      kind: "reply-published",
      messageId: createId("message"),
      occurredAt: now,
      requestId: null,
      runId: createId("run"),
      threadId: createId("thread"),
      title: "Opensteer",
      workspaceId: WorkspaceIdSchema.parse(workspaceId),
    };
  }

  it("delivers a notification once whichever sockets carry it, and never to a later viewer", async () => {
    const home = makeWorkspace("Main");
    const other = makeWorkspace("Research");
    const sockets: FakeSocket[] = [];
    let signedIn = true;
    const client = createHttpHostClient({
      fetch: async () =>
        signedIn
          ? json(bootstrap([home, other]))
          : json({ error: { code: "unauthorized", message: "Sign in again." } }, 401),
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const delivered: NotificationView[] = [];
    client.subscribeNotifications((notification) => delivered.push(notification));
    const failing = client.subscribeNotifications(() => {
      throw new Error("A listener's own fault.");
    });
    await client.load();
    client.activateWorkspace(other.id);
    expect(sockets).toHaveLength(2);
    for (const socket of sockets) socket.open();

    const reply = replyNotification(home.id);
    const raised = vi.spyOn(globalThis, "queueMicrotask").mockImplementation(() => undefined);
    for (const socket of sockets)
      socket.receive({ notification: reply, type: "host.notification" });
    const raisedCount = raised.mock.calls.length;
    raised.mockRestore();
    expect(delivered).toEqual([reply]);
    // Neither the frame, which names no Workspace of the socket's, nor the
    // failing listener costs a socket the Host will not replay it on.
    expect(raisedCount).toBe(1);
    expect(sockets.flatMap((socket) => socket.closeEvents)).toEqual([]);
    failing();

    signedIn = false;
    await expect(client.refresh()).rejects.toThrow();
    sockets[1]!.receive({
      notification: replyNotification(other.id),
      type: "host.notification",
    });
    expect(delivered).toEqual([reply]);
    client.dispose();
  });

  it("reports the viewer's time zone once per zone, again after a lost answer, never after a refusal", async () => {
    const workspace = makeWorkspace();
    let zone: string | undefined = "America/New_York";
    const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (
      this: Intl.DateTimeFormat,
    ) {
      return {
        ...resolvedOptions.call(this),
        timeZone: zone,
      } as Intl.ResolvedDateTimeFormatOptions;
    });
    const reports: unknown[] = [];
    let answer: "lost" | "refused" | "accepted" = "lost";
    const client = createHttpHostClient({
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname !== "/v1/rpc/commands.dispatch") return json(bootstrap([workspace]));
        const command = rpcPayload(url, init);
        reports.push(command.timeZone);
        if (answer === "lost") return json({ error: { code: "internal", message: "Lost" } }, 500);
        if (answer === "refused")
          return json({ error: { code: "bad_request", message: "Unknown zone" } }, 400);
        return json({ timeZone: command.timeZone });
      },
      refreshIntervalMs: 0,
      timeZoneReports: "observed",
      webSocketFactory: () => new FakeSocket(),
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    await client.load();
    await settle();
    expect(reports).toEqual(["America/New_York"]);
    answer = "accepted";
    await client.refresh();
    await settle();
    await client.refresh();
    await settle();
    expect(reports).toEqual(["America/New_York", "America/New_York"]);

    zone = "Europe/Paris";
    answer = "refused";
    await client.refresh();
    await settle();
    await client.refresh();
    await settle();
    expect(reports).toEqual(["America/New_York", "America/New_York", "Europe/Paris"]);

    for (const unreadable of [undefined, "Not/AZone"]) {
      zone = unreadable;
      await client.refresh();
      await settle();
    }
    expect(reports).toHaveLength(3);
    vi.restoreAllMocks();
    client.dispose();
  });
});

describe("HttpHostClient Run activity and live streams", () => {
  function emptyWindow() {
    return { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 };
  }

  function historyPage(thread: Thread, events: AgentEvent[] = []) {
    return {
      events,
      thread,
      threadId: thread.id,
      window: { ...emptyWindow(), itemCount: events.length, threadId: thread.id },
    };
  }

  function activityOf(client: HttpHostClient, threadId: string) {
    const snapshot = client.getSnapshot();
    const thread = snapshot.threads.find(({ id }) => id === threadId);
    if (!thread) throw new Error("Thread not projected.");
    return {
      activity: threadActivity({
        entries: snapshot.transcripts[threadId] ?? [],
        runQueue: snapshot.runQueue,
        thread,
      }),
      stop: threadStopTarget({ runQueue: snapshot.runQueue, thread })?.id ?? null,
    };
  }

  function liveFrame(
    workspaceId: Thread["workspaceId"],
    threadId: Thread["id"],
    runId: NonNullable<AgentEvent["runId"]>,
    afterSequence: string,
    items: Extract<HostToClientMessage, { type: "host.live" }>["progress"]["items"],
  ): HostToClientMessage {
    return {
      afterSequence: sequence(afterSequence),
      progress: { items, runId, threadId, workspaceId },
      type: "host.live",
      workspaceId,
    };
  }

  it("derives one activity and Stop target from Host state, the Run queue and a requested Stop", async () => {
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    const runId = createId("run");
    const interrupted: string[] = [];
    const socket = new FakeSocket();
    const client = createHttpHostClient({
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/rpc/commands.dispatch") {
          interrupted.push(requiredString(rpcPayload(url, init), "runId"));
          return json({ wasDuplicate: false }, 202);
        }
        return json(bootstrap([workspace]));
      },
      refreshIntervalMs: 0,
      webSocketFactory: () => socket,
    });
    const state = (
      at: string,
      status: Thread["status"],
      pendingRequests = 0,
      inputQueuePaused = false,
    ) =>
      agentEvent(workspace.id, thread.id, null, at, "thread.state-changed", {
        inputQueuePaused,
        pendingRequests,
        status,
      });
    try {
      await client.load();
      client.activateThread(thread.id);
      socket.open();
      socket.receive({
        snapshot: { ...workspaceSnapshot(workspace, "0"), threads: [thread] },
        type: "host.snapshot",
      });
      expect(activityOf(client, thread.id)).toEqual({ activity: "idle", stop: null });

      socket.receive({
        events: [
          agentEvent(workspace.id, thread.id, runId, "1", "run.queued", {
            run: {
              createdAt: now,
              id: runId,
              runOrdinal: 0,
              status: "queued",
              threadId: thread.id,
            },
          }),
          state("2", "running"),
        ],
        type: "host.events",
      });
      // A Run can wait minutes for its computer or AI account; Stop reaches it there.
      expect(activityOf(client, thread.id)).toEqual({ activity: "queued", stop: runId });
      // Behind a paused queue it is already held for the person.
      socket.receive({ events: [state("3", "running", 0, true)], type: "host.events" });
      expect(activityOf(client, thread.id)).toEqual({ activity: "queued", stop: null });
      socket.receive({ events: [state("4", "running")], type: "host.events" });
      expect(activityOf(client, thread.id)).toEqual({ activity: "queued", stop: runId });

      socket.receive({
        events: [
          agentEvent(workspace.id, thread.id, runId, "5", "run.started", { status: "running" }),
        ],
        type: "host.events",
      });
      expect(activityOf(client, thread.id)).toEqual({ activity: "working", stop: runId });

      const request = pendingRequest({
        presentation: {
          detail: "Publish the release",
          kind: "choice",
          options: [{ hint: "confirm", id: "allow", label: "Publish" }],
          risk: "high",
          title: "Publish externally",
        },
        runId,
        threadId: thread.id,
        workspaceId: workspace.id,
      });
      socket.receive({
        events: [
          agentEvent(workspace.id, thread.id, runId, "6", "request.opened", { request }),
          state("7", "waiting", 1),
        ],
        type: "host.events",
      });
      expect(activityOf(client, thread.id)).toEqual({ activity: "waiting_for_you", stop: runId });

      await client.stopRun(thread.id);
      expect(interrupted).toEqual([runId]);
      expect(activityOf(client, thread.id)).toEqual({ activity: "stopping", stop: runId });
      // The Runner may still report the turn while the interrupt reaches it.
      socket.receive({
        events: [
          agentEvent(workspace.id, thread.id, runId, "8", "run.status", { status: "running" }),
        ],
        type: "host.events",
      });
      expect(activityOf(client, thread.id)).toEqual({ activity: "stopping", stop: runId });

      socket.receive({
        events: [
          agentEvent(workspace.id, thread.id, runId, "9", "run.interrupted", {
            status: "interrupted",
          }),
          state("10", "idle"),
        ],
        type: "host.events",
      });
      expect(activityOf(client, thread.id)).toEqual({ activity: "idle", stop: null });
    } finally {
      client.dispose();
    }
  });

  it("forgets what the previous viewer was streaming when the session ends", async () => {
    const workspace = makeWorkspace();
    const thread = { ...makeThread(workspace.id), status: "running" as const };
    const runId = createId("run");
    const collaborator = {
      ...authenticatedSession().user,
      displayName: "Sam",
      email: "sam@example.com",
      id: createId("user"),
    };
    let viewer: "collaborator" | "owner" | "signed-out" = "owner";
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/rpc/auth.config") return json(bootstrap([workspace]).identityConfig);
        if (viewer === "signed-out") return json({ error: unauthorizedError() }, 401);
        if (path === "/v1/rpc/thread.events.list")
          return json({
            ...historyPage(thread),
            readState: { ...defaultReadState(thread.id), asOfSequence: "1" },
          });
        return json(
          viewer === "owner"
            ? bootstrap([workspace])
            : { ...bootstrap([workspace]), user: collaborator },
        );
      },
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    try {
      await client.load();
      client.activateThread(thread.id);
      sockets[0]!.open();
      sockets[0]!.receive({
        snapshot: { ...workspaceSnapshot(workspace, "1"), threads: [thread] },
        type: "host.snapshot",
      });
      sockets[0]!.receive(
        liveFrame(workspace.id, thread.id, runId, "1", [
          { at: 0, op: "append", stream: "assistant", text: "Owner's draft" },
        ]),
      );
      expect(client.getSnapshot().transcripts[thread.id]).toContainEqual(
        expect.objectContaining({ body: "Owner's draft", id: `stream:${runId}` }),
      );

      viewer = "signed-out";
      await client.refresh();
      expect(client.getSnapshot().session).toBe("authentication-required");

      viewer = "collaborator";
      await client.reauthenticate();
      expect(client.getSnapshot().user?.id).toBe(collaborator.id);
      const second = sockets.at(-1)!;
      expect(second).not.toBe(sockets[0]);
      second.open();
      second.receive({
        snapshot: { ...workspaceSnapshot(workspace, "1"), threads: [thread] },
        type: "host.snapshot",
      });
      client.activateThread(thread.id);
      await vi.waitFor(() =>
        expect(client.getSnapshot().transcriptWindows[thread.id]).toBeDefined(),
      );

      expect(
        (client.getSnapshot().transcripts[thread.id] ?? []).filter(
          (entry) => entry.id === `stream:${runId}`,
        ),
      ).toEqual([]);
    } finally {
      client.dispose();
    }
  });

  it("drops a drawn stream the resubscribed connection no longer carries", async () => {
    const workspace = makeWorkspace();
    const thread = { ...makeThread(workspace.id), status: "running" as const };
    const runId = createId("run");
    const answer = { length: 11, op: "replace", stream: "assistant", text: "Alpha beta." } as const;
    let liveReads = 0;
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async (input) => {
        if (new URL(String(input)).pathname === "/v1/rpc/thread.live.get") {
          liveReads += 1;
          // What the Host still has open: the answer, which went on while the
          // connection was down. The reasoning block it was showing is not.
          return json({
            runs: [
              {
                afterSequence: "1",
                progress: {
                  items: [answer],
                  runId,
                  threadId: thread.id,
                  workspaceId: workspace.id,
                },
              },
            ],
            threadId: thread.id,
          });
        }
        return json(bootstrap([workspace]));
      },
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 5,
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    try {
      await client.load();
      client.activateThread(thread.id);
      const first = sockets[0]!;
      first.open();
      first.receive({
        snapshot: { ...workspaceSnapshot(workspace, "0"), threads: [thread] },
        type: "host.snapshot",
      });
      first.receive({
        events: [
          agentEvent(workspace.id, thread.id, runId, "1", "run.started", { status: "running" }),
        ],
        type: "host.events",
      });
      first.receive(
        liveFrame(workspace.id, thread.id, runId, "1", [
          { at: 0, blockId: "plan", op: "append", stream: "reasoning", text: "Weighing it" },
          { at: 0, op: "append", stream: "assistant", text: "Alpha" },
        ]),
      );
      expect((client.getSnapshot().transcripts[thread.id] ?? []).map(({ id }) => id)).toEqual([
        `run:${runId}`,
        `reasoning:${runId}:plan`,
        `stream:${runId}`,
      ]);

      first.close(1006, "lost");
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      const second = sockets[1]!;
      second.open();
      second.receive({
        sequence: sequence("1"),
        type: "host.synchronized",
        workspaceId: workspace.id,
      });
      // Going live, the Host sends each stream it still has open, whole.
      second.receive(liveFrame(workspace.id, thread.id, runId, "1", [answer]));
      await vi.waitFor(() => expect(liveReads).toBe(1));
      await vi.waitFor(() =>
        expect((client.getSnapshot().transcripts[thread.id] ?? []).map(({ id }) => id)).toEqual([
          `run:${runId}`,
          `stream:${runId}`,
        ]),
      );
      expect(client.getSnapshot().transcripts[thread.id]?.[1]).toMatchObject({
        body: "Alpha beta.",
        streaming: true,
      });
    } finally {
      client.dispose();
    }
  });

  it("rereads again when a frame goes missing while a reread is in flight", async () => {
    const workspace = makeWorkspace();
    const thread = { ...makeThread(workspace.id), status: "running" as const };
    const runId = createId("run");
    const firstAnswer = Promise.withResolvers<void>();
    const whole = "Alpha beta gamma delta epsilon zeta";
    let liveReads = 0;
    const socket = new FakeSocket();
    const client = createHttpHostClient({
      fetch: async (input) => {
        if (new URL(String(input)).pathname === "/v1/rpc/thread.live.get") {
          liveReads += 1;
          const read = liveReads;
          if (read === 1) await firstAnswer.promise;
          // The first read was taken before the second frame went missing.
          const text = read === 1 ? "Alpha beta" : whole;
          return json({
            runs: [
              {
                afterSequence: "1",
                progress: {
                  items: [{ length: text.length, op: "replace", stream: "assistant", text }],
                  runId,
                  threadId: thread.id,
                  workspaceId: workspace.id,
                },
              },
            ],
            threadId: thread.id,
          });
        }
        return json(bootstrap([workspace]));
      },
      refreshIntervalMs: 0,
      webSocketFactory: () => socket,
    });
    const append = (at: number, text: string) =>
      socket.receive(
        liveFrame(workspace.id, thread.id, runId, "1", [
          { at, op: "append", stream: "assistant", text },
        ]),
      );
    const drawn = () =>
      (client.getSnapshot().transcripts[thread.id] ?? []).find(
        (entry) => entry.id === `stream:${runId}`,
      );
    try {
      await client.load();
      client.activateThread(thread.id);
      socket.open();
      socket.receive({
        snapshot: { ...workspaceSnapshot(workspace, "0"), threads: [thread] },
        type: "host.snapshot",
      });
      socket.receive({
        events: [
          agentEvent(workspace.id, thread.id, runId, "1", "run.started", { status: "running" }),
        ],
        type: "host.events",
      });
      append(0, "Alpha ");
      append(17, "gamma ");
      await vi.waitFor(() => expect(liveReads).toBe(1));
      append(29, "epsilon ");
      firstAnswer.resolve();

      await vi.waitFor(() => expect(drawn()).toMatchObject({ body: whole }));
      expect(liveReads).toBe(2);
    } finally {
      client.dispose();
    }
  });

  it("reads a Thread's Requests once per Host count while the count lags the list", async () => {
    const workspace = makeWorkspace();
    const thread = { ...makeThread(workspace.id), status: "running" as const };
    const runId = createId("run");
    const request = pendingRequest({
      presentation: {
        detail: "Publish the release",
        kind: "choice",
        options: [{ hint: "confirm", id: "allow", label: "Publish" }],
        risk: "high",
        title: "Publish externally",
      },
      runId,
      threadId: thread.id,
      workspaceId: workspace.id,
    });
    let requestReads = 0;
    const socket = new FakeSocket();
    const client = createHttpHostClient({
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/rpc/thread.requests.list") {
          requestReads += 1;
          return json({ requests: [request], threadId: thread.id, window: emptyWindow() });
        }
        if (path === "/v1/rpc/thread.events.list") return json(historyPage(thread));
        return json(bootstrap([workspace]));
      },
      refreshIntervalMs: 0,
      webSocketFactory: () => socket,
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const state = (at: string, pendingRequests: number) =>
      agentEvent(workspace.id, thread.id, null, at, "thread.state-changed", {
        inputQueuePaused: false,
        pendingRequests,
        status: "waiting",
      });
    try {
      await client.load();
      socket.open();
      socket.receive({
        snapshot: { ...workspaceSnapshot(workspace, "0"), threads: [thread] },
        type: "host.snapshot",
      });
      client.activateThread(thread.id);
      // The Host counts a second Request its list does not return yet.
      socket.receive({
        events: [
          agentEvent(workspace.id, thread.id, runId, "1", "request.opened", { request }),
          state("2", 2),
        ],
        type: "host.events",
      });
      await vi.waitFor(() => expect(requestReads).toBe(1));
      for (let at = 3; at < 9; at += 1) {
        await settle();
        socket.receive({
          events: [
            agentEvent(workspace.id, thread.id, runId, String(at), "tool.started", {
              arguments: {},
              callId: `call-${at}`,
              tool: { name: "shell", namespace: "codex" },
            }),
          ],
          type: "host.events",
        });
      }
      await settle();
      expect(requestReads).toBe(1);

      // A new count is a new question.
      socket.receive({ events: [state("9", 3)], type: "host.events" });
      await vi.waitFor(() => expect(requestReads).toBe(2));
    } finally {
      client.dispose();
    }
  });

  it("retains selection state live and after reload without adding conversation rows", async () => {
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    const switched = {
      ...thread,
      modelSelection: ModelSelectionSchema.parse({
        modelId: "gpt-5.6-sol",
        options: { effort: "high" },
        providerId: "openai",
      }),
    };
    const event = agentEvent(workspace.id, thread.id, null, "1", "thread.execution-updated", {
      thread: switched,
    });
    let history: AgentEvent[] = [];
    const socket = new FakeSocket();
    const client = createHttpHostClient({
      fetch: async (input) => {
        if (new URL(String(input)).pathname === "/v1/rpc/thread.events.list") {
          return json(historyPage(history.length > 0 ? switched : thread, history));
        }
        return json(bootstrap([workspace]));
      },
      refreshIntervalMs: 0,
      webSocketFactory: () => socket,
    });
    const markers = () =>
      (client.getSnapshot().transcripts[thread.id] ?? []).filter(
        (entry) => entry.kind === "selection",
      );
    try {
      await client.load();
      client.activateThread(thread.id);
      socket.open();
      socket.receive({
        snapshot: { ...workspaceSnapshot(workspace, "0"), threads: [thread] },
        type: "host.snapshot",
      });
      await client.loadLatestTranscript(thread.id);

      socket.receive({ events: [event], type: "host.events" });
      const live = markers();
      expect(live).toEqual([
        expect.objectContaining({
          harnessInstanceId: switched.harnessInstanceId,
          id: event.eventId,
          modelSelection: switched.modelSelection,
        }),
      ]);
      expect(
        client.getSnapshot().threads.find(({ id }) => id === thread.id)?.modelSelection,
      ).toEqual(switched.modelSelection);
      expect(visibleTranscript(client.getSnapshot().transcripts[thread.id] ?? [], null)).toEqual(
        [],
      );

      history = [event];
      await client.loadLatestTranscript(thread.id);
      expect(markers()).toEqual(live);
      expect(visibleTranscript(client.getSnapshot().transcripts[thread.id] ?? [], null)).toEqual(
        [],
      );
    } finally {
      client.dispose();
    }
  });
});

describe("HttpHostClient task list", () => {
  type TaskWindow = { readonly hasMore: boolean; readonly nextBefore: string | null };

  function readStateOf(
    threadId: string,
    positions: {
      readonly placed?: { readonly done: boolean; readonly sequence: string };
      readonly read?: string;
      readonly revision?: string;
      readonly unread?: string;
    } = {},
  ) {
    return {
      asOfSequence: SequenceSchema.parse("9"),
      readSequence: positions.read === undefined ? null : SequenceSchema.parse(positions.read),
      threadId: ThreadIdSchema.parse(threadId),
      unreadSequence:
        positions.unread === undefined ? null : SequenceSchema.parse(positions.unread),
    };
  }

  it("publishes task readiness only after the accepted page's read states are installed", async () => {
    const main = makeWorkspace(),
      thread = makeThread(main.id),
      host = taskHost([main]);
    const client = createHttpHostClient({
      fetch: host.fetch,
      taskReads: "observed",
      refreshIntervalMs: 0,
    });
    const observed: boolean[] = [];
    const detach = client.subscribe(() => {
      const snapshot = client.getSnapshot();
      if (snapshot.savedViewReadiness?.tasksReady)
        observed.push(
          snapshot.threadReadStates[snapshot.tasks?.entries[0]?.thread.id ?? ""]?.readSequence ===
            "9",
        );
    });
    const loading = client.load();
    await vi.waitFor(() => expect(host.reads).toHaveLength(1));
    expect(client.getSnapshot().savedViewReadiness?.tasksReady).toBe(false);
    host.reads[0]!.answer(
      taskPage([thread], { hasMore: false, nextBefore: null }, [
        readStateOf(thread.id, { read: "9" }),
      ]),
    );
    await loading;
    await vi.waitFor(() => expect(client.getSnapshot().savedViewReadiness?.tasksReady).toBe(true));
    expect(observed.length).toBeGreaterThan(0);
    await client.refresh();
    await vi.waitFor(() => expect(host.reads).toHaveLength(2));
    const after = { ...makeThread(main.id), title: "After" };
    host.reads[1]!.answer(
      taskPage([after], { hasMore: false, nextBefore: null }, [
        readStateOf(after.id, { read: "9" }),
      ]),
    );
    await vi.waitFor(() =>
      expect(client.getSnapshot().tasks?.entries[0]?.thread.title).toBe("After"),
    );
    await vi.waitFor(() => expect(client.getSnapshot().savedViewReadiness?.tasksReady).toBe(true));
    expect(observed.every(Boolean)).toBe(true);
    detach();
    client.dispose();
  });

  /** A page as `tasks.list` answers it, with a plain read state for each task. */
  function taskPage(
    threads: readonly Thread[],
    window: TaskWindow,
    readStates = threads.map((thread) => readStateOf(thread.id)),
  ) {
    return {
      readStates,
      tasks: threads.map((thread) => ({
        failure: null,
        lastReply: `Last said in ${thread.title}`,
        thread,
      })),
      window: {
        byteCount: 2,
        itemCount: threads.length,
        totalItems: threads.length,
        ...window,
      },
    };
  }

  function task(workspaceId: Thread["workspaceId"], title: string, updatedAt: string): Thread {
    return { ...makeThread(workspaceId), createdAt: updatedAt, title, updatedAt };
  }

  /** A Host whose task reads each wait for the case to answer them. */
  function taskHost(workspaces: readonly WorkspaceView[]) {
    const activeReads: { before: unknown; answer: (page: unknown) => void }[] = [];
    let observeActive = false;
    const reads: {
      readonly before: unknown;
      readonly answer: (page: unknown, status?: number) => void;
      readonly workspaceId: unknown;
    }[] = [];
    const commands: Record<string, unknown>[] = [];
    let viewer: "owner" | "signed-out" | "someone-else" = "owner";
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/v1/rpc/auth.config") {
        return json(bootstrap([...workspaces]).identityConfig);
      }
      if (viewer === "signed-out") return json({ error: unauthorizedError() }, 401);
      if (url.pathname === "/v1/rpc/tasks.list") {
        const payload = rpcPayload(url, init);
        if (payload.active === true) {
          if (!observeActive) return json(taskPage([], { hasMore: false, nextBefore: null }));
          return new Promise((resolve) => {
            activeReads.push({ before: payload.before, answer: (page) => resolve(json(page)) });
          });
        }
        return new Promise((resolve) => {
          reads.push({
            answer: (page, status = 200) => resolve(json(page, status)),
            before: payload.before,
            workspaceId: payload.workspaceId,
          });
        });
      }
      if (url.pathname === "/v1/rpc/commands.dispatch") {
        const payload = rpcPayload(url, init);
        commands.push(payload);
        return json({
          thread: {
            ...makeThread(workspaces[0]!.id),
            id: requiredString(payload, "threadId"),
            doneAt: payload.done === true ? "2026-10-27T17:40:00.000Z" : null,
          },
          asOfSequence: String(9 + commands.length),
          wasDuplicate: false,
        });
      }
      const answer = bootstrap([...workspaces]);
      return json(
        viewer === "owner"
          ? answer
          : { ...answer, user: { ...answer.user, id: createId("user"), displayName: "Sam" } },
      );
    };
    return {
      commands,
      fetch,
      reads,
      activeReads,
      observeActive: () => {
        observeActive = true;
      },
      setViewer: (next: typeof viewer) => {
        viewer = next;
      },
    };
  }

  function sockets() {
    const opened: FakeSocket[] = [];
    return {
      factory: () => {
        const socket = new FakeSocket();
        opened.push(socket);
        return socket;
      },
      opened,
    };
  }

  function titles(client: HttpHostClient): (string | undefined)[] {
    return client.getSnapshot().tasks?.entries.map(({ thread }) => thread.title) ?? [];
  }

  /** Lets every answer already given reach the snapshot. */
  async function settled(): Promise<void> {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("keeps all active pages alongside 100 newer idle tasks, refreshes them together and clears completed work", async () => {
    const workspace = makeWorkspace();
    const host = taskHost([workspace]);
    host.observeActive();
    const socket = sockets();
    const client = createHttpHostClient({
      fetch: host.fetch,
      refreshIntervalMs: 0,
      taskReads: "observed",
      webSocketFactory: socket.factory,
    });
    const idle = Array.from({ length: 100 }, (_, index) =>
      task(workspace.id, `Idle ${index}`, "2026-08-09T10:00:00.000Z"),
    );
    const running = {
      ...task(workspace.id, "Older running", "2026-08-09T09:00:00.000Z"),
      status: "running" as const,
    };
    const waiting = {
      ...task(workspace.id, "Older waiting", "2026-08-09T08:00:00.000Z"),
      status: "waiting" as const,
    };
    try {
      await client.load();
      await vi.waitFor(() => {
        expect(host.reads).toHaveLength(1);
        expect(host.activeReads).toHaveLength(1);
      });
      host.reads[0]!.answer(taskPage(idle, { hasMore: true, nextBefore: "history" }));
      host.activeReads[0]!.answer(
        taskPage([running], { hasMore: true, nextBefore: "active-next" }),
      );
      await vi.waitFor(() => expect(host.activeReads).toHaveLength(2));
      expect(host.activeReads[1]!.before).toBe("active-next");
      host.activeReads[1]!.answer(
        taskPage([waiting], { hasMore: false, nextBefore: null }, [
          readStateOf(waiting.id, { read: "3" }),
        ]),
      );
      await vi.waitFor(() => expect(client.getSnapshot().activeTasks).toHaveLength(2));
      const before = client.getSnapshot();
      expect(before.tasks?.entries).toHaveLength(100);
      expect(before.tasks?.window.hasMore).toBe(true);
      expect(taskList(before).running).toBe(1);
      expect(taskList(before).working.map((row) => row.threadId)).toEqual(
        expect.arrayContaining([running.id, waiting.id]),
      );
      expect(workspaceTaskList(before, workspace.id).running).toBe(1);
      expect(liveWork(before).map((group) => group.threadId)).toEqual([running.id, waiting.id]);
      expect(before.threadReadStates[waiting.id]?.readSequence).toBe("3");
      expect(sameTaskListSource(before, { ...before, activeTasks: [] })).toBe(false);
      expect(sameLiveWorkSource(before, { ...before, activeTasks: [] })).toBe(false);
      const first = socket.opened[0]!;
      first.open();
      first.receive({ type: "host.tasks-changed" });
      await vi.waitFor(() => {
        expect(host.reads).toHaveLength(2);
        expect(host.activeReads).toHaveLength(3);
      });
      for (let n = 0; n < 3; n++) first.receive({ type: "host.tasks-changed" });
      host.reads[1]!.answer(taskPage(idle, { hasMore: true, nextBefore: "history-fresh" }));
      host.activeReads[2]!.answer(taskPage([], { hasMore: false, nextBefore: null }));
      await vi.waitFor(() => {
        expect(host.reads).toHaveLength(3);
        expect(host.activeReads).toHaveLength(4);
      });
      host.reads[2]!.answer(taskPage(idle, { hasMore: true, nextBefore: "history-latest" }));
      host.activeReads[3]!.answer(taskPage([], { hasMore: false, nextBefore: null }));
      await vi.waitFor(() => expect(client.getSnapshot().activeTasks).toEqual([]));
      expect(taskList(client.getSnapshot()).running).toBe(0);
      expect(liveWork(client.getSnapshot())).toEqual([]);
    } finally {
      client.dispose();
    }
  });

  it("reads the reader's tasks once signed in, and once more however many changes land during a read", async () => {
    const workspace = makeWorkspace();
    const flight = task(workspace.id, "Book the flight", "2026-08-09T10:00:00.000Z");
    const host = taskHost([workspace]);
    const socket = sockets();
    const client = createHttpHostClient({
      fetch: host.fetch,
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 5,
      refreshIntervalMs: 0,
      taskReads: "observed",
      webSocketFactory: socket.factory,
    });
    try {
      expect(client.getSnapshot().tasks).toBeNull();
      await client.load();
      await vi.waitFor(() => expect(host.reads).toHaveLength(1));
      expect(host.reads[0]!.before).toBeUndefined();
      expect(client.getSnapshot().tasks).toBeNull();

      const first = socket.opened[0]!;
      first.open();
      first.receive({ snapshot: workspaceSnapshot(workspace, "1"), type: "host.snapshot" });
      first.receive({
        sequence: sequence("1"),
        type: "host.synchronized",
        workspaceId: workspace.id,
      });
      for (let notice = 0; notice < 3; notice += 1) first.receive({ type: "host.tasks-changed" });
      await settled();
      expect(host.reads).toHaveLength(1);

      host.reads[0]!.answer(
        taskPage([flight], { hasMore: false, nextBefore: null }, [
          readStateOf(flight.id, { placed: { done: true, sequence: "3" }, read: "3", unread: "3" }),
        ]),
      );
      await vi.waitFor(() => expect(host.reads).toHaveLength(2));
      expect(client.getSnapshot().tasks?.entries).toEqual([
        expect.objectContaining({
          failure: null,
          lastReply: "Last said in Book the flight",
          thread: expect.objectContaining({
            createdAt: flight.createdAt,
            id: flight.id,
            title: "Book the flight",
            workspaceId: workspace.id,
          }),
        }),
      ]);
      expect(client.getSnapshot().threadReadStates[flight.id]).toMatchObject({
        readSequence: "3",
      });

      host.reads[1]!.answer(
        taskPage(
          [{ ...flight, title: "Book the return flight" }],
          {
            hasMore: false,
            nextBefore: null,
          },
          [{ ...readStateOf(flight.id), asOfSequence: SequenceSchema.parse("10") }],
        ),
      );
      await vi.waitFor(() => expect(titles(client)).toEqual(["Book the return flight"]));
      await settled();
      expect(host.reads).toHaveLength(2);

      // A connection that starts over may have missed a notice.
      first.close(1006, "lost");
      await vi.waitFor(() => expect(socket.opened).toHaveLength(2));
      const second = socket.opened[1]!;
      second.open();
      second.receive({ snapshot: workspaceSnapshot(workspace, "2"), type: "host.snapshot" });
      second.receive({
        sequence: sequence("2"),
        type: "host.synchronized",
        workspaceId: workspace.id,
      });
      await vi.waitFor(() => expect(host.reads).toHaveLength(3));
      expect(host.reads[2]!.before).toBeUndefined();
    } finally {
      client.dispose();
    }
  });

  it("rebuilds the loaded prefix with fresh cursors and read states after invalidation", async () => {
    const workspace = makeWorkspace();
    const host = taskHost([workspace]);
    const socket = sockets();
    const client = createHttpHostClient({
      fetch: host.fetch,
      refreshIntervalMs: 0,
      taskReads: "observed",
      webSocketFactory: socket.factory,
    });
    const one = task(workspace.id, "One", "2026-08-09T10:00:04.000Z");
    const removed = task(workspace.id, "Removed", "2026-08-09T10:00:03.000Z");
    const older = task(workspace.id, "Older", "2026-08-09T10:00:01.000Z");
    const newer = task(workspace.id, "Newer", "2026-08-09T10:00:06.000Z");
    const skipped = task(workspace.id, "Previously skipped", "2026-08-09T10:00:05.000Z");
    try {
      await client.load();
      await vi.waitFor(() => expect(host.reads).toHaveLength(1));
      host.reads[0]!.answer(taskPage([one, removed], { hasMore: true, nextBefore: "old-cursor" }));
      await vi.waitFor(() => expect(titles(client)).toEqual(["One", "Removed"]));
      const earlier = client.loadEarlierTasks();
      await vi.waitFor(() => expect(host.reads).toHaveLength(2));
      host.reads[1]!.answer(taskPage([older], { hasMore: false, nextBefore: null }));
      await earlier;
      const first = socket.opened[0]!;
      first.open();
      first.receive({ type: "host.tasks-changed" });
      await vi.waitFor(() => expect(host.reads).toHaveLength(3));
      host.reads[2]!.answer(
        taskPage([newer, skipped], { hasMore: true, nextBefore: "fresh-cursor" }),
      );
      await vi.waitFor(() => expect(host.reads).toHaveLength(4));
      expect(host.reads[3]!.before).toBe("fresh-cursor");
      host.reads[3]!.answer(
        taskPage([one, older], { hasMore: false, nextBefore: null }, [
          readStateOf(one.id),
          readStateOf(older.id, {
            placed: { done: true, sequence: "7" },
            revision: "1",
            read: "7",
          }),
        ]),
      );
      await vi.waitFor(() =>
        expect(titles(client)).toEqual(["Newer", "Previously skipped", "One", "Older"]),
      );
      expect(client.getSnapshot().tasks?.window.hasMore).toBe(false);
      expect(client.getSnapshot().threadReadStates[older.id]?.readSequence).toBe("7");
    } finally {
      client.dispose();
    }
  });

  it.each(["success", "refused", "newer event", "success with newer event"] as const)(
    "renames an unopened task across global and Workspace pages (%s)",
    async (outcome) => {
      const main = makeWorkspace("Main");
      const research = { ...makeWorkspace("Research"), kind: "specialized" as const };
      const venue = {
        ...task(research.id, "Find a venue", "2026-08-09T10:00:03.000Z"),
        status: "running" as const,
      };
      const host = taskHost([main, research]);
      const socket = sockets();
      const answer = Promise.withResolvers<void>();
      const commands: unknown[] = [];
      const client = createHttpHostClient({
        capabilities: ["thread-titles-v1"],
        taskReads: "observed",
        refreshIntervalMs: 0,
        webSocketFactory: socket.factory,
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.pathname === "/v1/rpc/commands.dispatch") {
            commands.push(rpcPayload(url, init));
            await answer.promise;
            return outcome.startsWith("success")
              ? json({ thread: { ...venue, title: "New venue name" }, asOfSequence: "5" })
              : json(
                  { error: { code: "bad_request", message: "Rename refused", retryable: false } },
                  400,
                );
          }
          if (url.pathname === "/v1/rpc/tasks.list" && rpcPayload(url, init).active === true)
            return json(
              taskPage([venue], { hasMore: false, nextBefore: null }, [
                { ...readStateOf(venue.id), asOfSequence: SequenceSchema.parse("0") },
              ]),
            );
          if (url.pathname === "/v1/rpc/thread.events.list")
            return json({
              thread: venue,
              threadId: venue.id,
              events: [],
              readState: { ...readStateOf(venue.id), asOfSequence: "0" },
              window: {
                byteCount: 2,
                hasMore: false,
                itemCount: 0,
                nextBefore: null,
                totalItems: 0,
                threadId: venue.id,
              },
            });
          return host.fetch(input, init);
        },
      });
      const scopedTitles = () =>
        client.getSnapshot().workspaceTasks[research.id]?.entries.map(({ thread }) => thread.title);
      try {
        await client.load();
        await vi.waitFor(() => expect(host.reads).toHaveLength(1));
        host.reads[0]!.answer(
          taskPage([venue], { hasMore: false, nextBefore: null }, [
            { ...readStateOf(venue.id), asOfSequence: SequenceSchema.parse("0") },
          ]),
        );
        await vi.waitFor(() => expect(titles(client)).toEqual([venue.title]));
        const loading = client.loadWorkspaceTasks(research.id);
        await vi.waitFor(() => expect(host.reads).toHaveLength(2));
        host.reads[1]!.answer(
          taskPage([venue], { hasMore: false, nextBefore: null }, [
            { ...readStateOf(venue.id), asOfSequence: SequenceSchema.parse("0") },
          ]),
        );
        await loading;
        expect(client.getSnapshot().threads).toEqual([]);
        const renaming = client.renameThread(venue.id, "New venue name").then(
          (thread) => ({ thread, error: null }),
          (error: unknown) => ({ thread: null, error }),
        );
        expect(titles(client)).toEqual(["New venue name"]);
        expect(scopedTitles()).toEqual(["New venue name"]);
        expect(commands).toEqual([
          expect.objectContaining({ type: "thread.rename", threadId: venue.id }),
        ]);
        expect(client.getSnapshot().activeTasks.map(({ thread }) => thread.title)).toEqual([
          "New venue name",
        ]);
        if (outcome.includes("newer event")) {
          client.activateWorkspace(research.id);
          const channel = socket.opened.at(-1)!;
          channel.open();
          channel.receive({
            type: "host.snapshot",
            snapshot: { ...workspaceSnapshot(research, "0"), threads: [] },
          });
          channel.receive({
            type: "host.events",
            events: [
              agentEvent(research.id, venue.id, null, "6", "thread.state-changed", {
                status: "waiting",
                inputQueuePaused: true,
                pendingRequests: 0,
                title: "Newer authoritative title",
              }),
            ],
          });
          expect(titles(client)).toEqual(["New venue name"]);
        }
        answer.resolve();
        const result = await renaming;
        const expected = outcome.includes("newer event")
          ? "Newer authoritative title"
          : outcome === "success"
            ? "New venue name"
            : venue.title;
        if (outcome.startsWith("success")) {
          expect(result.thread?.title).toBe(expected);
          expect(result.thread?.status).toBe(
            outcome.includes("newer event") ? "waiting" : "running",
          );
        } else expect(result.error).toMatchObject({ message: "Rename refused" });
        expect(titles(client)).toEqual([expected]);
        expect(scopedTitles()).toEqual([expected]);
        expect(client.getSnapshot().activeTasks.map(({ thread }) => thread.title)).toEqual([
          expected,
        ]);
        expect(client.getSnapshot().tasks?.entries[0]?.thread.status).toBe("running");
        await client.loadLatestTranscript(venue.id);
        expect(client.getSnapshot().threads.find(({ id }) => id === venue.id)?.title).toBe(
          expected,
        );
      } finally {
        answer.resolve();
        client.dispose();
      }
    },
  );

  it.each(["success", "refused", "newer event", "success with newer event"] as const)(
    "changes the icon of an unopened task across global and Workspace pages (%s)",
    async (outcome) => {
      const main = makeWorkspace("Main");
      const research = { ...makeWorkspace("Research"), kind: "specialized" as const };
      const venue = {
        ...task(research.id, "Find a venue", "2026-08-09T10:00:03.000Z"),
        status: "running" as const,
      };
      const host = taskHost([main, research]);
      const socket = sockets();
      const answer = Promise.withResolvers<void>();
      const commands: unknown[] = [];
      const client = createHttpHostClient({
        capabilities: ["thread-titles-v1", "task-marks-v1"],
        taskReads: "observed",
        refreshIntervalMs: 0,
        webSocketFactory: socket.factory,
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.pathname === "/v1/rpc/commands.dispatch") {
            commands.push(rpcPayload(url, init));
            await answer.promise;
            return outcome.startsWith("success")
              ? json({ thread: { ...venue, icon: "plane" }, asOfSequence: "5" })
              : json(
                  { error: { code: "bad_request", message: "Rename refused", retryable: false } },
                  400,
                );
          }
          if (url.pathname === "/v1/rpc/tasks.list" && rpcPayload(url, init).active === true)
            return json(
              taskPage([venue], { hasMore: false, nextBefore: null }, [
                { ...readStateOf(venue.id), asOfSequence: SequenceSchema.parse("0") },
              ]),
            );
          if (url.pathname === "/v1/rpc/thread.events.list")
            return json({
              thread: venue,
              threadId: venue.id,
              events: [],
              readState: { ...readStateOf(venue.id), asOfSequence: "0" },
              window: {
                byteCount: 2,
                hasMore: false,
                itemCount: 0,
                nextBefore: null,
                totalItems: 0,
                threadId: venue.id,
              },
            });
          return host.fetch(input, init);
        },
      });
      const scopedIcons = () =>
        client.getSnapshot().workspaceTasks[research.id]?.entries.map(({ thread }) => thread.icon);
      try {
        await client.load();
        await vi.waitFor(() => expect(host.reads).toHaveLength(1));
        host.reads[0]!.answer(
          taskPage([venue], { hasMore: false, nextBefore: null }, [
            { ...readStateOf(venue.id), asOfSequence: SequenceSchema.parse("0") },
          ]),
        );
        await vi.waitFor(() =>
          expect(client.getSnapshot().tasks?.entries.map(({ thread }) => thread.icon)).toEqual([
            venue.icon,
          ]),
        );
        const loading = client.loadWorkspaceTasks(research.id);
        await vi.waitFor(() => expect(host.reads).toHaveLength(2));
        host.reads[1]!.answer(
          taskPage([venue], { hasMore: false, nextBefore: null }, [
            { ...readStateOf(venue.id), asOfSequence: SequenceSchema.parse("0") },
          ]),
        );
        await loading;
        expect(client.getSnapshot().threads).toEqual([]);
        const renaming = client
          .dispatch({
            type: "thread.icon.set",
            threadId: venue.id,
            icon: "plane",
            idempotencyKey: "page-icon",
          })
          .then(
            (thread) => ({ thread, error: null }),
            (error: unknown) => ({ thread: null, error }),
          );
        expect(client.getSnapshot().tasks?.entries.map(({ thread }) => thread.icon)).toEqual([
          "plane",
        ]);
        expect(scopedIcons()).toEqual(["plane"]);
        expect(commands).toEqual([
          expect.objectContaining({ type: "thread.icon.set", threadId: venue.id }),
        ]);
        expect(client.getSnapshot().activeTasks.map(({ thread }) => thread.icon)).toEqual([
          "plane",
        ]);
        if (outcome.includes("newer event")) {
          client.activateWorkspace(research.id);
          const channel = socket.opened.at(-1)!;
          channel.open();
          channel.receive({
            type: "host.snapshot",
            snapshot: { ...workspaceSnapshot(research, "0"), threads: [] },
          });
          channel.receive({
            type: "host.events",
            events: [
              agentEvent(research.id, venue.id, null, "6", "thread.state-changed", {
                status: "waiting",
                inputQueuePaused: true,
                pendingRequests: 0,
                icon: "gift",
              }),
            ],
          });
          expect(client.getSnapshot().tasks?.entries.map(({ thread }) => thread.icon)).toEqual([
            "plane",
          ]);
        }
        answer.resolve();
        const result = await renaming;
        const expected = outcome.includes("newer event")
          ? "gift"
          : outcome === "success"
            ? "plane"
            : venue.icon;
        if (outcome.startsWith("success")) {
          expect(result.thread?.type).toBe("thread.icon.set");
        } else expect(result.error).toMatchObject({ message: "Rename refused" });
        expect(client.getSnapshot().tasks?.entries.map(({ thread }) => thread.icon)).toEqual([
          expected,
        ]);
        expect(scopedIcons()).toEqual([expected]);
        expect(client.getSnapshot().activeTasks.map(({ thread }) => thread.icon)).toEqual([
          expected,
        ]);
        expect(client.getSnapshot().tasks?.entries[0]?.thread.status).toBe("running");
        await client.loadLatestTranscript(venue.id);
        expect(client.getSnapshot().threads.find(({ id }) => id === venue.id)?.icon).toBe(expected);
      } finally {
        answer.resolve();
        client.dispose();
      }
    },
  );

  it("keeps the task list of each Workspace a screen asked for, rereading it with the rest", async () => {
    const main = makeWorkspace("Main");
    const research = { ...makeWorkspace("Research"), kind: "specialized" as const };
    const host = taskHost([main, research]);
    const socket = sockets();
    const client = createHttpHostClient({
      fetch: host.fetch,
      refreshIntervalMs: 0,
      taskReads: "observed",
      webSocketFactory: socket.factory,
    });
    const venue = task(research.id, "Find a venue", "2026-08-09T10:00:03.000Z");
    const caterer = task(research.id, "Find a caterer", "2026-08-09T10:00:02.000Z");
    const budget = task(research.id, "Set the budget", "2026-08-09T10:00:01.000Z");
    const scoped = () => host.reads.filter(({ workspaceId }) => workspaceId === research.id);
    const scopedTitles = () =>
      client.getSnapshot().workspaceTasks[research.id]?.entries.map(({ thread }) => thread.title);
    try {
      expect(client.getSnapshot().workspaceTasks).toEqual({});
      await client.load();
      await vi.waitFor(() => expect(host.reads).toHaveLength(1));
      expect(host.reads[0]!.workspaceId).toBeUndefined();
      host.reads[0]!.answer(taskPage([venue], { hasMore: false, nextBefore: null }));
      await vi.waitFor(() => expect(titles(client)).toEqual(["Find a venue"]));

      // Asking twice while the first read is out asks once.
      const loads = Promise.all([
        client.loadWorkspaceTasks(research.id),
        client.loadWorkspaceTasks(research.id),
      ]);
      await vi.waitFor(() => expect(scoped()).toHaveLength(1));
      await settled();
      expect(scoped()).toHaveLength(1);
      expect(scoped()[0]!.before).toBeUndefined();
      scoped()[0]!.answer(
        taskPage([venue, caterer], { hasMore: true, nextBefore: "after-caterer" }),
      );
      await loads;
      expect(scopedTitles()).toEqual(["Find a venue", "Find a caterer"]);
      // The global list is its own.
      expect(titles(client)).toEqual(["Find a venue"]);

      const earlier = client.loadEarlierTasks(research.id);
      await vi.waitFor(() => expect(scoped()).toHaveLength(2));
      expect(scoped()[1]!.before).toBe("after-caterer");
      scoped()[1]!.answer(taskPage([budget], { hasMore: false, nextBefore: null }));
      await earlier;
      expect(scopedTitles()).toEqual(["Find a venue", "Find a caterer", "Set the budget"]);

      // A change rereads the first page of both lists, once each.
      const first = socket.opened[0]!;
      first.open();
      first.receive({ type: "host.tasks-changed" });
      first.receive({ type: "host.tasks-changed" });
      await vi.waitFor(() => expect(host.reads).toHaveLength(5));
      await settled();
      expect(host.reads).toHaveLength(5);
      const renamed = {
        ...venue,
        title: "Find a bigger venue",
        updatedAt: "2026-08-09T10:00:04.000Z",
      };
      for (const read of host.reads.slice(3)) {
        read.answer(
          taskPage([renamed], { hasMore: false, nextBefore: null }, [
            { ...readStateOf(renamed.id), asOfSequence: SequenceSchema.parse("10") },
          ]),
        );
      }
      await vi.waitFor(() => expect(scopedTitles()).toEqual(["Find a bigger venue"]));
      await vi.waitFor(() => expect(titles(client)).toEqual(["Find a bigger venue"]));
      // The two notices during the reads earned one more read of each list.
      await vi.waitFor(() => expect(host.reads).toHaveLength(7));
      for (const read of host.reads.slice(5)) {
        read.answer(
          taskPage([renamed], { hasMore: false, nextBefore: null }, [
            { ...readStateOf(renamed.id), asOfSequence: SequenceSchema.parse("10") },
          ]),
        );
      }
      await settled();
      expect(host.reads).toHaveLength(7);

      // A viewer who leaves takes every list with them.
      host.setViewer("signed-out");
      await client.refresh();
      expect(client.getSnapshot().workspaceTasks).toEqual({});
      host.setViewer("someone-else");
      await client.reauthenticate();
      await vi.waitFor(() => expect(host.reads).toHaveLength(8));
      await settled();
      expect(host.reads.slice(7).map(({ workspaceId }) => workspaceId)).toEqual([undefined]);
    } finally {
      client.dispose();
    }
  });

  it("places a task in Done and back, showing the Host's answer at once", async () => {
    const workspace = makeWorkspace();
    const finished = task(workspace.id, "Finished", "2026-08-09T10:00:00.000Z");
    const host = taskHost([workspace]);
    const client = createHttpHostClient({
      fetch: host.fetch,
      capabilities: ["shared-task-done-v1"],
      refreshIntervalMs: 0,
      taskReads: "observed",
      webSocketFactory: sockets().factory,
    });
    try {
      await client.load();
      await vi.waitFor(() => expect(host.reads).toHaveLength(1));
      host.reads[0]!.answer(
        taskPage([finished], { hasMore: false, nextBefore: null }, [
          readStateOf(finished.id, { read: "5", unread: "7" }),
        ]),
      );
      await vi.waitFor(() => expect(titles(client)).toEqual(["Finished"]));

      await client.setTaskDone(finished.id, true);
      expect(host.commands).toEqual([
        expect.objectContaining({
          done: true,
          threadId: finished.id,
          type: "thread.shared-done.set",
        }),
      ]);
      expect(client.getSnapshot().tasks?.entries[0]?.thread.doneAt).not.toBeNull();
      expect(client.getSnapshot().threadReadStates[finished.id]?.readSequence).toBe("5");

      await client.setTaskDone(finished.id, false);
      expect(host.commands[1]).toMatchObject({ done: false, type: "thread.shared-done.set" });
      expect(host.commands[1]!.idempotencyKey).not.toBe(host.commands[0]!.idempotencyKey);
      expect(client.getSnapshot().tasks?.entries[0]?.thread.doneAt).toBeNull();
    } finally {
      client.dispose();
    }
  });

  it("forgets the tasks of a viewer who left, including an answer still on its way", async () => {
    const workspace = makeWorkspace();
    const theirs = task(workspace.id, "Their task", "2026-08-09T10:00:00.000Z");
    const host = taskHost([workspace]);
    const client = createHttpHostClient({
      fetch: host.fetch,
      refreshIntervalMs: 0,
      taskReads: "observed",
      webSocketFactory: sockets().factory,
    });
    try {
      await client.load();
      await vi.waitFor(() => expect(host.reads).toHaveLength(1));
      host.reads[0]!.answer(taskPage([theirs], { hasMore: true, nextBefore: "more" }));
      await vi.waitFor(() => expect(titles(client)).toEqual(["Their task"]));
      const stale = client.loadEarlierTasks();
      await vi.waitFor(() => expect(host.reads).toHaveLength(2));

      host.setViewer("signed-out");
      await client.refresh();
      expect(client.getSnapshot().session).toBe("authentication-required");
      expect(client.getSnapshot().tasks).toBeNull();
      host.reads[1]!.answer(taskPage([theirs], { hasMore: false, nextBefore: null }));
      await stale;
      expect(client.getSnapshot().tasks).toBeNull();
      await client.loadEarlierTasks();
      expect(host.reads).toHaveLength(2);

      host.setViewer("someone-else");
      await client.reauthenticate();
      await vi.waitFor(() => expect(host.reads).toHaveLength(3));
      expect(host.reads[2]!.before).toBeUndefined();
      expect(client.getSnapshot().tasks).toBeNull();
      const mine = task(workspace.id, "My task", "2026-08-09T11:00:00.000Z");
      host.reads[2]!.answer(taskPage([mine], { hasMore: false, nextBefore: null }));
      await vi.waitFor(() => expect(titles(client)).toEqual(["My task"]));
    } finally {
      client.dispose();
    }
  });

  it("drops the tasks of a Workspace the Host refuses this reader", async () => {
    const home = makeWorkspace("Main");
    const other = { ...makeWorkspace("Research"), kind: "specialized" as const };
    const host = taskHost([home, other]);
    const socket = sockets();
    const client = createHttpHostClient({
      fetch: host.fetch,
      refreshIntervalMs: 0,
      taskReads: "observed",
      webSocketFactory: socket.factory,
    });
    const kept = task(home.id, "Kept", "2026-08-09T10:00:02.000Z");
    const refused = task(other.id, "Refused", "2026-08-09T10:00:01.000Z");
    try {
      await client.load();
      await vi.waitFor(() => expect(host.reads).toHaveLength(1));
      host.reads[0]!.answer(
        taskPage([kept, refused], { hasMore: false, nextBefore: null }, [
          readStateOf(kept.id),
          readStateOf(refused.id, { unread: "2" }),
        ]),
      );
      await vi.waitFor(() => expect(titles(client)).toEqual(["Kept", "Refused"]));

      const scopedLoad = client.loadWorkspaceTasks(other.id);
      await vi.waitFor(() => expect(host.reads).toHaveLength(2));
      host.reads[1]!.answer(taskPage([refused], { hasMore: false, nextBefore: null }));
      await scopedLoad;
      const refusedLoad = client.loadWorkspaceTasks(other.id);
      const refusal = expect(refusedLoad).rejects.toMatchObject({ code: "not_found" });
      await vi.waitFor(() => expect(host.reads).toHaveLength(3));
      host.reads[2]!.answer(
        { error: { code: "not_found", message: "Workspace not found", retryable: false } },
        404,
      );
      await refusal;
      expect(client.getSnapshot().workspaceTasks[other.id]).toBeUndefined();
      expect(titles(client)).toEqual(["Kept"]);
      expect(client.getSnapshot().threadReadStates[refused.id]).toBeUndefined();
    } finally {
      client.dispose();
    }
  });
});

describe("HttpHostClient owner views", () => {
  /** A real view and the machine that holds it, as the mock Host answers them. */
  async function ownerViewWorld() {
    const mock = new MockHostClient({ latencyMs: 0 });
    await mock.load();
    const app = (await mock.listApprovedComputerApps()).find(
      (candidate) => candidate.target.kind === "app",
    )!;
    const view = await mock.openComputerView(app.machineId, app.target);
    const machine = mock
      .getSnapshot()
      .machines.find((candidate) => candidate.id === app.machineId)!;
    mock.dispose();
    return { app, machine, view };
  }

  function ownerViewHost(
    machines: () => readonly unknown[],
    answer: (command: Readonly<Record<string, unknown>>) => Promise<Response>,
  ) {
    const workspace = makeWorkspace();
    const sockets: FakeSocket[] = [];
    const commands: Readonly<Record<string, unknown>>[] = [];
    const host = {
      bootstrap: async (): Promise<Response> =>
        json({ ...bootstrap([workspace]), machines: machines() }),
    };
    const client = createHttpHostClient({
      capabilities: ["ownerViewWindows"],
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname.endsWith("/commands.dispatch")) {
          const payload = rpcPayload(url, init);
          if (payload.type === "browser.history.clear" || payload.type === "browser.history.remove")
            return json({ type: payload.type });
          if (
            typeof payload.type === "string" &&
            /^(computer\.view|browser\.tab)\./u.test(payload.type)
          ) {
            commands.push(payload);
            return answer(payload);
          }
        }
        return host.bootstrap();
      },
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    /** The newest socket opens and catches up, as a reconnect does. */
    const connect = () => {
      const socket = sockets.at(-1)!;
      socket.open();
      socket.receive({
        sequence: sequence("1"),
        type: "host.synchronized",
        workspaceId: workspace.id,
      });
      return socket;
    };
    return { client, commands, connect, host, sockets, workspace };
  }
  async function browserOpenWorld() {
    const mock = new MockHostClient({ latencyMs: 0 });
    try {
      const session = mock.getSnapshot().browserSessions.find((value) => value.state === "ready")!;
      return await mock.openBrowserTab(session.id, {
        url: "https://pending.example/",
        idempotencyKey: "fixture-open",
      });
    } finally {
      mock.dispose();
    }
  }

  it("opens authoritative tabs before loading presentation scope without publishing pending rows", async () => {
    const opened = await browserOpenWorld();
    const host = ownerViewHost(
      () => [],
      async () => json(opened),
    );
    try {
      const target = { identity: { kind: "guest" as const } };
      const options = { url: "https://pending.example/", idempotencyKey: "before-load" };
      const opening = host.client.openBrowserTab(target, options);
      expect(host.client.getSnapshot().pendingBrowserTabs ?? []).toEqual([]);
      await expect(opening).resolves.toEqual(opened);
      expect(host.commands).toEqual([{ type: "browser.tab.open", ...target, ...options }]);
      expect(host.client.getSnapshot().pendingBrowserTabs ?? []).toEqual([]);
      expect(host.sockets).toEqual([]);
      await host.client.load();
      expect(host.client.getSnapshot().pendingBrowserTabs).toEqual([]);
    } finally {
      host.client.dispose();
    }
  });

  it("publishes a pending browser row synchronously before dispatch and joins the same key", async () => {
    const opened = await browserOpenWorld();
    const gate = deferred<void>();
    const host = ownerViewHost(
      () => [],
      async () => {
        expect(host.client.getSnapshot().pendingBrowserTabs).toMatchObject([
          { idempotencyKey: "instant", state: "opening", url: "https://pending.example/" },
        ]);
        await withTimeout(gate.promise, 2_000, {
          timeoutError: () => new Error("The delayed browser command was never released."),
        });
        return json(opened);
      },
    );
    try {
      await host.client.load();
      const handle = host.client.beginBrowserTabOpen(
        { identity: { kind: "guest" } },
        {
          url: "https://pending.example/",
          idempotencyKey: "instant",
        },
      );
      expect(host.client.getSnapshot().pendingBrowserTabs).toHaveLength(1);
      const joined = host.client.beginBrowserTabOpen(
        { identity: { kind: "guest" } },
        {
          url: "https://pending.example/",
          idempotencyKey: "instant",
        },
      );
      expect(joined.result).toBe(handle.result);
      gate.resolve();
      await handle.result;
      expect(host.commands).toHaveLength(1);
      expect(host.client.getSnapshot().pendingBrowserTabs).toEqual([]);
    } finally {
      gate.resolve();
      host.client.dispose();
    }
  });

  it("retains an uncertain open and retries only its original command key and payload", async () => {
    const opened = await browserOpenWorld();
    let uncertain = true;
    const host = ownerViewHost(
      () => [],
      async () => {
        if (uncertain) throw new TypeError("Connection lost");
        return json(opened);
      },
    );
    try {
      await host.client.load();
      const target = { identity: { kind: "guest" as const } };
      const options = {
        url: "https://pending.example/",
        viewport: { width: 700, height: 500 },
        idempotencyKey: "uncertain",
      };
      await expect(host.client.beginBrowserTabOpen(target, options).result).rejects.toThrow();
      expect(host.client.getSnapshot().pendingBrowserTabs).toMatchObject([
        { idempotencyKey: "uncertain", state: "unknown" },
      ]);
      uncertain = false;
      await host.client.beginBrowserTabOpen(target, {
        url: options.url,
        idempotencyKey: options.idempotencyKey,
      }).result;
      expect(host.commands).toHaveLength(2);
      expect(host.commands[1]).toEqual(host.commands[0]);
      expect(host.client.getSnapshot().pendingBrowserTabs).toEqual([]);
    } finally {
      host.client.dispose();
    }
  });

  it("keeps a Host's explicit unknown-outcome conflict on the original key", async () => {
    const host = ownerViewHost(
      () => [],
      async () =>
        json(
          {
            error: {
              code: "conflict",
              reason: "browser-tab-open-outcome-unknown",
              message: "The original page outcome is unknown.",
            },
          },
          409,
        ),
    );
    try {
      await host.client.load();
      const target = { identity: { kind: "guest" as const } };
      const options = { idempotencyKey: "host-unknown" };
      await expect(host.client.beginBrowserTabOpen(target, options).result).rejects.toMatchObject({
        reason: "browser-tab-open-outcome-unknown",
      });
      expect(host.client.getSnapshot().pendingBrowserTabs).toMatchObject([
        { idempotencyKey: "host-unknown", state: "unknown" },
      ]);
      await expect(host.client.beginBrowserTabOpen(target, options).result).rejects.toThrow();
      expect(host.commands[1]).toEqual(host.commands[0]);
    } finally {
      host.client.dispose();
    }
  });

  it.each(["inventory-first", "response-first"])(
    "merges a pending result once with %s inventory",
    async (order) => {
      const opened = await browserOpenWorld();
      const gate = deferred<void>();
      const host = ownerViewHost(
        () => [],
        async () => {
          await withTimeout(gate.promise, 2_000, {
            timeoutError: () => new Error("The delayed browser command was never released."),
          });
          return json(opened);
        },
      );
      try {
        const bootstrapAnswer = host.host.bootstrap;
        await host.client.load();
        const socket = host.connect();
        const handle = host.client.beginBrowserTabOpen(
          { identity: { kind: "guest" } },
          { idempotencyKey: "merge" },
        );
        const inventory = async () => {
          host.host.bootstrap = async () => {
            const body = await (await bootstrapAnswer()).json();
            return json({
              ...body,
              browser: {
                available: true,
                sessions: [opened.session],
                profiles: [],
                placements: [],
                profileGrants: [],
              },
            });
          };
          await host.client.refresh();
          socket.receive({
            type: "host.browser-tabs-changed",
            sessionId: opened.sessionId,
            catalog: { ...opened.catalog, revision: opened.catalog.revision + 1 },
          });
        };
        if (order === "inventory-first") await inventory();
        gate.resolve();
        await handle.result;
        if (order === "response-first") await inventory();
        expect(
          host.client
            .getSnapshot()
            .browserSessions.filter((value) => value.id === opened.sessionId),
        ).toHaveLength(1);
        expect(
          host.client.getSnapshot().browserSessions.find((value) => value.id === opened.sessionId)
            ?.tabCatalog?.revision,
        ).toBe(opened.catalog.revision + 1);
        expect(host.client.getSnapshot().pendingBrowserTabs).toEqual([]);
      } finally {
        gate.resolve();
        host.client.dispose();
      }
    },
  );

  it("dismisses an opening immediately and closes only its exact late result", async () => {
    const opened = await browserOpenWorld();
    const gate = deferred<void>();
    const host = ownerViewHost(
      () => [],
      async (command) => {
        if (command.type === "browser.tab.close")
          return json({
            sessionId: opened.sessionId,
            outcome: "tab-closed",
            catalog: opened.catalog,
          });
        await withTimeout(gate.promise, 2_000, {
          timeoutError: () => new Error("The delayed browser command was never released."),
        });
        return json(opened);
      },
    );
    try {
      await host.client.load();
      const close = vi.spyOn(host.client, "closeBrowserTab");
      const handle = host.client.beginBrowserTabOpen(
        { identity: { kind: "guest" } },
        { idempotencyKey: "dismiss" },
      );
      host.client.dismissPendingBrowserTab(handle.idempotencyKey);
      expect(host.client.getSnapshot().pendingBrowserTabs).toEqual([]);
      gate.resolve();
      await handle.result;
      expect(close).toHaveBeenCalledExactlyOnceWith(opened.sessionId, opened.tabId, opened.catalog);
    } finally {
      gate.resolve();
      host.client.dispose();
    }
  });

  it.each(["sign-out", "person", "deployment"])(
    "forgets pending browser authority on %s and refuses a late result",
    async (change) => {
      const opened = await browserOpenWorld();
      const gate = deferred<void>();
      const host = ownerViewHost(
        () => [],
        async () => {
          await withTimeout(gate.promise, 2_000, {
            timeoutError: () => new Error("The delayed browser command was never released."),
          });
          return json(opened);
        },
      );
      try {
        await host.client.load();
        const handle = host.client.beginBrowserTabOpen(
          { identity: { kind: "guest" } },
          { idempotencyKey: "viewer-open" },
        );
        const answer = handle.result.catch((error: unknown) => error);
        const original = host.host.bootstrap;
        host.host.bootstrap = async () => {
          if (change === "sign-out")
            return json({ error: { code: "unauthorized", message: "Sign in." } }, 401);
          const body = await (await original()).json();
          return json(
            change === "person"
              ? { ...body, user: { ...body.user, id: createId("user") } }
              : { ...body, deploymentId: "dep_00000000-0000-4000-8000-000000000002" },
          );
        };
        if (change === "sign-out") await expect(host.client.refresh()).rejects.toThrow();
        else await host.client.refresh();
        expect(host.client.getSnapshot().pendingBrowserTabs).toEqual([]);
        gate.resolve();
        expect(await answer).toMatchObject({ code: "unauthorized" });
        expect(
          host.client
            .getSnapshot()
            .browserSessions.some((session) => session.id === opened.sessionId),
        ).toBe(false);
      } finally {
        gate.resolve();
        host.client.dispose();
      }
    },
  );

  it("does not complete a dismissed opening for a viewer who left during its authorized close", async () => {
    const opened = await browserOpenWorld();
    const openingGate = deferred<void>();
    const closingGate = deferred<void>();
    const closingStarted = deferred<void>();
    const host = ownerViewHost(
      () => [],
      async (command) => {
        if (command.type === "browser.tab.close") {
          closingStarted.resolve();
          await withTimeout(closingGate.promise, 2_000, {
            timeoutError: () => new Error("The authorized tab close was never released."),
          });
          return json({
            sessionId: opened.sessionId,
            outcome: "tab-closed",
            catalog: opened.catalog,
          });
        }
        await withTimeout(openingGate.promise, 2_000, {
          timeoutError: () => new Error("The pending tab open was never released."),
        });
        return json(opened);
      },
    );
    try {
      await host.client.load();
      const handle = host.client.beginBrowserTabOpen(
        { identity: { kind: "guest" } },
        { idempotencyKey: "dismiss-and-leave" },
      );
      const answer = handle.result.catch((error: unknown) => error);
      host.client.dismissPendingBrowserTab(handle.idempotencyKey);
      openingGate.resolve();
      await withTimeout(closingStarted.promise, 2_000, {
        timeoutError: () => new Error("The dismissed tab was never closed."),
      });
      host.host.bootstrap = async () =>
        json({ error: { code: "unauthorized", message: "Sign in." } }, 401);
      await expect(host.client.refresh()).rejects.toThrow();
      closingGate.resolve();
      expect(await answer).toMatchObject({ code: "unauthorized" });
    } finally {
      openingGate.resolve();
      closingGate.resolve();
      host.client.dispose();
    }
  });

  const renewals = (commands: readonly Readonly<Record<string, unknown>>[]) =>
    commands.filter((command) => command.type === "computer.view.renew").length;

  it.each(["command", "notice"] as const)(
    "keeps a second app window accepted through a %s while an older refresh is in flight",
    async (delivery) => {
      const { machine, view } = await ownerViewWorld();
      if (view.target.kind !== "app") throw new Error("Expected a Mac app view");
      const second = ComputerViewSchema.parse({
        ...view,
        viewId: `cvw_${crypto.randomUUID()}`,
        target: { ...view.target, window: 102 },
        window: { id: 102, title: "Second window" },
      });
      let listed = [machine];
      const host = ownerViewHost(
        () => listed,
        async () => json({ view: second }),
      );
      try {
        await host.client.load();
        const socket = host.connect();
        const bootstrapAnswer = host.host.bootstrap;
        const reading = deferred<void>();
        const release = deferred<void>();
        host.host.bootstrap = async () => {
          const response = await bootstrapAnswer();
          reading.resolve();
          await release.promise;
          return response;
        };
        const refreshing = host.client.refresh();
        await reading.promise;
        if (delivery === "command")
          await host.client.openComputerView(second.machineId, second.target);
        else socket.receive({ type: "host.computer-view.changed", view: second });
        const views = () =>
          host.client.getSnapshot().machines.find((candidate) => candidate.id === machine.id)
            ?.computerUse?.ownerViews;
        expect(views()).toEqual([view, second]);
        release.resolve();
        await refreshing;
        expect(views()).toEqual([view, second]);
        expect(
          placeList(host.client.getSnapshot()).filter((place) => place.ownerView),
        ).toHaveLength(2);

        // A read begun after the update still removes views the Host no longer lists.
        host.host.bootstrap = bootstrapAnswer;
        await host.client.refresh();
        expect(views()).toEqual([view]);
        listed = [{ ...machine, computerUse: { ...machine.computerUse!, ownerViews: [] } }];
        await host.client.refresh();
        expect(views()).toEqual([]);
      } finally {
        host.client.dispose();
      }
    },
  );

  it.each(["ready", "renewed", "reopened", "closed", "expired"] as const)(
    "preserves a %s view update over an in-flight refresh",
    async (change) => {
      const { machine, view } = await ownerViewWorld();
      const initial = change === "ready" ? { ...view, state: "opening" as const } : view;
      const updated = ComputerViewSchema.parse({
        ...view,
        generation: view.generation + (change === "reopened" ? 1 : 0),
        expiresAt:
          change === "renewed"
            ? new Date(Date.parse(view.expiresAt) + 30_000).toISOString()
            : view.expiresAt,
        state: change === "closed" || change === "expired" ? change : "ready",
        unavailableReason: change === "closed" || change === "expired" ? change : null,
      });
      const host = ownerViewHost(
        () => [{ ...machine, computerUse: { ...machine.computerUse!, ownerViews: [initial] } }],
        async () => json({ view: updated }),
      );
      try {
        await host.client.load();
        const socket = host.connect();
        const bootstrapAnswer = host.host.bootstrap;
        const reading = deferred<void>();
        const release = deferred<void>();
        host.host.bootstrap = async () => {
          const response = await bootstrapAnswer();
          reading.resolve();
          await release.promise;
          return response;
        };
        const refreshing = host.client.refresh();
        await reading.promise;
        socket.receive({ type: "host.computer-view.changed", view: updated });
        release.resolve();
        await refreshing;
        expect(
          host.client.getSnapshot().machines.find((candidate) => candidate.id === machine.id)
            ?.computerUse?.ownerViews,
        ).toEqual([updated]);
      } finally {
        host.client.dispose();
      }
    },
  );

  it("keeps a watched view renewed through failed renewals and a dropped connection, and stops on a terminal refusal", async () => {
    const { machine, view } = await ownerViewWorld();
    let refusal: "none" | "gateway" | "ended" = "none";
    const host = ownerViewHost(
      () => [machine],
      async () =>
        refusal === "gateway"
          ? json({ error: { code: "unavailable", message: "Bad gateway", retryable: true } }, 502)
          : refusal === "ended"
            ? json(
                {
                  error: {
                    code: "conflict",
                    message: "This view ended.",
                    reason: "computer-view-ended",
                  },
                },
                409,
              )
            : json({ view }),
    );
    await host.client.load();
    const socket = host.connect();
    expect(host.client.getSnapshot().connection).toBe("connected");
    vi.useFakeTimers();
    const held = host.client.retainComputerView(view.viewId, view.generation);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renewals(host.commands)).toBe(1);

    // A failed renewal is retried soon, not given up.
    refusal = "gateway";
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renewals(host.commands)).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(renewals(host.commands)).toBeGreaterThanOrEqual(3);
    refusal = "none";
    await vi.advanceTimersByTimeAsync(30_000);
    const recovered = renewals(host.commands);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renewals(host.commands)).toBe(recovered + 1);

    // Disconnected it waits; reconnected it renews at once, without waiting out a period.
    socket.serverClose();
    expect(host.client.getSnapshot().connection).not.toBe("connected");
    const offline = renewals(host.commands);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(renewals(host.commands)).toBe(offline);
    host.connect();
    expect(host.client.getSnapshot().connection).toBe("connected");
    await vi.advanceTimersByTimeAsync(0);
    expect(renewals(host.commands)).toBe(offline + 1);

    // Hidden it renews nothing; shown again it renews at once.
    held.setVisible(false);
    const hidden = renewals(host.commands);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(renewals(host.commands)).toBe(hidden);
    held.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(renewals(host.commands)).toBe(hidden + 1);

    // An ended view is not asked for again.
    refusal = "ended";
    await vi.advanceTimersByTimeAsync(30_000);
    const ended = renewals(host.commands);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(renewals(host.commands)).toBe(ended);
    held.release();
    host.client.dispose();
  });

  it("lets go of every view when the signed-in viewer changes", async () => {
    const { machine, view } = await ownerViewWorld();
    let signedIn = true;
    const host = ownerViewHost(
      () => [machine],
      async () => json({ view }),
    );
    const bootstrapAnswer = host.host.bootstrap;
    host.host.bootstrap = async () =>
      signedIn
        ? bootstrapAnswer()
        : json({ error: { code: "unauthorized", message: "Sign in." } }, 401);
    await host.client.load();
    host.connect();
    vi.useFakeTimers();
    host.client.retainComputerView(view.viewId, view.generation);
    signedIn = false;
    await expect(host.client.refresh()).rejects.toThrow();
    signedIn = true;
    await host.client.load();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(renewals(host.commands)).toBe(0);
    host.client.dispose();
  });

  it("never brings back a view the Host removed while an answer about it was on its way", async () => {
    const { machine, view } = await ownerViewWorld();
    const without = {
      ...machine,
      computerUse: { ...machine.computerUse!, ownerViews: [] },
    };
    let listed: readonly unknown[] = [without];
    const opening = deferred<void>();
    const host = ownerViewHost(
      () => listed,
      async (command) => {
        if (command.type === "computer.view.open") await opening.promise;
        return json({ view: command.type === "computer.view.open" ? view : view });
      },
    );
    await host.client.load();
    host.connect();
    const shown = () =>
      host.client
        .getSnapshot()
        .machines.flatMap((candidate) => candidate.computerUse?.ownerViews ?? [])
        .filter((candidate) => candidate.viewId === view.viewId);
    const opened = host.client.openComputerView(view.machineId, view.target);
    // Another device closed it; that notice arrives before this device's answer.
    host.sockets[0]!.receive({
      type: "host.computer-view.removed",
      viewId: view.viewId,
      generation: view.generation,
      machineId: view.machineId,
      reason: "closed",
    } as HostToClientMessage);
    opening.resolve();
    await opened;
    expect(shown()).toEqual([]);
    // Nor does a reread that left before the removal.
    listed = [machine];
    await host.client.refresh();
    expect(shown()).toEqual([]);
    // A newer generation of the same view is a new open, and is shown.
    const reopened = { ...view, generation: view.generation + 1 };
    host.sockets[0]!.receive({
      type: "host.computer-view.changed",
      view: reopened,
    } as HostToClientMessage);
    expect(shown()).toEqual([reopened]);
    host.client.dispose();
  });

  it("finishes an open the Host granted although history was cleared meanwhile, and refuses one for a viewer who left", async () => {
    const { machine, view } = await ownerViewWorld();
    const sessionId = createBrowserSessionId();
    const workspaceId = WorkspaceIdSchema.parse(createId("workspace"));
    let gate = deferred<void>();
    let signedIn = true;
    const host = ownerViewHost(
      () => [machine],
      async (command) => {
        await gate.promise;
        if (command.type === "computer.view.open") return json({ view });
        return json({
          sessionId,
          tabId: "page-1",
          catalog: { generation: 1, revision: 1, tabs: [] },
          browserStarted: true,
          session: {
            access: "full-control",
            createdAt: now,
            id: sessionId,
            origin: "workspace",
            placement: { kind: "runner", runnerId },
            profileId: null,
            runtimeId: "runtime",
            state: "ready",
            updatedAt: now,
            workspaceId,
          },
        });
      },
    );
    const bootstrapAnswer = host.host.bootstrap;
    host.host.bootstrap = async () =>
      signedIn
        ? bootstrapAnswer()
        : json({ error: { code: "unauthorized", message: "Sign in." } }, 401);
    await host.client.load();
    host.connect();
    const personal = {
      kind: "profile" as const,
      profileId: "bpr_00000000-0000-4000-8000-000000000001",
    };
    const viewOpen = host.client.openComputerView(view.machineId, view.target);
    const tabOpen = host.client.openBrowserTab(
      { identity: { kind: "guest" } },
      { url: "https://example.com/", typed: true },
    );
    expect(host.commands.find((command) => command.type === "browser.tab.open")).toMatchObject({
      typed: true,
    });
    // Clearing history has no effect on unrelated domain answers.
    await host.client.browserHistory.clear(personal.profileId);
    gate.resolve();
    await expect(viewOpen).resolves.toMatchObject({ viewId: view.viewId });
    await expect(tabOpen).resolves.toMatchObject({ sessionId, tabId: "page-1" });
    expect(
      host.client.getSnapshot().browserSessions.some((session) => session.id === sessionId),
    ).toBe(true);
    expect(host.client.browserHistory.entries(personal.profileId)).toEqual([]);

    // The person who asked is no longer the one signed in: the answer is not adopted.
    gate = deferred<void>();
    const late = host.client.openComputerView(view.machineId, view.target);
    signedIn = false;
    await expect(host.client.refresh()).rejects.toThrow();
    gate.resolve();
    const refused = await late.then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(HostClientRequestError);
    expect((refused as HostClientRequestError).code).toBe("unauthorized");
    host.client.dispose();
  });
});

function fakeLifecycle(
  initial: ClientLifecycleSnapshot = { network: "unknown", visibility: "foreground" },
) {
  let snapshot = initial;
  const background = new Set<() => void>();
  const foreground = new Set<() => void>();
  const network = new Set<(state: ClientNetworkState) => void>();
  const lifecycle: ClientLifecycle = {
    getSnapshot: () => snapshot,
    onBackground: (listener) => {
      background.add(listener);
      return () => void background.delete(listener);
    },
    onForeground: (listener) => {
      foreground.add(listener);
      return () => void foreground.delete(listener);
    },
    onNetworkChange: (listener) => {
      network.add(listener);
      return () => void network.delete(listener);
    },
  };
  return {
    changeNetwork: (state: ClientNetworkState) => {
      snapshot = { ...snapshot, network: state };
      for (const listener of network) listener(state);
    },
    enterBackground: () => {
      snapshot = { ...snapshot, visibility: "background" };
      for (const listener of background) listener();
    },
    enterForeground: () => {
      snapshot = { ...snapshot, visibility: "foreground" };
      for (const listener of foreground) listener();
    },
    lifecycle,
    listenerCount: () => background.size + foreground.size + network.size,
  };
}

function sentPingNonce(socket: FakeSocket): string | undefined {
  for (const raw of socket.sent) {
    const frame = JSON.parse(raw) as { readonly nonce?: string; readonly type?: string };
    if (frame.type === "client.ping") return frame.nonce;
  }
  return undefined;
}

describe("HttpHostClient saved-tab activation lifecycle", () => {
  const traces: Record<string, unknown>[] = [];
  let traceStart = 0;
  beforeEach(() => {
    traceStart = traces.length;
  });
  afterEach(({ task }) => {
    const observed = traces.slice(traceStart);
    expect(observed.length).toBeGreaterThan(0);
    Object.assign(task.meta, { workspaceTabActivationTrace: observed });
  });

  async function fixture(name: string, available = false) {
    const seed = new MockHostClient();
    const initial = seed.getSnapshot();
    const saved = initial.workspaceTabs!.find(
      (group) => group.session.profileId && group.tabs?.length,
    )!;
    const session = initial.browserSessions.find((value) => value.id === saved.session.id)!;
    const workspace = makeWorkspace();
    const group: WorkspaceTabLineage = {
      ...saved,
      session: { ...saved.session, workspaceId: workspace.id },
      tabs: saved.tabs!.map((tab) => ({ ...tab, state: "suspended" })),
    };
    const tabId = group.tabs![0]!.id;
    const browser = HostedBrowserBootstrapSchema.parse({
      available: true,
      workspaceTabRestoreVersion: 1,
      workspaceTabs: [group],
      profiles: initial.browserProfiles,
      profileGrants: [],
      sessions: [],
      placements: initial.browserPlacements.map((placement) => ({ ...placement, available })),
    });
    seed.dispose();
    const body = bootstrap([workspace], browser);
    const platform = fakeLifecycle({ network: "online", visibility: "foreground" });
    const sockets: FakeSocket[] = [];
    const requests: { reply: (response: Response) => void }[] = [];
    let concurrent = 0;
    let maximumConcurrent = 0;
    const concurrentByViewer = new Map<string, number>();
    let subscriptions = 0;
    let heldRead: Promise<void> | null = null;
    const client = createHttpHostClient({
      refreshIntervalMs: 0,
      lifecycle: platform.lifecycle,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname.endsWith("/commands.dispatch")) {
          expect(rpcPayload(url, init).type).toBe("workspace.tab.activate");
          concurrent++;
          const viewer = client.getSnapshot().user!.id;
          const viewerConcurrent = (concurrentByViewer.get(viewer) ?? 0) + 1;
          concurrentByViewer.set(viewer, viewerConcurrent);
          maximumConcurrent = Math.max(maximumConcurrent, viewerConcurrent);
          try {
            return await new Promise<Response>((reply) => requests.push({ reply }));
          } finally {
            concurrent--;
            concurrentByViewer.set(viewer, concurrentByViewer.get(viewer)! - 1);
          }
        }
        if (url.pathname.endsWith("/workspace.tabs.get")) {
          await heldRead;
          return json(group);
        }
        return json(body);
      },
    });
    const sync = () => {
      const socket = sockets.at(-1)!;
      socket.open();
      socket.receive({ type: "host.snapshot", snapshot: workspaceSnapshot(workspace, "1") });
      socket.receive({
        type: "host.synchronized",
        workspaceId: workspace.id,
        sequence: sequence("1"),
      });
    };
    await client.load();
    sync();
    const effects: { sessions: string[]; titles: string[] }[] = [];
    const stopEffects = client.subscribe(() => {
      const snapshot = client.getSnapshot();
      effects.push({
        sessions: snapshot.browserSessions.map((session) => session.id),
        titles: snapshot.browserSessions.flatMap(
          (session) => session.tabCatalog?.tabs.map((tab) => tab.title) ?? [],
        ),
      });
    });
    const subscribe = client.subscribe;
    vi.spyOn(client, "subscribe").mockImplementation((listener) => {
      subscriptions++;
      const stop = subscribe(listener);
      return () => {
        subscriptions--;
        stop();
      };
    });
    const success = (title?: string) =>
      json({
        type: "workspace.tab.activate",
        tabId,
        catalog: title
          ? {
              ...session.tabCatalog!,
              tabs: session.tabCatalog!.tabs.map((tab) => ({ ...tab, title })),
            }
          : session.tabCatalog,
        session: { ...group.session, state: "ready" },
        group: {
          ...group,
          revision: group.revision + 1,
          session: { ...group.session, state: "ready" },
          tabs: group.tabs!.map((tab) => ({ ...tab, state: "live" })),
        },
      });
    const waiting = () =>
      json(
        {
          error: {
            code: "conflict",
            reason: "browser-placement-waiting",
            message: "Computer is reconnecting",
            retryable: true,
          },
        },
        409,
      );
    const record = (phase: string) => {
      const observed = {
        name,
        phase,
        dispatches: requests.length,
        concurrent,
        maximumConcurrent,
        concurrentByViewer: Object.fromEntries(concurrentByViewer),
        subscriptions,
        pending: [...(client.getSnapshot().activatingWorkspaceTabs ?? [])],
      };
      traces.push(observed);
      expect(maximumConcurrent).toBeLessThanOrEqual(1);
      return observed;
    };
    return {
      client,
      effects,
      tabId,
      group,
      browser,
      session,
      body,
      platform,
      sockets,
      requests,
      sync,
      success,
      waiting,
      record,
      async ready(value: boolean) {
        body.browser.placements = body.browser.placements.map((placement) => ({
          ...placement,
          available: value,
        }));
        await client.refresh();
      },
      holdRead() {
        let release!: () => void;
        heldRead = new Promise<void>((resolve) => {
          release = resolve;
        });
        return release;
      },
      cleanup() {
        stopEffects();
        client.dispose();
        const observed = record("disposed");
        expect(observed.subscriptions).toBe(0);
        expect(observed.pending).toEqual([]);
      },
    };
  }

  it("joins StrictMode double effects, switch-away/reselection and reconnect without concurrent dispatch", async () => {
    const f = await fixture("selection and Host reconnect");
    try {
      const first = f.client.activateWorkspaceTab(f.tabId);
      expect(f.client.activateWorkspaceTab(f.tabId)).toBe(first);
      // Selection cleanup does not own the client operation; reselection joins it.
      expect(f.client.activateWorkspaceTab(f.tabId)).toBe(first);
      expect(f.record("selected")).toMatchObject({
        dispatches: 0,
        subscriptions: 1,
        pending: [f.tabId],
      });
      f.platform.changeNetwork("offline");
      expect(f.client.getSnapshot().connection).toBe("offline");
      await f.ready(true);
      expect(f.record("Host offline").dispatches).toBe(0);
      f.platform.changeNetwork("online");
      f.sync();
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      f.requests[0]!.reply(f.success());
      expect(await first).toMatchObject({ tabId: f.tabId });
      expect(f.record("paintable")).toMatchObject({ dispatches: 1, subscriptions: 0, pending: [] });
    } finally {
      f.cleanup();
    }
  });

  it("rechecks availability changed before a placement refusal arrives", async () => {
    const f = await fixture("readiness changes during request", true);
    try {
      const result = f.client.activateWorkspaceTab(f.tabId);
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      await f.ready(false);
      await f.ready(true);
      expect(f.record("before refusal").dispatches).toBe(1);
      f.requests[0]!.reply(f.waiting());
      await vi.waitFor(() => expect(f.requests).toHaveLength(2));
      f.requests[1]!.reply(f.success());
      expect(await result).toMatchObject({ tabId: f.tabId });
      expect(f.record("retried")).toMatchObject({
        dispatches: 2,
        maximumConcurrent: 1,
        subscriptions: 0,
        pending: [],
      });
    } finally {
      f.cleanup();
    }
  });

  it("waits after placement refusal, ignores unrelated publications, and retries exactly once", async () => {
    const f = await fixture("serialized placement retry", true);
    try {
      const result = f.client.activateWorkspaceTab(f.tabId);
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      f.requests[0]!.reply(f.waiting());
      await vi.waitFor(() => expect(f.record("refused").concurrent).toBe(0));
      await f.client.refresh();
      await f.client.refresh();
      expect(f.record("unrelated publications")).toMatchObject({
        dispatches: 1,
        subscriptions: 1,
        pending: [f.tabId],
      });
      await f.ready(false);
      await f.ready(true);
      await vi.waitFor(() => expect(f.requests).toHaveLength(2));
      f.requests[1]!.reply(f.success());
      await result;
      expect(f.record("finished")).toMatchObject({
        dispatches: 2,
        maximumConcurrent: 1,
        subscriptions: 0,
        pending: [],
      });
    } finally {
      f.cleanup();
    }
  });

  it("rejects real errors and permits an explicit retry", async () => {
    const f = await fixture("failure and explicit retry", true);
    try {
      const pending = f.client.activateWorkspaceTab(f.tabId);
      const failed = expect(pending).rejects.toThrow("Activation failed");
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      f.requests[0]!.reply(
        json({ error: { code: "internal", message: "Activation failed" } }, 500),
      );
      await failed;
      expect(f.record("failed")).toMatchObject({ subscriptions: 0, pending: [] });
      const retry = f.client.activateWorkspaceTab(f.tabId);
      expect(retry).not.toBe(pending);
      await vi.waitFor(() => expect(f.requests).toHaveLength(2));
      f.requests[1]!.reply(f.success());
      await retry;
      expect(f.record("retry complete")).toMatchObject({
        dispatches: 2,
        subscriptions: 0,
        pending: [],
      });
    } finally {
      f.cleanup();
    }
  });

  it.each(["waiting", "dispatching"] as const)(
    "actively settles on disposal while %s",
    async (phase) => {
      const f = await fixture(`dispose ${phase}`, phase === "dispatching");
      const pending = f.client.activateWorkspaceTab(f.tabId);
      if (phase === "dispatching") await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      f.cleanup();
      expect(await pending).toBeNull();
      if (phase === "dispatching") f.requests[0]!.reply(f.success());
      await Promise.resolve();
      expect(f.client.getSnapshot().browserSessions).toEqual([]);
      expect(await f.client.activateWorkspaceTab(f.tabId)).toBeNull();
    },
  );

  it.each([false, true])(
    "silently closes and fences late success (dispatching=%s)",
    async (dispatching) => {
      const f = await fixture(`close dispatching=${dispatching}`, dispatching);
      try {
        const pending = f.client.activateWorkspaceTab(f.tabId);
        if (dispatching) await vi.waitFor(() => expect(f.requests).toHaveLength(1));
        f.body.browser.workspaceTabs = [{ ...f.group, revision: f.group.revision + 2, tabs: [] }];
        await f.client.refresh();
        expect(await pending).toBeNull();
        if (dispatching) f.requests[0]!.reply(f.success("Closed tab late reply"));
        await f.client.refresh();
        expect(
          f.effects.some((snapshot) => snapshot.titles.includes("Closed tab late reply")),
        ).toBe(false);
        expect(f.client.getSnapshot().browserSessions).toEqual([]);
        expect(f.client.getSnapshot().workspaceTabs![0]!.tabs).toEqual([]);
        expect(f.record("closed")).toMatchObject({ subscriptions: 0, pending: [] });
      } finally {
        f.cleanup();
      }
    },
  );

  it("settles on account switch and an old finalizer cannot clear a replacement", async () => {
    const f = await fixture("account switch and late reply", true);
    try {
      const old = f.client.activateWorkspaceTab(f.tabId);
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      f.body.user = { ...f.body.user, id: createId("user") };
      await f.client.refresh();
      f.sync();
      expect(await old).toBeNull();
      expect(f.record("account changed")).toMatchObject({ pending: [], subscriptions: 0 });
      const replacement = f.client.activateWorkspaceTab(f.tabId);
      await vi.waitFor(() => expect(f.requests).toHaveLength(2));
      f.requests[0]!.reply(f.success("Old account late reply"));
      await f.client.refresh();
      expect(f.record("old reply").pending).toEqual([f.tabId]);
      f.requests[1]!.reply(f.success());
      await replacement;
      expect(f.effects.some((snapshot) => snapshot.titles.includes("Old account late reply"))).toBe(
        false,
      );
      expect(f.record("replacement complete")).toMatchObject({ pending: [], subscriptions: 0 });
    } finally {
      f.cleanup();
    }
  });

  it.each(["profile", "row", "placement"] as const)(
    "lasting %s unavailability overrides restoring and ends silently",
    async (kind) => {
      const f = await fixture(`unavailable ${kind}`);
      try {
        const pending = f.client.activateWorkspaceTab(f.tabId);
        f.body.browser.workspaceTabs = [
          {
            ...f.group,
            tabs: f.group.tabs!.map((tab) => ({ ...tab, state: "restoring" })),
            ...(kind === "row" ? { unavailableReason: "Row unavailable" } : {}),
          },
        ];
        if (kind === "profile") f.body.browser.profiles = [];
        if (kind === "placement")
          f.body.browser.placements = f.body.browser.placements.map((placement) => ({
            ...placement,
            unavailableReason: "Computer unavailable",
          }));
        f.body.browser.sessions = [
          {
            ...f.group.session,
            state: "ready",
            tabCatalog: {
              ...f.session.tabCatalog!,
              tabs: f.session.tabCatalog!.tabs.map((tab) => ({ ...tab, loading: true })),
            },
          },
        ];
        await f.client.refresh();
        expect(await pending).toBeNull();
        expect(
          placeList(f.client.getSnapshot()).find((place) => place.workspaceTab?.id === f.tabId)
            ?.loading,
        ).toBe(false);
        expect(f.record("unavailable")).toMatchObject({
          dispatches: 0,
          pending: [],
          subscriptions: 0,
        });
      } finally {
        f.cleanup();
      }
    },
  );

  it("applies a successful reply even when a bounded bootstrap omitted the lineage", async () => {
    const f = await fixture("reply after omitted lineage", true);
    try {
      const pending = f.client.activateWorkspaceTab(f.tabId);
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      f.body.browser.workspaceTabs = [];
      await f.client.refresh();
      f.requests[0]!.reply(f.success());
      expect(await pending).toMatchObject({ tabId: f.tabId });
      expect(
        f.client
          .getSnapshot()
          .workspaceTabs?.find((group) => group.id === f.group.id)
          ?.tabs?.some((tab) => tab.id === f.tabId),
      ).toBe(true);
      expect(f.record("recovered from reply")).toMatchObject({
        dispatches: 1,
        subscriptions: 0,
        pending: [],
      });
    } finally {
      f.cleanup();
    }
  });

  it("keeps waiting across an omitted lineage and a missing tabs array", async () => {
    const f = await fixture("bounded catalog");
    try {
      const pending = f.client.activateWorkspaceTab(f.tabId);
      f.body.browser.workspaceTabs = [];
      await f.client.refresh();
      expect(f.record("lineage omitted")).toMatchObject({
        pending: [f.tabId],
        subscriptions: 1,
        dispatches: 0,
      });
      const { tabs: _tabs, ...bounded } = f.group;
      f.body.browser.workspaceTabs = [bounded];
      const release = f.holdRead();
      const refresh = f.client.refresh();
      await vi.waitFor(() =>
        expect(f.client.getSnapshot().workspaceTabs![0]!.tabs).toBeUndefined(),
      );
      expect(f.record("tabs omitted").pending).toEqual([f.tabId]);
      release();
      await refresh;
      await f.ready(true);
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      f.requests[0]!.reply(f.success());
      await pending;
      expect(f.record("recovered")).toMatchObject({ dispatches: 1, pending: [], subscriptions: 0 });
    } finally {
      f.cleanup();
    }
  });
});

describe("realtime review regressions", () => {
  async function fixture(options: Partial<TestHostClientOptions> = {}) {
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      refreshIntervalMs: 0,
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
      ...options,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    sockets[0]!.open();
    return { client, sockets, workspace, thread };
  }

  async function evidence(name: string, f: Awaited<ReturnType<typeof fixture>>) {
    await writeRealtimeEvidence(
      {
        name,
        connection: f.client.getSnapshot().connection,
        threads: f.client.getSnapshot().threads.map(({ id, status }) => ({ id, status })),
        sockets: f.sockets.map((socket) => ({
          closes: socket.closeEvents,
          positions: socket.sent
            .map(
              (raw) =>
                JSON.parse(raw) as { type: string; afterSequence?: string; sequence?: string },
            )
            .map(({ type, afterSequence, sequence }) => ({ type, afterSequence, sequence })),
        })),
      },
      `review-${name}.json`,
    );
  }

  it("F1 preserves understood snapshot siblings when one Thread has a future status", async () => {
    const f = await fixture();
    try {
      const future = { ...makeThread(f.workspace.id), status: "future-status" };
      f.sockets[0]!.receiveRaw({
        type: "host.snapshot",
        snapshot: { ...workspaceSnapshot(f.workspace, "10"), threads: [f.thread, future] },
      });
      f.sockets[0]!.receiveRaw({
        type: "host.synchronized",
        workspaceId: f.workspace.id,
        sequence: "10",
      });
      expect(f.client.getSnapshot().threads.map(({ id }) => id)).toContain(f.thread.id);
      expect(f.client.getSnapshot().threads.map(({ id }) => id)).not.toContain(future.id);
      expect(f.client.getSnapshot().connection).toBe("connected");
      expect(f.sockets[0]!.closeEvents).toEqual([]);
      expect(f.sockets[0]!.sent.map((raw) => JSON.parse(raw))).toContainEqual({
        type: "client.ack",
        workspaceId: f.workspace.id,
        sequence: "10",
      });
    } finally {
      await evidence("f1-snapshot", f);
      f.client.dispose();
    }
  });

  it("F1 keeps resync control behavior for an added reason and normal server close", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    try {
      f.sockets[0]!.receiveRaw({
        type: "host.synchronized",
        workspaceId: f.workspace.id,
        sequence: "10",
      });
      f.sockets[0]!.receiveRaw({
        type: "host.resync-required",
        workspaceId: f.workspace.id,
        reason: "future-reason",
      });
      f.sockets[0]!.serverClose(1000, "normal");
      await vi.advanceTimersByTimeAsync(20);
      expect(f.sockets).toHaveLength(2);
      f.sockets[1]!.open();
      expect(JSON.parse(f.sockets[1]!.sent[0]!)).toMatchObject({
        type: "client.subscribe",
        afterSequence: "0",
      });
      f.sockets[1]!.receiveRaw({
        type: "host.snapshot",
        snapshot: { ...workspaceSnapshot(f.workspace, "10"), threads: [f.thread] },
      });
      f.sockets[1]!.receiveRaw({
        type: "host.synchronized",
        workspaceId: f.workspace.id,
        sequence: "10",
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(f.sockets).toHaveLength(2);
      expect(f.client.getSnapshot().threads.map(({ id }) => id)).toContain(f.thread.id);
      expect(f.client.getSnapshot().connection).toBe("connected");
    } finally {
      await evidence("f1-resync", f);
      f.client.dispose();
    }
  });

  it("F1 refuses malformed known snapshot members instead of silently dropping the snapshot", async () => {
    const f = await fixture();
    try {
      f.sockets[0]!.receiveRaw({
        type: "host.snapshot",
        snapshot: {
          ...workspaceSnapshot(f.workspace, "10"),
          threads: [
            f.thread,
            { ...makeThread(f.workspace.id), status: "future-status", inputQueuePaused: "invalid" },
          ],
        },
      });
      expect(f.client.getSnapshot().connection).toBe("offline");
      expect(f.sockets[0]!.closeEvents).toEqual([
        { code: 4002, reason: "Invalid Host protocol frame" },
      ]);
      expect(f.client.getSnapshot().threads.map(({ id }) => id)).not.toContain(f.thread.id);
    } finally {
      f.client.dispose();
    }
  });

  it("F2 validates all Workspace identities before applying any event or advancing its cursor", async () => {
    const f = await fixture();
    try {
      const created = agentEvent(f.workspace.id, f.thread.id, null, "1", "thread.created", {
        thread: f.thread,
      });
      f.sockets[0]!.receiveRaw({
        type: "host.events",
        events: [created, { type: "future.event", workspaceId: makeWorkspace().id, sequence: "2" }],
      });
      expect(f.client.getSnapshot().threads.map(({ id }) => id)).not.toContain(f.thread.id);
      expect(f.sockets[0]!.sent.map((raw) => JSON.parse(raw))).not.toContainEqual(
        expect.objectContaining({ type: "client.ack" }),
      );
      await f.client.refresh({ retryConnection: true });
      expect(f.sockets).toHaveLength(2);
      f.sockets[1]!.open();
      expect(JSON.parse(f.sockets[1]!.sent[0]!)).toMatchObject({
        type: "client.subscribe",
        afterSequence: "0",
      });
      f.sockets[1]!.receiveRaw({ type: "host.events", events: [created] });
      expect(f.client.getSnapshot().threads.filter(({ id }) => id === f.thread.id)).toHaveLength(1);
    } finally {
      await evidence("f2-atomic-admission", f);
      f.client.dispose();
    }
  });

  it.each(["events", "synchronized"] as const)(
    "F3 reconnects after %s acknowledgement send failure with applied progress retained",
    async (kind) => {
      vi.useFakeTimers();
      const f = await fixture();
      const diagnostics = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const first = f.sockets[0]!;
        const send = first.send.bind(first);
        vi.spyOn(first, "send").mockImplementation((raw) => {
          if ((JSON.parse(raw) as { type: string }).type === "client.ack")
            throw new Error("transport lost while acknowledging");
          send(raw);
        });
        if (kind === "events")
          first.receiveRaw({
            type: "host.events",
            events: [
              agentEvent(f.workspace.id, f.thread.id, null, "1", "thread.created", {
                thread: f.thread,
              }),
            ],
          });
        else {
          first.receiveRaw({
            type: "host.snapshot",
            snapshot: { ...workspaceSnapshot(f.workspace, "1"), threads: [f.thread] },
          });
          first.receiveRaw({
            type: "host.synchronized",
            workspaceId: f.workspace.id,
            sequence: "1",
          });
        }
        expect(f.client.getSnapshot().threads.map(({ id }) => id)).toContain(f.thread.id);
        expect(f.client.getSnapshot().connection).toBe("connecting");
        expect(first.closeEvents).toEqual([
          { code: 1000, reason: "Realtime transport interrupted" },
        ]);
        expect(diagnostics).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(20);
        expect(f.sockets).toHaveLength(2);
        f.sockets[1]!.open();
        expect(JSON.parse(f.sockets[1]!.sent[0]!)).toMatchObject({
          type: "client.subscribe",
          afterSequence: "1",
        });
        f.sockets[1]!.receiveRaw({
          type: "host.synchronized",
          workspaceId: f.workspace.id,
          sequence: "1",
        });
        expect(f.client.getSnapshot().connection).toBe("connected");
      } finally {
        await evidence(`f3-${kind}-ack`, f);
        f.client.dispose();
      }
    },
  );

  it("F4 preserves terminal refusal through automatic rereads, foreground and network changes until person Retry", async () => {
    vi.useFakeTimers();
    const platform = fakeLifecycle();
    const f = await fixture({ lifecycle: platform.lifecycle, refreshIntervalMs: 10 });
    try {
      f.sockets[0]!.receiveRaw({ type: "host.events", events: [] });
      expect(f.client.getSnapshot().connection).toBe("offline");
      await vi.advanceTimersByTimeAsync(30);
      expect(f.sockets).toHaveLength(1);
      platform.enterBackground();
      platform.enterForeground();
      await vi.advanceTimersByTimeAsync(30);
      expect(f.sockets).toHaveLength(1);
      platform.changeNetwork("offline");
      platform.changeNetwork("online");
      await f.client.refresh();
      await vi.advanceTimersByTimeAsync(30);
      expect(f.sockets).toHaveLength(1);
      expect(f.client.getSnapshot().connection).toBe("offline");
      await f.client.refresh({ retryConnection: true });
      expect(f.sockets).toHaveLength(2);
      f.sockets[1]!.open();
      f.sockets[1]!.receiveRaw({
        type: "host.synchronized",
        workspaceId: f.workspace.id,
        sequence: "0",
      });
      expect(f.client.getSnapshot().connection).toBe("connected");
    } finally {
      await evidence("f4-person-retry", f);
      f.client.dispose();
    }
  });
});

describe("realtime protocol recovery journey", () => {
  it("reads additive kinds in a replay without reopening or losing the next durable event", async () => {
    vi.useFakeTimers();
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    const sockets: FakeSocket[] = [];
    const trace: unknown[] = [];
    const frames = [
      { type: "host.future-notice", privateValue: "FRAME-CONTENT-SENTINEL" },
      {
        type: "host.events",
        futureField: "FRAME-CONTENT-SENTINEL",
        events: [
          agentEvent(workspace.id, thread.id, null, "1", "thread.created", { thread }),
          {
            ...agentEvent(workspace.id, thread.id, null, "2", "run.started", { status: "running" }),
            type: "future.event",
            data: { secret: "FRAME-CONTENT-SENTINEL" },
          },
          {
            ...agentEvent(workspace.id, thread.id, null, "3", "thread.state-changed", {
              inputQueuePaused: false,
              pendingRequests: 0,
              status: "running",
            }),
            data: { inputQueuePaused: false, pendingRequests: 0, status: "future-status" },
          },
          agentEvent(workspace.id, thread.id, null, "4", "thread.state-changed", {
            inputQueuePaused: false,
            pendingRequests: 0,
            status: "waiting",
          }),
        ],
      },
      { type: "host.synchronized", sequence: "4", workspaceId: workspace.id },
    ];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      refreshIntervalMs: 0,
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        setTimeout(() => {
          socket.open();
          for (const frame of frames) {
            trace.push({
              socket: sockets.indexOf(socket) + 1,
              type: frame.type,
              bytes: new TextEncoder().encode(JSON.stringify(frame)).byteLength,
              closesBefore: socket.closeEvents.length,
            });
            socket.receiveRaw(frame);
          }
        }, 0);
        return socket;
      },
    });
    const diagnostics = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let outcome = "failed";
    try {
      await client.load();
      await vi.advanceTimersByTimeAsync(50);
      expect(sockets).toHaveLength(1);
      expect(sockets[0]!.closeEvents).toEqual([]);
      expect(client.getSnapshot().connection).toBe("connected");
      expect(client.getSnapshot().threads.find(({ id }) => id === thread.id)?.status).toBe(
        "waiting",
      );
      expect(sockets[0]!.sent.map((frame) => JSON.parse(frame))).toContainEqual({
        type: "client.ack",
        sequence: "4",
        workspaceId: workspace.id,
      });
      expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("FRAME-CONTENT-SENTINEL");
      outcome = "passed";
    } finally {
      await writeRealtimeEvidence({
        outcome,
        trace,
        sockets: sockets.map((socket) => ({
          closes: socket.closeEvents,
          acknowledgements: socket.sent
            .map((frame) => JSON.parse(frame))
            .filter((frame: { type: string }) => frame.type === "client.ack")
            .map((frame: { sequence: string }) => frame.sequence),
        })),
        diagnostics: diagnostics.mock.calls,
      });
      client.dispose();
    }
  });

  it("stops malformed replay without acknowledging it and logs only envelope metadata and schema paths", async () => {
    vi.useFakeTimers();
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    const sockets: FakeSocket[] = [];
    const diagnostics = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      refreshIntervalMs: 15,
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 1,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    try {
      await client.load();
      const socket = sockets[0]!;
      socket.open();
      const frame = {
        type: "host.events",
        events: [
          {
            ...agentEvent(workspace.id, thread.id, null, "1", "thread.state-changed", {
              inputQueuePaused: false,
              pendingRequests: 0,
              status: "running",
            }),
            data: {
              inputQueuePaused: "os_secret_DO_NOT_LOG",
              pendingRequests: -1,
              status: "running",
              "PRIVATE-FIELD-SENTINEL": "PRIVATE-VALUE-SENTINEL",
            },
          },
        ],
      };
      socket.receiveRaw(frame);
      await vi.advanceTimersByTimeAsync(100);
      expect(sockets).toHaveLength(1);
      expect(socket.closeEvents).toEqual([{ code: 4002, reason: "Invalid Host protocol frame" }]);
      expect(client.getSnapshot().connection).toBe("offline");
      expect(socket.sent.map((sent) => JSON.parse(sent))).not.toContainEqual(
        expect.objectContaining({ type: "client.ack" }),
      );
      expect(diagnostics).toHaveBeenCalledExactlyOnceWith(expect.any(String));
      const record = JSON.parse(diagnostics.mock.calls[0]![0] as string);
      expect(record).toMatchObject({
        event: "host.realtime.frame-rejected",
        envelopeType: "host.events",
        apiEpoch: hostApiVersion,
        bytes: new TextEncoder().encode(JSON.stringify(frame)).byteLength,
        issuePaths: ["events.[].data.inputQueuePaused", "events.[].data.pendingRequests"],
      });
      expect(JSON.stringify(record)).not.toMatch(
        /DO_NOT_LOG|PRIVATE-FIELD|PRIVATE-VALUE|os_secret/,
      );
    } finally {
      client.dispose();
    }
  });
});

async function writeRealtimeEvidence(
  report: unknown,
  filename = "frame-trace.redacted.json",
): Promise<void> {
  // Tests leave a replay artifact; the production package still compiles with
  // no Node type surface. Runtime-only test imports keep that portability check.
  const filesystemModule = "node:fs/promises";
  const osModule = "node:os";
  const processModule = "node:process";
  const filesystem: {
    mkdir(path: string, options: { recursive: true }): Promise<unknown>;
    writeFile(path: string, data: string): Promise<void>;
  } = await import(filesystemModule);
  const os: { tmpdir(): string } = await import(osModule);
  const runtime: { env: Record<string, string | undefined> } = await import(processModule);
  const directory =
    runtime.env.OPENSTEER_REALTIME_EVIDENCE_DIR ?? `${os.tmpdir()}/opensteer-realtime-diagnostics`;
  await filesystem.mkdir(directory, { recursive: true });
  await filesystem.writeFile(`${directory}/${filename}`, JSON.stringify(report, null, 2));
  console.info(`Realtime evidence: ${directory}`);
}

class FakeSocket implements WebSocketClient {
  binaryType: BinaryType = "blob";
  readonly closeEvents: Array<{ code: number; reason: string }> = [];
  readonly listeners = new Map<string, Set<(event: never) => void>>();
  readonly sent: string[] = [];
  readyState = 0;

  addEventListener<Type extends "close" | "error" | "message" | "open">(
    type: Type,
    listener: (event: never) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeEvents.push({ code, reason });
    this.emit("close", { code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  receive(message: HostToClientMessage): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  receiveBinary(message: ArrayBuffer): void {
    this.emit("message", { data: message });
  }

  receiveRaw(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  serverClose(code = 1006, reason = "Abnormal closure"): void {
    this.close(code, reason);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
}

function bootstrap(
  workspaces: WorkspaceView[],
  browser: HostedBrowserBootstrap = {
    profileGrants: [],
    available: false,
    placements: [],
    profiles: [],
    sessions: [],
  },
) {
  return {
    notificationPreferences: preferencesForWorkspaces(workspaces),
    browser,
    deploymentId: "dep_00000000-0000-4000-8000-000000000001",
    deploymentShape: {
      defaultWorkspaceBacking: "local-directory" as const,
      kind: "personal" as const,
    },
    environments: [
      {
        capabilities: ["filesystem", "container"],
        connected: true,
        harnessAuthenticationAllowed: true,
        harnessCatalogs: [codexCatalog(harnessInstanceId)],
        harnessDrivers: [
          {
            accessModes: [...ThreadAccessModeSchema.options],
            driverKind: "codex",
            readiness: "runtime-check",
            sources: [
              {
                fields: [],
                kind: "first-party",
                label: "OpenAI",
                quota: "windows",
                sourceId: "openai",
                stateKinds: ["ambient", "isolated"],
              },
            ],
          },
        ],
        providerStateModes: ["ambient", "isolated"] as const,
        id: environmentId,
        kind: "main",
        name: "Main runner",
        runnerId,
        status: "connected" as const,
        workspaceBackings: ["local-directory"] as const,
      },
    ],
    harnesses: [
      {
        config: { model: "gpt-5.6-sol" },
        driverKind: "codex",
        enabled: true,
        environmentId,
        id: harnessInstanceId,
        isDefault: true,
        name: "Codex",
        runtimeRevision: 1,
        sourceId: "openai",
        stateKind: "ambient" as const,
      },
    ],
    machines: [],
    homeWorkspace: workspaces.find((workspace) => workspace.kind === "main") ?? null,
    identityConfig: {
      deployment: { cloud: false, kind: "self-hosted" as const, name: null },
      emailDeliveryAvailable: false,
      localPasswordEnabled: true,
      machineOwner: false,
      oidcProviders: [],
      passkeysEnabled: false,
      exposure: "networked",
      portalOrigin: null,
      publicOrigin: "https://opensteer.example.test",
      setupState: "complete",
      signupPolicy: "invite-only",
    },
    user: authenticatedSession().user,
    workspaceSharingAvailable: true,
    workspaces,
    workspaceWindow: {
      byteCount: new TextEncoder().encode(JSON.stringify(workspaces)).byteLength,
      hasMore: false,
      itemCount: workspaces.length,
      nextBefore: null,
      totalItems: workspaces.length,
    },
  };
}

function codexCatalog(id: Thread["harnessInstanceId"]) {
  return {
    continuationIdentity: {
      continuationKey: "runner:v1:8tErnQuB1d-nw979Rab9a4JN0RE_tKRvI_Rtmy45Bbo",
      driverKind: "codex",
    },
    driverKind: "codex",
    harnessInstanceId: id,
    models: [
      {
        displayName: "GPT-5.6-Sol",
        isDefault: true,
        modelId: "gpt-5.6-sol",
        options: [
          {
            defaultValue: "low",
            id: "effort",
            label: "Reasoning",
            type: "select",
            values: [
              { label: "Low", value: "low" },
              { label: "High", value: "high" },
            ],
          },
        ],
        providerId: "openai",
      },
    ],
    status: "ready",
  } as const;
}

function authenticatedSession() {
  return {
    absoluteExpiresAt: "2026-09-08T20:00:00.000Z",
    createdAt: now,
    expiresAt: "2026-08-16T20:00:00.000Z",
    id: createId("authSession"),
    user: {
      disabledAt: null,
      displayName: "Alex",
      email: "alex@example.com",
      emailVerified: false,
      id: ownerId,
      image: null,
      instanceRole: "administrator" as const,
    },
  };
}

function browserFrame(frameId: number): ArrayBuffer {
  const header = new TextEncoder().encode(
    JSON.stringify({
      encoding: "jpeg",
      frameId,
      rasterHeight: 1,
      rasterWidth: 1,
      surfaceId: "page-1",
      viewportHeight: 720,
      viewportWidth: 1_280,
    }),
  );
  const image = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
  const frame = new Uint8Array(4 + header.byteLength + image.byteLength);
  new DataView(frame.buffer).setUint32(0, header.byteLength, false);
  frame.set(header, 4);
  frame.set(image, 4 + header.byteLength);
  return frame.buffer;
}

function makeWorkspace(name = "Opensteer"): WorkspaceView {
  return {
    homeThreadId: null,
    capacity: { kind: "managed-quota" },
    createdAt: now,
    icon: null,
    id: createId("workspace"),
    kind: "main",
    location: { kind: "shared-storage" },
    name,
    status: "ready",
    storageIssue: null,
    updatedAt: now,
  };
}

function makeThread(workspaceId: Thread["workspaceId"]): Thread {
  const id = createId("thread");
  return {
    doneAt: null,
    accessMode: "full-access",
    capabilityProfileId: "main",
    continuationIdentity: null,
    providerSessionId: null,
    createdAt: now,
    createdBy: ownerId,
    environmentId,
    harnessInstanceId,
    id,
    inputQueuePaused: false,
    lineageRootThreadId: id,
    listed: true,
    modelSelection: ModelSelectionSchema.parse({
      modelId: "gpt-5.6-sol",
      options: { effort: "low" },
      providerId: "openai",
    }),
    parentThreadId: null,
    pendingRequests: 0,
    role: "work",
    status: "idle",
    title: "Do the work",
    icon: null,
    updatedAt: now,
    workspaceId,
  };
}

function makeMessage(
  threadId: Message["threadId"],
  kind: "assistant" | "input",
  text: string,
): Message {
  const runId = createId("run");
  return {
    author:
      kind === "input"
        ? {
            displayName: "Owner",
            kind: "human",
            principalId: `user:${ownerId}`,
            userId: ownerId,
          }
        : {
            displayName: "Opensteer",
            kind: "agent",
            runId,
            threadId,
            workspaceId: createId("workspace"),
            workspaceName: "Main",
          },
    content: [{ text, type: "text" }],
    createdAt: now,
    id: createId("message"),
    kind,
    runId,
    sequence: SequenceSchema.parse("1"),
    threadId,
  };
}

function makeThreadInput(message: Message) {
  return {
    assignmentId: null,
    cancelReason: null,
    causalChainId: createId("causalChain"),
    createdAt: message.createdAt,
    deliveredAt: message.createdAt,
    messageId: message.id,
    policy: "queue" as const,
    replyTarget: null,
    runId: message.runId,
    state: "delivered" as const,
    threadId: message.threadId,
    updatedAt: message.createdAt,
  };
}

function workspaceSnapshot(workspace: WorkspaceView, sequence: string) {
  return {
    notificationPreferences: preferencesForWorkspaces([workspace]),
    readStates: [],
    messages: [],
    messageWindows: [],
    pendingRequests: [],
    pendingRequestWindow: {
      byteCount: 2,
      hasMore: false,
      itemCount: 0,
      nextBefore: null,
      totalItems: 0,
    },
    runQueue: [],
    sequence: SequenceSchema.parse(sequence),
    serializedBytes: 256,
    threads: [],
    threadWindow: { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 },
    workspace,
  };
}

function pendingRequest(input: {
  readonly presentation: OpensteerRequest["presentation"];
  readonly runId: OpensteerRequest["originatingRunId"];
  readonly threadId: OpensteerRequest["originatingThreadId"];
  readonly workspaceId: OpensteerRequest["originatingWorkspaceId"];
}): Extract<OpensteerRequest, { status: "pending" }> {
  const id = createId("request");
  return {
    callId: crypto.randomUUID(),
    cancellationReason: null,
    createdAt: now,
    id,
    kind: input.presentation.kind === "form" ? "harness.input" : "harness.approval",
    mode: "live",
    originatingOccurrenceId: null,
    originatingRunId: input.runId,
    originatingThreadId: input.threadId,
    originatingWorkspaceId: input.workspaceId,
    payload: {
      kind: input.presentation.kind === "form" ? "harness.input" : "harness.approval",
    },
    presentation: input.presentation,
    requestedBy: ownerId,
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
    targetWorkspaceId: input.workspaceId,
  };
}

function pendingIntegrationAccessRequest(input: {
  readonly optionId: string;
  readonly runId: OpensteerRequest["originatingRunId"];
  readonly threadId: OpensteerRequest["originatingThreadId"];
  readonly workspaceId: OpensteerRequest["originatingWorkspaceId"];
}): Extract<OpensteerRequest, { status: "pending" }> & {
  readonly kind: "integration.access";
  readonly payload: Extract<OpensteerRequest["payload"], { kind: "integration.access" }>;
} {
  const preinstall = input.optionId === "installed";
  const installationId = preinstall ? null : createIntegrationId("installation");
  return {
    callId: crypto.randomUUID(),
    cancellationReason: null,
    createdAt: now,
    id: createId("request"),
    kind: "integration.access",
    mode: "durable",
    originatingOccurrenceId: null,
    originatingRunId: input.runId,
    originatingThreadId: input.threadId,
    originatingWorkspaceId: input.workspaceId,
    payload: {
      access: "read-write",
      installationId,
      kind: "integration.access",
      manifest: preinstall ? { kind: "catalog", definition: { id: "calendar" } } : null,
      reason: "Read and update the calendar",
      requestedConnectionId: null,
      requestedServerId: null,
    },
    presentation: {
      detail: "Read and update the calendar",
      kind: "choice",
      options: [{ hint: "confirm", id: input.optionId, label: "Continue" }],
      risk: "high",
      title: "Connect Calendar",
    },
    requestedBy: ownerId,
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
    targetWorkspaceId: input.workspaceId,
  };
}

function sequence(value: string) {
  return SequenceSchema.parse(value);
}

function agentEvent<Type extends AgentEvent["type"]>(
  workspaceId: AgentEvent["workspaceId"],
  threadId: AgentEvent["threadId"],
  runId: AgentEvent["runId"],
  sequence: string,
  type: Type,
  data: Extract<AgentEvent, { type: Type }>["data"],
): Extract<AgentEvent, { type: Type }> {
  return {
    createdAt: now,
    data,
    environmentId,
    eventId: createId("event"),
    runId,
    sequence,
    threadId,
    type,
    workspaceId,
  } as Extract<AgentEvent, { type: Type }>;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function unauthorizedError() {
  return { code: "unauthorized", message: "Authentication required", retryable: false };
}

function parseSent(socket: FakeSocket, index: number): Record<string, unknown> {
  return JSON.parse(socket.sent[index] ?? "{}") as Record<string, unknown>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
}

describe("task marks through the production client and mock transport", () => {
  it.each(["target", "type"] as const)(
    "refuses same-key mark commands with a different %s",
    async (changed) => {
      const mock = new MockHostClient({ latencyMs: 0, places: "absent" });
      const client = new HttpHostClient({
        baseUrl: "http://127.0.0.1",
        capabilities: ["task-marks-v1"],
        refreshIntervalMs: 0,
        webSocketFactory: () => new FakeSocket(),
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          const name = url.pathname.slice("/v1/rpc/".length) as keyof typeof hostApi;
          const rpc = mock.rpc[name] as (payload: never) => Promise<unknown>;
          return json(await rpc(rpcPayload(url, init) as never));
        },
      });
      try {
        await mock.load();
        await client.load();
        const source = mock.getSnapshot();
        const [first, second] = source.threads.filter(({ role }) => role === "work");
        const command = {
          type: "thread.icon.set" as const,
          threadId: first!.id,
          icon: "plane" as const,
          idempotencyKey: "shared-mark-key",
        };
        await client.dispatch(command);
        await expect(
          client.dispatch(
            changed === "target"
              ? { ...command, threadId: second!.id }
              : {
                  type: "workspace.color.set",
                  workspaceId: source.workspaces.find(({ kind }) => kind === "specialized")!.id,
                  color: "purple",
                  idempotencyKey: command.idempotencyKey,
                },
          ),
        ).rejects.toMatchObject({ code: "conflict" });
        await client.dispatch({ ...command, icon: "gift", idempotencyKey: "newer-mark" });
        const retried = await client.dispatch(command);
        expect(retried).toMatchObject({
          type: "thread.icon.set",
          thread: { id: first!.id, icon: "gift" },
        });
      } finally {
        client.dispose();
        mock.dispose();
      }
    },
  );

  it.each(["marks", "future", "legacy"] as const)(
    "keeps %s through bootstrap, pages, search, history, events and commands",
    async (mode) => {
      const mock = new MockHostClient({ latencyMs: 0, places: "absent" });
      const sockets: FakeSocket[] = [];
      const adapt = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(adapt);
        if (value === null || typeof value !== "object") return value;
        return Object.fromEntries(
          Object.entries(value).flatMap(([key, item]) =>
            mode === "legacy" &&
            (key === "color" || (key === "icon" && stringValue(value, "id")?.startsWith("thr_")))
              ? []
              : [[key, key === "color" && mode === "future" ? "ultraviolet" : adapt(item)]],
          ),
        );
      };
      const client = new HttpHostClient({
        baseUrl: "http://127.0.0.1",
        capabilities: mode === "legacy" ? [] : ["task-marks-v1", "thread-titles-v1"],
        refreshIntervalMs: 0,
        webSocketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          const name = url.pathname.slice("/v1/rpc/".length) as keyof typeof hostApi;
          const rpc = mock.rpc[name] as (payload: never) => Promise<unknown>;
          const payload = rpcPayload(url, init);
          return json(
            adapt(await rpc((name === "tasks.list" ? { ...payload, limit: 1 } : payload) as never)),
          );
        },
      });
      try {
        await mock.load();
        await client.load();
        await vi.waitFor(() =>
          expect(client.getSnapshot().tasks?.entries.length).toBeGreaterThan(0),
        );
        expect(client.getSnapshot().tasks?.window.hasMore).toBe(true);
        while (client.getSnapshot().tasks?.window.hasMore) await client.loadEarlierTasks();
        const source = mock.getSnapshot();
        const task = source.threads.find(
          (thread) => thread.id !== source.homeThreadId && thread.icon !== null,
        )!;
        const expected = {
          icon: mode === "legacy" ? null : task.icon,
          color: mode === "marks" ? task.color : null,
        };
        expect(client.getSnapshot().taskMarksAvailable).toBe(mode !== "legacy");
        expect(client.getSnapshot().workspaces[0]?.color).toBe(
          mode === "marks" ? source.workspaces[0]!.color : null,
        );
        expect(
          client.getSnapshot().tasks?.entries.find(({ thread }) => thread.id === task.id)?.thread,
        ).toMatchObject(expected);
        await client.loadWorkspaceTasks(task.workspaceId);
        while (client.getSnapshot().workspaceTasks[task.workspaceId]?.window.hasMore)
          await client.loadEarlierTasks(task.workspaceId);
        expect(
          client
            .getSnapshot()
            .workspaceTasks[task.workspaceId]?.entries.find(({ thread }) => thread.id === task.id)
            ?.thread,
        ).toMatchObject(expected);
        const search = filterThreads(
          (client.getSnapshot().tasks?.entries ?? []).map(({ thread }) => thread),
          client.getSnapshot().workspaces,
          task.title,
          [],
        );
        expect(search.find(({ id }) => id === task.id)).toMatchObject(expected);
        const firstPage = unwrapMock(await mock.rpc["tasks.list"]({ limit: 1 }));
        expect(firstPage.window.hasMore).toBe(true);
        const nextPage = unwrapMock(
          await mock.rpc["tasks.list"]({ limit: 1, before: firstPage.window.nextBefore! }),
        );
        expect(nextPage.tasks[0]?.thread.icon).toBeDefined();
        expect(nextPage.tasks[0]?.thread.color).toBeDefined();
        await client.loadLatestTranscript(task.id);
        expect(client.getSnapshot().threads.find(({ id }) => id === task.id)).toMatchObject(
          expected,
        );
        const socket = sockets[0]!;
        socket.open();
        const workspace = source.workspaces.find(({ id }) => id === task.workspaceId)!;
        const wireWorkspace = unwrapMock(await mock.rpc["bootstrap.get"]({})).workspaces.find(
          ({ id }) => id === workspace.id,
        )!;
        socket.receive({
          type: "host.snapshot",
          snapshot: adapt({
            ...workspaceSnapshot(wireWorkspace, "0"),
            threads: [
              unwrapMock(await mock.rpc["thread.events.list"]({ threadId: task.id })).thread,
            ],
          }) as Extract<HostToClientMessage, { type: "host.snapshot" }>["snapshot"],
        });
        expect(client.getSnapshot().threads.find(({ id }) => id === task.id)).toMatchObject(
          expected,
        );
        socket.receive({
          type: "host.events",
          events: [
            adapt(
              agentEvent(
                WorkspaceIdSchema.parse(task.workspaceId),
                ThreadIdSchema.parse(task.id),
                null,
                "1",
                "thread.listed",
                {
                  thread: {
                    ...unwrapMock(await mock.rpc["thread.events.list"]({ threadId: task.id }))
                      .thread,
                    listed: false,
                  },
                },
              ),
            ) as AgentEvent,
          ],
        });
        expect(client.getSnapshot().threads.find(({ id }) => id === task.id)?.listed).toBe(false);
        expect(threadMark(task.id, client.getSnapshot()).color).toBe(expected.color);
        client.activateThread(source.homeThreadId!);
        await vi.waitFor(() =>
          expect(Object.values(client.getSnapshot().assignments).length).toBeGreaterThan(0),
        );
        const assignment = Object.values(client.getSnapshot().assignments)[0]!;
        const sourceAssignment = source.assignments[assignment.id]!;
        expect(assignmentMark(assignment, { threads: [] })).toMatchObject({
          icon: mode === "legacy" ? null : sourceAssignment.workerThread.icon,
          color: mode === "marks" ? sourceAssignment.workerThread.color : null,
        });
        if (mode !== "legacy") {
          const result = await client.dispatch({
            type: "thread.icon.set",
            threadId: task.id,
            icon: "gift",
            idempotencyKey: `transport-${mode}`,
          });
          expect(result.type).toBe("thread.icon.set");
          const specialist = source.workspaces.find(({ kind }) => kind === "specialized")!;
          await client.dispatch({
            type: "workspace.color.set",
            workspaceId: specialist.id,
            color: "purple",
            idempotencyKey: `transport-color-${mode}`,
          });
          expect(
            client.getSnapshot().workspaces.find(({ id }) => id === specialist.id)?.color,
          ).toBe(mode === "future" ? null : "purple");
          await client.dispatch({
            type: "workspace.color.set",
            workspaceId: specialist.id,
            color: "green",
            idempotencyKey: `transport-new-color-${mode}`,
          });
          await client.dispatch({
            type: "workspace.color.set",
            workspaceId: specialist.id,
            color: "purple",
            idempotencyKey: `transport-color-${mode}`,
          });
          expect(mock.getSnapshot().workspaces.find(({ id }) => id === specialist.id)?.color).toBe(
            "green",
          );
          expect(
            client.getSnapshot().workspaces.find(({ id }) => id === specialist.id)?.color,
          ).toBe(mode === "future" ? null : "green");
          expect(client.getSnapshot().threads.find(({ id }) => id === task.id)).toMatchObject({
            icon: "gift",
            color: expected.color,
          });
        }
      } finally {
        client.dispose();
        mock.dispose();
      }
    },
  );

  function unwrapMock<T>(
    result: { ok: true; data: T } | { ok: false; error: { message: string } },
  ): T {
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }
});

describe("HttpHostClient overnight transcript residency", () => {
  /*
   * Failure modes, before changing the projection:
   * - unshown Threads accumulate durable entries and streamed text indefinitely;
   * - skipping transcript content also skips Run, Request or assignment state;
   * - the first activation or observation never rereads missed history, or repeated
   *   holds reread the same page and releasing one holder stops another's updates;
   * - reconnect clears readable history or changes its event cursor before a
   *   replacement succeeds, and a failed read looks like an empty conversation;
   * - a successful retry drops durable or live events received during its read;
   * - an outstanding read restores a previous viewer or a refused Workspace.
   */
  function page(thread: Thread, events: AgentEvent[], asOfSequence: string) {
    return {
      events,
      readState: { ...defaultReadState(thread.id), asOfSequence },
      thread,
      threadId: thread.id,
      window: {
        byteCount: new TextEncoder().encode(JSON.stringify(events)).byteLength,
        hasMore: true,
        itemCount: events.length,
        nextBefore: events[0]?.sequence ?? null,
        threadId: thread.id,
        totalItems: 1_000,
      },
    };
  }

  async function residentFixture(hydrate = true, omitSnapshotMessages = false) {
    const workspace = makeWorkspace();
    const thread = makeThread(workspace.id);
    const other = makeThread(workspace.id);
    const runId = createId("run");
    const replyId = createId("message");
    const events: AgentEvent[] = [
      agentEvent(workspace.id, thread.id, runId, "1", "run.started", { status: "running" }),
      agentEvent(workspace.id, thread.id, runId, "2", "tool.started", {
        arguments: { command: "inspect the overnight work" },
        callId: "kept-step",
        tool: { name: "shell", namespace: "codex" },
      }),
      agentEvent(workspace.id, thread.id, runId, "3", "tool.completed", {
        callId: "kept-step",
        isError: false,
        output: { text: "The previous work remains readable." },
      }),
      agentEvent(workspace.id, thread.id, runId, "4", "assistant.message", {
        content: [{ text: "An already loaded answer.", type: "text" }],
        messageId: replyId,
      }),
      agentEvent(workspace.id, thread.id, runId, "5", "run.completed", {
        replyMessageId: replyId,
        status: "completed",
      }),
    ];
    const histories = new Map([
      [thread.id, page(thread, events, "5")],
      [other.id, page(other, [], "5")],
    ]);
    const reads: string[] = [];
    const socket = new FakeSocket();
    const held: Array<{
      readonly asked: ReturnType<typeof Promise.withResolvers<void>>;
      readonly answer: ReturnType<typeof Promise.withResolvers<Response>>;
    }> = [];
    let boot = bootstrap([workspace]);
    const client = createHttpHostClient({
      refreshIntervalMs: 0,
      capabilities: omitSnapshotMessages ? ["snapshot-messages-omit-v1"] : [],
      webSocketFactory: () => socket,
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const payload = rpcPayload(url, init);
        const threadId = payload.threadId;
        if (url.pathname === "/v1/rpc/thread.events.list") {
          const id = ThreadIdSchema.parse(threadId);
          reads.push(id);
          const pending = id === thread.id ? held.shift() : undefined;
          if (pending) {
            pending.asked.resolve();
            return pending.answer.promise;
          }
          return json(histories.get(id));
        }
        if (url.pathname === "/v1/rpc/thread.inputQueue.get")
          return json({ items: [], paused: false, steerRunId: null, threadId });
        if (url.pathname === "/v1/rpc/thread.requests.list")
          return json({ requests: [], threadId, window: emptyDurableWindow() });
        if (url.pathname === "/v1/rpc/thread.assignments.list")
          return json({ assignments: [], threadId, window: emptyDurableWindow() });
        if (url.pathname === "/v1/rpc/thread.live.get") return json({ runs: [], threadId });
        return json(boot);
      },
    });
    await client.load();
    socket.open();
    socket.receive({
      type: "host.snapshot",
      snapshot: { ...workspaceSnapshot(workspace, "0"), threads: [thread, other] },
    });
    if (hydrate) {
      client.activateThread(thread.id);
      await vi.waitFor(() =>
        expect(client.getSnapshot().transcripts[thread.id]?.some(({ id }) => id === replyId)).toBe(
          true,
        ),
      );
    }
    return {
      client,
      events,
      histories,
      other,
      reads,
      runId,
      replyId,
      socket,
      thread,
      workspace,
      holdHistory() {
        const pending = {
          asked: Promise.withResolvers<void>(),
          answer: Promise.withResolvers<Response>(),
        };
        held.push(pending);
        return pending;
      },
      changeViewer() {
        boot = { ...boot, user: { ...boot.user, id: createId("user") } };
      },
    };
  }

  function emptyDurableWindow() {
    return { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 };
  }

  it.each([false, true])(
    "negotiates omitted snapshot messages only with a capable Host (%s)",
    async (capable) => {
      const f = await residentFixture(false, capable);
      try {
        const subscription = parseSent(f.socket, 0);
        if (capable) expect(subscription).toHaveProperty("snapshotMessages", "omit");
        else expect(subscription).not.toHaveProperty("snapshotMessages");
      } finally {
        f.client.dispose();
      }
    },
  );

  it.each(["activate", "observe"] as const)(
    "leaves omitted history unloaded until %s reads its first durable page",
    async (mode) => {
      const f = await residentFixture(false, true);
      const pending = f.holdHistory();
      let release: (() => void) | undefined;
      try {
        // A previous full snapshot may have seeded a message window. It is not
        // coverage for this new snapshot's omitted history.
        f.socket.receive({
          type: "host.snapshot",
          snapshot: {
            ...workspaceSnapshot(f.workspace, "5"),
            threads: [f.thread, f.other],
            messages: [makeMessage(f.thread.id, "assistant", "Snapshot-only seed")],
            messageWindows: [{ ...emptyDurableWindow(), threadId: f.thread.id }],
          },
        });
        expect(f.client.getSnapshot().transcripts[f.thread.id]).toContainEqual(
          expect.objectContaining({ body: "Snapshot-only seed" }),
        );
        f.socket.receive({
          type: "host.snapshot",
          snapshot: {
            ...workspaceSnapshot(f.workspace, "5"),
            threads: [f.thread, f.other],
            messagesOmitted: true,
          },
        });
        expect(f.client.getSnapshot().transcripts[f.thread.id]).toBeUndefined();
        expect(f.client.getSnapshot().transcriptWindows[f.thread.id]).toBeUndefined();
        expect(f.reads).toEqual([]);
        if (mode === "activate") f.client.activateThread(f.thread.id);
        else release = f.client.observeThread(f.thread.id);
        await pending.asked.promise;
        expect(f.client.getSnapshot().threadLookups[f.thread.id]).toBe("loading");
        expect(f.client.getSnapshot().transcriptWindows[f.thread.id]).toBeUndefined();
        pending.answer.resolve(json(page(f.thread, f.events, "5")));
        await vi.waitFor(() =>
          expect(f.client.getSnapshot().transcriptWindows[f.thread.id]).toMatchObject({
            hasMore: true,
            nextBefore: "1",
            totalItems: 1_000,
          }),
        );
        expect(f.client.getSnapshot().transcripts[f.thread.id]).toContainEqual(
          expect.objectContaining({ body: "An already loaded answer." }),
        );
        expect(f.client.getSnapshot().threadLookups[f.thread.id]).toBeUndefined();
        expect(f.reads).toEqual([f.thread.id]);
      } finally {
        pending.answer.resolve(json(page(f.thread, f.events, "5")));
        release?.();
        f.client.dispose();
      }
    },
  );

  it("keeps historical reading and its cursor through an omitted-history snapshot", async () => {
    const f = await residentFixture(true, true);
    try {
      await f.client.loadTranscriptAround(f.thread.id, f.replyId);
      const entries = f.client.getSnapshot().transcripts[f.thread.id];
      const window = f.client.getSnapshot().transcriptWindows[f.thread.id];
      const reads = f.reads.length;
      f.socket.receive({
        type: "host.snapshot",
        snapshot: {
          ...workspaceSnapshot(f.workspace, "10"),
          threads: [f.thread, f.other],
          messagesOmitted: true,
        },
      });
      expect(f.client.getSnapshot().transcripts[f.thread.id]).toBe(entries);
      expect(f.client.getSnapshot().transcriptWindows[f.thread.id]).toBe(window);
      expect(f.reads).toHaveLength(reads);
    } finally {
      f.client.dispose();
    }
  });

  it("does not retain an unopened Thread's overnight output while keeping its current state", async () => {
    const f = await residentFixture(false);
    try {
      f.client.activateThread(f.other.id);
      const retained = f.client.getSnapshot().transcripts[f.thread.id];
      const runId = createId("run");
      const request = pendingRequest({
        presentation: {
          kind: "choice",
          title: "Continue?",
          detail: "Review the work",
          risk: "low",
          options: [{ hint: "confirm", id: "yes", label: "Continue" }],
        },
        runId,
        threadId: f.thread.id,
        workspaceId: f.workspace.id,
      });
      const assignment = {
        createdAt: now,
        currentRunId: runId,
        currentRunStatus: "waiting" as const,
        finishedAt: null,
        id: createId("delegation"),
        initialRunId: runId,
        modelLabel: f.thread.modelSelection.modelId,
        objectivePreview: "Check the overnight task",
        origin: "run" as const,
        parentThreadId: f.other.id,
        resultPreview: null,
        returnStatus: "pending" as const,
        revision: 1,
        status: "open" as const,
        updatedAt: now,
        workerThread: {
          environmentId,
          id: f.thread.id,
          pendingRequests: 1,
          status: "waiting" as const,
          title: f.thread.title,
          icon: null,
          workspaceId: f.workspace.id,
        },
      };
      const output = Array.from({ length: 100 }, (_, index) =>
        agentEvent(f.workspace.id, f.thread.id, runId, String(index + 10), "assistant.message", {
          content: [{ text: `Overnight update ${index}`, type: "text" }],
          messageId: createId("message"),
        }),
      );
      const overnightFrame = {
        type: "host.events" as const,
        events: [
          agentEvent(f.workspace.id, f.thread.id, runId, "6", "run.queued", {
            run: {
              id: runId,
              runOrdinal: 1,
              status: "queued",
              threadId: f.thread.id,
              createdAt: now,
            },
          }),
          agentEvent(f.workspace.id, f.thread.id, runId, "7", "run.started", { status: "running" }),
          ...output,
          agentEvent(f.workspace.id, f.thread.id, runId, "110", "request.opened", { request }),
          agentEvent(f.workspace.id, f.thread.id, runId, "111", "assignment.updated", {
            assignment,
          }),
          agentEvent(f.workspace.id, f.thread.id, null, "112", "thread.state-changed", {
            inputQueuePaused: false,
            pendingRequests: 1,
            status: "waiting",
          }),
        ],
      };
      HostToClientMessageSchema.parse(overnightFrame);
      f.socket.receive(overnightFrame);
      f.socket.receive({
        type: "host.live",
        workspaceId: f.workspace.id,
        afterSequence: sequence("112"),
        progress: {
          workspaceId: f.workspace.id,
          threadId: f.thread.id,
          runId,
          items: [{ op: "append", at: 0, stream: "assistant", text: "Still writing overnight" }],
        },
      });
      const snapshot = f.client.getSnapshot();
      const current = snapshot.threads.find(({ id }) => id === f.thread.id)!;
      expect(current).toMatchObject({ status: "waiting", pendingRequests: 1 });
      expect(threadStopTarget({ runQueue: snapshot.runQueue, thread: current })?.id).toBe(runId);
      expect(snapshot.requests[f.thread.id]).toContainEqual(request);
      expect(snapshot.assignments[assignment.id]).toEqual(assignment);
      expect(snapshot.transcripts[f.thread.id]).toBe(retained);
    } finally {
      f.client.dispose();
    }
  });

  it.each(["activate", "observe"] as const)(
    "rereads missed history once on %s and keeps multiple observers live",
    async (mode) => {
      const f = await residentFixture(false);
      const releases: Array<() => void> = [];
      try {
        f.client.activateThread(f.other.id);
        const update = agentEvent(
          f.workspace.id,
          f.thread.id,
          f.runId,
          "6",
          "reasoning.completed",
          { blockId: "missed", text: "Work performed while elsewhere." },
        );
        f.histories.set(f.thread.id, page(f.thread, [...f.events, update], "6"));
        f.socket.receive({ type: "host.events", events: [update] });
        if (mode === "activate") {
          f.client.activateThread(f.thread.id);
          f.client.activateThread(f.thread.id);
        } else {
          releases.push(f.client.observeThread(f.thread.id), f.client.observeThread(f.thread.id));
          releases.shift()!();
        }
        await vi.waitFor(() => expect(f.reads.filter((id) => id === f.thread.id)).toHaveLength(1));
        await vi.waitFor(() =>
          expect(f.client.getSnapshot().transcripts[f.thread.id]).toContainEqual(
            expect.objectContaining({ id: `reasoning:${f.runId}:missed` }),
          ),
        );
        const later = agentEvent(f.workspace.id, f.thread.id, f.runId, "7", "reasoning.completed", {
          blockId: "held",
          text: "The remaining reader still sees this.",
        });
        f.socket.receive({ type: "host.events", events: [later] });
        expect(f.client.getSnapshot().transcripts[f.thread.id]).toContainEqual(
          expect.objectContaining({ id: `reasoning:${f.runId}:held` }),
        );
        expect(f.reads.filter((id) => id === f.thread.id)).toHaveLength(1);
      } finally {
        for (const release of releases) release();
        f.client.dispose();
      }
    },
  );

  it("keeps cached older reading and live updates when returning from another task", async () => {
    // A latest-only reread must not discard the history to which the UI restores
    // a reader's saved position. Cached reader-owned windows stay live.
    const f = await residentFixture();
    try {
      const retained = f.client.getSnapshot().transcripts[f.thread.id]!;
      const window = f.client.getSnapshot().transcriptWindows[f.thread.id];
      f.client.activateThread(f.other.id);
      const update = agentEvent(f.workspace.id, f.thread.id, f.runId, "6", "assistant.message", {
        content: [{ text: "A new update while reading another task.", type: "text" }],
        messageId: createId("message"),
      });
      f.histories.set(f.thread.id, page(f.thread, [update], "6"));
      f.socket.receive({ type: "host.events", events: [update] });
      f.client.activateThread(f.thread.id);
      await Promise.resolve();
      await Promise.resolve();
      expect(f.client.getSnapshot().transcripts[f.thread.id]).toEqual([
        ...retained,
        expect.objectContaining({ body: "A new update while reading another task." }),
      ]);
      expect(f.client.getSnapshot().transcriptWindows[f.thread.id]).toBe(window);
      expect(f.reads.filter((id) => id === f.thread.id)).toHaveLength(1);
    } finally {
      f.client.dispose();
    }
  });

  it.each([false, true])(
    "keeps active history and its event cursor through a failed reconnect read, then replaces them atomically (omitted=%s)",
    async (omitted) => {
      const f = await residentFixture(true, omitted);
      const first = f.holdHistory();
      try {
        const entries = f.client.getSnapshot().transcripts[f.thread.id];
        const window = f.client.getSnapshot().transcriptWindows[f.thread.id];
        const installed: ReadonlyArray<{ readonly id: string }>[] = [];
        const unsubscribe = f.client.subscribe(() =>
          installed.push(f.client.getSnapshot().transcripts[f.thread.id] ?? []),
        );
        f.socket.receive({
          type: "host.snapshot",
          snapshot: {
            ...workspaceSnapshot(f.workspace, "10"),
            threads: [f.thread, f.other],
            ...(omitted
              ? { messagesOmitted: true }
              : { messageWindows: [{ ...emptyDurableWindow(), threadId: f.thread.id }] }),
          },
        });
        await first.asked.promise;
        expect.soft(f.client.getSnapshot().transcripts[f.thread.id]).toBe(entries);
        expect.soft(f.client.getSnapshot().transcriptWindows[f.thread.id]).toBe(window);
        first.answer.resolve(
          json(
            {
              error: {
                code: "internal",
                message: "History temporarily unavailable",
                retryable: true,
              },
            },
            503,
          ),
        );
        await vi.waitFor(() =>
          expect(f.client.getSnapshot().threadLookups[f.thread.id]).toBe("failed"),
        );
        expect(f.client.getSnapshot().transcripts[f.thread.id]).toBe(entries);
        expect(f.client.getSnapshot().transcriptWindows[f.thread.id]).toBe(window);
        const retry = f.holdHistory();
        f.client.activateThread(f.thread.id);
        await retry.asked.promise;
        const missed = agentEvent(
          f.workspace.id,
          f.thread.id,
          f.runId,
          "9",
          "reasoning.completed",
          {
            blockId: "missed-reconnect",
            text: "Recorded while disconnected.",
          },
        );
        const arrived = agentEvent(
          f.workspace.id,
          f.thread.id,
          f.runId,
          "11",
          "reasoning.completed",
          { blockId: "during-read", text: "Arrived during the replacement read." },
        );
        f.socket.receive({ type: "host.events", events: [arrived] });
        retry.answer.resolve(json(page(f.thread, [...f.events, missed], "10")));
        await vi.waitFor(() =>
          expect(f.client.getSnapshot().transcripts[f.thread.id]).toContainEqual(
            expect.objectContaining({ id: `reasoning:${f.runId}:missed-reconnect` }),
          ),
        );
        expect(f.client.getSnapshot().transcripts[f.thread.id]).toContainEqual(
          expect.objectContaining({ id: `reasoning:${f.runId}:during-read` }),
        );
        expect(f.client.getSnapshot().threadLookups[f.thread.id]).toBeUndefined();
        expect(
          installed.every((value) =>
            value.some(({ id }) => id === "tool:" + f.runId + ":kept-step"),
          ),
        ).toBe(true);
        unsubscribe();
      } finally {
        first.answer.resolve(json(page(f.thread, f.events, "10")));
        f.client.dispose();
      }
    },
  );

  it("rereads hydrated history when a newer snapshot covers a transcript gap", async () => {
    const f = await residentFixture();
    try {
      const missed = agentEvent(f.workspace.id, f.thread.id, f.runId, "9", "reasoning.completed", {
        blockId: "hydrated-snapshot-gap",
        text: "Recorded after the hydrated page while disconnected.",
      });
      f.histories.set(f.thread.id, page(f.thread, [...f.events, missed], "10"));
      f.socket.receive({
        type: "host.snapshot",
        snapshot: { ...workspaceSnapshot(f.workspace, "10"), threads: [f.thread, f.other] },
      });
      await vi.waitFor(() =>
        expect(f.client.getSnapshot().transcripts[f.thread.id]).toContainEqual(
          expect.objectContaining({ id: `reasoning:${f.runId}:hydrated-snapshot-gap` }),
        ),
      );
      expect(f.reads.filter((id) => id === f.thread.id)).toHaveLength(2);
    } finally {
      f.client.dispose();
    }
  });

  it("requires the newest overtaking snapshot and caps uncovered history rereads", async () => {
    const f = await residentFixture();
    const pending = f.holdHistory();
    try {
      const entries = f.client.getSnapshot().transcripts[f.thread.id];
      const window = f.client.getSnapshot().transcriptWindows[f.thread.id];
      f.histories.set(f.thread.id, page(f.thread, f.events, "8"));
      const reading = f.client.loadLatestTranscript(f.thread.id);
      await pending.asked.promise;
      for (const sequence of ["10", "8"]) {
        f.socket.receive({
          type: "host.snapshot",
          snapshot: { ...workspaceSnapshot(f.workspace, sequence), threads: [f.thread, f.other] },
        });
      }
      pending.answer.resolve(json(page(f.thread, f.events, "5")));
      await expect(reading).rejects.toThrow(
        "The connection changed while loading this conversation",
      );
      expect(f.reads.filter((id) => id === f.thread.id)).toHaveLength(5);
      expect(f.client.getSnapshot().transcripts[f.thread.id]).toBe(entries);
      expect(f.client.getSnapshot().transcriptWindows[f.thread.id]).toBe(window);
    } finally {
      pending.answer.resolve(json(page(f.thread, f.events, "5")));
      f.client.dispose();
    }
  });

  it("rereads an outstanding transcript after a snapshot even when Thread state did not change", async () => {
    const f = await residentFixture();
    const pending = f.holdHistory();
    try {
      const reading = f.client.loadLatestTranscript(f.thread.id);
      await pending.asked.promise;
      const missed = agentEvent(f.workspace.id, f.thread.id, f.runId, "9", "reasoning.completed", {
        blockId: "snapshot-gap",
        text: "New activity without a Thread status transition.",
      });
      f.histories.set(f.thread.id, page(f.thread, [...f.events, missed], "10"));
      f.socket.receive({
        type: "host.snapshot",
        snapshot: {
          ...workspaceSnapshot(f.workspace, "10"),
          threads: [f.thread, f.other],
        },
      });
      pending.answer.resolve(json(page(f.thread, f.events, "5")));
      await reading;
      expect(f.client.getSnapshot().transcripts[f.thread.id]).toContainEqual(
        expect.objectContaining({ id: `reasoning:${f.runId}:snapshot-gap` }),
      );
    } finally {
      pending.answer.resolve(json(page(f.thread, f.events, "5")));
      f.client.dispose();
    }
  });

  it.each(["viewer", "workspace"] as const)(
    "does not restore history whose %s was removed while the read was pending",
    async (removed) => {
      const f = await residentFixture();
      const pending = f.holdHistory();
      try {
        const reading = f.client.loadLatestTranscript(f.thread.id);
        await pending.asked.promise;
        if (removed === "viewer") {
          f.changeViewer();
          await f.client.refresh();
        } else {
          f.socket.receive({
            type: "host.error",
            error: {
              code: "forbidden",
              message: "Workspace access ended",
              reason: "workspace-forbidden",
              retryable: false,
            },
          });
        }
        pending.answer.resolve(json(page(f.thread, f.events, "10")));
        await reading;
        expect(f.client.getSnapshot().transcripts[f.thread.id]).toBeUndefined();
        expect(f.client.getSnapshot().transcriptWindows[f.thread.id]).toBeUndefined();
        expect(f.client.getSnapshot().threads.some(({ id }) => id === f.thread.id)).toBe(false);
      } finally {
        pending.answer.resolve(json(page(f.thread, f.events, "10")));
        f.client.dispose();
      }
    },
  );
});

it.each([false, true])(
  "gates the passkey viewer opt-in on the Host capability (%s)",
  async (capable) => {
    const workspace = makeWorkspace("Example");
    const sessionId = createBrowserSessionId();
    const runnerId = createId("runner");
    const tabId = BrowserSurfaceIdSchema.parse("tab");
    const browser: HostedBrowserBootstrap = {
      available: true,
      placements: [
        {
          kind: "runner",
          runnerId,
          runtimeId: "runtime",
          label: "Example computer",
          environmentIds: [],
          available: true,
        },
      ],
      profileGrants: [],
      profiles: [],
      sessions: [
        {
          id: sessionId,
          access: "full-control",
          origin: "workspace",
          state: "ready",
          createdAt: now,
          updatedAt: now,
          workspaceId: workspace.id,
          profileId: null,
          runtimeId: "runtime",
          placement: { kind: "runner", runnerId },
          tabCatalog: {
            generation: 1,
            revision: 1,
            tabs: [
              {
                id: tabId,
                title: "Example",
                site: "https://example.test",
                iconRef: null,
                order: 0,
                openerId: null,
                availability: "ready",
                documentId: null,
                occupants: [],
              },
            ],
          },
        },
      ],
    };
    const sockets: { url: string; socket: FakeSocket }[] = [];
    const client = createHttpHostClient({
      capabilities: capable
        ? ["browser-passkeys-v1", "browser-target-control-v1"]
        : ["browser-target-control-v1"],
      fetch: async () => json(bootstrap([workspace], browser)),
      refreshIntervalMs: 0,
      webSocketFactory: (url) => {
        const socket = new FakeSocket();
        sockets.push({ url, socket });
        return socket;
      },
    });
    try {
      await client.load();
      const release = client.retainBrowserViewer(sessionId, tabId, { picture: false });
      const connection = sockets.find(({ url }) => url.includes("/browser-sessions/"))!;
      expect(new URL(connection.url).searchParams.get("passkeys")).toBe(capable ? "notice" : null);
      connection.socket.open();
      connection.socket.receiveRaw({
        type: "browser.snapshot",
        sessionId,
        access: "full-control",
        state: "ready",
        dialog: null,
        targetedStreamingVersion: 1,
        surfaces: [{ id: tabId, active: true, title: "Example", url: "https://example.test" }],
        ...(capable ? { passkeys: "notice" } : {}),
      });
      if (capable) {
        connection.socket.receiveRaw({ type: "browser.passkey.notice", surfaceId: tabId });
        expect(client.browserPasskeys.get(sessionId, tabId)).toEqual({ kind: "notice" });
      }
      release();
      expect(client.browserPasskeys.get(sessionId, tabId)).toBeNull();
    } finally {
      client.dispose();
    }
  },
);

describe("attachment reads", () => {
  const boundedRead = (client: HttpHostClient, id: string, signal?: AbortSignal) =>
    withTimeout(client.readAttachment(id, signal), 1_000, {
      timeoutError: () => new Error("Attachment read did not settle"),
    });
  const content = (size = 4) => ({
    ok: true as const,
    data: {
      bytes: new Uint8Array(size),
      metadata: {
        contentType: "image/png",
        etag: "immutable",
        modifiedAt: null,
        sizeBytes: size,
        truncated: false as const,
      },
    },
  });
  function attachmentRpc(client: HttpHostClient) {
    const rpc = vi.fn<(typeof client.rpc)["attachment.content"]>();
    Object.defineProperty(client.rpc, "attachment.content", { value: rpc });
    return rpc;
  }
  function pendingRead() {
    const client = createHttpHostClient({ refreshIntervalMs: 0 });
    let complete!: (value: ReturnType<typeof content>) => void;
    const pending = new Promise<ReturnType<typeof content>>((resolve) => {
      complete = resolve;
    });
    const rpc = attachmentRpc(client).mockReturnValue(pending);
    return { client, rpc, complete };
  }

  it("shares concurrent reads, isolates cancellation, and caches completed bytes", async () => {
    const { client, rpc, complete } = pendingRead();
    try {
      const abort = new AbortController();
      const first = boundedRead(client, "image", abort.signal);
      const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
      const second = boundedRead(client, "image");
      abort.abort();
      await rejected;
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc.mock.calls[0]![1]?.signal?.aborted).toBe(false);
      complete(content());
      expect((await second).size).toBe(4);
      expect((await boundedRead(client, "image")).size).toBe(4);
      expect(rpc).toHaveBeenCalledTimes(1);
    } finally {
      client.dispose();
    }
  });

  it("keeps the request through synchronous cleanup and remount, then cancels when unused", async () => {
    const { client, rpc } = pendingRead();
    try {
      const a = new AbortController();
      const first = boundedRead(client, "image", a.signal);
      const firstRejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
      a.abort();
      const b = new AbortController();
      const second = boundedRead(client, "image", b.signal);
      const secondRejected = expect(second).rejects.toMatchObject({ name: "AbortError" });
      await firstRejected;
      expect(rpc).toHaveBeenCalledTimes(1);
      const signal = rpc.mock.calls[0]![1]!.signal!;
      expect(signal.aborted).toBe(false);
      b.abort();
      expect(signal.aborted).toBe(false);
      await secondRejected;
      expect(signal.aborted).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it("aborts active reads and refuses cached bytes after disposal", async () => {
    const { client, rpc, complete } = pendingRead();
    try {
      const completed = boundedRead(client, "cached");
      complete(content());
      await completed;
      rpc.mockImplementationOnce(() => new Promise(() => undefined));
      const pending = boundedRead(client, "pending");
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      client.dispose();
      await rejected;
      expect(rpc.mock.calls[1]![1]!.signal!.aborted).toBe(true);
      await expect(boundedRead(client, "cached")).rejects.toMatchObject({ name: "AbortError" });
      expect(rpc).toHaveBeenCalledTimes(2);
    } finally {
      client.dispose();
    }
  });

  it("evicts least recently used bytes and excludes oversized items", async () => {
    const client = createHttpHostClient({ refreshIntervalMs: 0 });
    const rpc = attachmentRpc(client).mockResolvedValue(content(12 * 1024 * 1024));
    try {
      await boundedRead(client, "a");
      await boundedRead(client, "b");
      await boundedRead(client, "a");
      await boundedRead(client, "c");
      await boundedRead(client, "a");
      expect(rpc).toHaveBeenCalledTimes(3);
      await boundedRead(client, "b");
      expect(rpc).toHaveBeenCalledTimes(4);
      rpc.mockResolvedValue(content(33 * 1024 * 1024));
      await boundedRead(client, "large");
      await boundedRead(client, "large");
      expect(rpc).toHaveBeenCalledTimes(6);
    } finally {
      client.dispose();
    }
  });

  it("does not cache failures or issue a request for an already aborted caller", async () => {
    const client = createHttpHostClient({ refreshIntervalMs: 0 });
    const rpc = attachmentRpc(client)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(content());
    try {
      await expect(boundedRead(client, "image")).rejects.toThrow("offline");
      await boundedRead(client, "image");
      expect(rpc).toHaveBeenCalledTimes(2);
      await expect(boundedRead(client, "other", AbortSignal.abort())).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(rpc).toHaveBeenCalledTimes(2);
    } finally {
      client.dispose();
    }
  });

  it.each(["sign-out", "user", "deployment"] as const)(
    "clears bytes and in-flight reads on %s",
    async (change) => {
      let payload = bootstrap([]);
      let authenticated = true;
      const client = createHttpHostClient({
        refreshIntervalMs: 0,
        fetch: async (input) => {
          const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
          if (path === "/v1/rpc/auth.config") return json(payload.identityConfig);
          return authenticated ? json(payload) : json({ error: unauthorizedError() }, 401);
        },
      });
      try {
        await client.load();
        const rpc = attachmentRpc(client).mockResolvedValue(content());
        await boundedRead(client, "image");
        let complete!: (value: ReturnType<typeof content>) => void;
        rpc.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              complete = resolve;
            }),
        );
        const pending = boundedRead(client, "pending");
        const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
        if (change === "sign-out") authenticated = false;
        else if (change === "user")
          payload = { ...payload, user: { ...payload.user, id: createId("user") } };
        else payload = { ...payload, deploymentId: createId("deployment") };
        await client.refresh();
        await rejected;
        complete(content());
        await boundedRead(client, "image");
        await boundedRead(client, "pending");
        expect(rpc).toHaveBeenCalledTimes(4);
      } finally {
        client.dispose();
      }
    },
  );
});
