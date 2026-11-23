import { digestSecret } from "@opensteer/shared/secretDigest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { createId, type ThreadAccessMode } from "@opensteer/core";
import {
  agentDirectoryJwtTyp,
  agentDirectoryPath,
  agentDirectoryTokenUse,
  type AgentDirectoryDocument,
} from "@opensteer/control-plane-protocol";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
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
  connectionCommandEffects,
  createConnectionRpcHandlers,
  handleConnectionCommand,
  isConnectionCommand,
  registerConnectionRoutes,
} from "./connection-routes.js";
import { credentialHash } from "./connection-authenticator.js";
import { AgentDirectoryCache } from "./agent-directory.js";

// The integration launcher supplies isolated PostgreSQL; skip only when it is absent.
const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;
const origin = "http://127.0.0.1:4310";
const redirectUri = "http://127.0.0.1:49210/callback";
const verifier = "a".repeat(64);
const testDirectoryIssuer = "https://accounts.example.test";

async function fixture(options: { readonly directory?: AgentDirectoryDocument | null } = {}) {
  const fixture = await createStoreFixture();
  const database = fixture.database;
  let now = Date.now();
  let currentDirectory = options.directory;
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
    initialOwnerEnrollment: {
      tokenDigest: digestSecret(enrollment),
      expiresAt: new Date(now + 60_000),
    },
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
  const startOAuth = () =>
    new ConnectionOAuth({
      deploymentId: deployment.id,
      store: connections,
      signingKey: keys.privateKey,
      verificationKey: keys.publicKey,
      now: () => now,
      ...(options.directory !== undefined
        ? {
            directory: {
              issuer: testDirectoryIssuer,
              get: async () => currentDirectory ?? null,
              current: () => currentDirectory ?? null,
            },
          }
        : {}),
    });
  const oauth = startOAuth();
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
  // The runtime's own effects: Disconnect drives its durable cleanup before it answers.
  const effects = connectionCommandEffects({
    store: fixture.store,
    closeLineage: async () => {},
    onFailure: (error) => {
      throw error;
    },
  });
  registerHostApi(app, authenticator, {
    ...createConnectionRpcHandlers(oauth),
    "commands.dispatch": async (command, context) => {
      if (!isConnectionCommand(command)) throw new Error("Unexpected command");
      return rpcSuccess(await handleConnectionCommand(oauth, command, context, effects));
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
  async function register(redirect = redirectUri) {
    const registration = await app.inject({
      method: "POST",
      url: `${mcpIssuerPath}/register`,
      headers,
      payload: { client_name: "Test agent", redirect_uris: [redirect] },
    });
    expect(registration.statusCode).toBe(201);
    return registration.json().client_id as string;
  }
  /** The authorization request as a client sends it. */
  async function request(
    input: {
      readonly redirect?: string;
      readonly clientId?: string;
      readonly parameters?: Readonly<Record<string, string | undefined>>;
    } = {},
  ) {
    const redirect = input.redirect ?? redirectUri;
    const clientId = input.clientId ?? (await register(redirect));
    const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
    const query = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirect,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      resource: origin + mcpResourcePath,
      state: "client-state",
    });
    for (const [name, value] of Object.entries(input.parameters ?? {})) {
      if (value === undefined) query.delete(name);
      else query.set(name, value);
    }
    const authorization = await app.inject({
      method: "GET",
      url: `${mcpIssuerPath}/authorize?${query}`,
      headers,
    });
    return { clientId, query, authorization };
  }
  async function begin(input: Parameters<typeof request>[0] = {}) {
    const { clientId, query, authorization } = await request(input);
    expect(authorization.statusCode).toBe(303);
    const location = new URL(authorization.headers.location!, origin);
    expect(location.pathname, location.href).toBe("/mcp-authorization");
    const requestId = location.searchParams.get("request")!;
    return { clientId, requestId, query };
  }
  async function authorize(
    mode: ThreadAccessMode = "approval-required",
    input?: Parameters<typeof request>[0],
  ) {
    const { clientId, requestId, query } = await begin(input);
    const read = await injectRpcRequest(
      app,
      "connections.authorization.get",
      { requestId },
      headers,
    );
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().data.grantsAvailable).toBe(true);
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
    return { code, clientId, requestId, query, redirect, consent: read.json().data };
  }
  function exchange(
    grant: { code: string; clientId: string },
    changes: Record<string, string | undefined> = {},
  ) {
    const payload = new URLSearchParams({
      grant_type: "authorization_code",
      code: grant.code,
      client_id: grant.clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: origin + mcpResourcePath,
    });
    for (const [name, value] of Object.entries(changes)) {
      if (value === undefined) payload.delete(name);
      else payload.set(name, value);
    }
    return app.inject({
      method: "POST",
      url: `${mcpIssuerPath}/token`,
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      payload: payload.toString(),
    });
  }
  return {
    ...fixture,
    database,
    app,
    oauth,
    startOAuth,
    identity,
    owner,
    headers,
    connections,
    request,
    begin,
    authorize,
    exchange,
    setDirectory: (document: AgentDirectoryDocument | null) => {
      currentDirectory = document;
    },
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
    expect(listed.json().data.endedConnections).toEqual([]);
    expect(listed.json().data.connections).toMatchObject([
      {
        id: row.id,
        label: "My agent",
        clientName: "Test agent",
        lastUsedAt: expect.any(String),
        // An old client's consent keeps today's authority; the Home records what it can prove.
        grant: { scope: "everything" },
        grantRevision: 1,
        consentVersion: 1,
        state: "active",
        client: {
          fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
          redirectOrigin: expect.any(String),
        },
      },
    ]);
    const renamed = await injectRpcRequest(
      f.app,
      "commands.dispatch",
      {
        type: "connection.update",
        connectionId: row.id,
        expectedRevision: 1,
        label: "Renamed agent",
        idempotencyKey: "rename",
      },
      f.headers,
    );
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().data.connection).toMatchObject({
      label: "Renamed agent",
      grantRevision: 1,
    });
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
    const ended = await injectRpcRequest(f.app, "connections.list", {}, f.headers);
    expect(ended.json().data).toMatchObject({
      connections: [],
      endedConnections: [{ id: row.id, state: "stopped" }],
    });
    expect(
      (
        await injectRpcRequest(f.app, "connections.list", { includeRevoked: true }, f.headers)
      ).json().data.connections,
    ).toMatchObject([{ id: row.id, state: "stopped", revokedAt: expect.any(String) }]);
    const removed = await injectRpcRequest(
      f.app,
      "commands.dispatch",
      { type: "connection.remove", connectionId: row.id, idempotencyKey: "remove" },
      f.headers,
    );
    expect(removed.statusCode, removed.body).toBe(200);
    expect(
      (
        await injectRpcRequest(f.app, "connections.list", { includeRevoked: true }, f.headers)
      ).json().data.connections,
    ).toEqual([]);
  });

  it("registers a desktop client's HTTPS and loopback callbacks and drops custom schemes", async () => {
    const f = await fixture();
    const secure = "https://agent.example/oauth/callback";
    const custom = [
      "cursor://anysphere.cursor/oauth/callback",
      "vscode://vscode.github-authentication/oauth/callback",
    ];
    const register = (redirects: string[]) =>
      f.app.inject({
        method: "POST",
        url: `${mcpIssuerPath}/register`,
        headers: f.headers,
        payload: { client_name: "Desktop agent", redirect_uris: redirects },
      });
    const registration = await register([secure, ...custom, redirectUri]);
    expect(registration.statusCode, registration.body).toBe(201);
    const { client_id: clientId, redirect_uris } = registration.json();
    expect(redirect_uris).toEqual([secure, redirectUri]);
    for (const redirect of [secure, redirectUri]) {
      const { authorization } = await f.request({ clientId, redirect });
      expect(authorization.statusCode).toBe(303);
      expect(authorization.headers.location).toMatch(/^\/mcp-authorization\?/u);
    }
    for (const redirect of [...custom, "https://agent.example/unregistered"]) {
      const { authorization } = await f.request({ clientId, redirect });
      expect(authorization.statusCode).toBe(400);
      expect(authorization.json()).toEqual({ error: "invalid_redirect_uri" });
      expect(authorization.headers.location).toBeUndefined();
    }
    const refused = await register(custom);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: "invalid_client_metadata" });
  });

  it("defaults an omitted MCP resource and accepts a single trailing slash", async () => {
    const f = await fixture();
    const canonical = origin + mcpResourcePath;
    for (const [authorizationResource, tokenResource] of [
      [canonical, undefined],
      [canonical, canonical + "/"],
      [canonical + "/", canonical],
      [undefined, canonical],
    ]) {
      const grant = await f.authorize("approval-required", {
        parameters: { resource: authorizationResource },
      });
      const response = await f.exchange(grant, { resource: tokenResource });
      expect(response.statusCode, response.body).toBe(200);
      const { access_token: token } = response.json();
      const hash = credentialHash(token);
      await expect(f.connections.authenticate(hash, canonical)).resolves.toMatchObject({
        userId: f.owner.user.id,
      });
      await expect(f.connections.authenticate(hash, canonical + "/")).resolves.toBeNull();
    }
    for (const resource of [
      "https://agent.example" + mcpResourcePath,
      canonical + "//",
      canonical + "?other=/",
      canonical + "#/",
      canonical.replace("/v1/", "/v1/./"),
    ]) {
      const { authorization } = await f.request({ parameters: { resource } });
      expect(new URL(authorization.headers.location!).searchParams.get("error")).toBe(
        "invalid_target",
      );
      const grant = await f.authorize();
      const refused = await f.exchange(grant, { resource });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toEqual({ error: "invalid_target" });
      expect((await f.exchange(grant)).json()).toEqual({ error: "invalid_grant" });
    }
  });

  it("grants only opensteer for an empty scope or extra scopes such as offline_access", async () => {
    const f = await fixture();
    for (const scope of ["", "opensteer offline_access", "offline_access"]) {
      const grant = await f.authorize("approval-required", { parameters: { scope } });
      const response = await f.exchange(grant, { scope });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ scope: "opensteer" });
      expect(response.json()).not.toHaveProperty("refresh_token");
    }
    const { authorization: malformed } = await f.request({
      parameters: { scope: 'opensteer "bad"' },
    });
    expect(new URL(malformed.headers.location!).searchParams.get("error")).toBe("invalid_scope");
    for (const parameters of [{ code_challenge: undefined }, { code_challenge_method: "plain" }]) {
      const { authorization } = await f.request({
        parameters: { ...parameters, scope: "opensteer offline_access" },
      });
      expect(new URL(authorization.headers.location!).searchParams.get("error")).toBe(
        "invalid_request",
      );
    }
    const grant = await f.authorize();
    expect((await f.exchange(grant, { code_verifier: undefined })).json()).toEqual({
      error: "invalid_grant",
    });
    expect((await f.exchange(grant)).json()).toEqual({ error: "invalid_grant" });
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
      const root = await f.app.inject({
        method: "GET",
        url: "/.well-known/oauth-authorization-server",
        headers,
      });
      expect(root.statusCode).toBe(200);
      expect(root.json()).toEqual(server.json());
      expect(root.headers["access-control-allow-origin"]).toBe("*");
    }
    f.setRemoteOrigin(null);
    expect(
      (
        await f.app.inject({
          method: "GET",
          url: "/.well-known/oauth-authorization-server",
          headers: { host: "home.connect.example", "x-forwarded-proto": "https" },
        })
      ).statusCode,
    ).toBe(403);
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

  it("stores evidence verified by origin, and ignores any statement a platform would have sent", async () => {
    const directory: AgentDirectoryDocument = {
      revision: 3,
      issuedAt: new Date().toISOString(),
      entries: [{ id: "agentpay", displayName: "AgentPay", origins: ["https://agentpay.example"] }],
    };
    const f = await fixture({ directory });
    const platform = "https://agentpay.example/oauth/callback";
    const read = async (requestId: string) =>
      (
        await injectRpcRequest(f.app, "connections.authorization.get", { requestId }, f.headers)
      ).json().data;
    const verified = await f.begin({ redirect: platform });
    expect(await read(verified.requestId)).toMatchObject({
      identityAtConsent: {
        kind: "platform",
        platformDirectoryId: "agentpay",
        directoryRevision: 3,
      },
      identity: {
        evidenceKind: "platform",
        heading: "AgentPay",
        detail: "https://agentpay.example",
        verified: true,
        origins: [{ role: "platform", origin: "https://agentpay.example" }],
        warning: "Only allow this if you started it yourself.",
      },
    });
    // A statement from an embedding product means nothing: the origin alone verifies.
    const withStatement = await f.begin({
      redirect: platform,
      parameters: { opensteer_embedder_assertion: "a.b.c" },
    });
    expect((await read(withStatement.requestId)).identity).toMatchObject({
      evidenceKind: "platform",
      heading: "AgentPay",
      verified: true,
    });
    expect(
      (await read((await f.begin({ redirect: "https://unknown.example/cb" })).requestId)).identity,
    ).toMatchObject({
      evidenceKind: "unverified",
      heading: "Test agent",
      detail: "https://unknown.example",
      verified: false,
      selfAsserted: true,
    });
    expect((await read((await f.begin()).requestId)).identity).toMatchObject({
      evidenceKind: "unverified",
      detail: "an app on this computer",
      origins: [],
    });

    // What the person was shown is kept on the connection and listed with it.
    const approval = await injectRpcRequest(
      f.app,
      "commands.dispatch",
      {
        type: "connection.authorize",
        requestId: verified.requestId,
        idempotencyKey: "verified-consent",
        decision: { kind: "approve", label: "AgentPay", accessMode: "approval-required" },
      },
      f.headers,
    );
    expect(approval.statusCode, approval.body).toBe(200);
    const listed = (await injectRpcRequest(f.app, "connections.list", {}, f.headers)).json().data
      .connections;
    expect(listed).toMatchObject([
      {
        label: "AgentPay",
        identityAtConsent: { kind: "platform", platformOrigin: "https://agentpay.example" },
        identity: { heading: "AgentPay" },
      },
    ]);
  });
  async function verifiedDirectoryFixture() {
    const callback = "https://platform.example/callback";
    const document: AgentDirectoryDocument = {
      revision: 1,
      issuedAt: new Date().toISOString(),
      entries: [{ id: "platform", displayName: "Platform", origins: ["https://platform.example"] }],
    };
    const f = await fixture({ directory: document });
    await f.connections.acceptDirectory(testDirectoryIssuer, document);
    const withoutPlatform = { ...document, revision: 2, entries: [] };
    return {
      ...f,
      callback,
      document,
      withoutPlatform,
      accept: async (next: AgentDirectoryDocument) => {
        const accepted = await f.connections.acceptDirectory(testDirectoryIssuer, next);
        f.setDirectory(accepted);
        return accepted;
      },
      read: async (requestId: string) => {
        const result = await injectRpcRequest(
          f.app,
          "connections.authorization.get",
          { requestId },
          f.headers,
        );
        expect(result.statusCode, result.body).toBe(200);
        return result.json().data;
      },
      approve: (requestId: string, verificationSnapshot: string) =>
        injectRpcRequest(
          f.app,
          "commands.dispatch",
          {
            type: "connection.authorize",
            requestId,
            idempotencyKey: randomUUID(),
            decision: {
              kind: "approve",
              label: "My agent",
              accessMode: "approval-required",
              verificationSnapshot,
            },
          },
          f.headers,
        ),
    };
  }

  it("withdraws a listed connection when a higher revision no longer lists its origin", async () => {
    const f = await verifiedDirectoryFixture();
    const approved = await f.authorize("approval-required", { redirect: f.callback });
    expect(approved.consent.identityAtConsent).toMatchObject({
      kind: "platform",
      directoryRevision: 1,
    });
    f.setNow(f.now() + 1_000);
    const next = {
      ...f.document,
      revision: 2,
      issuedAt: new Date(f.now()).toISOString(),
      entries: [{ id: "platform", displayName: "Platform", origins: ["https://other.example"] }],
    };
    expect(await f.accept(next)).toEqual(next);
    const result = await injectRpcRequest(f.app, "connections.list", {}, f.headers);
    expect(result.json().data.connections).toMatchObject([
      {
        identityAtConsent: approved.consent.identityAtConsent,
        verificationWithdrawnAt: new Date(f.now()).toISOString(),
      },
    ]);
  });

  it("shows pending consent as unverified when the directory changes before it is read", async () => {
    const f = await verifiedDirectoryFixture();
    const pending = await f.begin({ redirect: f.callback });
    await f.accept(f.withoutPlatform);
    const read = await f.read(pending.requestId);
    expect(read.identity).toMatchObject({ evidenceKind: "unverified", verified: false });
    const approved = await f.approve(pending.requestId, read.verificationSnapshot);
    expect(approved.statusCode, approved.body).toBe(200);
    const list = await injectRpcRequest(f.app, "connections.list", {}, f.headers);
    expect(
      list
        .json()
        .data.connections.map(
          (connection: { identityAtConsent: unknown }) => connection.identityAtConsent,
        ),
    ).toMatchObject([{ kind: "unverified" }]);
    expect(list.json().data.connections[0].verificationWithdrawnAt).toBeUndefined();
  });

  it("refuses the shown verification at approval after a withdrawal, even if another tab reads again", async () => {
    const f = await verifiedDirectoryFixture();
    const pending = await f.begin({ redirect: f.callback });
    const before = await f.read(pending.requestId);
    expect(before.identity.verified).toBe(true);
    // The persisted acceptance can win while the process still holds the prior copy.
    await f.connections.acceptDirectory(testDirectoryIssuer, f.withoutPlatform);
    const during = await f.approve(pending.requestId, before.verificationSnapshot);
    expect(during.statusCode).not.toBe(200);
    expect(during.body).toContain("consent-verification-changed");
    f.setDirectory(f.withoutPlatform);
    const after = await f.read(pending.requestId);
    expect(after.identity.verified).toBe(false);
    expect(after.verificationSnapshot).not.toBe(before.verificationSnapshot);
    const stale = await f.approve(pending.requestId, before.verificationSnapshot);
    expect(stale.statusCode).not.toBe(200);
    expect(stale.body).toContain("consent-verification-changed");
    expect((await f.connections.list(f.owner.user.id)).length).toBe(0);
    const fresh = await f.approve(pending.requestId, after.verificationSnapshot);
    expect(fresh.statusCode, fresh.body).toBe(200);
    const [connection] = await f.connections.list(f.owner.user.id);
    expect(connection?.identityAtConsent?.kind).toBe("unverified");
    expect(connection?.verificationWithdrawnAt).toBeUndefined();
  });

  it("keeps the accepted revision and first withdrawal across a cache restart", async () => {
    const account = "https://accounts.example.test";
    const platform = {
      id: "platform",
      displayName: "Platform",
      origins: ["https://platform.example"],
    };
    const document = { revision: 3, issuedAt: new Date().toISOString(), entries: [platform] };
    const f = await fixture({ directory: document });
    const approved = await f.authorize("approval-required", {
      redirect: "https://platform.example/cb",
    });
    expect(approved.consent.identityAtConsent).toMatchObject({
      kind: "platform",
      directoryRevision: 3,
    });

    const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const jwk = { ...(await exportJWK(publicKey)), alg: "EdDSA", kid: "account" };
    let served = document;
    let unavailable = false;
    const makeCache = () =>
      new AgentDirectoryCache({
        issuer: new URL(account),
        now: f.now,
        refreshIntervalMs: 0,
        storage: {
          load: (issuer) => f.connections.loadDirectory(issuer),
          accept: (issuer, incoming) => f.connections.acceptDirectory(issuer, incoming),
        },
        fetch: async (input) => {
          if (unavailable) return new Response(null, { status: 503 });
          if (String(input) === account + "/api/auth/jwks") return Response.json({ keys: [jwk] });
          expect(String(input)).toBe(account + agentDirectoryPath);
          return Response.json({
            assertion: await new SignJWT({
              ...served,
              tokenUse: agentDirectoryTokenUse,
              iss: account,
              iat: Math.floor(Date.parse(served.issuedAt) / 1000),
            })
              .setProtectedHeader({ alg: "EdDSA", kid: "account", typ: agentDirectoryJwtTyp })
              .sign(privateKey),
          });
        },
      });
    const list = async () =>
      (await injectRpcRequest(f.app, "connections.list", {}, f.headers)).json().data.connections[0];
    const initial = makeCache();
    await initial.start();
    await initial.refresh();
    expect(await f.connections.loadDirectory(account)).toEqual(document);
    expect((await list()).verificationWithdrawnAt).toBeUndefined();
    initial.close();

    const resumed = makeCache();
    served = { ...document, revision: 2 };
    await resumed.start();
    expect(resumed.current()).toEqual(document);
    await resumed.refresh();
    expect(resumed.current()).toEqual(document);
    served = { ...document, entries: [], issuedAt: new Date(f.now() + 1).toISOString() };
    await resumed.refresh();
    expect(resumed.current()).toEqual(document);
    const renewal = { ...document, issuedAt: served.issuedAt };
    served = renewal;
    await resumed.refresh();
    expect(resumed.current()).toEqual(renewal);
    served = document;
    await resumed.refresh();
    expect(resumed.current()).toEqual(renewal);
    expect((await list()).verificationWithdrawnAt).toBeUndefined();

    f.setNow(f.now() + 1_000);
    served = { revision: 4, issuedAt: new Date(f.now()).toISOString(), entries: [] };
    await resumed.refresh();
    const withdrawnAt = new Date(f.now()).toISOString();
    expect(await list()).toMatchObject({
      verificationWithdrawnAt: withdrawnAt,
      identityAtConsent: approved.consent.identityAtConsent,
      state: "active",
    });
    f.setNow(f.now() + 1_000);
    unavailable = true;
    await resumed.refresh();
    expect((await list()).verificationWithdrawnAt).toBe(withdrawnAt);
    unavailable = false;
    served = { revision: 5, issuedAt: new Date(f.now()).toISOString(), entries: [] };
    await resumed.refresh();
    expect((await list()).verificationWithdrawnAt).toBe(withdrawnAt);

    f.setNow(f.now() + 1_000);
    served = { revision: 6, issuedAt: new Date(f.now()).toISOString(), entries: [platform] };
    await resumed.refresh();
    expect((await list()).verificationWithdrawnAt).toBe(withdrawnAt);
    expect(await f.connections.loadDirectory(account)).toEqual(served);
    resumed.close();
  });

  it("sanitizes the client's own name and identifies only the callback that receives the code", async () => {
    const known = "https://platform.example/ready";
    const unknown = "https://unknown.example/return";
    const f = await fixture({
      directory: {
        revision: 1,
        issuedAt: new Date().toISOString(),
        entries: [{ id: "platform", displayName: "Platform", origins: [new URL(known).origin] }],
      },
    });
    const register = (name: string) =>
      f.app.inject({
        method: "POST",
        url: `${mcpIssuerPath}/register`,
        headers: f.headers,
        payload: { client_name: name, redirect_uris: [known, unknown] },
      });
    expect((await register("\u202E\u0008")).statusCode).toBe(400);
    const registration = await register("  Test   \u202Eagent\u2028\u0008  ");
    expect(registration.statusCode).toBe(201);
    expect(registration.json().client_name).toBe("Test agent");
    const clientId = registration.json().client_id;
    for (const [redirect, kind] of [
      [unknown, "unverified"],
      [known, "platform"],
    ] as const) {
      const result = await f.authorize("approval-required", { clientId, redirect });
      expect(result.consent.clientName).toBe("Test agent");
      expect(result.consent.identity.evidenceKind).toBe(kind);
      expect(result.redirect.origin + result.redirect.pathname).toBe(redirect);
      expect(result.code).toBeTruthy();
    }
  });

  it("tells a consent that was already answered from one that expired", async () => {
    const f = await fixture();
    const read = (requestId: string) =>
      injectRpcRequest(f.app, "connections.authorization.get", { requestId }, f.headers);
    const answered = await read((await f.authorize()).requestId);
    expect(answered.statusCode).not.toBe(200);
    expect(answered.body).toContain("consent-answered");
    expect(answered.body).toContain("This agent connection request was already answered.");
    const { requestId } = await f.begin();
    f.setNow(f.now() + 11 * 60_000);
    const expired = await read(requestId);
    expect(expired.statusCode).not.toBe(200);
    expect(expired.body).toContain("consent-expired");
    expect(expired.body).toContain("expired. Start again from the agent.");
  });

  it("keeps the AI engine sign-in profile out of a selected grant, at consent and on edit", async () => {
    const f = await fixture();
    const profile = (name: string, purpose?: "engine-sign-in") =>
      f.store.createBrowserProfile({
        ownerId: f.owner.user.id,
        name,
        idempotencyKey: `profile:${name}`,
        homeRunnerId: null,
        ...(purpose ? { purpose } : {}),
      });
    const signIn = await profile("AI engine sign-in", "engine-sign-in");
    const shopping = await profile("Shopping");
    const selected = (profileId: string) => ({
      scope: "selected" as const,
      tasks: false,
      resources: [{ kind: "browser-profile" as const, profileId }],
    });
    const { requestId } = await f.begin();
    const approve = (key: string, grant: unknown) =>
      injectRpcRequest(
        f.app,
        "commands.dispatch",
        {
          type: "connection.authorize",
          requestId,
          idempotencyKey: key,
          decision: { kind: "approve", label: "My agent", accessMode: "auto", grant },
        },
        f.headers,
      );
    const refused = await approve("with-sign-in", selected(signIn.id));
    expect(refused.statusCode).not.toBe(200);
    expect(refused.body).toContain("engine-sign-in-profile");
    expect(await f.database.selectFrom("agentConnections").select("id").execute()).toEqual([]);
    const approved = await approve("without-sign-in", selected(shopping.id));
    expect(approved.statusCode, approved.body).toBe(200);
    const { id } = await f.database
      .selectFrom("agentConnections")
      .select("id")
      .executeTakeFirstOrThrow();
    const update = (key: string, grant: unknown) =>
      injectRpcRequest(
        f.app,
        "commands.dispatch",
        {
          type: "connection.update",
          connectionId: id,
          expectedRevision: 1,
          idempotencyKey: key,
          grant,
        },
        f.headers,
      );
    const widened = await update("add-sign-in", {
      ...selected(shopping.id),
      resources: [...selected(shopping.id).resources, ...selected(signIn.id).resources],
    });
    expect(widened.statusCode).not.toBe(200);
    expect(widened.body).toContain("engine-sign-in-profile");
    // `everything` is the person's whole authority, so it still reaches that profile.
    const everything = await update("everything", { scope: "everything" });
    expect(everything.statusCode, everything.body).toBe(200);
    // Its answer is the connection as the list draws it, who it is included.
    const listed = await injectRpcRequest(f.app, "connections.list", {}, f.headers);
    const row = listed
      .json()
      .data.connections.find((connection: { readonly id: string }) => connection.id === id);
    expect(row.identity).toBeDefined();
    expect(everything.json().data.connection).toEqual(row);
  });
});
