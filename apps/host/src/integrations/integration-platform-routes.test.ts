import Fastify from "fastify";
import { createId } from "@opensteer/core";
import { createIntegrationId } from "@opensteer/integration-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostAuthenticator } from "../identity/auth.js";
import {
  handleIntegrationPlatformCommand,
  registerIntegrationPlatformRoutes,
} from "./integration-platform-routes.js";
import type { McpOAuthService } from "./mcp-oauth-service.js";
import { testHostApiContext } from "../server/test-host-api-context.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("integration platform OAuth routes", () => {
  it("routes computer app changes with the caller's administrator posture", async () => {
    const userId = createId("user");
    const runnerId = createId("runner");
    const connection = { id: createIntegrationId("connection") };
    const setComputerConnection = vi.fn(async () => connection);
    const command = {
      idempotencyKey: "computer-app-set",
      input: {
        kind: "app" as const,
        app: null,
        access: "read" as const,
        definitionId: "apple-messages",
        runnerId,
      },
      type: "integration.computer.setup.set" as const,
    };
    const options = {
      authenticator: {} as HostAuthenticator,
      dashboard: {} as never,
      mcpOauth: {} as McpOAuthService,
      platform: { computerAppApprovals: { setComputerConnection } } as never,
    };

    await expect(
      handleIntegrationPlatformCommand(options, command, testHostApiContext(userId)),
    ).resolves.toEqual({ connection, type: "integration.computer.setup.set" });
    expect(setComputerConnection).toHaveBeenCalledWith({
      ...command.input,
      actorUserId: userId,
      isAdministrator: false,
      requestId: "test-request",
    });
  });

  it("routes uninstall to the platform only for an administrator", async () => {
    const userId = createId("user");
    const installationId = createIntegrationId("installation");
    const uninstallIntegration = vi.fn(async () => ({
      cancelledRequests: 2,
      removedConnections: 1,
    }));
    const options = {
      authenticator: {} as HostAuthenticator,
      dashboard: {} as never,
      mcpOauth: {} as McpOAuthService,
      platform: { uninstallIntegration } as never,
    };
    const command = {
      idempotencyKey: "uninstall-integration",
      installationId,
      type: "integration.uninstall",
    } as const;

    await expect(
      handleIntegrationPlatformCommand(options, command, testHostApiContext(userId)),
    ).rejects.toMatchObject({ code: "forbidden", message: "Administrator access required" });
    expect(uninstallIntegration).not.toHaveBeenCalled();

    await expect(
      handleIntegrationPlatformCommand(
        options,
        command,
        testHostApiContext(userId, { instanceRole: "administrator" }),
      ),
    ).resolves.toEqual({
      cancelledRequests: 2,
      removedConnections: 1,
      type: "integration.uninstall",
    });
    expect(uninstallIntegration).toHaveBeenCalledWith({
      actorUserId: userId,
      installationId,
      requestId: "test-request",
    });
  });

  it("rejects an MCP OAuth callback on a Personal remote route before spending state", async () => {
    const identifyAuthorizationCallback = vi.fn(
      async () => "moa_00000000-0000-4000-8000-000000000001",
    );
    const app = Fastify();
    apps.push(app);
    registerIntegrationPlatformRoutes(app, {
      authenticator: {
        requireCanonicalSurface: vi.fn(() => {
          throw new Error("canonical surface required");
        }),
      } as unknown as HostAuthenticator,
      dashboard: {} as never,
      mcpOauth: { identifyAuthorizationCallback } as unknown as McpOAuthService,
      platform: {} as never,
    });

    const response = await app.inject({
      headers: { host: "personal-route.example" },
      method: "GET",
      url: `/v1/integration-platform/mcp-oauth/callback?code=provider-code&state=${"a".repeat(43)}`,
    });
    expect(response.statusCode).toBe(500);
    expect(identifyAuthorizationCallback).not.toHaveBeenCalled();
  });

  it.each([
    {
      expected: `https://opensteer.example/integrations?integrationAttempt=imo_00000000-0000-4000-8000-000000000001`,
      surface: "web" as const,
    },
    {
      expected:
        "com.opensteer.mobile:/oauth/integration-callback?deployment_id=dep_00000000-0000-4000-8000-000000000001&attempt_id=imo_00000000-0000-4000-8000-000000000001",
      surface: "native" as const,
    },
  ])(
    "returns a trusted failed MCP $surface callback without provider details",
    async ({ expected, surface }) => {
      const attemptId = "imo_00000000-0000-4000-8000-000000000001";
      const handleAuthorizationCallback = vi.fn(async () => ({
        attemptId,
        returnPath: "/integrations",
        status: "failed" as const,
        surface,
      }));
      const app = Fastify();
      apps.push(app);
      registerIntegrationPlatformRoutes(app, {
        authenticator: {
          publicOrigin: "https://opensteer.example",
          requireCanonicalSurface: vi.fn(),
        } as unknown as HostAuthenticator,
        dashboard: {} as never,
        deploymentId: "dep_00000000-0000-4000-8000-000000000001" as never,
        mcpOauth: {
          handleAuthorizationCallback,
          identifyAuthorizationCallback: vi.fn(async () => attemptId),
        } as unknown as McpOAuthService,
        platform: {} as never,
      });

      const response = await app.inject({
        headers: {
          cookie: `opensteer_integration_authorization_${attemptId.replaceAll("-", "_")}=${"b".repeat(43)}`,
          host: "opensteer.example",
        },
        method: "GET",
        url: `/v1/integration-platform/mcp-oauth/callback?error=server_error&error_description=provider-secret&state=${"a".repeat(43)}`,
      });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe(expected);
      expect(response.headers.location).not.toContain("server_error");
      expect(response.headers.location).not.toContain("provider-secret");
    },
  );
});
