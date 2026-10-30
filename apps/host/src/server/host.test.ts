import { mkdtemp, readFile, rm } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createId,
  emptyExecutionPreferences,
  OpensteerError,
  personalRemoteAuthorizationScheme,
  rememberExecutionChoice,
  ThreadAccessModeSchema,
  type AuthenticatedSession,
  type EnvironmentId,
  type ExecutionChoice,
  type ExecutionPreferences,
  type Request as OpensteerRequest,
  type RunnerId,
  type ThreadAccessMode,
  type UserId,
  type Workspace,
} from "@opensteer/core";
import type { OpensteerStore, WorkspaceFilesAdmission } from "@opensteer/database";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { createIntegrationId } from "@opensteer/integration-core";
import {
  HarnessInstanceCatalogSchema,
  agentToolPayloadMaxSerializedBytes,
  hostApiVersionHeader,
  ShellSessionIdSchema,
  type HarnessAuthenticationState,
  type HarnessInstanceCatalog,
} from "@opensteer/protocol";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import {
  PortableFsControlPlaneError,
  PortableFsWorkspaceLifecycleDriver,
  type PortableFsControlPlane,
  type PortableFsManagerVolume,
} from "@opensteer/workspace-portablefs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostAuthenticator } from "../identity/auth.js";
import { HarnessAuthenticationCoordinator } from "../identity/harness-authentication-coordinator.js";
import {
  hostServerTestDependencies,
  type HostServerTestOverrides,
} from "./host-server-test-harness.js";
import { injectRpcRequest } from "./test-host-api-request.js";
import {
  loadOrCreateHostKeys,
  signHostDiscovery,
  SignedTokenClaimsSchema,
  SignedTokenService,
} from "../identity/host-keys.js";
import {
  createHostServer as createProductionHostServer,
  RunnerChallengeAdmission,
} from "../server.js";
import { unroutedShellControlStream } from "../shell/shell-control-stream.test-support.js";
import { WorkspaceService } from "../workspace/workspace-service.js";
import { hostInternalRoutePaths } from "./internal-routes.js";

const temporaryDirectories: string[] = [];

function createHostServer(dependencies: HostServerTestOverrides) {
  const complete = hostServerTestDependencies(dependencies);
  const authenticator = complete.authenticator;
  const runners = Object.assign(
    {
      identityForRunner: () => undefined,
      isRunnerConnected: () => false,
      moduleReadiness: () => undefined,
    },
    complete.runners,
  ) as typeof complete.runners;
  const store = Object.assign(
    {
      countLiveThreadsByEnvironment: async () => new Map(),
      listLocalWorkspacesForEnvironments: async () => [],
      listPendingRunnerEnrollments: async () => [],
      listRunners: async () => ({ nextCursor: null, runners: [] }),
    },
    complete.store,
  ) as typeof complete.store;
  return createProductionHostServer({
    ...complete,
    authenticator: {
      ...authenticator,
      authenticateSessionContext: async (headers, options) => ({
        credentialKind: "browser-cookie" as const,
        session:
          typeof authenticator.authenticateSession === "function"
            ? await authenticator.authenticateSession(headers, options)
            : testAuthenticatedSession(await authenticator.authenticateUser(headers, options)),
        surface: "canonical" as const,
      }),
    } as HostAuthenticator,
    runners,
    store,
  });
}

function testAuthenticatedSession(userId: UserId): AuthenticatedSession {
  return {
    absoluteExpiresAt: "2026-09-12T00:00:00.000Z",
    createdAt: "2026-08-12T00:00:00.000Z",
    expiresAt: "2026-08-13T00:00:00.000Z",
    id: createId("authSession"),
    user: {
      disabledAt: null,
      displayName: "Owner",
      email: "owner@example.com",
      emailVerified: true,
      id: userId,
      image: null,
      instanceRole: "administrator",
    },
  };
}

function rpcData(response: LightMyRequestResponse): Readonly<Record<string, unknown>> {
  const body = response.json<{ data?: Readonly<Record<string, unknown>>; ok: boolean }>();
  expect(body.ok).toBe(true);
  return body.data ?? {};
}

/** The refusal an rpc call carried, which is where a message people read lives. */
function rpcError(response: LightMyRequestResponse): { readonly message: string } {
  const body = response.json<{ error?: { message: string }; ok: boolean }>();
  expect(body.ok).toBe(false);
  if (!body.error) throw new Error("The rpc response carried no error");
  return body.error;
}

function injectHarnessAuthentication(
  app: FastifyInstance,
  method: "DELETE" | "GET" | "POST",
  environmentId: EnvironmentId,
  harnessInstanceId: string,
): Promise<LightMyRequestResponse> {
  if (method === "GET") {
    return injectRpcRequest(app, "harness.authentication.get", {
      environmentId,
      harnessInstanceId,
    });
  }
  return injectRpcRequest(app, "commands.dispatch", {
    environmentId,
    harnessInstanceId,
    idempotencyKey: `harness-auth-${method.toLowerCase()}`,
    ...(method === "POST" ? { connectionSlot: "primary", methodId: "subscription" } : {}),
    type: method === "POST" ? "harness.authentication.begin" : "harness.authentication.cancel",
  });
}

/**
 * The realtime hub as a command handler uses it: `publish` for a Workspace's
 * durable events, `broadcast` for the "read the computers list again" nudge.
 */
function testRealtime(overrides: Record<string, unknown> = {}) {
  return { broadcast: vi.fn(), publish: vi.fn(), ...overrides } as never;
}

const testDiscoveryKeys = generateKeyPairSync("ed25519");
const testDiscovery = signHostDiscovery(testDiscoveryKeys, {
  canonicalOrigin: "https://opensteer.example",
  deploymentId: createId("deployment"),
  hostInstanceId: createId("hostInstance"),
  hostKey: {
    algorithm: "Ed25519",
  },
  deploymentShape: {
    defaultWorkspaceBacking: "local-directory",
    kind: "server" as const,
  },
});
/** The PortableFS shape, which a server may only claim alongside its services. */
const portableFsDiscovery = signHostDiscovery(testDiscoveryKeys, {
  ...testDiscovery.document,
  deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
});
const personalDiscovery = signHostDiscovery(testDiscoveryKeys, {
  ...testDiscovery.document,
  canonicalOrigin: "http://127.0.0.1:47821",
  deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "personal" },
});

describe("public Runner challenge admission", () => {
  it("bounds unauthenticated sockets and releases each slot exactly once", () => {
    const admission = new RunnerChallengeAdmission(2);
    const first = admission.acquire();
    const second = admission.acquire();
    expect(first).toBeTypeOf("function");
    expect(second).toBeTypeOf("function");
    expect(admission.acquire()).toBeNull();
    first?.();
    first?.();
    expect(admission.acquire()).toBeTypeOf("function");
  });
});

describe("PortableFS server assembly", () => {
  const portableFsServices = {
    mountExchange: {} as never,
    workspaceActivity: { note: () => undefined },
    workspaceWake: { wake: async () => undefined },
  };

  it("accepts each shape only with the services that shape implies", async () => {
    const local = await createHostServer({ discovery: testDiscovery });
    await local.close();
    const portableFs = await createHostServer({
      discovery: portableFsDiscovery,
      portablefs: portableFsServices,
    });
    await portableFs.close();
  });

  it("refuses a shape and a service record that disagree", async () => {
    await expect(createHostServer({ discovery: portableFsDiscovery })).rejects.toThrow(
      /must be declared together/u,
    );
    await expect(
      createHostServer({ discovery: testDiscovery, portablefs: portableFsServices }),
    ).rejects.toThrow(/must be declared together/u);
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Host signing keys", () => {
  it("expires and renews capabilities across the full injected interval", () => {
    let now = 1_800_000_000_000;
    const tokens = new SignedTokenService(
      generateKeyPairSync("ed25519"),
      {
        deploymentId: createId("deployment"),
        hostInstanceId: createId("hostInstance"),
      },
      () => now,
    );
    const original = tokens.issue({ purpose: "capability-refresh" }, 4);
    expect(tokens.verify(original, SignedTokenClaimsSchema).exp).toBe(now / 1_000 + 4);
    now += 3_999;
    expect(() => tokens.verify(original, SignedTokenClaimsSchema)).not.toThrow();
    now += 2_001;
    expect(() => tokens.verify(original, SignedTokenClaimsSchema)).toThrow(/Invalid or expired/);
    const fresh = tokens.issue({ purpose: "capability-refresh" }, 4);
    expect(tokens.verify(fresh, SignedTokenClaimsSchema).exp).toBe(now / 1_000 + 4);
  });

  it("persists a matching Ed25519 pair and rejects token tampering", async () => {
    const directory = await temporaryDirectory();
    const first = await loadOrCreateHostKeys({ dataDirectory: directory });
    const second = await loadOrCreateHostKeys({ dataDirectory: directory });
    expect(second.publicKeyPem).toBe(first.publicKeyPem);
    expect(await readFile(first.privateKeyPath, "utf8")).toContain("BEGIN PRIVATE KEY");

    const authority = {
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
    } as const;
    const tokens = new SignedTokenService(first, authority);
    const token = tokens.issue({ purpose: "test" }, 60);
    const claims = tokens.verify(token, SignedTokenClaimsSchema);
    expect(claims.iss).toBe("opensteer-host");
    expect(claims).toMatchObject(authority);
    const segments = token.split(".");
    const tampered = `${segments[0]}.${segments[1]}x.${segments[2]}`;
    expect(() => tokens.verify(tampered, SignedTokenClaimsSchema)).toThrow(/Invalid or expired/);
    const nextAuthority = new SignedTokenService(first, {
      ...authority,
      hostInstanceId: createId("hostInstance"),
    });
    expect(() => nextAuthority.verify(token, SignedTokenClaimsSchema)).toThrow(
      /Invalid or expired/,
    );
    const attemptedOverride = tokens.issue(
      { deploymentId: createId("deployment"), purpose: "test" },
      60,
    );
    expect(tokens.verify(attemptedOverride, SignedTokenClaimsSchema)).toMatchObject(authority);
  });

  it("binds cookie sessions to the configured origin for mutations", async () => {
    const owner = createId("user");
    const session = {
      absoluteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      id: createId("authSession"),
      user: {
        disabledAt: null,
        displayName: "Owner",
        email: "owner@example.com",
        emailVerified: true,
        id: owner,
        image: null,
        instanceRole: "administrator",
      },
    } satisfies AuthenticatedSession;
    const requireSession = vi.fn(async () => session);
    const authenticator = new HostAuthenticator({
      identity: { requireSession } as never,
      publicUrl: new URL("https://opensteer.example"),
    });
    await expect(authenticator.authenticateUser({ cookie: "session=test" })).resolves.toBe(owner);
    await expect(
      authenticator.authenticateUser(
        { cookie: "session=test", origin: "https://evil.example" },
        { mutation: true },
      ),
    ).rejects.toThrow(/origin/);
    await expect(
      authenticator.authenticateUser(
        { cookie: "session=test", origin: "https://opensteer.example" },
        { mutation: true },
      ),
    ).resolves.toBe(owner);
  });

  it("applies the exact-origin cookie boundary to realtime WebSocket handshakes", async () => {
    const ownerId = createId("user");
    const session = testAuthenticatedSession(ownerId);
    const authenticateSession = vi.fn(async () => session);
    const app = await createHostServer({
      requestResponseVault: {} as never,
      agentControl: {} as never,
      agentTools: {} as never,
      authenticator: {
        authenticateSession,
        identity: {
          configuration: async () => ({
            localPasswordEnabled: true,
            oidcProviders: [],
          }),
          nativeOpenIdConfiguration: () => undefined,
        },
      } as never,
      browser: {} as never,
      commands: {} as never,
      credentials: {} as never,
      discovery: testDiscovery,
      egress: {} as never,
      files: {} as never,
      harnessAuthenticationCoordinator: {} as never,
      realtime: testRealtime(),
      runnerAuthenticator: {} as never,
      runners: {} as never,
      securityEffects: {} as never,
      store: {} as never,
      workspaces: {} as never,
    } satisfies HostServerTestOverrides);
    try {
      const discovery = await app.inject({ method: "GET", url: "/.well-known/opensteer" });
      expect(discovery.statusCode).toBe(200);
      expect(discovery.json().apiVersion).toBe(48);
      expect(discovery.headers["cache-control"]).toBe("no-store");
      expect(discovery.json()).toEqual({
        apiVersion: hostApiVersion,
        authority: testDiscovery,
        bootstrapMethods: ["password"],
        capabilities: [
          "chat-attachments",
          "thread-titles-v1",
          "task-marks-v1",
          "snapshot-messages-omit-v1",
          "shared-task-done-v1",
          "iphone-apps-v1",
          "ownerViewWindows",
          "browser-target-control-v1",
          "browser-frame-window-v1",
          "browser-raster-demand-v1",
          "browser-capture-region-v1",
          "browser-search-suggestions-v1",
          "workspace-tab-reopen-v1",
        ],
      });
      await app.inject({
        headers: { cookie: "opensteer_session=test", origin: "https://opensteer.example" },
        method: "GET",
        url: "/v1/realtime",
      });
      expect(authenticateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          cookie: "opensteer_session=test",
          origin: "https://opensteer.example",
        }),
        { mutation: true },
      );
    } finally {
      await app.close();
    }
  });

  it("advertises exactly the optional features whose routes it registered", async () => {
    const app = await createHostServer({
      authenticator: {
        authenticateUser: async () => createId("user"),
        identity: {
          configuration: async () => ({ localPasswordEnabled: false, oidcProviders: [] }),
          nativeOAuthAuthorizationServerMetadata: () => async () => new Response(null),
          nativeOpenIdConfiguration: () => async () => new Response(null),
        },
        publicOrigin: "https://opensteer.example",
      } as never,
      discovery: testDiscovery,
      personalRemoteAccess: {
        service: { accountSessionExchangeEnabled: () => true } as never,
      },
      realtime: testRealtime(),
    } satisfies HostServerTestOverrides);
    try {
      const discovery = await app.inject({ method: "GET", url: "/.well-known/opensteer" });

      expect(discovery.json()).toMatchObject({
        apiVersion: hostApiVersion,
        capabilities: [
          "chat-attachments",
          "thread-titles-v1",
          "task-marks-v1",
          "snapshot-messages-omit-v1",
          "shared-task-done-v1",
          "iphone-apps-v1",
          "ownerViewWindows",
          "browser-target-control-v1",
          "browser-frame-window-v1",
          "browser-raster-demand-v1",
          "browser-capture-region-v1",
          "browser-search-suggestions-v1",
          "workspace-tab-reopen-v1",
          "native-oauth",
          "personal-session-header",
        ],
      });
    } finally {
      await app.close();
    }
  });
});

describe("rpc envelope", () => {
  const testIdentity = {
    configuration: async () => ({ deployment: { kind: "hosted", name: "Test" } }),
    nativeOpenIdConfiguration: () => undefined,
  };

  function machinesServer(
    overrides: {
      readonly authenticateSession?: () => Promise<AuthenticatedSession>;
      readonly listPendingRunnerEnrollments?: OpensteerStore["listPendingRunnerEnrollments"];
      readonly listRunners?: OpensteerStore["listRunners"];
    } = {},
  ) {
    const ownerId = createId("user");
    return createHostServer({
      authenticator: {
        authenticateSession:
          overrides.authenticateSession ?? (async () => testAuthenticatedSession(ownerId)),
        identity: testIdentity,
      } as never,
      channels: { relay: {}, service: {} } as never,
      discovery: testDiscovery,
      runners: {
        identityForRunner: () => undefined,
        isRunnerConnected: () => false,
        moduleReadiness: () => undefined,
      } as never,
      store: {
        countLiveThreadsByEnvironment: async () => new Map(),
        listLocalWorkspacesForEnvironments: async () => [],
        listPendingRunnerEnrollments: overrides.listPendingRunnerEnrollments ?? (async () => []),
        listRunners: overrides.listRunners ?? (async () => ({ runners: [] })),
      } as never,
    } satisfies HostServerTestOverrides);
  }

  it("refuses an unauthenticated call inside the envelope the client parses", async () => {
    const app = await machinesServer({
      authenticateSession: async () => {
        throw new OpensteerError({ code: "unauthorized", message: "Authentication required" });
      },
    });
    try {
      const response = await injectRpcRequest(app, "machines.list", {});
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: { code: "unauthorized", message: "Authentication required", retryable: false },
        ok: false,
      });
      expect(response.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });

  it("refuses a caller on another protocol epoch before it authenticates or dispatches", async () => {
    const authenticateSession = vi.fn(async () => testAuthenticatedSession(createId("user")));
    const listRunners = vi.fn(async () => ({ nextCursor: null, runners: [] as const }));
    const app = await machinesServer({ authenticateSession, listRunners });
    try {
      expect(hostApiVersion).toBe(48);
      for (const legacyHostApiVersion of [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
        26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 49,
      ]) {
        const legacyEpoch = await injectRpcRequest(
          app,
          "machines.list",
          {},
          { [hostApiVersionHeader]: String(legacyHostApiVersion) },
        );
        expect(legacyEpoch.statusCode).toBe(400);
        expect(legacyEpoch.json()).toMatchObject({
          error: { code: "bad_request", reason: "unsupported-version", retryable: false },
          ok: false,
        });
      }

      const wrongVersion = await injectRpcRequest(
        app,
        "machines.list",
        {},
        { [hostApiVersionHeader]: String(hostApiVersion + 1) },
      );
      expect(wrongVersion.statusCode).toBe(400);
      expect(wrongVersion.json()).toMatchObject({
        error: { code: "bad_request", reason: "unsupported-version", retryable: false },
        ok: false,
      });

      // A caller that states no epoch is a client from before negotiation, and
      // gets the same answer rather than a silent pass.
      const noVersion = await app.inject({
        method: "GET",
        url: `/v1/rpc/machines.list?input=${encodeURIComponent("{}")}`,
      });
      expect(noVersion.statusCode).toBe(400);
      expect(noVersion.json()).toMatchObject({
        error: { code: "bad_request", reason: "unsupported-version" },
        ok: false,
      });

      expect(authenticateSession).not.toHaveBeenCalled();
      expect(listRunners).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("keeps client rpc payload parsing strict", async () => {
    const listRunners = vi.fn(async () => ({ nextCursor: null, runners: [] as const }));
    const app = await machinesServer({ listRunners });
    try {
      const response = await injectRpcRequest(app, "machines.list", { futureClientField: true });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "bad_request" }, ok: false });
      expect(listRunners).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("keeps an unexpected failure's own words out of the response", async () => {
    const app = await machinesServer({
      listRunners: async () => {
        throw new Error("postgres://opensteer:hunter2@db.internal/opensteer");
      },
    });
    try {
      const response = await injectRpcRequest(app, "machines.list", {});
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: { code: "internal", message: "Internal server error", retryable: false },
        ok: false,
      });
      expect(response.body).not.toContain("hunter2");
    } finally {
      await app.close();
    }
  });

  it("forbids storing a per-user read", async () => {
    const app = await machinesServer();
    try {
      const response = await injectRpcRequest(app, "machines.list", {});
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });

  it("lets a signed-in member list only their own computers and pending additions", async () => {
    const ownerId = createId("user");
    const session = {
      ...testAuthenticatedSession(ownerId),
      user: { ...testAuthenticatedSession(ownerId).user, instanceRole: "user" as const },
    };
    const listRunners = vi.fn(async () => ({ nextCursor: null, runners: [] as const }));
    const listPendingRunnerEnrollments = vi.fn(async () => [
      {
        deviceProfile: null,
        allowedModules: ["agents"] as const,
        expiresAt: new Date("2026-08-12T00:10:00.000Z"),
        id: "ren_pending",
        name: "Office computer",
        ownerKind: "user" as const,
        runnerKind: "local" as const,
      },
    ]);
    const app = await machinesServer({
      authenticateSession: async () => session,
      listPendingRunnerEnrollments,
      listRunners,
    });
    try {
      const response = await injectRpcRequest(app, "machines.list", {});
      expect(response.statusCode, response.body).toBe(200);
      expect(rpcData(response)).toMatchObject({
        machines: [
          {
            expiresAt: "2026-08-12T00:10:00.000Z",
            name: "Office computer",
            ownership: "mine",
            status: "pending",
          },
        ],
      });
      expect(listRunners).toHaveBeenCalledWith({
        includeDeployment: false,
        includeOtherOwners: false,
        limit: 100,
        ownerId,
      });
      expect(listPendingRunnerEnrollments).toHaveBeenCalledWith({
        includeDeployment: false,
        limit: 100,
        ownerId,
      });
    } finally {
      await app.close();
    }
  });

  it("lets owners revoke their own computer without deployment administration", async () => {
    const ownerId = createId("user");
    const session = {
      ...testAuthenticatedSession(ownerId),
      user: { ...testAuthenticatedSession(ownerId).user, instanceRole: "user" as const },
    };
    const runnerId = createId("runner");
    const revokeRunner = vi.fn(async () => ({
      cancelledRequestIds: [],
      closedBrowserSessions: [],
      events: [],
      requestEvents: [],
      revokedComputerConnectionIds: [],
    }));
    const revokeLiveRunner = vi.fn(async () => undefined);
    const app = await createHostServer({
      authenticator: {
        authenticateSession: async () => session,
        identity: testIdentity,
      } as never,
      discovery: testDiscovery,
      channels: { relay: { forget: vi.fn() }, service: {} } as never,
      browser: { abandonSession: vi.fn() } as never,
      runners: { revoke: revokeLiveRunner } as never,
      store: { revokeRunner } as never,
    });
    try {
      const response = await injectRpcRequest(app, "commands.dispatch", {
        idempotencyKey: "member-revokes-own-computer",
        machineId: runnerId,
        type: "machine.revoke",
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(revokeRunner).toHaveBeenCalledWith(runnerId, ownerId, {
        allowDeployment: false,
        allowOtherOwners: false,
      });
      expect(revokeLiveRunner).toHaveBeenCalledWith(runnerId);
    } finally {
      await app.close();
    }
  });

  it("publishes the terminal events for work the removed computer never claimed", async () => {
    const ownerId = createId("user");
    const runnerId = createId("runner");
    const terminalEvent = {
      id: createId("event"),
      runId: createId("run"),
      threadId: createId("thread"),
      data: {
        code: "forbidden",
        message: "Access revoked",
        retryable: false,
        status: "failed",
        startedAt: "2026-08-09T09:00:00.000Z",
        personWaiting: true,
        startedBy: {
          displayName: "Alex",
          kind: "human",
          userId: createId("user"),
          principalId: "test-principal",
        },
      },
      type: "run.failed",
      workspaceId: createId("workspace"),
    };
    const publish = vi.fn();
    const app = await createHostServer({
      authenticator: {
        authenticateSession: async () => testAuthenticatedSession(ownerId),
        identity: testIdentity,
      } as never,
      discovery: testDiscovery,
      channels: { relay: { forget: vi.fn() }, service: {} } as never,
      browser: { abandonSession: vi.fn() } as never,
      realtime: testRealtime({ publish }),
      runners: { revoke: vi.fn(async () => undefined) } as never,
      store: {
        revokeRunner: vi.fn(async () => ({
          cancelledRequestIds: [],
          closedBrowserSessions: [],
          events: [terminalEvent],
          requestEvents: [],
          revokedComputerConnectionIds: [],
        })),
      } as never,
    });
    try {
      const response = await injectRpcRequest(app, "commands.dispatch", {
        idempotencyKey: "revoke-settles-queued-work",
        machineId: runnerId,
        type: "machine.revoke",
      });
      expect(response.statusCode, response.body).toBe(200);
      // A parent Thread waiting on a delegation only learns about it here.
      expect(publish).toHaveBeenCalledWith(terminalEvent);
    } finally {
      await app.close();
    }
  });

  it("surfaces the refusal to retire the computer a Personal Deployment runs on", async () => {
    const ownerId = createId("user");
    const runnerId = createId("runner");
    const revokeRunner = vi.fn(async () => {
      throw new OpensteerError({
        code: "forbidden",
        message: "This computer runs the Deployment itself and cannot be removed",
      });
    });
    const revokeLiveRunner = vi.fn(async () => undefined);
    const app = await createHostServer({
      authenticator: {
        authenticateSession: async () => testAuthenticatedSession(ownerId),
        identity: testIdentity,
      } as never,
      discovery: testDiscovery,
      channels: { relay: { forget: vi.fn() }, service: {} } as never,
      browser: { abandonSession: vi.fn() } as never,
      runners: { revoke: revokeLiveRunner } as never,
      store: { revokeRunner } as never,
    });
    try {
      const response = await injectRpcRequest(app, "commands.dispatch", {
        idempotencyKey: "administrator-revokes-personal-main",
        machineId: runnerId,
        type: "machine.revoke",
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: { message: expect.stringContaining("runs the Deployment itself") },
      });
      // Nothing live is torn down when the durable refusal stands.
      expect(revokeLiveRunner).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("shows a computer's access with its live byte totals and whether owner reach is real", async () => {
    const ownerId = createId("user");
    const withShell = createId("runner");
    const withoutShell = createId("runner");
    const sessionId = ShellSessionIdSchema.parse(`shs_${globalThis.crypto.randomUUID()}`);
    const runnerRow = (id: RunnerId, shell: boolean) => ({
      accessPolicy: { commands: true, forwarding: false, reach: "owner", shares: [] },
      accessPolicyRevision: 3,
      // The grant, which a row reports whether or not the computer is
      // advertising the module right now.
      allowedModules: shell ? ["agents", "shell"] : ["agents"],
      enrollmentId: `ren_${id}`,
      environmentIds: [],
      id,
      kind: "local" as const,
      lastSeenAt: null,
      moduleDescriptors: shell
        ? { shell: { hostPublicKey: `ssh-ed25519 ${"A".repeat(68)}`, platform: "linux" } }
        : {},
      name: shell ? "example-mac" : "old-mac",
      ownerKind: "user" as const,
      ownerUserId: ownerId,
      revokedAt: null,
    });
    const app = await createHostServer({
      authenticator: {
        authenticateSession: async () => testAuthenticatedSession(ownerId),
        identity: testIdentity,
      } as never,
      channels: { relay: {}, service: {} } as never,
      discovery: testDiscovery,
      shellControl: {
        ...unroutedShellControlStream,
        liveSessionBytes: () => new Map([[sessionId, { bytesIn: 4_096, bytesOut: 512 }]]),
      } as never,
      store: {
        effectiveMachineOwners: async () =>
          new Map([[withShell, { effectiveOwner: ownerId, ownerKind: "user" }]]),
        listActiveShellSessions: async () => [
          {
            bytesIn: 0,
            bytesOut: 0,
            callerMachineName: "cloud-1",
            id: sessionId,
            requestedBy: ownerId,
            runId: createId("run"),
            startedAt: new Date().toISOString(),
            threadId: createId("thread"),
            threadTitle: "Fix the deploy",
          },
        ],
        listRunners: async () => ({
          nextCursor: null,
          runners: [runnerRow(withShell, true), runnerRow(withoutShell, false)],
        }),
      } as never,
    });
    try {
      const response = await injectRpcRequest(app, "machines.list", {});

      expect(response.statusCode, response.body).toBe(200);
      const machines = (rpcData(response) as { machines: { id: string; access: unknown }[] })
        .machines;
      expect(machines.find((machine) => machine.id === withShell)?.access).toMatchObject({
        // The row stores zeroes until the session ends; what it has actually
        // moved is only known to the hub.
        activeSessions: [{ bytesIn: 4_096, bytesOut: 512, id: sessionId }],
        ownerReachAvailable: true,
        revision: 3,
      });
      // A computer that does not advertise `shell` has no access to show, so the
      // page never offers controls the write side would refuse.
      expect(machines.find((machine) => machine.id === withoutShell)?.access).toBeNull();
    } finally {
      await app.close();
    }
  });

  it.each([
    ["owner", "server", "user", "local", "user", true],
    ["administrator who is not the owner", "server", "user", "local", "administrator", false],
    [
      "administrator of a Deployment-owned computer",
      "server",
      "deployment",
      "managed",
      "administrator",
      false,
    ],
    ["owner of a Personal Main computer", "personal", "deployment", "main", "administrator", true],
  ] as const)(
    "projects apps for the %s according to effective ownership",
    async (_label, deploymentKind, ownerKind, runnerKind, instanceRole, expected) => {
      const viewerId = createId("user");
      const otherOwnerId = createId("user");
      const runnerId = createId("runner");
      const apps = [
        {
          definitionId: "apple-messages",
          operations: [
            {
              operation: "list_conversations",
              detail: "Messages needs Full access.",
              remedy: "full-disk-access" as const,
              state: "permission-required" as const,
            },
            {
              operation: "read_messages",
              detail: "Messages needs Full access.",
              remedy: "full-disk-access" as const,
              state: "permission-required" as const,
            },
            {
              operation: "send_message",
              detail: "Messages needs Full access.",
              remedy: "full-disk-access" as const,
              state: "permission-required" as const,
            },
          ],
        },
      ];
      const session = testAuthenticatedSession(viewerId);
      const app = await createHostServer({
        authenticator: {
          authenticateSession: async () => ({
            ...session,
            user: { ...session.user, instanceRole },
          }),
          identity: testIdentity,
        } as never,
        computerApps: {
          displayStream: vi.fn(() => null),
          captureSupported: vi.fn(() => false),
          status: vi.fn(() => apps),
        } as never,
        discovery: deploymentKind === "personal" ? personalDiscovery : testDiscovery,
        store: {
          effectiveMachineOwners: async () =>
            new Map([
              [
                runnerId,
                {
                  effectiveOwner:
                    deploymentKind === "personal"
                      ? viewerId
                      : ownerKind === "user"
                        ? instanceRole === "user"
                          ? viewerId
                          : otherOwnerId
                        : null,
                  ownerKind,
                },
              ],
            ]),
          listRunners: async () => ({
            nextCursor: null,
            runners: [
              {
                accessPolicy: { commands: false, forwarding: false, reach: "nobody", shares: [] },
                accessPolicyRevision: 1,
                allowedModules: ["integrations"],
                enrollmentId: `ren_${runnerId}`,
                environmentIds: [],
                id: runnerId,
                kind: runnerKind,
                lastSeenAt: null,
                moduleDescriptors: { integrations: { platform: "darwin" } },
                name: "Studio Mac",
                ownerKind,
                ownerUserId: ownerKind === "user" ? otherOwnerId : null,
                revokedAt: null,
              },
            ],
          }),
        } as never,
      });
      try {
        const response = await injectRpcRequest(app, "machines.list", {});
        expect(response.statusCode, response.body).toBe(200);
        const machines = (rpcData(response) as { machines: { apps: unknown; id: string }[] })
          .machines;
        expect(machines.find((machine) => machine.id === runnerId)?.apps).toEqual(
          expected ? apps : null,
        );
      } finally {
        await app.close();
      }
    },
  );

  it("claims the revoked reason between the durable write and the stream teardown", async () => {
    const ownerId = createId("user");
    const runnerId = createId("runner");
    const order: string[] = [];
    const shellControl = {
      ...unroutedShellControlStream,
      endMachineSessions: vi.fn(async (_runnerId: RunnerId, reason: string) => {
        order.push(`sessions:${reason}`);
      }),
      withMachineAdmission: vi.fn(async (_runnerId: RunnerId, task: () => Promise<unknown>) =>
        task(),
      ),
    };
    const computerApps = {
      detachRunner: vi.fn(() => {
        order.push("apps-stream");
      }),
      withRunnerAdmission: vi.fn(async (_runnerId: RunnerId, task: () => Promise<unknown>) => {
        order.push("apps-admission");
        return task();
      }),
    };
    const app = await createHostServer({
      authenticator: {
        authenticateSession: async () => testAuthenticatedSession(ownerId),
        identity: testIdentity,
      } as never,
      browser: { abandonSession: vi.fn() } as never,
      channels: { relay: { forget: () => order.push("relay") }, service: {} } as never,
      computerApps: computerApps as never,
      discovery: testDiscovery,
      runners: {
        revoke: vi.fn(async () => {
          order.push("stream");
        }),
      } as never,
      shellControl: shellControl as never,
      store: {
        revokeRunner: vi.fn(async () => {
          order.push("durable");
          return {
            cancelledRequestIds: [],
            closedBrowserSessions: [],
            events: [],
            requestEvents: [],
            revokedComputerConnectionIds: [],
          };
        }),
      } as never,
    });
    try {
      const response = await injectRpcRequest(app, "commands.dispatch", {
        idempotencyKey: "revoke-records-revocation",
        machineId: runnerId,
        type: "machine.revoke",
      });

      expect(response.statusCode, response.body).toBe(200);
      // The sessions are claimed as revoked before the stream is torn down, so
      // the generic loss hook cannot record them as a disconnection first.
      expect(order).toEqual([
        "apps-admission",
        "durable",
        "sessions:machine-revoked",
        "stream",
        "relay",
        "apps-stream",
      ]);
      expect(shellControl.withMachineAdmission).toHaveBeenCalledWith(
        runnerId,
        expect.any(Function),
      );
      expect(computerApps.withRunnerAdmission).toHaveBeenCalledWith(runnerId, expect.any(Function));
    } finally {
      await app.close();
    }
  });

  it("carries the machine-access idempotency keys into the recorded results", async () => {
    const ownerId = createId("user");
    const runnerId = createId("runner");
    const sessionId = ShellSessionIdSchema.parse(`shs_${globalThis.crypto.randomUUID()}`);
    const updateMachineAccessPolicy = vi.fn(async () => ({
      outcome: "updated" as const,
      revision: 8,
    }));
    const end = vi.fn(async () => ({ ended: true }));
    const shellControl = {
      ...unroutedShellControlStream,
      end,
      endMachineSessions: vi.fn(async () => undefined),
      withMachineAdmission: vi.fn(async (_runnerId: RunnerId, task: () => Promise<unknown>) =>
        task(),
      ),
    };
    const app = await createHostServer({
      authenticator: {
        authenticateSession: async () => testAuthenticatedSession(ownerId),
        identity: testIdentity,
      } as never,
      discovery: testDiscovery,
      shellControl: shellControl as never,
      store: {
        effectiveMachineOwner: async () => ({ effectiveOwner: ownerId, ownerKind: "user" }),
        getShellSession: async () => ({ id: sessionId, runnerId }),
        updateMachineAccessPolicy,
      } as never,
    });
    try {
      const policy = { commands: true, forwarding: false, reach: "owner", shares: [] };
      const saved = await injectRpcRequest(app, "commands.dispatch", {
        expectedRevision: 7,
        idempotencyKey: "save-access-key",
        policy,
        runnerId,
        type: "machine.access.update",
      });
      const stopped = await injectRpcRequest(app, "commands.dispatch", {
        idempotencyKey: "stop-session-key",
        sessionId,
        type: "machine.access.session.stop",
      });

      expect(saved.statusCode, saved.body).toBe(200);
      expect(stopped.statusCode, stopped.body).toBe(200);
      expect(updateMachineAccessPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotency: { key: "save-access-key", requestedBy: ownerId },
        }),
      );
      // The write happens inside the machine's admission turn, so an activation
      // cannot commit against the revision it replaces.
      expect(shellControl.withMachineAdmission).toHaveBeenCalledWith(
        runnerId,
        expect.any(Function),
      );
      expect(end).toHaveBeenCalledWith(sessionId, "stopped-by-owner", {
        idempotency: { key: "stop-session-key", requestedBy: ownerId },
      });
    } finally {
      await app.close();
    }
  });

  it("closes sessions on a committed access save, and leaves them alone on a replay", async () => {
    const ownerId = createId("user");
    const runnerId = createId("runner");
    // A store that records the key the way the real one does: the second save
    // with the same key commits nothing and replays the recorded answer.
    const recorded = new Map<string, { readonly outcome: "updated"; readonly revision: number }>();
    const updateMachineAccessPolicy = vi.fn(
      async (input: { readonly idempotency: { readonly key: string } }) => {
        const replay = recorded.get(input.idempotency.key);
        if (replay) return { ...replay, replayed: true };
        const result = { outcome: "updated" as const, revision: 9 };
        recorded.set(input.idempotency.key, result);
        return { ...result, replayed: false };
      },
    );
    // What the machine is carrying at any moment, so "the session survived"
    // is a fact about the hub rather than about a spy's call count alone.
    const live = new Set<string>();
    const shellControl = {
      ...unroutedShellControlStream,
      endMachineSessions: vi.fn(async () => {
        live.clear();
      }),
      withMachineAdmission: vi.fn(async (_runnerId: RunnerId, task: () => Promise<unknown>) =>
        task(),
      ),
    };
    const app = await createHostServer({
      authenticator: {
        authenticateSession: async () => testAuthenticatedSession(ownerId),
        identity: testIdentity,
      } as never,
      discovery: testDiscovery,
      shellControl: shellControl as never,
      store: {
        effectiveMachineOwner: async () => ({ effectiveOwner: ownerId, ownerKind: "user" }),
        updateMachineAccessPolicy,
      } as never,
    });
    try {
      const save = () =>
        injectRpcRequest(app, "commands.dispatch", {
          expectedRevision: 7,
          idempotencyKey: "save-access-replay",
          policy: { commands: true, forwarding: false, reach: "owner", shares: [] },
          runnerId,
          type: "machine.access.update",
        });

      const committed = await save();
      expect(committed.statusCode, committed.body).toBe(200);
      // The policy a live session opened under is gone, so it is closed.
      expect(shellControl.endMachineSessions).toHaveBeenCalledTimes(1);

      // A new `ssh` opens under the policy that save committed.
      live.add("shs_opened-after-the-save");
      const replayed = await save();

      expect(replayed.statusCode, replayed.body).toBe(200);
      // The retried click reads back the same answer...
      expect(rpcData(replayed)).toMatchObject({ outcome: "updated", revision: 9 });
      // ...and closes nothing: this session is already running under it.
      expect(shellControl.endMachineSessions).toHaveBeenCalledTimes(1);
      expect([...live]).toEqual(["shs_opened-after-the-save"]);
    } finally {
      await app.close();
    }
  });

  it("includes deployment-owned computers only for administrators", async () => {
    const ownerId = createId("user");
    const listRunners = vi.fn(async () => ({ nextCursor: null, runners: [] }));
    const listPendingRunnerEnrollments = vi.fn(async () => []);
    const app = await machinesServer({
      authenticateSession: async () => testAuthenticatedSession(ownerId),
      listPendingRunnerEnrollments,
      listRunners,
    });
    try {
      const response = await injectRpcRequest(app, "machines.list", {});
      expect(response.statusCode, response.body).toBe(200);
      expect(listRunners).toHaveBeenCalledWith({
        includeDeployment: true,
        includeOtherOwners: true,
        limit: 100,
        ownerId,
      });
      expect(listPendingRunnerEnrollments).toHaveBeenCalledWith({
        includeDeployment: true,
        limit: 100,
        ownerId,
      });
    } finally {
      await app.close();
    }
  });

  it("repeats the consent endpoint's own refusal instead of a generic rejection", async () => {
    const app = await createHostServer({
      authenticator: {
        identity: {
          ...testIdentity,
          handleNativeOAuthRequest: async () =>
            new Response(JSON.stringify({ message: "Consent request has expired" }), {
              headers: { "content-type": "application/json" },
              status: 401,
            }),
        },
        publicOrigin: "https://opensteer.example",
        requireExactOrigin: () => undefined,
      } as never,
      discovery: testDiscovery,
    } satisfies HostServerTestOverrides);
    try {
      const refused = await injectRpcRequest(app, "auth.native.complete", {
        accept: true,
        oauthQuery: "client_id=opensteer-desktop",
      });
      expect(refused.statusCode).toBe(401);
      expect(refused.json()).toMatchObject({
        error: { code: "unauthorized", message: "Consent request has expired" },
        ok: false,
      });
    } finally {
      await app.close();
    }
  });

  it("holds session revocation to an exact-origin request whatever the credential", async () => {
    const session = testAuthenticatedSession(createId("user"));
    const revokeSession = vi.fn(async () => undefined);
    const authenticator = new HostAuthenticator({
      identity: {
        ...testIdentity,
        authenticateNativeAccessToken: async () => ({
          absoluteExpiresAt: new Date(session.absoluteExpiresAt),
          application: "desktop",
          clientId: "opensteer-desktop",
          createdAt: new Date(session.createdAt),
          expiresAt: new Date(session.expiresAt),
          sessionId: session.id,
          subject: session.user.id,
        }),
        requireSession: async () => session,
        revokeSession,
        userSessionProfile: async () => session.user,
      } as never,
      publicUrl: new URL("https://opensteer.example"),
    });
    const app = await createProductionHostServer(
      hostServerTestDependencies({ authenticator, discovery: testDiscovery }),
    );
    const command = {
      idempotencyKey: "revoke-a-session",
      sessionId: createId("authSession"),
      type: "session.revoke",
    };
    try {
      // A native access token authenticates without ever meeting the origin
      // comparison, which is exactly the caller this gate exists for.
      const bearer = await injectRpcRequest(app, "commands.dispatch", command, {
        authorization: "Bearer header.payload.signature",
      });
      expect(bearer.statusCode).toBe(403);
      expect(bearer.json()).toMatchObject({ error: { code: "forbidden" }, ok: false });
      expect(revokeSession).not.toHaveBeenCalled();

      const fromBrowser = await injectRpcRequest(app, "commands.dispatch", command, {
        cookie: "opensteer.session=test",
        origin: "https://opensteer.example",
      });
      expect(fromBrowser.statusCode, fromBrowser.body).toBe(200);
      expect(revokeSession).toHaveBeenCalledWith(session, command.sessionId);
    } finally {
      await app.close();
    }
  });

  it("lets a header credential end its own session without a browser origin", async () => {
    const session = testAuthenticatedSession(createId("user"));
    const revokeSession = vi.fn(async () => undefined);
    const authenticator = new HostAuthenticator({
      identity: {
        ...testIdentity,
        authenticateNativeAccessToken: async () => ({
          absoluteExpiresAt: new Date(session.absoluteExpiresAt),
          application: "mobile",
          clientId: "opensteer-mobile",
          createdAt: new Date(session.createdAt),
          expiresAt: new Date(session.expiresAt),
          sessionId: session.id,
          subject: session.user.id,
        }),
        requireSession: async () => session,
        revokeSession,
        userSessionProfile: async () => session.user,
      } as never,
      publicUrl: new URL("https://opensteer.example"),
    });
    const app = await createProductionHostServer(
      hostServerTestDependencies({ authenticator, discovery: testDiscovery }),
    );
    try {
      // A phone has no page and therefore no Origin to send. Holding this to
      // one would make signing out of a deployment impossible from a phone.
      const own = await injectRpcRequest(
        app,
        "commands.dispatch",
        {
          idempotencyKey: "revoke-my-own-session",
          sessionId: session.id,
          type: "session.revoke",
        },
        { authorization: "Bearer header.payload.signature" },
      );

      expect(own.statusCode, own.body).toBe(200);
      expect(revokeSession).toHaveBeenCalledWith(session, session.id);
    } finally {
      await app.close();
    }
  });

  it("lets a Personal remote session end itself, which is how a phone signs out", async () => {
    const session = testAuthenticatedSession(createId("user"));
    const revokeSession = vi.fn(async () => undefined);
    const authenticator = new HostAuthenticator({
      identity: { ...testIdentity, requireSession: async () => session, revokeSession } as never,
      personalRemote: {
        authenticateRemoteCredential: async () => session,
        authenticateRemoteSession: async () => null,
      },
      publicUrl: new URL("https://opensteer.example"),
    });
    const app = await createProductionHostServer(
      hostServerTestDependencies({ authenticator, discovery: testDiscovery }),
    );
    try {
      const own = await injectRpcRequest(
        app,
        "commands.dispatch",
        {
          idempotencyKey: "revoke-my-own-personal-session",
          sessionId: session.id,
          type: "session.revoke",
        },
        {
          authorization: `${personalRemoteAuthorizationScheme} ${"a".repeat(43)}.${"b".repeat(43)}=`,
        },
      );

      expect(own.statusCode, own.body).toBe(200);
      expect(revokeSession).toHaveBeenCalledWith(session, session.id);
    } finally {
      await app.close();
    }
  });

  it("still refuses a header credential ending somebody else's session", async () => {
    const session = testAuthenticatedSession(createId("user"));
    const revokeSession = vi.fn(async () => undefined);
    const authenticator = new HostAuthenticator({
      identity: {
        ...testIdentity,
        authenticateNativeAccessToken: async () => ({
          absoluteExpiresAt: new Date(session.absoluteExpiresAt),
          application: "mobile",
          clientId: "opensteer-mobile",
          createdAt: new Date(session.createdAt),
          expiresAt: new Date(session.expiresAt),
          sessionId: session.id,
          subject: session.user.id,
        }),
        requireSession: async () => session,
        revokeSession,
        userSessionProfile: async () => session.user,
      } as never,
      publicUrl: new URL("https://opensteer.example"),
    });
    const app = await createProductionHostServer(
      hostServerTestDependencies({ authenticator, discovery: testDiscovery }),
    );
    try {
      const other = await injectRpcRequest(
        app,
        "commands.dispatch",
        {
          idempotencyKey: "revoke-another-session",
          sessionId: createId("authSession"),
          type: "session.revoke",
        },
        { authorization: "Bearer header.payload.signature" },
      );

      // Signing this device out is one thing; ending another device's access
      // is the owner's move and still wants the owner's browser.
      expect(other.statusCode).toBe(403);
      expect(other.json()).toMatchObject({ error: { code: "forbidden" }, ok: false });
      expect(revokeSession).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("holds integration uninstall to an exact-origin request whatever the credential", async () => {
    const session = testAuthenticatedSession(createId("user"));
    const authenticator = new HostAuthenticator({
      identity: {
        ...testIdentity,
        authenticateNativeAccessToken: async () => ({
          absoluteExpiresAt: new Date(session.absoluteExpiresAt),
          application: "desktop",
          clientId: "opensteer-desktop",
          createdAt: new Date(session.createdAt),
          expiresAt: new Date(session.expiresAt),
          sessionId: session.id,
          subject: session.user.id,
        }),
        requireSession: async () => session,
        userSessionProfile: async () => session.user,
      } as never,
      publicUrl: new URL("https://opensteer.example"),
    });
    const uninstallIntegration = vi.fn(async () => ({
      cancelledRequests: 1,
      removedConnections: 2,
    }));
    const app = await createProductionHostServer(
      hostServerTestDependencies({
        authenticator,
        discovery: testDiscovery,
        integrations: {
          authAttempts: {} as never,
          continuations: {} as never,
          dashboard: {} as never,
          mcpOauth: {} as never,
          platform: { uninstallIntegration } as never,
          service: {} as never,
          skills: {} as never,
          tools: {} as never,
        },
      }),
    );
    const command = {
      idempotencyKey: "uninstall-an-integration",
      installationId: createIntegrationId("installation"),
      type: "integration.uninstall",
    };
    try {
      const bearer = await injectRpcRequest(app, "commands.dispatch", command, {
        authorization: "Bearer header.payload.signature",
      });
      expect(bearer.statusCode).toBe(403);
      expect(bearer.json()).toMatchObject({ error: { code: "forbidden" }, ok: false });
      expect(uninstallIntegration).not.toHaveBeenCalled();

      const fromBrowser = await injectRpcRequest(app, "commands.dispatch", command, {
        cookie: "opensteer.session=test",
        origin: "https://opensteer.example",
      });
      expect(fromBrowser.statusCode, fromBrowser.body).toBe(200);
      expect(rpcData(fromBrowser)).toEqual({
        cancelledRequests: 1,
        removedConnections: 2,
        type: "integration.uninstall",
      });
      expect(uninstallIntegration).toHaveBeenCalledWith({
        actorUserId: session.user.id,
        installationId: command.installationId,
        requestId: expect.any(String),
      });
    } finally {
      await app.close();
    }
  });

  it("refuses a listed command to a Personal remote session and leaves disconnecting open to it", async () => {
    const session = testAuthenticatedSession(createId("user"));
    const authenticator = new HostAuthenticator({
      identity: { ...testIdentity, requireSession: async () => session } as never,
      personalRemote: {
        authenticateRemoteCredential: async () => session,
        authenticateRemoteSession: async () => null,
      },
      publicUrl: new URL("http://127.0.0.1:43101"),
    });
    const uninstallIntegration = vi.fn(async () => ({
      cancelledRequests: 0,
      removedConnections: 0,
    }));
    const disconnect = vi.fn(async () => ({ notice: null, revokedUpstream: true }));
    const app = await createProductionHostServer(
      hostServerTestDependencies({
        authenticator,
        discovery: testDiscovery,
        integrations: {
          authAttempts: {} as never,
          continuations: {} as never,
          dashboard: {} as never,
          mcpOauth: {} as never,
          platform: {
            store: { getConnectionKind: async () => "oauth" },
            uninstallIntegration,
          } as never,
          service: { disconnect } as never,
          skills: {} as never,
          tools: {} as never,
        },
      }),
    );
    // A remote session arrives on its signed route, never on the canonical
    // loopback origin, so that route is the only origin it can honestly state.
    const remote = {
      authorization: `${personalRemoteAuthorizationScheme} ${"a".repeat(43)}.${"b".repeat(43)}=`,
      origin: "https://personal.route.example",
    };
    try {
      const uninstall = await injectRpcRequest(
        app,
        "commands.dispatch",
        {
          idempotencyKey: "remote-uninstall",
          installationId: createIntegrationId("installation"),
          type: "integration.uninstall",
        },
        remote,
      );
      expect(uninstall.statusCode).toBe(403);
      expect(uninstallIntegration).not.toHaveBeenCalled();

      // Disconnecting an account only ever reduces what agents can reach, and
      // the owner has to be able to do it from wherever they are.
      const connectionId = createIntegrationId("connection");
      const disconnected = await injectRpcRequest(
        app,
        "commands.dispatch",
        { connectionId, idempotencyKey: "remote-disconnect", type: "integration.disconnect" },
        remote,
      );
      expect(disconnected.statusCode, disconnected.body).toBe(200);
      expect(rpcData(disconnected)).toEqual({
        notice: null,
        revokedUpstream: true,
        type: "integration.disconnect",
      });
      expect(disconnect).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId, ownerUserId: session.user.id }),
      );
    } finally {
      await app.close();
    }
  });
});

/*
 * Where a phone reaches this Deployment, read without minting. Failure modes:
 * an anonymous caller learns the route; a Personal Deployment hands out its
 * loopback canonical origin, which no phone can reach, or answers with remote
 * access off instead of refusing by reason; a server answers anything but its
 * canonical origin, or an origin no phone may dial; the phone is told an
 * address, or nothing, to call a Deployment that has a name — and an unnamed
 * one is called anything but the address its own Settings page shows.
 */
describe("Agent Phone pairing target", () => {
  async function targetServer(input: {
    readonly authenticated?: boolean;
    readonly canonicalOrigin?: string;
    readonly deploymentName?: string | null;
    readonly personalRoute?: string | null;
  }) {
    const ownerId = createId("user");
    const document = {
      ...(input.personalRoute === undefined ? testDiscovery : personalDiscovery).document,
      ...(input.canonicalOrigin ? { canonicalOrigin: input.canonicalOrigin } : {}),
    };
    const accessRoute = vi.fn(async () =>
      input.personalRoute ? { document: { route: { origin: input.personalRoute } } } : null,
    );
    const app = await createHostServer({
      authenticator: {
        authenticateSession: async () => {
          if (input.authenticated === false) {
            throw new OpensteerError({ code: "unauthorized", message: "Authentication required" });
          }
          return testAuthenticatedSession(ownerId);
        },
        identity: {
          configuration: async () => ({
            deployment: {
              kind: "hosted",
              name: input.deploymentName === undefined ? "Test" : input.deploymentName,
            },
          }),
          nativeOpenIdConfiguration: () => undefined,
        },
      } as never,
      discovery: signHostDiscovery(testDiscoveryKeys, document),
      ...(input.personalRoute === undefined
        ? {}
        : {
            personalRemoteAccess: {
              service: { accessRoute, accountSessionExchangeEnabled: () => false } as never,
            },
          }),
    } satisfies HostServerTestOverrides);
    return { accessRoute, app };
  }

  it("answers a server's canonical origin with its Deployment and Host instance", async () => {
    const { app } = await targetServer({});
    try {
      const response = await injectRpcRequest(app, "agentPhone.target.get", {});
      expect(response.statusCode).toBe(200);
      expect(rpcData(response)).toEqual({
        deploymentId: testDiscovery.document.deploymentId,
        deploymentName: "Test",
        hostInstanceId: testDiscovery.document.hostInstanceId,
        hostUrl: "https://opensteer.example",
      });
    } finally {
      await app.close();
    }
  });

  it("calls an unnamed Deployment by its address, as its Settings page does", async () => {
    const { app } = await targetServer({ deploymentName: null });
    try {
      const response = await injectRpcRequest(app, "agentPhone.target.get", {});
      expect(rpcData(response)).toMatchObject({
        deploymentName: "opensteer.example",
        hostUrl: "https://opensteer.example",
      });
    } finally {
      await app.close();
    }
  });

  it("answers a Personal Deployment's live route, never its loopback origin", async () => {
    const { accessRoute, app } = await targetServer({
      deploymentName: "Mac mini",
      personalRoute: "https://mac.route.example",
    });
    try {
      const response = await injectRpcRequest(app, "agentPhone.target.get", {});
      expect(rpcData(response)).toMatchObject({
        deploymentName: "Mac mini",
        hostUrl: "https://mac.route.example",
      });
      expect(accessRoute).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("refuses by reason while a Personal Deployment's remote access is off", async () => {
    const { app } = await targetServer({ personalRoute: null });
    try {
      const response = await injectRpcRequest(app, "agentPhone.target.get", {});
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: { code: "forbidden", reason: "personal-remote-access-off" },
        ok: false,
      });
    } finally {
      await app.close();
    }
  });

  it("refuses an origin no phone may dial, and an anonymous caller", async () => {
    const plain = await targetServer({ canonicalOrigin: "http://opensteer.example" });
    try {
      const response = await injectRpcRequest(plain.app, "agentPhone.target.get", {});
      expect(response.statusCode).toBe(409);
      expect(rpcError(response).message).toBe(
        "A phone reaches Opensteer only over HTTPS, and this Deployment is at http://opensteer.example.",
      );
    } finally {
      await plain.app.close();
    }
    const anonymous = await targetServer({ authenticated: false });
    try {
      const response = await injectRpcRequest(anonymous.app, "agentPhone.target.get", {});
      expect(response.statusCode).toBe(401);
    } finally {
      await anonymous.app.close();
    }
  });
});

describe("Request routes", () => {
  it("seals a live form response and queues the one Runner control command", async () => {
    const ownerId = createId("user");
    const request = pendingRequestFixture("harness.input");
    const sendControl = vi.fn(async () => ({
      commandId: createId("command"),
      wasDuplicate: false,
    }));
    const seal = vi.fn(async () => ({ envelope: Buffer.from("encrypted"), keyVersion: 3 }));
    const app = await requestRouteServer({
      ownerId,
      request,
      requestResponseVault: {
        fingerprint: vi.fn(async () => "hmac-sha256-v1:3:fingerprint"),
        open: vi.fn(),
        seal,
      },
      sendControl,
    });
    const responseBody = {
      response: { answers: { password: ["only-in-the-sealed-envelope"] }, kind: "form" },
    } as const;
    try {
      const response = await injectRpcRequest(app, "commands.dispatch", {
        idempotencyKey: "resolve-secret-request",
        requestId: request.id,
        response: responseBody.response,
        type: "request.respond",
      });
      expect(response.statusCode).toBe(200);
      expect(seal).toHaveBeenCalledWith(
        { response: JSON.stringify(responseBody.response) },
        expect.objectContaining({
          binding: request.originatingRunId,
          recordId: request.id,
          scope: request.originatingThreadId,
        }),
      );
      expect(sendControl).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: "resolve-secret-request",
          requestId: request.id,
          response: responseBody.response,
          sealedResponse: expect.objectContaining({
            envelope: Buffer.from("encrypted"),
            keyVersion: 3,
          }),
          type: "request.respond",
        }),
      );
    } finally {
      await app.close();
    }
  });
});

describe("Optional subsystem registration", () => {
  it("rejects oversized MCP bodies before handing them to the transport", async () => {
    const handle = vi.fn();
    const app = await createHostServer({
      requestResponseVault: {} as never,
      agentControl: {} as never,
      agentTools: { handle } as never,
      authenticator: { authenticateUser: async () => createId("user") } as never,
      browser: {} as never,
      commands: {} as never,
      credentials: {} as never,
      discovery: testDiscovery,
      egress: {} as never,
      files: {} as never,
      harnessAuthenticationCoordinator: {} as never,
      realtime: testRealtime(),
      runnerAuthenticator: {} as never,
      runners: {} as never,
      securityEffects: {} as never,
      store: {} as never,
      workspaces: {} as never,
    } satisfies HostServerTestOverrides);
    try {
      const response = await app.inject({
        method: "POST",
        url: hostInternalRoutePaths.mcp,
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        payload: JSON.stringify({
          value: "x".repeat(agentToolPayloadMaxSerializedBytes + 32 * 1024),
        }),
      });
      expect(response.statusCode).toBe(413);
      expect(handle).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("no longer answers on any of the replaced session-establishment paths", async () => {
    const app = await createHostServer({
      requestResponseVault: {} as never,
      agentControl: {} as never,
      agentTools: {} as never,
      authenticator: { authenticateUser: async () => createId("user") } as never,
      browser: {} as never,
      commands: {} as never,
      credentials: {} as never,
      discovery: testDiscovery,
      egress: {} as never,
      files: {} as never,
      harnessAuthenticationCoordinator: {} as never,
      realtime: testRealtime(),
      runnerAuthenticator: {} as never,
      runners: {} as never,
      securityEffects: {} as never,
      store: {} as never,
      workspaces: {} as never,
    } satisfies HostServerTestOverrides);
    try {
      for (const url of [
        "/v1/auth/deployment-session",
        "/v1/personal-remote-access/account-session",
        "/v1/personal-remote-access/pair",
      ]) {
        const response = await app.inject({ method: "POST", payload: {}, url });
        expect(response.statusCode, url).toBe(404);
      }
    } finally {
      await app.close();
    }
  });
});

describe("Workspace route projections", () => {
  it("does not expose internal storage authority when retrying storage", async () => {
    const ownerId = createId("user");
    const workspace = portableFsWorkspace(ownerId, {
      name: "Research",
      volumeId: "workspace-retry-projection",
    });
    const retry = vi.fn(async () => workspace);
    const app = await createHostServer({
      requestResponseVault: {} as never,
      agentControl: {} as never,
      agentTools: {} as never,
      authenticator: { authenticateUser: async () => ownerId } as never,
      browser: {} as never,
      commands: {} as never,
      credentials: {} as never,
      discovery: testDiscovery,
      egress: {} as never,
      files: {} as never,
      harnessAuthenticationCoordinator: {} as never,
      realtime: testRealtime(),
      runnerAuthenticator: {} as never,
      runners: {} as never,
      securityEffects: {} as never,
      store: {} as never,
      workspaces: { retry } as never,
    } satisfies HostServerTestOverrides);
    try {
      const response = await injectRpcRequest(app, "commands.dispatch", {
        idempotencyKey: "workspace-storage-retry",
        type: "workspace.storage.retry",
        workspaceId: workspace.id,
      });
      expect(response.statusCode).toBe(200);
      const payload = rpcData(response) as { workspace: Record<string, unknown> };
      expect(payload.workspace).toMatchObject({
        capacity: { kind: "managed-quota" },
        id: workspace.id,
        location: { kind: "shared-storage" },
      });
      expect(payload.workspace).not.toHaveProperty("backing");
      expect(payload.workspace).not.toHaveProperty("capacityPolicy");
      expect(payload.workspace).not.toHaveProperty("createdBy");
      expect(retry).toHaveBeenCalledWith(workspace.id, ownerId);
    } finally {
      await app.close();
    }
  });
});

describe("Personal sharing boundary", () => {
  it("declares sharing unavailable and rejects issue, exchange, and acceptance", async () => {
    const ownerId = createId("user");
    const workspace = portableFsWorkspace(ownerId, {
      name: "Private",
      volumeId: "workspace-personal-private",
    });
    const createWorkspaceInvitation = vi.fn();
    const exchangeInvitation = vi.fn();
    const acceptInvitation = vi.fn();
    const session = {
      absoluteExpiresAt: "2026-09-12T00:00:00.000Z",
      createdAt: "2026-08-12T00:00:00.000Z",
      expiresAt: "2026-08-13T00:00:00.000Z",
      id: "ses_00000000-0000-4000-8000-000000000001",
      user: {
        disabledAt: null,
        displayName: "You",
        email: "owner@example.com",
        emailVerified: true,
        id: ownerId,
        image: null,
        instanceRole: "administrator",
      },
    } as const;
    const personalDiscovery = signHostDiscovery(testDiscoveryKeys, {
      ...testDiscovery.document,
      deploymentShape: {
        defaultWorkspaceBacking: "local-directory",
        kind: "personal" as const,
      },
    });
    const app = await createHostServer({
      requestResponseVault: {} as never,
      agentControl: {} as never,
      agentTools: {} as never,
      authenticator: {
        authenticateUser: async () => ownerId,
        authenticateSession: async () => session,
        identity: {
          acceptInvitation,
          configuration: async () => ({
            deployment: { cloud: false, kind: "personal" as const, name: "This computer" },
            emailDeliveryAvailable: false,
            exposure: "loopback",
            localPasswordEnabled: false,
            machineOwner: true,
            oidcProviders: [],
            passkeysEnabled: false,
            portalOrigin: null,
            publicOrigin: "https://opensteer.example",
            setupState: "complete",
            signupPolicy: "invite-only",
          }),
          createWorkspaceInvitation,
          exchangeInvitation,
          nativeOpenIdConfiguration: () => undefined,
        },
        publicOrigin: new URL("https://opensteer.example"),
        requireExactOrigin: () => undefined,
      } as never,
      browser: {
        latestPlaces: async () => [],
        bootstrap: async () => ({
          profileGrants: [],
          available: false,
          placements: [],
          profiles: [],
          sessions: [],
        }),
      } as never,
      commands: {} as never,
      credentials: {} as never,
      discovery: personalDiscovery,
      egress: {} as never,
      files: {} as never,
      harnessAuthenticationCoordinator: {} as never,
      realtime: testRealtime(),
      runnerAuthenticator: {} as never,
      runners: { identityForEnvironment: () => undefined } as never,
      securityEffects: {} as never,
      store: {
        getExecutionPreferences: async () => emptyExecutionPreferences,
        notificationState: {
          listWorkspacePreferences: async () => [
            { workspaceId: workspace.id, muted: false, revision: "0" },
          ],
        },
        getWorkspaceForOwner: async () => workspace,
        listEnvironmentsForUser: async () => [],
        listHarnessCatalogs: async () => [],
        listHarnessInstances: async () => [],
        workspacePageForOwner: async () => ({
          notificationPreferences: [],
          window: {
            byteCount: 2,
            hasMore: false,
            itemCount: 1,
            nextBefore: null,
            totalItems: 1,
          },
          workspaces: [],
        }),
      } as never,
      workspaces: { ensureMainWorkspace: async () => workspace } as never,
    } satisfies HostServerTestOverrides);
    try {
      const bootstrap = await injectRpcRequest(app, "bootstrap.get", {});
      expect(bootstrap.statusCode).toBe(200);
      expect(rpcData(bootstrap)).toMatchObject({ workspaceSharingAvailable: false });

      const issued = await injectRpcRequest(app, "commands.dispatch", {
        idempotencyKey: "personal-share-attempt",
        role: "collaborator",
        type: "workspace.invitation.create",
        workspaceId: workspace.id,
      });
      expect(issued.statusCode).toBe(403);
      expect(issued.json()).toMatchObject({
        error: {
          code: "forbidden",
          message: "Workspace sharing is unavailable for this Deployment",
        },
      });

      const exchanged = await injectRpcRequest(app, "auth.invitation.exchange", {
        selector: "a".repeat(24),
        verifier: "b".repeat(32),
      });
      expect(exchanged.statusCode).toBe(403);

      const accepted = await injectRpcRequest(app, "auth.invitation.accept", {});
      expect(accepted.statusCode).toBe(403);
      expect(createWorkspaceInvitation).not.toHaveBeenCalled();
      expect(exchangeInvitation).not.toHaveBeenCalled();
      expect(acceptInvitation).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("Workspace invitation issuance", () => {
  function invitationServer() {
    const ownerId = createId("user");
    const workspace = specializedWorkspace(ownerId);
    const createWorkspaceInvitation = vi.fn(
      async (input: { readonly intendedEmail?: string; readonly type: "email" | "link" }) => ({
        invitation: {
          acceptedAt: null,
          acceptedBy: null,
          createdAt: new Date("2026-08-30T00:00:00.000Z"),
          createdBy: ownerId,
          expiresAt: new Date("2026-09-06T00:00:00.000Z"),
          id: createId("workspaceInvitation"),
          intendedEmail: input.intendedEmail ?? null,
          revokedAt: null,
          role: "collaborator" as const,
          selector: "s".repeat(24),
          type: input.type,
          workspaceId: workspace.id,
        },
        verifier: "v".repeat(32),
      }),
    );
    return {
      createWorkspaceInvitation,
      server: createHostServer({
        authenticator: {
          authenticateSession: async () => testAuthenticatedSession(ownerId),
          identity: { createWorkspaceInvitation, nativeOpenIdConfiguration: () => undefined },
          publicOrigin: "https://opensteer.example",
        } as never,
        discovery: testDiscovery,
        store: { getWorkspaceForOwner: async () => workspace } as never,
      } satisfies HostServerTestOverrides),
      workspace,
    };
  }

  it("refuses an invitation whose kind and address disagree", async () => {
    for (const command of [
      { invitationType: "email" as const },
      { intendedEmail: "teammate@example.com" },
      { lifetimeSeconds: 60 },
    ]) {
      const fixture = invitationServer();
      const app = await fixture.server;
      try {
        const refused = await injectRpcRequest(app, "commands.dispatch", {
          idempotencyKey: "invite-mismatch",
          role: "collaborator",
          type: "workspace.invitation.create",
          workspaceId: fixture.workspace.id,
          ...command,
        });
        expect(refused.statusCode).toBe(400);
        expect(refused.json()).toMatchObject({ error: { code: "bad_request" }, ok: false });
        expect(fixture.createWorkspaceInvitation).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  });
});

describe("thread event history route", () => {
  it("serves the durable event page and 404s when the Thread is not accessible", async () => {
    const ownerId = createId("user");
    const threadId = createId("thread");
    const page = {
      events: [],
      threadId,
      window: {
        byteCount: 2,
        hasMore: false,
        itemCount: 0,
        nextBefore: null,
        threadId,
        totalItems: 0,
      },
    };
    let result: typeof page | null = page;
    const threadEventPageForOwner = vi.fn(async () => result);
    const app = await createHostServer({
      requestResponseVault: {} as never,
      agentControl: {} as never,
      agentTools: {} as never,
      authenticator: { authenticateUser: async () => ownerId } as never,
      browser: {} as never,
      commands: {} as never,
      credentials: {} as never,
      discovery: testDiscovery,
      egress: {} as never,
      files: {} as never,
      harnessAuthenticationCoordinator: {} as never,
      realtime: testRealtime(),
      runnerAuthenticator: {} as never,
      runners: {} as never,
      securityEffects: {} as never,
      store: { threadEventPageForOwner } as never,
      workspaces: {} as never,
    } satisfies HostServerTestOverrides);
    try {
      const ok = await injectRpcRequest(app, "thread.events.list", {
        before: "17",
        limit: 100,
        threadId,
      });
      expect(ok.statusCode).toBe(200);
      expect(rpcData(ok)).toEqual(page);
      expect(threadEventPageForOwner).toHaveBeenCalledWith({
        before: "17",
        maxItems: 100,
        ownerId,
        threadId,
      });

      const bare = await injectRpcRequest(app, "thread.events.list", { threadId });
      expect(bare.statusCode).toBe(200);
      expect(threadEventPageForOwner).toHaveBeenLastCalledWith({
        maxItems: 200,
        ownerId,
        threadId,
      });

      const invalidCursor = await injectRpcRequest(app, "thread.events.list", {
        before: "not a cursor",
        threadId,
      });
      expect(invalidCursor.statusCode).toBe(400);

      result = null;
      const missing = await injectRpcRequest(app, "thread.events.list", { threadId });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ error: { code: "not_found" } });
    } finally {
      await app.close();
    }
  });
});

describe("Thread input command boundary", () => {
  const identity = {
    configuration: async () => ({ deployment: { kind: "hosted", name: "Test" } }),
    nativeOpenIdConfiguration: () => undefined,
  };
  const ownerId = createId("user");
  const threadId = createId("thread");
  const workspaceId = createId("workspace");
  const environmentId = createId("environment");
  const now = "2026-09-15T09:00:00.000Z";

  const thread = {
    accessMode: "full-access" as const,
    capabilityProfileId: "main" as const,
    continuationIdentity: null,
    createdAt: now,
    createdBy: ownerId,
    environmentId,
    harnessInstanceId: createId("harnessInstance"),
    id: threadId,
    inputQueuePaused: false,
    lineageRootThreadId: threadId,
    modelSelection: { modelId: "gpt-5.6-sol", options: {}, providerId: "openai" },
    listed: true,
    parentThreadId: null,
    pendingRequests: 0,
    status: "idle" as const,
    title: "Boundary",
    updatedAt: now,
    workspaceId,
  };

  function messageResult(policy: "queue" | "steer") {
    const messageId = createId("message");
    return {
      command: null,
      disposition: policy === "steer" ? ("steering" as const) : ("pending" as const),
      events: [],
      input: {
        assignmentId: null,
        cancelReason: null,
        causalChainId: createId("causalChain"),
        createdAt: now,
        deliveredAt: null,
        messageId,
        policy,
        replyTarget: null,
        runId: null,
        state: "pending" as const,
        threadId,
        updatedAt: now,
      },
      message: {
        author: {
          displayName: "Owner",
          kind: "human" as const,
          principalId: "pri_00000000-0000-4000-8000-000000000099",
          userId: ownerId,
        },
        content: [{ text: "hello", type: "text" as const }],
        createdAt: now,
        id: messageId,
        kind: "input" as const,
        runId: null,
        sequence: "1",
        threadId,
      },
      run: null,
      wasDuplicate: false,
    };
  }

  async function boundaryServer(commands: Record<string, unknown>) {
    return createHostServer({
      authenticator: {
        authenticateSession: async () => testAuthenticatedSession(ownerId),
        identity,
      } as never,
      commands: commands as never,
      discovery: testDiscovery,
    });
  }

  it("defaults human messages to queue and forwards explicit steer", async () => {
    const enqueueThreadInput = vi.fn(async (input: { readonly policy: "queue" | "steer" }) =>
      messageResult(input.policy),
    );
    const app = await boundaryServer({ enqueueThreadInput });
    try {
      const queued = await injectRpcRequest(app, "commands.dispatch", {
        content: [{ text: "hello", type: "text" }],
        idempotencyKey: "human-default-queue",
        threadId,
        type: "thread.sendMessage",
      });
      const steered = await injectRpcRequest(app, "commands.dispatch", {
        content: [{ text: "hello", type: "text" }],
        delivery: "steer",
        idempotencyKey: "human-explicit-steer",
        threadId,
        type: "thread.sendMessage",
      });

      expect(queued.statusCode, queued.body).toBe(200);
      expect(steered.statusCode, steered.body).toBe(200);
      expect(enqueueThreadInput).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ policy: "queue", requestedBy: ownerId }),
      );
      expect(enqueueThreadInput).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ policy: "steer", requestedBy: ownerId }),
      );
    } finally {
      await app.close();
    }
  });

  it("rejects human report delivery at the protocol boundary", async () => {
    const enqueueThreadInput = vi.fn();
    const app = await boundaryServer({ enqueueThreadInput });
    try {
      const response = await app.inject({
        headers: { [hostApiVersionHeader]: String(hostApiVersion) },
        method: "POST",
        payload: {
          content: [{ text: "hello", type: "text" }],
          delivery: "report",
          idempotencyKey: "human-report-refused",
          threadId,
          type: "thread.sendMessage",
        },
        url: "/v1/rpc/commands.dispatch",
      });

      expect(response.statusCode).toBe(400);
      expect(enqueueThreadInput).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("reads the authoritative queue with owner identity", async () => {
    const getThreadForOwner = vi.fn(async () => thread);
    const getThreadInputQueue = vi.fn(async (input: { readonly threadId: typeof threadId }) => ({
      items: [],
      paused: false,
      steerRunId: null,
      threadId: input.threadId,
    }));
    const app = await createHostServer({
      authenticator: {
        authenticateSession: async () => testAuthenticatedSession(ownerId),
        identity,
      } as never,
      commands: {} as never,
      discovery: testDiscovery,
      store: { getThreadForOwner, getThreadInputQueue } as never,
    });
    try {
      const response = await injectRpcRequest(app, "thread.inputQueue.get", { threadId });
      expect(response.statusCode, response.body).toBe(200);
      expect(rpcData(response)).toEqual({
        items: [],
        paused: false,
        steerRunId: null,
        threadId,
      });
      expect(getThreadForOwner).toHaveBeenCalledWith(threadId, ownerId);
      expect(getThreadInputQueue).toHaveBeenCalledWith({ requestedBy: ownerId, threadId });
    } finally {
      await app.close();
    }
  });

  it("requires a session before reading a queue", async () => {
    const getThreadForOwner = vi.fn();
    const app = await createHostServer({
      authenticator: {
        authenticateSession: async () => {
          throw new OpensteerError({ code: "unauthorized", message: "Authentication required" });
        },
        identity,
      } as never,
      commands: {} as never,
      discovery: testDiscovery,
      store: { getThreadForOwner } as never,
    });
    try {
      const response = await injectRpcRequest(app, "thread.inputQueue.get", { threadId });
      expect(response.statusCode).toBe(401);
      expect(getThreadForOwner).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("durable harness catalogs", () => {
  const ownerId = createId("user");
  const environmentId = createId("environment");
  const harnessInstanceId = createId("harnessInstance");
  const threadId = createId("thread");
  const modelSelection = { modelId: "gpt-5.6-sol", options: {}, providerId: "openai" };
  const readyCatalog = HarnessInstanceCatalogSchema.parse({
    continuationIdentity: {
      continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
      driverKind: "native",
    },
    driverKind: "native",
    harnessInstanceId,
    models: [
      {
        displayName: "GPT-5.6 Sol",
        isDefault: true,
        modelId: "gpt-5.6-sol",
        options: [],
        providerId: "openai",
      },
    ],
    status: "ready",
    steering: false,
  });
  // A compatible endpoint spells the same model its own way and answers to
  // nothing else.
  const gatewayCatalog = HarnessInstanceCatalogSchema.parse({
    continuationIdentity: {
      continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
      driverKind: "native",
    },
    driverKind: "native",
    harnessInstanceId,
    models: [
      {
        displayName: "GPT 5.6 Sol",
        isDefault: true,
        modelId: "gpt-5.6-sol",
        nativeModelId: "openai/gpt-5.6-sol",
        options: [],
        providerId: "openai",
      },
    ],
    status: "ready",
    steering: false,
  });
  const authenticationRequiredCatalog = HarnessInstanceCatalogSchema.parse({
    connections: [
      {
        connectionSlot: "primary",
        label: "Opensteer",
        status: "authentication-required",
      },
    ],
    detail: "Sign in to Opensteer on this Runner",
    driverKind: "native",
    harnessInstanceId,
    models: [],
    setupMethods: [
      {
        connectionSlot: "primary",
        kind: "device-code",
        label: "Subscription",
        methodId: "subscription",
      },
    ],
    status: "authentication-required",
  });

  function harnessCatalogServer(options: {
    /** A non-terminal Run still bound to this profile. */
    readonly activeRun?: boolean;
    readonly authenticationState?: (
      action: "cancel" | "logout" | "read" | "remove" | "start",
    ) => HarnessAuthenticationState;
    /** What the engine on this work location says it can enforce. Defaults to all four. */
    readonly accessModes?: readonly ThreadAccessMode[];
    readonly catalog?: HarnessInstanceCatalog;
    readonly connected: boolean;
    readonly environmentKind: "main" | "local" | "managed";
    readonly inspectHarnesses?: () => Promise<readonly unknown[]>;
    readonly reconcileHarnesses?: () => Promise<readonly HarnessInstanceCatalog[]>;
    readonly harnessDrivers?: readonly {
      readonly accessModes: readonly ThreadAccessMode[];
      readonly driverKind: string;
      readonly readiness: "configured";
      readonly sources: readonly {
        readonly fields: readonly {
          readonly id: string;
          readonly kind: "text" | "url";
          readonly label: string;
        }[];
        readonly kind: "first-party" | "compatible-endpoint" | "cloud-identity" | "gateway";
        readonly label: string;
        readonly quota: "none" | "windows";
        readonly sourceId: string;
        readonly stateKinds: readonly ("ambient" | "isolated")[];
      }[];
    }[];
    /** Defaults to the Deployment administrator the older cases assume. */
    readonly instanceRole?: "administrator" | "user";
    /** A managed Runner outside this person's listing is not disclosed. */
    readonly visibleToUser?: boolean;
    /** Who the work location's Runner is bound to. Absent is an unbound managed
     * Runner — what a self-hosted Deployment's administrator enrolls. */
    readonly runnerOwner?: UserId;
    /** An existing-CLI profile belongs to the machine; a private one does not. */
    readonly stateKind?: "ambient" | "isolated";
  }) {
    const workspace = portableFsWorkspace(ownerId, { volumeId: "workspace-catalog" });
    const runnerId = createId("runner");
    const environment = {
      capabilities: [],
      id: environmentId,
      kind: options.environmentKind,
      name: "Work location",
      runnerId,
    };
    const harness = {
      config: {},
      driverKind: "native",
      enabled: true,
      environmentId,
      id: harnessInstanceId,
      isDefault: true,
      name: "Opensteer",
      runtimeRevision: 1,
      sourceId: "native",
      stateKind: options.stateKind ?? ("isolated" as const),
    };
    const createThread = vi.fn(async (input: { readonly modelSelection: unknown }) => ({
      thread: {
        accessMode: "full-access" as const,
        capabilityProfileId: "main",
        continuationIdentity: null,
        createdAt: "2026-09-15T09:00:00.000Z",
        createdBy: ownerId,
        environmentId,
        harnessInstanceId,
        id: createId("thread"),
        lineageRootThreadId: createId("thread"),
        modelSelection: input.modelSelection,
        listed: true,
        parentThreadId: null,
        pendingRequests: 0,
        inputQueuePaused: false,
        role: "work" as const,
        status: "idle" as const,
        title: "Created",
        updatedAt: "2026-09-15T09:00:00.000Z",
        workspaceId: workspace.id,
      },
      asOfSequence: "0",
      wasDuplicate: false,
    }));
    const stored = options.catalog
      ? [
          {
            capturedAt: new Date(),
            catalog: options.catalog,
            environmentId,
            harnessInstanceId,
          },
        ]
      : [];
    // A Runner is never consulted on a request path, so a fake that answers
    // would hide the very dependency these tests exist to forbid.
    const refuseInspection = () => {
      throw new Error("A request path asked a Runner for its harness catalog");
    };
    const inspectHarnesses = vi.fn(options.inspectHarnesses ?? refuseInspection);
    const listHarnessCatalogs = vi.fn(async () => stored);
    const manageHarnessAuthentication = vi.fn(
      async (
        _asked: EnvironmentId,
        request: { readonly action: "cancel" | "logout" | "read" | "remove" | "start" },
      ) => options.authenticationState?.(request.action) ?? { status: "not-started" as const },
    );
    const recordHarnessCatalogs = vi.fn(
      async ({ catalogs }: { readonly catalogs: readonly HarnessInstanceCatalog[] }) => catalogs,
    );
    const reconcileHarnesses = vi.fn(options.reconcileHarnesses ?? (async () => []));
    const runners = {
      canRunHarness: () => options.connected,
      // A Runner that is away has declared nothing, which is not the same as
      // declaring nothing is enforceable.
      harnessAccessModes: () =>
        options.connected ? (options.accessModes ?? ThreadAccessModeSchema.options) : undefined,
      identityForEnvironment: () =>
        options.connected
          ? {
              modules: {
                agents: {
                  harnessDrivers: options.harnessDrivers ?? [],
                  providerStateModes: ["ambient", "isolated"],
                },
              },
            }
          : undefined,
      inspectHarnesses,
      isAvailable: () => options.connected,
      manageHarnessAuthentication,
      reconcileHarnesses,
    };
    const discardHarnessCatalog = vi.fn(async () => undefined);
    const updateThreadExecutionSelection = vi.fn(
      async (input: { readonly harnessInstanceId: string; readonly modelSelection: unknown }) => ({
        asOfSequence: "0",
        thread: {
          accessMode: "full-access" as const,
          capabilityProfileId: "main",
          continuationIdentity: null,
          createdAt: "2026-09-15T09:00:00.000Z",
          createdBy: ownerId,
          environmentId,
          harnessInstanceId: input.harnessInstanceId,
          id: threadId,
          lineageRootThreadId: threadId,
          modelSelection: input.modelSelection,
          listed: true,
          parentThreadId: null,
          pendingRequests: 0,
          inputQueuePaused: false,
          status: "idle" as const,
          title: "Moved",
          updatedAt: "2026-09-15T09:00:00.000Z",
          workspaceId: workspace.id,
        },
      }),
    );
    // The Host owns one execution-preference record per person, so the fake
    // holds it the same way: what a remember writes is what the next bootstrap
    // reads back.
    let executionPreferences: ExecutionPreferences = emptyExecutionPreferences;
    const rememberChoice = vi.fn(async (_userId: UserId, choice: ExecutionChoice) => {
      executionPreferences = rememberExecutionChoice(executionPreferences, choice);
      return executionPreferences;
    });
    const removeHarnessInstance = vi.fn(async () => ({ ...harness, enabled: false }));
    const updateHarnessInstance = vi.fn(
      async (input: { readonly enabled?: boolean; readonly name?: string }) => {
        // The store settles the idle check and the write in one transaction, so
        // a busy profile refuses the disable from in there. The route's own job
        // is to carry that conflict out and reconcile nothing.
        if (input.enabled === false && (options.activeRun ?? false)) {
          throw new OpensteerError({
            code: "conflict",
            message:
              "This AI engine is still running work; wait for it to finish before turning it off",
            retryable: true,
          });
        }
        return {
          ...harness,
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          ...(input.name === undefined ? {} : { name: input.name }),
        };
      },
    );
    const store = {
      createHarnessInstance: vi.fn(async () => harness),
      discardHarnessCatalog,
      // The enrollment creator is the person a user-owned Runner belongs to;
      // a Deployment-owned Runner names nobody.
      environmentRunnerOwner: async () => options.runnerOwner ?? null,
      findThreadCreationByIdempotency: async () => null,
      getEnvironment: async () => environment,
      getExecutionPreferences: async () => executionPreferences,
      hasActiveRunForHarness: async () => options.activeRun ?? false,
      getHarnessCatalog: async () => options.catalog ?? null,
      getHarnessInstance: async () => harness,
      getThreadForOwner: async () => ({
        accessMode: "full-access" as const,
        environmentId,
        harnessInstanceId,
        id: threadId,
      }),
      getWorkspaceForOwner: async () => workspace,
      notificationState: {
        listWorkspacePreferences: async () => [
          { workspaceId: workspace.id, muted: false, revision: "0" },
        ],
      },
      listEnvironmentsForUser: async () => (options.visibleToUser === false ? [] : [environment]),
      listHarnessCatalogs,
      listHarnessInstances: async () => [harness],
      // Ownership lives on the Runner row, and the inventory listing is where
      // the Host reads it.
      listRunners: async () => ({
        nextCursor: null,
        runners: [
          {
            environmentIds: [environmentId],
            id: runnerId,
            moduleDescriptors: {},
            ownerUserId: options.runnerOwner ?? null,
          },
        ],
      }),
      recordHarnessCatalogs,
      rememberExecutionChoice: rememberChoice,
      removeHarnessInstance,
      updateHarnessInstance,
      updateThreadExecutionSelection,
      workspacePageForOwner: async () => ({
        notificationPreferences: [],
        window: { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 },
        workspaces: [],
      }),
    };
    const authenticateSession = vi.fn(
      async () =>
        ({
          absoluteExpiresAt: "2026-09-12T00:00:00.000Z",
          createdAt: "2026-08-12T00:00:00.000Z",
          expiresAt: "2026-08-13T00:00:00.000Z",
          id: "ses_00000000-0000-4000-8000-000000000001",
          user: {
            disabledAt: null,
            displayName: "Owner",
            email: "owner@example.com",
            emailVerified: true,
            id: ownerId,
            image: null,
            instanceRole: options.instanceRole ?? "administrator",
          },
        }) as const,
    );
    const updateThreadAccessMode = vi.fn(
      async (input: { readonly accessMode: ThreadAccessMode }) => ({
        asOfSequence: "0",
        thread: {
          accessMode: input.accessMode,
          capabilityProfileId: "main",
          continuationIdentity: null,
          createdAt: "2026-09-15T09:00:00.000Z",
          createdBy: ownerId,
          environmentId,
          harnessInstanceId,
          id: threadId,
          lineageRootThreadId: threadId,
          modelSelection,
          listed: true,
          parentThreadId: null,
          pendingRequests: 0,
          inputQueuePaused: false,
          role: "work" as const,
          status: "idle" as const,
          title: "Access",
          updatedAt: "2026-09-15T09:00:00.000Z",
          workspaceId: workspace.id,
        },
      }),
    );
    return {
      authenticateSession,
      createHarnessInstance: store.createHarnessInstance,
      createThread,
      rememberExecutionChoice: rememberChoice,
      updateThreadAccessMode,
      updateThreadExecutionSelection,
      discardHarnessCatalog,
      inspectHarnesses,
      listHarnessCatalogs,
      manageHarnessAuthentication,
      reconcileHarnesses,
      removeHarnessInstance,
      recordHarnessCatalogs,
      updateHarnessInstance,
      server: createHostServer({
        requestResponseVault: {} as never,
        agentControl: {} as never,
        agentTools: {} as never,
        authenticator: {
          authenticateSession,
          authenticateUser: async () => ownerId,
          identity: {
            configuration: async () => ({
              deployment: { cloud: false, kind: "self-hosted", name: null },
              emailDeliveryAvailable: false,
              exposure: "networked",
              localPasswordEnabled: true,
              machineOwner: false,
              oidcProviders: [],
              passkeysEnabled: false,
              portalOrigin: null,
              publicOrigin: "https://opensteer.example",
              setupState: "complete",
              signupPolicy: "invite-only",
            }),
            nativeOpenIdConfiguration: () => undefined,
          },
          publicOrigin: new URL("https://opensteer.example"),
          requireExactOrigin: () => undefined,
        } as never,
        browser: {
          latestPlaces: async () => [],
          bootstrap: async () => ({
            available: false,
            placements: [],
            profileGrants: [],
            profiles: [],
            sessions: [],
          }),
        } as never,
        commands: { createThread, updateThreadAccessMode } as never,
        credentials: {} as never,
        discovery: testDiscovery,
        egress: {} as never,
        files: {} as never,
        harnessAuthenticationCoordinator: new HarnessAuthenticationCoordinator({
          harnesses: store as never,
          runners: runners as never,
        }),
        realtime: testRealtime(),
        runnerAuthenticator: {} as never,
        runners: runners as never,
        securityEffects: {} as never,
        store: store as never,
        workspaces: { ensureMainWorkspace: async () => workspace } as never,
      } satisfies HostServerTestOverrides),
      workspace,
    };
  }

  it("explicitly refreshes only the requested account and records its revision", async () => {
    const fixture = harnessCatalogServer({
      catalog: readyCatalog,
      connected: true,
      environmentKind: "managed",
      inspectHarnesses: async () => [gatewayCatalog],
    });
    const app = await fixture.server;
    try {
      const response = await injectRpcRequest(app, "harness.catalog.refresh", {
        environmentId,
        harnessInstanceId,
      });
      expect(response.statusCode).toBe(200);
      expect(fixture.inspectHarnesses).toHaveBeenCalledTimes(1);
      expect(fixture.inspectHarnesses).toHaveBeenCalledWith(
        environmentId,
        [expect.objectContaining({ id: harnessInstanceId, runtimeRevision: 1 })],
        expect.any(AbortSignal),
        { fresh: true },
      );
      expect(fixture.recordHarnessCatalogs).toHaveBeenCalledWith({
        catalogs: [gatewayCatalog],
        environmentId,
        expectedRevisions: new Map([[harnessInstanceId, 1]]),
      });
      expect(fixture.reconcileHarnesses).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    {
      connected: false,
      instanceRole: "administrator" as const,
      visibleToUser: true,
      expected: 409,
    },
    { connected: true, instanceRole: "user" as const, visibleToUser: true, expected: 403 },
    {
      connected: true,
      instanceRole: "administrator" as const,
      visibleToUser: false,
      expected: 404,
    },
  ])("refuses unauthorized or offline catalog refresh ($expected)", async (scenario) => {
    const fixture = harnessCatalogServer({
      ...scenario,
      catalog: readyCatalog,
      environmentKind: "managed",
    });
    const app = await fixture.server;
    try {
      const response = await injectRpcRequest(app, "harness.catalog.refresh", {
        environmentId,
        harnessInstanceId,
      });
      expect(response.statusCode).toBe(scenario.expected);
      expect(fixture.inspectHarnesses).not.toHaveBeenCalled();
      expect(fixture.recordHarnessCatalogs).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("reports a refresh transport failure instead of claiming the old catalog was refreshed", async () => {
    const fixture = harnessCatalogServer({
      catalog: readyCatalog,
      connected: true,
      environmentKind: "managed",
      inspectHarnesses: async () => {
        throw new Error("Runner stopped");
      },
    });
    const app = await fixture.server;
    try {
      const response = await injectRpcRequest(app, "harness.catalog.refresh", {
        environmentId,
        harnessInstanceId,
      });
      expect(response.statusCode).toBe(500);
      expect(fixture.recordHarnessCatalogs).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("refuses a Thread the engine cannot be held to, naming the engine and the mode", async () => {
    const { createThread, server } = harnessCatalogServer({
      accessModes: ["approval-required", "full-access"],
      catalog: readyCatalog,
      connected: true,
      environmentKind: "managed",
    });
    const app = await server;
    try {
      const refused = await injectRpcRequest(app, "commands.dispatch", {
        accessMode: "auto",
        environmentId,
        harnessInstanceId,
        idempotencyKey: "mode-the-engine-refuses",
        modelSelection,
        title: "Auto on an engine that cannot",
        type: "thread.create",
        workspaceId: createId("workspace"),
      });

      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({
        error: { message: "Native cannot enforce the auto access mode" },
      });
      expect(createThread).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("admits a mode the engine advertises", async () => {
    const { createThread, server } = harnessCatalogServer({
      accessModes: ["approval-required", "full-access"],
      catalog: readyCatalog,
      connected: true,
      environmentKind: "managed",
    });
    const app = await server;
    try {
      const created = await injectRpcRequest(app, "commands.dispatch", {
        accessMode: "approval-required",
        environmentId,
        harnessInstanceId,
        idempotencyKey: "mode-the-engine-enforces",
        modelSelection,
        title: "Supervised",
        type: "thread.create",
        workspaceId: createId("workspace"),
      });

      expect(created.statusCode).toBe(200);
      expect(createThread).toHaveBeenCalledWith(
        expect.objectContaining({ accessMode: "approval-required" }),
      );
    } finally {
      await app.close();
    }
  });

  it("refuses moving an existing Thread to a mode its engine cannot enforce", async () => {
    const { server, updateThreadAccessMode } = harnessCatalogServer({
      accessModes: ["approval-required", "full-access"],
      catalog: readyCatalog,
      connected: true,
      environmentKind: "managed",
    });
    const app = await server;
    try {
      const refused = await injectRpcRequest(app, "commands.dispatch", {
        accessMode: "auto-accept-edits",
        idempotencyKey: "access-update-refused",
        threadId,
        type: "thread.access.update",
      });

      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({
        error: { message: "Native cannot enforce the auto-accept-edits access mode" },
      });
      expect(updateThreadAccessMode).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("refuses moving a Thread onto an engine that cannot enforce its access mode", async () => {
    // The Thread keeps its mode across an engine change, so the engine it
    // lands on is held to the same declaration a new Thread would be.
    const { server, updateThreadExecutionSelection } = harnessCatalogServer({
      accessModes: ["approval-required"],
      catalog: readyCatalog,
      connected: true,
      environmentKind: "managed",
    });
    const app = await server;
    try {
      const refused = await injectRpcRequest(app, "commands.dispatch", {
        harnessInstanceId,
        idempotencyKey: "execution-update-refused",
        modelSelection: { modelId: "gpt-5.6-sol", options: {}, providerId: "openai" },
        threadId,
        type: "thread.execution.update",
      });

      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({
        error: { message: "Native cannot enforce the full-access access mode" },
      });
      expect(updateThreadExecutionSelection).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("leaves an access-mode change alone while the work location is away", async () => {
    // Silence is not a declaration: an engine that has not advertised its modes
    // refuses none of them, and a Thread nobody can run is already blocked.
    const { server, updateThreadAccessMode } = harnessCatalogServer({
      catalog: readyCatalog,
      connected: false,
      environmentKind: "managed",
    });
    const app = await server;
    try {
      const applied = await injectRpcRequest(app, "commands.dispatch", {
        accessMode: "auto",
        idempotencyKey: "access-update-while-away",
        threadId,
        type: "thread.access.update",
      });

      expect(applied.statusCode).toBe(200);
      expect(updateThreadAccessMode).toHaveBeenCalledWith(
        expect.objectContaining({ accessMode: "auto" }),
      );
    } finally {
      await app.close();
    }
  });

  it("refuses a disconnected managed work location despite its durable catalog", async () => {
    const { createThread, server } = harnessCatalogServer({
      catalog: readyCatalog,
      connected: false,
      environmentKind: "managed",
    });
    const app = await server;
    try {
      const created = await injectRpcRequest(app, "commands.dispatch", {
        environmentId,
        harnessInstanceId,
        idempotencyKey: "managed-while-disconnected",
        modelSelection,
        title: "Disconnected Runner",
        type: "thread.create",
        workspaceId: createId("workspace"),
      });
      expect(created.statusCode).toBe(409);
      expect(createThread).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("refuses a managed work location that has never reported a catalog", async () => {
    const { createThread, server } = harnessCatalogServer({
      connected: false,
      environmentKind: "managed",
    });
    const app = await server;
    try {
      const refused = await injectRpcRequest(app, "commands.dispatch", {
        environmentId,
        harnessInstanceId,
        idempotencyKey: "managed-never-seen",
        modelSelection,
        title: "Never seen",
        type: "thread.create",
        workspaceId: createId("workspace"),
      });
      expect(refused.statusCode).toBe(409);
      expect(createThread).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("keeps a self-hosted work location closed while its Runner is away", async () => {
    const { createThread, server } = harnessCatalogServer({
      catalog: readyCatalog,
      connected: false,
      environmentKind: "local",
    });
    const app = await server;
    try {
      const refused = await injectRpcRequest(app, "commands.dispatch", {
        environmentId,
        harnessInstanceId,
        idempotencyKey: "self-host-while-away",
        modelSelection,
        title: "Laptop is closed",
        type: "thread.create",
        workspaceId: createId("workspace"),
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: { retryable: true } });
      expect(createThread).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("serves bootstrap catalogs from the store without asking a Runner", async () => {
    const { listHarnessCatalogs, server } = harnessCatalogServer({
      catalog: readyCatalog,
      connected: false,
      environmentKind: "managed",
    });
    const app = await server;
    try {
      const bootstrap = await injectRpcRequest(app, "bootstrap.get", {});
      expect(bootstrap.statusCode).toBe(200);
      expect(rpcData(bootstrap)).toMatchObject({
        environments: [
          {
            connected: false,
            harnessCatalogs: [{ harnessInstanceId, status: "ready" }],
            id: environmentId,
          },
        ],
      });
      expect(listHarnessCatalogs).toHaveBeenCalledWith([environmentId]);
    } finally {
      await app.close();
    }
  });

  it("keeps a self-hosted work location's status two-valued", async () => {
    // No lifecycle service exists on a self-hosted Host, so an away Runner is
    // exactly what it looks like: disconnected.
    const away = await harnessCatalogServer({
      catalog: readyCatalog,
      connected: false,
      environmentKind: "local",
    }).server;
    try {
      expect(rpcData(await injectRpcRequest(away, "bootstrap.get", {}))).toMatchObject({
        environments: [{ connected: false, status: "disconnected" }],
      });
    } finally {
      await away.close();
    }

    // A managed work location on a self-hosted Deployment is read the same way.
    const unmanaged = await harnessCatalogServer({
      catalog: readyCatalog,
      connected: false,
      environmentKind: "managed",
    }).server;
    try {
      expect(rpcData(await injectRpcRequest(unmanaged, "bootstrap.get", {}))).toMatchObject({
        environments: [{ connected: false, status: "disconnected" }],
      });
    } finally {
      await unmanaged.close();
    }
  });

  it("keeps all auth routes safe on a lifecycle-less managed Host", async () => {
    const fixture = harnessCatalogServer({
      catalog: authenticationRequiredCatalog,
      connected: false,
      environmentKind: "managed",
    });
    const app = await fixture.server;
    try {
      for (const method of ["POST", "GET", "DELETE"] as const) {
        const response = await injectHarnessAuthentication(
          app,
          method,
          environmentId,
          harnessInstanceId,
        );
        expect(response.statusCode).toBe(200);
        expect(rpcData(response)).toMatchObject({
          authentication: { status: "not-started" },
          environmentStatus: "disconnected",
        });
      }
      expect(fixture.manageHarnessAuthentication).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  /** A profile the driver reports as signed in and willing to sign out. */
  const signedInCatalog = HarnessInstanceCatalogSchema.parse({
    connections: [
      {
        connectionSlot: "primary",
        label: "Opensteer",
        logoutSupported: true,
        status: "connected",
      },
    ],
    continuationIdentity: {
      continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
      driverKind: "native",
    },
    driverKind: "native",
    harnessInstanceId,
    models: [
      {
        displayName: "GPT-5.6 Sol",
        isDefault: true,
        modelId: "gpt-5.6-sol",
        options: [],
        providerId: "openai",
      },
    ],
    status: "ready",
    steering: false,
  });

  it("refuses to turn an AI engine off while it is still running work", async () => {
    const fixture = harnessCatalogServer({
      activeRun: true,
      catalog: readyCatalog,
      connected: true,
      environmentKind: "local",
      runnerOwner: ownerId,
    });
    const app = await fixture.server;
    try {
      const refused = await injectRpcRequest(app, "commands.dispatch", {
        enabled: false,
        environmentId,
        harnessInstanceId,
        idempotencyKey: "disable-harness",
        type: "harness.enabled.set",
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: { code: "conflict", retryable: true } });
      // Nothing may be half-applied: the store's transaction leaves the record
      // untouched, and the Runner never hears a desired set that would close
      // the live adapter.
      expect(fixture.updateHarnessInstance).toHaveBeenCalledTimes(1);
      expect(fixture.reconcileHarnesses).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("turns an idle AI engine off and reconciles the remaining desired set", async () => {
    const fixture = harnessCatalogServer({
      catalog: readyCatalog,
      connected: true,
      environmentKind: "local",
      runnerOwner: ownerId,
    });
    const app = await fixture.server;
    try {
      const patched = await injectRpcRequest(app, "commands.dispatch", {
        enabled: false,
        environmentId,
        harnessInstanceId,
        idempotencyKey: "disable-harness",
        type: "harness.enabled.set",
      });
      expect(patched.statusCode).toBe(200);
      expect(fixture.updateHarnessInstance).toHaveBeenCalledTimes(1);
      expect(fixture.reconcileHarnesses).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("admits an account only against the source its engine declared", async () => {
    const fixture = harnessCatalogServer({
      connected: true,
      environmentKind: "local",
      harnessDrivers: [
        {
          accessModes: [...ThreadAccessModeSchema.options],
          driverKind: "native",
          readiness: "configured",
          sources: [
            {
              fields: [],
              kind: "first-party",
              label: "Native",
              quota: "none",
              sourceId: "native",
              stateKinds: ["ambient", "isolated"],
            },
            {
              fields: [{ id: "baseUrl", kind: "url", label: "Base URL" }],
              kind: "compatible-endpoint",
              label: "Compatible endpoint",
              quota: "none",
              sourceId: "compatible",
              stateKinds: ["isolated"],
            },
          ],
        },
      ],
      runnerOwner: ownerId,
    });
    const app = await fixture.server;
    const create = (
      input: Readonly<Record<string, unknown>>,
    ): ReturnType<typeof injectRpcRequest> =>
      injectRpcRequest(app, "commands.dispatch", {
        driverKind: "native",
        environmentId,
        name: "Account",
        stateKind: "isolated",
        type: "harness.create",
        ...input,
      });
    try {
      // A source nobody declared is not a source, whatever the person typed.
      const unknownSource = await create({
        idempotencyKey: "source-unknown",
        sourceId: "gateway",
      });
      expect(unknownSource.statusCode).toBe(409);
      expect(rpcError(unknownSource).message).toBe(
        "This AI engine does not offer that source here",
      );

      // The declaration also says where an account of it may live.
      const wrongState = await create({
        idempotencyKey: "source-state",
        sourceId: "compatible",
        config: { baseUrl: "https://openrouter.ai/api/v1" },
        stateKind: "ambient",
      });
      expect(wrongState.statusCode).toBe(409);
      expect(rpcError(wrongState).message).toBe(
        "Compatible endpoint accounts only support isolated AI engine state",
      );

      // A declared field is not optional, and a url field has to be reachable.
      const missingField = await create({ idempotencyKey: "source-field", sourceId: "compatible" });
      expect(missingField.statusCode).toBe(400);
      expect(rpcError(missingField).message).toBe("Base URL is required");
      const badUrl = await create({
        config: { baseUrl: "openrouter.ai" },
        idempotencyKey: "source-url",
        sourceId: "compatible",
      });
      expect(badUrl.statusCode).toBe(400);
      expect(rpcError(badUrl).message).toBe("Base URL must be an http:// or https:// address");

      // The parts of a url a driver's request would drop are the parts a secret
      // can be hidden in: neither reaches the endpoint, and the credential
      // would be stored and logged in clear.
      const embeddedCredentials = await create({
        config: { baseUrl: "https://user:pass@host/v1" },
        idempotencyKey: "source-url-credentials",
        sourceId: "compatible",
      });
      expect(embeddedCredentials.statusCode).toBe(400);
      expect(rpcError(embeddedCredentials).message).toBe(
        "Base URL must not carry credentials, a query, or a fragment",
      );
      const fragment = await create({
        config: { baseUrl: "https://host/v1#x" },
        idempotencyKey: "source-url-fragment",
        sourceId: "compatible",
      });
      expect(fragment.statusCode).toBe(400);
      expect(rpcError(fragment).message).toBe(
        "Base URL must not carry credentials, a query, or a fragment",
      );

      // A value the source never asked for would reach the driver as a setting
      // it cannot parse, so it is refused here rather than stored.
      const strayKey = await create({
        config: { baseUrl: "https://openrouter.ai/api/v1", region: "us-east-1" },
        idempotencyKey: "source-stray",
        sourceId: "compatible",
      });
      expect(strayKey.statusCode).toBe(400);
      expect(rpcError(strayKey).message).toBe("Compatible endpoint has no region setting");

      // What survives is the declared record, and the source the row now names.
      const created = await create({
        config: { baseUrl: "  https://openrouter.ai/api/v1  " },
        idempotencyKey: "source-accepted",
        sourceId: "compatible",
      });
      expect(created.statusCode).toBe(200);
      expect(fixture.createHarnessInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          config: { baseUrl: "https://openrouter.ai/api/v1" },
          sourceId: "compatible",
        }),
      );

      // A source with no fields stores nothing at all.
      const firstParty = await create({ idempotencyKey: "source-first-party", sourceId: "native" });
      expect(firstParty.statusCode).toBe(200);
      expect(fixture.createHarnessInstance).toHaveBeenLastCalledWith(
        expect.objectContaining({ config: {}, sourceId: "native" }),
      );
    } finally {
      await app.close();
    }
  });

  it("answers profile creation after the durable write while cold catalog startup continues", async () => {
    const coldCatalog = Promise.withResolvers<readonly HarnessInstanceCatalog[]>();
    const fixture = harnessCatalogServer({
      connected: true,
      environmentKind: "local",
      harnessDrivers: [
        {
          accessModes: [...ThreadAccessModeSchema.options],
          driverKind: "native",
          readiness: "configured",
          sources: [
            {
              fields: [],
              kind: "first-party",
              label: "Native",
              quota: "none",
              sourceId: "native",
              stateKinds: ["ambient", "isolated"],
            },
          ],
        },
      ],
      reconcileHarnesses: async () => await coldCatalog.promise,
      runnerOwner: ownerId,
    });
    const app = await fixture.server;
    try {
      const created = await injectRpcRequest(app, "commands.dispatch", {
        driverKind: "native",
        environmentId,
        idempotencyKey: "create-cold-harness",
        name: "Cold account",
        sourceId: "native",
        stateKind: "isolated",
        type: "harness.create",
      });

      expect(created.statusCode).toBe(200);
      await vi.waitFor(() => expect(fixture.reconcileHarnesses).toHaveBeenCalledTimes(1));
      const refreshed = await injectRpcRequest(app, "bootstrap.get", {});
      expect(refreshed.statusCode).toBe(200);
      expect(rpcData(refreshed)).toMatchObject({
        harnesses: [expect.objectContaining({ id: harnessInstanceId })],
      });
      coldCatalog.resolve([]);
    } finally {
      coldCatalog.resolve([]);
      await app.close();
    }
  });

  it("reconciles every explicit enabled-state request", async () => {
    const fixture = harnessCatalogServer({
      catalog: readyCatalog,
      connected: true,
      environmentKind: "local",
      runnerOwner: ownerId,
    });
    const app = await fixture.server;
    try {
      const patched = await injectRpcRequest(app, "commands.dispatch", {
        // This matches the route's initial read. A concurrent mutation can still
        // make the store transaction change state, so the route must not use
        // that read to decide whether reconciliation is necessary.
        enabled: true,
        environmentId,
        harnessInstanceId,
        idempotencyKey: "enable-harness",
        type: "harness.enabled.set",
      });
      expect(patched.statusCode).toBe(200);
      expect(fixture.updateHarnessInstance).toHaveBeenCalledTimes(1);
      expect(fixture.reconcileHarnesses).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("refuses to sign an AI engine out while it is still running work", async () => {
    const fixture = harnessCatalogServer({
      activeRun: true,
      catalog: signedInCatalog,
      connected: true,
      environmentKind: "local",
      runnerOwner: ownerId,
    });
    const app = await fixture.server;
    try {
      const refused = await injectRpcRequest(app, "commands.dispatch", {
        environmentId,
        harnessInstanceId,
        idempotencyKey: "logout-harness",
        type: "harness.authentication.logout",
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: { code: "conflict", retryable: true } });
      expect(fixture.manageHarnessAuthentication).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("drops the stale catalog when signing an idle AI engine out", async () => {
    const fixture = harnessCatalogServer({
      catalog: signedInCatalog,
      connected: true,
      environmentKind: "local",
      reconcileHarnesses: async () => {
        throw new Error("Runner went away");
      },
      runnerOwner: ownerId,
    });
    const app = await fixture.server;
    try {
      const signedOut = await injectRpcRequest(app, "commands.dispatch", {
        environmentId,
        harnessInstanceId,
        idempotencyKey: "logout-harness",
        type: "harness.authentication.logout",
      });
      // The re-inspection failed, which is exactly when the stale "connected"
      // catalog would otherwise survive the sign-out.
      expect(signedOut.statusCode).toBe(200);
      expect(fixture.discardHarnessCatalog).toHaveBeenCalledWith(environmentId, harnessInstanceId);
    } finally {
      await app.close();
    }
  });

  it("removes an existing-CLI profile without touching the machine's provider files", async () => {
    const fixture = harnessCatalogServer({
      catalog: readyCatalog,
      connected: true,
      environmentKind: "local",
      runnerOwner: ownerId,
      stateKind: "ambient",
    });
    const app = await fixture.server;
    try {
      const removed = await injectRpcRequest(app, "commands.dispatch", {
        environmentId,
        harnessInstanceId,
        idempotencyKey: "remove-harness",
        type: "harness.delete",
      });
      expect(removed.statusCode).toBe(200);
      expect(fixture.removeHarnessInstance).toHaveBeenCalledWith(environmentId, harnessInstanceId);
      expect(
        fixture.manageHarnessAuthentication.mock.calls.map(([, request]) => request.action),
      ).toEqual(["remove"]);
      expect(fixture.reconcileHarnesses).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("keeps a teammate's existing CLI out of an administrator's reach", async () => {
    for (const type of ["harness.delete", "harness.authentication.logout"] as const) {
      const fixture = harnessCatalogServer({
        catalog: signedInCatalog,
        connected: true,
        environmentKind: "local",
        // The caller is an instance administrator; the Runner is somebody
        // else's own computer.
        runnerOwner: createId("user"),
        stateKind: "ambient",
      });
      const app = await fixture.server;
      try {
        const refused = await injectRpcRequest(app, "commands.dispatch", {
          environmentId,
          harnessInstanceId,
          idempotencyKey: "teammate-harness",
          type,
        });
        expect(refused.statusCode).toBe(403);
        expect(refused.json()).toMatchObject({ error: { code: "forbidden" } });
        expect(fixture.removeHarnessInstance).not.toHaveBeenCalled();
        expect(fixture.manageHarnessAuthentication).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  });

  it("lets an administrator rename and disable a teammate's existing CLI", async () => {
    const fixture = harnessCatalogServer({
      catalog: readyCatalog,
      connected: true,
      environmentKind: "local",
      runnerOwner: createId("user"),
      stateKind: "ambient",
    });
    const app = await fixture.server;
    try {
      const renamed = await injectRpcRequest(app, "commands.dispatch", {
        environmentId,
        harnessInstanceId,
        idempotencyKey: "rename-harness",
        name: "Shared CLI",
        type: "harness.rename",
      });
      await injectRpcRequest(app, "commands.dispatch", {
        enabled: false,
        environmentId,
        harnessInstanceId,
        idempotencyKey: "disable-harness",
        type: "harness.enabled.set",
      });
      expect(renamed.statusCode).toBe(200);
      expect(fixture.updateHarnessInstance).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("starts authentication only from an explicit catalog action", async () => {
    for (const catalog of [readyCatalog, { ...authenticationRequiredCatalog, setupMethods: [] }]) {
      const fixture = harnessCatalogServer({
        catalog,
        connected: true,
        environmentKind: "managed",
      });
      const app = await fixture.server;
      try {
        const response = await injectHarnessAuthentication(
          app,
          "POST",
          environmentId,
          harnessInstanceId,
        );
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ error: { code: "conflict" } });
        expect(fixture.manageHarnessAuthentication).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  });

  it("passes all auth operations through while connected and recaptures on ready", async () => {
    const fixture = harnessCatalogServer({
      authenticationState: (action) =>
        action === "start"
          ? {
              challenge: {
                kind: "device-code",
                userCode: "OPEN-STEER",
                verificationUrl: "https://example.test/device",
              },
              status: "pending",
            }
          : action === "read"
            ? { status: "ready" }
            : { status: "not-started" },
      catalog: authenticationRequiredCatalog,
      connected: true,
      environmentKind: "managed",
      reconcileHarnesses: async () => [readyCatalog],
    });
    const app = await fixture.server;
    try {
      const started = await injectHarnessAuthentication(
        app,
        "POST",
        environmentId,
        harnessInstanceId,
      );
      expect(started.statusCode).toBe(200);
      expect(rpcData(started)).toMatchObject({
        authentication: { challenge: { userCode: "OPEN-STEER" }, status: "pending" },
        environmentStatus: "connected",
      });

      const read = await injectHarnessAuthentication(app, "GET", environmentId, harnessInstanceId);
      expect(read.statusCode).toBe(200);
      expect(rpcData(read)).toEqual({
        authentication: { status: "ready" },
        environmentStatus: "connected",
      });
      await vi.waitFor(() => expect(fixture.reconcileHarnesses).toHaveBeenCalledTimes(1));
      expect(fixture.reconcileHarnesses).toHaveBeenCalledWith(
        environmentId,
        [expect.objectContaining({ id: harnessInstanceId })],
        expect.any(AbortSignal),
      );
      expect(fixture.recordHarnessCatalogs).toHaveBeenCalledExactlyOnceWith({
        catalogs: [readyCatalog],
        environmentId,
        expectedRevisions: new Map([[harnessInstanceId, 1]]),
      });

      const cancelled = await injectHarnessAuthentication(
        app,
        "DELETE",
        environmentId,
        harnessInstanceId,
      );
      expect(cancelled.statusCode).toBe(200);
      expect(rpcData(cancelled)).toMatchObject({
        authentication: { status: "not-started" },
        environmentStatus: "connected",
      });
      expect(
        fixture.manageHarnessAuthentication.mock.calls.map(([, request]) => request.action),
      ).toEqual(["start", "read", "cancel"]);
    } finally {
      await app.close();
    }
  });

  it("lets the person a managed Runner belongs to inspect its AI engine", async () => {
    const fixture = harnessCatalogServer({
      catalog: authenticationRequiredCatalog,
      connected: false,
      environmentKind: "managed",
      instanceRole: "user",
      runnerOwner: ownerId,
    });
    const app = await fixture.server;
    try {
      for (const method of ["POST", "GET", "DELETE"] as const) {
        const response = await injectHarnessAuthentication(
          app,
          method,
          environmentId,
          harnessInstanceId,
        );
        expect(response.statusCode).toBe(200);
        expect(rpcData(response)).toMatchObject({
          authentication: { status: "not-started" },
          environmentStatus: "disconnected",
        });
      }
    } finally {
      await app.close();
    }
  });

  it("keeps an unbound managed work location administrator-only", async () => {
    // A self-hosted Deployment's administrator enrolls managed Runners that
    // name no owner. Nothing is bound, so nothing changes for them.
    const fixture = harnessCatalogServer({
      catalog: readyCatalog,
      connected: false,
      environmentKind: "managed",
      instanceRole: "user",
    });
    const app = await fixture.server;
    try {
      for (const method of ["POST", "GET", "DELETE"] as const) {
        const response = await injectHarnessAuthentication(
          app,
          method,
          environmentId,
          harnessInstanceId,
        );
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ error: { code: "forbidden" } });
      }
      expect(fixture.manageHarnessAuthentication).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("does not admit somebody else's managed Runner even as an existence check", async () => {
    const fixture = harnessCatalogServer({
      catalog: readyCatalog,
      connected: false,
      environmentKind: "managed",
      instanceRole: "user",
      runnerOwner: createId("user"),
      visibleToUser: false,
    });
    const app = await fixture.server;
    try {
      for (const method of ["POST", "GET", "DELETE"] as const) {
        const response = await injectHarnessAuthentication(
          app,
          method,
          environmentId,
          harnessInstanceId,
        );
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ error: { code: "not_found" } });
      }
      expect(fixture.manageHarnessAuthentication).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("tells bootstrap who may sign an AI engine in, under the route's own rule", async () => {
    const administrator = await harnessCatalogServer({
      catalog: readyCatalog,
      connected: false,
      environmentKind: "managed",
    }).server;
    try {
      expect(rpcData(await injectRpcRequest(administrator, "bootstrap.get", {}))).toMatchObject({
        environments: [{ harnessAuthenticationAllowed: true }],
      });
    } finally {
      await administrator.close();
    }

    const owner = await harnessCatalogServer({
      catalog: readyCatalog,
      connected: false,
      environmentKind: "managed",
      instanceRole: "user",
      runnerOwner: ownerId,
    }).server;
    try {
      expect(rpcData(await injectRpcRequest(owner, "bootstrap.get", {}))).toMatchObject({
        environments: [{ harnessAuthenticationAllowed: true }],
      });
    } finally {
      await owner.close();
    }

    const unbound = await harnessCatalogServer({
      catalog: readyCatalog,
      connected: false,
      environmentKind: "managed",
      instanceRole: "user",
    }).server;
    try {
      expect(rpcData(await injectRpcRequest(unbound, "bootstrap.get", {}))).toMatchObject({
        environments: [{ harnessAuthenticationAllowed: false }],
      });
    } finally {
      await unbound.close();
    }

    // An administrator can set up an engine on their connected or reconnectable laptop too.
    const laptop = await harnessCatalogServer({
      catalog: readyCatalog,
      connected: false,
      environmentKind: "local",
    }).server;
    try {
      expect(rpcData(await injectRpcRequest(laptop, "bootstrap.get", {}))).toMatchObject({
        environments: [{ harnessAuthenticationAllowed: true }],
      });
    } finally {
      await laptop.close();
    }
  });

  it("refuses a selection whose account belongs to another work location", async () => {
    // The account fixes the work location, so a pair that disagrees is not a
    // choice anybody could have made in a picker.
    const fixture = harnessCatalogServer({
      catalog: readyCatalog,
      connected: true,
      environmentKind: "managed",
    });
    const app = await fixture.server;
    try {
      const refused = await injectRpcRequest(app, "commands.dispatch", {
        idempotencyKey: "remember-a-mismatch",
        selection: {
          environmentId: createId("environment"),
          harnessInstanceId,
          modelSelection,
        },
        type: "execution.preferences.remember",
      });

      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({
        error: { code: "conflict", message: "The selected AI engine is not available" },
      });
      expect(fixture.rememberExecutionChoice).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("does not remember a work location this person cannot see", async () => {
    const fixture = harnessCatalogServer({
      catalog: readyCatalog,
      connected: true,
      environmentKind: "managed",
      instanceRole: "user",
      visibleToUser: false,
    });
    const app = await fixture.server;
    try {
      const refused = await injectRpcRequest(app, "commands.dispatch", {
        idempotencyKey: "remember-an-invisible-location",
        selection: { environmentId, harnessInstanceId, modelSelection },
        type: "execution.preferences.remember",
      });

      expect(refused.statusCode).toBe(404);
      expect(refused.json()).toMatchObject({ error: { code: "not_found" } });
      expect(fixture.rememberExecutionChoice).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("Workspace Files routes", () => {
  it("authorizes Workspace membership and forwards only the bounded directory request", async () => {
    const ownerId = createId("user");
    const workspace = specializedWorkspace(ownerId);
    const list = vi.fn(async () => ({
      cursor: null,
      entries: [],
      parentKey: "",
      revision: "directory_revision_1",
    }));
    const preview = vi.fn(async () => ({
      bytes: new TextEncoder().encode("<script>alert(1)</script>"),
      metadata: {
        contentType: "text/html; charset=utf-8",
        etag: '"file-revision-1"',
        modifiedAt: null,
        sizeBytes: 25,
        truncated: false,
      },
    }));
    const admission = { membershipGeneration: 1, userId: ownerId, workspace };
    const admitWorkspaceFiles = vi.fn<() => Promise<WorkspaceFilesAdmission | null>>(
      async () => admission,
    );
    const app = await createHostServer({
      requestResponseVault: {} as never,
      agentControl: {} as never,
      agentTools: {} as never,
      authenticator: { authenticateUser: async () => ownerId } as never,
      browser: {} as never,
      commands: {} as never,
      credentials: {} as never,
      discovery: testDiscovery,
      egress: {} as never,
      files: { list, preview } as never,
      harnessAuthenticationCoordinator: {} as never,
      realtime: testRealtime(),
      runnerAuthenticator: {} as never,
      runners: {} as never,
      securityEffects: {} as never,
      store: { admitWorkspaceFiles } as never,
      workspaces: {} as never,
    } satisfies HostServerTestOverrides);
    try {
      const response = await injectRpcRequest(app, "workspace.files.list", {
        parentKey: "",
        workspaceId: workspace.id,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"directory_revision_1"');
      expect(response.headers["cache-control"]).toBe("private, no-cache");
      expect(admitWorkspaceFiles).toHaveBeenCalledWith(workspace.id, ownerId);
      expect(list).toHaveBeenCalledWith(
        admission,
        { limit: 200, parentKey: "" },
        expect.any(AbortSignal),
      );

      const revalidated = await injectRpcRequest(app, "workspace.files.list", {
        knownRevision: "directory_revision_1",
        parentKey: "",
        retainedCursor: "retained_cursor_token_1",
        workspaceId: workspace.id,
      });
      expect(revalidated.statusCode).toBe(200);
      expect(list).toHaveBeenLastCalledWith(
        admission,
        {
          knownRevision: "directory_revision_1",
          limit: 200,
          parentKey: "",
          retainedCursor: "retained_cursor_token_1",
        },
        expect.any(AbortSignal),
      );

      const unchangedDirectory = await injectRpcRequest(
        app,
        "workspace.files.list",
        { parentKey: "", workspaceId: workspace.id },
        { "if-none-match": '"directory_revision_1"' },
      );
      expect(unchangedDirectory.statusCode).toBe(304);
      expect(unchangedDirectory.body).toBe("");

      admitWorkspaceFiles.mockResolvedValueOnce(null);
      const missing = await injectRpcRequest(app, "workspace.files.list", {
        parentKey: "",
        workspaceId: workspace.id,
      });
      expect(missing.statusCode).toBe(404);
      expect(list).toHaveBeenCalledTimes(3);

      admitWorkspaceFiles.mockResolvedValueOnce(admission);
      const filePreview = await injectRpcRequest(app, "workspace.files.preview", {
        fileKey: "UkVBRE1FLm1k",
        workspaceId: workspace.id,
      });
      expect(filePreview.statusCode).toBe(200);
      expect(filePreview.headers["content-disposition"]).toBe("attachment");
      expect(filePreview.headers["content-security-policy"]).toContain("sandbox");
      expect(filePreview.headers["x-content-type-options"]).toBe("nosniff");
      expect(filePreview.headers["cache-control"]).toBe("private, no-cache");

      admitWorkspaceFiles.mockResolvedValueOnce(admission);
      const unchangedFile = await injectRpcRequest(
        app,
        "workspace.files.preview",
        { fileKey: "UkVBRE1FLm1k", workspaceId: workspace.id },
        { "if-none-match": '"file-revision-1"' },
      );
      expect(unchangedFile.statusCode).toBe(304);
      expect(unchangedFile.body).toBe("");
    } finally {
      await app.close();
    }
  });
});

describe("Workspace provisioning", () => {
  it("persists provisioning before the external mutation and reaches ready", async () => {
    const owner = createId("user");
    const calls: string[] = [];
    let workspace: Workspace | undefined;
    const store = {
      async createWorkspace(input: Parameters<OpensteerStore["createWorkspace"]>[0]) {
        calls.push("database");
        workspace = {
          backing: input.backing,
          capacityPolicy: input.capacityPolicy,
          createdAt: new Date().toISOString(),
          createdBy: input.createdBy,
          homeThreadId: null,
          icon: null,
          id: input.id ?? createId("workspace"),
          kind: input.kind ?? "main",
          name: input.name,
          status: input.status ?? "provisioning",
          storageIssue: null,
          updatedAt: new Date().toISOString(),
        };
        return workspace;
      },
      async listWorkspacesByStatus() {
        return [];
      },
      async setWorkspaceProvisioningResult(input: {
        backing: Workspace["backing"];
        status: Workspace["status"];
      }) {
        if (!workspace) throw new Error("missing workspace");
        workspace = {
          ...workspace,
          backing: input.backing,
          status: input.status,
        };
        return workspace;
      },
    };
    const controlPlane = {
      async createVolume() {
        calls.push("portablefs");
        return volume("00000000-0000-4000-8000-000000000001", "READY");
      },
    } as unknown as PortableFsControlPlane;
    const service = portableFsWorkspaceService(store, controlPlane);
    const result = await service.create({
      createdBy: owner,
      idempotencyKey: "create-1",
      name: "Client",
    });
    expect(calls).toEqual(["database", "portablefs"]);
    expect(result.capacityPolicy).toEqual({
      blockHardLimitBytes: 512 * 1_024 * 1_024,
      inodeHardLimit: 50_000,
      kind: "hard-quota",
    });
    expect(result.status).toBe("ready");
    expect(result.backing).toMatchObject({
      kind: "portablefs",
      serviceId: "test-portablefs",
      volumeId: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("marks retryable control-plane failures unavailable", async () => {
    const owner = createId("user");
    let workspace: Workspace | undefined;
    const statuses: Workspace["status"][] = [];
    const store = {
      async createWorkspace(input: Parameters<OpensteerStore["createWorkspace"]>[0]) {
        workspace = {
          backing: input.backing,
          capacityPolicy: input.capacityPolicy,
          createdAt: new Date().toISOString(),
          createdBy: input.createdBy,
          homeThreadId: null,
          icon: null,
          id: input.id ?? createId("workspace"),
          kind: input.kind ?? "main",
          name: input.name,
          status: "provisioning",
          storageIssue: null,
          updatedAt: new Date().toISOString(),
        };
        return workspace;
      },
      async listWorkspacesByStatus() {
        return [];
      },
      async setWorkspaceStorageState(input: {
        issue: Workspace["storageIssue"];
        status: Workspace["status"];
      }) {
        statuses.push(input.status);
        if (!workspace) throw new Error("missing workspace");
        workspace = { ...workspace, status: input.status, storageIssue: input.issue };
        return workspace;
      },
      async setWorkspaceProvisioningResult() {
        throw new Error("unexpected provisioning result");
      },
    };
    const controlPlane = {
      async createVolume() {
        throw new PortableFsControlPlaneError({
          message: "offline",
          operation: "create-volume",
          retryable: true,
        });
      },
    } as unknown as PortableFsControlPlane;
    const service = portableFsWorkspaceService(store, controlPlane);
    const result = await service.create({
      createdBy: owner,
      idempotencyKey: "create-2",
      name: "Client",
    });
    expect(result).toMatchObject({
      status: "unavailable",
      storageIssue: { code: "manager-unavailable", retryable: true },
    });
    expect(statuses).toEqual(["unavailable"]);
  });

  it("downgrades stale ready storage when Manager health is unavailable", async () => {
    const owner = createId("user");
    let workspace: Workspace = portableFsWorkspace(owner, {
      kind: "main",
      volumeId: "00000000-0000-4000-8000-000000000007",
    });
    const store = {
      async listWorkspaces() {
        return [workspace];
      },
      async listWorkspacesByStatus(status: Workspace["status"]) {
        return workspace.status === status ? [workspace] : [];
      },
      async setWorkspaceStorageState(input: {
        issue: Workspace["storageIssue"];
        status: Workspace["status"];
      }) {
        workspace = { ...workspace, status: input.status, storageIssue: input.issue };
        return workspace;
      },
    };
    const controlPlane = {
      async health() {
        throw new PortableFsControlPlaneError({
          message: "offline",
          operation: "manager-health",
          retryable: true,
        });
      },
    } as unknown as PortableFsControlPlane;

    const service = portableFsWorkspaceService(store, controlPlane);
    // One Manager blip must not demote healthy Workspaces; only the third
    // consecutive failed preflight does.
    await service.reconcile();
    await service.reconcile();
    expect(workspace.status).toBe("ready");
    await service.reconcile();

    expect(workspace).toMatchObject({
      status: "unavailable",
      storageIssue: { code: "manager-unavailable", retryable: true },
    });
  });

  it("retries the same durable Workspace instead of creating another one", async () => {
    const owner = createId("user");
    const workspaceId = createId("workspace");
    let attempts = 0;
    let workspace: Workspace = portableFsWorkspace(owner, {
      id: workspaceId,
      name: "Client",
      status: "unavailable",
      storageIssue: {
        code: "manager-unavailable",
        message: "Storage is offline.",
        occurredAt: new Date().toISOString(),
        retryable: true,
      },
      volumeId: `pending_${workspaceId}`,
    });
    const store = {
      async getWorkspaceForOwner(id: Workspace["id"], requestedBy: typeof owner) {
        return id === workspace.id && requestedBy === owner ? workspace : null;
      },
      async listWorkspacesByStatus() {
        return [];
      },
      async setWorkspaceStorageState(input: {
        issue: Workspace["storageIssue"];
        status: Workspace["status"];
      }) {
        workspace = { ...workspace, status: input.status, storageIssue: input.issue };
        return workspace;
      },
      async setWorkspaceProvisioningResult(input: {
        backing: Workspace["backing"];
        status: Workspace["status"];
      }) {
        workspace = {
          ...workspace,
          backing: input.backing,
          status: input.status,
          storageIssue: null,
        };
        return workspace;
      },
    };
    const controlPlane = {
      async createVolume() {
        attempts += 1;
        return volume("00000000-0000-4000-8000-000000000009", "READY");
      },
    } as unknown as PortableFsControlPlane;
    const service = portableFsWorkspaceService(store, controlPlane);

    const result = await service.retry(workspaceId, owner);

    expect(attempts).toBe(1);
    expect(result).toMatchObject({
      backing: {
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "00000000-0000-4000-8000-000000000009",
      },
      id: workspaceId,
      status: "ready",
      storageIssue: null,
    });
  });

  it("rejects a Workspace bound to another PortableFS authority without mutation", async () => {
    const workspaceId = createId("workspace");
    let workspace = portableFsWorkspace(createId("user"), {
      id: workspaceId,
      serviceId: "old-portablefs",
      status: "unavailable",
      volumeId: "old-volume",
    });
    const calls: string[] = [];
    const store = {
      async setWorkspaceStorageState(input: {
        issue: Workspace["storageIssue"];
        status: Workspace["status"];
      }) {
        workspace = { ...workspace, status: input.status, storageIssue: input.issue };
        return workspace;
      },
    };
    const controlPlane = {
      async createVolume() {
        calls.push("create");
        return volume("new-volume", "READY");
      },
    } as unknown as PortableFsControlPlane;
    const service = portableFsWorkspaceService(store, controlPlane, "current-portablefs");

    const result = await service.provision(workspace);

    expect(calls).toEqual([]);
    expect(result).toMatchObject({
      backing: { serviceId: "old-portablefs", volumeId: "old-volume" },
      status: "failed",
      storageIssue: { code: "manager-configuration-invalid", retryable: false },
    });
  });

  it("never silently rebinds a ready Workspace during a readiness check", async () => {
    let workspace = portableFsWorkspace(createId("user"), {
      serviceId: "old-portablefs",
      volumeId: "old-volume",
    });
    const store = {
      async setWorkspaceStorageState(input: {
        issue: Workspace["storageIssue"];
        status: Workspace["status"];
      }) {
        workspace = { ...workspace, status: input.status, storageIssue: input.issue };
        return workspace;
      },
    };
    const controlPlane = {
      async createVolume() {
        throw new Error("must not allocate");
      },
    } as unknown as PortableFsControlPlane;
    const service = portableFsWorkspaceService(store, controlPlane, "current-portablefs");

    await expect(service.ensureExecutionReady(workspace)).rejects.toThrow(
      /rejected|binding|ready/i,
    );

    expect(workspace.backing).toEqual({
      generation: 1,
      kind: "portablefs",
      serviceId: "old-portablefs",
      volumeId: "old-volume",
    });
    expect(workspace.status).toBe("failed");
  });
});

async function requestRouteServer(options: {
  readonly browser?: object;
  readonly continuations?: object;
  readonly ownerId: UserId;
  readonly request: OpensteerRequest;
  readonly requestResponseVault?: NonNullable<HostServerTestOverrides["requestResponseVault"]>;
  readonly sendControl?: (...args: never[]) => Promise<unknown>;
  readonly store?: {
    readonly getThreadForOwner?: (...args: never[]) => Promise<unknown>;
    readonly requests?: Record<string, unknown>;
  };
}) {
  const requests = {
    get: vi.fn(async () => options.request),
    originatingPendingPage: vi.fn(async () => ({
      requests: [options.request],
      window: { byteCount: 1, hasMore: false, itemCount: 1, nextBefore: null, totalItems: 1 },
    })),
    ...options.store?.requests,
  };
  return createHostServer({
    requestResponseVault:
      options.requestResponseVault ??
      ({
        fingerprint: vi.fn(async () => "hmac-sha256-v1:1:test"),
        open: vi.fn(),
        seal: vi.fn(async () => ({ envelope: Buffer.from("encrypted"), keyVersion: 1 })),
      } as never),
    agentControl: {} as never,
    agentTools: {} as never,
    authenticator: { authenticateUser: async () => options.ownerId } as never,
    browser: { latestPlaces: async () => [], ...options.browser } as never,
    commands: { sendControl: options.sendControl ?? vi.fn() } as never,
    integrations: {
      ...hostServerTestDependencies().integrations,
      ...(options.continuations ? { continuations: options.continuations as never } : {}),
    },
    credentials: {} as never,
    discovery: testDiscovery,
    egress: {} as never,
    files: {} as never,
    harnessAuthenticationCoordinator: {} as never,
    realtime: testRealtime(),
    runnerAuthenticator: {} as never,
    runners: {} as never,
    securityEffects: {} as never,
    store: {
      getThreadForOwner: vi.fn(async () => ({ id: options.request.originatingThreadId })),
      ...options.store,
      requests,
    } as never,
    workspaces: {} as never,
  } satisfies HostServerTestOverrides);
}

function pendingRequestFixture(
  kind: "browser.access" | "harness.input",
): Extract<OpensteerRequest, { status: "pending" }> {
  const workspaceId = createId("workspace");
  return {
    callId: crypto.randomUUID(),
    cancellationReason: null,
    createdAt: new Date().toISOString(),
    id: createId("request"),
    kind,
    mode: kind === "harness.input" ? "live" : "durable",
    originatingOccurrenceId: null,
    originatingRunId: createId("run"),
    originatingThreadId: createId("thread"),
    originatingWorkspaceId: workspaceId,
    payload:
      kind === "harness.input"
        ? { kind }
        : { kind, reason: "Use the signed-in portal", suggestion: { kind: "user_choice" } },
    presentation:
      kind === "harness.input"
        ? {
            fields: [
              {
                id: "password",
                multiSelect: false,
                prompt: "Enter the password",
                secret: true,
              },
            ],
            kind: "form",
            title: "Input needed",
          }
        : {
            kind: "external",
            subject: { id: workspaceId, kind: "workspace" },
            title: "Browser access",
          },
    requestedBy: createId("user"),
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
    targetWorkspaceId: workspaceId,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-host-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function specializedWorkspace(ownerId: Workspace["createdBy"]): Workspace {
  const now = new Date().toISOString();
  const id = createId("workspace");
  return {
    backing: {
      generation: 1,
      kind: "portablefs",
      serviceId: "portablefs-test",
      volumeId: `volume_${id}`,
    },
    capacityPolicy: {
      blockHardLimitBytes: 512 * 1_024 * 1_024,
      inodeHardLimit: 50_000,
      kind: "hard-quota",
    },
    createdAt: now,
    createdBy: ownerId,
    homeThreadId: null,
    icon: null,
    id,
    kind: "specialized",
    name: "Client",
    status: "ready",
    storageIssue: null,
    updatedAt: now,
  };
}

function portableFsWorkspace(
  ownerId: Workspace["createdBy"],
  overrides: {
    readonly id?: Workspace["id"];
    readonly kind?: Workspace["kind"];
    readonly name?: string;
    readonly serviceId?: string;
    readonly status?: Workspace["status"];
    readonly storageIssue?: Workspace["storageIssue"];
    readonly volumeId: string;
  },
): Workspace {
  const now = new Date().toISOString();
  return {
    backing: {
      generation: 1,
      kind: "portablefs",
      serviceId: overrides.serviceId ?? "test-portablefs",
      volumeId: overrides.volumeId,
    },
    capacityPolicy: {
      blockHardLimitBytes: 512 * 1_024 * 1_024,
      inodeHardLimit: 50_000,
      kind: "hard-quota",
    },
    createdAt: now,
    createdBy: ownerId,
    homeThreadId: null,
    icon: null,
    id: overrides.id ?? createId("workspace"),
    kind: overrides.kind ?? "main",
    name: overrides.name ?? "Main",
    status: overrides.status ?? "ready",
    storageIssue: overrides.storageIssue ?? null,
    updatedAt: now,
  };
}

function portableFsWorkspaceService(
  store: object,
  controlPlane: PortableFsControlPlane,
  serviceId = "test-portablefs",
): WorkspaceService {
  return new WorkspaceService({
    capacityPolicy: {
      blockHardLimitBytes: 512 * 1_024 * 1_024,
      inodeHardLimit: 50_000,
      kind: "hard-quota",
    },
    capacityPolicyCeiling: {
      blockHardLimitBytes: 100 * 1_024 * 1_024 * 1_024,
      inodeHardLimit: 10_000_000,
      kind: "hard-quota",
    },
    drivers: { portableFs: new PortableFsWorkspaceLifecycleDriver({ controlPlane, serviceId }) },
    shape: {
      defaultWorkspaceBacking: "portablefs",
      kind: "server" as const,
    },
    store: store as never,
  });
}

function volume(
  volumeId: string,
  state: PortableFsManagerVolume["state"],
): PortableFsManagerVolume {
  const now = Math.floor(Date.now() / 1_000);
  return {
    authority_endpoint: "127.0.0.1:9443",
    authority_generation: 1,
    authority_server_name: "authority.test",
    cell_id: "00000000-0000-4000-8000-000000000002",
    created_unix: now,
    id: volumeId,
    owner: "owner-test",
    product_issuer: "opensteer-test",
    project_id: 1,
    quota_bytes: 100 * 1_024 * 1_024 * 1_024,
    quota_inodes: 1_000_000,
    state,
    updated_unix: now,
  };
}
