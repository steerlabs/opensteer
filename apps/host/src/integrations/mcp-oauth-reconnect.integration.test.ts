import { describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { createIntegrationId, McpOAuthAttemptIdSchema } from "@opensteer/integration-core";
import { IntegrationPlatformStore } from "@opensteer/database";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { IntegrationAuthAttemptLifecycle } from "./integration-auth-attempt-service.js";
import {
  createMachineAccessDatabase,
  startMachineAccessHost,
  connectCallerMachine,
  dispatchCallerRun,
  enrollmentToken,
} from "../runtime/machine-access.test-support.js";

const sdk = vi.hoisted(() => {
  class Transport {
    readonly authProvider: OAuthClientProvider;
    finished = false;
    constructor(_url: URL, options: { authProvider: OAuthClientProvider }) {
      this.authProvider = options.authProvider;
    }
    async finishAuth() {
      this.finished = true;
      await this.authProvider.saveTokens({
        access_token: "new-token",
        token_type: "Bearer",
        issuer: "https://accounts.example.test/",
      });
    }
  }
  class Client {
    async connect(transport: Transport) {
      if (transport.finished) return;
      const provider = transport.authProvider;
      await provider.saveDiscoveryState!({
        authorizationServerUrl: "https://accounts.example.test/",
        authorizationServerMetadata: {
          issuer: "https://accounts.example.test",
          authorization_endpoint: "https://accounts.example.test/authorize",
          token_endpoint: "https://accounts.example.test/token",
          response_types_supported: ["code"],
        },
      });
      await provider.saveClientInformation!({
        client_id: "new-client",
        issuer: "https://accounts.example.test/",
      });
      await provider.saveCodeVerifier("v".repeat(43));
      provider.redirectToAuthorization(
        new URL(`https://accounts.example.test/authorize?state=${await provider.state!()}`),
      );
      throw new Error("authorization required");
    }
    async listTools() {
      return {
        tools: [
          {
            name: "search",
            description: "Search",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    }
    async close() {}
  }
  return { Transport, Client };
});
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: sdk.Client }));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: sdk.Transport,
}));

import { McpOAuthService } from "./mcp-oauth-service.js";
import { IntegrationPlatformService } from "./integration-platform-service.js";

const baseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = baseUrl ? describe : describe.skip;

integration("MCP OAuth reconnect", () => {
  it("reconnects an unbound legacy credential in place and fulfills its pinned request", async () => {
    const database = await createMachineAccessDatabase(baseUrl!);
    const closers: Array<() => Promise<unknown>> = [];
    try {
      const host = await startMachineAccessHost(database.url);
      closers.unshift(() => host.close());
      const caller = await connectCallerMachine(host, {
        name: "MCP caller",
        token: await enrollmentToken(host, {
          allowedModules: ["agents"],
          idempotencyKey: "mcp-caller",
          name: "MCP caller",
        }),
      });
      closers.unshift(() => caller.close());
      const main = await host.store.database
        .selectFrom("workspaces")
        .select("id")
        .where("createdBy", "=", host.ownerId)
        .where("kind", "=", "main")
        .executeTakeFirstOrThrow();
      const run = await dispatchCallerRun(host, caller, {
        key: "mcp-reconnect",
        title: "Reconnect MCP",
        workspaceId: main.id,
      });
      closers.unshift(() => run.complete());
      const store = new IntegrationPlatformStore(host.store.database);
      const installationId = createIntegrationId("installation"),
        serverId = createIntegrationId("server"),
        connectionId = createIntegrationId("connection");
      const installation = {
        description: "Test MCP",
        id: installationId,
        manifest: {},
        name: "mcp-test",
        provenance: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
        sourceKind: "remote-mcp" as const,
        status: "active" as const,
        title: "Test MCP",
        trust: "administrator-approved" as const,
        version: null,
      };
      const server = {
        connectionRequirement: { kind: "mcp-oauth" as const },
        id: serverId,
        name: "default",
        status: "active" as const,
        statusDetail: null,
        catalog: { definitions: {}, tools: [] },
        transport: {
          headers: {},
          type: "streamable-http" as const,
          url: "https://mcp.example.test/mcp",
        },
      };
      await store.install({
        actorUserId: host.ownerId,
        adapterSnapshot: null,
        installation,
        requestId: "install-mcp-reconnect",
        servers: [server],
      });
      await host.store.database
        .insertInto("integrationConnections")
        .values({
          accountIdentifier: null,
          applicationSource: null,
          authMethodId: null,
          authorizationDigest: null,
          capabilities: sql`'[]'::jsonb`,
          runnerId: null,
          connectionKind: "mcp-oauth",
          connectionMethod: "managed-oauth",
          credentialId: null,
          displayName: "Existing",
          externalIdentityId: null,
          externalTenantId: null,
          grantedScopes: sql`'[]'::jsonb`,
          id: connectionId,
          integrationDefinitionId: null,
          integrationServerId: serverId,
          ownerUserId: host.ownerId,
          provider: `mcp:${serverId}`,
          providerApplicationId: null,
          status: "connected",
          statusDetail: null,
          transportKind: null,
          updatedAt: new Date(),
        })
        .executeTakeFirstOrThrow();
      const legacyState = {
        clientInformation: { client_id: "legacy", client_secret: "old-secret" },
        tokens: { access_token: "old-token", refresh_token: "old-refresh", token_type: "Bearer" },
      };
      await host.store.database
        .insertInto("mcpOAuthCredentials")
        .values({
          connectionId,
          encryptedState: Buffer.from(JSON.stringify({ state: JSON.stringify(legacyState) })),
          encryptionKeyVersion: 1,
          revision: 1,
          updatedAt: new Date(),
        })
        .executeTakeFirstOrThrow();
      const grant = await store.createGrant({
        access: "read",
        alias: "Existing",
        connectionId,
        createdBy: host.ownerId,
        installationId,
        isDefault: true,
        ownerUserId: host.ownerId,
        providerAuthorizations: {},
        workspaceId: run.workspaceId,
      });
      let savedPayload: Readonly<Record<string, string>> = {};
      let attemptId: ReturnType<typeof createIntegrationId<"mcpOauthAttempt">> | undefined;
      const attempts = {
        begin: async (input: Parameters<IntegrationAuthAttemptLifecycle["begin"]>[0]) => {
          attemptId = McpOAuthAttemptIdSchema.parse(input.id);
          const built = await input.payload("s".repeat(43));
          savedPayload = built.payload;
          return {
            attemptId,
            expiresAt: new Date(Date.now() + 60_000),
            launchTicket: "t".repeat(43),
            state: "s".repeat(43),
          };
        },
        claim: async () => ({
          id: attemptId!,
          ownerUserId: host.ownerId,
          payload: savedPayload,
          surface: "desktop" as const,
        }),
        fail: vi.fn(async () => undefined),
      };
      const vault = {
        open: vi.fn(async (envelope: Buffer) => JSON.parse(envelope.toString())),
        seal: vi.fn(async (value: Record<string, string>) => ({
          envelope: Buffer.from(JSON.stringify(value)),
          keyVersion: 1,
        })),
      };
      let platform!: IntegrationPlatformService;
      const oauth = new McpOAuthService({
        attempts: attempts as never,
        exposure: "loopback",
        publicUrl: new URL(host.origin),
        store,
        vault: vault as never,
        onConnectionConnected: (input) => platform.connectionConnected(input).then(() => undefined),
      });
      platform = new IntegrationPlatformService({
        store,
        mcpOauth: oauth,
        adapters: [],
        definitions: [],
        dataDirectory: "/tmp",
        listConnections: async () => [],
        authorizationSource: { providerAuthorizations: async () => ({}) },
        credentialMaterializer: {} as never,
        computerApps: {} as never,
        onWorkspaceEvent: () => {},
        onConnectionsChanged: () => {},
        onRequestsChanged: () => {},
        isRunnerConnected: () => true,
      });
      const callable = {
        installation: { ...installation, title: "Test MCP" },
        server,
        grant: { connectionId, ownerUserId: host.ownerId },
        tool: { name: "search", title: "Search" },
      } as never;
      await expect(platform.callTool(callable, {}, {} as never)).rejects.toThrow(
        /authorization is required/i,
      );
      expect(
        await host.store.database
          .selectFrom("integrationConnections")
          .select("status")
          .where("id", "=", connectionId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: "needs-attention" });
      const request = await store.requests.createIntegrationAccessRequest({
        access: "read",
        callId: "mcp-reconnect-request",
        installationId,
        originatingRunId: run.runId,
        originatingThreadId: run.threadId,
        originatingWorkspaceId: run.workspaceId,
        reason: "Reconnect",
        requestedBy: host.ownerId,
        requestedConnectionId: connectionId,
        requestedServerId: serverId,
        targetWorkspaceId: run.workspaceId,
      });
      const started = await oauth.beginAuthorization({
        displayName: "Existing",
        ownerUserId: host.ownerId,
        requestId: request.request.id,
        requestSurface: "canonical",
        returnPath: "/",
        serverId,
        surface: "desktop",
      });
      const now = new Date();
      await host.store.database
        .insertInto("integrationAuthAttempts")
        .values({
          id: started.attemptId,
          flow: "mcp-oauth",
          ownerUserId: host.ownerId,
          stateHash: "a".repeat(43),
          launchTicketHash: "b".repeat(43),
          browserBindingHash: "c".repeat(43),
          encryptedPayload: Buffer.from("attempt"),
          encryptionKeyVersion: 1,
          status: "claimed",
          surface: "desktop",
          failureReason: null,
          resultConnectionId: null,
          expiresAt: new Date(now.getTime() + 60_000),
          launchedAt: now,
          claimedAt: now,
          completedAt: null,
          createdAt: now,
        })
        .executeTakeFirstOrThrow();
      const result = await oauth.handleAuthorizationCallback({
        attemptId: started.attemptId,
        browserBinding: "b".repeat(43),
        parameters: new URLSearchParams({ code: "code", state: "s".repeat(43) }),
        state: "s".repeat(43),
      });
      expect(result).toMatchObject({ status: "completed", connectionId });
      expect(await store.requests.get(request.request.id)).toMatchObject({ status: "fulfilled" });
      expect(
        await store.getMcpOAuthConnection({ connectionId, ownerUserId: host.ownerId, serverId }),
      ).toMatchObject({ revision: 2 });
      expect(
        await store.listGrants({ ownerUserId: host.ownerId, workspaceId: run.workspaceId }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: grant.id, connectionId, status: "active" }),
        ]),
      );
      expect(attempts.fail).not.toHaveBeenCalled();
      await platform.close();
    } finally {
      for (const close of closers) await close();
      await database.drop();
    }
  }, 120_000);
});
