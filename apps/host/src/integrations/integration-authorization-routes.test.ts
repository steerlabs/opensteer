import { createIntegrationId } from "@opensteer/integration-core";
import { createId } from "@opensteer/core";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostAuthenticator } from "../identity/auth.js";
import type { IntegrationAuthAttemptLifecycle } from "./integration-auth-attempt-service.js";
import {
  failIntegrationAuthorizationBrowser,
  finishIntegrationAuthorizationBrowser,
  handleIntegrationAuthorizationCommand,
  readIntegrationAuthorizationBinding,
  registerIntegrationAuthorizationRoutes,
} from "./integration-authorization-routes.js";
import { testHostApiContext } from "../server/test-host-api-context.js";

const apps: ReturnType<typeof Fastify>[] = [];
const attemptId = createIntegrationId("oauthAttempt");
const deploymentId = createId("deployment");
const launchTicket = "t".repeat(43);
const browserBinding = "b".repeat(43);

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("integration authorization transaction routes", () => {
  it("binds an atomic launch to the callback browser and redirects without caching", async () => {
    const launch = vi.fn(async () => ({
      authorizationUrl: "https://accounts.example.test/authorize?state=opaque",
      browserBinding,
      flow: "provider-oauth" as const,
      id: attemptId,
      surface: "desktop" as const,
    }));
    const app = Fastify();
    apps.push(app);
    const requireCanonicalSurface = vi.fn((headers: { readonly host?: string }) => {
      if (headers.host !== "host.example.test") throw new Error("canonical surface required");
    });
    registerIntegrationAuthorizationRoutes(app, {
      attempts: { launch } as unknown as IntegrationAuthAttemptLifecycle,
      authenticator: {
        publicOrigin: "https://host.example.test",
        requireCanonicalSurface,
      } as unknown as HostAuthenticator,
      deploymentId,
    });

    const response = await app.inject({
      headers: { host: "host.example.test" },
      method: "GET",
      url: `/v1/integration-authorizations/${attemptId}/launch?ticket=${launchTicket}`,
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("https://accounts.example.test/authorize?state=opaque");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["set-cookie"]).toContain("HttpOnly; SameSite=Lax; Secure");
    expect(readIntegrationAuthorizationBinding(response.headers["set-cookie"], attemptId)).toBe(
      browserBinding,
    );
    expect(launch).toHaveBeenCalledWith({ id: attemptId, launchTicket });

    const remote = await app.inject({
      headers: { host: "personal-route.example.test" },
      method: "GET",
      url: `/v1/integration-authorizations/${attemptId}/launch?ticket=${launchTicket}`,
    });
    expect(remote.statusCode).toBe(500);
    expect(launch).toHaveBeenCalledOnce();
  });

  it("exposes status and cancellation only to the authenticated owner", async () => {
    const ownerUserId = createId("user");
    const status = vi.fn(async () => ({
      connectionId: null,
      expiresAt: new Date("2026-08-20T23:10:00.000Z"),
      status: "cancelled" as const,
    }));
    const cancel = vi.fn(async () => true);
    const options = {
      attempts: { cancel, status } as unknown as IntegrationAuthAttemptLifecycle,
      authenticator: {} as HostAuthenticator,
      deploymentId,
    };
    const response = await handleIntegrationAuthorizationCommand(
      options,
      { attemptId, idempotencyKey: "cancel-attempt", type: "integration.authorization.cancel" },
      testHostApiContext(ownerUserId),
    );

    expect(response).toEqual({
      connectionId: null,
      expiresAt: "2026-08-20T23:10:00.000Z",
      failureCode: null,
      status: "cancelled",
      type: "integration.authorization.cancel",
    });
    expect(cancel).toHaveBeenCalledWith({ id: attemptId, ownerUserId });
    expect(status).toHaveBeenCalledWith({ id: attemptId, ownerUserId });
  });

  it("returns web callbacks to the stored same-origin path with only the attempt id", async () => {
    const app = Fastify();
    apps.push(app);
    app.get("/finish", (_request, reply) =>
      finishIntegrationAuthorizationBrowser(reply, {
        attemptId,
        deploymentId,
        publicOrigin: "https://host.example.test",
        returnPath: "/integrations?view=accounts",
        status: "completed",
        surface: "web",
      }),
    );

    const response = await app.inject({ method: "GET", url: "/finish" });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(
      `https://host.example.test/integrations?view=accounts&integrationAttempt=${attemptId}`,
    );
    expect(response.headers.location).not.toContain("code=");
    expect(response.headers["set-cookie"]).toContain("Max-Age=0");
  });

  it("returns native callbacks through the fixed app scheme with opaque ids only", async () => {
    const app = Fastify();
    apps.push(app);
    app.get("/finish-native", (_request, reply) =>
      finishIntegrationAuthorizationBrowser(reply, {
        attemptId,
        deploymentId,
        publicOrigin: "https://host.example.test",
        returnPath: "/ignored-for-native",
        status: "completed",
        surface: "native",
      }),
    );

    const response = await app.inject({ method: "GET", url: "/finish-native" });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(
      `com.opensteer.mobile:/oauth/integration-callback?deployment_id=${deploymentId}&attempt_id=${attemptId}`,
    );
    expect(response.headers.location).not.toContain("host.example.test");
    expect(response.headers.location).not.toContain("code=");
  });

  it.each([
    { status: "completed" as const, statusCode: 200, title: "Connection complete" },
    { status: "denied" as const, statusCode: 400, title: "Connection not completed" },
  ])(
    "keeps desktop $status completion on the callback page",
    async ({ status, statusCode, title }) => {
      const app = Fastify();
      apps.push(app);
      app.get(`/finish-desktop-${status}`, (_request, reply) =>
        finishIntegrationAuthorizationBrowser(reply, {
          attemptId,
          deploymentId,
          publicOrigin: "https://host.example.test",
          returnPath: "/integrations",
          status,
          surface: "desktop",
        }),
      );

      const response = await app.inject({ method: "GET", url: `/finish-desktop-${status}` });

      expect(response.statusCode).toBe(statusCode);
      expect(response.headers.location).toBeUndefined();
      expect(response.body).toContain(title);
      expect(response.headers["set-cookie"]).toContain("Max-Age=0");
    },
  );

  it.each([
    "https://attacker.test/integrations",
    "//attacker.test/integrations",
    "/integrations#hidden",
  ])("refuses an unsafe stored web return path: %s", async (returnPath) => {
    const app = Fastify();
    apps.push(app);
    app.get("/finish-unsafe", (_request, reply) =>
      finishIntegrationAuthorizationBrowser(reply, {
        attemptId,
        deploymentId,
        publicOrigin: "https://host.example.test",
        returnPath,
        status: "completed",
        surface: "web",
      }),
    );

    const response = await app.inject({ method: "GET", url: "/finish-unsafe" });

    expect(response.statusCode).toBe(500);
    expect(response.headers.location).toBeUndefined();
  });

  it("shows only safe actionable copy for a duplicate provider identity", async () => {
    const app = Fastify();
    apps.push(app);
    app.get("/failed", (_request, reply) =>
      failIntegrationAuthorizationBrowser(reply, "provider-identity-already-connected"),
    );

    const response = await app.inject({ method: "GET", url: "/failed" });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("already connected by another user");
    expect(response.body).toContain("your own provider app");
  });
});
