import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
  recordTestDatabaseSetup,
} from "./test-database.test-support.js";
import { pauseAfterLock } from "./lock-race.test-support.js";
import { createComputerAppApproval } from "@opensteer/runner-auth";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  IntegrationDefinitionSchema,
  createIntegrationId,
  integrationDefinitionSummary,
  isComputerAppDefinition,
  type ComputerAppIdentity,
} from "@opensteer/integration-core";
import type { ComputerAppDefinition } from "@opensteer/integration-core/computer-app";
import { computerAppTools } from "@opensteer/integration-core/computer-app-tools";
import { integrationDefinitionDigest } from "@opensteer/integration-core/digest";
import {
  type RunId,
  type ThreadId,
  HarnessIdSchema,
  ModelSelectionSchema,
  ThreadAccessModeSchema,
  createId,
  type RequestId,
} from "@opensteer/core";
import {
  HarnessInstanceCatalogSchema,
  type PendingAgentEvent,
  type RunnerDescriptor,
} from "@opensteer/protocol";
import { CamelCasePlugin, Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import type { DatabaseSchema } from "./schema.js";
import { describe, expect, it as baseIt } from "vitest";
import {
  ChannelStore,
  createDatabase,
  IntegrationInstallStore,
  IntegrationPlatformStore,
  IntegrationStore,
  OpensteerStore,
} from "./index.js";
import { jsonValue } from "./store-primitives.js";
import { agentPhoneOwnerAccessMigration } from "./migrations.js";
import {
  installIntegrationInTransaction,
  revokeComputerConnectionsInTransaction,
} from "./integration-platform-stores.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration.sequential("PostgreSQL integration installation lookups", () => {
  async function createTestFixture() {
    const clone = await cloneTestDatabase("host");
    const databaseUrl = clone.url;
    const { database } = await ownTestDatabaseProducer(databaseUrl, async () => {
      const database = createDatabase({
        applicationName: "opensteer-integration-installation-test",
        connectionString: databaseUrl,
        maxConnections: 2,
      });
      return { database, close: () => database.destroy() };
    });
    const installations = new IntegrationInstallStore(database);

    return Object.freeze({ database, installations, databaseUrl });
  }
  type StoreFixture = Awaited<ReturnType<typeof createTestFixture>>;
  const it = baseIt.extend<{ storeFixture: StoreFixture }>({
    storeFixture: async ({ task }, use) => {
      const started = performance.now();
      const fixture = await createTestFixture();
      recordTestDatabaseSetup(task, started);
      await use(fixture);
    },
  });

  it("reads an installed definition back by definition id", async ({ storeFixture }) => {
    const { installations, database } = storeFixture;
    const definition = IntegrationDefinitionSchema.parse({
      adapter: "openapi",
      authMethods: [
        {
          id: "api-key",
          inputs: [{ label: "API key", secret: true, variable: "apiKey" }],
          kind: "api-key",
          label: "Proposed API key",
          placements: [
            { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "apiKey" },
          ],
        },
      ],
      config: { specUrl: "https://api.proposed.test/openapi.json", timeoutMs: 30_000 },
      description: "Researched by an agent and approved by an administrator",
      id: "proposed-inventory",
      name: "Proposed inventory",
      provider: "proposed-inventory",
    });
    await installations.install({
      actorUserId: null,
      adapterSnapshot: {
        adapter: "openapi",
        config: definition.config as Readonly<Record<string, unknown>>,
        definitionId: definition.id,
      },
      installation: {
        description: definition.description,
        id: createIntegrationId("installation"),
        manifest: { definition: integrationDefinitionSummary(definition) },
        name: definition.id,
        provenance: { artifactDigest: "d".repeat(43), proposalKind: "openapi" },
        sourceKind: "proposed",
        status: "active",
        title: definition.name,
        trust: "administrator-approved",
        version: "d".repeat(43),
      },
      requestId: "install-proposed-inventory",
      servers: [
        {
          connectionRequirement: {
            definitionId: definition.id,
            kind: "provider",
            provider: definition.provider,
            providerApplicationRequired: false,
          },
          id: createIntegrationId("server"),
          name: "default",
          status: "active",
          statusDetail: null,
          catalog: { definitions: {}, tools: [] },
          transport: { adapter: "openapi", definitionId: definition.id, type: "adapter" },
        },
      ],
    });

    // The adapter config is never in the manifest, so a full definition proves both halves loaded.
    await expect(installations.findInstalledDefinition(definition.id)).resolves.toEqual(definition);
    await expect(installations.findInstalledDefinition("proposed-absent")).resolves.toBeNull();

    for (const status of ["disabled", "needs-attention"] as const) {
      await database
        .updateTable("integrationInstallations")
        .set({ status })
        .where("name", "=", definition.id)
        .execute();
      await expect(installations.findInstalledDefinition(definition.id)).rejects.toThrow(
        "Installed integration is unavailable",
      );
      await expect(
        installations.findInstalledDefinition(definition.id, { allowUnavailable: true }),
      ).resolves.toEqual(definition);
    }
  });
});

integration.sequential("PostgreSQL integration uninstall", () => {
  async function createTestFixture() {
    const clone = await cloneTestDatabase("host");
    const databaseUrl = clone.url;
    const { database } = await ownTestDatabaseProducer(databaseUrl, async () => {
      const database = createDatabase({
        applicationName: "opensteer-integration-uninstall-test",
        connectionString: databaseUrl,
        maxConnections: 4,
      });
      return { database, close: () => database.destroy() };
    });
    const platform = new IntegrationPlatformStore(database);
    const store = new OpensteerStore(database);
    async function stagedRequestRace(
      lock: (
        transaction: import("kysely").Transaction<import("./schema.js").DatabaseSchema>,
      ) => Promise<unknown>,
      first: () => Promise<unknown>,
      second: () => Promise<unknown>,
    ) {
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const blocker = database.transaction().execute(async (transaction) => {
        await lock(transaction);
        held.resolve();
        await release.promise;
      });
      await held.promise;
      const waiters = (count: number) =>
        expect
          .poll(async () => {
            const result = await sql<{
              waiting: number;
            }>`select count(*)::integer as waiting from pg_stat_activity
        where datname = current_database() and application_name = 'opensteer-integration-uninstall-test' and wait_event_type = 'Lock'`.execute(
              database,
            );
            return result.rows[0]!.waiting;
          })
          .toBeGreaterThanOrEqual(count);
      const a = first();
      void a.catch(() => undefined);
      let b: Promise<unknown> | undefined;
      try {
        await waiters(1);
        b = second();
        void b.catch(() => undefined);
        await waiters(2);
      } finally {
        release.resolve();
        await blocker;
      }
      const results = await Promise.allSettled([a, b!]);
      for (const result of results) {
        if (result.status === "rejected")
          expect(result.reason).toMatchObject({
            code: expect.stringMatching(/^(conflict|forbidden|not_found)$/),
          });
      }
      expect(results.some(({ status }) => status === "fulfilled")).toBe(true);
      return results;
    }

    return Object.freeze({ database, platform, store, stagedRequestRace, databaseUrl });
  }
  type StoreFixture = Awaited<ReturnType<typeof createTestFixture>>;
  const it = baseIt.extend<{ storeFixture: StoreFixture }>({
    storeFixture: async ({ task }, use) => {
      const started = performance.now();
      const fixture = await createTestFixture();
      recordTestDatabaseSetup(task, started);
      await use(fixture);
    },
  });

  it("orders provider tool reconciliation with grant creation without a deadlock", async ({
    storeFixture,
  }) => {
    const { store, platform, database } = storeFixture;
    const userId = await store.createUser("Provider race owner");
    const workspace = await createWorkspace(store, userId, "provider-lock-order");
    const installationId = createIntegrationId("installation");
    const serverId = createIntegrationId("server");
    const connectionId = createIntegrationId("connection");
    const credentialId = createId("credential");
    const tool = { ...discoveredTool(createIntegrationId("tool")), connectionId };
    await platform.install({
      actorUserId: userId,
      adapterSnapshot: {
        adapter: "openapi",
        config: { specUrl: "https://api.records.test/openapi.json" },
        definitionId: "records-catalog",
      },
      installation: catalogInstallation(installationId),
      requestId: "provider-lock-order-install",
      servers: [
        {
          connectionRequirement: {
            definitionId: "records-catalog",
            kind: "provider",
            provider: "records-catalog",
            providerApplicationRequired: false,
          },
          id: serverId,
          name: "default",
          status: "active",
          statusDetail: null,
          catalog: { definitions: {}, tools: [] },
          transport: { adapter: "openapi", definitionId: "records-catalog", type: "adapter" },
        },
      ],
    });
    await insertCredential(database, credentialId, userId);
    await insertProviderConnection(database, {
      connectionId,
      credentialId,
      definitionId: "records-catalog",
      ownerUserId: userId,
    });
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pausedQueries = new Set<object>();
    const grantStore = new IntegrationPlatformStore(
      database.withPlugin({
        transformQuery(args) {
          const node = JSON.stringify(args.node);
          if (
            args.node.kind === "SelectQueryNode" &&
            /"name":"integration_?servers"/iu.test(node) &&
            node.includes("ForShare")
          )
            pausedQueries.add(args.queryId);
          return args.node;
        },
        async transformResult(args) {
          if (pausedQueries.delete(args.queryId)) {
            held.resolve();
            await release.promise;
          }
          return args.result;
        },
      }),
    );
    const granting = grantStore.createGrant({
      access: "read",
      alias: "records",
      connectionId,
      createdBy: userId,
      installationId,
      isDefault: true,
      ownerUserId: userId,
      providerAuthorizations: {},
      workspaceId: workspace.id,
    });
    void granting.catch(() => undefined);
    let reconciling: Promise<void> | undefined;
    try {
      await held.promise;
      reconciling = platform.reconcileProviderConnectionTools({
        connectionId,
        definitionId: "records-catalog",
        ownerUserId: userId,
        serverId,
        catalog: { definitions: {}, tools: [tool] },
      });
      void reconciling.catch(() => undefined);
      await expect
        .poll(async () =>
          (
            await sql<{ query: string }>`select query from pg_stat_activity
        where datname = current_database() and application_name = 'opensteer-integration-uninstall-test'
        and wait_event_type = 'Lock'`.execute(database)
          ).rows.some(({ query }) => query.includes('from "integration_servers"')),
        )
        .toBe(true);
      release.resolve();
      const outcomes = await Promise.allSettled([granting, reconciling]);
      expect(outcomes.filter(({ status }) => status === "rejected")).toEqual([]);
      expect(
        await database
          .selectFrom("integrationGrants")
          .select("id")
          .where("workspaceId", "=", workspace.id)
          .execute(),
      ).toHaveLength(1);
      expect(
        await database
          .selectFrom("integrationTools")
          .select("id")
          .where("connectionId", "=", connectionId)
          .execute(),
      ).toEqual([{ id: tool.id }]);
    } finally {
      release.resolve();
      await Promise.allSettled([granting, reconciling]);
    }
  });

  it("removes the installation and its dependents while catalog accounts survive", async ({
    storeFixture,
  }) => {
    const { store, platform, database } = storeFixture;
    const userId = await store.createUser("Catalog owner");
    const workspace = await createWorkspace(store, userId, "catalog-uninstall");
    const installationId = createIntegrationId("installation");
    const serverId = createIntegrationId("server");
    const tool = discoveredTool(createIntegrationId("tool"));
    const skillId = createIntegrationId("skill");
    await platform.install({
      actorUserId: userId,
      adapterSnapshot: {
        adapter: "openapi",
        config: { specUrl: "https://api.records.test/openapi.json" },
        definitionId: "records-catalog",
      },
      installation: catalogInstallation(installationId),
      requestId: "install-records-catalog",
      servers: [
        {
          connectionRequirement: {
            definitionId: "records-catalog",
            kind: "provider",
            provider: "records",
            providerApplicationRequired: false,
          },
          id: serverId,
          name: "default",
          status: "active",
          statusDetail: null,
          catalog: { definitions: {}, tools: [tool] },
          transport: { adapter: "openapi", definitionId: "records-catalog", type: "adapter" },
        },
      ],
      skills: [
        {
          description: "Draft a record summary",
          digest: "s".repeat(43),
          id: skillId,
          name: "record-summary",
          status: "active",
        },
      ],
    });
    const connectionId = createIntegrationId("connection");
    const credentialId = createId("credential");
    await insertCredential(database, credentialId, userId);
    await insertProviderConnection(database, {
      connectionId,
      credentialId,
      definitionId: "records-catalog",
      ownerUserId: userId,
    });
    const grantId = createIntegrationId("grant");
    await database
      .insertInto("integrationGrants")
      .values({
        access: "read",
        alias: "records",
        connectionId,
        createdBy: userId,
        id: grantId,
        installationId,
        isDefault: false,
        ownerUserId: userId,
        revokedAt: null,
        status: "active",
        updatedAt: new Date(),
        workspaceId: workspace.id,
      })
      .executeTakeFirstOrThrow();

    const mutation = await platform.uninstall({
      actorUserId: userId,
      installationId,
      requestId: "uninstall-records-catalog",
    });

    expect(mutation).toMatchObject({
      cancelledRequestIds: [],
      removedConnectionIds: [],
      removedServerIds: [serverId],
    });
    await expect(platform.listInstallations()).resolves.toEqual([]);
    await expect(countRows(database, "integrationServers")).resolves.toBe(0);
    await expect(countRows(database, "integrationTools")).resolves.toBe(0);
    await expect(countRows(database, "integrationSkills")).resolves.toBe(0);
    await expect(countRows(database, "integrationGrants")).resolves.toBe(0);
    // The catalog definition still exists, so the account it authorizes stays usable.
    await expect(countRows(database, "integrationConnections")).resolves.toBe(1);
    await expect(countRows(database, "credentials")).resolves.toBe(1);
    await expect(
      database
        .selectFrom("securityAudit")
        .select("action")
        .where("targetId", "=", installationId)
        .orderBy("createdAt", "desc")
        .limit(1)
        .executeTakeFirst(),
    ).resolves.toEqual({ action: "integration.installation.removed" });
  });

  it("removes the accounts of a proposed definition with the installation", async ({
    storeFixture,
  }) => {
    const { store, platform, database } = storeFixture;
    const userId = await store.createUser("Proposal owner");
    const installationId = createIntegrationId("installation");
    const serverId = createIntegrationId("server");
    await platform.install({
      actorUserId: userId,
      adapterSnapshot: {
        adapter: "openapi",
        config: { specUrl: "https://api.proposed.test/openapi.json" },
        definitionId: "proposed-inventory",
      },
      installation: {
        description: "Researched by an agent",
        id: installationId,
        manifest: {
          definition: {
            adapter: "openapi",
            authMethods: [
              {
                id: "api-key",
                inputs: [{ label: "API key", secret: true, variable: "apiKey" }],
                kind: "api-key",
                label: "Proposed API key",
                placements: [
                  {
                    carrier: "header",
                    name: "Authorization",
                    prefix: "Bearer ",
                    variable: "apiKey",
                  },
                ],
              },
            ],
            description: "Researched by an agent",
            id: "proposed-inventory",
            name: "Proposed inventory",
            provider: "proposed-inventory",
          },
        },
        name: "proposed-inventory",
        provenance: { artifactDigest: "d".repeat(43), proposalKind: "openapi" },
        sourceKind: "proposed",
        status: "active",
        title: "Proposed inventory",
        trust: "administrator-approved",
        version: "d".repeat(43),
      },
      requestId: "install-proposed-inventory",
      servers: [
        {
          connectionRequirement: {
            definitionId: "proposed-inventory",
            kind: "provider",
            provider: "proposed-inventory",
            providerApplicationRequired: false,
          },
          id: serverId,
          name: "default",
          status: "active",
          statusDetail: null,
          catalog: { definitions: {}, tools: [] },
          transport: { adapter: "openapi", definitionId: "proposed-inventory", type: "adapter" },
        },
      ],
    });
    const connectionId = createIntegrationId("connection");
    const credentialId = createId("credential");
    await insertCredential(database, credentialId, userId);
    await insertProviderConnection(database, {
      connectionId,
      credentialId,
      definitionId: "proposed-inventory",
      ownerUserId: userId,
    });

    const mutation = await platform.uninstall({
      actorUserId: userId,
      installationId,
      requestId: "uninstall-proposed-inventory",
    });

    expect(mutation.removedConnectionIds).toEqual([connectionId]);
    await expect(countRows(database, "integrationConnections")).resolves.toBe(0);
    // The secret has nothing left that could use it.
    await expect(countRows(database, "credentials")).resolves.toBe(0);
  });

  it("removes the MCP account bound to an uninstalled server", async ({ storeFixture }) => {
    const { store, platform, database } = storeFixture;
    const userId = await store.createUser("MCP owner");
    const installationId = createIntegrationId("installation");
    const serverId = createIntegrationId("server");
    await platform.install({
      actorUserId: userId,
      adapterSnapshot: null,
      installation: {
        description: "The team MCP server",
        id: installationId,
        manifest: {},
        name: "team-mcp",
        provenance: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
        sourceKind: "remote-mcp",
        status: "active",
        title: "Team MCP",
        trust: "administrator-approved",
        version: null,
      },
      requestId: "install-team-mcp",
      servers: [
        {
          connectionRequirement: { kind: "mcp-oauth" },
          id: serverId,
          name: "default",
          status: "active",
          statusDetail: null,
          catalog: { definitions: {}, tools: [] },
          transport: { headers: {}, type: "streamable-http", url: "https://mcp.example.test/mcp" },
        },
      ],
    });
    const connectionId = createIntegrationId("connection");
    await database
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
        displayName: "Team MCP",
        externalIdentityId: null,
        externalTenantId: null,
        grantedScopes: sql`'[]'::jsonb`,
        id: connectionId,
        integrationDefinitionId: null,
        integrationServerId: serverId,
        ownerUserId: userId,
        provider: `mcp:${serverId}`,
        providerApplicationId: null,
        status: "connected",
        statusDetail: null,
        transportKind: null,
        updatedAt: new Date(),
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("mcpOAuthCredentials")
      .values({
        connectionId,
        encryptedState: Buffer.from("mcp-oauth-state"),
        encryptionKeyVersion: 1,
        revision: 1,
        updatedAt: new Date(),
      })
      .executeTakeFirstOrThrow();

    const mutation = await platform.uninstall({
      actorUserId: userId,
      installationId,
      requestId: "uninstall-team-mcp",
    });

    expect(mutation.removedConnectionIds).toEqual([connectionId]);
    await expect(countRows(database, "integrationConnections")).resolves.toBe(0);
    await expect(countRows(database, "mcpOAuthCredentials")).resolves.toBe(0);
  });

  it("avoids a deadlock between integration uninstall and Request withdrawal", async ({
    storeFixture,
  }) => {
    const { store, platform, stagedRequestRace } = storeFixture;
    const fixture = await runningRunFixture(store, "uninstall-requests");
    const installationId = createIntegrationId("installation");
    const serverId = createIntegrationId("server");
    await platform.install({
      actorUserId: fixture.userId,
      adapterSnapshot: null,
      installation: catalogInstallation(installationId),
      requestId: "install-records-for-requests",
      servers: [
        {
          connectionRequirement: { kind: "none" },
          id: serverId,
          name: "default",
          status: "active",
          statusDetail: null,
          catalog: { definitions: {}, tools: [] },
          transport: { headers: {}, type: "streamable-http", url: "https://records.example.test" },
        },
      ],
    });
    const opened = await platform.requests.createIntegrationAccessRequest({
      access: "read",
      callId: "uninstall-pending-access",
      installationId,
      originatingRunId: fixture.runId,
      originatingThreadId: fixture.threadId,
      originatingWorkspaceId: fixture.workspaceId,
      reason: "Read the records before the uninstall",
      requestedBy: fixture.userId,
      requestedServerId: serverId,
      targetWorkspaceId: fixture.workspaceId,
    });

    const results = await stagedRequestRace(
      (transaction) =>
        transaction
          .selectFrom("requests")
          .select("id")
          .where("id", "=", opened.request.id)
          .forUpdate()
          .execute(),
      () =>
        platform.uninstall({
          actorUserId: fixture.userId,
          installationId,
          requestId: "uninstall-race",
        }),
      () =>
        store.requests.withdraw({
          requestId: opened.request.id,
          threadId: fixture.threadId,
          withdrawnBy: fixture.userId,
        }),
    );
    expect(results[0]!.status).toBe("fulfilled");
    expect((await store.requests.get(opened.request.id))?.status).toBe("cancelled");
  });

  it("cancels pending access Requests and detaches resolved ones", async ({ storeFixture }) => {
    const { store, platform, database } = storeFixture;
    const fixture = await runningRunFixture(store, "uninstall-requests");
    const installationId = createIntegrationId("installation");
    const serverId = createIntegrationId("server");
    await platform.install({
      actorUserId: fixture.userId,
      adapterSnapshot: null,
      installation: catalogInstallation(installationId),
      requestId: "install-records-for-requests",
      servers: [
        {
          connectionRequirement: { kind: "none" },
          id: serverId,
          name: "default",
          status: "active",
          statusDetail: null,
          catalog: { definitions: {}, tools: [] },
          transport: { headers: {}, type: "streamable-http", url: "https://records.example.test" },
        },
      ],
    });
    const opened = await platform.requests.createIntegrationAccessRequest({
      access: "read",
      callId: "uninstall-pending-access",
      installationId,
      originatingRunId: fixture.runId,
      originatingThreadId: fixture.threadId,
      originatingWorkspaceId: fixture.workspaceId,
      reason: "Read the records before the uninstall",
      requestedBy: fixture.userId,
      requestedServerId: serverId,
      targetWorkspaceId: fixture.workspaceId,
    });

    const mutation = await platform.uninstall({
      actorUserId: fixture.userId,
      installationId,
      requestId: "uninstall-records-with-request",
    });

    expect(mutation.cancelledRequestIds).toEqual([opened.request.id]);
    expect(mutation.requestEvents).toEqual([
      expect.objectContaining({
        data: { reason: "resource-deleted", requestId: opened.request.id },
        type: "request.cancelled",
      }),
    ]);
    await expect(platform.requests.get(opened.request.id)).resolves.toMatchObject({
      cancellationReason: "resource-deleted",
      status: "cancelled",
    });
    // The Request keeps its history; only the binding to the removed rows goes.
    await expect(
      database
        .selectFrom("integrationRequestDetails")
        .select(["installationId", "requestedServerId"])
        .where("requestId", "=", opened.request.id)
        .executeTakeFirst(),
    ).resolves.toEqual({ installationId: null, requestedServerId: null });
  });
});

integration.sequential("PostgreSQL computer app connections", () => {
  async function createTestFixture() {
    type TaskAsk = Omit<
      Parameters<typeof platform.requestComputerAppAccess>[0],
      "auditRequestId" | "tools"
    > &
      Partial<Pick<Parameters<typeof platform.requestComputerAppAccess>[0], "tools">>;
    const clone = await cloneTestDatabase("host");
    const databaseUrl = clone.url;
    const { database } = await ownTestDatabaseProducer(databaseUrl, async () => {
      const database = createDatabase({
        applicationName: "opensteer-computer-app-connections-test",
        connectionString: databaseUrl,
        maxConnections: 4,
      });
      return { database, close: () => database.destroy() };
    });
    const store = new OpensteerStore(database);
    const platform = new IntegrationPlatformStore(database);
    const definition = IntegrationDefinitionSchema.parse({
      adapter: "computer",
      authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
      config: {
        accessLabels: { read: "Read only", readWrite: "Read and send" },
        accessSummaries: {
          read: "Agents can read messages.",
          readWrite: "Agents can read and send messages.",
        },
        operations: [
          {
            description: "Read messages",
            effect: "read",
            inputSchema: { type: "object" },
            name: "read_messages",
            outputSchema: { type: "object" },
            title: "Read messages",
          },
          {
            description: "Send a message",
            effect: "write",
            inputSchema: { type: "object" },
            name: "send_message",
            outputSchema: { type: "object" },
            title: "Send message",
          },
        ],
        platforms: ["darwin"],
      },
      description: "Messages on an enrolled Mac",
      id: "apple-messages",
      name: "Messages",
      provider: "apple",
    });
    if (!isComputerAppDefinition(definition))
      throw new Error("Computer definition fixture is invalid");
    const computerDefinition: ComputerAppDefinition = definition;
    const computerKeys = new Map<
      string,
      { privateKey: import("node:crypto").KeyObject; publicKey: import("node:crypto").KeyObject }
    >();
    const runnerKeys = new Map<string, { privateKey: import("node:crypto").KeyObject }>();
    async function setApprovedComputerConnection(
      input: Omit<
        Parameters<typeof platform.setComputerConnection>[0],
        "app" | "definitionDigest"
      > & {
        readonly app?: ComputerAppIdentity | null;
      },
    ) {
      const definitionDigest = integrationDefinitionDigest(definition);
      const app = input.app ?? null;
      const ownership = await store.effectiveMachineOwners([input.runnerId]);
      const key = computerKeys.get(input.runnerId);
      if (!key || ownership.get(input.runnerId)?.effectiveOwner !== input.actorUserId) {
        return platform.setComputerConnection({ ...input, app, definitionDigest });
      }
      const { request } = await platform.requestComputerAppSetup({
        ...input,
        app,
        definitionDigest,
        requiresApp: app !== null,
      });
      return platform.setComputerConnection({
        ...input,
        app,
        definitionDigest,
        approval: createComputerAppApproval(key.privateKey, request),
      });
    }
    async function fixture(
      suffix: string,
      existingOwnerUserId?: ReturnType<typeof createId<"user">>,
    ) {
      if (!(await store.getDeployment())) {
        await store.ensureDeployment({
          canonicalOrigin: "https://computer-apps.test.invalid",
          deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
          hostInstanceId: createId("hostInstance"),
        });
      }
      const ownerUserId = existingOwnerUserId ?? (await store.createUser(`Owner ${suffix}`));
      const runnerId = createId("runner");
      await insertComputerRunner(runnerId, ownerUserId, `Mac ${suffix}`);
      const installationId = createIntegrationId("installation");
      const serverId = createIntegrationId("server");
      await platform.install({
        actorUserId: ownerUserId,
        adapterSnapshot: null,
        installation: {
          description: definition.description,
          id: installationId,
          manifest: { definition: integrationDefinitionSummary(definition) },
          name: definition.id,
          provenance: { definitionId: definition.id, maintainedBy: "opensteer" },
          sourceKind: "built-in",
          status: "active",
          title: definition.name,
          trust: "built-in",
          version: "fixture",
        },
        requestId: `install-${suffix}`,
        servers: [
          {
            connectionRequirement: { definitionId: definition.id, kind: "computer" },
            id: serverId,
            name: "default",
            status: "active",
            statusDetail: null,
            catalog: { definitions: {}, tools: [] },
            transport: { definitionId: definition.id, type: "computer" },
          },
        ],
      });
      const tools =
        (access: "read" | "read-write") => (connectionId: Parameters<typeof computerAppTools>[2]) =>
          computerAppTools(computerDefinition, access, connectionId);
      return { installationId, ownerUserId, runnerId, serverId, tools };
    }
    async function insertComputerRunner(
      runnerId: ReturnType<typeof createId<"runner">>,
      ownerUserId: ReturnType<typeof createId<"user">> | null,
      name: string,
      ownerKind: "deployment" | "user" = "user",
    ) {
      const keys = generateKeyPairSync("ed25519");
      runnerKeys.set(runnerId, keys);
      const approvalKey = generateKeyPairSync("ed25519");
      computerKeys.set(runnerId, approvalKey);
      await database
        .insertInto("runners")
        .values({
          accessPolicy: jsonValue({
            commands: false,
            forwarding: false,
            reach: "nobody",
            shares: [],
          }),
          accessPolicyRevision: 1,
          allowedModules: jsonValue(["integrations", "shell"]),
          capabilities: jsonValue([]),
          connectionGeneration: 0,
          enrolledAt: new Date(),
          enrollmentTokenHash: `sha256:${runnerId}`,
          id: runnerId,
          kind: ownerKind === "user" ? "local" : "managed",
          lastSeenAt: null,
          maxConcurrentRuns: null,
          moduleDescriptors: jsonValue({}),
          name,
          ownerKind,
          ownerUserId,
          publicKeyFingerprint: `sha256:key-${runnerId}`,
          publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
          revokedAt: null,
        })
        .executeTakeFirstOrThrow();
      // The owner set computer use up on this Mac, which registered its key.
      if (ownerUserId !== null) {
        await platform.registerComputerUseApprovalKey({
          ownerUserId,
          publicKey: approvalKey.publicKey.export({ format: "pem", type: "spki" }).toString(),
          requestId: `register-${runnerId}`,
          runnerId,
        });
      }
    }
    async function insertLineageThread(
      sibling: ThreadId,
      profile: "workspace" | "delegated",
      parentThreadId: ThreadId | null,
    ): Promise<ThreadId> {
      const id = createId("thread");
      const lineageRoot = parentThreadId
        ? (
            await database
              .selectFrom("threads")
              .select("lineageRootThreadId")
              .where("id", "=", parentThreadId)
              .executeTakeFirstOrThrow()
          ).lineageRootThreadId
        : id;
      await sql`
      insert into threads (
        id, workspace_id, parent_thread_id, title, environment_id, harness_instance_id,
        created_by, capability_profile_id, created_by_principal_id, model_selection,
        access_mode, lineage_root_thread_id, listed, color
      )
      select ${id}, workspace_id, ${parentThreadId}, ${`Lineage ${id}`}, environment_id,
        harness_instance_id, created_by, ${profile}, created_by_principal_id, model_selection,
        access_mode, ${lineageRoot}, ${parentThreadId === null}, color
      from threads where id = ${sibling}
    `.execute(database);
      return id;
    }
    const guiDefinition = IntegrationDefinitionSchema.parse({
      adapter: "computer",
      authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
      config: {
        accessLabels: { read: "Can see", readWrite: "Can see and control" },
        accessSummaries: {
          read: "Agents can see this app.",
          readWrite: "Agents can see and control this app.",
        },
        kind: "gui",
        operations: [
          {
            description: "Observe the app",
            effect: "read",
            inputSchema: { type: "object" },
            name: "observe",
            outputSchema: { type: "object" },
            title: "Observe",
          },
          {
            description: "Act in the app",
            effect: "write",
            inputSchema: { type: "object" },
            name: "act",
            outputSchema: { type: "object" },
            title: "Act",
          },
        ],
        platforms: ["darwin"],
      },
      description: "One app on an enrolled Mac",
      id: "macos-app",
      name: "Computer use",
      provider: "apple",
    });
    if (!isComputerAppDefinition(guiDefinition)) throw new Error("GUI fixture is invalid");
    const computerUseDefinition: ComputerAppDefinition = guiDefinition;
    const guiDigest = integrationDefinitionDigest(guiDefinition);
    const notes: ComputerAppIdentity = {
      bundleId: "com.apple.Notes",
      displayName: "Notes",
      teamId: null,
    };
    const calendar: ComputerAppIdentity = {
      bundleId: "com.apple.iCal",
      displayName: "Calendar",
      teamId: "APPLE00001",
    };
    async function guiFixture(
      suffix: string,
      existingOwnerUserId?: ReturnType<typeof createId<"user">>,
    ) {
      const base = await fixture(suffix, existingOwnerUserId);
      const installationId = createIntegrationId("installation");
      const serverId = createIntegrationId("server");
      await platform.install({
        actorUserId: base.ownerUserId,
        adapterSnapshot: null,
        installation: {
          description: guiDefinition.description,
          id: installationId,
          manifest: { definition: integrationDefinitionSummary(guiDefinition) },
          name: guiDefinition.id,
          provenance: { definitionId: guiDefinition.id, maintainedBy: "opensteer" },
          sourceKind: "built-in",
          status: "active",
          title: guiDefinition.name,
          trust: "built-in",
          version: "fixture",
        },
        requestId: `install-gui-${suffix}`,
        servers: [
          {
            connectionRequirement: { definitionId: guiDefinition.id, kind: "computer" },
            id: serverId,
            name: "default",
            status: "active",
            statusDetail: null,
            catalog: { definitions: {}, tools: [] },
            transport: { definitionId: guiDefinition.id, type: "computer" },
          },
        ],
      });
      const guiTools =
        (access: "read" | "read-write") => (connectionId: Parameters<typeof computerAppTools>[2]) =>
          computerAppTools(computerUseDefinition, access, connectionId);
      return { ...base, gui: { installationId, serverId, tools: guiTools } };
    }
    function guiInput(input: {
      readonly access: "read" | "read-write";
      readonly actorUserId: ReturnType<typeof createId<"user">>;
      readonly app: ComputerAppIdentity;
      readonly requestId: string;
      readonly runnerId: ReturnType<typeof createId<"runner">>;
      readonly tools: (
        connectionId: Parameters<typeof computerAppTools>[2],
      ) => readonly import("@opensteer/integration-core").IntegrationToolMaterial[];
    }) {
      return {
        access: input.access,
        actorUserId: input.actorUserId,
        app: input.app,
        createIfMissing: true,
        definitionDigest: guiDigest,
        definitionId: guiDefinition.id,
        requestId: input.requestId,
        runnerId: input.runnerId,
        tools: input.tools,
      };
    }
    async function approveApp(input: Parameters<typeof guiInput>[0]) {
      const shaped = guiInput(input);
      const { request } = await platform.requestComputerAppSetup({
        access: shaped.access,
        actorUserId: shaped.actorUserId,
        app: shaped.app,
        definitionDigest: guiDigest,
        definitionId: guiDefinition.id,
        requiresApp: true,
        runnerId: shaped.runnerId,
      });
      return platform.setComputerConnection({
        ...shaped,
        approval: createComputerAppApproval(computerKeys.get(shaped.runnerId)!.privateKey, request),
      });
    }
    async function allowAutomatic(setup: Awaited<ReturnType<typeof guiFixture>>) {
      const { request } = await platform.requestComputerAppSetup({
        kind: "policy",
        appApproval: "automatic",
        actorUserId: setup.ownerUserId,
        runnerId: setup.runnerId,
        definitionDigest: guiDigest,
      });
      expect(request).toMatchObject({ kind: "policy", policyAppApproval: "automatic", app: null });
      const approval = createComputerAppApproval(
        computerKeys.get(setup.runnerId)!.privateKey,
        request,
      );
      const input = {
        runnerId: setup.runnerId,
        ownerUserId: setup.ownerUserId,
        requestId: "policy-on",
        appApproval: "automatic" as const,
        definitionDigest: guiDigest,
        approval,
      };
      await expect(
        platform.setComputerUsePolicy({
          ...input,
          approval: { ...approval, signature: "a".repeat(86) },
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      const policy = await platform.setComputerUsePolicy(input);
      return { input, policy, request };
    }
    function askForApp(input: TaskAsk) {
      return platform.requestComputerAppAccess({
        auditRequestId: "task-ask",
        tools: () => [],
        ...input,
      });
    }
    async function askOnMac(input: TaskAsk) {
      const decision = await askForApp(input);
      if (decision.kind !== "computer")
        throw new Error(`Expected a Mac approval, got ${decision.kind}`);
      return decision;
    }
    async function waitForLockWaiters(count: number): Promise<void> {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const { rows } = await sql<{ waiting: string }>`
        select count(*)::text as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
      `.execute(database);
        if (Number(rows[0]?.waiting ?? 0) >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Fewer than ${count} sessions ever waited on a lock.`);
    }

    return Object.freeze({
      database,
      store,
      platform,
      definition,
      computerDefinition,
      computerKeys,
      runnerKeys,
      setApprovedComputerConnection,
      fixture,
      insertComputerRunner,
      insertLineageThread,
      guiDefinition,
      computerUseDefinition,
      guiDigest,
      notes,
      calendar,
      guiFixture,
      guiInput,
      approveApp,
      allowAutomatic,
      askForApp,
      askOnMac,
      waitForLockWaiters,
      databaseUrl,
    });
  }
  type StoreFixture = Awaited<ReturnType<typeof createTestFixture>>;
  const it = baseIt.extend<{ storeFixture: StoreFixture }>({
    storeFixture: async ({ task }, use) => {
      const started = performance.now();
      const fixture = await createTestFixture();
      recordTestDatabaseSetup(task, started);
      await use(fixture);
    },
  });

  /**
   * Each Mac's desktop approval key, registered by its owner — what signs the
   * person's consent. The Runner authenticates with a different key, in
   * `runnerKeys`, which signs nothing the Host takes as consent.
   */

  it("requires the target key, consumes once, and invalidates approval on remote reductions", async ({
    storeFixture,
  }) => {
    const { fixture, definition, platform, computerKeys, database } = storeFixture;
    const setup = await fixture("approval");
    const definitionDigest = integrationDefinitionDigest(definition);
    const input = {
      access: "read-write" as const,
      actorUserId: setup.ownerUserId,
      app: null,
      createIfMissing: true,
      definitionDigest,
      definitionId: definition.id,
      requiresApp: false,
      requestId: "approval",
      runnerId: setup.runnerId,
      tools: setup.tools("read-write"),
    };
    await expect(platform.setComputerConnection(input)).rejects.toMatchObject({
      code: "forbidden",
    });
    const { request } = await platform.requestComputerAppSetup(input);
    expect(await platform.listComputerAppSetupRequests(setup.ownerUserId)).toEqual([request]);
    const bad = createComputerAppApproval(generateKeyPairSync("ed25519").privateKey, request);
    await expect(platform.setComputerConnection({ ...input, approval: bad })).rejects.toMatchObject(
      { code: "forbidden" },
    );
    const approval = createComputerAppApproval(
      computerKeys.get(setup.runnerId)!.privateKey,
      request,
    );
    const connected = await platform.setComputerConnection({ ...input, approval });
    expect(await platform.listComputerAppSetupRequests(setup.ownerUserId)).toEqual([]);
    await expect(platform.setComputerConnection({ ...input, approval })).rejects.toMatchObject({
      code: "forbidden",
    });
    const { request: pending } = await platform.requestComputerAppSetup(input);
    const stale = createComputerAppApproval(computerKeys.get(setup.runnerId)!.privateKey, pending);
    await platform.setComputerConnection({ ...input, access: "read", tools: setup.tools("read") });
    await expect(
      platform.setComputerConnection({ ...input, approval: stale }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const { request: afterReduction } = await platform.requestComputerAppSetup(input);
    const afterReductionProof = createComputerAppApproval(
      computerKeys.get(setup.runnerId)!.privateKey,
      afterReduction,
    );
    await platform.revokeComputerConnection({
      connectionId: connected.connection.id,
      ownerUserId: setup.ownerUserId,
      requestId: "off",
    });
    await expect(
      platform.setComputerConnection({ ...input, approval: afterReductionProof }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const { request: afterOff } = await platform.requestComputerAppSetup(input);
    const restarted = new IntegrationPlatformStore(database);
    expect(await restarted.listComputerAppSetupRequests(setup.ownerUserId)).toEqual([afterOff]);
    await restarted.cancelComputerAppSetup({
      requestId: afterOff.id,
      ownerUserId: setup.ownerUserId,
    });
    await expect(
      platform.setComputerConnection({
        ...input,
        approval: createComputerAppApproval(computerKeys.get(setup.runnerId)!.privateKey, afterOff),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("consumes a signed same-access setup request without changing the connection ceiling", async ({
    storeFixture,
  }) => {
    const { fixture, definition, platform, computerKeys, database } = storeFixture;
    const setup = await fixture("same-access");
    const definitionDigest = integrationDefinitionDigest(definition);
    const input = {
      access: "read-write" as const,
      actorUserId: setup.ownerUserId,
      app: null,
      createIfMissing: true,
      definitionDigest,
      definitionId: definition.id,
      requiresApp: false,
      runnerId: setup.runnerId,
      tools: setup.tools("read-write"),
    };
    const { request: first } = await platform.requestComputerAppSetup(input);
    const connected = await platform.setComputerConnection({
      ...input,
      approval: createComputerAppApproval(computerKeys.get(setup.runnerId)!.privateKey, first),
      requestId: "same-access-create",
    });

    const { request: pending } = await platform.requestComputerAppSetup(input);
    expect(await platform.listComputerAppSetupRequests(setup.ownerUserId)).toEqual([pending]);
    const proof = createComputerAppApproval(computerKeys.get(setup.runnerId)!.privateKey, pending);
    const finished = await platform.setComputerConnection({
      ...input,
      approval: proof,
      requestId: "same-access-finish",
    });
    expect(finished.created).toBe(false);
    expect(finished.connection.id).toBe(connected.connection.id);
    expect(finished.connection.computer?.access).toBe("read-write");
    expect(await platform.listComputerAppSetupRequests(setup.ownerUserId)).toEqual([]);
    await expect(
      platform.setComputerConnection({
        ...input,
        approval: proof,
        requestId: "same-access-replay",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const { request: replaced } = await platform.requestComputerAppSetup(input);
    const staleProof = createComputerAppApproval(
      computerKeys.get(setup.runnerId)!.privateKey,
      replaced,
    );
    const { request: replacement } = await platform.requestComputerAppSetup({
      ...input,
      definitionDigest: "changed-catalog-digest",
    });
    expect(replacement.id).not.toBe(replaced.id);
    await expect(
      platform.setComputerConnection({
        ...input,
        approval: staleProof,
        requestId: "same-access-replaced",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const { request: current } = await platform.requestComputerAppSetup(input);
    await database
      .updateTable("computerAppSetupRequests")
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where("id", "=", current.id)
      .execute();
    await expect(
      platform.setComputerConnection({
        ...input,
        approval: createComputerAppApproval(computerKeys.get(setup.runnerId)!.privateKey, current),
        requestId: "same-access-expired",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      (
        await database
          .selectFrom("integrationConnections")
          .select("computerAccess")
          .where("id", "=", connected.connection.id)
          .executeTakeFirstOrThrow()
      ).computerAccess,
    ).toBe("read-write");
  });

  it("creates idempotently, widens, narrows, and preserves retained tool ids", async ({
    storeFixture,
  }) => {
    const {
      fixture,
      setApprovedComputerConnection,
      definition,
      database,
      platform,
      computerDefinition,
    } = storeFixture;
    const setup = await fixture("lifecycle");
    const created = await setApprovedComputerConnection({
      access: "read",
      actorUserId: setup.ownerUserId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "computer-create",
      runnerId: setup.runnerId,
      tools: setup.tools("read"),
    });
    expect(created.created).toBe(true);
    expect(created.connection).toMatchObject({
      authorizationDigest: null,
      computer: { access: "read", runnerId: setup.runnerId },
      connectionMethod: "computer",
      displayName: "Mac lifecycle",
    });
    const readTool = await database
      .selectFrom("integrationTools")
      .select(["id", "name"])
      .where("connectionId", "=", created.connection.id)
      .executeTakeFirstOrThrow();

    const repeated = await setApprovedComputerConnection({
      access: "read",
      actorUserId: setup.ownerUserId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "computer-repeat",
      runnerId: setup.runnerId,
      tools: setup.tools("read"),
    });
    expect(repeated).toMatchObject({ created: false, connection: { id: created.connection.id } });

    await setApprovedComputerConnection({
      access: "read-write",
      actorUserId: setup.ownerUserId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "computer-widen",
      runnerId: setup.runnerId,
      tools: setup.tools("read-write"),
    });
    expect(
      await database
        .selectFrom("integrationTools")
        .select(["id", "name"])
        .where("connectionId", "=", created.connection.id)
        .orderBy("name", "asc")
        .execute(),
    ).toEqual([
      { id: readTool.id, name: "read_messages" },
      expect.objectContaining({ name: "send_message" }),
    ]);

    await setApprovedComputerConnection({
      access: "read",
      actorUserId: setup.ownerUserId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "computer-narrow",
      runnerId: setup.runnerId,
      tools: setup.tools("read"),
    });
    await expect(
      database
        .selectFrom("integrationTools")
        .select(["id", "name"])
        .where("connectionId", "=", created.connection.id)
        .execute(),
    ).resolves.toEqual([{ id: readTool.id, name: "read_messages" }]);

    const generation = await database
      .selectFrom("integrationServers")
      .select("toolGeneration")
      .where("id", "=", setup.serverId)
      .executeTakeFirstOrThrow();
    await platform.install({
      actorUserId: setup.ownerUserId,
      adapterSnapshot: null,
      computerConnectionTools: (connectionId, access) =>
        computerAppTools(computerDefinition, access, connectionId),
      installation: {
        description: definition.description,
        id: setup.installationId,
        manifest: { definition: integrationDefinitionSummary(definition) },
        name: definition.id,
        provenance: { definitionId: definition.id, maintainedBy: "opensteer" },
        sourceKind: "built-in",
        status: "active",
        title: definition.name,
        trust: "built-in",
        version: "fixture-rematerialized",
      },
      requestId: "install-lifecycle-rematerialized",
      servers: [
        {
          connectionRequirement: { definitionId: definition.id, kind: "computer" },
          id: setup.serverId,
          name: "default",
          status: "active",
          statusDetail: null,
          catalog: { definitions: {}, tools: [] },
          transport: { definitionId: definition.id, type: "computer" },
        },
      ],
    });
    await expect(
      database
        .selectFrom("integrationServers")
        .select("toolGeneration")
        .where("id", "=", setup.serverId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ toolGeneration: generation.toolGeneration + 1 });
    await expect(
      database
        .selectFrom("integrationTools")
        .select(["id", "name"])
        .where("connectionId", "=", created.connection.id)
        .execute(),
    ).resolves.toEqual([{ id: readTool.id, name: "read_messages" }]);
  });

  it("returns the locked computer name when an offline app has no connection to update", async ({
    storeFixture,
  }) => {
    const { fixture, setApprovedComputerConnection, definition, database } = storeFixture;
    const setup = await fixture("offline-create");

    await expect(
      setApprovedComputerConnection({
        access: "read",
        actorUserId: setup.ownerUserId,
        createIfMissing: false,
        definitionId: definition.id,
        requestId: "computer-offline-create",
        runnerId: setup.runnerId,
        tools: setup.tools("read"),
      }),
    ).rejects.toMatchObject({
      name: "ComputerAppNotOfferedError",
      runnerName: "Mac offline-create",
    });
    await expect(
      database
        .selectFrom("integrationConnections")
        .select("id")
        .where("runnerId", "=", setup.runnerId)
        .execute(),
    ).resolves.toEqual([]);
  });

  it("serializes a double create, permits recreation after revoke, and enforces ownership", async ({
    storeFixture,
  }) => {
    const { fixture, store, setApprovedComputerConnection, definition, platform } = storeFixture;
    const setup = await fixture("concurrent");
    const foreignUserId = await store.createUser("Foreign owner");
    await expect(
      setApprovedComputerConnection({
        access: "read",
        actorUserId: foreignUserId,
        createIfMissing: true,
        definitionId: definition.id,
        requestId: "computer-foreign",
        runnerId: setup.runnerId,
        tools: setup.tools("read"),
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Only the person who added this computer can turn its apps on.",
    });
    // Concurrent setup requests can share one single-use approval. Its second
    // consumption must fail; a later fresh approval may safely find the same connection.
    const settled = await Promise.allSettled(
      ["a", "b"].map((suffix) =>
        setApprovedComputerConnection({
          access: "read",
          actorUserId: setup.ownerUserId,
          createIfMissing: true,
          definitionId: definition.id,
          requestId: `computer-concurrent-${suffix}`,
          runnerId: setup.runnerId,
          tools: setup.tools("read"),
        }),
      ),
    );
    const fulfilled = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const rejected = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(fulfilled.filter(({ created }) => created)).toHaveLength(1);
    expect(new Set(fulfilled.map(({ connection }) => connection.id)).size).toBe(1);
    for (const reason of rejected) {
      expect(reason).toMatchObject({
        code: "forbidden",
        message: "Approve this access in Opensteer on the computer that provides the app.",
      });
    }
    const firstId = fulfilled[0]!.connection.id;
    await platform.revokeComputerConnection({
      connectionId: firstId,
      ownerUserId: setup.ownerUserId,
      requestId: "computer-revoke",
    });
    const recreated = await setApprovedComputerConnection({
      access: "read",
      actorUserId: setup.ownerUserId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "computer-recreate",
      runnerId: setup.runnerId,
      tools: setup.tools("read"),
    });
    expect(recreated.created).toBe(true);
    expect(recreated.connection.id).not.toBe(firstId);
  });

  it.for(["installation", "connection"] as const)(
    "fences grant creation before rechecking its %s parent",
    async (parent, { storeFixture }) => {
      const { fixture, setApprovedComputerConnection, definition, store, database, platform } =
        storeFixture;
      const setup = await fixture(`grant-parent-${parent}`);
      const connected = await setApprovedComputerConnection({
        access: "read",
        actorUserId: setup.ownerUserId,
        createIfMissing: true,
        definitionId: definition.id,
        requestId: "grant-parent-connect",
        runnerId: setup.runnerId,
        tools: setup.tools("read"),
      });
      const workspace = await createWorkspace(store, setup.ownerUserId, "grant-parent-workspace");
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const blocker = database.transaction().execute(async (transaction) => {
        if (parent === "installation") {
          await transaction
            .selectFrom("integrationInstallations")
            .select("id")
            .where("id", "=", setup.installationId)
            .forNoKeyUpdate()
            .execute();
        } else {
          await transaction
            .selectFrom("integrationConnections")
            .select("id")
            .where("id", "=", connected.connection.id)
            .forNoKeyUpdate()
            .execute();
        }
        held.resolve();
        await release.promise;
        if (parent === "installation") {
          await transaction
            .updateTable("integrationInstallations")
            .set({ status: "disabled" })
            .where("id", "=", setup.installationId)
            .execute();
        } else {
          await transaction
            .updateTable("integrationConnections")
            .set({ status: "revoked" })
            .where("id", "=", connected.connection.id)
            .execute();
        }
      });
      await held.promise;
      let settled = false;
      const creating = platform.createGrant({
        access: "read",
        alias: "Messages",
        connectionId: connected.connection.id,
        createdBy: setup.ownerUserId,
        installationId: setup.installationId,
        isDefault: true,
        ownerUserId: setup.ownerUserId,
        providerAuthorizations: {},
        workspaceId: workspace.id,
      });
      void creating.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const waiters = async () =>
        (
          await sql<{ query: string }>`select query from pg_stat_activity
      where datname = current_database() and application_name = 'opensteer-computer-app-connections-test'
      and wait_event_type = 'Lock'`.execute(database)
        ).rows;
      try {
        await expect.poll(async () => settled || (await waiters()).length > 0).toBe(true);
        expect(settled).toBe(false);
        expect(
          (await waiters()).some(
            ({ query }) =>
              query.startsWith("select") &&
              query.includes(
                `from "integration_${parent === "installation" ? "installations" : "connections"}"`,
              ),
          ),
        ).toBe(true);
        release.resolve();
        await blocker;
        await expect(creating).rejects.toMatchObject({
          code: parent === "installation" ? "conflict" : "forbidden",
        });
        expect(
          await database
            .selectFrom("integrationGrants")
            .select("id")
            .where("workspaceId", "=", workspace.id)
            .execute(),
        ).toEqual([]);
      } finally {
        release.resolve();
        await blocker;
        await Promise.allSettled([creating]);
      }
    },
  );

  it("renames live connections and revokes their tools and grants with the computer", async ({
    storeFixture,
  }) => {
    const { fixture, setApprovedComputerConnection, definition, store, platform, database } =
      storeFixture;
    const setup = await fixture("rename-revoke");
    const connected = await setApprovedComputerConnection({
      access: "read",
      actorUserId: setup.ownerUserId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "computer-connect",
      runnerId: setup.runnerId,
      tools: setup.tools("read"),
    });
    await store.renameRunner(setup.runnerId, setup.ownerUserId, "Renamed Mac");
    await expect(
      platform.getComputerConnectionForCall({
        connectionId: connected.connection.id,
        ownerUserId: setup.ownerUserId,
      }),
    ).resolves.toMatchObject({ connection: { displayName: "Renamed Mac" } });
    const workspace = await createWorkspace(store, setup.ownerUserId, "computer-grant");
    await platform.createGrant({
      access: "read",
      alias: "Messages",
      connectionId: connected.connection.id,
      createdBy: setup.ownerUserId,
      installationId: setup.installationId,
      isDefault: true,
      ownerUserId: setup.ownerUserId,
      providerAuthorizations: {},
      workspaceId: workspace.id,
    });
    const foreignUserId = await store.createUser("Foreign grant owner");
    await expect(
      platform.createGrant({
        access: "read",
        alias: "Someone else's Messages",
        connectionId: connected.connection.id,
        createdBy: foreignUserId,
        installationId: setup.installationId,
        isDefault: false,
        ownerUserId: foreignUserId,
        providerAuthorizations: {},
        workspaceId: workspace.id,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const revoked = await store.revokeRunner(setup.runnerId, setup.ownerUserId);
    expect(revoked.revokedComputerConnectionIds).toEqual([connected.connection.id]);
    await expect(
      database
        .selectFrom("integrationTools")
        .select("id")
        .where("connectionId", "=", connected.connection.id)
        .execute(),
    ).resolves.toEqual([]);
    await expect(
      database
        .selectFrom("integrationGrants")
        .select("status")
        .where("connectionId", "=", connected.connection.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "revoked" });
    await expect(
      database
        .selectFrom("integrationConnections")
        .select(["runnerId", "status"])
        .where("id", "=", connected.connection.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ runnerId: setup.runnerId, status: "revoked" });
  });

  it("rejects unavailable definitions and runners outside the effective owner", async ({
    storeFixture,
  }) => {
    const { fixture, setApprovedComputerConnection, insertComputerRunner, definition, database } =
      storeFixture;
    const setup = await fixture("refusals");
    await expect(
      setApprovedComputerConnection({
        access: "read",
        actorUserId: setup.ownerUserId,
        createIfMissing: true,
        definitionId: "not-installed",
        requestId: "computer-missing-definition",
        runnerId: setup.runnerId,
        tools: setup.tools("read"),
      }),
    ).rejects.toMatchObject({ code: "not_found", message: "not-installed is not installed" });

    const deploymentRunnerId = createId("runner");
    await insertComputerRunner(deploymentRunnerId, null, "Shared worker", "deployment");
    await expect(
      setApprovedComputerConnection({
        access: "read",
        actorUserId: setup.ownerUserId,
        createIfMissing: true,
        definitionId: definition.id,
        requestId: "computer-unowned-runner",
        runnerId: deploymentRunnerId,
        tools: setup.tools("read"),
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Only the person who added this computer can turn its apps on.",
    });

    const revokedRunnerId = createId("runner");
    await insertComputerRunner(revokedRunnerId, setup.ownerUserId, "Revoked Mac");
    await database
      .updateTable("runners")
      .set({ revokedAt: new Date() })
      .where("id", "=", revokedRunnerId)
      .executeTakeFirstOrThrow();
    await expect(
      setApprovedComputerConnection({
        access: "read",
        actorUserId: setup.ownerUserId,
        createIfMissing: true,
        definitionId: definition.id,
        requestId: "computer-revoked-runner",
        runnerId: revokedRunnerId,
        tools: setup.tools("read"),
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    await database
      .updateTable("integrationInstallations")
      .set({ status: "needs-attention" })
      .where("id", "=", setup.installationId)
      .executeTakeFirstOrThrow();
    await expect(
      setApprovedComputerConnection({
        access: "read",
        actorUserId: setup.ownerUserId,
        createIfMissing: true,
        definitionId: definition.id,
        requestId: "computer-disabled-definition",
        runnerId: setup.runnerId,
        tools: setup.tools("read"),
      }),
    ).rejects.toMatchObject({ code: "not_found", message: "Messages is not installed" });
  });

  it("fulfils pending Main access only when the computer ceiling covers it", async ({
    storeFixture,
  }) => {
    const { store, fixture, platform, setApprovedComputerConnection, definition } = storeFixture;
    const run = await runningRunFixture(store, "computer-request-fulfillment");
    const setup = await fixture("request-fulfillment", run.userId);
    const request = (access: "read" | "read-write", callId: string) =>
      platform.requests.createIntegrationAccessRequest({
        access,
        callId,
        installationId: setup.installationId,
        originatingRunId: run.runId,
        originatingThreadId: run.threadId,
        originatingWorkspaceId: run.workspaceId,
        reason: `Need ${access} Messages access`,
        requestedBy: run.userId,
        requestedServerId: setup.serverId,
        targetWorkspaceId: run.workspaceId,
      });

    const read = await request("read", "computer-request-read");
    const created = await setApprovedComputerConnection({
      access: "read",
      actorUserId: setup.ownerUserId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "computer-request-create",
      runnerId: setup.runnerId,
      tools: setup.tools("read"),
    });
    expect(created.requestEvents).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          request: expect.objectContaining({ id: read.request.id }),
        }),
      }),
    ]);
    await expect(platform.requests.get(read.request.id)).resolves.toMatchObject({
      status: "fulfilled",
    });

    const write = await request("read-write", "computer-request-write");
    const unchanged = await setApprovedComputerConnection({
      access: "read",
      actorUserId: setup.ownerUserId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "computer-request-still-read",
      runnerId: setup.runnerId,
      tools: setup.tools("read"),
    });
    expect(unchanged.requestEvents).toEqual([]);
    await expect(platform.requests.get(write.request.id)).resolves.toMatchObject({
      status: "pending",
    });
    const widened = await setApprovedComputerConnection({
      access: "read-write",
      actorUserId: setup.ownerUserId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "computer-request-widen",
      runnerId: setup.runnerId,
      tools: setup.tools("read-write"),
    });
    expect(widened.requestEvents).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          request: expect.objectContaining({ id: write.request.id }),
        }),
      }),
    ]);
    await expect(platform.requests.get(write.request.id)).resolves.toMatchObject({
      status: "fulfilled",
    });

    const stillActionable = await request("read", "computer-request-survives-machine-removal");
    const revoked = await store.revokeRunner(setup.runnerId, setup.ownerUserId);
    expect(revoked.cancelledRequestIds).toEqual([]);
    expect(revoked.requestEvents).toEqual([]);
    await expect(platform.requests.get(stillActionable.request.id)).resolves.toMatchObject({
      cancellationReason: null,
      status: "pending",
    });
  });

  it("keeps Main access pinned to the requested computer during automatic and explicit fulfillment", async ({
    storeFixture,
  }) => {
    const {
      store,
      fixture,
      setApprovedComputerConnection,
      definition,
      platform,
      insertComputerRunner,
    } = storeFixture;
    const run = await runningRunFixture(store, "computer-pinned-request");
    const setup = await fixture("pinned-request", run.userId);
    const connect = (runnerId: typeof setup.runnerId, access: "read" | "read-write") =>
      setApprovedComputerConnection({
        access,
        actorUserId: run.userId,
        createIfMissing: true,
        definitionId: definition.id,
        requestId: `pin-${runnerId}-${access}`,
        runnerId,
        tools: setup.tools(access),
      });
    const own = await connect(setup.runnerId, "read");
    const opened = await platform.requests.createIntegrationAccessRequest({
      access: "read-write",
      callId: "pinned-computer-access",
      installationId: setup.installationId,
      originatingRunId: run.runId,
      originatingThreadId: run.threadId,
      originatingWorkspaceId: run.workspaceId,
      reason: "Send from the chosen Mac",
      requestedBy: run.userId,
      requestedConnectionId: own.connection.id,
      requestedServerId: setup.serverId,
      targetWorkspaceId: run.workspaceId,
    });
    const otherRunnerId = createId("runner");
    await insertComputerRunner(otherRunnerId, run.userId, "Other Mac");
    const other = await connect(otherRunnerId, "read-write");
    expect(other.requestEvents).toEqual([]);
    await expect(
      platform.requests.resolveIntegrationAccessRequest({
        providerAuthorizations: {},
        requestId: opened.request.id,
        resolvedBy: run.userId,
        response: {
          kind: "external",
          value: { connectionId: other.connection.id, decision: "fulfilled" },
        },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(platform.requests.get(opened.request.id)).resolves.toMatchObject({
      status: "pending",
    });
    expect(
      (await platform.requests.listPendingContinuations()).some(
        ({ request }) => request.id === opened.request.id,
      ),
    ).toBe(false);
    const widened = await connect(setup.runnerId, "read-write");
    expect(widened.requestEvents.map((event) => event.type)).toEqual(["request.resolved"]);
    await expect(platform.requests.get(opened.request.id)).resolves.toMatchObject({
      status: "fulfilled",
      response: { value: { connectionId: own.connection.id } },
    });
  });

  it("scopes Request cancellation to removed computers until the installation is removed", async ({
    storeFixture,
  }) => {
    const {
      store,
      fixture,
      setApprovedComputerConnection,
      definition,
      insertComputerRunner,
      platform,
    } = storeFixture;
    const run = await runningRunFixture(store, "computer-request-revocation-scope");
    const setup = await fixture("request-revocation-scope", run.userId);
    const connect = (runnerId: typeof setup.runnerId, requestId: string) =>
      setApprovedComputerConnection({
        access: "read",
        actorUserId: run.userId,
        createIfMissing: true,
        definitionId: definition.id,
        requestId,
        runnerId,
        tools: setup.tools("read"),
      });
    const first = await connect(setup.runnerId, "connect-first-request-target");
    const secondRunnerId = createId("runner");
    await insertComputerRunner(secondRunnerId, run.userId, "Second request target");
    const second = await connect(secondRunnerId, "connect-second-request-target");
    const request = (callId: string, requestedConnectionId?: typeof first.connection.id) =>
      platform.requests.createIntegrationAccessRequest({
        access: "read-write",
        callId,
        installationId: setup.installationId,
        originatingRunId: run.runId,
        originatingThreadId: run.threadId,
        originatingWorkspaceId: run.workspaceId,
        reason: "Need Messages send access",
        requestedBy: run.userId,
        ...(requestedConnectionId ? { requestedConnectionId } : {}),
        requestedServerId: setup.serverId,
        targetWorkspaceId: run.workspaceId,
      });
    const pinnedToFirst = await request("request-pinned-to-first-computer", first.connection.id);
    const pinnedToSecond = await request("request-pinned-to-second-computer", second.connection.id);
    const unpinned = await request("request-without-computer-pin");

    const firstRevocation = await platform.revokeComputerConnection({
      connectionId: first.connection.id,
      ownerUserId: run.userId,
      requestId: "revoke-first-request-target",
    });
    expect(firstRevocation.cancelledRequestIds).toEqual([pinnedToFirst.request.id]);
    await expect(platform.requests.get(pinnedToFirst.request.id)).resolves.toMatchObject({
      cancellationReason: "resource-deleted",
      status: "cancelled",
    });
    await expect(platform.requests.get(pinnedToSecond.request.id)).resolves.toMatchObject({
      status: "pending",
    });
    await expect(platform.requests.get(unpinned.request.id)).resolves.toMatchObject({
      status: "pending",
    });

    const secondRevocation = await platform.revokeComputerConnection({
      connectionId: second.connection.id,
      ownerUserId: run.userId,
      requestId: "revoke-second-request-target",
    });
    expect(secondRevocation.cancelledRequestIds).toEqual([pinnedToSecond.request.id]);
    await expect(platform.requests.get(unpinned.request.id)).resolves.toMatchObject({
      status: "pending",
    });

    const uninstall = await platform.uninstall({
      actorUserId: run.userId,
      installationId: setup.installationId,
      requestId: "uninstall-after-request-targets-removed",
    });
    expect(uninstall.cancelledRequestIds).toEqual([unpinned.request.id]);
    await expect(platform.requests.get(unpinned.request.id)).resolves.toMatchObject({
      cancellationReason: "resource-deleted",
      status: "cancelled",
    });
  });

  it.for(["integration_connections", "integration_grants"] as const)(
    "locks fulfillment resources before Requests (%s)",
    async (resource, { storeFixture }) => {
      const { store, fixture, setApprovedComputerConnection, definition, platform, database } =
        storeFixture;
      const run = await runningRunFixture(store, "fulfillment-order", { kind: "specialized" });
      const setup = await fixture("fulfillment-order", run.userId);
      const connected = await setApprovedComputerConnection({
        access: "read",
        actorUserId: run.userId,
        createIfMissing: true,
        definitionId: definition.id,
        requestId: "fulfillment-order-connect",
        runnerId: setup.runnerId,
        tools: setup.tools("read"),
      });
      const grant = await platform.createGrant({
        access: "read",
        alias: "Messages",
        connectionId: connected.connection.id,
        createdBy: run.userId,
        installationId: setup.installationId,
        isDefault: true,
        ownerUserId: run.userId,
        providerAuthorizations: {},
        workspaceId: run.workspaceId,
      });
      const opened = await platform.requests.createIntegrationAccessRequest({
        access: "read",
        callId: "fulfillment-order-request",
        installationId: setup.installationId,
        originatingRunId: run.runId,
        originatingThreadId: run.threadId,
        originatingWorkspaceId: run.workspaceId,
        reason: "Test atomic fulfillment",
        requestedBy: run.userId,
        requestedServerId: setup.serverId,
        targetWorkspaceId: run.workspaceId,
      });
      const barrier = pauseAfterLock(database, (node) => node.includes(resource));
      const peer = barrier.database.transaction().execute(async (transaction) => {
        await sql`select id from ${sql.table(resource)} where id=${resource === "integration_connections" ? connected.connection.id : grant.id} for no key update`.execute(
          transaction,
        );
        await transaction
          .selectFrom("requests")
          .select("id")
          .where("id", "=", opened.request.id)
          .forNoKeyUpdate()
          .execute();
      });
      void peer.catch(() => undefined);
      let fulfillment: Promise<unknown> | undefined;
      try {
        await barrier.reached;
        fulfillment = platform.requests.resolveIntegrationAccessRequest({
          providerAuthorizations: {},
          requestId: opened.request.id,
          resolvedBy: run.userId,
          response: {
            kind: "external",
            value: {
              access: "read",
              alias: "Messages",
              connectionId: connected.connection.id,
              decision: "fulfilled",
              isDefault: true,
            },
          },
        });
        void fulfillment.catch(() => undefined);
        await expect
          .poll(async () =>
            (
              await sql<{ query: string }>`
          select query from pg_stat_activity where datname=current_database()
          and application_name='opensteer-computer-app-connections-test' and wait_event_type='Lock'
        `.execute(database)
            ).rows.some(({ query }) => query.includes(resource)),
          )
          .toBe(true);
        barrier.release();
        const results = await Promise.allSettled([peer, fulfillment]);
        expect(barrier.conflicts).toEqual([]);
        expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
      } finally {
        barrier.release();
        await Promise.allSettled([peer, fulfillment]);
      }
    },
  );

  it("locks revoked computer Grants before materialized Tools", async ({ storeFixture }) => {
    const { fixture, setApprovedComputerConnection, definition, store, platform, database } =
      storeFixture;
    const setup = await fixture("grant-tool-order");
    const connected = await setApprovedComputerConnection({
      access: "read",
      actorUserId: setup.ownerUserId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "grant-tool-order-connect",
      runnerId: setup.runnerId,
      tools: setup.tools("read"),
    });
    const workspace = await createWorkspace(store, setup.ownerUserId, "grant-tool-order");
    const grant = await platform.createGrant({
      access: "read",
      alias: "Messages",
      connectionId: connected.connection.id,
      createdBy: setup.ownerUserId,
      installationId: setup.installationId,
      isDefault: true,
      ownerUserId: setup.ownerUserId,
      providerAuthorizations: {},
      workspaceId: workspace.id,
    });
    const barrier = pauseAfterLock(database, (node) => /"name":"integration_?grants"/iu.test(node));
    const peer = barrier.database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("integrationGrants")
        .select("id")
        .where("id", "=", grant.id)
        .forNoKeyUpdate()
        .execute();
      await transaction
        .selectFrom("integrationTools")
        .select("id")
        .where("connectionId", "=", connected.connection.id)
        .orderBy("id", "asc")
        .forNoKeyUpdate()
        .execute();
    });
    void peer.catch(() => undefined);
    let removal: Promise<unknown> | undefined;
    try {
      await barrier.reached;
      removal = platform.revokeComputerConnection({
        connectionId: connected.connection.id,
        ownerUserId: setup.ownerUserId,
        requestId: "grant-tool-order-revoke",
      });
      void removal.catch(() => undefined);
      await expect
        .poll(async () =>
          (
            await sql<{ query: string }>`
        select query from pg_stat_activity where datname=current_database()
        and application_name='opensteer-computer-app-connections-test' and wait_event_type='Lock'
      `.execute(database)
          ).rows.some(({ query }) => query.includes('"integration_grants"')),
        )
        .toBe(true);
      barrier.release();
      const results = await Promise.allSettled([peer, removal]);
      expect(barrier.conflicts).toEqual([]);
      expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
    } finally {
      barrier.release();
      await Promise.allSettled([peer, removal]);
    }
  });

  it("validates computer fulfillment authority atomically for Main and specialized Workspaces", async ({
    storeFixture,
  }) => {
    const {
      store,
      fixture,
      setApprovedComputerConnection,
      definition,
      insertComputerRunner,
      platform,
    } = storeFixture;
    const run = await runningRunFixture(store, "computer-request-authority");
    const setup = await fixture("request-authority", run.userId);
    const specialized = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_computer_request_authority_specialized",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: run.userId,
      idempotencyKey: "computer-request-authority-specialized",
      kind: "specialized",
      name: "Computer request authority specialist",
      status: "ready",
    });
    const own = await setApprovedComputerConnection({
      access: "read",
      actorUserId: run.userId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "computer-request-authority-own",
      runnerId: setup.runnerId,
      tools: setup.tools("read"),
    });
    const foreignUserId = await store.createUser("Foreign computer owner");
    const foreignRunnerId = createId("runner");
    await insertComputerRunner(foreignRunnerId, foreignUserId, "Foreign Mac");
    const foreign = await setApprovedComputerConnection({
      access: "read",
      actorUserId: foreignUserId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "computer-request-authority-foreign",
      runnerId: foreignRunnerId,
      tools: setup.tools("read"),
    });
    const revokedRunnerId = createId("runner");
    await insertComputerRunner(revokedRunnerId, run.userId, "Revoked Mac");
    const revoked = await setApprovedComputerConnection({
      access: "read",
      actorUserId: run.userId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "computer-request-authority-revoked",
      runnerId: revokedRunnerId,
      tools: setup.tools("read"),
    });
    await platform.revokeComputerConnection({
      connectionId: revoked.connection.id,
      ownerUserId: run.userId,
      requestId: "computer-request-authority-revoke",
    });

    const cases = [
      { connectionId: own.connection.id, expected: "fulfilled" as const, name: "own" },
      { connectionId: foreign.connection.id, expected: "forbidden" as const, name: "foreign" },
      {
        connectionId: createIntegrationId("connection"),
        expected: "forbidden" as const,
        name: "nonexistent",
      },
      {
        connectionId: revoked.connection.id,
        expected: "forbidden" as const,
        name: "revoked",
      },
    ];
    for (const target of [run.workspaceId, specialized.id]) {
      for (const candidate of cases) {
        const opened = await platform.requests.createIntegrationAccessRequest({
          access: "read",
          callId: `computer-request-${candidate.name}-${target}`,
          installationId: setup.installationId,
          originatingRunId: run.runId,
          originatingThreadId: run.threadId,
          originatingWorkspaceId: run.workspaceId,
          reason: `Use ${candidate.name} Messages`,
          requestedBy: run.userId,
          requestedServerId: setup.serverId,
          targetWorkspaceId: target,
        });
        const response =
          target === run.workspaceId
            ? {
                kind: "external" as const,
                value: { connectionId: candidate.connectionId, decision: "fulfilled" as const },
              }
            : {
                kind: "external" as const,
                value: {
                  access: "read" as const,
                  alias: "Messages",
                  connectionId: candidate.connectionId,
                  decision: "fulfilled" as const,
                  isDefault: true,
                },
              };
        const resolution = platform.requests.resolveIntegrationAccessRequest({
          providerAuthorizations: {},
          requestId: opened.request.id,
          resolvedBy: run.userId,
          response,
        });
        if (candidate.expected === "fulfilled") {
          await expect(resolution).resolves.toMatchObject({ request: { status: "fulfilled" } });
        } else {
          await expect(resolution).rejects.toMatchObject({ code: "forbidden" });
          await expect(platform.requests.get(opened.request.id)).resolves.toMatchObject({
            response: null,
            status: "pending",
          });
          expect(
            (await platform.requests.listPendingContinuations()).some(
              ({ request }) => request.id === opened.request.id,
            ),
          ).toBe(false);
        }
      }
    }

    const write = await platform.requests.createIntegrationAccessRequest({
      access: "read-write",
      callId: "computer-request-read-only-ceiling",
      installationId: setup.installationId,
      originatingRunId: run.runId,
      originatingThreadId: run.threadId,
      originatingWorkspaceId: run.workspaceId,
      reason: "Send with Messages",
      requestedBy: run.userId,
      requestedServerId: setup.serverId,
      targetWorkspaceId: specialized.id,
    });
    await expect(
      platform.requests.resolveIntegrationAccessRequest({
        providerAuthorizations: {},
        requestId: write.request.id,
        resolvedBy: run.userId,
        response: {
          kind: "external",
          value: {
            access: "read-write",
            alias: "Messages",
            connectionId: own.connection.id,
            decision: "fulfilled",
            isDefault: true,
          },
        },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(platform.requests.get(write.request.id)).resolves.toMatchObject({
      response: null,
      status: "pending",
    });
  });

  it("removes a live computer connection with its installation", async ({ storeFixture }) => {
    const { fixture, setApprovedComputerConnection, definition, platform, database } = storeFixture;
    const setup = await fixture("uninstall");
    const connected = await setApprovedComputerConnection({
      access: "read",
      actorUserId: setup.ownerUserId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "computer-uninstall-connect",
      runnerId: setup.runnerId,
      tools: setup.tools("read"),
    });
    const mutation = await platform.uninstall({
      actorUserId: setup.ownerUserId,
      installationId: setup.installationId,
      requestId: "computer-uninstall",
    });
    expect(mutation.removedConnectionIds).toEqual([connected.connection.id]);
    await expect(
      database
        .selectFrom("integrationConnections")
        .select("id")
        .where("id", "=", connected.connection.id)
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
  });

  it("does not deadlock when uninstall races a computer connection edit", async ({
    storeFixture,
  }) => {
    const {
      fixture,
      setApprovedComputerConnection,
      definition,
      database,
      platform,
      waitForLockWaiters,
    } = storeFixture;
    const setup = await fixture("uninstall-edit-race");
    const connected = await setApprovedComputerConnection({
      access: "read",
      actorUserId: setup.ownerUserId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "uninstall-edit-race-create",
      runnerId: setup.runnerId,
      tools: setup.tools("read"),
    });
    // Pause the edit after it has locked the connection and before it advances
    // the server generation. Its foreign-key key-share lock on the server must
    // make uninstall wait there, before uninstall can lock the connection.
    await sql`
      create function public.opensteer_uninstall_edit_probe() returns trigger
      language plpgsql as $$
      begin
        perform pg_advisory_xact_lock(794378203);
        return new;
      end;
      $$;
      create trigger opensteer_uninstall_edit_probe
      before update on public.integration_tools
      for each row when (new.connection_id = '${sql.raw(connected.connection.id)}')
      execute function public.opensteer_uninstall_edit_probe();
    `.execute(database);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = database.transaction().execute(async (transaction) => {
      await sql`select pg_advisory_xact_lock(794378203)`.execute(transaction);
      held();
      await released;
    });
    let edit: ReturnType<StoreFixture["platform"]["setComputerConnection"]> | null = null;
    let uninstall: ReturnType<StoreFixture["platform"]["uninstall"]> | null = null;
    let cleanupError: Error | null = null;
    try {
      await Promise.race([holding, holder]);
      edit = platform.setComputerConnection({
        access: "read",
        actorUserId: setup.ownerUserId,
        app: null,
        createIfMissing: true,
        definitionDigest: integrationDefinitionDigest(definition),
        definitionId: definition.id,
        requestId: "uninstall-edit-race-edit",
        runnerId: setup.runnerId,
        tools: setup.tools("read"),
      });
      await waitForLockWaiters(1);
      uninstall = platform.uninstall({
        actorUserId: setup.ownerUserId,
        installationId: setup.installationId,
        requestId: "uninstall-edit-race-remove",
      });
      await waitForLockWaiters(2);
      const blockedOnServer = await sql<{ count: string }>`
        select count(*)::text as count from pg_stat_activity
        where datname = current_database()
          and application_name = 'opensteer-computer-app-connections-test'
          and wait_event_type = 'Lock'
          and query ilike '%integration_servers%'
      `.execute(database);
      expect(Number(blockedOnServer.rows[0]?.count)).toBeGreaterThanOrEqual(1);
      release();
      const outcomes = await Promise.allSettled([edit, uninstall, holder]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual([
        "fulfilled",
        "fulfilled",
        "fulfilled",
      ]);
    } finally {
      release();
      const inFlight = Promise.allSettled([
        holder,
        ...(edit ? [edit] : []),
        ...(uninstall ? [uninstall] : []),
      ]);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          inFlight,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Computer uninstall race did not settle")),
              10_000,
            );
          }),
        ]);
      } catch (error) {
        // Cancel the test's blocked statements so their transactions release
        // pooled connections before the next case starts.
        await sql`
          select pg_cancel_backend(pid) from pg_stat_activity
          where datname = current_database()
            and application_name = 'opensteer-computer-app-connections-test'
            and pid <> pg_backend_pid()
            and state = 'active'
        `.execute(database);
        await inFlight;
        cleanupError = new Error("Computer uninstall race cleanup timed out", { cause: error });
      } finally {
        if (timeout) clearTimeout(timeout);
        await sql`drop trigger if exists opensteer_uninstall_edit_probe on public.integration_tools;
          drop function if exists public.opensteer_uninstall_edit_probe();`.execute(database);
      }
    }
    if (cleanupError) throw cleanupError;
  });

  it("removes a disconnected computer connection with its installation", async ({
    storeFixture,
  }) => {
    const { fixture, setApprovedComputerConnection, definition, platform, database } = storeFixture;
    const setup = await fixture("uninstall-disconnected");
    const connected = await setApprovedComputerConnection({
      access: "read",
      actorUserId: setup.ownerUserId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "computer-uninstall-disconnected-connect",
      runnerId: setup.runnerId,
      tools: setup.tools("read"),
    });
    await platform.revokeComputerConnection({
      connectionId: connected.connection.id,
      ownerUserId: setup.ownerUserId,
      requestId: "computer-uninstall-disconnected-revoke",
    });

    await expect(
      platform.uninstall({
        actorUserId: setup.ownerUserId,
        installationId: setup.installationId,
        requestId: "computer-uninstall-disconnected",
      }),
    ).resolves.toMatchObject({ removedConnectionIds: [connected.connection.id] });
    await expect(
      database
        .selectFrom("integrationConnections")
        .select("id")
        .where("integrationServerId", "=", setup.serverId)
        .execute(),
    ).resolves.toEqual([]);
  });

  it("removes a machine-revoked computer connection with its installation", async ({
    storeFixture,
  }) => {
    const { fixture, setApprovedComputerConnection, definition, store, platform, database } =
      storeFixture;
    const setup = await fixture("uninstall-machine-revoked");
    const connected = await setApprovedComputerConnection({
      access: "read",
      actorUserId: setup.ownerUserId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "computer-uninstall-machine-connect",
      runnerId: setup.runnerId,
      tools: setup.tools("read"),
    });
    await store.revokeRunner(setup.runnerId, setup.ownerUserId);

    await expect(
      platform.uninstall({
        actorUserId: setup.ownerUserId,
        installationId: setup.installationId,
        requestId: "computer-uninstall-machine-revoked",
      }),
    ).resolves.toMatchObject({ removedConnectionIds: [connected.connection.id] });
    await expect(
      database
        .selectFrom("integrationConnections")
        .select("id")
        .where("integrationServerId", "=", setup.serverId)
        .execute(),
    ).resolves.toEqual([]);
  });

  it("removes both historical and recreated computer connections on uninstall", async ({
    storeFixture,
  }) => {
    const { fixture, setApprovedComputerConnection, definition, platform, database } = storeFixture;
    const setup = await fixture("uninstall-recreated");
    const first = await setApprovedComputerConnection({
      access: "read",
      actorUserId: setup.ownerUserId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "computer-uninstall-recreated-first",
      runnerId: setup.runnerId,
      tools: setup.tools("read"),
    });
    await platform.revokeComputerConnection({
      connectionId: first.connection.id,
      ownerUserId: setup.ownerUserId,
      requestId: "computer-uninstall-recreated-disconnect",
    });
    const second = await setApprovedComputerConnection({
      access: "read",
      actorUserId: setup.ownerUserId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "computer-uninstall-recreated-second",
      runnerId: setup.runnerId,
      tools: setup.tools("read"),
    });

    const mutation = await platform.uninstall({
      actorUserId: setup.ownerUserId,
      installationId: setup.installationId,
      requestId: "computer-uninstall-recreated",
    });
    expect(new Set(mutation.removedConnectionIds)).toEqual(
      new Set([first.connection.id, second.connection.id]),
    );
    await expect(
      database
        .selectFrom("integrationConnections")
        .select("id")
        .where("integrationServerId", "=", setup.serverId)
        .execute(),
    ).resolves.toEqual([]);
  });

  it("fences Runner rename environment before its computer connections", async ({
    storeFixture,
  }) => {
    const { fixture, setApprovedComputerConnection, definition, store, database } = storeFixture;
    const setup = await fixture("rename-environment-prefix");
    const source = await setApprovedComputerConnection({
      access: "read-write",
      actorUserId: setup.ownerUserId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "rename-environment-prefix",
      runnerId: setup.runnerId,
      tools: setup.tools("read-write"),
    });
    const environmentId = await store.createEnvironment({
      kind: "local",
      name: "Rename fence",
      runnerId: setup.runnerId,
    });
    const barrier = pauseAfterLock(
      database,
      (node) =>
        node.includes('"kind":"SelectQueryNode"') &&
        /"name":"execution_?environments"/iu.test(node) &&
        node.includes("ForShare"),
    );
    const peer = barrier.database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("executionEnvironments")
        .select("id")
        .where("id", "=", environmentId)
        .forShare()
        .execute();
      await transaction
        .selectFrom("integrationConnections")
        .select("id")
        .where("id", "=", source.connection.id)
        .forShare()
        .execute();
    });
    void peer.catch(() => undefined);
    let renaming: Promise<void> | undefined;
    try {
      await barrier.reached;
      renaming = store.renameRunner(setup.runnerId, setup.ownerUserId, "Renamed fence");
      void renaming.catch(() => undefined);
      await expect
        .poll(async () =>
          (
            await sql<{ query: string }>`
        select query from pg_stat_activity where datname=current_database()
        and application_name='opensteer-computer-app-connections-test' and wait_event_type='Lock'
      `.execute(database)
          ).rows.some(({ query }) => query.includes('"execution_environments"')),
        )
        .toBe(true);
      barrier.release();
      const results = await Promise.allSettled([peer, renaming]);
      expect(barrier.conflicts).toEqual([]);
      expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
    } finally {
      barrier.release();
      await Promise.allSettled([peer, renaming]);
    }
  });

  it("orders computer ingress with Runner rename without a deadlock", async ({ storeFixture }) => {
    const { store, database, fixture, setApprovedComputerConnection, definition, platform } =
      storeFixture;
    const run = await runningRunFixture(store, "rename-ingress-order");
    const harness = await database
      .selectFrom("harnessInstances")
      .select("runtimeRevision")
      .where("id", "=", run.harnessInstanceId)
      .executeTakeFirstOrThrow();
    await store.recordHarnessCatalogs({
      catalogs: [
        HarnessInstanceCatalogSchema.parse({
          continuationIdentity: {
            continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
            driverKind: "native",
          },
          driverKind: "native",
          harnessInstanceId: run.harnessInstanceId,
          models: [
            {
              displayName: "Test model",
              isDefault: true,
              modelId: "gpt-5.6-sol",
              options: [],
              providerId: "openai",
            },
          ],
          status: "ready",
        }),
      ],
      environmentId: run.environmentId,
      expectedRevisions: new Map([[run.harnessInstanceId, harness.runtimeRevision]]),
    });
    const setup = await fixture("rename-ingress-order", run.userId);
    const source = await setApprovedComputerConnection({
      access: "read-write",
      actorUserId: run.userId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "rename-ingress-order",
      runnerId: setup.runnerId,
      tools: setup.tools("read-write"),
    });
    const pending = await platform.requests.createIntegrationAccessRequest({
      access: "read-write",
      callId: "rename-ingress-order",
      installationId: setup.installationId,
      originatingRunId: run.runId,
      originatingThreadId: run.threadId,
      originatingWorkspaceId: run.workspaceId,
      targetWorkspaceId: run.workspaceId,
      requestedBy: run.userId,
      requestedConnectionId: source.connection.id,
      requestedServerId: setup.serverId,
      reason: "Keep a pending Request in the channel Workspace",
    });
    expect(pending.request.status).toBe("pending");
    const channels = new ChannelStore(database);
    const sender = { allowedExternalUserIds: [], mode: "anyone" };
    const connectionInput: Parameters<ChannelStore["createConnection"]>[0] = {
      accessPolicy: {
        channels: { conversationIds: [], scope: "all", sender },
        directMessages: sender,
      },
      account: {
        displayName: "Messages",
        externalAccountId: "messages",
        routingMode: "dedicated",
      },
      connection: {
        connectionMethod: "computer",
        displayName: "Messages",
        provider: "imessage",
        runnerId: setup.runnerId,
        sourceConnectionId: source.connection.id,
        transportKind: "computer",
      },
      createdBy: run.userId,
      credential: null,
      executionPolicy: { harness: "default", harnessInstanceId: null },
      linkedExternalUserIds: ["owner@messages.test"],
      selector: {
        conversationId: null,
        conversationType: null,
        scopeId: null,
        threadId: null,
      },
      workspaceId: run.workspaceId,
    };
    const configured = await channels.createConnection(connectionInput);
    await channels.setRuntimeConnectionHealth({
      connectionId: configured.connection.id,
      detail: null,
      reason: null,
      runnerId: setup.runnerId,
      status: "connected",
    });
    const ingress = await channels.commitIngress(configured.connection.id, {
      accountExternalId: "messages",
      actor: { displayName: "Owner", externalUserId: "owner@messages.test" },
      content: [{ type: "text", text: "Hello" }],
      conversation: {
        displayName: "Owner",
        externalConversationId: "owner-chat",
        externalScopeId: null,
        externalThreadId: null,
        type: "dm",
      },
      eventId: "rename-ingress-order",
      occurredAt: new Date().toISOString(),
      provider: "imessage",
      providerMessageId: "rename-ingress-order",
      trigger: "direct-message",
    });
    const claim = await channels.claimIngress("source-race");
    if (!claim) throw new Error("Expected claimed ingress");
    expect(claim.id).toBe(ingress.ingressId);
    const placementEnvironmentId = await store.createEnvironment({
      kind: "local",
      name: "Source Mac",
      runnerId: setup.runnerId,
    });
    const placementHarness = await store.createHarnessInstance({
      config: {},
      driverKind: HarnessIdSchema.parse("native"),
      environmentId: placementEnvironmentId,
      name: "Source Mac engine",
      stateKind: "isolated",
    });
    await store.recordHarnessCatalogs({
      environmentId: placementEnvironmentId,
      expectedRevisions: new Map([[placementHarness.id, placementHarness.runtimeRevision]]),
      catalogs: [
        HarnessInstanceCatalogSchema.parse({
          harnessInstanceId: placementHarness.id,
          driverKind: "native",
          status: "ready",
          continuationIdentity: {
            continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
            driverKind: "native",
          },
          models: [
            {
              displayName: "Test",
              isDefault: true,
              modelId: "gpt-5.6-sol",
              options: [],
              providerId: "openai",
            },
          ],
        }),
      ],
    });
    const barrier = pauseAfterLock(
      database,
      (node) =>
        node.includes('"kind":"UpdateQueryNode"') &&
        /"name":"execution_?environments"/iu.test(node),
    );
    const renaming = new OpensteerStore(barrier.database).renameRunner(
      setup.runnerId,
      run.userId,
      "Renamed Mac",
    );
    void renaming.catch(() => undefined);
    let adopting: ReturnType<ChannelStore["adoptIngress"]> | undefined;
    try {
      await barrier.reached;
      adopting = channels.adoptIngress({
        claimToken: claim.claimToken,
        ingressId: claim.id,
        notices: {
          approvalPending: "Pending",
          linkByDirectMessage: "DM",
          linkCode: (code) => code,
          noRoute: "No route",
          notAMember: "Not a member",
        },
        placementCandidates: [
          { environmentId: placementEnvironmentId, harnessInstanceId: placementHarness.id },
        ],
      });
      void adopting.catch(() => undefined);
      await expect
        .poll(async () =>
          (
            await sql<{
              query: string;
            }>`select query from pg_stat_activity where datname=current_database() and application_name='opensteer-computer-app-connections-test' and wait_event_type='Lock'`.execute(
              database,
            )
          ).rows.some(
            ({ query }) =>
              query.includes('"execution_environments"') ||
              query.includes('"integration_connections"'),
          ),
        )
        .toBe(true);
      barrier.release();
      const results = await Promise.allSettled([renaming, adopting]);
      expect(barrier.conflicts).toEqual([]);
      expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
      expect(results[1]).toMatchObject({ value: { kind: "adopted" } });
    } finally {
      barrier.release();
      await Promise.allSettled([renaming, adopting]);
    }
  });

  it.for([
    "revocation-first",
    "ingress-first",
    "connection-first",
    "connection-holds-workspace",
    "binding-first",
  ] as const)(
    "orders computer channel mutations after their Workspace (%s)",
    async (arrival, { storeFixture }) => {
      const { store, database, fixture, setApprovedComputerConnection, definition, platform } =
        storeFixture;
      const run = await runningRunFixture(store, `channel-source-${arrival}`);
      const harness = await database
        .selectFrom("harnessInstances")
        .select("runtimeRevision")
        .where("id", "=", run.harnessInstanceId)
        .executeTakeFirstOrThrow();
      await store.recordHarnessCatalogs({
        catalogs: [
          HarnessInstanceCatalogSchema.parse({
            continuationIdentity: {
              continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
              driverKind: "native",
            },
            driverKind: "native",
            harnessInstanceId: run.harnessInstanceId,
            models: [
              {
                displayName: "Test model",
                isDefault: true,
                modelId: "gpt-5.6-sol",
                options: [],
                providerId: "openai",
              },
            ],
            status: "ready",
          }),
        ],
        environmentId: run.environmentId,
        expectedRevisions: new Map([[run.harnessInstanceId, harness.runtimeRevision]]),
      });
      const setup = await fixture(`channel-source-${arrival}`, run.userId);
      const source = await setApprovedComputerConnection({
        access: "read-write",
        actorUserId: run.userId,
        createIfMissing: true,
        definitionId: definition.id,
        requestId: `channel-source-${arrival}`,
        runnerId: setup.runnerId,
        tools: setup.tools("read-write"),
      });
      const pending = await platform.requests.createIntegrationAccessRequest({
        access: "read-write",
        callId: `channel-source-${arrival}`,
        installationId: setup.installationId,
        originatingRunId: run.runId,
        originatingThreadId: run.threadId,
        originatingWorkspaceId: run.workspaceId,
        targetWorkspaceId: run.workspaceId,
        requestedBy: run.userId,
        requestedConnectionId: source.connection.id,
        requestedServerId: setup.serverId,
        reason: "Keep a pending Request in the channel Workspace",
      });
      expect(pending.request.status).toBe("pending");
      const channels = new ChannelStore(database);
      const sender = { allowedExternalUserIds: [], mode: "anyone" };
      const connectionInput: Parameters<ChannelStore["createConnection"]>[0] = {
        accessPolicy: {
          channels: { conversationIds: [], scope: "all", sender },
          directMessages: sender,
        },
        account: {
          displayName: "Messages",
          externalAccountId: "messages",
          routingMode: arrival === "binding-first" ? "shared" : "dedicated",
        },
        connection: {
          connectionMethod: "computer",
          displayName: "Messages",
          provider: "imessage",
          runnerId: setup.runnerId,
          sourceConnectionId: source.connection.id,
          transportKind: "computer",
        },
        createdBy: run.userId,
        credential: null,
        executionPolicy: { harness: "default", harnessInstanceId: null },
        linkedExternalUserIds: ["owner@messages.test"],
        selector: {
          conversationId: arrival === "binding-first" ? "owner-chat" : null,
          conversationType: null,
          scopeId: null,
          threadId: null,
        },
        workspaceId: run.workspaceId,
      };
      const configured = await channels.createConnection(connectionInput);
      await channels.setRuntimeConnectionHealth({
        connectionId: configured.connection.id,
        detail: null,
        reason: null,
        runnerId: setup.runnerId,
        status: "connected",
      });
      const ingress = await channels.commitIngress(configured.connection.id, {
        accountExternalId: "messages",
        actor: { displayName: "Owner", externalUserId: "owner@messages.test" },
        content: [{ type: "text", text: "Hello" }],
        conversation: {
          displayName: "Owner",
          externalConversationId: "owner-chat",
          externalScopeId: null,
          externalThreadId: null,
          type: "dm",
        },
        eventId: `channel-source-${arrival}`,
        occurredAt: new Date().toISOString(),
        provider: "imessage",
        providerMessageId: `channel-source-${arrival}`,
        trigger: "direct-message",
      });
      const claim = await channels.claimIngress("source-race");
      if (!claim) throw new Error("Expected claimed ingress");
      expect(claim.id).toBe(ingress.ingressId);
      const newIdentity = JSON.stringify(["imessage", null, "second-bot"]);
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const blocker = database.transaction().execute(async (transaction) => {
        if (arrival === "revocation-first") {
          // SHARE stops revocation's NO KEY UPDATE while allowing source
          // readers through, preserving the source → Workspace race staging.
          await transaction
            .selectFrom("integrationConnections")
            .select("id")
            .where("id", "=", source.connection.id)
            .forShare()
            .execute();
        } else if (arrival === "connection-first") {
          await sql`select pg_advisory_xact_lock(hashtextextended(${newIdentity}, 0))`.execute(
            transaction,
          );
        } else if (arrival === "connection-holds-workspace") {
          // Creation takes its Workspace, then waits here for the source;
          // revocation then has to queue behind it at that Workspace.
          await transaction
            .selectFrom("integrationConnections")
            .select("id")
            .where("id", "=", source.connection.id)
            .forShare()
            .execute();
        } else if (arrival === "binding-first") {
          await transaction
            .selectFrom("channelBindings")
            .select("id")
            .where("id", "=", configured.binding.id)
            .forUpdate()
            .execute();
        } else {
          await transaction
            .selectFrom("workspaces")
            .select("id")
            .where("id", "=", run.workspaceId)
            .forUpdate()
            .execute();
        }
        held.resolve();
        await release.promise;
      });
      await held.promise;
      const adopt = () =>
        channels.adoptIngress({
          claimToken: claim.claimToken,
          ingressId: claim.id,
          notices: {
            approvalPending: "Pending",
            linkByDirectMessage: "Send a DM",
            linkCode: (code: string) => code,
            noRoute: "No route",
            notAMember: "Not a member",
          },
          placementCandidates: [
            { environmentId: run.environmentId, harnessInstanceId: run.harnessInstanceId },
          ],
        });
      // Exercise the production revocation transaction without its outer retry:
      // either deadlock victim must be visible to this regression.
      const revoke = () =>
        database.transaction().execute((transaction) =>
          revokeComputerConnectionsInTransaction(transaction, {
            connectionId: source.connection.id,
            ownerUserId: run.userId,
          }),
        );
      const waitingQueries = async () =>
        (
          await sql<{ query: string }>`
        select query from pg_stat_activity where datname = current_database()
        and application_name = 'opensteer-computer-app-connections-test'
        and wait_event_type = 'Lock'
      `.execute(database)
        ).rows.map(({ query }) => query);
      const first =
        arrival === "revocation-first"
          ? revoke()
          : arrival === "connection-first" || arrival === "connection-holds-workspace"
            ? channels.createConnection({
                ...connectionInput,
                account: { ...connectionInput.account, externalAccountId: "second-messages" },
                connection: { ...connectionInput.connection, externalIdentityId: "second-bot" },
              })
            : arrival === "binding-first"
              ? channels.createBinding({
                  accessPolicy: connectionInput.accessPolicy,
                  accountId: configured.account.id,
                  createdBy: run.userId,
                  executionPolicy: connectionInput.executionPolicy,
                  selector: {
                    conversationId: "another-chat",
                    conversationType: null,
                    scopeId: null,
                    threadId: null,
                  },
                  workspaceId: run.workspaceId,
                })
              : adopt();
      void first.catch(() => undefined);
      let second: Promise<unknown> | undefined;
      try {
        await expect.poll(async () => (await waitingQueries()).length).toBe(1);
        expect((await waitingQueries())[0]).toContain(
          arrival === "revocation-first"
            ? '"integration_connections"'
            : arrival === "connection-first"
              ? "pg_advisory_xact_lock"
              : arrival === "connection-holds-workspace"
                ? '"integration_connections"'
                : arrival === "binding-first"
                  ? '"channel_bindings"'
                  : '"workspaces"',
        );
        second = arrival === "revocation-first" || arrival === "binding-first" ? adopt() : revoke();
        void second.catch(() => undefined);
        if (arrival === "connection-first") {
          // Identity reservation now precedes Workspace acquisition. Revocation
          // commits while creation is still at identity; creation must revalidate it.
          await second;
        } else {
          await expect.poll(async () => (await waitingQueries()).length).toBe(2);
          if (arrival === "connection-holds-workspace") {
            expect(await waitingQueries()).toEqual(
              expect.arrayContaining([expect.stringContaining('"workspaces"')]),
            );
          }
        }
        // Both waiters have reached their contested fences before release.
      } finally {
        release.resolve();
        await blocker;
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
      const results = await Promise.allSettled([first, second!]);
      if (arrival === "connection-first") {
        expect(results[0]).toMatchObject({ status: "rejected", reason: { code: "forbidden" } });
        expect(results[1]).toMatchObject({ status: "fulfilled" });
      } else {
        for (const result of results) if (result.status === "rejected") throw result.reason;
      }
      if (arrival === "connection-holds-workspace") {
        // Revocation ran after creation committed, so it took the new channel too.
        expect(
          await database
            .selectFrom("integrationConnections")
            .select("status")
            .where("externalIdentityId", "=", "second-bot")
            .executeTakeFirstOrThrow(),
        ).toEqual({ status: "revoked" });
      } else if (arrival !== "connection-first") {
        const adoption = results[arrival === "ingress-first" ? 0 : 1];
        expect(adoption).toMatchObject({
          value:
            arrival === "revocation-first"
              ? { kind: "ignored", reason: "source-withdrawn" }
              : { kind: "adopted" },
        });
      }
      expect(await platform.requests.get(pending.request.id)).toMatchObject({
        status: arrival === "binding-first" ? "pending" : "cancelled",
      });
      expect(
        await database
          .selectFrom("integrationConnections")
          .select("status")
          .where("id", "=", source.connection.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: arrival === "binding-first" ? "connected" : "revoked" });
    },
  );

  it("advances authority generations at commit after source mutations", async ({
    storeFixture,
  }) => {
    const { fixture, database } = storeFixture;
    const setup = await fixture("deferred-authority-order");
    const before = await database
      .selectFrom("integrationAuthorityGenerations")
      .select("generation")
      .where("ownerUserId", "=", setup.ownerUserId)
      .executeTakeFirstOrThrow();
    await database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("integrationInstallations")
        .set({ version: "deferred-authority" })
        .where("id", "=", setup.installationId)
        .execute();
      const held = await sql<{ held: boolean }>`select exists (
        select 1 from public.pgrowlocks('integration_authority_generations')
        where pg_backend_pid() = any(pids)
      ) as held`.execute(transaction);
      expect(held.rows[0]!.held).toBe(false);
      expect(
        await transaction
          .selectFrom("integrationAuthorityGenerations")
          .select("generation")
          .where("ownerUserId", "=", setup.ownerUserId)
          .executeTakeFirstOrThrow(),
      ).toEqual(before);
    });
    const after = await database
      .selectFrom("integrationAuthorityGenerations")
      .select("generation")
      .where("ownerUserId", "=", setup.ownerUserId)
      .executeTakeFirstOrThrow();
    expect(after.generation).toBeGreaterThan(before.generation);
    expect((await sql`select * from integration_authority_pending`.execute(database)).rows).toEqual(
      [],
    );
  });

  it("rolls back queued authority invalidations with the rejected mutation", async ({
    storeFixture,
  }) => {
    const { fixture, database } = storeFixture;
    const setup = await fixture("rollback-authority-order");
    const before = await database
      .selectFrom("integrationAuthorityGenerations")
      .select("generation")
      .where("ownerUserId", "=", setup.ownerUserId)
      .executeTakeFirstOrThrow();
    const rejected = new Error("Reject the source mutation");
    await expect(
      database.transaction().execute(async (transaction) => {
        await transaction
          .updateTable("integrationInstallations")
          .set({ version: "rolled-back" })
          .where("id", "=", setup.installationId)
          .execute();
        const pending =
          await sql`select * from integration_authority_pending where transaction_id=pg_current_xact_id()`.execute(
            transaction,
          );
        expect(pending.rows.length).toBeGreaterThan(0);
        throw rejected;
      }),
    ).rejects.toBe(rejected);
    expect(
      await database
        .selectFrom("integrationAuthorityGenerations")
        .select("generation")
        .where("ownerUserId", "=", setup.ownerUserId)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    expect((await sql`select * from integration_authority_pending`.execute(database)).rows).toEqual(
      [],
    );
  });

  it("fences installation servers before authority-generation triggers", async ({
    storeFixture,
  }) => {
    const { fixture, database, definition } = storeFixture;
    const setup = await fixture("installation-generation-order");
    const barrier = pauseAfterLock(
      database,
      (node) =>
        node.includes('"kind":"SelectQueryNode"') &&
        /"name":"integration_?servers"/iu.test(node) &&
        node.includes("ForNoKeyUpdate"),
    );
    const peer = barrier.database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("integrationServers")
        .select("id")
        .where("id", "=", setup.serverId)
        .forNoKeyUpdate()
        .execute();
      await transaction
        .selectFrom("integrationAuthorityGenerations")
        .select("ownerUserId")
        .where("ownerUserId", "=", setup.ownerUserId)
        .forNoKeyUpdate()
        .execute();
    });
    void peer.catch(() => undefined);
    let replacing: Promise<unknown> | undefined;
    try {
      await barrier.reached;
      replacing = database.transaction().execute((transaction) =>
        installIntegrationInTransaction(transaction, {
          actorUserId: setup.ownerUserId,
          adapterSnapshot: null,
          installation: {
            description: definition.description,
            id: setup.installationId,
            manifest: { definition: integrationDefinitionSummary(definition) },
            name: definition.id,
            provenance: { definitionId: definition.id, maintainedBy: "opensteer" },
            sourceKind: "built-in",
            status: "active",
            title: definition.name,
            trust: "built-in",
            version: "generation-order",
          },
          requestId: "installation-generation-order",
          computerConnectionTools: (connectionId, access) => setup.tools(access)(connectionId),
          servers: [
            {
              connectionRequirement: { definitionId: definition.id, kind: "computer" },
              id: setup.serverId,
              name: "default",
              status: "active",
              statusDetail: null,
              catalog: { definitions: {}, tools: [] },
              transport: { definitionId: definition.id, type: "computer" },
            },
          ],
        }),
      );
      void replacing.catch(() => undefined);
      await expect
        .poll(async () =>
          (
            await sql<{ query: string }>`
        select query from pg_stat_activity where datname=current_database()
        and application_name='opensteer-computer-app-connections-test' and wait_event_type='Lock'
      `.execute(database)
          ).rows.some(({ query }) => query.includes('"integration_servers"')),
        )
        .toBe(true);
      barrier.release();
      const results = await Promise.allSettled([peer, replacing]);
      expect(barrier.conflicts).toEqual([]);
      expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
      expect(
        await database
          .selectFrom("integrationInstallations")
          .select("version")
          .where("id", "=", setup.installationId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ version: "generation-order" });
    } finally {
      barrier.release();
      await Promise.allSettled([peer, replacing]);
    }
  });

  it("orders installation tool replacement with computer revocation without a deadlock", async ({
    storeFixture,
  }) => {
    const { fixture, setApprovedComputerConnection, definition, database } = storeFixture;
    const setup = await fixture("installation-revocation-order");
    const source = await setApprovedComputerConnection({
      access: "read-write",
      actorUserId: setup.ownerUserId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "installation-revocation-order",
      runnerId: setup.runnerId,
      tools: setup.tools("read-write"),
    });
    const barrier = pauseAfterLock(
      database,
      (node) =>
        node.includes('"kind":"SelectQueryNode"') &&
        /"name":"integration_?tools"/iu.test(node) &&
        node.includes("ForNoKeyUpdate"),
    );
    const replacing = barrier.database.transaction().execute((transaction) =>
      installIntegrationInTransaction(transaction, {
        actorUserId: setup.ownerUserId,
        adapterSnapshot: null,
        installation: {
          description: definition.description,
          id: setup.installationId,
          manifest: { definition: integrationDefinitionSummary(definition) },
          name: definition.id,
          provenance: { definitionId: definition.id, maintainedBy: "opensteer" },
          sourceKind: "built-in",
          status: "active",
          title: definition.name,
          trust: "built-in",
          version: "replacement",
        },
        requestId: "installation-revocation-replace",
        computerConnectionTools: (connectionId, access) => setup.tools(access)(connectionId),
        servers: [
          {
            connectionRequirement: { definitionId: definition.id, kind: "computer" },
            id: setup.serverId,
            name: "default",
            status: "active",
            statusDetail: null,
            catalog: { definitions: {}, tools: [] },
            transport: { definitionId: definition.id, type: "computer" },
          },
        ],
      }),
    );
    void replacing.catch(() => undefined);
    let revoking: Promise<unknown> | undefined;
    try {
      await barrier.reached;
      revoking = database.transaction().execute((transaction) =>
        revokeComputerConnectionsInTransaction(transaction, {
          connectionId: source.connection.id,
          ownerUserId: setup.ownerUserId,
        }),
      );
      void revoking.catch(() => undefined);
      await expect
        .poll(async () =>
          (
            await sql<{
              query: string;
            }>`select query from pg_stat_activity where datname=current_database() and application_name='opensteer-computer-app-connections-test' and wait_event_type='Lock'`.execute(
              database,
            )
          ).rows.some(
            ({ query }) =>
              query.includes('"integration_tools"') || query.includes('"integration_connections"'),
          ),
        )
        .toBe(true);
      barrier.release();
      const results = await Promise.allSettled([replacing, revoking]);
      expect(barrier.conflicts).toEqual([]);
      expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
      expect(
        await database
          .selectFrom("integrationConnections")
          .select("status")
          .where("id", "=", source.connection.id)
          .executeTakeFirst(),
      ).toEqual({ status: "revoked" });
    } finally {
      barrier.release();
      await Promise.allSettled([replacing, revoking]);
    }
  });

  it("rejects channel health writes for a computer placement", async ({ storeFixture }) => {
    const { fixture, setApprovedComputerConnection, definition, database, platform } = storeFixture;
    const setup = await fixture("channel-isolation");
    const connected = await setApprovedComputerConnection({
      access: "read",
      actorUserId: setup.ownerUserId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "computer-channel-isolation",
      runnerId: setup.runnerId,
      tools: setup.tools("read"),
    });
    const channels = new ChannelStore(database);
    await expect(
      channels.setRuntimeConnectionHealth({
        connectionId: connected.connection.id,
        detail: "Channel runtime touched the wrong row",
        reason: null,
        runnerId: setup.runnerId,
        status: "connecting",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      platform.getComputerConnectionForCall({
        connectionId: connected.connection.id,
        ownerUserId: setup.ownerUserId,
      }),
    ).resolves.toMatchObject({
      connection: { status: "connected" },
      runnerId: setup.runnerId,
    });
  });

  it("keeps Main inheritance below a read-only connection ceiling", async ({ storeFixture }) => {
    const { store, fixture, setApprovedComputerConnection, definition, platform } = storeFixture;
    const run = await runningRunFixture(store, "main-ceiling");
    const setup = await fixture("main-ceiling", run.userId);
    const connected = await setApprovedComputerConnection({
      access: "read",
      actorUserId: setup.ownerUserId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "computer-main-connect",
      runnerId: setup.runnerId,
      tools: setup.tools("read"),
    });
    const callable = await platform.listCallableTools({
      ownerUserId: setup.ownerUserId,
      providerAuthorizations: {},
      threadId: run.threadId,
      workspaceId: run.workspaceId,
    });
    expect(callable.map(({ tool }) => tool.name)).toEqual(["read_messages"]);
    expect(callable[0]?.grant).toMatchObject({
      access: "read",
      connectionId: connected.connection.id,
      source: "main-inherited",
    });
    const inventory = await platform.listDiscoveryInventory({
      ownerUserId: setup.ownerUserId,
      providerAuthorizations: {},
      threadId: run.threadId,
      workspaceId: run.workspaceId,
    });
    expect(inventory[0]?.accounts).toContainEqual(
      expect.objectContaining({
        access: "read",
        connectionId: connected.connection.id,
      }),
    );
  });

  it("inherits Main only in a lineage that starts from a Main-profile Thread", async ({
    storeFixture,
  }) => {
    const {
      store,
      fixture,
      setApprovedComputerConnection,
      definition,
      insertLineageThread,
      platform,
    } = storeFixture;
    const run = await runningRunFixture(store, "main-lineage");
    const setup = await fixture("main-lineage", run.userId);
    await setApprovedComputerConnection({
      access: "read",
      actorUserId: setup.ownerUserId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "main-lineage-connect",
      runnerId: setup.runnerId,
      tools: setup.tools("read"),
    });
    // A channel route runs as its creator without being them, so its root
    // Thread takes `workspace` even in their own Main, and whatever it
    // delegates inherits that lineage.
    const channelRoot = await insertLineageThread(run.threadId, "workspace", null);
    const channelChild = await insertLineageThread(run.threadId, "delegated", channelRoot);
    const homeChild = await insertLineageThread(run.threadId, "delegated", run.threadId);
    const callable = async (threadId: ThreadId) =>
      (
        await platform.listCallableTools({
          ownerUserId: run.userId,
          providerAuthorizations: {},
          threadId,
          workspaceId: run.workspaceId,
        })
      ).map(({ grant, tool }) => [tool.name, "source" in grant ? grant.source : "grant"]);
    const accounts = async (threadId: ThreadId) =>
      (
        await platform.listDiscoveryInventory({
          ownerUserId: run.userId,
          providerAuthorizations: {},
          threadId,
          workspaceId: run.workspaceId,
        })
      ).flatMap(({ accounts }) => accounts);

    await expect(callable(run.threadId)).resolves.toEqual([["read_messages", "main-inherited"]]);
    await expect(callable(homeChild)).resolves.toEqual([["read_messages", "main-inherited"]]);
    await expect(callable(channelRoot)).resolves.toEqual([]);
    await expect(callable(channelChild)).resolves.toEqual([]);
    await expect(accounts(run.threadId)).resolves.not.toEqual([]);
    await expect(accounts(channelRoot)).resolves.toEqual([]);
    await expect(accounts(channelChild)).resolves.toEqual([]);
  });

  // Computer use is the one definition whose connections name an app, so these
  // exercise the third component of a computer connection's identity.

  /** A task's ask, with nothing inline to write. */

  it.for(["ask", "automatic"] as const)(
    "orders covered computer access with standalone grants (%s)",
    async (policy, { storeFixture }) => {
      const {
        store,
        guiFixture,
        approveApp,
        notes,
        allowAutomatic,
        databaseUrl,
        guiDigest,
        database,
      } = storeFixture;
      const run = await runningRunFixture(store, `covered-order-${policy}`, {
        kind: "specialized",
      });
      const setup = await guiFixture(`covered-order-${policy}`, run.userId);
      const connected = await approveApp({
        access: "read",
        actorUserId: run.userId,
        app: notes,
        requestId: "covered-order-existing",
        runnerId: setup.runnerId,
        tools: setup.gui.tools("read"),
      });
      if (policy === "automatic") await allowAutomatic(setup);
      const otherWorkspace = await createWorkspace(store, run.userId, "covered-order-other");
      const errors: { code: unknown; message: string }[] = [];
      const racing = new Kysely<DatabaseSchema>({
        dialect: new PostgresDialect({
          pool: new Pool({
            connectionString: databaseUrl,
            max: 4,
            application_name: "opensteer-covered-order-test",
          }),
        }),
        plugins: [new CamelCasePlugin({ maintainNestedObjectKeys: true })],
        log(event) {
          if (event.level === "error" && event.error instanceof Error)
            errors.push({
              code: "code" in event.error ? event.error.code : undefined,
              message: event.error.message,
            });
        },
      });
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const pausedQueries = new Set<object>();
      const grantStore = new IntegrationPlatformStore(
        racing.withPlugin({
          transformQuery(args) {
            const node = JSON.stringify(args.node);
            if (
              args.node.kind === "SelectQueryNode" &&
              /"name":"integration_?servers"/iu.test(node) &&
              node.includes("ForShare")
            )
              pausedQueries.add(args.queryId);
            return args.node;
          },
          async transformResult(args) {
            if (pausedQueries.delete(args.queryId)) {
              held.resolve();
              await release.promise;
            }
            return args.result;
          },
        }),
      );

      const granting = grantStore.createGrant({
        access: "read",
        alias: "Notes",
        connectionId: connected.connection.id,
        createdBy: run.userId,
        installationId: setup.gui.installationId,
        isDefault: true,
        ownerUserId: run.userId,
        providerAuthorizations: {},
        workspaceId: otherWorkspace.id,
      });
      void granting.catch(() => undefined);
      let asking: ReturnType<IntegrationPlatformStore["requestComputerAppAccess"]> | undefined;
      try {
        await held.promise;
        asking = new IntegrationPlatformStore(racing).requestComputerAppAccess({
          access: "read",
          app: notes,
          auditRequestId: "covered-order-ask",
          definitionDigest: guiDigest,
          definitionId: "macos-app",
          originatingRunId: run.runId,
          ownerUserId: run.userId,
          reason: "Read Notes",
          runnerId: setup.runnerId,
          threadId: run.threadId,
          threadTitle: null,
          tools: setup.gui.tools("read"),
          workspaceId: run.workspaceId,
        });
        void asking.catch(() => undefined);
        await expect
          .poll(async () =>
            (
              await sql<{ query: string }>`select query from pg_stat_activity
        where datname = current_database() and application_name = 'opensteer-covered-order-test'
        and wait_event_type = 'Lock'`.execute(database)
            ).rows.some(
              ({ query }) =>
                query.includes('"integration_servers"') ||
                query.includes('"integration_installations"'),
            ),
          )
          .toBe(true);
        release.resolve();
        const outcomes = await Promise.allSettled([granting, asking]);
        expect(errors).toEqual([]);
        expect(outcomes.filter(({ status }) => status === "rejected")).toEqual([]);
        expect(outcomes[1]).toMatchObject({
          status: "fulfilled",
          value: { kind: policy === "automatic" ? "approved" : "workspace-grant" },
        });
        expect(
          await database
            .selectFrom("integrationGrants")
            .select("id")
            .where("workspaceId", "=", otherWorkspace.id)
            .execute(),
        ).toHaveLength(1);
      } finally {
        release.resolve();
        await Promise.allSettled([granting, asking]);
        await racing.destroy();
      }
    },
  );

  it("requires the signed policy request, consumes it once, and keeps connections when switched off", async ({
    storeFixture,
  }) => {
    const {
      guiFixture,
      platform,
      approveApp,
      notes,
      guiDigest,
      computerKeys,
      allowAutomatic,
      database,
    } = storeFixture;
    const setup = await guiFixture("policy-consent");
    const owner = { runnerId: setup.runnerId, ownerUserId: setup.ownerUserId };
    expect(await platform.getComputerUsePolicy(owner)).toEqual({
      appApproval: "ask",
      approvalKeyId: expect.stringMatching(/^sha256:/u),
      revision: 0,
    });
    const connected = await approveApp({
      access: "read",
      actorUserId: setup.ownerUserId,
      app: notes,
      requestId: "policy-existing",
      runnerId: setup.runnerId,
      tools: setup.gui.tools("read"),
    });
    const appRequest = await platform.requestComputerAppSetup({
      access: "read",
      actorUserId: setup.ownerUserId,
      app: notes,
      definitionDigest: guiDigest,
      definitionId: "macos-app",
      requiresApp: true,
      runnerId: setup.runnerId,
    });
    await expect(
      platform.setComputerUsePolicy({
        ...owner,
        requestId: "wrong-kind",
        appApproval: "automatic",
        definitionDigest: guiDigest,
        approval: createComputerAppApproval(
          computerKeys.get(setup.runnerId)!.privateKey,
          appRequest.request,
        ),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const { input, policy, request } = await allowAutomatic(setup);
    expect(policy).toEqual({ appApproval: "automatic", revision: 1 });
    await expect(platform.setComputerUsePolicy(input)).rejects.toMatchObject({ code: "forbidden" });
    const stored = await database
      .selectFrom("computerUsePolicies")
      .selectAll()
      .where("runnerId", "=", setup.runnerId)
      .executeTakeFirstOrThrow();
    expect(stored.approval).toEqual({ request, approval: input.approval });
    await expect(
      platform.setComputerUsePolicy({ ...owner, requestId: "policy-off", appApproval: "ask" }),
    ).resolves.toEqual({ appApproval: "ask", revision: 2 });
    expect(
      (
        await database
          .selectFrom("computerUsePolicies")
          .select("approval")
          .where("runnerId", "=", setup.runnerId)
          .executeTakeFirstOrThrow()
      ).approval,
    ).toBeNull();
    expect(
      (
        await database
          .selectFrom("integrationConnections")
          .selectAll()
          .where("id", "=", connected.connection.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("connected");
    expect(
      await database
        .selectFrom("integrationTools")
        .select("name")
        .where("connectionId", "=", connected.connection.id)
        .execute(),
    ).toEqual([{ name: "observe" }]);
  });

  it("approves automatically with its grant and policy provenance, refuses widening, and rolls back a failed grant", async ({
    storeFixture,
  }) => {
    const { store, guiFixture, guiInput, notes, platform, allowAutomatic, database } = storeFixture;
    const run = await runningRunFixture(store, "automatic-grant", { kind: "specialized" });
    const setup = await guiFixture("automatic-grant", run.userId);
    const input = {
      ...guiInput({
        access: "read",
        actorUserId: run.userId,
        app: notes,
        requestId: "automatic",
        runnerId: setup.runnerId,
        tools: setup.gui.tools("read"),
      }),
      workspaceId: run.workspaceId,
    };
    await expect(platform.approveComputerAppAutomatically(input)).rejects.toMatchObject({
      code: "forbidden",
    });
    await allowAutomatic(setup);
    await expect(
      platform.approveComputerAppAutomatically({ ...input, workspaceId: createId("workspace") }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await database
        .selectFrom("integrationConnections")
        .select("id")
        .where("runnerId", "=", setup.runnerId)
        .execute(),
    ).toEqual([]);
    const approved = await platform.approveComputerAppAutomatically(input);
    expect(approved.connection).toMatchObject({
      displayName: "Notes on Mac automatic-grant",
      computer: { access: "read", policyRevision: null, blockedAt: null },
    });
    expect(approved.grants).toEqual([
      expect.objectContaining({
        workspaceId: run.workspaceId,
        connectionId: approved.connection.id,
        access: "read",
      }),
    ]);
    await expect(
      platform.approveComputerAppAutomatically({
        ...input,
        access: "read-write",
        tools: setup.gui.tools("read-write"),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const again = await platform.approveComputerAppAutomatically(input);
    expect(again.created).toBe(false);
    expect(again.connection.id).toBe(approved.connection.id);
    expect(
      await database
        .selectFrom("integrationTools")
        .select("name")
        .where("connectionId", "=", approved.connection.id)
        .execute(),
    ).toEqual([{ name: "observe" }]);
  });

  it("grants an existing controlled app automatically without narrowing its access or replacing tools", async ({
    storeFixture,
  }) => {
    const { store, guiFixture, approveApp, notes, database, allowAutomatic, platform, guiInput } =
      storeFixture;
    const run = await runningRunFixture(store, "automatic-existing", { kind: "specialized" });
    const setup = await guiFixture("automatic-existing", run.userId);
    const signed = await approveApp({
      access: "read-write",
      actorUserId: run.userId,
      app: notes,
      requestId: "existing",
      runnerId: setup.runnerId,
      tools: setup.gui.tools("read-write"),
    });
    const tools = await database
      .selectFrom("integrationTools")
      .select(["id", "name"])
      .where("connectionId", "=", signed.connection.id)
      .orderBy("name")
      .execute();
    await allowAutomatic(setup);
    const granted = await platform.approveComputerAppAutomatically({
      ...guiInput({
        access: "read",
        actorUserId: run.userId,
        app: notes,
        requestId: "grant-existing",
        runnerId: setup.runnerId,
        tools: setup.gui.tools("read"),
      }),
      workspaceId: run.workspaceId,
    });
    expect(granted.connection.computer).toMatchObject({
      access: "read-write",
      policyRevision: null,
    });
    expect(granted.sessionReset).toBeNull();
    expect(granted.grants).toEqual([
      expect.objectContaining({ access: "read", workspaceId: run.workspaceId }),
    ]);
    expect(
      await database
        .selectFrom("integrationTools")
        .select(["id", "name"])
        .where("connectionId", "=", signed.connection.id)
        .orderBy("name")
        .execute(),
    ).toEqual(tools);
  });

  it("keeps blocked connections tool-less across reinstall and automatic requests, and unblocks only with a signed approval", async ({
    storeFixture,
  }) => {
    const {
      store,
      guiFixture,
      allowAutomatic,
      guiInput,
      notes,
      platform,
      database,
      computerUseDefinition,
      guiDefinition,
      approveApp,
    } = storeFixture;
    const run = await runningRunFixture(store, "blocked-automatic", { kind: "specialized" });
    const setup = await guiFixture("blocked-automatic", run.userId);
    await allowAutomatic(setup);
    const input = {
      ...guiInput({
        access: "read-write",
        actorUserId: run.userId,
        app: notes,
        requestId: "blocked",
        runnerId: setup.runnerId,
        tools: setup.gui.tools("read-write"),
      }),
      workspaceId: run.workspaceId,
    };
    const approved = await platform.approveComputerAppAutomatically(input);
    await platform.blockComputerApp({
      connectionId: approved.connection.id,
      ownerUserId: run.userId,
      requestId: "block",
    });
    await expect(platform.approveComputerAppAutomatically(input)).rejects.toMatchObject({
      code: "forbidden",
      message: "Notes is blocked on Mac blocked-automatic. The person can unblock it on that Mac.",
    });
    await expect(platform.setComputerConnection(input)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(
      await database
        .selectFrom("integrationTools")
        .select("id")
        .where("connectionId", "=", approved.connection.id)
        .execute(),
    ).toEqual([]);
    expect(
      await database
        .selectFrom("integrationGrants")
        .select("status")
        .where("connectionId", "=", approved.connection.id)
        .execute(),
    ).toEqual([{ status: "revoked" }]);
    await platform.install({
      actorUserId: run.userId,
      adapterSnapshot: null,
      computerConnectionTools: (id, access) => computerAppTools(computerUseDefinition, access, id),
      installation: {
        description: guiDefinition.description,
        id: setup.gui.installationId,
        manifest: { definition: integrationDefinitionSummary(guiDefinition) },
        name: guiDefinition.id,
        provenance: { definitionId: guiDefinition.id, maintainedBy: "opensteer" },
        sourceKind: "built-in",
        status: "active",
        title: guiDefinition.name,
        trust: "built-in",
        version: "blocked-refresh",
      },
      requestId: "blocked-refresh",
      servers: [
        {
          connectionRequirement: { kind: "computer", definitionId: guiDefinition.id },
          id: setup.gui.serverId,
          name: "default",
          status: "active",
          statusDetail: null,
          catalog: { definitions: {}, tools: [] },
          transport: { type: "computer", definitionId: guiDefinition.id },
        },
      ],
    });
    expect(
      await database
        .selectFrom("integrationTools")
        .select("id")
        .where("connectionId", "=", approved.connection.id)
        .execute(),
    ).toEqual([]);
    const unblocked = await approveApp(input);
    expect(unblocked.connection.id).toBe(approved.connection.id);
    expect(unblocked.connection.computer?.blockedAt).toBeNull();
    expect(
      (
        await database
          .selectFrom("integrationTools")
          .select("name")
          .where("connectionId", "=", approved.connection.id)
          .execute()
      )
        .map(({ name }) => name)
        .sort(),
    ).toEqual(["act", "observe"]);
  });

  it("settles a pending app Request and grant in the automatic transaction", async ({
    storeFixture,
  }) => {
    const {
      store,
      guiFixture,
      askOnMac,
      notes,
      guiDigest,
      platform,
      allowAutomatic,
      guiInput,
      database,
    } = storeFixture;
    const run = await runningRunFixture(store, "automatic-pending", { kind: "specialized" });
    const setup = await guiFixture("automatic-pending", run.userId);
    const pending = await askOnMac({
      access: "read",
      app: notes,
      definitionDigest: guiDigest,
      definitionId: "macos-app",
      reason: "Read the meeting notes.",
      threadTitle: "Prepare the meeting",
      originatingRunId: run.runId,
      ownerUserId: run.userId,
      runnerId: setup.runnerId,
      threadId: run.threadId,
      workspaceId: run.workspaceId,
    });
    expect((await platform.listComputerAppSetupRequests(run.userId))[0]).toMatchObject({
      kind: "app",
      reason: "Read the meeting notes.",
      threadTitle: "Prepare the meeting",
      threadId: run.threadId,
      workspaceId: run.workspaceId,
    });
    await allowAutomatic(setup);
    const approved = await platform.approveComputerAppAutomatically({
      ...guiInput({
        access: "read",
        actorUserId: run.userId,
        app: notes,
        requestId: "automatic-pending",
        runnerId: setup.runnerId,
        tools: setup.gui.tools("read"),
      }),
      workspaceId: run.workspaceId,
    });
    expect(approved.fulfilledRequestIds).toEqual([pending.request.id]);
    expect(approved.grants).toHaveLength(1);
    expect(
      (
        await database
          .selectFrom("requests")
          .select("status")
          .where("id", "=", pending.request.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("fulfilled");
    expect(await platform.listComputerAppSetupRequests(run.userId)).toEqual([]);
  });

  it("gives each app its own connection, folds a differently cased bundle id into it, and leaves an app-less computer app its own slot", async ({
    storeFixture,
  }) => {
    const {
      guiFixture,
      approveApp,
      notes,
      calendar,
      platform,
      guiInput,
      setApprovedComputerConnection,
      definition,
      database,
      guiDefinition,
    } = storeFixture;
    const setup = await guiFixture("two-apps");
    const notesConnection = await approveApp({
      access: "read",
      actorUserId: setup.ownerUserId,
      app: notes,
      requestId: "two-apps-notes",
      runnerId: setup.runnerId,
      tools: setup.gui.tools("read"),
    });
    const calendarConnection = await approveApp({
      access: "read-write",
      actorUserId: setup.ownerUserId,
      app: calendar,
      requestId: "two-apps-calendar",
      runnerId: setup.runnerId,
      tools: setup.gui.tools("read-write"),
    });
    expect(notesConnection.created).toBe(true);
    expect(calendarConnection.created).toBe(true);
    expect(notesConnection.connection.id).not.toBe(calendarConnection.connection.id);
    expect(notesConnection.connection.computer).toEqual({
      access: "read",
      app: notes,
      blockedAt: null,
      policyRevision: null,
      runnerId: setup.runnerId,
    });
    expect(calendarConnection.connection.computer).toEqual({
      access: "read-write",
      app: calendar,
      blockedAt: null,
      policyRevision: null,
      runnerId: setup.runnerId,
    });
    const narrowedCalendar = await platform.setComputerConnection(
      guiInput({
        access: "read",
        actorUserId: setup.ownerUserId,
        app: calendar,
        requestId: "two-apps-calendar-narrow",
        runnerId: setup.runnerId,
        tools: setup.gui.tools("read"),
      }),
    );
    expect(narrowedCalendar.sessionReset).toEqual({
      appKey: "com.apple.ical",
      kind: "app",
      runnerId: setup.runnerId,
    });

    // macOS resolves bundle identifiers case-insensitively, so this is the
    // same app shouted, not a second one.
    const shouted = await approveApp({
      access: "read",
      actorUserId: setup.ownerUserId,
      app: { ...notes, bundleId: notes.bundleId.toUpperCase(), displayName: "NOTES" },
      requestId: "two-apps-notes-shouted",
      runnerId: setup.runnerId,
      tools: setup.gui.tools("read"),
    });
    expect(shouted.created).toBe(false);
    expect(shouted.connection.id).toBe(notesConnection.connection.id);

    // Messages is the whole app rather than one app on the Mac, so its row
    // keeps `app = null` and still satisfies the same unique index.
    const messages = await setApprovedComputerConnection({
      access: "read",
      actorUserId: setup.ownerUserId,
      createIfMissing: true,
      definitionId: definition.id,
      requestId: "two-apps-messages",
      runnerId: setup.runnerId,
      tools: setup.tools("read"),
    });
    expect(messages.connection.computer).toEqual({
      access: "read",
      app: null,
      blockedAt: null,
      policyRevision: null,
      runnerId: setup.runnerId,
    });
    await expect(
      database
        .selectFrom("integrationConnections")
        .select(["computerAppKey", "integrationDefinitionId"])
        .where("connectionKind", "=", "computer")
        .where("status", "!=", "revoked")
        .orderBy("integrationDefinitionId", "asc")
        .orderBy("computerAppKey", "asc")
        .execute(),
    ).resolves.toEqual([
      { computerAppKey: null, integrationDefinitionId: definition.id },
      { computerAppKey: "com.apple.ical", integrationDefinitionId: guiDefinition.id },
      { computerAppKey: "com.apple.notes", integrationDefinitionId: guiDefinition.id },
    ]);
    // One key, and the identity the person last approved under it.
    expect(shouted.connection.computer?.app).toEqual({
      bundleId: notes.bundleId.toUpperCase(),
      displayName: "NOTES",
      teamId: null,
    });
    // Every listing that projects a computer connection carries the app.
    await expect(
      new IntegrationStore(database)
        .listConnections(setup.ownerUserId)
        .then((rows) => rows.map(({ computer }) => computer?.app ?? null)),
    ).resolves.toEqual(
      expect.arrayContaining([
        null,
        calendar,
        { bundleId: notes.bundleId.toUpperCase(), displayName: "NOTES", teamId: null },
      ]),
    );
    await expect(
      platform.getComputerConnectionForCall({
        connectionId: calendarConnection.connection.id,
        ownerUserId: setup.ownerUserId,
      }),
    ).resolves.toMatchObject({ connection: { computer: { app: calendar } } });
  });

  it("refuses an app on a definition that has none, and a missing app on one that needs it", async ({
    storeFixture,
  }) => {
    const { guiFixture, platform, guiDigest, guiDefinition, guiInput, notes, definition } =
      storeFixture;
    const setup = await guiFixture("app-presence");
    await expect(
      platform.requestComputerAppSetup({
        access: "read",
        actorUserId: setup.ownerUserId,
        app: null,
        definitionDigest: guiDigest,
        definitionId: guiDefinition.id,
        requiresApp: true,
        runnerId: setup.runnerId,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      platform.setComputerConnection({
        ...guiInput({
          access: "read",
          actorUserId: setup.ownerUserId,
          app: notes,
          requestId: "app-presence-wrong-definition",
          runnerId: setup.runnerId,
          tools: setup.tools("read"),
        }),
        definitionDigest: integrationDefinitionDigest(definition),
        definitionId: definition.id,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("consumes one app's approval and leaves another app's pending", async ({ storeFixture }) => {
    const {
      guiFixture,
      platform,
      guiDigest,
      guiDefinition,
      notes,
      calendar,
      guiInput,
      computerKeys,
    } = storeFixture;
    const setup = await guiFixture("scoped-approval");
    const ask = async (app: ComputerAppIdentity) =>
      (
        await platform.requestComputerAppSetup({
          access: "read",
          actorUserId: setup.ownerUserId,
          app,
          definitionDigest: guiDigest,
          definitionId: guiDefinition.id,
          requiresApp: true,
          runnerId: setup.runnerId,
        })
      ).request;
    const notesRequest = await ask(notes);
    const calendarRequest = await ask(calendar);
    expect(notesRequest.app).toEqual(notes);
    expect(await platform.listComputerAppSetupRequests(setup.ownerUserId)).toEqual([
      notesRequest,
      calendarRequest,
    ]);

    await platform.setComputerConnection({
      ...guiInput({
        access: "read",
        actorUserId: setup.ownerUserId,
        app: notes,
        requestId: "scoped-approval-notes",
        runnerId: setup.runnerId,
        tools: setup.gui.tools("read"),
      }),
      approval: createComputerAppApproval(
        computerKeys.get(setup.runnerId)!.privateKey,
        notesRequest,
      ),
    });
    expect(await platform.listComputerAppSetupRequests(setup.ownerUserId)).toEqual([
      calendarRequest,
    ]);
    // Notes' proof cannot stand in for Calendar's, and Calendar's is still live.
    await expect(
      platform.setComputerConnection({
        ...guiInput({
          access: "read",
          actorUserId: setup.ownerUserId,
          app: calendar,
          requestId: "scoped-approval-crossed",
          runnerId: setup.runnerId,
          tools: setup.gui.tools("read"),
        }),
        approval: createComputerAppApproval(
          computerKeys.get(setup.runnerId)!.privateKey,
          notesRequest,
        ),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const calendarConnection = await platform.setComputerConnection({
      ...guiInput({
        access: "read",
        actorUserId: setup.ownerUserId,
        app: calendar,
        requestId: "scoped-approval-calendar",
        runnerId: setup.runnerId,
        tools: setup.gui.tools("read"),
      }),
      approval: createComputerAppApproval(
        computerKeys.get(setup.runnerId)!.privateKey,
        calendarRequest,
      ),
    });
    expect(calendarConnection.created).toBe(true);
    expect(await platform.listComputerAppSetupRequests(setup.ownerUserId)).toEqual([]);
  });

  it("refuses to apply a signature to a different full identity with the same app key", async ({
    storeFixture,
  }) => {
    const {
      guiFixture,
      platform,
      notes,
      guiDigest,
      guiDefinition,
      computerKeys,
      guiInput,
      database,
    } = storeFixture;
    const setup = await guiFixture("exact-signed-identity");
    const { request } = await platform.requestComputerAppSetup({
      access: "read",
      actorUserId: setup.ownerUserId,
      app: notes,
      definitionDigest: guiDigest,
      definitionId: guiDefinition.id,
      requiresApp: true,
      runnerId: setup.runnerId,
    });
    const approval = createComputerAppApproval(
      computerKeys.get(setup.runnerId)!.privateKey,
      request,
    );
    const substituted = { ...notes, displayName: "Impostor Notes", teamId: "ABCDEFGHIJ" };

    await expect(
      platform.setComputerConnection({
        ...guiInput({
          access: "read",
          actorUserId: setup.ownerUserId,
          app: substituted,
          requestId: "exact-signed-identity-substitution",
          runnerId: setup.runnerId,
          tools: setup.gui.tools("read"),
        }),
        approval,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      database
        .selectFrom("integrationConnections")
        .select("id")
        .where("runnerId", "=", setup.runnerId)
        .where("computerAppKey", "=", "com.apple.notes")
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
  });

  it("replays one ask, then fulfils it with the specialized Workspace grant when that Mac approves", async ({
    storeFixture,
  }) => {
    const {
      store,
      guiFixture,
      notes,
      guiDigest,
      guiDefinition,
      askOnMac,
      platform,
      guiInput,
      computerKeys,
    } = storeFixture;
    const run = await runningRunFixture(store, "computer-use-grant", { kind: "specialized" });
    const setup = await guiFixture("computer-use-grant", run.userId);
    const ask = {
      access: "read" as const,
      app: notes,
      definitionDigest: guiDigest,
      definitionId: guiDefinition.id as "macos-app",
      reason: "Find the task notes.",
      threadTitle: "Review notes",
      originatingRunId: run.runId,
      ownerUserId: run.userId,
      runnerId: setup.runnerId,
      threadId: run.threadId,
      workspaceId: run.workspaceId,
    };
    const opened = await askOnMac(ask);
    expect(opened.replayed).toBe(false);
    expect(opened.requestEvents).toEqual([
      expect.objectContaining({
        data: { request: expect.objectContaining({ id: opened.request.id }) },
        threadId: run.threadId,
        type: "request.opened",
      }),
    ]);
    expect(opened.setupRequest).toMatchObject({ access: "read", app: notes });
    expect(opened.request).toMatchObject({
      kind: "computer.app.access",
      mode: "durable",
      payload: {
        access: "read",
        app: notes,
        definitionId: "macos-app",
        runnerId: setup.runnerId,
        setupRequestId: opened.setupRequest.id,
        workspaceId: run.workspaceId,
      },
      presentation: {
        kind: "external",
        subject: { id: opened.setupRequest.id, kind: "computer-app-setup" },
        title: "Wants to use Notes on Mac computer-use-grant",
      },
      // The Mac's owner answers — who is always the one whose task asked.
      requiredActor: "requester",
      status: "pending",
    });
    const again = await askOnMac(ask);
    expect(again.replayed).toBe(true);
    expect(again.requestEvents).toEqual([]);
    expect(again.request.id).toBe(opened.request.id);
    expect(again.setupRequest.id).toBe(opened.setupRequest.id);
    // A second call with a different call identity is still the same card.
    const relabelled = await askOnMac({
      ...ask,
      idempotencyKey: "a-second-tool-call",
    });
    expect(relabelled.request.id).toBe(opened.request.id);

    const consumed = await platform.setComputerConnection({
      ...guiInput({
        access: "read",
        actorUserId: run.userId,
        app: notes,
        requestId: "computer-use-grant-consume",
        runnerId: setup.runnerId,
        tools: setup.gui.tools("read"),
      }),
      approval: createComputerAppApproval(
        computerKeys.get(setup.runnerId)!.privateKey,
        opened.setupRequest,
      ),
    });
    expect(consumed.fulfilledRequestIds).toEqual([opened.request.id]);
    expect(consumed.grants).toEqual([
      expect.objectContaining({
        access: "read",
        alias: "Notes",
        connectionId: consumed.connection.id,
        workspaceId: run.workspaceId,
      }),
    ]);
    expect(consumed.requestEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "request.resolved", threadId: run.threadId }),
      ]),
    );
    await expect(platform.requests.get(opened.request.id)).resolves.toMatchObject({
      status: "fulfilled",
    });
    // The Thread hears about it through the same continuation an
    // `integration.access` answer produces.
    await expect(
      platform.requests
        .listPendingContinuations()
        .then((entries) => entries.map(({ request }) => request.id)),
    ).resolves.toContain(opened.request.id);
    await expect(platform.listComputerAppSetupRequests(run.userId)).resolves.toEqual([]);
  });

  it("grants nothing extra when the asking Workspace is Main", async ({ storeFixture }) => {
    const {
      store,
      guiFixture,
      askOnMac,
      calendar,
      guiDigest,
      guiDefinition,
      platform,
      guiInput,
      computerKeys,
    } = storeFixture;
    const run = await runningRunFixture(store, "computer-use-main");
    const setup = await guiFixture("computer-use-main", run.userId);
    const opened = await askOnMac({
      access: "read-write",
      app: calendar,
      definitionDigest: guiDigest,
      definitionId: guiDefinition.id as "macos-app",
      reason: "Find the task notes.",
      threadTitle: "Review notes",
      originatingRunId: run.runId,
      ownerUserId: run.userId,
      runnerId: setup.runnerId,
      threadId: run.threadId,
      workspaceId: run.workspaceId,
    });
    const consumed = await platform.setComputerConnection({
      ...guiInput({
        access: "read-write",
        actorUserId: run.userId,
        app: calendar,
        requestId: "computer-use-main-consume",
        runnerId: setup.runnerId,
        tools: setup.gui.tools("read-write"),
      }),
      approval: createComputerAppApproval(
        computerKeys.get(setup.runnerId)!.privateKey,
        opened.setupRequest,
      ),
    });
    expect(consumed.fulfilledRequestIds).toEqual([opened.request.id]);
    expect(consumed.grants).toEqual([]);
  });

  it("declines from anywhere but that Mac, and takes the approval with it", async ({
    storeFixture,
  }) => {
    const { store, guiFixture, askOnMac, notes, guiDigest, guiDefinition, platform, database } =
      storeFixture;
    const run = await runningRunFixture(store, "computer-use-decline");
    const setup = await guiFixture("computer-use-decline", run.userId);
    const opened = await askOnMac({
      access: "read",
      app: notes,
      definitionDigest: guiDigest,
      definitionId: guiDefinition.id as "macos-app",
      reason: "Find the task notes.",
      threadTitle: "Review notes",
      originatingRunId: run.runId,
      ownerUserId: run.userId,
      runnerId: setup.runnerId,
      threadId: run.threadId,
      workspaceId: run.workspaceId,
    });
    // Only "not now" is a person's to say from a phone.
    await expect(
      platform.declineComputerAppAccessRequest({
        actorUserId: run.userId,
        requestId: opened.request.id,
        response: { kind: "external", value: { decision: "fulfilled" } },
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    const declined = await platform.declineComputerAppAccessRequest({
      actorUserId: run.userId,
      requestId: opened.request.id,
    });
    expect(declined.request.status).toBe("declined");
    expect(declined.events).toContainEqual(expect.objectContaining({ type: "request.resolved" }));
    await expect(platform.listComputerAppSetupRequests(run.userId)).resolves.toEqual([]);
    await expect(
      database
        .selectFrom("computerAppSetupRequests")
        .select("id")
        .where("id", "=", opened.setupRequest.id)
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
    await expect(
      platform.declineComputerAppAccessRequest({
        actorUserId: run.userId,
        requestId: opened.request.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("declines the waiting Thread when the owner cancels or expires the approval, and names what a removal took back", async ({
    storeFixture,
  }) => {
    const {
      store,
      guiFixture,
      notes,
      guiDigest,
      guiDefinition,
      askOnMac,
      platform,
      database,
      approveApp,
    } = storeFixture;
    const run = await runningRunFixture(store, "computer-use-cancel");
    const setup = await guiFixture("computer-use-cancel", run.userId);
    const ask = {
      access: "read" as const,
      app: notes,
      definitionDigest: guiDigest,
      definitionId: guiDefinition.id as "macos-app",
      reason: "Find the task notes.",
      threadTitle: "Review notes",
      originatingRunId: run.runId,
      ownerUserId: run.userId,
      runnerId: setup.runnerId,
      threadId: run.threadId,
      workspaceId: run.workspaceId,
    };
    const opened = await askOnMac(ask);
    const cancelled = await platform.cancelComputerAppSetup({
      ownerUserId: run.userId,
      requestId: opened.setupRequest.id,
    });
    expect(cancelled.requestIds).toEqual([opened.request.id]);
    expect(cancelled.grants).toEqual([]);
    await expect(platform.requests.get(opened.request.id)).resolves.toMatchObject({
      status: "declined",
    });

    // An approval nobody answered inside its week takes its Request with it.
    const reopened = await askOnMac({
      ...ask,
      idempotencyKey: "computer-use-cancel-second",
    });
    await database
      .updateTable("computerAppSetupRequests")
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where("id", "=", reopened.setupRequest.id)
      .execute();
    const expired = await platform.expireComputerAppSetupRequests();
    expect(expired.requestIds).toEqual([reopened.request.id]);
    await expect(platform.requests.get(reopened.request.id)).resolves.toMatchObject({
      status: "declined",
    });

    // Turning the app off tells the caller which `(runnerId, appKey)` to close.
    const connection = await approveApp({
      access: "read",
      actorUserId: run.userId,
      app: notes,
      requestId: "computer-use-cancel-connect",
      runnerId: setup.runnerId,
      tools: setup.gui.tools("read"),
    });
    const removal = await platform.revokeComputerConnection({
      connectionId: connection.connection.id,
      ownerUserId: run.userId,
      requestId: "computer-use-cancel-off",
    });
    expect(removal.removedApps).toEqual([
      {
        app: notes,
        appKey: "com.apple.notes",
        connectionId: connection.connection.id,
        definitionId: guiDefinition.id,
        runnerId: setup.runnerId,
      },
    ]);
  });

  it("takes consent only from the desktop key its owner registered for that Mac", async ({
    storeFixture,
  }) => {
    const {
      guiFixture,
      platform,
      notes,
      guiDigest,
      guiDefinition,
      guiInput,
      computerKeys,
      runnerKeys,
      database,
      store,
    } = storeFixture;
    const setup = await guiFixture("approval-key");
    const { request } = await platform.requestComputerAppSetup({
      access: "read",
      actorUserId: setup.ownerUserId,
      app: notes,
      definitionDigest: guiDigest,
      definitionId: guiDefinition.id,
      requiresApp: true,
      runnerId: setup.runnerId,
    });
    const consume = (privateKey: import("node:crypto").KeyObject) =>
      platform.setComputerConnection({
        ...guiInput({
          access: "read",
          actorUserId: setup.ownerUserId,
          app: notes,
          requestId: "approval-key",
          runnerId: setup.runnerId,
          tools: setup.gui.tools("read"),
        }),
        approval: createComputerAppApproval(privateKey, request),
      });
    const publicKey = computerKeys
      .get(setup.runnerId)!
      .publicKey.export({ format: "pem", type: "spki" })
      .toString();
    await expect(
      platform.getComputerUsePolicy({ ownerUserId: setup.ownerUserId, runnerId: setup.runnerId }),
    ).resolves.toMatchObject({ approvalKeyId: expect.stringMatching(/^sha256:/u) });

    // The Runner's own key — which every process running as the person can
    // read — signs nothing the Host takes as the person's consent.
    await expect(consume(runnerKeys.get(setup.runnerId)!.privateKey)).rejects.toMatchObject({
      code: "forbidden",
      message: "Approve this access in Opensteer on the computer that provides the app.",
    });

    // With no key registered nothing is accepted, and the refusal says how to
    // register one: open this Mac's page on the Mac.
    await database
      .deleteFrom("computerUseApprovalKeys")
      .where("runnerId", "=", setup.runnerId)
      .execute();
    await expect(
      platform.getComputerUsePolicy({ ownerUserId: setup.ownerUserId, runnerId: setup.runnerId }),
    ).resolves.toMatchObject({ approvalKeyId: null });
    await expect(consume(computerKeys.get(setup.runnerId)!.privateKey)).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("Open this Mac's page in Opensteer"),
    });

    // Only the Mac's owner registers one.
    const stranger = await store.createUser("Stranger");
    await expect(
      platform.registerComputerUseApprovalKey({
        ownerUserId: stranger,
        publicKey,
        requestId: "stranger-key",
        runnerId: setup.runnerId,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      platform.registerComputerUseApprovalKey({
        ownerUserId: setup.ownerUserId,
        publicKey: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n",
        requestId: "bad-key",
        runnerId: setup.runnerId,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });

    // Setting computer use up on the Mac again registers it, and then it approves.
    await expect(
      platform.registerComputerUseApprovalKey({
        ownerUserId: setup.ownerUserId,
        publicKey,
        requestId: "re-register",
        runnerId: setup.runnerId,
      }),
    ).resolves.toMatchObject({ replaced: false });
    await expect(consume(computerKeys.get(setup.runnerId)!.privateKey)).resolves.toMatchObject({
      created: true,
    });

    // A new desktop key replaces the old one, which then approves nothing.
    const rotated = generateKeyPairSync("ed25519");
    await expect(
      platform.registerComputerUseApprovalKey({
        ownerUserId: setup.ownerUserId,
        publicKey: rotated.publicKey.export({ format: "pem", type: "spki" }).toString(),
        requestId: "rotate",
        runnerId: setup.runnerId,
      }),
    ).resolves.toMatchObject({ replaced: true });
    const { request: widen } = await platform.requestComputerAppSetup({
      access: "read-write",
      actorUserId: setup.ownerUserId,
      app: notes,
      definitionDigest: guiDigest,
      definitionId: guiDefinition.id,
      requiresApp: true,
      runnerId: setup.runnerId,
    });
    await expect(
      platform.setComputerConnection({
        ...guiInput({
          access: "read-write",
          actorUserId: setup.ownerUserId,
          app: notes,
          requestId: "rotated-away",
          runnerId: setup.runnerId,
          tools: setup.gui.tools("read-write"),
        }),
        approval: createComputerAppApproval(computerKeys.get(setup.runnerId)!.privateKey, widen),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      platform.setComputerConnection({
        ...guiInput({
          access: "read-write",
          actorUserId: setup.ownerUserId,
          app: notes,
          requestId: "rotated-key-consumes",
          runnerId: setup.runnerId,
          tools: setup.gui.tools("read-write"),
        }),
        approval: createComputerAppApproval(rotated.privateKey, widen),
      }),
    ).resolves.toMatchObject({ connection: { computer: { access: "read-write" } } });
  });

  it("answers an identity-change approval only with that identity, never with an edit that kept the old one", async ({
    storeFixture,
  }) => {
    const {
      store,
      guiFixture,
      approveApp,
      notes,
      askOnMac,
      guiDigest,
      guiDefinition,
      platform,
      guiInput,
      computerKeys,
    } = storeFixture;
    const run = await runningRunFixture(store, "identity-change", { kind: "specialized" });
    const mac = await guiFixture("identity-change", run.userId);
    await approveApp({
      access: "read",
      actorUserId: run.userId,
      app: notes,
      requestId: "notes-before",
      runnerId: mac.runnerId,
      tools: mac.gui.tools("read"),
    });
    // The Mac now resolves Notes re-signed by another team, so the task waits
    // on an approval for that identity.
    const resigned: ComputerAppIdentity = { ...notes, teamId: "NEWTEAM001" };
    const opened = await askOnMac({
      access: "read",
      app: resigned,
      definitionDigest: guiDigest,
      definitionId: guiDefinition.id as "macos-app",
      reason: "Read the note.",
      threadTitle: "Notes",
      originatingRunId: run.runId,
      ownerUserId: run.userId,
      runnerId: mac.runnerId,
      threadId: run.threadId,
      workspaceId: run.workspaceId,
    });
    expect(opened.setupRequest.app).toEqual(resigned);

    // The owner keeps Notes' access from a phone: unsigned, the same access,
    // and the connection keeps the identity it was approved with.
    const kept = await platform.setComputerConnection(
      guiInput({
        access: "read",
        actorUserId: run.userId,
        app: notes,
        requestId: "keep-from-phone",
        runnerId: mac.runnerId,
        tools: mac.gui.tools("read"),
      }),
    );
    expect(kept.connection.computer?.app).toEqual(notes);
    expect(kept.fulfilledRequestIds).toEqual([]);
    await expect(platform.requests.get(opened.request.id)).resolves.toMatchObject({
      status: "pending",
    });
    await expect(platform.listComputerAppSetupRequests(run.userId)).resolves.toEqual([
      expect.objectContaining({ app: resigned, id: opened.setupRequest.id }),
    ]);

    // The signed answer for the new identity is what fulfils it.
    const approved = await platform.setComputerConnection({
      ...guiInput({
        access: "read",
        actorUserId: run.userId,
        app: resigned,
        requestId: "approve-resigned",
        runnerId: mac.runnerId,
        tools: mac.gui.tools("read"),
      }),
      approval: createComputerAppApproval(
        computerKeys.get(mac.runnerId)!.privateKey,
        opened.setupRequest,
      ),
    });
    expect(approved.connection.computer?.app).toEqual(resigned);
    expect(approved.fulfilledRequestIds).toEqual([opened.request.id]);
  });

  it("relabels both pending task cards when an app's identity changes before approval", async ({
    storeFixture,
  }) => {
    const {
      store,
      guiFixture,
      guiDigest,
      guiDefinition,
      askOnMac,
      notes,
      platform,
      guiInput,
      computerKeys,
    } = storeFixture;
    const run = await runningRunFixture(store, "identity-change-pending", { kind: "specialized" });
    const mac = await guiFixture("identity-change-pending", run.userId);
    const ask = {
      access: "read" as const,
      definitionDigest: guiDigest,
      definitionId: guiDefinition.id as "macos-app",
      originatingRunId: run.runId,
      ownerUserId: run.userId,
      runnerId: mac.runnerId,
      threadId: run.threadId,
      threadTitle: "Notes",
      workspaceId: run.workspaceId,
    };
    const first = await askOnMac({
      ...ask,
      app: notes,
      idempotencyKey: "old-identity",
      reason: "Read the first note.",
    });
    const renamed: ComputerAppIdentity = {
      ...notes,
      displayName: "Notes from another team",
      teamId: "NEWTEAM001",
    };
    const second = await askOnMac({
      ...ask,
      access: "read-write",
      app: renamed,
      idempotencyKey: "new-identity",
      reason: "Read the second note.",
    });
    expect(second.setupRequest.id).not.toBe(first.setupRequest.id);
    for (const [id, reason] of [
      [first.request.id, "Read the first note."],
      [second.request.id, "Read the second note."],
    ] as const) {
      await expect(platform.requests.get(id)).resolves.toMatchObject({
        payload: {
          app: renamed,
          reason,
          setupRequestId: second.setupRequest.id,
        },
        presentation: {
          detail: expect.stringContaining("Notes from another team on Mac identity-change-pending"),
          subject: { id: second.setupRequest.id },
          title: expect.stringContaining("Notes from another team"),
        },
        status: "pending",
      });
    }
    const approved = await platform.setComputerConnection({
      ...guiInput({
        access: "read-write",
        actorUserId: run.userId,
        app: renamed,
        requestId: "approve-renamed-pending",
        runnerId: mac.runnerId,
        tools: mac.gui.tools("read-write"),
      }),
      approval: createComputerAppApproval(
        computerKeys.get(mac.runnerId)!.privateKey,
        second.setupRequest,
      ),
    });
    expect(approved.fulfilledRequestIds).toEqual(
      expect.arrayContaining([first.request.id, second.request.id]),
    );
  });

  it("decides two tasks' asks in one Workspace on two Macs without deadlocking", async ({
    storeFixture,
  }) => {
    const {
      store,
      guiFixture,
      insertComputerRunner,
      allowAutomatic,
      approveApp,
      calendar,
      guiDigest,
      guiDefinition,
      computerUseDefinition,
      databaseUrl,
      notes,
    } = storeFixture;
    // Two asks from one Workspace, each on its own Mac: one Mac allows any app
    // automatically, the other already has the app and needs only this
    // Workspace's grant. Each writes the Workspace and the Computer use
    // server; taken in opposite orders, they deadlock.
    const first = await runningRunFixture(store, "lock-order", { kind: "specialized" });
    const second = await anotherRunIn(store, first, "lock-order-second");
    const automatic = await guiFixture("lock-order", first.userId);
    const covered = { runnerId: createId("runner") };
    await insertComputerRunner(covered.runnerId, first.userId, "Mac lock-order covered");
    await allowAutomatic(automatic);
    await approveApp({
      access: "read",
      actorUserId: first.userId,
      app: calendar,
      requestId: "covered-calendar",
      runnerId: covered.runnerId,
      tools: automatic.gui.tools("read"),
    });
    const ask = (
      run: { readonly runId: RunId; readonly threadId: ThreadId },
      runnerId: typeof covered.runnerId,
      app: ComputerAppIdentity,
      stores: IntegrationPlatformStore,
    ) =>
      stores.requestComputerAppAccess({
        access: "read",
        app,
        auditRequestId: `lock-order-${runnerId}`,
        definitionDigest: guiDigest,
        definitionId: guiDefinition.id as "macos-app",
        originatingRunId: run.runId,
        ownerUserId: first.userId,
        reason: `Use ${app.displayName}.`,
        runnerId,
        threadId: run.threadId,
        threadTitle: null,
        tools: (connectionId) => computerAppTools(computerUseDefinition, "read", connectionId),
        workspaceId: first.workspaceId,
      });

    // A separate pool, so the barrier, both asks and the probe each hold a
    // connection of their own.
    const wide = createDatabase({
      applicationName: "opensteer-computer-app-lock-order-test",
      connectionString: databaseUrl ?? "postgres://unconfigured",
      maxConnections: 8,
    });
    try {
      const stores = new IntegrationPlatformStore(wide);
      const waitingOnLocks = async (count: number) => {
        for (let attempt = 0; attempt < 400; attempt += 1) {
          const waiting = await sql<{ count: string }>`
            select count(*)::text as count from pg_stat_activity
            where application_name = 'opensteer-computer-app-lock-order-test'
              and wait_event_type = 'Lock'
          `.execute(wide);
          if (Number(waiting.rows[0]?.count) >= count) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`Expected ${count} transactions waiting on a lock`);
      };
      // The barrier: somebody else holds the Workspace, so each ask stops at
      // the first lock it needs that the other might be holding.
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const barrier = wide.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom("workspaces")
          .select("id")
          .where("id", "=", first.workspaceId)
          .forUpdate()
          .execute();
        await released;
      });
      // The covered ask queues for the Workspace first; the automatic one
      // then reaches it holding whatever its order took before it.
      const coveredAsk = ask(second, covered.runnerId, calendar, stores);
      await waitingOnLocks(1);
      const automaticAsk = ask(first, automatic.runnerId, notes, stores);
      await waitingOnLocks(2);
      release();
      await barrier;

      const [coveredDecision, automaticDecision] = await Promise.all([coveredAsk, automaticAsk]);
      expect(coveredDecision.kind).toBe("workspace-grant");
      expect(automaticDecision.kind).toBe("approved");
    } finally {
      await wide.destroy();
    }
  });

  describe("one waiting approval per app, answered only by a person", () => {
    async function setup(storeFixture: StoreFixture, suffix: string) {
      const {
        store,
        guiFixture,
        notes,
        guiDigest,
        guiDefinition,
        platform,
        guiInput,
        computerKeys,
        database,
      } = storeFixture;
      const run = await runningRunFixture(store, suffix, { kind: "specialized" });
      const mac = await guiFixture(suffix, run.userId);
      const ask = (access: "read" | "read-write", app: ComputerAppIdentity = notes) => ({
        access,
        app,
        definitionDigest: guiDigest,
        definitionId: guiDefinition.id as "macos-app",
        idempotencyKey: `${suffix}-${access}-${app.displayName}`,
        reason: `Use ${app.displayName}.`,
        threadTitle: "Shopping list",
        originatingRunId: run.runId,
        ownerUserId: run.userId,
        runnerId: mac.runnerId,
        threadId: run.threadId,
        workspaceId: run.workspaceId,
      });
      const consume = (
        request: Parameters<typeof createComputerAppApproval>[1],
        access: "read" | "read-write",
        app: ComputerAppIdentity = notes,
      ) =>
        platform.setComputerConnection({
          ...guiInput({
            access,
            actorUserId: run.userId,
            app,
            requestId: `${suffix}-consume-${request.id}`,
            runnerId: mac.runnerId,
            tools: mac.gui.tools(access),
          }),
          approval: createComputerAppApproval(computerKeys.get(mac.runnerId)!.privateKey, request),
        });
      const grants = () =>
        database
          .selectFrom("integrationGrants")
          .select(["access", "connectionId"])
          .where("workspaceId", "=", run.workspaceId)
          .where("revokedAt", "is", null)
          .execute();
      const status = (requestId: RequestId) =>
        database
          .selectFrom("requests")
          .select(["status", sql<string>`payload->>'setupRequestId'`.as("setupRequestId")])
          .where("id", "=", requestId)
          .executeTakeFirstOrThrow();
      return { ask, consume, grants, mac, run, status };
    }

    it("grants a Workspace the widest access its Requests asked for, whatever order they came in", async ({
      storeFixture,
    }) => {
      const { askOnMac } = storeFixture;
      const test = await setup(storeFixture, "widest-grant");
      const control = await askOnMac(test.ask("read-write"));
      const look = await askOnMac(test.ask("read"));
      // The narrower ask joins the wider approval rather than replacing it.
      expect(look.setupRequest.id).toBe(control.setupRequest.id);

      const consumed = await test.consume(control.setupRequest, "read-write");

      expect([...consumed.fulfilledRequestIds].sort()).toEqual(
        [control.request.id, look.request.id].sort(),
      );
      expect(await test.grants()).toEqual([
        { access: "read-write", connectionId: consumed.connection.id },
      ]);
    });

    it("never lowers a grant a Workspace already holds when a narrower approval is answered", async ({
      storeFixture,
    }) => {
      const { askOnMac, notes } = storeFixture;
      const test = await setup(storeFixture, "never-lower");
      const control = await askOnMac(test.ask("read-write"));
      const connected = await test.consume(control.setupRequest, "read-write");
      // The Mac now resolves the app differently, so a narrower ask is a new
      // approval rather than something the connection already covers.
      const renamed = { ...notes, displayName: "Notes (renamed)" };
      const look = await askOnMac(test.ask("read", renamed));

      const narrowed = await test.consume(look.setupRequest, "read", renamed);

      expect(narrowed.fulfilledRequestIds).toEqual([look.request.id]);
      expect(await test.grants()).toEqual([
        { access: "read-write", connectionId: connected.connection.id },
      ]);
    });

    it("approves automatically what the policy covers and leaves a wider approval waiting", async ({
      storeFixture,
    }) => {
      const { askOnMac, allowAutomatic, askForApp, platform } = storeFixture;
      const test = await setup(storeFixture, "automatic-keeps-wider");
      const control = await askOnMac(test.ask("read-write"));
      await allowAutomatic(test.mac);

      const approved = await askForApp({ ...test.ask("read"), tools: test.mac.gui.tools("read") });

      expect(approved.kind).toBe("approved");
      expect(await test.status(control.request.id)).toEqual({
        setupRequestId: control.setupRequest.id,
        status: "pending",
      });
      expect(await platform.listComputerAppSetupRequests(test.run.userId)).toEqual([
        expect.objectContaining({ access: "read-write", id: control.setupRequest.id }),
      ]);
      // The wider approval is still the person's to answer on the Mac.
      await test.consume(control.setupRequest, "read-write");
      expect(await test.status(control.request.id)).toMatchObject({ status: "fulfilled" });
      expect(await test.grants()).toEqual([expect.objectContaining({ access: "read-write" })]);
    });

    it("widens a Thread's approval for the picker and moves the Thread to it instead of declining it", async ({
      storeFixture,
    }) => {
      const { askOnMac, platform, notes, guiDigest, guiDefinition } = storeFixture;
      const test = await setup(storeFixture, "picker-relinks");
      const look = await askOnMac(test.ask("read"));

      const { request: widened, settlement } = await platform.requestComputerAppSetup({
        access: "read-write",
        actorUserId: test.run.userId,
        app: notes,
        definitionDigest: guiDigest,
        definitionId: guiDefinition.id,
        requiresApp: true,
        runnerId: test.mac.runnerId,
      });

      expect(settlement.requestIds).toEqual([]);
      expect(widened).toMatchObject({ access: "read-write", threadId: test.run.threadId });
      expect(widened.id).not.toBe(look.setupRequest.id);
      expect(await test.status(look.request.id)).toEqual({
        setupRequestId: widened.id,
        status: "pending",
      });
      await test.consume(widened, "read-write");
      expect(await test.status(look.request.id)).toMatchObject({ status: "fulfilled" });
    });

    it("gives a Thread that joins a picker's approval a prompt the Mac will show it", async ({
      storeFixture,
    }) => {
      const { platform, notes, guiDigest, guiDefinition, askOnMac } = storeFixture;
      const test = await setup(storeFixture, "thread-joins-picker");
      const { request: picked } = await platform.requestComputerAppSetup({
        access: "read-write",
        actorUserId: test.run.userId,
        app: notes,
        definitionDigest: guiDigest,
        definitionId: guiDefinition.id,
        requiresApp: true,
        runnerId: test.mac.runnerId,
      });
      expect(picked.threadId).toBeNull();

      const joined = await askOnMac(test.ask("read"));

      expect(joined.setupRequest).toMatchObject({
        access: "read-write",
        reason: "Use Notes.",
        threadId: test.run.threadId,
        threadTitle: "Shopping list",
        workspaceId: test.run.workspaceId,
      });
      // The picker's signature covered an approval that named no task.
      expect(joined.setupRequest.id).not.toBe(picked.id);
      expect(await platform.listComputerAppSetupRequests(test.run.userId)).toEqual([
        joined.setupRequest,
      ]);
    });

    it("keeps the approval for a Thread that joins while another Thread's decline is deciding", async ({
      storeFixture,
    }) => {
      const { askOnMac, database, waitForLockWaiters, platform } = storeFixture;
      const test = await setup(storeFixture, "decline-race");
      const declining = await askOnMac(test.ask("read-write"));
      // Holding the approval row makes the join wait inside its transaction,
      // after it has taken the Mac's row: exactly where a decline that does
      // not take that lock could slip in and remove the approval under it.
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held!: () => void;
      const holding = new Promise<void>((resolve) => {
        held = resolve;
      });
      const holder = database.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom("computerAppSetupRequests")
          .select("id")
          .where("id", "=", declining.setupRequest.id)
          .forUpdate()
          .execute();
        held();
        await released;
      });
      await holding;
      const joining = askOnMac(test.ask("read"));
      await waitForLockWaiters(1);
      const decline = platform.declineComputerAppAccessRequest({
        actorUserId: test.run.userId,
        requestId: declining.request.id,
      });
      await waitForLockWaiters(2);
      release();
      const [joined] = await Promise.all([joining, decline, holder]);

      expect(await test.status(declining.request.id)).toMatchObject({ status: "declined" });
      const waiting = await test.status(joined.request.id);
      expect(waiting.status).toBe("pending");
      expect(
        await database
          .selectFrom("computerAppSetupRequests")
          .select("id")
          .where("id", "=", waiting.setupRequestId)
          .executeTakeFirst(),
      ).toEqual({ id: waiting.setupRequestId });
    });

    it("decides a task's ask against the policy as it stands under the Mac's lock", async ({
      storeFixture,
    }) => {
      const { allowAutomatic, platform, askForApp, calendar } = storeFixture;
      const test = await setup(storeFixture, "policy-flip");
      await allowAutomatic(test.mac);
      await platform.setComputerUsePolicy({
        appApproval: "ask",
        ownerUserId: test.run.userId,
        requestId: "policy-flip-off",
        runnerId: test.mac.runnerId,
      });

      const asked = await askForApp({ ...test.ask("read"), tools: test.mac.gui.tools("read") });

      expect(asked.kind).toBe("computer");
      await allowAutomatic(test.mac);
      const approved = await askForApp({
        ...test.ask("read", calendar),
        tools: test.mac.gui.tools("read"),
      });
      expect(approved.kind).toBe("approved");
    });

    it("keeps a wider approval waiting under a new id when the owner lowers an app's access", async ({
      storeFixture,
    }) => {
      const { askOnMac, notes, platform, guiInput } = storeFixture;
      const test = await setup(storeFixture, "reduction-reissues");
      const control = await askOnMac(test.ask("read-write"));
      await test.consume(control.setupRequest, "read-write");
      // A wider approval can wait beside a connection that has the same
      // access, when the Mac now resolves the app differently.
      const renamed = { ...notes, displayName: "Notes (renamed)" };
      const again = await askOnMac(test.ask("read-write", renamed));

      const lowered = await platform.setComputerConnection(
        guiInput({
          access: "read",
          actorUserId: test.run.userId,
          app: notes,
          requestId: "reduction-reissues-lower",
          runnerId: test.mac.runnerId,
          tools: test.mac.gui.tools("read"),
        }),
      );

      expect(lowered.reissuedSetupRequestId).not.toBeNull();
      expect(await test.status(again.request.id)).toEqual({
        setupRequestId: lowered.reissuedSetupRequestId,
        status: "pending",
      });
      // A signature taken before the reduction cannot widen the app back.
      await expect(test.consume(again.setupRequest, "read-write", renamed)).rejects.toMatchObject({
        code: "forbidden",
      });
    });
  });

  /*
   * An Android phone's connection is its whole display: it names no app, so
   * every lookup, dedupe and relink keyed by an app has to say what it means
   * for a phone rather than fall through. What goes wrong otherwise:
   * - an app-less connection compared with `= null` is never found, so a task
   *   whose phone is already allowed gets another owner access Request;
   * - the one-card dedupe reads the app's bundle id and fails on a null app;
   * - an ask for a phone replays a Mac's card, or the other way round;
   * - widening a phone's waiting approval relinks its Threads through the
   *   policy check, which mistakes "no app" for the automatic policy;
   * - an automatic policy row, however it got there, approves a phone
   *   without its owner allowing access;
   * - lowering a phone's access leaves its live session holding the screen;
   * - the card sends the owner to a phone approval prompt that no longer exists.
   */
  describe("an Android phone, whose connection is its whole display", () => {
    const phoneDefinition = IntegrationDefinitionSchema.parse({
      adapter: "computer",
      authMethods: [{ id: "computer", kind: "computer", label: "This phone" }],
      config: {
        accessLabels: { read: "Can see", readWrite: "Can see and control" },
        accessSummaries: {
          read: "Agents can see this phone.",
          readWrite: "Agents can see and control this phone.",
        },
        kind: "display",
        operations: [
          {
            description: "Observe the phone",
            effect: "read",
            inputSchema: { type: "object" },
            name: "observe",
            outputSchema: null,
            title: "Observe",
          },
          {
            description: "Act on the phone",
            effect: "write",
            inputSchema: { type: "object" },
            name: "act",
            outputSchema: null,
            title: "Act",
          },
          {
            description: "Let go of the phone",
            effect: "read",
            inputSchema: { type: "object" },
            name: "release",
            outputSchema: null,
            title: "Release",
          },
        ],
        platforms: ["android"],
      },
      description: "The whole screen of an Android phone",
      id: "android-phone",
      name: "Android phone",
      provider: "android-phone",
    });
    if (!isComputerAppDefinition(phoneDefinition)) throw new Error("Phone fixture is invalid");
    const phoneComputerDefinition: ComputerAppDefinition = phoneDefinition;
    const phoneDigest = integrationDefinitionDigest(phoneDefinition);

    async function phoneFixture(
      storeFixture: StoreFixture,
      suffix: string,
      ownerUserId: ReturnType<typeof createId<"user">>,
    ) {
      const { guiFixture, insertComputerRunner, database, platform } = storeFixture;
      const base = await guiFixture(suffix, ownerUserId);
      const phoneId = createId("runner");
      await insertComputerRunner(phoneId, ownerUserId, `Pixel ${suffix}`);
      await database
        .updateTable("runners")
        .set({
          allowedModules: jsonValue(["integrations"]),
          device: jsonValue({ form: "phone", platform: "android" }),
          moduleDescriptors: jsonValue({
            integrations: { platform: "android", protocolVersion: 4 },
          }),
        })
        .where("id", "=", phoneId)
        .execute();
      await database
        .deleteFrom("computerUseApprovalKeys")
        .where("runnerId", "=", phoneId)
        .execute();
      const installationId = createIntegrationId("installation");
      const serverId = createIntegrationId("server");
      await platform.install({
        actorUserId: ownerUserId,
        adapterSnapshot: null,
        installation: {
          description: phoneDefinition.description,
          id: installationId,
          manifest: { definition: integrationDefinitionSummary(phoneDefinition) },
          name: phoneDefinition.id,
          provenance: { definitionId: phoneDefinition.id, maintainedBy: "opensteer" },
          sourceKind: "built-in",
          status: "active",
          title: phoneDefinition.name,
          trust: "built-in",
          version: "fixture",
        },
        requestId: `install-phone-${suffix}`,
        servers: [
          {
            connectionRequirement: { definitionId: phoneDefinition.id, kind: "computer" },
            id: serverId,
            name: "default",
            status: "active",
            statusDetail: null,
            catalog: { definitions: {}, tools: [] },
            transport: { definitionId: phoneDefinition.id, type: "computer" },
          },
        ],
      });
      const tools =
        (access: "read" | "read-write") => (connectionId: Parameters<typeof computerAppTools>[2]) =>
          computerAppTools(phoneComputerDefinition, access, connectionId);
      return {
        ...base,
        phone: { installationId, serverId, name: `Pixel ${suffix}`, phoneId, tools },
      };
    }

    function phoneAsk(
      run: Awaited<ReturnType<typeof runningRunFixture>>,
      phoneId: ReturnType<typeof createId<"runner">>,
      access: "read" | "read-write",
    ) {
      return {
        access,
        app: null,
        definitionDigest: phoneDigest,
        definitionId: "android-phone" as const,
        originatingRunId: run.runId,
        ownerUserId: run.userId,
        reason: "Reply to the delivery driver.",
        runnerId: phoneId,
        threadId: run.threadId,
        threadTitle: "Deliveries",
        workspaceId: run.workspaceId,
      };
    }

    async function allowPhoneFromClient(
      storeFixture: StoreFixture,
      setup: Awaited<ReturnType<typeof phoneFixture>>,
      access: "read" | "read-write",
      approved: Parameters<typeof createComputerAppApproval>[1],
    ) {
      const { platform } = storeFixture;
      return platform.setComputerConnection({
        access,
        actorUserId: setup.ownerUserId,
        app: null,
        createIfMissing: true,
        definitionDigest: phoneDigest,
        definitionId: phoneDefinition.id,
        requestId: `allow-phone-${approved.id}`,
        runnerId: setup.phone.phoneId,
        tools: setup.phone.tools(access),
      });
    }

    it("asks the owner once per Thread, finds the app-less connection, and names the phone on the card", async ({
      storeFixture,
    }) => {
      const { store, askOnMac, database, askForApp, platform } = storeFixture;
      const run = await runningRunFixture(store, "phone-ask", { kind: "specialized" });
      const setup = await phoneFixture(storeFixture, "phone-ask", run.userId);
      const opened = await askOnMac(phoneAsk(run, setup.phone.phoneId, "read-write"));
      expect(opened.setupRequest).toMatchObject({
        access: "read-write",
        app: null,
        definitionId: "android-phone",
        kind: "app",
      });
      expect(opened.request).toMatchObject({
        payload: {
          access: "read-write",
          app: null,
          definitionId: "android-phone",
          runnerId: setup.phone.phoneId,
          setupRequestId: opened.setupRequest.id,
        },
        presentation: {
          detail:
            "Reply to the delivery driver. Pixel phone-ask — can see and control. Allow or decline from any Opensteer app.",
          title: "Wants to see and control Pixel phone-ask",
        },
        status: "pending",
      });
      // The same ask, under another call identity, is still the same card.
      const again = await askOnMac({
        ...phoneAsk(run, setup.phone.phoneId, "read-write"),
        idempotencyKey: "another-tool-call",
      });
      expect(again).toMatchObject({ replayed: true, request: { id: opened.request.id } });

      expect(
        (await new IntegrationStore(database).listConnections(run.userId)).filter(
          ({ definitionId }) => definitionId === "android-phone",
        ),
      ).toEqual([]);
      const allowed = await allowPhoneFromClient(
        storeFixture,
        setup,
        "read-write",
        opened.setupRequest,
      );
      expect(allowed.fulfilledRequestIds).toEqual([opened.request.id]);
      expect(allowed.connection).toMatchObject({
        computer: { access: "read-write", app: null, runnerId: setup.phone.phoneId },
        displayName: "Pixel phone-ask",
      });
      expect(allowed.grants).toEqual([
        expect.objectContaining({ access: "read-write", workspaceId: run.workspaceId }),
      ]);

      // The phone is approved now, so another Thread's ask finds that
      // connection and asks only for a Workspace grant.
      const other = await anotherRunIn(store, run, "phone-ask-other");
      await expect(askForApp(phoneAsk(other, setup.phone.phoneId, "read"))).resolves.toMatchObject({
        kind: "workspace-grant",
      });
      await expect(platform.listComputerAppSetupRequests(run.userId)).resolves.toEqual([]);
    });

    it("keeps a phone's card apart from a Mac app's card in the same Thread", async ({
      storeFixture,
    }) => {
      const { store, askOnMac, notes, guiDigest, askForApp } = storeFixture;
      const run = await runningRunFixture(store, "phone-and-mac", { kind: "specialized" });
      const setup = await phoneFixture(storeFixture, "phone-and-mac", run.userId);
      const phone = await askOnMac(phoneAsk(run, setup.phone.phoneId, "read"));
      const mac = await askOnMac({
        ...phoneAsk(run, setup.runnerId, "read"),
        app: notes,
        definitionDigest: guiDigest,
        definitionId: "macos-app",
      });
      expect(mac.replayed).toBe(false);
      expect(mac.request.id).not.toBe(phone.request.id);
      expect(mac.request.presentation.title).toBe("Wants to use Notes on Mac phone-and-mac");
      await expect(
        askForApp({ ...phoneAsk(run, setup.phone.phoneId, "read"), app: notes }),
      ).rejects.toMatchObject({ code: "bad_request" });
      await expect(
        askForApp({
          ...phoneAsk(run, setup.runnerId, "read"),
          definitionDigest: guiDigest,
          definitionId: "macos-app",
        }),
      ).rejects.toMatchObject({ code: "bad_request" });
    });

    it("widens a phone's waiting approval and moves the Thread already waiting onto it", async ({
      storeFixture,
    }) => {
      const { store, askOnMac, platform } = storeFixture;
      const run = await runningRunFixture(store, "phone-widen", { kind: "specialized" });
      const setup = await phoneFixture(storeFixture, "phone-widen", run.userId);
      const narrow = await askOnMac(phoneAsk(run, setup.phone.phoneId, "read"));
      const other = await anotherRunIn(store, run, "phone-widen-other");
      const wide = await askOnMac(phoneAsk(other, setup.phone.phoneId, "read-write"));
      expect(wide.setupRequest.id).not.toBe(narrow.setupRequest.id);
      expect(wide.setupRequest).toMatchObject({ access: "read-write", app: null });
      await expect(platform.requests.get(narrow.request.id)).resolves.toMatchObject({
        payload: { app: null, setupRequestId: wide.setupRequest.id },
        status: "pending",
      });
      const allowed = await allowPhoneFromClient(
        storeFixture,
        setup,
        "read-write",
        wide.setupRequest,
      );
      expect([...allowed.fulfilledRequestIds].sort()).toEqual(
        [narrow.request.id, wide.request.id].sort(),
      );
    });

    it("never approves a phone automatically, whatever its policy row says", async ({
      storeFixture,
    }) => {
      const { store, askOnMac, platform, database, askForApp } = storeFixture;
      const run = await runningRunFixture(store, "phone-automatic", { kind: "specialized" });
      const setup = await phoneFixture(storeFixture, "phone-automatic", run.userId);
      // A setup request to stand in the forged envelope; nothing reads it.
      const phoneOpened = await askOnMac(phoneAsk(run, setup.phone.phoneId, "read"));
      await platform.cancelComputerAppSetup({
        ownerUserId: run.userId,
        requestId: phoneOpened.setupRequest.id,
      });
      const deployment = await store.getDeployment();
      await database
        .insertInto("computerUsePolicies")
        .values({
          appApproval: "automatic",
          // However the row got here, nothing about it may stand for a
          // person holding the phone; its contents are never consulted.
          approval: jsonValue({
            approval: {
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              requestId: randomUUID(),
              signature: "a".repeat(86),
            },
            request: phoneOpened.setupRequest,
          }),
          deploymentId: deployment!.id,
          ownerUserId: run.userId,
          revision: 1,
          runnerId: setup.phone.phoneId,
          updatedAt: new Date(),
        })
        .execute();
      await expect(
        askForApp(phoneAsk(run, setup.phone.phoneId, "read-write")),
      ).resolves.toMatchObject({ kind: "computer" });
      expect(
        (await new IntegrationStore(database).listConnections(run.userId)).filter(
          ({ definitionId }) => definitionId === "android-phone",
        ),
      ).toEqual([]);
    });

    it("ends the phone's session when its access is lowered, and nothing else's", async ({
      storeFixture,
    }) => {
      const { store, askOnMac, platform, setApprovedComputerConnection, definition } = storeFixture;
      const run = await runningRunFixture(store, "phone-lower", { kind: "specialized" });
      const setup = await phoneFixture(storeFixture, "phone-lower", run.userId);
      const opened = await askOnMac(phoneAsk(run, setup.phone.phoneId, "read-write"));
      await allowPhoneFromClient(storeFixture, setup, "read-write", opened.setupRequest);
      const kept = await platform.setComputerConnection({
        access: "read-write",
        actorUserId: run.userId,
        app: null,
        createIfMissing: false,
        definitionDigest: phoneDigest,
        definitionId: phoneDefinition.id,
        requestId: "phone-keep",
        runnerId: setup.phone.phoneId,
        tools: setup.phone.tools("read-write"),
      });
      expect(kept.sessionReset).toBeNull();
      const lowered = await platform.setComputerConnection({
        access: "read",
        actorUserId: run.userId,
        app: null,
        createIfMissing: false,
        definitionDigest: phoneDigest,
        definitionId: phoneDefinition.id,
        requestId: "phone-lower",
        runnerId: setup.phone.phoneId,
        tools: setup.phone.tools("read"),
      });
      expect(lowered.sessionReset).toEqual({
        definitionId: "android-phone",
        kind: "display",
        runnerId: setup.phone.phoneId,
      });

      // Messages has no session to end however its access moves.
      const messages = await setApprovedComputerConnection({
        access: "read-write",
        actorUserId: run.userId,
        createIfMissing: true,
        definitionId: definition.id,
        requestId: "messages-on",
        runnerId: setup.runnerId,
        tools: setup.tools("read-write"),
      });
      expect(messages.sessionReset).toBeNull();
      const messagesLowered = await setApprovedComputerConnection({
        access: "read",
        actorUserId: run.userId,
        createIfMissing: false,
        definitionId: definition.id,
        requestId: "messages-lower",
        runnerId: setup.runnerId,
        tools: setup.tools("read"),
      });
      expect(messagesLowered.sessionReset).toBeNull();
    });

    it("refuses signed phone mutations, key nomination and non-owner changes", async ({
      storeFixture,
    }) => {
      const { store, askOnMac, platform, computerKeys } = storeFixture;
      const run = await runningRunFixture(store, "phone-key", { kind: "specialized" });
      const setup = await phoneFixture(storeFixture, "phone-key", run.userId);
      const opened = await askOnMac(phoneAsk(run, setup.phone.phoneId, "read"));
      const mutation = {
        access: "read" as const,
        actorUserId: run.userId,
        app: null,
        createIfMissing: true,
        definitionDigest: phoneDigest,
        definitionId: "android-phone",
        requestId: "phone-owner",
        runnerId: setup.phone.phoneId,
        tools: setup.phone.tools("read"),
      };
      await expect(
        platform.setComputerConnection({
          ...mutation,
          approval: createComputerAppApproval(
            computerKeys.get(setup.phone.phoneId)!.privateKey,
            opened.setupRequest,
          ),
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      const stranger = await store.createUser("Stranger");
      await expect(
        platform.setComputerConnection({ ...mutation, actorUserId: stranger }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        platform.registerComputerUseApprovalKey({
          ownerUserId: run.userId,
          publicKey: computerKeys
            .get(setup.phone.phoneId)!
            .publicKey.export({ format: "pem", type: "spki" })
            .toString(),
          requestId: "phone-key-refused",
          runnerId: setup.phone.phoneId,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(platform.requests.get(opened.request.id)).resolves.toMatchObject({
        status: "pending",
      });
    });

    it("settles covered phone Requests once, preserves wider asks and grants the right Workspaces", async ({
      storeFixture,
    }) => {
      const { store, askOnMac, platform, database } = storeFixture;
      const run = await runningRunFixture(store, "phone-settle", { kind: "specialized" });
      const setup = await phoneFixture(storeFixture, "phone-settle", run.userId);
      const narrow = await askOnMac(phoneAsk(run, setup.phone.phoneId, "read"));
      const workspace = await createWorkspace(
        store,
        run.userId,
        "phone-settle-other",
        "specialized",
      );
      const other = await startRunIn(
        store,
        { ...run, workspaceId: workspace.id },
        "phone-settle-other",
      );
      const otherNarrow = await askOnMac(phoneAsk(other, setup.phone.phoneId, "read"));
      const wideRun = await anotherRunIn(store, other, "phone-settle-wide");
      const wide = await askOnMac(phoneAsk(wideRun, setup.phone.phoneId, "read-write"));
      const allowed = await allowPhoneFromClient(storeFixture, setup, "read", wide.setupRequest);
      expect(allowed.created).toBe(true);
      const coveredIds = [narrow.request.id, otherNarrow.request.id].sort();
      expect([...allowed.fulfilledRequestIds].sort()).toEqual(coveredIds);
      expect(
        allowed.grants
          .map(({ access, workspaceId }) => ({ access, workspaceId }))
          .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
      ).toEqual(
        [run.workspaceId, other.workspaceId]
          .sort()
          .map((workspaceId) => ({ access: "read", workspaceId })),
      );
      await expect(platform.requests.get(wide.request.id)).resolves.toMatchObject({
        status: "pending",
      });
      const again = await allowPhoneFromClient(storeFixture, setup, "read", wide.setupRequest);
      expect(again.fulfilledRequestIds).toEqual([]);
      expect(again.grants).toEqual([]);
      const widened = await allowPhoneFromClient(
        storeFixture,
        setup,
        "read-write",
        wide.setupRequest,
      );
      expect(widened.created).toBe(false);
      expect(widened.fulfilledRequestIds).toEqual([wide.request.id]);
      expect(widened.grants).toEqual([
        expect.objectContaining({ access: "read-write", workspaceId: other.workspaceId }),
      ]);
      const ids = [...coveredIds, wide.request.id].sort();
      const continuations = await database
        .selectFrom("requestContinuations")
        .select("requestId")
        .where("requestId", "in", ids)
        .execute();
      expect(continuations.map(({ requestId }) => requestId).sort()).toEqual(ids);
      const grants = await database
        .selectFrom("integrationGrants")
        .select(["access", "workspaceId"])
        .where("connectionId", "=", allowed.connection.id)
        .orderBy("workspaceId")
        .execute();
      expect(grants).toEqual(
        [
          { access: "read", workspaceId: run.workspaceId },
          { access: "read-write", workspaceId: other.workspaceId },
        ].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
      );
    });

    it("keeps Main phone Requests and declines answerable from any client", async ({
      storeFixture,
    }) => {
      const { store, platform, askOnMac, database } = storeFixture;
      const run = await runningRunFixture(store, "phone-main");
      const setup = await phoneFixture(storeFixture, "phone-main", run.userId);
      const mainAsk = (access: "read" | "read-write") =>
        platform.requests.createIntegrationAccessRequest({
          access,
          callId: `phone-main-${access}`,
          installationId: setup.phone.installationId,
          originatingRunId: run.runId,
          originatingThreadId: run.threadId,
          originatingWorkspaceId: run.workspaceId,
          targetWorkspaceId: run.workspaceId,
          requestedBy: run.userId,
          requestedConnectionId: null,
          requestedServerId: setup.phone.serverId,
          reason: "Use this phone from Main.",
        });
      const mainRead = await mainAsk("read");
      const opened = await askOnMac(phoneAsk(run, setup.phone.phoneId, "read"));
      const allowed = await allowPhoneFromClient(storeFixture, setup, "read", opened.setupRequest);
      expect(allowed.fulfilledRequestIds).toEqual([opened.request.id]);
      expect(allowed.grants).toEqual([]);
      await expect(platform.requests.get(mainRead.request.id)).resolves.toMatchObject({
        status: "fulfilled",
      });
      const mainWide = await mainAsk("read-write");
      const wide = await askOnMac(phoneAsk(run, setup.phone.phoneId, "read-write"));
      const declined = await platform.declineComputerAppAccessRequest({
        actorUserId: run.userId,
        requestId: wide.request.id,
      });
      expect(declined.request.status).toBe("declined");
      expect(
        (await new IntegrationStore(database).listConnections(run.userId)).find(
          ({ definitionId }) => definitionId === "android-phone",
        )?.computer?.access,
      ).toBe("read");
      await expect(platform.requests.get(mainWide.request.id)).resolves.toMatchObject({
        status: "pending",
      });
      await allowPhoneFromClient(storeFixture, setup, "read-write", wide.setupRequest);
      await expect(platform.requests.get(mainWide.request.id)).resolves.toMatchObject({
        status: "fulfilled",
      });
    });

    it("migrates pre-upgrade phone Requests without changing their authority or settlement links", async ({
      storeFixture,
    }) => {
      const { store, askOnMac, database, platform } = storeFixture;
      const run = await runningRunFixture(store, "phone-upgrade", { kind: "specialized" });
      const setup = await phoneFixture(storeFixture, "phone-upgrade", run.userId);
      const pending = await askOnMac(phoneAsk(run, setup.phone.phoneId, "read"));
      const other = await anotherRunIn(store, run, "phone-upgrade-decline");
      const decline = await askOnMac(phoneAsk(other, setup.phone.phoneId, "read-write"));
      const before = await database
        .selectFrom("requests")
        .selectAll()
        .where("id", "in", [pending.request.id, decline.request.id])
        .orderBy("id")
        .execute();
      for (const row of before) {
        await database
          .updateTable("requests")
          .set({
            presentation: jsonValue({ ...row.presentation, detail: "Old on-phone approval copy." }),
          })
          .where("id", "=", row.id)
          .execute();
      }
      await agentPhoneOwnerAccessMigration.up(database);
      const after = await database
        .selectFrom("requests")
        .selectAll()
        .where("id", "in", [pending.request.id, decline.request.id])
        .orderBy("id")
        .execute();
      expect(after.map(({ presentation: _, ...row }) => row)).toEqual(
        before.map(({ presentation: _, ...row }) => row),
      );
      for (const row of after)
        expect(row.presentation.detail).toContain("Allow or decline from any Opensteer app.");
      await platform.declineComputerAppAccessRequest({
        actorUserId: run.userId,
        requestId: decline.request.id,
      });
      const allowed = await allowPhoneFromClient(storeFixture, setup, "read", pending.setupRequest);
      expect(allowed.fulfilledRequestIds).toEqual([pending.request.id]);
      expect(allowed.grants).toEqual([
        expect.objectContaining({ access: "read", workspaceId: run.workspaceId }),
      ]);
      await expect(platform.requests.get(decline.request.id)).resolves.toMatchObject({
        status: "declined",
      });
    });
  });

  /** Waits until this many sessions are blocked on a row lock. */
});

function catalogInstallation(
  installationId: ReturnType<typeof createIntegrationId<"installation">>,
) {
  return {
    description: "Records for the team",
    id: installationId,
    manifest: {
      definition: {
        adapter: "openapi" as const,
        authMethods: [
          {
            id: "api-key",
            inputs: [{ label: "API key", secret: true, variable: "apiKey" }],
            kind: "api-key" as const,
            label: "Records API key",
            placements: [
              {
                carrier: "header" as const,
                name: "Authorization",
                prefix: "Bearer ",
                variable: "apiKey",
              },
            ],
          },
        ],
        description: "Records for the team",
        id: "records-catalog",
        name: "Records",
        provider: "records",
      },
    },
    name: "records-catalog",
    provenance: {
      definitionDigest: "c".repeat(43),
      definitionId: "records-catalog",
      maintainedBy: "opensteer",
    },
    sourceKind: "built-in" as const,
    status: "active" as const,
    title: "Records",
    trust: "built-in" as const,
    version: "c".repeat(43),
  };
}

function discoveredTool(toolId: ReturnType<typeof createIntegrationId<"tool">>) {
  const inputSchema = { properties: { query: { type: "string" } }, type: "object" } as const;
  return {
    annotations: {},
    connectionId: null,
    description: "Read records",
    id: toolId,
    inputSchema,
    name: "records.read",
    outputSchema: null,
    status: "active" as const,
    title: "Read records",
  };
}

async function countRows(
  database: ReturnType<typeof createDatabase>,
  table:
    | "credentials"
    | "integrationConnections"
    | "integrationGrants"
    | "integrationServers"
    | "integrationSkills"
    | "integrationTools"
    | "mcpOAuthCredentials",
): Promise<number> {
  const row = await database
    .selectFrom(table)
    .select((expression) => expression.fn.countAll<string>().as("total"))
    .executeTakeFirstOrThrow();
  return Number(row.total);
}

async function insertCredential(
  database: ReturnType<typeof createDatabase>,
  credentialId: ReturnType<typeof createId<"credential">>,
  ownerUserId: ReturnType<typeof createId<"user">>,
): Promise<void> {
  await database
    .insertInto("credentials")
    .values({
      encryptedPayload: Buffer.from("sealed-api-key"),
      encryptionKeyVersion: 1,
      id: credentialId,
      metadata: sql`'{}'::jsonb`,
      name: "Records key",
      ownerId: ownerUserId,
      provider: "records",
      updatedAt: new Date(),
    })
    .executeTakeFirstOrThrow();
}

async function insertProviderConnection(
  database: ReturnType<typeof createDatabase>,
  input: {
    readonly connectionId: ReturnType<typeof createIntegrationId<"connection">>;
    readonly credentialId: ReturnType<typeof createId<"credential">>;
    readonly definitionId: string;
    readonly ownerUserId: ReturnType<typeof createId<"user">>;
  },
): Promise<void> {
  await database
    .insertInto("integrationConnections")
    .values({
      accountIdentifier: "alex@example.com",
      applicationSource: sql`'{"kind":"api-key"}'::jsonb`,
      authMethodId: "api-key",
      authorizationDigest: "a".repeat(43),
      capabilities: sql`'[]'::jsonb`,
      runnerId: null,
      connectionKind: "provider-account",
      connectionMethod: "api-key",
      credentialId: input.credentialId,
      displayName: "Alex",
      externalIdentityId: `${input.definitionId}-key`,
      externalTenantId: null,
      grantedScopes: sql`'[]'::jsonb`,
      id: input.connectionId,
      integrationDefinitionId: input.definitionId,
      integrationServerId: null,
      ownerUserId: input.ownerUserId,
      provider: input.definitionId,
      providerApplicationId: null,
      status: "connected",
      statusDetail: null,
      transportKind: null,
      updatedAt: new Date(),
    })
    .executeTakeFirstOrThrow();
}

async function createWorkspace(
  store: OpensteerStore,
  createdBy: ReturnType<typeof createId<"user">>,
  suffix: string,
  kind?: "main" | "specialized",
) {
  return store.createWorkspace({
    backing: {
      generation: 1,
      kind: "portablefs",
      serviceId: "test-portablefs",
      volumeId: `wsp_${suffix.replaceAll("-", "_")}`,
    },
    capacityPolicy: {
      blockHardLimitBytes: 10_000_000,
      inodeHardLimit: 10_000,
      kind: "hard-quota",
    },
    createdBy,
    idempotencyKey: `workspace-${suffix}`,
    ...(kind === undefined ? {} : { kind }),
    name: `Workspace ${suffix}`,
    status: "ready",
  });
}

/** A Request may only be opened from a Run the Host has seen start. */
async function runningRunFixture(
  store: OpensteerStore,
  suffix: string,
  options: { readonly kind?: "main" | "specialized" } = {},
) {
  const userId = await store.createUser(`Owner ${suffix}`);
  const runnerId = createId("runner");
  const environmentId = createId("environment");
  if (!(await store.getDeployment())) {
    await store.ensureDeployment({
      canonicalOrigin: "https://test-host.invalid",
      deploymentShape: {
        defaultWorkspaceBacking: "portablefs",
        kind: "server" as const,
      },
      hostInstanceId: createId("hostInstance"),
    });
  }
  const pair = generateKeyPairSync("ed25519");
  const publicKeyDer = pair.publicKey.export({ format: "der", type: "spki" });
  const enrollmentTokenHash = `sha256:${createHash("sha256")
    .update(`test-enrollment-${suffix}`, "utf8")
    .digest("base64url")}`;
  await store.createRunnerEnrollment({
    allowedModules: ["agents"],
    createdBy: userId,
    expiresAt: new Date(Date.now() + 60_000),
    id: `ren_${randomUUID()}`,
    idempotencyKey: `test-runner-${suffix}`,
    mainEnrollmentPurpose: "initial",
    name: `Test runner ${suffix}`,
    requestFingerprint: `sha256:test-runner-${suffix}`,
    runnerKind: "main",
    tokenHash: enrollmentTokenHash,
  });
  const descriptor: RunnerDescriptor = {
    bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
    capabilities: ["filesystem"],
    modules: {
      agents: {
        environmentIds: [environmentId],
        harnessDrivers: [
          {
            accessModes: ThreadAccessModeSchema.options,
            driverKind: HarnessIdSchema.parse("native"),
            readiness: "configured",
            sources: [
              {
                fields: [],
                kind: "first-party",
                label: "Native",
                quota: "none",
                sourceId: "native",
                stateKinds: ["isolated"],
              },
            ],
          },
        ],
        localStorage: null,
        maxConcurrentRuns: 4,
        providerStateModes: ["isolated"],
        workspaceBackings: ["portablefs"],
        workspaceMounts: [],
      },
    },
    name: `Runner ${suffix}`,
    runnerId,
    runnerKind: "main",
    runtimeVersion: "test",
  };
  await store.enrollRunnerConnection({
    descriptor,
    enrollmentTokenHash,
    publicKeyFingerprint: `sha256:${createHash("sha256").update(publicKeyDer).digest("base64url")}`,
    publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
  });
  const workspace = await createWorkspace(store, userId, suffix, options.kind);
  const harnessInstance = await store.createHarnessInstance({
    config: { model: "test" },
    driverKind: HarnessIdSchema.parse("native"),
    environmentId,
    name: "Native",
    sourceId: "native",
    stateKind: "isolated",
  });
  return startRunIn(
    store,
    {
      environmentId,
      harnessInstanceId: harnessInstance.id,
      runnerId,
      userId,
      workspaceId: workspace.id,
    },
    suffix,
  );
}

/** Another running Run in the same Workspace, on the same Runner, in a Thread of its own. */
async function anotherRunIn(
  store: OpensteerStore,
  fixture: Awaited<ReturnType<typeof runningRunFixture>>,
  suffix: string,
) {
  return startRunIn(store, fixture, suffix);
}

async function startRunIn(
  store: OpensteerStore,
  context: {
    readonly environmentId: ReturnType<typeof createId<"environment">>;
    readonly harnessInstanceId: Awaited<ReturnType<OpensteerStore["createHarnessInstance"]>>["id"];
    readonly runnerId: ReturnType<typeof createId<"runner">>;
    readonly userId: ReturnType<typeof createId<"user">>;
    readonly workspaceId: Awaited<ReturnType<OpensteerStore["createWorkspace"]>>["id"];
  },
  suffix: string,
) {
  const { environmentId, harnessInstanceId, runnerId, userId, workspaceId } = context;
  const { thread } = await store.createThread({
    createdBy: userId,
    environmentId,
    harnessInstanceId,
    idempotencyKey: `thread-${suffix}`,
    modelSelection: ModelSelectionSchema.parse({
      modelId: "gpt-5.6-sol",
      options: { effort: "low" },
      providerId: "openai",
    }),
    title: `Thread ${suffix}`,
    workspaceId,
  });
  const admitted = await store.enqueueThreadInput({
    content: [{ text: "Start the work", type: "text" }],
    idempotencyKey: `${suffix}-initial-turn`,
    policy: "queue",
    requestedBy: userId,
    source: { kind: "human" },
    threadId: thread.id,
  });
  if (!admitted.command || !admitted.run) throw new Error("Expected the input to queue a Run");
  await store.claimCommand(admitted.command.id, `${suffix}-dispatcher`);
  // One boot per Runner, whichever Run is bound to it.
  const runnerBootId = `boot-${runnerId}`;
  const binding = await store.acquireExecutionBinding({
    bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
    continuationIdentity: {
      continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
      driverKind: HarnessIdSchema.parse("native"),
    },
    harnessInstanceId,
    leaseTokenHash: `${suffix}-lease`,
    membershipGeneration: 1,
    runnerBootId,
    runnerId,
    runId: admitted.run.id,
    threadId: thread.id,
  });
  const started: PendingAgentEvent = {
    bindingGeneration: binding.bindingGeneration,
    data: { status: "running" },
    emittedAt: new Date().toISOString(),
    environmentId,
    ordinal: 0,
    runId: admitted.run.id,
    threadId: thread.id,
    type: "run.started",
    workspaceId,
  };
  await store.commitRunnerEvent({ environmentId, event: started, runnerBootId, runnerId });
  return {
    environmentId,
    harnessInstanceId,
    runId: admitted.run.id,
    runnerId,
    threadId: thread.id,
    userId,
    workspaceId,
  };
}
