import { createIntegrationPlatformRpcHandlers } from "./integration-platform-routes.js";
import { DeviceIdSchema, createId } from "@opensteer/core";
import { createIntegrationId } from "@opensteer/integration-core";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostAuthenticator } from "../identity/auth.js";
import {
  createIntegrationRpcHandlers,
  handleIntegrationCommand,
  registerIntegrationRoutes,
} from "./integration-routes.js";
import type { IntegrationService } from "./integration-service.js";
import { testHostApiContext } from "../server/test-host-api-context.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("integration routes", () => {
  it("includes screen Device approvals while preserving the existing self connection shape", async () => {
    const owner = createId("user"),
      runnerId = createId("runner"),
      deviceId = DeviceIdSchema.parse(createId("device"));
    const common = {
      accountIdentifier: null,
      applicationSource: null,
      authMethodId: "computer",
      authorizationDigest: null,
      connectionMethod: "computer",
      createdAt: "2026-11-16T12:00:00.000Z",
      definitionId: "macos-app",
      displayName: "Work Mac",
      externalIdentityId: null,
      externalTenantId: null,
      grantedScopes: [],
      id: createIntegrationId("connection"),
      provider: "macos-app",
      providerApplicationId: null,
      status: "connected",
      statusDetail: null,
      statusReason: null,
      updatedAt: "2026-11-16T12:00:00.000Z",
    };
    const self = {
      ...common,
      computer: { runnerId, access: "read", app: null, blockedAt: null, policyRevision: null },
    };
    const screen = {
      ...common,
      id: createIntegrationId("connection"),
      provider: "iphone-screen",
      definitionId: "iphone-screen",
      displayName: "Travel iPhone",
      computer: { deviceId, access: "read", app: null, blockedAt: null, policyRevision: null },
    };
    const handlers = createIntegrationRpcHandlers({
      dashboard: {
        providerDashboard: async () => ({
          applications: [],
          authorizationSurface: "canonical",
          providerAuthorizations: {},
          callbackUrls: {},
          connections: [self],
          isAdministrator: true,
          providers: [],
          hostedOAuthDisclosure: "Test",
        }),
      },
      platform: {
        store: { connections: { assertOwner: async () => {} } },
        deviceConnections: async () => [screen],
      },
    } as never);
    const result = await handlers["integrations.get"]({}, testHostApiContext(owner));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Integration inventory was refused");
    expect(result.data.connections).toEqual([self, screen]);
    expect(result.data.connections[1]?.computer).not.toHaveProperty("runnerId");
  });

  it("serializes a screen Device's pending owner approval without a Runner placement", async () => {
    const owner = createId("user");
    const request = {
      id: crypto.randomUUID(),
      deploymentId: createId("deployment"),
      ownerUserId: owner,
      deviceId: DeviceIdSchema.parse(createId("device")),
      definitionId: "iphone-screen",
      definitionDigest: "a".repeat(43),
      access: "read",
      kind: "app",
      app: null,
      policyAppApproval: null,
      server: null,
      reason: "Read the map",
      threadId: null,
      threadTitle: null,
      createdAt: "2026-11-16T12:00:00.000Z",
      expiresAt: "2026-11-17T12:00:00.000Z",
    };
    const handlers = createIntegrationPlatformRpcHandlers({
      platform: {
        store: {
          connections: { assertOwner: async () => {} },
          listComputerAppSetupRequests: async () => [],
          listDeviceComputerAppSetupRequests: async () => [request],
        },
      },
    } as never);
    const result = await handlers["integration.computer.setup.list"]({}, testHostApiContext(owner));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Approval inventory was refused");
    expect(result.data.requests).toEqual([request]);
    expect(result.data.requests[0]).not.toHaveProperty("runnerId");
  });

  it("carries a desktop return port to the service", async () => {
    const ownerUserId = createId("user");
    const beginAuthorization = vi.fn(async () => ({
      attemptId: "ioa_00000000-0000-4000-8000-000000000001",
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      launchTicket: "t".repeat(43),
    }));
    await handleIntegrationCommand(
      {
        platform: { store: { connections: { assertOwner: vi.fn(async () => undefined) } } },
        integrations: { beginAuthorization },
      } as never,
      {
        type: "integration.authorization.begin",
        idempotencyKey: "begin-port",
        input: {
          appReturnPort: 48_203,
          definitionId: "google",
          finish: "app",
          returnPath: "/integrations",
          surface: "desktop",
        },
      },
      testHostApiContext(ownerUserId),
    );
    expect(beginAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ appReturnPort: 48_203, finish: "app" }),
    );
  });

  it.each([undefined, "app"] as const)("forwards the requested finish mode: %s", async (finish) => {
    const ownerUserId = createId("user");
    const attemptId = createIntegrationId("oauthAttempt");
    const beginAuthorization = vi.fn(async () => ({
      attemptId,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      launchTicket: "t".repeat(43),
    }));
    await handleIntegrationCommand(
      {
        platform: { store: { connections: { assertOwner: vi.fn(async () => undefined) } } },
        integrations: { beginAuthorization },
      } as never,
      {
        type: "integration.authorization.begin",
        idempotencyKey: "begin-app",
        input: {
          definitionId: "google",
          returnPath: "/integrations",
          surface: "desktop",
          ...(finish ? { finish } : {}),
        },
      },
      testHostApiContext(ownerUserId),
    );
    expect(beginAuthorization).toHaveBeenCalledWith({
      definitionId: "google",
      ownerUserId,
      requestSurface: "canonical",
      returnPath: "/integrations",
      surface: "desktop",
      ...(finish ? { finish } : {}),
    });
  });

  it.each([false, true])(
    "returns the API-key command's exact connection id (reconnect: %s)",
    async (reconnect) => {
      const ownerUserId = createId("user");
      const connectionId = createIntegrationId("connection");
      const connectApiKey = vi.fn(async () => ({ id: connectionId }));
      const input = {
        authMethodId: "api-key",
        definitionId: "test-integration",
        values: { apiKey: "test-api-key" },
        ...(reconnect ? { connectionId } : {}),
      };
      await expect(
        handleIntegrationCommand(
          {
            platform: { store: { connections: { assertOwner: vi.fn(async () => undefined) } } },
            integrations: { connectApiKey },
          } as never,
          { type: "integration.apiKey.connect", idempotencyKey: "connect-key", input },
          testHostApiContext(ownerUserId),
        ),
      ).resolves.toEqual({ type: "integration.apiKey.connect", connectionId });
      expect(connectApiKey).toHaveBeenCalledExactlyOnceWith(input, {
        ownerUserId,
        requestId: "test-request",
      });
    },
  );

  it("dispatches computer disconnects without opening provider credentials", async () => {
    const userId = createId("user");
    const connectionId = createIntegrationId("connection");
    const disconnect = vi.fn();
    const disconnectComputerConnection = vi.fn(async () => ({
      notice: null,
      revokedUpstream: false,
    }));
    const output = await handleIntegrationCommand(
      {
        authenticator: {} as HostAuthenticator,
        dashboard: {} as never,
        integrations: { disconnect } as unknown as IntegrationService,
        platform: {
          computerAppApprovals: { disconnectComputerConnection },
          store: {
            connections: { assertOwner: vi.fn(async () => undefined) },
            getConnectionKind: vi.fn(async () => "computer"),
          },
        } as never,
      },
      { connectionId, idempotencyKey: "disconnect-computer", type: "integration.disconnect" },
      testHostApiContext(userId),
    );
    expect(output).toEqual({
      notice: null,
      revokedUpstream: false,
      type: "integration.disconnect",
    });
    expect(disconnectComputerConnection).toHaveBeenCalledWith({
      connectionId,
      ownerUserId: userId,
      requestId: "test-request",
    });
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("returns OAuth callbacks to the stored local path without provider secrets", async () => {
    const userId = createId("user");
    const attemptId = "ioa_00000000-0000-4000-8000-000000000001";
    const authenticateUser = vi.fn(async () => userId);
    const handleAuthorizationCallback = vi.fn(async (_input: unknown) => ({
      connection: { id: "con_00000000-0000-4000-8000-000000000001" },
      ownerUserId: userId,
      returnPath: "/",
      status: "completed" as const,
      surface: "web",
    }));
    const app = Fastify();
    apps.push(app);
    registerIntegrationRoutes(app, {
      authenticator: {
        authenticateUser,
        publicOrigin: "https://opensteer.example",
        requireCanonicalSurface: vi.fn(),
      } as unknown as HostAuthenticator,
      dashboard: {} as never,
      integrations: {
        handleAuthorizationCallback,
        identifyAuthorizationCallback: vi.fn(async () => attemptId),
      } as unknown as IntegrationService,
      platform: { store: { connections: { assertOwner: vi.fn(async () => undefined) } } } as never,
    });
    const response = await app.inject({
      headers: {
        cookie: `opensteer_integration_authorization_${attemptId.replaceAll("-", "_")}=${"b".repeat(43)}`,
        host: "opensteer.example",
      },
      method: "GET",
      url: `/v1/integrations/oauth/callback/google?code=provider-code&state=${"a".repeat(43)}&scope=email&authuser=0&future_provider_field=accepted`,
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(
      `https://opensteer.example/?integrationAttempt=${attemptId}`,
    );
    expect(response.headers.location).not.toContain("provider-code");
    expect(handleAuthorizationCallback).toHaveBeenCalledWith({
      attemptId,
      browserBinding: "b".repeat(43),
      parameters: expect.any(URLSearchParams),
      provider: "google",
      state: "a".repeat(43),
    });
    const parameters = (
      handleAuthorizationCallback.mock.calls[0]![0] as {
        parameters: URLSearchParams;
      }
    ).parameters;
    expect(parameters.get("code")).toBe("provider-code");
    expect(parameters.get("future_provider_field")).toBe("accepted");
    expect(authenticateUser).not.toHaveBeenCalled();
  });

  it.each([
    {
      expected: `https://opensteer.example/integrations?integrationAttempt=ioa_00000000-0000-4000-8000-000000000001`,
      surface: "web" as const,
    },
    {
      expected:
        "com.opensteer.mobile:/oauth/integration-callback?deployment_id=dep_00000000-0000-4000-8000-000000000001&attempt_id=ioa_00000000-0000-4000-8000-000000000001",
      surface: "native" as const,
    },
  ])(
    "returns a trusted failed $surface callback without provider details",
    async ({ expected, surface }) => {
      const attemptId = "ioa_00000000-0000-4000-8000-000000000001";
      const deploymentId = "dep_00000000-0000-4000-8000-000000000001";
      const handleAuthorizationCallback = vi.fn(async () => ({
        attemptId,
        returnPath: "/integrations",
        status: "failed" as const,
        surface,
      }));
      const app = Fastify();
      apps.push(app);
      registerIntegrationRoutes(app, {
        authenticator: {
          publicOrigin: "https://opensteer.example",
          requireCanonicalSurface: vi.fn(),
        } as unknown as HostAuthenticator,
        dashboard: {} as never,
        deploymentId: deploymentId as never,
        integrations: {
          handleAuthorizationCallback,
          identifyAuthorizationCallback: vi.fn(async () => attemptId),
        } as unknown as IntegrationService,
        platform: {
          store: { connections: { assertOwner: vi.fn(async () => undefined) } },
        } as never,
      });

      const response = await app.inject({
        headers: {
          cookie: `opensteer_integration_authorization_${attemptId.replaceAll("-", "_")}=${"b".repeat(43)}`,
          host: "opensteer.example",
        },
        method: "GET",
        url: `/v1/integrations/oauth/callback/google?error=server_error&error_description=provider-secret&state=${"a".repeat(43)}`,
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe(expected);
      expect(response.headers.location).not.toContain("server_error");
      expect(response.headers.location).not.toContain("provider-secret");
    },
  );

  it("rejects a deployment OAuth callback on a Personal remote route before spending state", async () => {
    const identifyAuthorizationCallback = vi.fn(
      async () => "ioa_00000000-0000-4000-8000-000000000001",
    );
    const app = Fastify();
    apps.push(app);
    registerIntegrationRoutes(app, {
      authenticator: {
        publicOrigin: "https://opensteer.example",
        requireCanonicalSurface: vi.fn(() => {
          throw new Error("canonical surface required");
        }),
      } as unknown as HostAuthenticator,
      dashboard: {} as never,
      integrations: { identifyAuthorizationCallback } as unknown as IntegrationService,
      platform: { store: { connections: { assertOwner: vi.fn(async () => undefined) } } } as never,
    });

    const response = await app.inject({
      headers: { host: "personal-route.example" },
      method: "GET",
      url: `/v1/integrations/oauth/callback/google?code=provider-code&state=${"a".repeat(43)}`,
    });
    expect(response.statusCode).toBe(500);
    expect(identifyAuthorizationCallback).not.toHaveBeenCalled();
  });
});
