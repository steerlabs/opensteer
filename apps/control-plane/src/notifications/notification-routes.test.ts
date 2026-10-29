import Fastify from "fastify";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import type { ControlPlaneAuthenticator } from "../auth/auth.js";
import type { ControlPlaneStore } from "../database/store.js";
import { ControlPlaneError } from "../server/errors.js";
import type { ControlPlaneNotificationStore } from "./notification-store.js";
import { registerNotificationRoutes } from "./notification-routes.js";

const accountId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);

describe("notification registration routes", () => {
  it("requires iOS environment and only registers configured platforms", async () => {
    const app = Fastify();
    const registerDevice = vi.fn(
      async (input: Parameters<ControlPlaneNotificationStore["registerDevice"]>[0]) => ({
        ...input,
        lastSeenAt: new Date().toISOString(),
        registeredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: "bad_request" });
      if (error instanceof ControlPlaneError)
        return reply.code(error.status).send({ reason: error.reason });
      throw error;
    });
    registerNotificationRoutes(app, {
      authenticator: {
        authenticate: async () => ({ accountId, application: "mobile" }),
      } as unknown as ControlPlaneAuthenticator,
      notifications: { registerDevice } as unknown as ControlPlaneNotificationStore,
      notificationPlatforms: ["ios"],
      store: {} as ControlPlaneStore,
    });
    const body = {
      platform: "ios",
      approvalsEnabled: true,
      runOutcomesEnabled: true,
      token: "a".repeat(64),
    };
    const put = (payload: Record<string, unknown>) =>
      app.inject({
        method: "PUT",
        url: "/v1/account/notification-devices/install-routing-001",
        payload,
      });
    try {
      expect((await put(body)).statusCode).toBe(400);
      for (const apsEnvironment of ["development", "production"]) {
        expect((await put({ ...body, apsEnvironment })).statusCode).toBe(200);
        expect(registerDevice).toHaveBeenLastCalledWith(
          expect.objectContaining({ apsEnvironment }),
        );
      }
      const android = await put({ ...body, platform: "android" });
      expect(android.statusCode).toBe(404);
      expect(android.json()).toEqual({ reason: "push-not-configured" });
      expect(
        (await put({ ...body, platform: "android", apsEnvironment: "production" })).statusCode,
      ).toBe(400);
      expect(registerDevice).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("withdraws and lists registrations with no provider, refusing only registration and publication", async () => {
    const app = Fastify();
    const unregisterDevice = vi.fn(async () => undefined);
    const listDevices = vi.fn(async () => []);
    const registerDevice = vi.fn();
    const ingest = vi.fn();
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: "bad_request" });
      if (error instanceof ControlPlaneError)
        return reply.code(error.status).send({ reason: error.reason });
      throw error;
    });
    registerNotificationRoutes(app, {
      authenticator: {
        authenticate: async () => ({ accountId, application: "mobile" }),
      } as unknown as ControlPlaneAuthenticator,
      notifications: {
        ingest,
        listDevices,
        registerDevice,
        unregisterDevice,
      } as unknown as ControlPlaneNotificationStore,
      notificationPlatforms: [],
      store: {
        authenticateHostCredential: async () => ({}),
      } as unknown as ControlPlaneStore,
    });
    const url = "/v1/account/notification-devices/install-routing-001";
    try {
      expect((await app.inject({ method: "DELETE", url })).statusCode).toBe(200);
      expect(unregisterDevice).toHaveBeenCalledWith({
        accountId,
        installationId: "install-routing-001",
      });
      expect(
        (await app.inject({ method: "GET", url: "/v1/account/notification-devices" })).statusCode,
      ).toBe(200);
      const put = await app.inject({
        method: "PUT",
        url,
        payload: {
          apsEnvironment: "development",
          approvalsEnabled: true,
          platform: "ios",
          runOutcomesEnabled: true,
          token: "a".repeat(64),
        },
      });
      expect(put.json()).toEqual({ reason: "push-not-configured" });
      const publication = await app.inject({
        method: "POST",
        url: "/v1/host/notifications",
        headers: { authorization: "Bearer host" },
        payload: {},
      });
      expect(publication.statusCode).toBe(404);
      expect(publication.json()).toEqual({ reason: "push-not-configured" });
      expect(registerDevice).not.toHaveBeenCalled();
      expect(ingest).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
