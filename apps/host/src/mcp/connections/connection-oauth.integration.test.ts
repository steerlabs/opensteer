import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { createId, type ThreadAccessMode } from "@opensteer/core";
import { AgentConnectionStore } from "@opensteer/database";
import {
  createStoreFixture,
  seedPersonalOwnerResources,
} from "@opensteer/database/test-support/store";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownTestDatabaseProducer } from "@opensteer/database/test-support/database";
import { IdentityService } from "@opensteer/identity";
import { rpcSuccess, type HostApiHandlers } from "@opensteer/protocol";
import Fastify from "fastify";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HostAuthenticator } from "../../identity/auth.js";
import { registerHostApi } from "../../server/host-api-registration.js";
import { injectRpcRequest } from "../../server/test-host-api-request.js";
import {
  ConnectionOAuth,
  mcpIssuerPath,
  mcpResourceMetadataPath,
  mcpResourcePath,
  mcpServerMetadataPath,
} from "./connection-oauth.js";
import {
  createConnectionRpcHandlers,
  handleConnectionCommand,
  registerConnectionRoutes,
} from "./connection-routes.js";
import { credentialHash } from "./connection-authenticator.js";

// The integration launcher supplies isolated PostgreSQL; skip only when it is absent.
const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;
const origin = "http://127.0.0.1:4310";
const redirectUri = "http://127.0.0.1:49210/callback";
const verifier = "a".repeat(64);

async function fixture() {
  const fixture = await createStoreFixture();
  const database = fixture.database;
  let now = Date.now();
  const deployment = await fixture.store.ensureDeployment({
    canonicalOrigin: origin,
    hostInstanceId: createId("hostInstance"),
    deploymentShape: { kind: "personal" },
  });
  const enrollment = randomBytes(32).toString("base64url");
  const identity = new IdentityService(database, {
    deployment: { kind: "personal", name: null },
    exposure: "loopback",
    localPasswordEnabled: false,
    oidcProviders: [],
    publicOrigin: new URL(origin),
    secret: randomBytes(32).toString("base64url"),
    signupPolicy: "closed",
    initialOwnerEnrollment: { token: enrollment, expiresAt: new Date(now + 60_000) },
    localMachineOwner: { displayName: "Owner", email: "owner@opensteer.local" },
  });
  await identity.initialize();
  const signedIn = await identity.claimLocalMachineOwner(enrollment, new Headers({ origin }));
  const owner = signedIn.data.session;
  const cookie = signedIn.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const folder = await mkdtemp(join(tmpdir(), "opensteer-mcp-oauth-"));
  await ownTestDatabaseProducer(fixture.databaseUrl, async () => ({
    close: () => rm(folder, { recursive: true, force: true }),
  }));
  await seedPersonalOwnerResources(database, {
    deploymentId: deployment.id,
    userId: owner.user.id,
    path: folder,
  });
  const authenticator = new HostAuthenticator({ identity, publicUrl: new URL(origin) });
  const keys = generateKeyPairSync("ed25519");
  const connections = new AgentConnectionStore(database, () => new Date(now));
  const oauth = new ConnectionOAuth({
    deploymentId: deployment.id,
    store: connections,
    signingKey: keys.privateKey,
    verificationKey: keys.publicKey,
    now: () => now,
  });
  let remoteOrigin: string | null = null;
  const app = Fastify();
  await ownTestDatabaseProducer(fixture.databaseUrl, async () => ({ close: () => app.close() }));
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(error instanceof Error && "code" in error && error.code === "unauthorized" ? 401 : 403)
      .send({ error: "refused" }),
  );
  registerConnectionRoutes(app, {
    oauth,
    canonicalOrigin: origin,
    loopbackOriginAliases: true,
    remoteOrigin: async () => remoteOrigin,
  });
  registerHostApi(app, authenticator, {
    ...createConnectionRpcHandlers(oauth),
    "commands.dispatch": async (command, context) => {
      if (command.type !== "connection.authorize" && command.type !== "connection.revoke")
        throw new Error("Unexpected command");
      return rpcSuccess(await handleConnectionCommand(oauth, command, context));
    },
  } as HostApiHandlers);
  const mcp = new McpServer({ name: "connection-authority-test", version: "1" });
  mcp.registerTool("probe", { inputSchema: z.object({}) }, async () => ({
    content: [{ type: "text", text: "Connected" }],
  }));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
  });
  await mcp.connect(transport as unknown as Transport);
  app.addHook("onClose", async () => mcp.close());
  app.post(mcpResourcePath, async (request, reply) => {
    try {
      await oauth.authenticator.authenticate(
        request.headers.authorization?.slice(7) ?? "",
        origin + mcpResourcePath,
      );
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
  const headers = { host: new URL(origin).host, origin, cookie };
  async function begin() {
    const registration = await app.inject({
      method: "POST",
      url: `${mcpIssuerPath}/register`,
      headers,
      payload: { client_name: "Test agent", redirect_uris: [redirectUri] },
    });
    expect(registration.statusCode).toBe(201);
    const clientId: string = registration.json().client_id;
    const query = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: origin + mcpResourcePath,
      state: "client-state",
    });
    const authorization = await app.inject({
      method: "GET",
      url: `${mcpIssuerPath}/authorize?${query}`,
      headers,
    });
    expect(authorization.statusCode).toBe(303);
    const requestId = new URL(authorization.headers.location!, origin).searchParams.get("request")!;
    return { clientId, requestId, query };
  }
  async function authorize(mode: ThreadAccessMode = "approval-required") {
    const { clientId, requestId, query } = await begin();
    const read = await injectRpcRequest(
      app,
      "connections.authorization.get",
      { requestId },
      headers,
    );
    expect(read.statusCode, read.body).toBe(200);
    const approval = await injectRpcRequest(
      app,
      "commands.dispatch",
      {
        type: "connection.authorize",
        requestId,
        idempotencyKey: "consent",
        decision: { kind: "approve", label: "My agent", accessMode: mode },
      },
      headers,
    );
    expect(approval.statusCode, approval.body).toBe(200);
    expect(approval.body).not.toContain("code=");
    const complete = await app.inject({
      method: "GET",
      url: approval.json().data.completionPath,
      headers: { host: headers.host },
    });
    expect(complete.statusCode).toBe(303);
    const redirect = new URL(complete.headers.location!);
    expect(redirect.searchParams.get("state")).toBe("client-state");
    expect(redirect.searchParams.get("iss")).toBe(origin + mcpIssuerPath);
    const code = redirect.searchParams.get("code")!;
    return { code, clientId, requestId, query };
  }
  const exchange = (
    grant: { code: string; clientId: string },
    changes: Record<string, string> = {},
  ) =>
    app.inject({
      method: "POST",
      url: `${mcpIssuerPath}/token`,
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code: grant.code,
        client_id: grant.clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: origin + mcpResourcePath,
        ...changes,
      }).toString(),
    });
  return {
    ...fixture,
    database,
    app,
    oauth,
    identity,
    owner,
    headers,
    connections,
    begin,
    authorize,
    exchange,
    setNow: (value: number) => {
      now = value;
    },
    now: () => now,
    setRemoteOrigin: (value: string | null) => {
      remoteOrigin = value;
    },
  };
}

integration("external MCP OAuth over HTTP", () => {
  it("works without Account or native OAuth on Personal loopback; lists and revokes an open session", async () => {
    const f = await fixture();
    expect(f.identity.nativeOAuthAuthorizationServerMetadata()).toBeNull();
    const challenge = await f.app.inject({
      method: "POST",
      url: mcpResourcePath,
      headers: { host: f.headers.host },
      payload: {},
    });
    expect(challenge.statusCode).toBe(401);
    expect(challenge.headers["www-authenticate"]).toBe(
      `Bearer resource_metadata="${origin}${mcpResourceMetadataPath}"`,
    );
    const grant = await f.authorize("full-access");
    const token = await f.exchange(grant);
    expect(token.statusCode, token.body).toBe(200);
    const bearer: string = token.json().access_token;
    expect(bearer).toMatch(/^ost_mcp_[A-Za-z0-9_-]{43}$/);
    const row = await f.database
      .selectFrom("agentConnections")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.tokenHash).toBe(credentialHash(bearer));
    expect(JSON.stringify(row)).not.toContain(bearer);
    const mcpHeaders = {
      ...f.headers,
      authorization: `Bearer ${bearer}`,
      accept: "application/json, text/event-stream",
    };
    const first = await f.app.inject({
      method: "POST",
      url: mcpResourcePath,
      headers: mcpHeaders,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "External agent", version: "1" },
        },
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers["mcp-session-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.json().result.serverInfo.name).toBe("connection-authority-test");
    await expect(f.oauth.authenticator.authenticate(bearer)).resolves.toMatchObject({
      connectionId: row.id,
      userId: f.owner.user.id,
      accessMode: "full-access",
    });
    const sessionHeaders = {
      ...mcpHeaders,
      "mcp-session-id": first.headers["mcp-session-id"]!,
      "mcp-protocol-version": "2025-03-26",
    };
    const initialized = await f.app.inject({
      method: "POST",
      url: mcpResourcePath,
      headers: sessionHeaders,
      payload: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    expect(initialized.statusCode).toBe(202);
    const tools = await f.app.inject({
      method: "POST",
      url: mcpResourcePath,
      headers: sessionHeaders,
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    });
    expect(tools.statusCode).toBe(200);
    expect(tools.json().result.tools).toMatchObject([{ name: "probe" }]);
    const listed = await injectRpcRequest(f.app, "connections.list", {}, f.headers);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data.connections).toMatchObject([
      { id: row.id, label: "My agent", clientName: "Test agent", lastUsedAt: expect.any(String) },
    ]);
    expect(listed.body).not.toMatch(/tokenHash|token_hash|ost_mcp_|code_verifier/);
    const deniedHost = await injectRpcRequest(
      f.app,
      "connections.list",
      {},
      { ...f.headers, authorization: `Bearer ${bearer}` },
    );
    expect(deniedHost.statusCode).toBe(401);
    const revoke = await injectRpcRequest(
      f.app,
      "commands.dispatch",
      { type: "connection.revoke", connectionId: row.id, idempotencyKey: "revoke" },
      f.headers,
    );
    expect(revoke.statusCode).toBe(200);
    const next = await f.app.inject({
      method: "POST",
      url: mcpResourcePath,
      headers: sessionHeaders,
      payload: { jsonrpc: "2.0", id: 3, method: "tools/list" },
    });
    expect(next.statusCode).toBe(401);
    expect(
      (await injectRpcRequest(f.app, "connections.list", {}, f.headers)).json().data.connections,
    ).toEqual([]);
  });

  it("publishes exact route metadata and refuses unconfigured or removed routes", async () => {
    const f = await fixture();
    f.setRemoteOrigin("https://home.connect.example");
    for (const route of [origin, "http://localhost:4310", "https://home.connect.example"]) {
      const headers = {
        host: new URL(route).host,
        ...(route.startsWith("https:") ? { "x-forwarded-proto": "https" } : {}),
      };
      const resource = await f.app.inject({ method: "GET", url: mcpResourceMetadataPath, headers });
      expect(resource.json()).toMatchObject({
        resource: route + mcpResourcePath,
        authorization_servers: [route + mcpIssuerPath],
      });
      const server = await f.app.inject({ method: "GET", url: mcpServerMetadataPath, headers });
      expect(server.json()).toMatchObject({
        issuer: route + mcpIssuerPath,
        registration_endpoint: `${route}${mcpIssuerPath}/register`,
        code_challenge_methods_supported: ["S256"],
      });
    }
    f.setRemoteOrigin(null);
    const removed = await f.app.inject({
      method: "GET",
      url: mcpResourceMetadataPath,
      headers: { host: "home.connect.example", "x-forwarded-proto": "https" },
    });
    expect(removed.statusCode).toBe(403);
    expect(
      (
        await f.app.inject({
          method: "GET",
          url: mcpResourceMetadataPath,
          headers: { host: "evil.example" },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("burns codes on wrong PKCE, resource, redirect or client binding and refuses reuse", async () => {
    const f = await fixture();
    for (const changes of [
      { code_verifier: "b".repeat(64) },
      { resource: "https://evil.example/internal/v1/mcp" },
      { redirect_uri: "http://127.0.0.1:49211/callback" },
      { client_id: "unregistered" },
    ]) {
      const grant = await f.authorize();
      expect((await f.exchange(grant, changes)).statusCode).toBe(400);
      expect((await f.exchange(grant)).statusCode).toBe(400);
    }
    const grant = await f.authorize();
    expect((await f.exchange(grant)).statusCode).toBe(200);
    expect((await f.exchange(grant)).statusCode).toBe(400);
  });

  it("expires consent, codes and credentials without timers", async () => {
    const f = await fixture();
    const grant = await f.authorize();
    f.setNow(f.now() + 60_001);
    expect((await f.exchange(grant)).statusCode).toBe(400);
    const active = await f.authorize();
    const token = (await f.exchange(active)).json().access_token as string;
    f.setNow(f.now() + 30 * 24 * 60 * 60_000 + 1);
    await expect(f.oauth.authenticator.authenticate(token)).rejects.toMatchObject({
      code: "unauthorized",
    });
    const pending = await f.begin();
    expect(
      (
        await injectRpcRequest(
          f.app,
          "connections.authorization.get",
          { requestId: pending.requestId },
          f.headers,
        )
      ).statusCode,
    ).toBe(200);
    f.setNow(f.now() + 10 * 60_000 + 1);
    expect(
      (
        await injectRpcRequest(
          f.app,
          "connections.authorization.get",
          { requestId: pending.requestId },
          f.headers,
        )
      ).statusCode,
    ).toBe(404);
  });

  it("requires signed-in owner consent, protects mutations from CSRF and denies without a connection", async () => {
    const f = await fixture();
    const registration = f.oauth.register(origin, { redirect_uris: [redirectUri] });
    const query = new URLSearchParams({
      client_id: registration.client_id,
      response_type: "code",
      redirect_uri: redirectUri,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: origin + mcpResourcePath,
    });
    const begin = await f.app.inject({
      method: "GET",
      url: `${mcpIssuerPath}/authorize?${query}`,
      headers: f.headers,
    });
    const requestId = new URL(begin.headers.location!, origin).searchParams.get("request")!;
    const command = {
      type: "connection.authorize",
      requestId,
      idempotencyKey: "deny",
      decision: { kind: "deny" },
    };
    expect(
      (
        await injectRpcRequest(f.app, "commands.dispatch", command, {
          host: f.headers.host,
          origin,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await injectRpcRequest(f.app, "commands.dispatch", command, {
          ...f.headers,
          origin: "https://evil.example",
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: "GET",
          url: `${mcpIssuerPath}/complete?request=${requestId}`,
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(403);
    const denied = await injectRpcRequest(f.app, "commands.dispatch", command, f.headers);
    const complete = await f.app.inject({
      method: "GET",
      url: denied.json().data.completionPath,
      headers: f.headers,
    });
    expect(new URL(complete.headers.location!).searchParams.get("error")).toBe("access_denied");
    expect(await f.connections.list(f.owner.user.id)).toEqual([]);
  });

  it("requires the personal owner and refuses a disabled owner's credential", async () => {
    const f = await fixture();
    const grant = await f.authorize("auto");
    const token = (await f.exchange(grant)).json().access_token as string;
    const caller = await f.oauth.authenticator.authenticate(token);
    const other = await f.store.createUser("Other");
    await expect(f.connections.list(other)).rejects.toMatchObject({ code: "forbidden" });
    await expect(f.connections.revoke(other, caller.connectionId)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(f.oauth.authenticator.authenticate(token)).resolves.toMatchObject({
      connectionId: caller.connectionId,
    });
    await f.database
      .updateTable("users")
      .set({ disabledAt: new Date(f.now()) })
      .where("id", "=", f.owner.user.id)
      .execute();
    await expect(f.oauth.authenticator.authenticate(token)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });
});
