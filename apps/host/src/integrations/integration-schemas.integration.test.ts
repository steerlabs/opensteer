import { startUpstream } from "./integration-schemas.test-support.js";
/**
 * A large API's schemas through the integration gateway, end to end on real
 * parts: one real Host on real PostgreSQL, an agent proposing a Vapi-shaped
 * OpenAPI document whose operations all reach the same large, deeply nested
 * and cyclic types, its owner approving the Request, the real gateway over
 * HTTP, and the real OpenAPI adapter calling a local upstream. Only where the
 * Host's provider traffic lands is the test's own.
 *
 * Ways this can fail, each asserted below:
 *  1. The dashboard read (`integration.platform.get`) carries a schema, or
 *     grows with the API's types.
 *  2. A describe answer exceeds 32,000 UTF-8 bytes, so an engine cuts it.
 *  3. Pages lose, repeat or corrupt bytes where they meet, including inside a
 *     multibyte character, so they do not join into exactly the schemas.
 *  4. A described schema is not standalone: a `$ref` resolves nowhere in it,
 *     or a definition is missing, extra, or differs from the document's.
 *  5. A path, as a `$ref` names a definition, does not narrow to that part,
 *     and a missing one is not named.
 *  6. The Host judges a call against the schema instead of the upstream, the
 *     call does not reach the upstream as its operation declares, or the
 *     upstream's refusal does not come back as it was written.
 *  7. A `..` path argument reaches a different upstream path.
 *  8. A toolRef issued before its operation's schema changed still describes
 *     or calls it; one whose schemas did not change stops working.
 *
 * Writes `result.json` to `OPENSTEER_INTEGRATION_SCHEMAS_E2E_ARTIFACT_DIR`,
 * or a temporary directory, whether it passes or not.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RequestIdSchema } from "@opensteer/core";
import { IntegrationPlatformStore, replaceServerToolsInTransaction } from "@opensteer/database";
import {
  IntegrationToolIdSchema,
  type IntegrationInstallationId,
  type IntegrationServerId,
} from "@opensteer/integration-core";
import { standaloneToolSchema } from "@opensteer/integration-core/tool-schemas";
import { testRpcData, testRpcRequest } from "../server/test-host-api-request.js";
import { integrationGateway, toolText } from "../runtime/computer-apps.test-support.js";
import {
  connectCallerMachine,
  createMachineAccessDatabase,
  dispatchCallerRun,
  enrollmentToken,
  resetMachineAccessDatabase,
  startMachineAccessHost,
  type MachineAccessHost,
} from "../runtime/machine-access.test-support.js";
import { maximumDescribeBytes } from "./integration-describe.js";

const baseDatabaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = baseDatabaseUrl ? describe : describe.skip;
let database: Awaited<ReturnType<typeof createMachineAccessDatabase>> | undefined;
let databaseUrl = "postgres://unconfigured";

const upstreamOrigin = "https://vapi.example.test";
const apiTitle = "Synthvapi";
const refusalBody =
  '{"message":["name must be a string","property unexpected should not exist"],"error":"Unprocessable Entity","statusCode":422}';

type Json = Readonly<Record<string, unknown>>;
type Gateway = Awaited<ReturnType<typeof integrationGateway>>;

integration("integration schemas", () => {
  beforeAll(async () => {
    database = await createMachineAccessDatabase(baseDatabaseUrl ?? "");
    databaseUrl = database.url;
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
    database = undefined;
  }, 120_000);

  beforeEach(async () => resetMachineAccessDatabase(databaseUrl));

  let closeCurrent: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await closeCurrent?.();
    closeCurrent = undefined;
  }, 60_000);

  it("lists a large API without its schemas and describes each part in bounded pages", async () => {
    const artifactDirectory =
      process.env.OPENSTEER_INTEGRATION_SCHEMAS_E2E_ARTIFACT_DIR ??
      (await mkdtemp(join(tmpdir(), "opensteer-integration-schemas-e2e-")));
    const steps: { readonly observed: unknown; readonly step: string }[] = [];
    const record = (step: string, observed: unknown) => steps.push({ observed, step });
    let failure: unknown = null;
    try {
      const api = syntheticVapi();
      const specText = JSON.stringify(api.document);
      const upstream = await startUpstream(specText, upstreamOrigin, refusalBody);
      const closers: (() => Promise<void>)[] = [() => upstream.close()];
      closeCurrent = async () => {
        for (const close of closers) await close().catch(() => undefined);
      };
      const host = await startMachineAccessHost(databaseUrl, {
        integrationFetch: upstream.fetch,
        signupPolicy: "open",
      });
      closers.unshift(() => host.close());
      const caller = await connectCallerMachine(host, {
        name: "Caller",
        token: await enrollmentToken(host, {
          allowedModules: ["agents"],
          idempotencyKey: "integration-schemas-caller",
          name: "Caller",
        }),
      });
      closers.unshift(() => caller.close());
      const run = await dispatchCallerRun(host, caller, {
        key: "integration-schemas-run",
        title: "Set up a voice assistant",
      });
      closers.unshift(() => run.complete());
      const gateway = await integrationGateway(run.integrationTools);
      closers.unshift(() => gateway.close());
      record("document", {
        components: Object.keys(api.schemas).length,
        operations: api.operations.length,
        specBytes: Buffer.byteLength(specText, "utf8"),
      });
      expect(api.operations.length).toBeGreaterThanOrEqual(100);

      // An agent proposes the API and its owner approves it.
      const installing = performance.now();
      const installationId = await proposeAndInstall(host, gateway);
      record("installed", { elapsedMs: Math.round(performance.now() - installing) });
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          idempotencyKey: "integration-schemas-grant",
          input: {
            access: "read-write",
            alias: "Voice",
            connectionId: null,
            installationId,
            isDefault: true,
            workspaceId: run.workspaceId,
          },
          type: "integration.grant.create",
        },
        { headers: host.ownerHeaders },
      );
      const server = await host.store.database
        .selectFrom("integrationServers")
        .select(["id"])
        .where("installationId", "=", installationId)
        .executeTakeFirstOrThrow();
      const store = new IntegrationPlatformStore(host.store.database);

      // 1. The dashboard names every operation and carries none of its schemas.
      const dashboardResponse = await testRpcRequest(
        host.origin,
        "integration.platform.get",
        {},
        { headers: host.ownerHeaders },
      );
      const dashboardText = await dashboardResponse.text();
      expect(dashboardResponse.status).toBe(200);
      const dashboard = JSON.parse(dashboardText) as { readonly data: unknown };
      const dashboardKeys = jsonKeys(dashboard);
      for (const key of ["inputSchema", "outputSchema", "$defs", "$ref"]) {
        expect(dashboardKeys.has(key)).toBe(false);
      }
      const listed = await store.listTools(installationId, host.ownerId);
      expect(listed.filter(({ status }) => status === "active")).toHaveLength(
        api.operations.length,
      );
      const storage = await storedBytes(host, server.id);
      const schemaListingBytes = await schemaCarryingListingBytes(store, listed);
      const dashboardBytes = Buffer.byteLength(dashboardText, "utf8");
      expect(dashboardBytes).toBeLessThan(256 * 1_024);
      record("dashboard", {
        dashboardBytes,
        schemaCarryingListingBytes: schemaListingBytes,
        storedDefinitionBytes: storage.definitionBytes,
        storedToolSchemaBytes: storage.toolSchemaBytes,
      });

      // The operations an agent finds, each with the toolRef it describes and calls.
      const found = await searchAll(gateway);
      expect(found.total).toBe(api.operations.length);
      const operation = (name: string) => {
        const match = found.operations.find((candidate) => candidate.name === name);
        if (!match) throw new Error(`${name} was not found`);
        return match;
      };
      const createAssistant = operation("assistants.createAssistant");
      const getAssistant = operation("assistants.getAssistant");
      const listLogs = operation("logs.listLogs");

      // 2–4. The whole document, page by page: bounded, complete and exact.
      const expected = await describedDocument(store, createAssistant.toolRef);
      const whole = await describeAll(gateway, createAssistant.toolRef, undefined);
      expect(whole.first).toMatchObject({
        account: { alias: "Voice", connectionId: null, isDefault: true },
        integration: { title: apiTitle, trust: "administrator-approved" },
        operation: { name: "assistants.createAssistant" },
        path: "",
        toolRef: createAssistant.toolRef,
      });
      expect(whole.pages).toBeGreaterThan(1);
      expect(whole.joined).toBe(JSON.stringify(expected));
      expect(JSON.parse(whole.joined)).toEqual(expected);
      const createAssistantSpec = api.operations.find(
        ({ operationId }) => operationId === "createAssistant",
      )!;
      for (const part of ["inputSchema", "outputSchema"] as const) {
        const schema = expected[part] as Json;
        expect(unresolvedReferences(schema)).toEqual([]);
        const reachable = componentClosure(
          part === "inputSchema" ? createAssistantSpec.inputRoots : createAssistantSpec.outputRoots,
          api.schemas,
        );
        const definitions = (schema.$defs ?? {}) as Json;
        expect(Object.keys(definitions).sort()).toEqual(reachable);
        for (const name of reachable) {
          expect(definitions[name]).toEqual(hoisted(api.schemas[name]));
        }
      }
      expect(Object.keys((expected.inputSchema as Json).$defs as Json)).toContain("Assistant");
      record("described whole", whole.summary);

      // 5. Narrowed to one part, as a `$ref` names it.
      const properties = await describeAll(
        gateway,
        createAssistant.toolRef,
        "/inputSchema/properties",
      );
      expect(properties.pages).toBe(1);
      expect(JSON.parse(properties.joined)).toEqual((expected.inputSchema as Json).properties);
      const bodyReference = ((expected.inputSchema as Json).properties as Json).body as Json;
      expect(bodyReference.$ref).toBe("#/$defs/CreateAssistantDTO");
      const assistant = await describeAll(
        gateway,
        createAssistant.toolRef,
        "#/inputSchema/$defs/Assistant",
      );
      expect(assistant.first).toMatchObject({ path: "/inputSchema/$defs/Assistant" });
      expect(assistant.first).not.toHaveProperty("operation");
      expect(JSON.parse(assistant.joined)).toEqual(
        ((expected.inputSchema as Json).$defs as Json).Assistant,
      );
      const viaReference = await describeAll(
        gateway,
        createAssistant.toolRef,
        `/inputSchema${String(bodyReference.$ref).slice(1)}`,
      );
      expect(JSON.parse(viaReference.joined)).toEqual(
        ((expected.inputSchema as Json).$defs as Json).CreateAssistantDTO,
      );
      const allOutputDefinitions = await describeAll(
        gateway,
        createAssistant.toolRef,
        "/outputSchema/$defs",
      );
      expect(allOutputDefinitions.pages).toBeGreaterThan(1);
      expect(JSON.parse(allOutputDefinitions.joined)).toEqual(
        (expected.outputSchema as Json).$defs,
      );
      const missing = await gateway.callRaw("integration_describe", {
        path: "/inputSchema/$defs/NoSuchType",
        toolRef: createAssistant.toolRef,
      });
      expect(missing.isError).toBe(true);
      expect(toolText(missing)).toContain('"/inputSchema/$defs/NoSuchType"');
      const pastEnd = await gateway.callRaw("integration_describe", {
        cursor: properties.schemaBytes + 10,
        path: "/inputSchema/properties",
        toolRef: createAssistant.toolRef,
      });
      expect(pastEnd.isError).toBe(true);
      expect(toolText(pastEnd)).toContain("past the end");
      record("described parts", {
        allOutputDefinitions: allOutputDefinitions.summary,
        assistant: assistant.summary,
        missing: toolText(missing),
        pastEnd: toolText(pastEnd),
        properties: properties.summary,
      });

      // 6. Calls reach the upstream as declared, and its refusal comes back as written.
      const call = (toolRef: string, args: Json) =>
        gateway.callRaw("integration_call", { arguments: args, toolRef });
      const invalidBody = { firstMessage: "Hello", unexpected: true };
      const refused = await call(createAssistant.toolRef, { body: invalidBody });
      expect(refused.isError).toBe(true);
      expect(toolText(refused)).toContain(refusalBody);
      expect(upstream.received).toEqual([
        {
          body: JSON.stringify(invalidBody),
          contentType: "application/json",
          method: "POST",
          url: "/assistant",
        },
      ]);
      const fetched = await call(getAssistant.toolRef, { id: "asst_1" });
      expect(fetched.isError).toBeFalsy();
      expect(fetched.structuredContent).toEqual({ id: "asst_1", name: "Riley" });
      expect(upstream.received.at(-1)).toMatchObject({ method: "GET", url: "/assistant/asst_1" });
      const undeclared = await call(getAssistant.toolRef, { id: "asst_1", voiceId: "v" });
      expect(undeclared.isError).toBe(true);
      expect(toolText(undeclared)).toContain("invalid_arguments");
      record("called", {
        fetched: fetched.structuredContent,
        refused: toolText(refused),
        undeclared: toolText(undeclared),
        upstream: [...upstream.received],
      });

      // 7. A `..` argument never addresses another path.
      const beforeEscape = upstream.received.length;
      const escaped = await call(getAssistant.toolRef, { id: ".." });
      expect(escaped.isError).toBe(true);
      expect(toolText(escaped)).toContain("invalid_arguments");
      expect(upstream.received).toHaveLength(beforeEscape);
      record("path escape refused", toolText(escaped));

      // 8. Rematerialized unchanged, every toolRef holds; with one definition
      // changed, exactly the toolRefs whose schemas reach it are retired.
      await rematerialize(host, server.id, null);
      const unchanged = await searchAll(gateway);
      expect(unchanged.operations.map(({ toolRef }) => toolRef).sort()).toEqual(
        found.operations.map(({ toolRef }) => toolRef).sort(),
      );
      await rematerialize(host, server.id, "Assistant");
      const stale = await gateway.callRaw("integration_describe", {
        toolRef: createAssistant.toolRef,
      });
      expect(stale.isError).toBe(true);
      expect(toolText(stale)).toBe(
        "Integration operation schema changed; search and describe it again",
      );
      const staleCall = await call(getAssistant.toolRef, { id: "asst_1" });
      expect(staleCall.isError).toBe(true);
      expect(toolText(staleCall)).toBe(
        "Integration operation schema changed; search and describe it again",
      );
      const untouched = await describeAll(gateway, listLogs.toolRef, "/outputSchema");
      expect(JSON.parse(untouched.joined)).toMatchObject({ type: "array" });
      const fresh = (await searchAll(gateway)).operations.find(
        ({ name }) => name === "assistants.createAssistant",
      )!;
      expect(fresh.toolRef).not.toBe(createAssistant.toolRef);
      const changed = await describeAll(gateway, fresh.toolRef, "/inputSchema/$defs/Assistant");
      expect(JSON.parse(changed.joined)).toMatchObject({
        properties: { recordingEnabled: { type: "boolean" } },
      });
      record("rematerialized", {
        changed: changed.summary,
        stale: toolText(stale),
        staleCall: toolText(staleCall),
        untouchedToolRef: listLogs.toolRef,
      });
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await mkdir(artifactDirectory, { recursive: true });
      const artifact = join(artifactDirectory, "result.json");
      await writeFile(
        artifact,
        `${JSON.stringify(
          {
            failure: failure instanceof Error ? failure.message : failure,
            maximumDescribeBytes,
            passed: failure === null,
            steps,
          },
          null,
          2,
        )}\n`,
      );
      console.info(`Integration schemas E2E artifact: ${artifact}`);
    }
  }, 600_000);
});

interface FoundOperation {
  readonly name: string;
  readonly connectionId: string | null;
  readonly toolRef: string;
}

/** Every operation integration_search finds for the API, page by page. */
async function searchAll(
  gateway: Gateway,
): Promise<{ readonly operations: readonly FoundOperation[]; readonly total: number }> {
  const operations: FoundOperation[] = [];
  let offset: number | null = 0;
  let total = 0;
  while (offset !== null) {
    const page: Json = await gateway.call("integration_search", {
      limit: 20,
      offset,
      query: apiTitle,
    });
    operations.push(...(page.operations as readonly FoundOperation[]));
    total = page.operationTotal as number;
    offset = page.operationNextOffset as number | null;
  }
  for (const found of operations) {
    expect(found.connectionId).toBeNull();
    expect(found).not.toHaveProperty("readiness");
  }
  return { operations, total };
}

/** Proposes the document by its URL, as an agent does, and approves it as its owner. */
async function proposeAndInstall(
  host: MachineAccessHost,
  gateway: Gateway,
): Promise<IntegrationInstallationId> {
  const proposed = await gateway.call("integration_propose", {
    description: "Voice AI agents that answer and place phone calls.",
    kind: "openapi",
    reason: "Manage this person's voice assistants",
    source: `${upstreamOrigin}/openapi.json`,
  });
  expect(proposed).toMatchObject({ status: "pending" });
  await testRpcData(
    host.origin,
    "commands.dispatch",
    {
      idempotencyKey: "integration-schemas-install",
      requestId: RequestIdSchema.parse(proposed.requestId),
      response: { kind: "choice", optionId: "installed" },
      type: "request.respond",
    },
    { headers: host.ownerHeaders },
  );
  const installation = await host.store.database
    .selectFrom("integrationInstallations")
    .select(["id"])
    .where("sourceKind", "=", "proposed")
    .where("status", "=", "active")
    .executeTakeFirstOrThrow();
  return installation.id;
}

interface DescribedPages {
  readonly first: Json;
  readonly joined: string;
  readonly pages: number;
  readonly schemaBytes: number;
  readonly summary: Json;
}

/** Every page of one part, following nextCursor, each answer checked against the bound. */
async function describeAll(
  gateway: Gateway,
  toolRef: string,
  path: string | undefined,
): Promise<DescribedPages> {
  const bodies: string[] = [];
  const boundaries: number[] = [];
  let first: Json | undefined;
  let cursor = 0;
  let largest = 0;
  let schemaBytes = 0;
  const started = performance.now();
  for (;;) {
    const result = await gateway.callRaw("integration_describe", {
      ...(cursor === 0 ? {} : { cursor }),
      ...(path === undefined ? {} : { path }),
      toolRef,
    });
    if (result.isError) throw new Error(`integration_describe refused: ${toolText(result)}`);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toHaveLength(1);
    const text = toolText(result);
    const bytes = Buffer.byteLength(text, "utf8");
    expect(bytes).toBeLessThanOrEqual(maximumDescribeBytes);
    largest = Math.max(largest, bytes);
    const newline = text.indexOf("\n");
    const header = JSON.parse(text.slice(0, newline)) as Json;
    expect(header).toMatchObject({ cursor, toolRef });
    if (first === undefined) first = header;
    else expect(Object.keys(header).sort()).toEqual(continuationKeys(header));
    schemaBytes = header.schemaBytes as number;
    bodies.push(text.slice(newline + 1));
    if (header.nextCursor === null) break;
    expect(header.next).toContain(`cursor ${String(header.nextCursor)}`);
    cursor = header.nextCursor as number;
    boundaries.push(cursor);
  }
  const joined = bodies.join("");
  const joinedBytes = Buffer.from(joined, "utf8");
  expect(joinedBytes.byteLength).toBe(schemaBytes);
  const elapsedMs = Math.round(performance.now() - started);
  return {
    first: first!,
    joined,
    pages: bodies.length,
    schemaBytes,
    summary: {
      // A page that ends just before a multibyte character was cut back from
      // inside it; joining exactly proves no character was split.
      boundariesBeforeMultibyteCharacter: boundaries.filter(
        (boundary) => (joinedBytes[boundary] ?? 0) >= 0x80,
      ).length,
      elapsedMs,
      largestAnswerBytes: largest,
      msPerPage: Math.round(elapsedMs / bodies.length),
      pages: bodies.length,
      path: first!.path,
      schemaBytes,
    },
  };
}

/** A later page names only what it is a page of. */
function continuationKeys(header: Json): readonly string[] {
  return [
    "cursor",
    ...(header.nextCursor === null ? [] : ["next"]),
    "nextCursor",
    "path",
    "schemaBytes",
    "toolRef",
  ];
}

/** What describe must return for a toolRef: the stored schemas, each made standalone. */
async function describedDocument(store: IntegrationPlatformStore, toolRef: string): Promise<Json> {
  const stored = await store.getToolSchemas(IntegrationToolIdSchema.parse(toolRef.split(".")[1]));
  if (!stored) throw new Error("The described tool has no schemas");
  return {
    inputSchema: standaloneToolSchema(stored.inputSchema, stored.definitions),
    outputSchema:
      stored.outputSchema === null
        ? null
        : standaloneToolSchema(stored.outputSchema, stored.definitions),
  };
}

/** What a listing that carried every tool's standalone schemas would have weighed. */
async function schemaCarryingListingBytes(
  store: IntegrationPlatformStore,
  tools: readonly { readonly id: string; readonly status: string }[],
): Promise<number> {
  let total = 0;
  for (const tool of tools) {
    if (tool.status !== "active") continue;
    const stored = await store.getToolSchemas(IntegrationToolIdSchema.parse(tool.id));
    if (!stored) continue;
    total += Buffer.byteLength(
      JSON.stringify({
        inputSchema: standaloneToolSchema(stored.inputSchema, stored.definitions),
        outputSchema:
          stored.outputSchema === null
            ? null
            : standaloneToolSchema(stored.outputSchema, stored.definitions),
      }),
      "utf8",
    );
  }
  return total;
}

async function storedBytes(host: MachineAccessHost, serverId: IntegrationServerId) {
  const definitions = await host.store.database
    .selectFrom("integrationToolDefinitions")
    .select(["definitions"])
    .where("serverId", "=", serverId)
    .execute();
  const tools = await host.store.database
    .selectFrom("integrationTools")
    .select(["inputSchema", "outputSchema"])
    .where("serverId", "=", serverId)
    .execute();
  return {
    definitionBytes: definitions.reduce(
      (sum, row) => sum + Buffer.byteLength(JSON.stringify(row.definitions), "utf8"),
      0,
    ),
    toolSchemaBytes: tools.reduce(
      (sum, row) =>
        sum + Buffer.byteLength(JSON.stringify([row.inputSchema, row.outputSchema]), "utf8"),
      0,
    ),
  };
}

/**
 * Rewrites the server's tools through the store's own writer, as installing
 * the document again does, with the definition `changed` names given one more
 * property.
 */
async function rematerialize(
  host: MachineAccessHost,
  serverId: IntegrationServerId,
  changed: string | null,
): Promise<void> {
  await host.store.database.transaction().execute(async (transaction) => {
    const server = await transaction
      .selectFrom("integrationServers")
      .select(["toolGeneration"])
      .where("id", "=", serverId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const document = await transaction
      .selectFrom("integrationToolDefinitions")
      .select(["definitions"])
      .where("serverId", "=", serverId)
      .where("connectionId", "is", null)
      .executeTakeFirstOrThrow();
    const tools = await transaction
      .selectFrom("integrationTools")
      .select([
        "annotations",
        "connectionId",
        "description",
        "id",
        "inputSchema",
        "name",
        "outputSchema",
        "status",
        "target",
        "title",
      ])
      .where("serverId", "=", serverId)
      .where("connectionId", "is", null)
      .where("status", "=", "active")
      .execute();
    const definition = changed === null ? null : (document.definitions[changed] as Json);
    await replaceServerToolsInTransaction(transaction, {
      catalog: {
        definitions:
          changed === null || definition === null
            ? document.definitions
            : {
                ...document.definitions,
                [changed]: {
                  ...definition,
                  properties: {
                    ...(definition.properties as Json),
                    recordingEnabled: { type: "boolean" },
                  },
                },
              },
        tools: tools.map(({ target, ...tool }) => (target ? { ...tool, target } : tool)),
      },
      now: new Date(),
      serverId: serverId,
    });
    await transaction
      .updateTable("integrationServers")
      .set({ toolGeneration: server.toolGeneration + 1 })
      .where("id", "=", serverId)
      .execute();
  });
}

function jsonKeys(value: unknown, keys = new Set<string>()): ReadonlySet<string> {
  if (Array.isArray(value)) for (const entry of value) jsonKeys(entry, keys);
  else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      keys.add(key);
      jsonKeys(entry, keys);
    }
  }
  return keys;
}

/** Every `$ref` in a schema that does not name one of its own `$defs`. */
function unresolvedReferences(schema: Json): readonly string[] {
  const definitions = (schema.$defs ?? {}) as Json;
  const unresolved: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) for (const entry of value) visit(entry);
    else if (typeof value === "object" && value !== null) {
      const reference = (value as Json).$ref;
      if (
        typeof reference === "string" &&
        !(
          reference.startsWith("#/$defs/") &&
          Object.hasOwn(definitions, reference.slice("#/$defs/".length))
        )
      ) {
        unresolved.push(reference);
      }
      for (const entry of Object.values(value)) visit(entry);
    }
  };
  visit(schema);
  return unresolved;
}

/** The document's component names `roots` reach, read straight from the document. */
function componentClosure(roots: readonly unknown[], schemas: Json): readonly string[] {
  const reached = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) pending.push(...(value as unknown[]));
    else if (typeof value === "object" && value !== null) {
      const reference = (value as Json).$ref;
      if (typeof reference === "string" && reference.startsWith("#/components/schemas/")) {
        const name = reference.slice("#/components/schemas/".length);
        if (!reached.has(name)) {
          reached.add(name);
          pending.push(schemas[name]);
        }
      }
      pending.push(...Object.values(value));
    }
  }
  return [...reached].sort();
}

/** A component as a shared definition: its references re-pointed at `$defs`. */
function hoisted(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value).replaceAll('"#/components/schemas/', '"#/$defs/'),
  ) as unknown;
}

interface SpecOperation {
  /** Where the input schema's references start: the request body and parameters. */
  readonly inputRoots: readonly unknown[];
  readonly operationId: string;
  /** Where the output schema's references start: the success response. */
  readonly outputRoots: readonly unknown[];
}

/**
 * A Vapi-shaped OpenAPI document: two dozen resources whose operations nearly
 * all reach one assistant type, which reaches every model, voice, transcriber,
 * tool and plan, through cycles back to itself. Descriptions carry multibyte
 * text, so page boundaries fall inside characters. Logs reach none of it.
 */
function syntheticVapi() {
  const schemas: Record<string, Json> = {};
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const prose = (subject: string) =>
    `${subject}: how a voice agent uses it, when it applies and what it changes. Ünïcödé — 日本語の説明 ✓ 😀. ${subject} is validated by the service, which says what to fix.`;
  const kinds = (
    prefix: string,
    names: readonly string[],
    properties: (name: string) => Json,
    settings: number,
  ) => {
    for (const name of names)
      schemas[`${name}${prefix}`] = typed(`${name}${prefix}`, properties(name), settings);
    return { oneOf: names.map((name) => ref(`${name}${prefix}`)) };
  };
  function typed(name: string, properties: Json, settings: number): Json {
    return {
      description: prose(name),
      properties: {
        ...properties,
        ...Object.fromEntries(
          Array.from({ length: settings }, (_, index) => [
            `setting${index + 1}`,
            {
              description: prose(`${name} setting ${index + 1}`),
              type: ["number", "string", "boolean"][index % 3],
            },
          ]),
        ),
      },
      type: "object",
    };
  }
  const text = { type: "string" };
  const list = (items: unknown) => ({ items, type: "array" });

  schemas.JsonSchema = {
    description: prose("JsonSchema"),
    properties: {
      description: text,
      enum: list(text),
      items: ref("JsonSchema"),
      properties: { additionalProperties: ref("JsonSchema"), type: "object" },
      required: list(text),
      type: { enum: ["string", "number", "integer", "boolean", "array", "object"], type: "string" },
    },
    type: "object",
  };
  schemas.Server = typed(
    "Server",
    { headers: { additionalProperties: text, type: "object" }, url: text },
    6,
  );
  schemas.Condition = typed(
    "Condition",
    { operator: { enum: ["eq", "neq", "gt", "lt"], type: "string" }, param: text, value: text },
    4,
  );
  const toolMessage = kinds(
    "ToolMessage",
    ["Start", "Complete", "Failed", "Delayed"],
    () => ({ conditions: list(ref("Condition")), content: text }),
    4,
  );
  schemas.ToolMessage = toolMessage;
  schemas.OpenAIFunction = typed(
    "OpenAIFunction",
    { name: text, parameters: ref("JsonSchema") },
    4,
  );
  const toolNames = [
    "Function",
    "TransferCall",
    "EndCall",
    "Dtmf",
    "Query",
    "Sms",
    "Ghl",
    "Make",
    "Bash",
    "Computer",
    "TextEditor",
    "GoogleCalendar",
  ];
  schemas.Tool = kinds(
    "Tool",
    toolNames,
    (name) => ({
      function: ref("OpenAIFunction"),
      messages: list(ref("ToolMessage")),
      server: ref("Server"),
      type: { enum: [name.toLowerCase()], type: "string" },
      ...(name === "TransferCall" ? { destinations: list(ref("TransferDestination")) } : {}),
    }),
    10,
  );
  schemas.ToolCall = typed("ToolCall", { function: ref("OpenAIFunction"), id: text }, 3);
  schemas.Message = kinds(
    "Message",
    ["System", "User", "Assistant", "ToolCall"],
    (name) => ({
      content: text,
      role: { enum: [name.toLowerCase()], type: "string" },
      ...(name === "Assistant" ? { toolCalls: list(ref("ToolCall")) } : {}),
    }),
    5,
  );
  schemas.KnowledgeBase = typed(
    "KnowledgeBase",
    { fileIds: list(text), provider: text, server: ref("Server") },
    6,
  );
  const models = [
    "OpenAI",
    "Anthropic",
    "Google",
    "Groq",
    "Together",
    "Anyscale",
    "OpenRouter",
    "Perplexity",
    "DeepInfra",
    "Custom",
    "Xai",
    "Cerebras",
    "DeepSeek",
    "InflectionAi",
    "Vapi",
    "Azure",
  ];
  schemas.Model = kinds(
    "Model",
    models,
    (name) => ({
      knowledgeBase: ref("KnowledgeBase"),
      maxTokens: { type: "integer" },
      messages: list(ref("Message")),
      model: {
        enum: Array.from({ length: 24 }, (_, index) => `${name.toLowerCase()}-model-${index + 1}`),
        type: "string",
      },
      provider: { enum: [name.toLowerCase()], type: "string" },
      temperature: { type: "number" },
      toolIds: list(text),
      tools: list(ref("Tool")),
    }),
    16,
  );
  schemas.Replacement = kinds(
    "Replacement",
    ["Exact", "Regex"],
    () => ({ key: text, value: text }),
    3,
  );
  schemas.FormatPlan = typed("FormatPlan", { replacements: list(ref("Replacement")) }, 4);
  schemas.ChunkPlan = typed("ChunkPlan", { formatPlan: ref("FormatPlan") }, 5);
  const voices = [
    "ElevenLabs",
    "Azure",
    "Cartesia",
    "Deepgram",
    "LMNT",
    "Neets",
    "OpenAI",
    "PlayHT",
    "RimeAI",
    "SmallestAI",
    "Tavus",
    "Hume",
    "Inworld",
    "Minimax",
  ];
  schemas.Voice = kinds(
    "Voice",
    voices,
    (name) => ({
      chunkPlan: ref("ChunkPlan"),
      fallbackPlan: ref("FallbackPlan"),
      provider: { enum: [name.toLowerCase()], type: "string" },
      voiceId: text,
    }),
    12,
  );
  schemas.FallbackPlan = typed("FallbackPlan", { voices: list(ref("Voice")) }, 3);
  const languages = Array.from({ length: 40 }, (_, index) => `language-${index + 1}`);
  const transcribers = [
    "Deepgram",
    "Gladia",
    "Speechmatics",
    "Talkscriber",
    "Azure",
    "Google",
    "OpenAI",
    "Cartesia",
    "AssemblyAI",
    "Custom",
  ];
  schemas.Transcriber = kinds(
    "Transcriber",
    transcribers,
    (name) => ({
      fallbackPlan: ref("TranscriberFallbackPlan"),
      language: { enum: languages, type: "string" },
      provider: { enum: [name.toLowerCase()], type: "string" },
    }),
    10,
  );
  schemas.TranscriberFallbackPlan = typed(
    "TranscriberFallbackPlan",
    { transcribers: list(ref("Transcriber")) },
    3,
  );
  const credentials = Array.from({ length: 20 }, (_, index) => `Provider${index + 1}`);
  schemas.Credential = kinds("Credential", credentials, () => ({ apiKey: text, name: text }), 5);
  schemas.SummaryPlan = typed("SummaryPlan", { messages: list(ref("Message")) }, 4);
  schemas.StructuredDataPlan = typed(
    "StructuredDataPlan",
    { messages: list(ref("Message")), schema: ref("JsonSchema") },
    4,
  );
  schemas.SuccessEvaluationPlan = typed(
    "SuccessEvaluationPlan",
    { messages: list(ref("Message")), rubric: text },
    4,
  );
  schemas.AnalysisPlan = typed(
    "AnalysisPlan",
    {
      structuredDataPlan: ref("StructuredDataPlan"),
      successEvaluationPlan: ref("SuccessEvaluationPlan"),
      summaryPlan: ref("SummaryPlan"),
    },
    4,
  );
  for (const plan of [
    "ArtifactPlan",
    "MessagePlan",
    "StartSpeakingPlan",
    "StopSpeakingPlan",
    "MonitorPlan",
    "CompliancePlan",
    "KeypadInputPlan",
    "BackgroundSpeechDenoisingPlan",
  ]) {
    schemas[plan] = typed(plan, { conditions: list(ref("Condition")) }, 8);
  }
  schemas.VoicemailDetection = kinds(
    "VoicemailDetection",
    ["Google", "OpenAI", "Twilio", "Vapi"],
    () => ({ provider: text }),
    6,
  );
  schemas.TransferDestination = kinds(
    "Destination",
    ["Number", "Sip", "Assistant"],
    (name) => ({
      message: text,
      ...(name === "Assistant" ? { assistant: ref("Assistant") } : { number: text }),
    }),
    6,
  );
  schemas.HookAction = kinds(
    "HookAction",
    ["Say", "ToolCall", "Transfer"],
    (name) => ({
      ...(name === "ToolCall" ? { tool: ref("Tool") } : {}),
      ...(name === "Transfer" ? { destination: ref("TransferDestination") } : { exact: text }),
    }),
    4,
  );
  schemas.Hook = typed(
    "Hook",
    {
      do: list(ref("HookAction")),
      on: { enum: ["call.ending", "customer.speech.timeout"], type: "string" },
    },
    3,
  );
  const assistantProperties = {
    analysisPlan: ref("AnalysisPlan"),
    artifactPlan: ref("ArtifactPlan"),
    backgroundSpeechDenoisingPlan: ref("BackgroundSpeechDenoisingPlan"),
    compliancePlan: ref("CompliancePlan"),
    credentials: list(ref("Credential")),
    firstMessage: text,
    hooks: list(ref("Hook")),
    keypadInputPlan: ref("KeypadInputPlan"),
    messagePlan: ref("MessagePlan"),
    model: ref("Model"),
    monitorPlan: ref("MonitorPlan"),
    name: text,
    server: ref("Server"),
    startSpeakingPlan: ref("StartSpeakingPlan"),
    stopSpeakingPlan: ref("StopSpeakingPlan"),
    transcriber: ref("Transcriber"),
    voice: ref("Voice"),
    voicemailDetection: ref("VoicemailDetection"),
  };
  const identity = { createdAt: text, id: text, orgId: text, updatedAt: text };
  schemas.Assistant = typed("Assistant", { ...assistantProperties, ...identity }, 20);
  schemas.CreateAssistantDTO = {
    ...typed("CreateAssistantDTO", assistantProperties, 20),
    additionalProperties: false,
    required: ["name"],
  };
  schemas.UpdateAssistantDTO = typed("UpdateAssistantDTO", assistantProperties, 20);
  schemas.AssistantOverrides = typed("AssistantOverrides", assistantProperties, 10);
  schemas.SquadMember = typed(
    "SquadMember",
    {
      assistant: ref("Assistant"),
      assistantDestinations: list(ref("TransferDestination")),
      assistantOverrides: ref("AssistantOverrides"),
    },
    4,
  );
  schemas.WorkflowNode = kinds(
    "Node",
    ["Conversation", "Tool"],
    (name) =>
      name === "Tool"
        ? { tool: ref("Tool") }
        : { model: ref("Model"), transcriber: ref("Transcriber"), voice: ref("Voice") },
    6,
  );
  schemas.Edge = typed("Edge", { condition: ref("Condition"), from: text, to: text }, 3);
  schemas.Customer = typed("Customer", { name: text, number: text }, 6);
  schemas.PhoneNumberProvider = kinds(
    "PhoneNumber",
    ["Twilio", "Vonage", "Telnyx", "Vapi", "ByoSip"],
    () => ({ number: text, server: ref("Server") }),
    6,
  );
  schemas.Cost = kinds(
    "Cost",
    [
      "Model",
      "Voice",
      "Transcriber",
      "Transport",
      "Analysis",
      "Vapi",
      "VoicemailDetection",
      "Knowledge",
    ],
    () => ({ amount: { type: "number" } }),
    3,
  );
  schemas.Artifact = typed("Artifact", { messages: list(ref("Message")), recordingUrl: text }, 6);
  const resource = (name: string, properties: Json) => {
    schemas[name] = typed(name, { ...properties, ...identity }, 10);
    schemas[`Create${name}DTO`] = typed(`Create${name}DTO`, properties, 6);
    schemas[`Update${name}DTO`] = typed(`Update${name}DTO`, properties, 6);
  };
  resource("Squad", { members: list(ref("SquadMember")), name: text });
  resource("Workflow", { edges: list(ref("Edge")), name: text, nodes: list(ref("WorkflowNode")) });
  resource("Call", {
    analysis: ref("AnalysisPlan"),
    artifact: ref("Artifact"),
    assistant: ref("Assistant"),
    costs: list(ref("Cost")),
    customer: ref("Customer"),
    phoneNumber: ref("PhoneNumberProvider"),
    squad: ref("Squad"),
    workflow: ref("Workflow"),
  });
  const generic = [
    "PhoneNumber",
    "File",
    "KnowledgeBaseResource",
    "CredentialResource",
    "Chat",
    "Session",
    "Campaign",
    "StructuredOutput",
    "Eval",
    "TestSuite",
    "TestSuiteRun",
    "Insight",
    "Report",
    "Template",
    "ProviderResource",
    "ObservabilityPlan",
    "Analytics",
    "Org",
    "ToolResource",
  ];
  for (const name of generic)
    resource(name, { assistant: ref("Assistant"), call: ref("Call"), name: text });
  resource("Log", {
    level: { enum: ["debug", "info", "warn", "error"], type: "string" },
    message: text,
  });

  const paths: Record<string, Record<string, Json>> = {};
  const operations: SpecOperation[] = [];
  const add = (
    path: string,
    method: string,
    operation: Json,
    inputRoots: readonly unknown[],
    outputRoots: readonly unknown[],
  ) => {
    (paths[path] ??= {})[method] = operation;
    operations.push({ inputRoots, operationId: operation.operationId as string, outputRoots });
  };
  const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/gu, "$1-$2").toLowerCase();
  const idParameter = { in: "path", name: "id", required: true, schema: text };
  for (const name of ["Assistant", "Squad", "Workflow", "Call", ...generic, "Log"]) {
    const path = `/${kebab(name)}`;
    const tags = [`${name}s`];
    const single = {
      content: { "application/json": { schema: ref(name) } },
      description: "The resource",
    };
    const body = (dto: string) => ({
      content: { "application/json": { schema: ref(dto) } },
      required: true,
    });
    const listParameters = [
      { in: "query", name: "limit", schema: { type: "integer" } },
      { in: "query", name: "createdAtGt", schema: { format: "date-time", type: "string" } },
    ];
    add(
      path,
      "post",
      {
        operationId: `create${name}`,
        requestBody: body(`Create${name}DTO`),
        responses: { 201: single },
        summary: `Create ${name}`,
        tags,
      },
      [ref(`Create${name}DTO`)],
      [ref(name)],
    );
    add(
      path,
      "get",
      {
        operationId: `list${name}s`,
        parameters: listParameters,
        responses: {
          200: {
            content: { "application/json": { schema: list(ref(name)) } },
            description: "The resources",
          },
        },
        summary: `List ${name}s`,
        tags,
      },
      listParameters.map(({ schema }) => schema),
      [list(ref(name))],
    );
    add(
      `${path}/{id}`,
      "get",
      {
        operationId: `get${name}`,
        parameters: [idParameter],
        responses: { 200: single },
        summary: `Get ${name}`,
        tags,
      },
      [text],
      [ref(name)],
    );
    add(
      `${path}/{id}`,
      "patch",
      {
        operationId: `update${name}`,
        parameters: [idParameter],
        requestBody: body(`Update${name}DTO`),
        responses: { 200: single },
        summary: `Update ${name}`,
        tags,
      },
      [text, ref(`Update${name}DTO`)],
      [ref(name)],
    );
    add(
      `${path}/{id}`,
      "delete",
      {
        operationId: `delete${name}`,
        parameters: [idParameter],
        responses: { 200: single },
        summary: `Delete ${name}`,
        tags,
      },
      [text],
      [ref(name)],
    );
  }
  const document = {
    components: { schemas },
    info: { title: apiTitle, version: "1.0.0" },
    openapi: "3.1.0",
    paths,
    servers: [{ url: upstreamOrigin }],
  };
  return { document, operations, schemas: schemas as Json };
}
