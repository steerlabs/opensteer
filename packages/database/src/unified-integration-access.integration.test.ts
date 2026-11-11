import {
  personalFixtureOwner,
  createPersonalRunFixturePort,
} from "./personal-run-fixture.test-support.js";

import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
  recordTestDatabaseSetup,
} from "./test-database.test-support.js";
import { createHash } from "node:crypto";
import {
  IntegrationDefinitionSchema,
  createIntegrationId,
  integrationDefinitionSummary,
  integrationProposalSummary,
} from "@opensteer/integration-core";
import { integrationDefinitionDigest } from "@opensteer/integration-core/digest";
import { createId } from "@opensteer/core";

import { sql } from "kysely";
import { describe, expect, it as baseIt } from "vitest";
import { createDatabase, IntegrationPlatformStore, OpensteerStore } from "./index.js";
const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
integration.sequential("unified integration access Requests", () => {
  async function createTestFixture() {
    const clone = await cloneTestDatabase("host");
    const databaseUrl = clone.url;
    const { database } = await ownTestDatabaseProducer(databaseUrl, async () => {
      const database = createDatabase({
        applicationName: "opensteer-unified-integration-access-test",
        connectionString: databaseUrl,
        maxConnections: 3,
      });
      return {
        database,
        close: () => database.destroy(),
      };
    });
    const platform = new IntegrationPlatformStore(database);
    const store = new OpensteerStore(database);
    return Object.freeze({
      database,
      platform,
      store,
      databaseUrl,
    });
  }
  type StoreFixture = Awaited<ReturnType<typeof createTestFixture>>;
  const it = baseIt.extend<{
    storeFixture: StoreFixture;
  }>({
    storeFixture: async ({ task }, use) => {
      const started = performance.now();
      const fixture = await createTestFixture();
      recordTestDatabaseSetup(task, started);
      await use(fixture);
    },
  });
  it("binds an exact installation while the access Request stays pending, then continues only after fulfillment", async ({
    storeFixture,
  }) => {
    const {
      store,

      platform,
    } = storeFixture;
    const fixture = await runningRunFixture(store, "preinstall-bind", storeFixture.databaseUrl);

    const contract = integrationContract("preinstall-calendar");
    const prepared = preparedFulfillment(contract);
    const opened = await platform.requests.createIntegrationAccessRequest({
      ...requestOrigin(fixture),
      access: "read-write",
      callId: "preinstall-calendar-access",
      installationId: null,
      manifest: prepared.approvalManifest,
      reason: "Read and update the calendar",
      requestedConnectionId: null,
      requestedServerId: null,
    });
    expect(opened.request).toMatchObject({
      payload: {
        installationId: null,
        manifest: expect.any(Object),
      },
      status: "pending",
    });
    await expect(
      platform.requests.loadIntegrationAccessInstallManifest({
        requestId: opened.request.id,
        resolvedBy: fixture.userId,
      }),
    ).resolves.toEqual(prepared.approvalManifest);
    const installed = await platform.requests.installForIntegrationAccessRequest({
      preparedFulfillment: prepared,
      requestId: opened.request.id,
      resolvedBy: fixture.userId,
    });
    expect(installed).toMatchObject({
      installation: {
        id: prepared.material.installation.id,
      },
      request: {
        payload: {
          installationId: prepared.material.installation.id,
          manifest: null,
          requestedServerId: prepared.material.servers[0]!.id,
        },
        status: "pending",
      },
      requestEvents: expect.arrayContaining([
        expect.objectContaining({
          type: "request.updated",
        }),
      ]),
    });
    await expect(platform.requests.listPendingContinuations()).resolves.toEqual([]);
    const resolved = await platform.requests.resolveIntegrationAccessRequest({
      providerAuthorizations: {},
      requestId: opened.request.id,
      resolvedBy: fixture.userId,
      response: {
        kind: "external",
        value: {
          connectionId: null,
          decision: "fulfilled",
        },
      },
    });
    expect(resolved.request.status).toBe("fulfilled");
    await fixture.complete();
    await expect(platform.requests.listPendingContinuations()).resolves.toEqual([
      expect.objectContaining({
        request: expect.objectContaining({
          id: opened.request.id,
        }),
      }),
    ]);
  });
  it("refuses prepared material whose digest differs from the reviewed manifest", async ({
    storeFixture,
  }) => {
    const { store, platform } = storeFixture;
    const fixture = await runningRunFixture(store, "digest-conflict", storeFixture.databaseUrl);
    const reviewed = preparedFulfillment(integrationContract("reviewed-calendar"));
    const changed = preparedFulfillment(integrationContract("changed-calendar"));
    const opened = await platform.requests.createIntegrationAccessRequest({
      ...requestOrigin(fixture),
      access: "read",
      callId: "digest-conflict-access",
      installationId: null,
      manifest: reviewed.approvalManifest,
      reason: "Read the reviewed calendar",
      requestedServerId: null,
    });
    await expect(
      platform.requests.installForIntegrationAccessRequest({
        preparedFulfillment: changed,
        requestId: opened.request.id,
        resolvedBy: fixture.userId,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(platform.requests.get(opened.request.id)).resolves.toMatchObject({
      payload: {
        installationId: null,
      },
      status: "pending",
    });
  });
  it("declines a preinstall access Request without installing its manifest", async ({
    storeFixture,
  }) => {
    const { store, platform, database } = storeFixture;
    const fixture = await runningRunFixture(store, "preinstall-decline", storeFixture.databaseUrl);
    const prepared = preparedFulfillment(integrationContract("declined-calendar"));
    const opened = await platform.requests.createIntegrationAccessRequest({
      ...requestOrigin(fixture),
      access: "read",
      callId: "preinstall-decline-access",
      installationId: null,
      manifest: prepared.approvalManifest,
      reason: "Read the calendar",
      requestedServerId: null,
    });
    await expect(
      platform.requests.resolveIntegrationAccessRequest({
        providerAuthorizations: {},
        requestId: opened.request.id,
        resolvedBy: fixture.userId,
        response: {
          kind: "external",
          value: {
            decision: "declined",
          },
        },
      }),
    ).resolves.toMatchObject({
      request: {
        status: "declined",
      },
    });
    const count = await database
      .selectFrom("integrationInstallations")
      .select(sql<number>`count(*)::integer`.as("count"))
      .executeTakeFirstOrThrow();
    expect(count.count).toBe(0);
  });
  it("allows a requester to bind the exact installation already installed by the personal owner", async ({
    storeFixture,
  }) => {
    const {
      store,

      platform,
    } = storeFixture;
    const fixture = await runningRunFixture(store, "existing-exact", storeFixture.databaseUrl);

    const administratorId = fixture.userId;

    const prepared = proposedFulfillment("shared-calendar");
    const opened = await platform.requests.createIntegrationAccessRequest({
      ...requestOrigin(fixture),
      access: "read",
      callId: "existing-exact-access",
      installationId: null,
      manifest: prepared.approvalManifest,
      reason: "Read the shared calendar",
      requestedServerId: null,
    });
    await platform.install({
      ...prepared.material,
      actorUserId: administratorId,
      requestId: "administrator-installed-shared-calendar",
    });
    await expect(
      platform.requests.loadIntegrationAccessInstallManifest({
        requestId: opened.request.id,
        resolvedBy: fixture.userId,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      platform.requests.tryBindExistingIntegrationAccessInstallation({
        requestId: opened.request.id,
        resolvedBy: fixture.userId,
      }),
    ).resolves.toMatchObject({
      installation: {
        id: prepared.material.installation.id,
      },
      request: {
        status: "pending",
      },
    });
  });
  it("rejects fulfillment through a different account than the one requested", async ({
    storeFixture,
  }) => {
    const { store, platform, database } = storeFixture;
    const fixture = await runningRunFixture(store, "exact-account", storeFixture.databaseUrl);
    const prepared = preparedFulfillment(integrationContract("account-calendar"));
    const material = {
      ...prepared.material,
      servers: [
        {
          ...prepared.material.servers[0]!,
          connectionRequirement: {
            definitionId: "account-calendar",
            kind: "provider" as const,
            provider: "account-calendar",
            providerApplicationRequired: false,
          },
        },
      ],
    };
    await platform.install({
      ...material,
      actorUserId: fixture.userId,
      requestId: "install-account-calendar",
    });
    const requestedConnectionId = await insertConnection(
      database,
      fixture.userId,
      material.servers[0]!.id,
      "account-calendar",
      "Requested account",
    );
    const otherConnectionId = await insertConnection(
      database,
      fixture.userId,
      material.servers[0]!.id,
      "account-calendar",
      "Other account",
    );
    const opened = await platform.requests.createIntegrationAccessRequest({
      ...requestOrigin(fixture),
      access: "read-write",
      callId: "exact-account-access",
      installationId: material.installation.id,
      reason: "Update this account's calendar",
      requestedConnectionId,
      requestedServerId: material.servers[0]!.id,
    });
    await expect(
      platform.requests.resolveIntegrationAccessRequest({
        providerAuthorizations: {},
        requestId: opened.request.id,
        resolvedBy: fixture.userId,
        response: {
          kind: "external",
          value: {
            connectionId: otherConnectionId,
            decision: "fulfilled",
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Integration access requires the requested account",
    });
  });
  it("allows decline after a pinned account and server become unavailable", async ({
    storeFixture,
  }) => {
    const { store, platform, database } = storeFixture;
    const fixture = await runningRunFixture(store, "unavailable-decline", storeFixture.databaseUrl);
    const prepared = preparedFulfillment(integrationContract("unavailable-calendar"));
    const server = {
      ...prepared.material.servers[0]!,
      connectionRequirement: {
        definitionId: "unavailable-calendar",
        kind: "provider" as const,
        provider: "unavailable-calendar",
        providerApplicationRequired: false,
      },
    };
    await platform.install({
      ...prepared.material,
      actorUserId: fixture.userId,
      requestId: "install-unavailable-calendar",
      servers: [server],
    });
    const connectionId = await insertConnection(
      database,
      fixture.userId,
      server.id,
      "unavailable-calendar",
      "Unavailable account",
    );
    const opened = await platform.requests.createIntegrationAccessRequest({
      ...requestOrigin(fixture),
      access: "read",
      callId: "unavailable-decline-access",
      installationId: prepared.material.installation.id,
      reason: "Read the unavailable calendar",
      requestedConnectionId: connectionId,
      requestedServerId: server.id,
    });
    await database
      .updateTable("integrationConnections")
      .set({
        status: "revoked",
        updatedAt: new Date(),
      })
      .where("id", "=", connectionId)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("integrationServers")
      .set({
        status: "disabled",
        updatedAt: new Date(),
      })
      .where("id", "=", server.id)
      .executeTakeFirstOrThrow();
    await expect(
      platform.requests.resolveIntegrationAccessRequest({
        providerAuthorizations: {},
        requestId: opened.request.id,
        resolvedBy: fixture.userId,
        response: {
          kind: "external",
          value: {
            decision: "declined",
          },
        },
      }),
    ).resolves.toMatchObject({
      request: {
        status: "declined",
      },
    });
  });
  it("settles one concurrent fulfillment and rejects the other", async ({ storeFixture }) => {
    const { store, platform } = storeFixture;
    const fixture = await runningRunFixture(
      store,
      "concurrent-fulfillment",
      storeFixture.databaseUrl,
    );
    const prepared = preparedFulfillment(integrationContract("concurrent-calendar"));
    await platform.install({
      ...prepared.material,
      actorUserId: fixture.userId,
      requestId: "install-concurrent-calendar",
    });
    const opened = await platform.requests.createIntegrationAccessRequest({
      ...requestOrigin(fixture),
      access: "read",
      callId: "concurrent-calendar-access",
      installationId: prepared.material.installation.id,
      reason: "Read the calendar once",
      requestedServerId: prepared.material.servers[0]!.id,
    });
    const resolve = () =>
      platform.requests.resolveIntegrationAccessRequest({
        providerAuthorizations: {},
        requestId: opened.request.id,
        resolvedBy: fixture.userId,
        response: {
          kind: "external" as const,
          value: {
            connectionId: null,
            decision: "fulfilled",
          },
        },
      });
    const results = await Promise.allSettled([resolve(), resolve()]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    await expect(platform.requests.get(opened.request.id)).resolves.toMatchObject({
      status: "fulfilled",
    });
  });
  it("does not let broad read-write fulfillment cover read Requests for another server or account", async ({
    storeFixture,
  }) => {
    const { store, platform, database } = storeFixture;
    const fixture = await runningRunFixture(store, "selector-coverage", storeFixture.databaseUrl);
    const prepared = preparedFulfillment(integrationContract("selector-calendar"));
    const otherServer = {
      ...prepared.material.servers[0]!,
      connectionRequirement: {
        definitionId: "selector-calendar",
        kind: "provider" as const,
        provider: "selector-calendar",
        providerApplicationRequired: false,
      },
      id: createIntegrationId("server"),
      name: "secondary",
    };
    const material = {
      ...prepared.material,
      servers: [...prepared.material.servers, otherServer],
    };
    await platform.install({
      ...material,
      actorUserId: fixture.userId,
      requestId: "install-selector-calendar",
    });
    const connectionId = await insertConnection(
      database,
      fixture.userId,
      otherServer.id,
      "selector-calendar",
      "Secondary account",
    );
    const base = {
      ...requestOrigin(fixture),
      installationId: material.installation.id,
      reason: "Read calendar records",
    };
    const serverSpecific = await platform.requests.createIntegrationAccessRequest({
      ...base,
      access: "read",
      callId: "selector-server-read",
      requestedServerId: otherServer.id,
    });
    const accountSpecific = await platform.requests.createIntegrationAccessRequest({
      ...base,
      access: "read",
      callId: "selector-account-read",
      requestedConnectionId: connectionId,
      requestedServerId: otherServer.id,
    });
    const broad = await platform.requests.createIntegrationAccessRequest({
      ...base,
      access: "read-write",
      callId: "selector-broad-write",
      requestedServerId: null,
    });
    await expect(
      platform.requests.resolveIntegrationAccessRequest({
        providerAuthorizations: {},
        requestId: broad.request.id,
        resolvedBy: fixture.userId,
        response: {
          kind: "external",
          value: {
            connectionId: null,
            decision: "fulfilled",
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "Choose the integration server before granting access",
    });
    const otherUserId = await store.createUser("Other selector");
    await expect(
      platform.requests.selectIntegrationAccessServer({
        requestId: broad.request.id,
        requestedServerId: material.servers[0]!.id,
        resolvedBy: otherUserId,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    const selected = await platform.requests.selectIntegrationAccessServer({
      requestId: broad.request.id,
      requestedServerId: material.servers[0]!.id,
      resolvedBy: fixture.userId,
    });
    expect(selected).toMatchObject({
      events: [
        expect.objectContaining({
          type: "request.updated",
        }),
      ],
      request: {
        payload: {
          requestedServerId: material.servers[0]!.id,
        },
        status: "pending",
      },
    });
    await expect(platform.requests.listPendingContinuations()).resolves.toEqual([]);
    await expect(
      platform.requests.selectIntegrationAccessServer({
        requestId: broad.request.id,
        requestedServerId: otherServer.id,
        resolvedBy: fixture.userId,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    await platform.requests.resolveIntegrationAccessRequest({
      providerAuthorizations: {},
      requestId: broad.request.id,
      resolvedBy: fixture.userId,
      response: {
        kind: "external",
        value: {
          connectionId: null,
          decision: "fulfilled",
        },
      },
    });
    await expect(
      Promise.all([
        platform.requests.get(serverSpecific.request.id),
        platform.requests.get(accountSpecific.request.id),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({
        status: "pending",
      }),
      expect.objectContaining({
        status: "pending",
      }),
    ]);
  });
});
function integrationContract(id: string) {
  const definition = IntegrationDefinitionSchema.parse({
    adapter: "graphql",
    authMethods: [
      {
        id: "none",
        kind: "none",
        label: "No authentication",
      },
    ],
    config: {
      endpoint: `https://${id}.example.test/graphql`,
    },
    description: "Calendar records",
    id,
    name: id,
    provider: id,
  });
  return {
    definition,
    manifest: {
      definition: integrationDefinitionSummary(definition),
    },
  };
}
function preparedFulfillment(contract: ReturnType<typeof integrationContract>) {
  const digest = integrationDefinitionDigest(contract.definition);
  return {
    approvalManifest: {
      definition: integrationDefinitionSummary(contract.definition),
      digest,
      kind: "catalog" as const,
    },
    material: {
      adapterSnapshot: {
        adapter: "graphql" as const,
        config: contract.definition.config as Readonly<Record<string, unknown>>,
        definitionId: contract.definition.id,
      },
      installation: {
        description: contract.definition.description,
        id: createIntegrationId("installation"),
        manifest: contract.manifest,
        name: contract.definition.id,
        provenance: {
          definitionDigest: digest,
          definitionId: contract.definition.id,
          maintainedBy: "opensteer",
        },
        sourceKind: "built-in" as const,
        status: "active" as const,
        title: contract.definition.name,
        trust: "built-in" as const,
        version: digest,
      },
      servers: [
        {
          connectionRequirement: {
            kind: "none" as const,
          },
          id: createIntegrationId("server"),
          name: "default",
          status: "active" as const,
          statusDetail: null,
          catalog: {
            definitions: {},
            tools: [],
          },
          transport: {
            adapter: "graphql" as const,
            definitionId: contract.definition.id,
            type: "adapter" as const,
          },
        },
      ],
    },
  };
}
function proposedFulfillment(id: string) {
  const contract = integrationContract(id);
  const digest = createHash("sha256").update(id).digest("base64url");
  const proposal = {
    authMethods: ["none" as const],
    digest,
    kind: "mcp" as const,
    preview: {
      title: id,
    },
    source: {
      origin: `https://${id}.example.test`,
      type: "url" as const,
      url: `https://${id}.example.test/mcp`,
    },
  };
  return {
    approvalManifest: {
      kind: "proposal" as const,
      proposal,
    },
    material: {
      adapterSnapshot: null,
      installation: {
        description: contract.definition.description,
        id: createIntegrationId("installation"),
        manifest: {
          definition: integrationDefinitionSummary(contract.definition),
          proposal: integrationProposalSummary(proposal),
        },
        name: id,
        provenance: {
          artifactDigest: digest,
          proposalKind: proposal.kind,
          source: integrationProposalSummary(proposal).source,
        },
        sourceKind: "proposed" as const,
        status: "active" as const,
        title: contract.definition.name,
        trust: "administrator-approved" as const,
        version: digest,
      },
      servers: [
        {
          connectionRequirement: {
            kind: "none" as const,
          },
          id: createIntegrationId("server"),
          name: "default",
          status: "active" as const,
          statusDetail: null,
          catalog: {
            definitions: {},
            tools: [],
          },
          transport: {
            headers: {},
            type: "streamable-http" as const,
            url: proposal.source.url,
          },
        },
      ],
    },
  };
}
function requestOrigin(fixture: Awaited<ReturnType<typeof runningRunFixture>>) {
  return {
    originatingRunId: fixture.runId,
    originatingThreadId: fixture.threadId,
    requestedBy: fixture.userId,
  };
}
async function insertConnection(
  database: ReturnType<typeof createDatabase>,
  ownerUserId: ReturnType<typeof createId<"user">>,
  _integrationServerId: ReturnType<typeof createIntegrationId<"server">>,
  definitionId: string,
  displayName: string,
) {
  const id = createIntegrationId("connection");
  await database
    .insertInto("integrationConnections")
    .values({
      accountIdentifier: `${displayName.toLowerCase().replaceAll(" ", "-")}@example.test`,
      applicationSource: sql`'{"kind":"api-key"}'::jsonb`,
      authMethodId: "none",
      authorizationDigest: "a".repeat(43),
      capabilities: sql`'[]'::jsonb`,
      connectionKind: "provider-account",
      connectionMethod: "api-key",
      credentialId: null,
      displayName,
      externalIdentityId: id,
      externalTenantId: null,
      grantedScopes: sql`'[]'::jsonb`,
      id,
      integrationDefinitionId: definitionId,
      integrationServerId: null,
      ownerUserId,
      provider: definitionId,
      providerApplicationId: null,
      runnerId: null,
      status: "connected",
      statusDetail: null,
      transportKind: null,
      updatedAt: new Date(),
    })
    .executeTakeFirstOrThrow();
  return id;
}
async function runningRunFixture(store: OpensteerStore, suffix: string, databaseUrl: string) {
  const owner = await personalFixtureOwner(store.database, databaseUrl);
  const personalRuns = createPersonalRunFixturePort(store);
  const task = await personalRuns.createTask({
    ownerId: owner.userId,
    folder: owner.agentHome,
    suffix,
  });
  const started = await personalRuns.startTask(task.threadId, "Start");
  return {
    runId: started.runId,
    threadId: task.threadId,
    userId: owner.userId,
    complete: async () => {
      const row = await store.database
        .selectFrom("runs")
        .select("nextRunnerOrdinal")
        .where("id", "=", started.runId)
        .executeTakeFirstOrThrow();
      return store.commitRunnerEvent({
        environmentId: owner.environmentId,
        runnerBootId: started.runnerBootId,
        runnerId: owner.runnerId,
        event: {
          type: "run.completed",
          environmentId: owner.environmentId,
          runId: started.runId,
          threadId: task.threadId,
          bindingGeneration: started.bindingGeneration,
          ordinal: row.nextRunnerOrdinal,
          emittedAt: new Date().toISOString(),
          data: { status: "completed" },
        },
      });
    },
  };
}
