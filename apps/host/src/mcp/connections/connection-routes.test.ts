import { createId } from "@opensteer/core";
import Fastify from "fastify";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AgentConnectionStore } from "@opensteer/database";
import {
  ConnectionOAuth,
  mcpResourceMetadataPath,
  mcpServerMetadataPath,
} from "./connection-oauth.js";
import { registerConnectionRoutes } from "./connection-routes.js";

describe("public MCP discovery boundaries", () => {
  it("passes the resource-bound caller to the MCP request", async () => {
    const app = Fastify();
    const keys = generateKeyPairSync("ed25519");
    const oauth = new ConnectionOAuth({
      deploymentId: createId("deployment"),
      store: {} as AgentConnectionStore,
      signingKey: keys.privateKey,
      verificationKey: keys.publicKey,
    });
    const connection = {
      connectionId: "mcn_test",
      userId: createId("user"),
      accessMode: "approval-required" as const,
    };
    const authenticate = vi
      .spyOn(oauth.authenticator, "authenticate")
      .mockResolvedValue(connection);
    registerConnectionRoutes(app, {
      oauth,
      canonicalOrigin: "https://server.example",
      loopbackOriginAliases: false,
    });
    app.post(
      "/internal/v1/mcp",
      async (request) =>
        (request.raw as typeof request.raw & { auth: { extra: { caller: unknown } } }).auth.extra
          .caller,
    );
    try {
      const token = `ost_mcp_${"a".repeat(43)}`;
      const response = await app.inject({
        method: "POST",
        url: "/internal/v1/mcp",
        headers: {
          host: "server.example",
          "x-forwarded-proto": "https",
          authorization: `Bearer ${token}`,
        },
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ...connection,
        kind: "connection",
        key: "connection:mcn_test",
      });
      expect(authenticate).toHaveBeenCalledExactlyOnceWith(
        token,
        "https://server.example/internal/v1/mcp",
      );
    } finally {
      await app.close();
    }
  });
  it("leaves Run and program credentials on a private runtime origin to the MCP service", async () => {
    const app = Fastify();
    const keys = generateKeyPairSync("ed25519");
    const oauth = new ConnectionOAuth({
      deploymentId: createId("deployment"),
      store: {} as AgentConnectionStore,
      signingKey: keys.privateKey,
      verificationKey: keys.publicKey,
    });
    const authenticate = vi.spyOn(oauth.authenticator, "authenticate");
    registerConnectionRoutes(app, {
      oauth,
      canonicalOrigin: "https://server.example",
      loopbackOriginAliases: false,
    });
    app.post("/internal/v1/mcp", async () => ({ reached: true }));
    try {
      // A self-hosted gateway gives Runners a runtime origin unlike the public one.
      const response = await app.inject({
        method: "POST",
        url: "/internal/v1/mcp",
        headers: {
          host: "gateway:8443",
          "x-forwarded-proto": "https",
          authorization: "Bearer run-capability-token",
        },
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ reached: true });
      expect(authenticate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("uses the server public origin without replacing native OAuth metadata", async () => {
    const app = Fastify();
    const keys = generateKeyPairSync("ed25519");
    const oauth = new ConnectionOAuth({
      deploymentId: createId("deployment"),
      store: {} as AgentConnectionStore,
      signingKey: keys.privateKey,
      verificationKey: keys.publicKey,
    });
    app.get("/.well-known/oauth-authorization-server", async () => ({
      issuer: "https://server.example",
      native: true,
    }));
    registerConnectionRoutes(app, {
      oauth,
      canonicalOrigin: "https://server.example",
      loopbackOriginAliases: false,
    });
    try {
      const headers = { host: "server.example", "x-forwarded-proto": "https" };
      const resource = await app.inject({ method: "GET", url: mcpResourceMetadataPath, headers });
      expect(resource.json()).toMatchObject({
        resource: "https://server.example/internal/v1/mcp",
        authorization_servers: ["https://server.example/oauth/mcp"],
      });
      const server = await app.inject({ method: "GET", url: mcpServerMetadataPath, headers });
      expect(server.json()).toMatchObject({
        issuer: "https://server.example/oauth/mcp",
        authorization_endpoint: "https://server.example/oauth/mcp/authorize",
      });
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/.well-known/oauth-authorization-server",
            headers,
          })
        ).json(),
      ).toEqual({ issuer: "https://server.example", native: true });
      for (const path of ["/oauth/mcp/register", "/oauth/mcp/token"]) {
        const preflight = await app.inject({
          method: "OPTIONS",
          url: path,
          headers: {
            ...headers,
            origin: "https://client.example",
            "access-control-request-method": "POST",
          },
        });
        expect(preflight.statusCode).toBe(204);
        expect(preflight.headers["access-control-allow-origin"]).toBe("*");
        expect(preflight.headers["access-control-allow-credentials"]).toBeUndefined();
      }
    } finally {
      await app.close();
    }
  });
});
