import {
  personalFixtureOwner,
  createPersonalRunFixturePort,
} from "./personal-run-fixture.test-support.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type UserId } from "@opensteer/core";
import {
  createIntegrationId,
  type IntegrationConnectionId,
  type IntegrationToolCatalog,
  type IntegrationToolMaterial,
} from "@opensteer/integration-core";
import { integrationSchemaDigest } from "@opensteer/integration-core/digest";
import {
  definitionClosure,
  standaloneToolSchema,
  storedToolSchemaDigest,
} from "@opensteer/integration-core/tool-schemas";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { CamelCasePlugin, Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withDatabaseTransaction } from "./connection.js";
import { IntegrationAuthorityCache } from "./integration-authority-cache.js";
import { IntegrationPlatformStore } from "./integration-platform-store.js";
import { replaceServerToolsInTransaction } from "./integration-platform-stores.js";
import { migrateToLatest } from "./migrations.js";
import type { DatabaseSchema } from "./schema.js";
import { OpensteerStore } from "./store.js";
import { jsonValue } from "./store-primitives.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
type Schema = Readonly<Record<string, unknown>>;

integration.sequential("shared integration tool definitions E2E", () => {
  const databaseName = `opensteer_tool_definitions_${randomUUID().replaceAll("-", "")}`;
  const queries: string[] = [];
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;

  function urlFor(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlFor("postgres") });
    for (const name of [databaseName]) {
      await maintenance.query(`create database ${name}`);
    }
    database = new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: urlFor(databaseName) }) }),
      log: (event) => {
        if (event.level === "query") queries.push(event.query.sql);
      },
      plugins: [new CamelCasePlugin({ maintainNestedObjectKeys: true })],
    });
    await migrateToLatest(database);
  });

  afterAll(async () => {
    await database?.destroy();
    for (const name of [databaseName]) {
      await maintenance?.query(`drop database if exists ${name}`);
    }
    await maintenance?.end();
  });

  it("stores shared provider catalogs with bounded reads and writes and removes documents", async () => {
    const store = new OpensteerStore(database);
    const platform = new IntegrationPlatformStore(database);
    const personal = await personalFixtureOwner(database, urlFor(databaseName));
    const ownerUserId = personal.userId;
    const task = await createPersonalRunFixturePort(store).createTask({
      ownerId: ownerUserId,
      suffix: "schemas",
    });
    const definitions: Record<string, Schema> = {};
    for (let index = 11; index >= 0; index -= 1) {
      definitions[`Type${index}`] = {
        description: `Shared type ${index}: ${"x".repeat(1_024)}`,
        properties:
          index === 11
            ? { value: { type: "string" } }
            : { next: { $ref: `#/$defs/Type${index + 1}` } },
        type: "object",
      };
    }
    definitions["escaped/name~"] = { $ref: "#/$defs/Type0" };
    definitions.Unused = { type: "boolean" };
    const root = { properties: { value: { $ref: "#/$defs/escaped~1name~0" } }, type: "object" };
    const catalog: IntegrationToolCatalog = {
      definitions,
      tools: Array.from({ length: 24 }, (_, index) =>
        material(
          `operation.${index}`,
          index === 0 ? { $ref: "#/$defs/Type10" } : root,
          index === 0 ? null : { $ref: "#/$defs/Type6" },
        ),
      ),
    };
    const openapi = await seedScope("openapi", catalog, ownerUserId);
    const graphql = await seedScope(
      "graphql",
      { definitions, tools: [material("query.records", root, root)] },
      ownerUserId,
    );
    const scopedConnectionId = await seedConnection(ownerUserId);
    const scopedDefinitions = {
      ...definitions,
      Type0: { ...definitions.Type0, description: "Connection-specific type" },
    };
    const scopedMaterial = {
      ...material("query.scoped", root, null),
      connectionId: scopedConnectionId,
    };
    const scoped = {
      installationId: graphql.installationId,
      serverId: graphql.serverId,
      tools: [
        {
          ...scopedMaterial,
          inputSchema: standaloneToolSchema(root, scopedDefinitions),
        },
      ],
    };
    await platform.reconcileProviderConnectionTools({
      catalog: { definitions: scopedDefinitions, tools: [scopedMaterial] },
      connectionId: scopedConnectionId,
      definitionId: "proof",
      ownerUserId,
      serverId: scoped.serverId,
    });
    const beforeBytes = [openapi, graphql, scoped]
      .flatMap((scope) => scope.tools)
      .reduce(
        (bytes, tool) =>
          bytes +
          Buffer.byteLength(JSON.stringify(tool.inputSchema)) +
          (tool.outputSchema ? Buffer.byteLength(JSON.stringify(tool.outputSchema)) : 0),
        0,
      );
    const afterBytes = await schemaBytes();
    expect(afterBytes).toBeLessThan(beforeBytes / 5);
    expect(
      await database
        .selectFrom("integrationToolDefinitions")
        .select("serverId")
        .orderBy("serverId")
        .execute(),
    ).toHaveLength(3);
    const proofs: unknown[] = [];
    for (const scope of [openapi, graphql, scoped]) {
      for (const tool of scope.tools) {
        queries.length = 0;
        const schemas = await platform.getToolSchemas(tool.id);
        expect(queries).toHaveLength(1);
        expect(schemas).not.toBeNull();
        if (!schemas) throw new Error("Missing schemas");
        const names = definitionClosure([tool.inputSchema, tool.outputSchema], definitions);
        expect(Object.keys(schemas.definitions).sort()).toEqual(names);
        expect(schemas.schemaDigest).toBe(storedToolSchemaDigest(schemas));
        expect(canonicalJson(standaloneToolSchema(schemas.inputSchema, schemas.definitions))).toBe(
          canonicalJson(tool.inputSchema),
        );
        expect(
          canonicalJson(
            schemas.outputSchema === null
              ? null
              : standaloneToolSchema(schemas.outputSchema, schemas.definitions),
          ),
        ).toBe(canonicalJson(tool.outputSchema));
        const row = await database
          .selectFrom("integrationTools")
          .select(["definitionNames", "inputSchema", "outputSchema"])
          .where("id", "=", tool.id)
          .executeTakeFirstOrThrow();
        expect(row.definitionNames).toEqual(names);
        expect(row.inputSchema).not.toHaveProperty("$defs");
        if (row.outputSchema !== null) expect(row.outputSchema).not.toHaveProperty("$defs");
        proofs.push({
          definitionNames: names,
          name: tool.name,
          schemaDigest: schemas.schemaDigest,
          standaloneDigest: integrationSchemaDigest({
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
          }),
        });
      }
    }
    const rootGraphqlSchemas = await platform.getToolSchemas(graphql.tools[0]!.id);
    await platform.reconcileProviderConnectionTools({
      catalog: { definitions: scopedDefinitions, tools: [scopedMaterial] },
      connectionId: scopedConnectionId,
      definitionId: "proof",
      ownerUserId,
      serverId: scoped.serverId,
    });
    expect((await platform.getToolSchemas(graphql.tools[0]!.id))!.schemaDigest).toBe(
      rootGraphqlSchemas!.schemaDigest,
    );
    expect((await platform.getToolSchemas(scoped.tools[0]!.id))!.definitions.Type0).toEqual(
      scopedDefinitions.Type0,
    );
    expect((await platform.getToolSchemas(scoped.tools[0]!.id))!.definitions).not.toHaveProperty(
      "Unused",
    );
    await database
      .updateTable("integrationToolDefinitions")
      .set({ definitions: jsonValue({}) })
      .where("serverId", "=", scoped.serverId)
      .where("connectionId", "=", scopedConnectionId)
      .execute();
    await expect(platform.getToolSchemas(scoped.tools[0]!.id)).rejects.toMatchObject({
      code: "conflict",
    });
    await platform.reconcileProviderConnectionTools({
      catalog: { definitions: scopedDefinitions, tools: [scopedMaterial] },
      connectionId: scopedConnectionId,
      definitionId: "proof",
      ownerUserId,
      serverId: scoped.serverId,
    });
    const firstSchemas = await platform.getToolSchemas(openapi.tools[0]!.id);
    queries.length = 0;
    expect(await platform.getToolInvocation(openapi.tools[0]!.id)).toMatchObject({
      schemaDigest: firstSchemas!.schemaDigest,
      status: "active",
    });
    expect(queries).toHaveLength(1);
    await expect(platform.getToolSchemas(createIntegrationId("tool"))).resolves.toBeNull();
    await expect(platform.getToolInvocation(createIntegrationId("tool"))).resolves.toBeNull();

    await database
      .insertInto("integrationGrants")
      .values({
        access: "read-write",
        alias: "proof",
        createdBy: ownerUserId,
        connectionId: null,
        id: createIntegrationId("grant"),
        installationId: openapi.installationId,
        isDefault: false,
        ownerUserId,
        revokedAt: null,
        status: "active",

        updatedAt: new Date(),
      })
      .execute();
    const requester = {
      ownerUserId,
      providerAuthorizations: {},
      threadId: task.threadId,
    };
    queries.length = 0;
    const listed = await platform.listTools(openapi.installationId);
    await platform.listDiscoveryInventory(requester);
    const callables = await platform.listCallableTools(requester);
    expect(listed).toHaveLength(24);
    expect(callables).toHaveLength(24);
    expect(listed.every((tool) => !("inputSchema" in tool) && !("outputSchema" in tool))).toBe(
      true,
    );
    expect(callables.every((tool) => !("adapterSnapshot" in tool))).toBe(true);
    const listingQueries = queries.filter((query) => query.includes('from "integration_tools"'));
    expect(listingQueries.length).toBeGreaterThanOrEqual(3);
    for (const query of listingQueries)
      expect(query).not.toMatch(/\*|input_schema|output_schema|definition_names|adapter_snapshot/u);

    const replacement = (next: IntegrationToolCatalog) =>
      withDatabaseTransaction(database, (transaction) =>
        replaceServerToolsInTransaction(transaction, {
          catalog: next,
          now: new Date(),
          serverId: openapi.serverId,
        }),
      );
    for (const [name, invalid] of [
      [
        "utf8-",
        {
          definitions: {},
          tools: [{ ...material(`utf8-${"é".repeat(255)}`, {}, null), title: "UTF-8 name" }],
        },
      ],
      [
        "oversize-input",
        {
          definitions: {},
          tools: [material("oversize-input", { description: "x".repeat(1_048_576) }, null)],
        },
      ],
      [
        "jsonb-expansion",
        {
          definitions: {},
          tools: [
            material("jsonb-expansion", { enum: Array.from({ length: 350_000 }, () => 0) }, null),
          ],
        },
      ],
      [
        "oversize-output",
        {
          definitions: {},
          tools: [material("oversize-output", {}, { description: "x".repeat(1_048_576) })],
        },
      ],
      [
        "invalid-title",
        {
          definitions: {},
          tools: [{ ...material("invalid-title", {}, null), title: "x".repeat(161) }],
        },
      ],
      [
        "oversize-annotations",
        {
          definitions: {},
          tools: [
            {
              ...material("oversize-annotations", {}, null),
              annotations: { description: "x".repeat(65_536) },
            },
          ],
        },
      ],
    ] as const) {
      await expect(replacement(invalid)).rejects.toMatchObject({
        code: "bad_request",
        message: expect.stringContaining(name),
      });
    }
    await expect(
      replacement({
        definitions: { Big: { description: "x".repeat(8_388_608) } },
        tools: [material("big", { $ref: "#/$defs/Big" }, null)],
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringContaining(openapi.serverId),
    });
    await expect(
      replacement({
        definitions,
        tools: [{ ...material("wrong-scope", root, null), connectionId: scopedConnectionId }],
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(await platform.listTools(openapi.installationId)).toHaveLength(24);
    await replacement(catalog);
    expect((await platform.listTools(openapi.installationId)).map(({ id }) => id)).toEqual(
      listed.map(({ id }) => id),
    );
    const emptyScopeTool = material("no-definitions", {}, null);
    await replacement({ definitions: {}, tools: [emptyScopeTool] });
    expect(
      await database
        .selectFrom("integrationToolDefinitions")
        .select("serverId")
        .where("serverId", "=", openapi.serverId)
        .execute(),
    ).toEqual([]);
    await replacement(catalog);
    await platform.uninstall({
      actorUserId: ownerUserId,
      installationId: openapi.installationId,
      requestId: "schema-proof-uninstall",
    });
    expect(
      await database
        .selectFrom("integrationToolDefinitions")
        .select("serverId")
        .where("serverId", "=", openapi.serverId)
        .execute(),
    ).toEqual([]);
    await platform.uninstall({
      actorUserId: ownerUserId,
      installationId: scoped.installationId,
      requestId: "schema-proof-scoped-uninstall",
    });
    expect(
      await database
        .selectFrom("integrationToolDefinitions")
        .select("serverId")
        .where("serverId", "=", scoped.serverId)
        .execute(),
    ).toEqual([]);

    const cache = new IntegrationAuthorityCache<number>();
    const authority = { authorityFingerprint: "v1", generation: 1, ownerUserId };
    cache.set(authority, 0);
    expect(cache.get(authority)).toBe(0);
    const changed = { ...authority, generation: 2, authorityFingerprint: "v2" };
    cache.set(changed, 999);
    expect(cache.get(authority)).toBeNull();
    expect(cache.get(changed)).toBe(999);

    const artifactPath = join(
      await mkdtemp(join(tmpdir(), "opensteer-tool-definitions-")),
      "proof.json",
    );
    await writeFile(
      artifactPath,
      JSON.stringify(
        {
          afterBytes,
          beforeBytes,
          cache: { staleGenerationEvicted: true },
          verified: {
            atomicReads: true,
            corruptedDefinitionsRejected: true,
            metadataOnlyListings: true,
            scopedDefinitions: true,
            uninstallCleanup: true,
            writerLimits: true,
          },
          listingQueries,
          proofs,
        },
        null,
        2,
      ),
    );
    console.log(`Integration tool definitions proof: ${artifactPath}`);
  });

  async function seedConnection(ownerUserId: UserId): Promise<IntegrationConnectionId> {
    const id = createIntegrationId("connection");
    await database
      .insertInto("integrationConnections")
      .values({
        accountIdentifier: null,
        applicationSource: jsonValue({ kind: "api-key" }),
        authMethodId: "api-key",
        authorizationDigest: "a".repeat(43),
        capabilities: jsonValue([]),
        connectionKind: "provider-account",
        connectionMethod: "api-key",
        credentialId: null,
        displayName: "Proof account",
        externalIdentityId: id,
        externalTenantId: null,
        grantedScopes: jsonValue([]),
        id,
        integrationDefinitionId: "proof",
        integrationServerId: null,
        ownerUserId,
        provider: "proof",
        providerApplicationId: null,
        status: "connected",
        statusDetail: null,
        transportKind: null,
      })
      .execute();
    return id;
  }

  async function seedScope(
    adapter: "openapi" | "graphql" | "mcp",
    catalog: IntegrationToolCatalog,
    ownerUserId: UserId,
  ) {
    const installationId = createIntegrationId("installation");
    const serverId = createIntegrationId("server");
    await database
      .insertInto("integrationInstallations")
      .values({
        adapterSnapshot: jsonValue({
          adapter,
          config: { specUrl: "https://proof.test/openapi.json" },
          definitionId: "proof",
        }),
        createdBy: ownerUserId,
        description: "Schema proof",
        id: installationId,
        manifest: jsonValue({}),
        name: `proof-${randomUUID()}`,
        provenance: jsonValue({}),
        revision: 1,
        sourceKind: "built-in",
        status: "active",
        title: "Schema proof",
        trust: "built-in",
        updatedBy: ownerUserId,
        version: null,
      })
      .execute();
    await database
      .insertInto("integrationServers")
      .values({
        connectionRequirement: jsonValue({ kind: "none" }),
        id: serverId,
        installationId,
        name: "default",
        status: "active",
        statusDetail: null,
        toolGeneration: 1,
        transport: jsonValue({ adapter, definitionId: "proof", type: "adapter" }),
      })
      .execute();
    const tools = catalog.tools.map((tool) => ({
      ...tool,
      inputSchema: standaloneToolSchema(tool.inputSchema, catalog.definitions),
      outputSchema:
        tool.outputSchema === null
          ? null
          : standaloneToolSchema(tool.outputSchema, catalog.definitions),
    }));
    await withDatabaseTransaction(database, (transaction) =>
      replaceServerToolsInTransaction(transaction, { catalog, now: new Date(), serverId }),
    );
    return { installationId, serverId, tools };
  }

  async function schemaBytes(): Promise<number> {
    const result = await sql<{
      bytes: number;
    }>`select coalesce(sum(octet_length(input_schema::text) + coalesce(octet_length(output_schema::text), 0)), 0)::integer + coalesce((select sum(octet_length(definitions::text))::integer from public.integration_tool_definitions), 0) as bytes from public.integration_tools`.execute(
      database,
    );
    return result.rows[0]!.bytes;
  }
});

function material(
  name: string,
  inputSchema: Schema,
  outputSchema: Schema | null,
): IntegrationToolMaterial {
  return {
    annotations: {},
    connectionId: null,
    description: "Schema proof",
    id: createIntegrationId("tool"),
    inputSchema,
    name,
    outputSchema,
    status: "active",
    title: name,
  };
}
