import { createId } from "@opensteer/core";
import { createIntegrationId } from "@opensteer/integration-core";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostAuthenticator } from "../identity/auth.js";
import { handleIntegrationCommand, registerIntegrationRoutes } from "./integration-routes.js";
import type { IntegrationService } from "./integration-service.js";
import { testHostApiContext } from "../server/test-host-api-context.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("integration routes", () => {
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
          store: { getConnectionKind: vi.fn(async () => "computer") },
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
      platform: {} as never,
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
        platform: {} as never,
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
      platform: {} as never,
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
