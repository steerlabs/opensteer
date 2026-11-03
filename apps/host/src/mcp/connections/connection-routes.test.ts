import { createId } from "@opensteer/core";
import Fastify from "fastify";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentConnectionStore } from "@opensteer/database";
import {
  ConnectionOAuth,
  mcpResourceMetadataPath,
  mcpServerMetadataPath,
} from "./connection-oauth.js";
import { registerConnectionRoutes } from "./connection-routes.js";

describe("public MCP discovery boundaries", () => {
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
      personal: false,
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
