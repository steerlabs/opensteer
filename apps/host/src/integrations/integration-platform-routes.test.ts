import Fastify from "fastify";
import { createId } from "@opensteer/core";
import { createIntegrationId } from "@opensteer/integration-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostAuthenticator } from "../identity/auth.js";
import {
  createIntegrationPlatformRpcHandlers,
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
  it("refuses folder updates of agent-made plugins before loading a Host path", async () => {
    const installAgentPlugin = vi.fn();
    await expect(
      handleIntegrationPlatformCommand(
        {
          authenticator: {} as HostAuthenticator,
          dashboard: {} as never,
          mcpOauth: {} as McpOAuthService,
          platform: {
            store: { plugins: { list: async () => [{ id: "plugin", scope: "workspace" }] } },
            installAgentPlugin,
          } as never,
        },
        {
          type: "plugin.update",
          pluginId: "plugin",
          input: { directory: "/deleted/staging" },
          idempotencyKey: "update",
        },
        testHostApiContext(createId("user"), { instanceRole: "administrator" }),
      ),
    ).rejects.toThrow("Agent-made plugins update when an agent installs their folder again.");
    expect(installAgentPlugin).not.toHaveBeenCalled();
  });

  it("keeps plugin uninstall retryable until specialist retirement completes", async () => {
    const order: string[] = [];
    const retirePlugin = vi.fn(async (): Promise<void> => {
      throw new Error("Owner computer offline");
    });
    const remove = vi.fn(async () => {
      order.push("remove");
    });
    const uninstallIntegration = vi.fn(async () => {
      order.push("uninstall");
    });
    const options = {
      authenticator: {} as HostAuthenticator,
      dashboard: {} as never,
      mcpOauth: {} as McpOAuthService,
      platform: {
        store: {
          specialists: { retirePlugin },
          plugins: { remove },
          listInstallations: async () => [{ id: "installation", pluginId: "plugin" }],
        },
        uninstallIntegration,
      } as never,
    };
    const context = testHostApiContext(createId("user"), { instanceRole: "administrator" });
    const command = {
      type: "plugin.remove",
      pluginId: "plugin",
      idempotencyKey: "remove",
    } as const;
    await expect(handleIntegrationPlatformCommand(options, command, context)).rejects.toThrow(
      "offline",
    );
    expect(remove).not.toHaveBeenCalled();
    expect(uninstallIntegration).not.toHaveBeenCalled();
    retirePlugin.mockImplementation(async () => {
      order.push("retire");
    });
    await expect(handleIntegrationPlatformCommand(options, command, context)).resolves.toEqual({
      type: "plugin.remove",
    });
    expect(retirePlugin).toHaveBeenCalledWith("plugin");
    expect(order).toEqual(["retire", "uninstall", "remove"]);
  });

  it("addresses invalidation to affected viewers only after a committed shared mutation", async () => {
    const owner = createId("user"),
      member = createId("user"),
      workspaceId = createId("workspace");
    const changed = vi.fn();
    const setActivation = vi.fn(async () => {
      expect(changed).not.toHaveBeenCalled();
    });
    const options = {
      authenticator: {} as HostAuthenticator,
      dashboard: {} as never,
      mcpOauth: {} as McpOAuthService,
      pluginsChanged: changed,
      platform: {
        store: {
          settings: { affectedViewers: vi.fn(async () => [owner, member]) },
          plugins: { setActivation },
        },
      } as never,
    };
    await handleIntegrationPlatformCommand(
      options,
      {
        type: "plugin.activation.set",
        pluginId: "plugin",
        workspaceId,
        active: true,
        idempotencyKey: "activate",
      },
      testHostApiContext(owner),
    );
    expect(changed).toHaveBeenCalledExactlyOnceWith([owner, member]);
    changed.mockClear();
    setActivation.mockRejectedValueOnce(new Error("refused"));
    await expect(
      handleIntegrationPlatformCommand(
        options,
        {
          type: "plugin.activation.set",
          pluginId: "plugin",
          workspaceId,
          active: true,
          idempotencyKey: "refused",
        },
        testHostApiContext(owner),
      ),
    ).rejects.toThrow("refused");
    expect(changed).not.toHaveBeenCalled();
  });

  it("routes member plugin reads through the scoped projection on both entry points", async () => {
    const userId = createId("user"),
      workspaceId = createId("workspace");
    const listForUser = vi.fn(async () => [{ id: "plugin" }]);
    const options = {
      authenticator: {} as HostAuthenticator,
      dashboard: {} as never,
      mcpOauth: {} as McpOAuthService,
      platform: { store: { plugins: { listForUser } } } as never,
    };
    const context = testHostApiContext(userId);
    expect(
      await createIntegrationPlatformRpcHandlers(options)["plugin.list"]({ workspaceId }, context),
    ).toMatchObject({ ok: true, data: { plugins: [{ id: "plugin" }] } });
    expect(
      await handleIntegrationPlatformCommand(
        options,
        { type: "plugin.list", workspaceId, idempotencyKey: "list" },
        context,
      ),
    ).toEqual({ type: "plugin.list", plugins: [{ id: "plugin" }] });
    expect(listForUser).toHaveBeenNthCalledWith(1, userId, workspaceId);
    expect(listForUser).toHaveBeenNthCalledWith(2, userId, workspaceId);
  });
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

    const context = testHostApiContext(userId);
    await expect(handleIntegrationPlatformCommand(options, command, context)).resolves.toEqual({
      connection,
      type: "integration.computer.setup.set",
    });
    expect(setComputerConnection).toHaveBeenCalledWith({
      ...command.input,
      actorUserId: userId,
      isAdministrator: false,
      requestId: "test-request",
      settlementSessionId: context.session?.id,
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
