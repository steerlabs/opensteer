import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId, type UserId } from "@opensteer/core";
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
import { Migrator } from "kysely/migration";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASELINE_SCHEMA_SQL } from "./baseline-schema.js";
import { createDatabase, withDatabaseTransaction } from "./connection.js";
import { IntegrationAuthorityCache } from "./integration-authority-cache.js";
import { IntegrationPlatformStore } from "./integration-platform-store.js";
import { replaceServerToolsInTransaction } from "./integration-platform-stores.js";
import { migrationProvider, migrateToLatest } from "./migrations.js";
import type { DatabaseSchema } from "./schema.js";
import { OpensteerStore } from "./store.js";
import { jsonValue } from "./store-primitives.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
type Schema = Readonly<Record<string, unknown>>;

integration.sequential("shared integration tool definitions E2E", () => {
  const databaseName = `opensteer_tool_definitions_${randomUUID().replaceAll("-", "")}`;
  const baselineName = `${databaseName}_baseline`;
  const queries: string[] = [];
  let maintenance: Pool;
  let database: Kysely<DatabaseSchema>;
  let baseline: Kysely<DatabaseSchema>;

  function urlFor(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlFor("postgres") });
    for (const name of [databaseName, baselineName]) {
      await maintenance.query(`create database ${name}`);
    }
    database = new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: urlFor(databaseName) }) }),
      log: (event) => {
        if (event.level === "query") queries.push(event.query.sql);
      },
      plugins: [new CamelCasePlugin({ maintainNestedObjectKeys: true })],
    });
    baseline = createDatabase({ connectionString: urlFor(baselineName) });
    await sql.raw(BASELINE_SCHEMA_SQL).execute(baseline);
    const migrator = new Migrator({ db: database, provider: migrationProvider() });
    const result = await migrator.migrateTo("0090_thread_task_placement_revision");
    if (result.error) throw result.error;
    // 0001 declares the current shape; reconstruct exactly the released 0090 columns.
    await sql`
      drop table if exists public.integration_tool_definitions;
      alter table public.integration_tools
        drop column if exists definition_names,
        drop column if exists target;
    `.execute(database);
  });

  afterAll(async () => {
    await database?.destroy();
    await baseline?.destroy();
    for (const name of [databaseName, baselineName]) {
      await maintenance?.query(`drop database if exists ${name}`);
    }
    await maintenance?.end();
  });

  it("compacts old provider catalogs, proves bounded reads and writes, and removes documents", async () => {
    const store = new OpensteerStore(database);
    const platform = new IntegrationPlatformStore(database);
    const ownerUserId = await store.createUser("Schema proof owner");
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
    const mcp = await seedScope(
      "mcp",
      {
        definitions: {},
        tools: [
          material(
            "first",
            { $defs: { Shared: { type: "string" } }, $ref: "#/$defs/Shared" },
            null,
          ),
          material(
            "second",
            { $defs: { Shared: { type: "integer" } }, $ref: "#/$defs/Shared" },
            null,
          ),
        ],
      },
      ownerUserId,
    );
    const conflict = await seedScope(
      "openapi",
      {
        definitions: {},
        tools: [
          material(
            "first",
            { $defs: { Shared: { type: "string" } }, $ref: "#/$defs/Shared" },
            null,
          ),
          material(
            "second",
            { $defs: { Shared: { type: "integer" } }, $ref: "#/$defs/Shared" },
            null,
          ),
        ],
      },
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
    await insertLegacyTool(scoped.serverId, scoped.tools[0]!);
    const disabled = {
      ...material("disabled", standaloneToolSchema(root, definitions), null),
      status: "disabled" as const,
    };
    await insertLegacyTool(openapi.serverId, disabled);
    const untouchedIds = [...mcp.tools, ...conflict.tools, disabled].map(({ id }) => id);
    const beforeUntouched = await database
      .selectFrom("integrationTools")
      .selectAll()
      .where("id", "in", untouchedIds)
      .orderBy("id")
      .execute();
    const beforeBytes = await schemaBytes(false);
    await migrateToLatest(database);
    const workspace = await store.createWorkspace({
      backing: { generation: 1, kind: "portablefs", serviceId: "test", volumeId: "schema-proof" },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: ownerUserId,
      idempotencyKey: "schema-proof",
      name: "Schema proof",
      status: "ready",
    });
    const afterBytes = await schemaBytes();
    expect(afterBytes).toBeLessThan(beforeBytes / 5);
    const afterUntouched = await database
      .selectFrom("integrationTools")
      .selectAll()
      .where("id", "in", untouchedIds)
      .orderBy("id")
      .execute();
    expect(
      afterUntouched.map(({ definitionNames: _names, target: _target, ...row }) => row),
    ).toEqual(beforeUntouched);
    expect(afterUntouched.every(({ definitionNames }) => definitionNames.length === 0)).toBe(true);
    expect(afterUntouched.every(({ target }) => target === null)).toBe(true);
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
        workspaceId: workspace.id,
        updatedAt: new Date(),
      })
      .execute();
    const requester = {
      ownerUserId,
      providerAuthorizations: {},
      threadId: createId("thread"),
      workspaceId: workspace.id,
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
    const scopes = Array.from({ length: 257 }, () => ({
      authorityFingerprint: "v1",
      generation: 1,
      inheritsMain: false,
      ownerUserId,
      workspaceId: createId("workspace"),
    }));
    for (const [index, scope] of scopes.entries()) {
      if (index === 256) expect(cache.get(scopes[0]!)).toBe(0);
      cache.set(scope, index);
    }
    expect(cache.get(scopes[0]!)).toBe(0);
    expect(cache.get(scopes[1]!)).toBeNull();
    cache.set({ ...scopes[0]!, generation: 2 }, 999);
    expect(cache.get(scopes[0]!)).toBeNull();
    expect(cache.get({ ...scopes[0]!, generation: 2 })).toBe(999);

    const schemaQueries = [
      `select table_name, column_name, data_type, is_nullable, coalesce(column_default, '') as column_default from information_schema.columns where table_schema='public' and table_name in ('integration_tools', 'integration_tool_definitions') order by table_name, ordinal_position`,
      `select conrelid::regclass::text as table_name, conname, pg_get_constraintdef(oid) as definition from pg_constraint where conrelid in ('integration_tools'::regclass, 'integration_tool_definitions'::regclass) order by table_name, conname`,
      `select tablename, indexname, indexdef from pg_indexes where schemaname='public' and tablename in ('integration_tools', 'integration_tool_definitions') order by tablename, indexname`,
    ];
    for (const query of schemaQueries)
      expect((await sql.raw(query).execute(database)).rows).toEqual(
        (await sql.raw(query).execute(baseline)).rows,
      );
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
          cache: { bound: 256, evictedLeastRecentlyUsed: true },
          verified: {
            atomicReads: true,
            corruptedDefinitionsRejected: true,
            metadataOnlyListings: true,
            scopedDefinitions: true,
            uninstallCleanup: true,
            writerLimits: true,
          },
          listingQueries,
          migration: "0091_integration_tool_definitions",
          proofs,
          untouchedTools: untouchedIds.length,
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
    for (const tool of tools) await insertLegacyTool(serverId, tool);
    return { installationId, serverId, tools };
  }

  async function insertLegacyTool(
    serverId: ReturnType<typeof createIntegrationId<"server">>,
    tool: IntegrationToolMaterial,
  ) {
    await database
      .insertInto("integrationTools")
      .values({
        ...tool,
        annotations: jsonValue(tool.annotations),
        inputSchema: jsonValue(tool.inputSchema),
        outputSchema: tool.outputSchema === null ? null : jsonValue(tool.outputSchema),
        schemaDigest: integrationSchemaDigest({
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
        }),
        serverId,
      })
      .execute();
  }

  async function schemaBytes(shared = true): Promise<number> {
    const result = shared
      ? await sql<{
          bytes: number;
        }>`select coalesce(sum(octet_length(input_schema::text) + coalesce(octet_length(output_schema::text), 0)), 0)::integer + coalesce((select sum(octet_length(definitions::text))::integer from public.integration_tool_definitions), 0) as bytes from public.integration_tools`.execute(
          database,
        )
      : await sql<{
          bytes: number;
        }>`select sum(octet_length(input_schema::text) + coalesce(octet_length(output_schema::text), 0))::integer as bytes from public.integration_tools`.execute(
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
