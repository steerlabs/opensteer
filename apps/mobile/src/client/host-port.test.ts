import { TeamRuntimeOwner } from "@opensteer/client/team";
import { expect, it, vi } from "vitest";
import { HostSessionExchange, type NativeOAuthManager } from "@opensteer/client/auth";
import { DeploymentCatalogSchema } from "@opensteer/client/connections";
import { createId, ModelSelectionSchema, personalRemoteAuthorizationScheme } from "@opensteer/core";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { expectedMutationSessionHeader } from "@opensteer/protocol";
import { testDeploymentConnection } from "../../test-support/deployment-fixtures.js";
import { createHostAuthorization } from "../platform/host-network.js";
import { MemorySecureStore } from "../platform/memory-secure-store.js";
import { createSecureRecordStore } from "../platform/secure-record-store.js";
import { createPersonalSessionStore } from "./personal-session-store.js";
import { createNetworkHostPort } from "./host-port.js";

it.each([false, true])(
  "recovers an expired maintenance session across an epoch mismatch; wrong identity=%s",
  async (wrongIdentity) => {
    const connection = testDeploymentConnection({ kind: "personal", route: { kind: "connect" } });
    if (connection.reachability !== "routed") throw new Error("Expected route");
    const deploymentId = connection.authority.document.deploymentId;
    const sessions = createPersonalSessionStore(
      createSecureRecordStore({
        secureStore: new MemorySecureStore(),
        keyPrefix: "maintenance-test",
      }),
    );
    const token = `${"a".repeat(43)}.${"b".repeat(43)}=`;
    await sessions.save({
      deploymentId,
      token,
      expiresAt: "2020-01-01T00:00:00.000Z",
      absoluteExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    const authority = wrongIdentity
      ? testDeploymentConnection({
          kind: "personal",
          deploymentId: "dep_0192f4a1-4444-4000-8000-000000000004",
        }).authority
      : connection.authority;
    const status = { supported: true, state: null, operation: null, revision: "host:0" };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/personal-access-route"))
        return Response.json(connection.personalAccessRoute);
      if (url.endsWith("/.well-known/opensteer"))
        return Response.json({
          kind: "personal",
          authority,
          apiVersion: hostApiVersion - 1,
          bootstrapMethods: ["connect-grant"],
          capabilities: [],
        });
      return new Headers(init?.headers).has("authorization")
        ? Response.json(status)
        : Response.json({}, { status: 401 });
    });
    const exchange = new HostSessionExchange({
      application: "mobile",
      account: { issuePersonalHostSessionGrant: vi.fn() },
      fetch: (_id, input, init) => fetch(input, init),
    });
    const establish = vi.spyOn(exchange, "establish").mockResolvedValue({
      credentialDelivery: "header",
      credential: {
        token,
        expiresAt: "2099-01-01T00:00:00.000Z",
        absoluteExpiresAt: "2099-01-01T00:00:00.000Z",
      },
    } as Awaited<ReturnType<HostSessionExchange["establish"]>>);
    const owner = new TeamRuntimeOwner(null);
    const oauth = {
      teamRuntime: () => owner,
      subscribe: () => () => {},
      subscribeHostCredentials: () => () => {},
      authorizationHeader: vi.fn(),
    } as unknown as NativeOAuthManager;
    const port = createNetworkHostPort({
      fetch,
      now: () => new Date(),
      lifecycle: {
        getSnapshot: () => ({ network: "online", visibility: "foreground" }),
        onBackground: () => () => {},
        onForeground: () => () => {},
        onNetworkChange: () => () => {},
      },
      openWebSocket: vi.fn(),
      origin: { app: "ios", device: "phone" },
    })({ oauth, sessions, sessionExchange: exchange });
    const updates = port.desktopUpdates({
      deploymentId,
      catalog: {
        load: async () =>
          DeploymentCatalogSchema.parse({
            schemaVersion: DeploymentCatalogSchema.shape.schemaVersion.value,
            revision: 1,
            deployments: [connection],
            selectedDeploymentId: deploymentId,
            updatedAt: new Date().toISOString(),
          }),
        subscribe: () => () => {},
      },
    });
    if (wrongIdentity) {
      await expect(updates.status()).rejects.toMatchObject({ reason: "invalid-response" });
      expect(establish).not.toHaveBeenCalled();
      expect(
        fetch.mock.calls.every(([, init]) => !new Headers(init?.headers).has("authorization")),
      ).toBe(true);
    } else {
      await expect(updates.status()).resolves.toEqual(status);
      expect(establish).toHaveBeenCalledOnce();
      expect(await sessions.authorization(deploymentId, new Date())).toContain(token);
    }
  },
);

it("sends both PersonalRemote authorization and the Host AuthSessionId on mobile task creation", async () => {
  const connection = testDeploymentConnection({ kind: "personal", route: { kind: "connect" } });
  if (connection.reachability !== "routed") throw new Error("Expected route");
  const deploymentId = connection.authority.document.deploymentId;
  const userId = createId("user");
  const hostSessionId = createId("authSession");
  const threadId = createId("thread");
  const environmentId = createId("environment");
  const harnessInstanceId = createId("harnessInstance");
  const modelSelection = ModelSelectionSchema.parse({
    modelId: "claude",
    providerId: "anthropic",
    options: {},
  });
  const at = "2026-11-23T15:00:00.000Z";
  const sessions = createPersonalSessionStore(
    createSecureRecordStore({
      secureStore: new MemorySecureStore(),
      keyPrefix: "mobile-session-fence-test",
    }),
  );
  const token = `${"a".repeat(43)}.${"b".repeat(43)}=`;
  await sessions.save({
    deploymentId,
    token,
    expiresAt: "2099-01-01T00:00:00.000Z",
    absoluteExpiresAt: "2099-01-01T00:00:00.000Z",
  });
  const stored = await sessions.load(deploymentId);
  const viewLoginId = stored!.viewLoginId!;
  expect(viewLoginId).not.toBe(hostSessionId);

  const seenHeaders: { readonly authorization: string | null; readonly expectedSession: string | null }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    if (url.pathname.endsWith("/commands.dispatch")) {
      const authorization = headers.get("authorization");
      const expectedSession = headers.get(expectedMutationSessionHeader);
      seenHeaders.push({ authorization, expectedSession });
      if (authorization !== `${personalRemoteAuthorizationScheme} ${token}`) {
        return Response.json(
          { ok: false, error: { code: "unauthorized", message: "Unauthorized", retryable: false } },
          { status: 401 },
        );
      }
      if (expectedSession !== null && expectedSession !== hostSessionId) {
        return Response.json(
          {
            ok: false,
            error: {
              code: "forbidden",
              reason: "session-changed",
              message: "This request belongs to another sign-in.",
              retryable: false,
            },
          },
          { status: 403 },
        );
      }
      const command = JSON.parse(String(init?.body)) as { type: string };
      if (command.type === "thread.create") {
        return Response.json({
          ok: true,
          data: {
            type: "thread.create",
            asOfSequence: "1",
            wasDuplicate: false,
            thread: {
              accessMode: "auto",
              continuationIdentity: null,
              createdAt: at,
              updatedAt: at,
              createdBy: userId,
              environmentId,
              harnessInstanceId,
              id: threadId,
              lineageRootThreadId: threadId,
              inputQueuePaused: false,
              listed: true,
              modelSelection,
              parentThreadId: null,
              pendingRequests: 0,
              status: "idle",
              title: "Phone task",
              purpose: "task",
              teamOrigin: null,
            },
          },
        });
      }
      return Response.json({
        ok: true,
        data: {
          type: "execution.preferences.remember",
          preferences: { accessMode: "auto", selection: null },
        },
      });
    }
    return Response.json({ ok: true, data: {} });
  });

  const openWebSocket = vi.fn(() => {
    const listeners = new Map<string, Set<(event: never) => void>>();
    const emit = (type: string, event: unknown) => {
      for (const listener of listeners.get(type) ?? []) listener(event as never);
    };
    const ws = {
      binaryType: "arraybuffer" as const,
      readyState: 0,
      addEventListener: (type: string, listener: (event: never) => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
      },
      close: () => {
        ws.readyState = 3;
      },
      send: (raw: string | ArrayBufferLike | Blob | ArrayBufferView) => {
        const frame = JSON.parse(String(raw)) as { type?: string; generation?: number };
        if (frame.type !== "client.attach") return;
        const generation = frame.generation ?? 1;
        queueMicrotask(() => {
          emit("message", {
            data: JSON.stringify({
              type: "host.snapshot",
              subscriptionId: "shell",
              scope: { kind: "shell" },
              generation,
              throughSequence: "0",
              snapshot: {
                deploymentId,
                viewerId: userId,
                epoch: crypto.randomUUID(),
                tasks: [],
                visits: [],
                attention: [],
                attentionHasMore: false,
                counts: {
                  pendingRequestCount: 0,
                  pendingRequestsRevision: "0",
                  needsYouCount: 0,
                  unreadTaskCount: 0,
                },
                session: {
                  sessionId: hostSessionId,
                  sessionSurface: "personal-remote",
                  user: {
                    id: userId,
                    displayName: "Owner",
                    email: "owner@example.test",
                    image: null,
                    emailVerified: true,
                    disabledAt: null,
                  },
                  can: {
                    createTasks: true,
                    useVoice: true,
                    manageComputers: true,
                    managePrivateResources: true,
                  },
                },
                activeTaskIds: [],
                activeNextBefore: null,
                recentTaskIds: [],
                nextBefore: null,
                taskCounts: { active: 0, open: 0 },
              },
            }),
          });
          emit("message", {
            data: JSON.stringify({
              type: "host.synchronized",
              subscriptionId: "shell",
              scope: { kind: "shell" },
              generation,
              throughSequence: "0",
            }),
          });
        });
      },
    };
    queueMicrotask(() => {
      ws.readyState = 1;
      emit("open", {});
    });
    return ws;
  });

  const owner = new TeamRuntimeOwner(null);
  const oauth = {
    teamRuntime: () => owner,
    subscribe: () => () => {},
    subscribeHostCredentials: () => () => {},
    authorizationHeader: vi.fn(),
  } as unknown as NativeOAuthManager;
  const exchange = new HostSessionExchange({
    application: "mobile",
    account: { issuePersonalHostSessionGrant: vi.fn() },
    fetch: (_id, input, init) => fetch(input, init),
  });
  const port = createNetworkHostPort({
    fetch,
    now: () => new Date(),
    lifecycle: {
      getSnapshot: () => ({ network: "online", visibility: "foreground" }),
      onBackground: () => () => {},
      onForeground: () => () => {},
      onNetworkChange: () => () => {},
    },
    openWebSocket: openWebSocket as never,
    origin: { app: "ios", device: "phone" },
  })({ oauth, sessions, sessionExchange: exchange });

  const authorization = createHostAuthorization(() =>
    sessions.authorization(deploymentId, new Date(), viewLoginId),
  );
  const client = port.attach({
    authorization,
    capabilities: async () => [],
    connection,
    origin: connection.personalAccessRoute!.document.route.origin,
    clientScope: () => {
      const viewer = client.getSnapshot().user?.id;
      return viewer
        ? {
            authorityKey: "mobile-authority",
            deploymentId,
            viewerId: viewer,
            loginId: viewLoginId,
          }
        : null;
    },
  });
  try {
    await client.load();
    const scope = client.connection.getSnapshot().scope!;
    expect(scope.loginId).toBe(viewLoginId);
    const created = await client.createThread(
      {
        accessMode: "auto",
        environmentId,
        harnessInstanceId,
        modelSelection,
        title: "Phone task",
      },
      scope,
    );
    expect(created.id).toBe(threadId);
    expect(seenHeaders[0]).toEqual({
      authorization: `${personalRemoteAuthorizationScheme} ${token}`,
      expectedSession: hostSessionId,
    });
  } finally {
    client.dispose();
  }
});
