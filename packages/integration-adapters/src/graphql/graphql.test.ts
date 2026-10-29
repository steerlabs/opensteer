import { describe, expect, it, vi } from "vitest";
import { integrationSchemaDigest } from "@opensteer/integration-core/digest";
import { definitionClosure, standaloneToolSchema } from "@opensteer/integration-core/tool-schemas";
import { createGraphqlAdapter, graphqlAdapter } from "./adapter.js";

const scalar = (name: string) => ({ kind: "SCALAR", name, ofType: null });
const nonNull = (ofType: unknown) => ({ kind: "NON_NULL", name: null, ofType });

const introspection = {
  __schema: {
    queryType: { name: "Query" },
    mutationType: { name: "Mutation" },
    types: [
      {
        kind: "OBJECT",
        name: "Query",
        description: null,
        inputFields: null,
        enumValues: null,
        fields: [
          {
            name: "user",
            description: "Find a user",
            args: [
              {
                name: "id",
                description: null,
                defaultValue: null,
                type: nonNull(scalar("ID")),
              },
              {
                name: "filter",
                description: null,
                defaultValue: null,
                type: { kind: "INPUT_OBJECT", name: "UserFilter", ofType: null },
              },
            ],
            type: { kind: "OBJECT", name: "User", ofType: null },
          },
        ],
      },
      {
        kind: "OBJECT",
        name: "Mutation",
        description: null,
        inputFields: null,
        enumValues: null,
        fields: [
          {
            name: "createUser",
            description: "Create a user",
            args: [
              {
                name: "input",
                description: null,
                defaultValue: null,
                type: nonNull({ kind: "INPUT_OBJECT", name: "NewUser", ofType: null }),
              },
            ],
            type: { kind: "OBJECT", name: "User", ofType: null },
          },
        ],
      },
      {
        kind: "OBJECT",
        name: "User",
        description: null,
        inputFields: null,
        enumValues: null,
        fields: [
          { name: "id", description: null, args: [], type: scalar("ID") },
          { name: "name", description: null, args: [], type: scalar("String") },
          {
            name: "friends",
            description: null,
            args: [],
            type: {
              kind: "LIST",
              name: null,
              ofType: { kind: "OBJECT", name: "User", ofType: null },
            },
          },
        ],
      },
      {
        kind: "INPUT_OBJECT",
        name: "UserFilter",
        description: null,
        fields: null,
        enumValues: null,
        inputFields: [
          {
            name: "role",
            description: null,
            defaultValue: null,
            type: { kind: "ENUM", name: "Role", ofType: null },
          },
        ],
      },
      {
        kind: "INPUT_OBJECT",
        name: "NewUser",
        description: null,
        fields: null,
        enumValues: null,
        inputFields: [
          {
            name: "name",
            description: null,
            defaultValue: null,
            type: nonNull(scalar("String")),
          },
        ],
      },
      {
        kind: "ENUM",
        name: "Role",
        description: null,
        fields: null,
        inputFields: null,
        enumValues: [
          { name: "ADMIN", description: null },
          { name: "MEMBER", description: null },
        ],
      },
    ],
  },
};

const named = (kind: string, name: string) => ({ kind, name, ofType: null });
const list = (ofType: unknown) => ({ kind: "LIST", name: null, ofType });
const value = (name: string, type: unknown, defaultValue: string | null = null) => ({
  name,
  type,
  defaultValue,
});
const field = (name: string, type: unknown, args: readonly unknown[] = []) => ({
  name,
  type,
  args,
});

const directoryIntrospection = {
  __schema: {
    queryType: { name: "Query" },
    mutationType: { name: "Mutation" },
    types: [
      {
        kind: "OBJECT",
        name: "Query",
        fields: [
          field("user", named("OBJECT", "User"), [
            value("id", nonNull(named("SCALAR", "ID"))),
            value("filter", named("INPUT_OBJECT", "UserFilter")),
          ]),
          field("users", list(named("OBJECT", "User")), [
            value("first", named("SCALAR", "Int"), "10"),
            value("where", named("INPUT_OBJECT", "UserWhere")),
            value("orderBy", list(nonNull(named("INPUT_OBJECT", "UserOrder")))),
          ]),
          field("search", list(named("UNION", "SearchResult")), [
            value("term", nonNull(named("SCALAR", "String"))),
          ]),
          field("__internal", named("SCALAR", "String")),
        ],
      },
      {
        kind: "OBJECT",
        name: "Mutation",
        fields: [
          field("createUser", named("OBJECT", "User"), [
            value("input", nonNull(named("INPUT_OBJECT", "NewUser"))),
          ]),
          field("updateUser", named("OBJECT", "User"), [
            value("id", nonNull(named("SCALAR", "ID"))),
            value("input", nonNull(named("INPUT_OBJECT", "UserPatch"))),
          ]),
          field("ping", named("SCALAR", "Boolean")),
        ],
      },
      {
        kind: "OBJECT",
        name: "User",
        fields: [
          field("id", named("SCALAR", "ID")),
          field("name", named("SCALAR", "String")),
          field("role", named("ENUM", "Role")),
          field("createdAt", named("SCALAR", "DateTime")),
          field("friends", list(named("OBJECT", "User"))),
        ],
      },
      { kind: "UNION", name: "SearchResult" },
      { kind: "SCALAR", name: "DateTime" },
      {
        kind: "INPUT_OBJECT",
        name: "UserFilter",
        inputFields: [
          value("role", named("ENUM", "Role")),
          value("and", list(nonNull(named("INPUT_OBJECT", "UserFilter")))),
        ],
      },
      {
        kind: "INPUT_OBJECT",
        name: "UserWhere",
        inputFields: [
          value("filter", named("INPUT_OBJECT", "UserFilter")),
          value("createdAfter", named("SCALAR", "DateTime")),
        ],
      },
      {
        kind: "INPUT_OBJECT",
        name: "UserOrder",
        inputFields: [
          value("field", nonNull(named("ENUM", "UserOrderField"))),
          value("direction", named("ENUM", "Direction"), "ASC"),
        ],
      },
      {
        kind: "INPUT_OBJECT",
        name: "NewUser",
        inputFields: [
          value("name", nonNull(named("SCALAR", "String"))),
          value("role", named("ENUM", "Role")),
          value("address", named("INPUT_OBJECT", "AddressInput")),
        ],
      },
      {
        kind: "INPUT_OBJECT",
        name: "UserPatch",
        inputFields: [
          value("name", named("SCALAR", "String")),
          value("address", named("INPUT_OBJECT", "AddressInput")),
        ],
      },
      {
        kind: "INPUT_OBJECT",
        name: "AddressInput",
        inputFields: [
          value("city", named("SCALAR", "String")),
          value("country", nonNull(named("ENUM", "CountryCode"))),
        ],
      },
      { kind: "INPUT_OBJECT", name: "Orphan", inputFields: [value("x", named("SCALAR", "Int"))] },
      { kind: "ENUM", name: "Role", enumValues: [{ name: "ADMIN" }, { name: "MEMBER" }] },
      { kind: "ENUM", name: "Direction", enumValues: [{ name: "ASC" }, { name: "DESC" }] },
      {
        kind: "ENUM",
        name: "UserOrderField",
        enumValues: [{ name: "NAME" }, { name: "CREATED_AT" }],
      },
      { kind: "ENUM", name: "CountryCode", enumValues: [{ name: "US" }, { name: "KR" }] },
    ],
  },
};

/** What the adapter stored for `directoryIntrospection` before definitions were shared: each
 * tool's self-contained `{ inputSchema, outputSchema }` digest, computed by the previous release. */
const selfContainedDigests = {
  "mutation.createUser": "q49cjz8ORFYqh0voBMnnz0AGkE49MCXzg7YHad1_cjc",
  "mutation.ping": "kN87ul-0um5WqyBPUwo88oPryyaUgZmy2JqHvJvPG-Q",
  "mutation.updateUser": "bffP1C8ODoTSbFcCSj8AHRUKVX0UFTxuGwqqKuTAt7Y",
  "query.search": "zyaF7BJd23SdHi18fqGyo5WHo_jegDDmyojGXbrj9TU",
  "query.user": "_Dmf8AA0TXtLG4cS0jC506YYid5y3zzv0Nx0PNB2-9w",
  "query.users": "GPEPdnOJuWdCTXsTuwXYbIrtIIoc0zzXvlD60ynZDiQ",
};

function recordingAdapter() {
  const sent: { query: string; variables?: unknown }[] = [];
  const fetch_ = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as { query: string; variables?: unknown });
    return Response.json({ data: { ok: true } });
  });
  return { adapter: createGraphqlAdapter(fetch_), fetch: fetch_, sent };
}

const config = {
  endpoint: "https://graphql.example/api",
  introspection,
  healthCheck: {
    accountIdentifierPath: "data.viewer.email",
    query: "query Health { viewer { id name email organization { id } } }",
    identityPath: "data.viewer.id",
    displayNamePath: "data.viewer.name",
    tenantPath: "data.viewer.organization.id",
  },
};

describe("GraphQL adapter", () => {
  it("turns top-level queries/mutations into tools with shared definitions", async () => {
    const { definitions, tools } = await graphqlAdapter.resolveTools({ config });
    expect(tools.map((tool) => tool.name)).toEqual(["query.user", "mutation.createUser"]);
    expect(tools[0]).toMatchObject({
      annotations: { destructiveHint: false, readOnlyHint: true },
      inputSchema: { properties: { filter: { $ref: "#/$defs/UserFilter" } } },
    });
    expect(tools[0]?.inputSchema).not.toHaveProperty("$defs");
    expect(definitions).toMatchObject({
      NewUser: { type: "object" },
      Role: { enum: ["ADMIN", "MEMBER"] },
      UserFilter: { type: "object" },
    });
    expect(definitionClosure([tools[0]?.inputSchema], definitions)).toEqual(["Role", "UserFilter"]);
    expect(tools[1]?.annotations).toEqual({ readOnlyHint: false });
  });

  it("snapshots only admitted operations and their reachable GraphQL types", async () => {
    const snapshot = await graphqlAdapter.snapshotConfig({
      ...config,
      operationFilter: { include: ["query.user"] },
    });
    await expect(graphqlAdapter.resolveTools({ config: snapshot })).resolves.toMatchObject({
      tools: [{ name: "query.user" }],
    });
    const schema = (snapshot.introspection as typeof introspection).__schema;
    expect(schema.types.map(({ name }) => name)).not.toContain("NewUser");
    expect(schema.types.find(({ name }) => name === "Mutation")?.fields).toEqual([]);
  });

  it("runs config -> resolve -> invoke with variables, selection, and auth placements", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        expect(url.searchParams.get("team")).toBe("workspace");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
        const body = JSON.parse(String(init?.body)) as { query: string; variables: unknown };
        expect(body.query).toContain(
          "user(id: $id, filter: $filter) { id name friends { id }\n} }",
        );
        expect(body.variables).toEqual({ id: "user-1", filter: { role: "ADMIN" } });
        return new Response(JSON.stringify({ data: { user: { id: "user-1", name: "Ada" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    await expect(
      graphqlAdapter.invokeTool({
        config,
        toolName: "query.user",
        args: { id: "user-1", filter: { role: "ADMIN" }, select: "id name friends { id }" },
        credentialValues: { token: "token", workspace: "workspace" },
        placements: [
          { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "token" },
          { carrier: "query", name: "team", variable: "workspace" },
        ],
      }),
    ).resolves.toEqual({ kind: "ok", value: { user: { id: "user-1", name: "Ada" } } });
  });

  it.each([
    [401, {}, "connection_rejected"],
    [403, { "www-authenticate": 'Bearer error="insufficient_scope"' }, "oauth_scope_insufficient"],
    [500, {}, "upstream_http_error"],
  ] as const)("maps HTTP %s", async (status, headers, code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status, headers })),
    );
    await expect(
      graphqlAdapter.invokeTool({
        config,
        toolName: "query.user",
        args: { id: "1" },
        credentialValues: {},
        placements: [],
      }),
    ).resolves.toMatchObject({ kind: "error", code });
  });

  it("maps GraphQL errors, invalid input, and timeouts", async () => {
    await expect(
      graphqlAdapter.invokeTool({
        config,
        toolName: "query.user",
        args: { id: "1", limit: 5 },
        credentialValues: {},
        placements: [],
      }),
    ).resolves.toMatchObject({ kind: "error", code: "invalid_arguments" });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ errors: [{ message: "bad" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(
      graphqlAdapter.invokeTool({
        config,
        toolName: "query.user",
        args: { id: "1" },
        credentialValues: {},
        placements: [],
      }),
    ).resolves.toMatchObject({ kind: "error", code: "upstream_http_error" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("timed out", "AbortError");
      }),
    );
    await expect(
      graphqlAdapter.invokeTool({
        config,
        toolName: "query.user",
        args: { id: "1" },
        credentialValues: {},
        placements: [],
      }),
    ).resolves.toMatchObject({ kind: "error", code: "upstream_timeout" });
  });

  it("checks health and extracts identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                viewer: {
                  email: "lin@example.com",
                  id: "u1",
                  name: "Lin",
                  organization: { id: "o1" },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    await expect(
      graphqlAdapter.checkHealth({ config, credentialValues: {}, placements: [] }),
    ).resolves.toEqual({
      healthy: true,
      identity: {
        accountIdentifier: "lin@example.com",
        displayName: "Lin",
        externalIdentityId: "u1",
        externalTenantId: "o1",
      },
    });
  });
});

describe("GraphQL argument containment", () => {
  const invoke = (
    adapter: ReturnType<typeof createGraphqlAdapter>,
    args: Readonly<Record<string, unknown>>,
    toolName = "query.user",
  ) => adapter.invokeTool({ args, config, credentialValues: {}, placements: [], toolName });

  it("refuses an argument the field does not take", async () => {
    const { adapter, fetch } = recordingAdapter();
    const result = await invoke(adapter, { id: "1", role: "ADMIN" });
    expect(result).toMatchObject({ kind: "error", code: "invalid_arguments" });
    const message = result.kind === "error" ? result.message : "";
    expect(message).toContain("role");
    expect(message).toContain("id, filter, select");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a select that is not text", async () => {
    const { adapter, fetch } = recordingAdapter();
    await expect(invoke(adapter, { id: "1", select: ["id"] })).resolves.toMatchObject({
      kind: "error",
      code: "invalid_arguments",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "id } otherRoot { secret",
    "id } } query Other { secret",
    "id } } mutation Drop { dropAll }",
    "}",
    "id { name",
    'friends(after: "\\\\") } other { secret',
    "id # {\n } other { secret",
    "id # hidden\r} other { secret",
    'friends(after: "abc',
    'friends(after: "a\n} other { x") { id }',
    'friends(after: "\\\n") } other { x',
    'friends(after: """abc',
    'friends(after: """a\\""" } b) { x',
  ])("refuses a select that would leave the root field: %j", async (select) => {
    const { adapter, fetch } = recordingAdapter();
    await expect(invoke(adapter, { id: "1", select })).resolves.toMatchObject({
      kind: "error",
      code: "invalid_arguments",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'friends(after: "}") { id }',
    'friends(after: "\\" }") { id }',
    'friends(after: "") { id }',
    'friends(after: """ } """) { id }',
    'friends(after: """ \\""" } """) { id }',
    'friends(after: """""") { id }',
    "id # }\n name",
    "id # a trailing comment",
    "... on User { id }",
  ])("sends a select that stays inside the root field: %j", async (select) => {
    const { adapter, sent } = recordingAdapter();
    await expect(invoke(adapter, { id: "1", select })).resolves.toMatchObject({ kind: "ok" });
    expect(sent[0]?.query).toBe(
      `query User($id: ID!, $filter: UserFilter) { user(id: $id, filter: $filter) { ${select}\n} }`,
    );
  });
});

describe("GraphQL operation naming", () => {
  const directoryConfig = {
    endpoint: "https://graphql.example/api",
    introspection: directoryIntrospection,
  };

  it.each([
    [
      undefined,
      [
        "query.user",
        "query.users",
        "query.search",
        "mutation.createUser",
        "mutation.updateUser",
        "mutation.ping",
      ],
    ],
    [
      ["query.user", "createUser", "ping"],
      ["query.user", "mutation.createUser", "mutation.ping"],
    ],
  ])("invokes exactly the field each listed tool names (include %j)", async (include, names) => {
    const config = { ...directoryConfig, ...(include ? { operationFilter: { include } } : {}) };
    const { adapter, sent } = recordingAdapter();
    const { tools } = await adapter.resolveTools({ config });
    expect(tools.map(({ name }) => name)).toEqual(names);
    for (const tool of tools) {
      const [kind, field] = tool.name.split(".") as [string, string];
      await expect(
        adapter.invokeTool({
          args: {},
          config,
          credentialValues: {},
          placements: [],
          toolName: tool.name,
        }),
      ).resolves.toMatchObject({ kind: "ok" });
      expect(sent.at(-1)?.query).toMatch(
        new RegExp(`^${kind} \\w+(?:\\([^)]*\\))? \\{ ${field}\\b`, "u"),
      );
    }
  });

  it.each([
    ["query.__internal", undefined],
    ["subscription.user", undefined],
    ["mutation.user", undefined],
    ["user", undefined],
    ["query.", undefined],
    ["query.user.id", undefined],
    ["query.users", ["query.user"]],
  ])("refuses %s, which the admitted fields do not name", async (toolName, include) => {
    const { adapter, fetch } = recordingAdapter();
    await expect(
      adapter.invokeTool({
        args: {},
        config: { ...directoryConfig, ...(include ? { operationFilter: { include } } : {}) },
        credentialValues: {},
        placements: [],
        toolName,
      }),
    ).resolves.toMatchObject({
      kind: "error",
      code: "invalid_arguments",
      message: `Unknown GraphQL tool "${toolName}"`,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("describes every tool exactly as the self-contained schemas stored before", async () => {
    const { definitions, tools } = await graphqlAdapter.resolveTools({ config: directoryConfig });
    const described = Object.fromEntries(
      tools.map((tool) => {
        expect(tool.inputSchema).not.toHaveProperty("$defs");
        return [
          tool.name,
          integrationSchemaDigest({
            inputSchema: standaloneToolSchema(tool.inputSchema, definitions),
            outputSchema: tool.outputSchema ?? null,
          }),
        ] as const;
      }),
    );
    expect(described).toEqual(selfContainedDigests);
    expect(Object.keys(definitions)).toContain("Orphan");
  });
});
