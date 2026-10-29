import { describe, expect, it, vi } from "vitest";
import { integrationSchemaDigest } from "@opensteer/integration-core/digest";
import { definitionClosure, standaloneToolSchema } from "@opensteer/integration-core/tool-schemas";
import type { IntegrationAdapter } from "@opensteer/integration-core";
import { createOpenApiAdapter, openApiAdapter } from "./adapter.js";
import { OpenApiAdapterConfigSchema } from "./config.js";
import { applySpecOverrides } from "./spec-overrides.js";

const spec = {
  openapi: "3.1.0",
  info: { title: "Pets", version: "1" },
  servers: [{ url: "https://api.example/v1" }],
  security: [{ oauth: ["pets.read"] }],
  paths: {
    "/pets/{petId}": {
      parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
      get: {
        operationId: "pets.get",
        tags: ["pets"],
        parameters: [
          {
            name: "fields",
            in: "query",
            style: "form",
            explode: false,
            schema: { type: "array", items: { type: "string" } },
          },
          { name: "x-mode", in: "header", schema: { type: "string" } },
          { name: "api_key", in: "query", schema: { type: "string" } },
          {
            name: "target",
            in: "query",
            allowReserved: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Pet",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
          },
        },
      },
    },
    "/pets": {
      post: {
        operationId: "pets.create",
        tags: ["pets"],
        security: [{ oauth: ["pets.write"] }, { oauth: ["pets.admin"] }],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/NewPet" } },
            "application/x-www-form-urlencoded": {
              schema: { $ref: "#/components/schemas/NewPet" },
              encoding: { labels: { style: "form", explode: false } },
            },
          },
        },
        responses: { "201": { description: "Created" } },
      },
    },
    "/uploads": {
      post: {
        operationId: "pets.upload",
        tags: ["pets"],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: { type: "object" },
              encoding: { file: { contentType: "image/png" } },
            },
          },
        },
        responses: { "200": { description: "Uploaded" } },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: "object",
        required: ["id", "name"],
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
      NewPet: {
        type: "object",
        required: ["name"],
        properties: {
          friend: { $ref: "#/components/schemas/Pet" },
          name: { type: "string" },
        },
      },
      Unused: { type: "object", properties: { ignored: { type: "boolean" } } },
    },
  },
} as const;

const billingSpec = {
  openapi: "3.1.0",
  info: { title: "Billing", version: "2" },
  servers: [{ url: "https://billing.example/v2" }],
  paths: {
    "/customers": {
      get: {
        operationId: "listCustomers",
        tags: ["customers"],
        parameters: [
          { $ref: "#/components/parameters/Limit" },
          { $ref: "#/components/parameters/Cursor" },
          { name: "status", in: "query", schema: { $ref: "#/components/schemas/CustomerStatus" } },
        ],
        responses: {
          "200": {
            description: "Page",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/CustomerPage" } },
            },
          },
          default: { $ref: "#/components/responses/Error" },
        },
      },
      post: {
        operationId: "createCustomer",
        tags: ["customers"],
        requestBody: { $ref: "#/components/requestBodies/CustomerInput" },
        responses: {
          "201": {
            description: "Created",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Customer" } } },
          },
        },
      },
    },
    "/customers/{customerId}": {
      parameters: [{ $ref: "#/components/parameters/CustomerId" }],
      get: {
        operationId: "getCustomer",
        tags: ["customers"],
        responses: { "200": { $ref: "#/components/responses/CustomerResponse" } },
      },
      patch: {
        operationId: "updateCustomer",
        tags: ["customers"],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/CustomerUpdate" } },
            "application/merge-patch+json": {
              schema: { $ref: "#/components/schemas/CustomerUpdate" },
            },
          },
        },
        responses: { "200": { $ref: "#/components/responses/CustomerResponse" } },
      },
      delete: {
        operationId: "deleteCustomer",
        tags: ["customers"],
        responses: { "204": { description: "Deleted" } },
      },
    },
    "/customers/{customerId}/invoices": {
      parameters: [{ $ref: "#/components/parameters/CustomerId" }],
      get: {
        operationId: "listCustomerInvoices",
        tags: ["invoices"],
        parameters: [{ $ref: "#/components/parameters/Limit" }],
        responses: {
          "200": {
            description: "Invoices",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/Invoice" } },
                    next: { type: ["string", "null"] },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/invoices": {
      post: {
        operationId: "createInvoice",
        tags: ["invoices"],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/InvoiceInput" } },
          },
        },
        responses: {
          "201": {
            description: "Invoice",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Invoice" } } },
          },
        },
      },
    },
    "/invoices/{invoiceId}/pay": {
      post: {
        operationId: "payInvoice",
        tags: ["invoices"],
        parameters: [
          { name: "invoiceId", in: "path", required: true, schema: { type: "string" } },
          { name: "Idempotency-Key", in: "header", schema: { type: "string", format: "uuid" } },
        ],
        requestBody: {
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                properties: {
                  amount: { $ref: "#/components/schemas/Money" },
                  source: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Paid",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Invoice" } } },
          },
        },
      },
    },
    "/files": {
      post: {
        operationId: "uploadFile",
        tags: ["files"],
        summary: "Upload a file",
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["file"],
                properties: {
                  file: { type: "string", format: "binary" },
                  purpose: { $ref: "#/components/schemas/FilePurpose" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "File",
            content: { "application/json": { schema: { $ref: "#/components/schemas/File" } } },
          },
        },
      },
    },
    "/health": {
      get: {
        responses: {
          "200": { description: "OK", content: { "text/plain": { schema: { type: "string" } } } },
        },
      },
    },
  },
  components: {
    parameters: {
      CustomerId: {
        name: "customerId",
        in: "path",
        required: true,
        schema: { type: "string", pattern: "^cus_" },
      },
      Cursor: { name: "starting_after", in: "query", schema: { type: "string" } },
      Limit: {
        name: "limit",
        in: "query",
        description: "Page size",
        schema: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    requestBodies: {
      CustomerInput: {
        required: true,
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/CustomerInput" } },
        },
      },
    },
    responses: {
      CustomerResponse: {
        description: "Customer",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Customer" } } },
      },
      Error: {
        description: "Error",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
    },
    schemas: {
      Address: {
        type: "object",
        properties: {
          city: { type: "string" },
          country: { type: "string", minLength: 2, maxLength: 2 },
          line1: { type: "string" },
        },
      },
      Customer: {
        type: "object",
        required: ["id"],
        properties: {
          address: { $ref: "#/components/schemas/Address" },
          balance: { $ref: "#/components/schemas/Money" },
          id: { type: "string" },
          referredBy: { anyOf: [{ $ref: "#/components/schemas/Customer" }, { type: "null" }] },
          status: { $ref: "#/components/schemas/CustomerStatus" },
        },
      },
      CustomerInput: {
        type: "object",
        required: ["email"],
        properties: {
          address: { $ref: "#/components/schemas/Address" },
          email: { type: "string", format: "email" },
        },
      },
      CustomerPage: {
        type: "object",
        properties: {
          data: { type: "array", items: { $ref: "#/components/schemas/Customer" } },
          has_more: { type: "boolean" },
        },
      },
      CustomerStatus: { type: "string", enum: ["active", "delinquent"] },
      CustomerUpdate: {
        allOf: [
          { $ref: "#/components/schemas/CustomerInput" },
          {
            type: "object",
            properties: { status: { $ref: "#/components/schemas/CustomerStatus" } },
          },
        ],
      },
      Error: { type: "object", properties: { message: { type: "string" } } },
      File: {
        type: "object",
        properties: {
          id: { type: "string" },
          purpose: { $ref: "#/components/schemas/FilePurpose" },
        },
      },
      FilePurpose: { type: "string", enum: ["receipt", "dispute"] },
      Invoice: {
        type: "object",
        properties: {
          customer: { oneOf: [{ type: "string" }, { $ref: "#/components/schemas/Customer" }] },
          id: { type: "string" },
          lines: { type: "array", items: { $ref: "#/components/schemas/LineItem" } },
          total: { $ref: "#/components/schemas/Money" },
        },
      },
      InvoiceInput: {
        type: "object",
        required: ["customer"],
        properties: {
          customer: { type: "string" },
          lines: { type: "array", items: { $ref: "#/components/schemas/LineItem" } },
        },
      },
      "Legacy.Unused": { type: "object" },
      LineItem: {
        type: "object",
        properties: {
          amount: { $ref: "#/components/schemas/Money" },
          description: { type: "string" },
        },
      },
      Money: {
        type: "object",
        required: ["amount", "currency"],
        properties: { amount: { type: "integer" }, currency: { type: "string" } },
      },
    },
  },
};

/** What the adapter stored for `billingSpec` before definitions were shared: each tool's
 * self-contained `{ inputSchema, outputSchema }` digest, computed by the previous release. */
const selfContainedDigests = {
  "customers.createCustomer": "qPhUFTocjYdRgE3agMdyqZeaD4-5OU8Ha2Ovv9IyV8Q",
  "customers.deleteCustomer": "CRNG1JiCqu4kgl2v-ITgkSf0rHwkYKM531nziT-Si5g",
  "customers.getCustomer": "fcV8P9gqc9ApitJ2UJBRXy5mfJawezCwhQeA0I0ct88",
  "customers.listCustomers": "_0Noqo8b9tjaxQbGT11nIOwoC4D7lHRG2JaPZ1LLOY0",
  "customers.updateCustomer": "fOVIRo9trxb24kMUfU4TQApXa6PblQenuZ5Chl8v_nM",
  "files.uploadFile": "mKZYE-_APblG5YuGr2pOjDTef9WBEGKjAiualzIP9qc",
  "health.getHealth": "CZG6fg1o5FBD1LwXRnClohy6e6_91hWRJxJaVAL-JBc",
  "invoices.createInvoice": "vUDVkQBODPN5XH2Q_luTlM3sldWQJv187b4iHc6OcME",
  "invoices.listCustomerInvoices": "swp1ZxJym_dlWEz9SoUz-iQxmTSgUOeJKTqXY8qjpDA",
  "invoices.payInvoice": "pk99amLfG5iPYRQpWvnAawz2aQHHOlqkDrhve1_qwIc",
};

const filesSpec = {
  openapi: "3.1.0",
  info: { title: "Files", version: "1" },
  servers: [{ url: "https://files.example/api" }],
  paths: {
    "/owners/{ownerId}/files/{fileId}": {
      get: {
        operationId: "getFile",
        tags: ["files"],
        parameters: [
          { name: "ownerId", in: "path", required: true, schema: { type: "string" } },
          { name: "fileId", in: "path", required: true, schema: { type: "string" } },
          { name: "session", in: "cookie", schema: { type: "string" } },
          { name: "theme", in: "cookie", schema: { type: "string" } },
          { name: "Authorization", in: "header", schema: { type: "string" } },
        ],
        responses: { "200": { description: "File" } },
      },
    },
    "/labels/{label}": {
      get: {
        operationId: "getLabel",
        tags: ["labels"],
        parameters: [
          { name: "label", in: "path", required: true, style: "label", schema: { type: "string" } },
        ],
        responses: { "200": { description: "Label" } },
      },
    },
    "/status": {
      get: { operationId: "status", tags: ["status"], responses: { "200": { description: "Up" } } },
    },
  },
};

/** No descriptions, so each tool describes itself as `METHOD /path`. */
const namingSpec = {
  openapi: "3.1.0",
  info: { title: "Naming", version: "1" },
  servers: [{ url: "https://naming.example" }],
  paths: {
    // As TMDB publishes it: a bare version segment, no tags, hyphenated operation IDs.
    "/3/account/{account_id}": {
      parameters: [{ name: "account_id", in: "path", required: true, schema: { type: "string" } }],
      get: { operationId: "account-details", responses: {} },
    },
    "/3/account/{account_id}/favorite": {
      parameters: [{ name: "account_id", in: "path", required: true, schema: { type: "string" } }],
      post: { operationId: "account-add-favorite", responses: {} },
    },
    "/3/authentication": { get: { operationId: "authentication-validate-key", responses: {} } },
    "/items": { get: { responses: {} }, post: { responses: {} } },
    "/items/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      delete: { operationId: "items/fetch", tags: ["items"], responses: {} },
      get: { operationId: "items.fetch", tags: ["items"], responses: {} },
    },
    "/shared": { $ref: "#/components/pathItems/Shared" },
    "/v1/api/widgets": { put: { operationId: "replace", responses: {} } },
  },
  components: {
    pathItems: { Shared: { get: { operationId: "shared", tags: ["shared"], responses: {} } } },
  },
};

/** A call as the Host makes it: with the target materializing its tool stored. */
async function invokeStored(
  adapter: IntegrationAdapter,
  input: Omit<Parameters<IntegrationAdapter["invokeTool"]>[0], "target">,
) {
  const { tools } = await adapter.resolveTools({ config: input.config });
  const target = tools.find(({ name }) => name === input.toolName)?.target ?? null;
  return adapter.invokeTool({ ...input, target });
}

function recordingAdapter() {
  const requests: { headers: Headers; method: string; url: URL }[] = [];
  const fetch_ = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      headers: new Headers(init?.headers),
      method: init?.method ?? "GET",
      url: new URL(String(input)),
    });
    return Response.json({ ok: true });
  });
  return { adapter: createOpenApiAdapter(fetch_), fetch: fetch_, requests };
}

const config = {
  inline: spec,
  healthCheck: {
    accountIdentifierPath: "email",
    operationId: "pets.get",
    args: { petId: "me" },
    identityPath: "id",
    displayNamePath: "name",
  },
};

describe("OpenAPI adapter", () => {
  it.each([
    [{ ok: false, error: "channel_not_found" }, "channel_not_found"],
    [{ unexpected: true }, "valid Slack response"],
  ])("recognizes the selected Slack response envelope: %j", async (body, message) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body)),
    );
    const response = await invokeStored(openApiAdapter, {
      args: { petId: "1" },
      config: { ...config, responseProfile: "slack" },
      credentialValues: {},
      placements: [],
      toolName: "pets.get",
    });
    expect(response).toMatchObject({ kind: "error", message: expect.stringContaining(message) });
  });

  it("keeps arbitrary business data untouched without the Slack response profile", async () => {
    const body = { ok: false, error: "ordinary business data" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body)),
    );
    await expect(
      invokeStored(openApiAdapter, {
        args: { petId: "1" },
        config,
        credentialValues: {},
        placements: [],
        toolName: "pets.get",
      }),
    ).resolves.toEqual({ kind: "ok", value: body });
  });

  it("marks a lost response as an unknown outcome without invoking again", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("Network response lost");
    });
    vi.stubGlobal("fetch", fetch);
    await expect(
      invokeStored(openApiAdapter, {
        args: { body: { name: "Mochi" } },
        config,
        credentialValues: {},
        placements: [],
        toolName: "pets.create",
      }),
    ).resolves.toMatchObject({ kind: "error", details: { outcomeUnknown: true } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("parses config, filters operations, and resolves schemas in reference form", async () => {
    expect(OpenApiAdapterConfigSchema.parse(config).timeoutMs).toBe(30_000);
    const catalog = await openApiAdapter.resolveTools({
      config: { ...config, operationFilter: { include: [{ operationId: "pets.*" }] } },
    });
    const { definitions, tools } = catalog;
    expect(tools.map((tool) => tool.name)).toEqual(["pets.create", "pets.get", "pets.upload"]);
    expect(Object.keys(definitions).sort()).toEqual(["NewPet", "Pet", "Unused"]);
    expect(definitions.NewPet).toMatchObject({
      properties: { friend: { $ref: "#/$defs/Pet" } },
    });
    const get = tools.find((tool) => tool.name === "pets.get")!;
    expect(get.annotations).toMatchObject({ destructiveHint: false, readOnlyHint: true });
    expect(get.inputSchema).not.toHaveProperty("$defs");
    expect(get.outputSchema).toEqual({ $ref: "#/$defs/Pet" });
    const create = tools.find((tool) => tool.name === "pets.create")!;
    expect(create.annotations).toEqual({ readOnlyHint: false });
    expect(create.inputSchema).not.toHaveProperty("$defs");
    expect(definitionClosure([create.inputSchema, create.outputSchema], definitions)).toEqual([
      "NewPet",
      "Pet",
    ]);
    expect((create.inputSchema.properties as Record<string, unknown>).contentType).toMatchObject({
      enum: ["application/json", "application/x-www-form-urlencoded"],
    });
    const filtered = await openApiAdapter.resolveTools({
      config: {
        ...config,
        operationFilter: {
          include: [{ path: "/pets*", tag: "pets" }],
          exclude: [{ method: "post", operationId: "pets.create" }],
        },
      },
    });
    expect(filtered.tools.map((tool) => tool.name)).toEqual(["pets.get"]);
  });

  it("classifies configured POST operations as read only", async () => {
    const { tools } = await openApiAdapter.resolveTools({
      config: { ...config, readOnlyOperationIds: ["pets.create"] },
    });
    expect(tools.find(({ name }) => name === "pets.create")?.annotations).toEqual({
      destructiveHint: false,
      readOnlyHint: true,
    });
  });

  it("snapshots only admitted operations and their transitive component schemas", async () => {
    const snapshot = OpenApiAdapterConfigSchema.parse(
      await openApiAdapter.snapshotConfig({
        ...config,
        operationFilter: { include: [{ operationId: "pets.get" }] },
      }),
    );
    const document = snapshot.inline as Record<string, unknown>;
    expect(Object.keys(document.paths as Record<string, unknown>)).toEqual(["/pets/{petId}"]);
    expect(
      Object.keys(
        ((document.components as Record<string, unknown>).schemas ?? {}) as Record<string, unknown>,
      ),
    ).toEqual(["Pet"]);
    await expect(openApiAdapter.resolveTools({ config: snapshot })).resolves.toMatchObject({
      tools: [{ name: "pets.get" }],
    });
  });

  it("stores spec overrides only as their result, so a snapshot resolves without reapplying them", async () => {
    const snapshot = await openApiAdapter.snapshotConfig({
      ...config,
      specOverrides: [
        { op: "remove", path: "/paths/~1uploads" },
        { op: "replace", path: "/paths/~1pets~1{petId}/get/operationId", value: "pets.fetch" },
      ],
    });
    expect(snapshot).not.toHaveProperty("specOverrides");
    const { tools } = await openApiAdapter.resolveTools({ config: snapshot });
    expect(tools.map(({ name }) => name)).toEqual(["pets.create", "pets.fetch"]);
  });

  it("runs config -> resolve -> invoke with path/query/header and auth placements", async () => {
    const fetch_ = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v1/pets/pet%201");
      expect(url.searchParams.get("fields")).toBe("id,name");
      expect(url.searchParams.get("api_key")).toBe("query-secret");
      expect(url.searchParams.getAll("api_key")).toHaveLength(1);
      expect(url.search).toContain("target=https://api.example/resource");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer access");
      expect(headers.get("x-mode")).toBe("compact");
      return new Response(JSON.stringify({ id: "pet 1", name: "Mochi" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch_);
    await expect(
      invokeStored(openApiAdapter, {
        config,
        toolName: "pets.get",
        args: {
          petId: "pet 1",
          fields: ["id", "name"],
          "x-mode": "compact",
          api_key: "caller-value",
          target: "https://api.example/resource",
        },
        credentialValues: { accessToken: "access", apiKey: "query-secret" },
        placements: [
          { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "accessToken" },
          { carrier: "query", name: "api_key", variable: "apiKey" },
        ],
      }),
    ).resolves.toEqual({ kind: "ok", value: { id: "pet 1", name: "Mochi" } });
  });

  it("encodes form-urlencoded and multipart bodies", async () => {
    const seen: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        seen.push(init?.body);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    await invokeStored(openApiAdapter, {
      config,
      toolName: "pets.create",
      args: {
        body: { name: "Mochi", labels: ["a", "b"] },
        contentType: "application/x-www-form-urlencoded",
      },
      credentialValues: {},
      placements: [],
    });
    await invokeStored(openApiAdapter, {
      config,
      toolName: "pets.upload",
      args: {
        body: {
          file: {
            dataBase64: Buffer.from("png").toString("base64"),
            filename: "pet.png",
            contentType: "image/png",
          },
        },
      },
      credentialValues: {},
      placements: [],
    });
    expect(String(seen[0])).toBe("name=Mochi&labels=a%2Cb");
    expect(seen[1]).toBeInstanceOf(FormData);
  });

  it.each([
    [401, "connection_rejected"],
    [403, "oauth_scope_insufficient"],
    [500, "upstream_http_error"],
  ] as const)("maps HTTP %s to %s", async (status, code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "no" }), {
            status,
            headers: {
              "content-type": "application/json",
              ...(status === 403
                ? { "www-authenticate": 'Bearer error="insufficient_scope"' }
                : {}),
            },
          }),
      ),
    );
    const result = await invokeStored(openApiAdapter, {
      config,
      toolName: "pets.get",
      args: { petId: "1" },
      credentialValues: { grantedScopes: "" },
      placements: [],
    });
    expect(result).toMatchObject({ kind: "error", code });
  });

  it("maps invalid arguments and timeouts", async () => {
    await expect(
      invokeStored(openApiAdapter, {
        config,
        toolName: "pets.get",
        args: {},
        credentialValues: {},
        placements: [],
      }),
    ).resolves.toMatchObject({ kind: "error", code: "invalid_arguments" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("timed out", "AbortError");
      }),
    );
    await expect(
      invokeStored(openApiAdapter, {
        config,
        toolName: "pets.get",
        args: { petId: "1" },
        credentialValues: {},
        placements: [],
      }),
    ).resolves.toMatchObject({ kind: "error", code: "upstream_timeout" });
  });

  it("caps streaming response bodies at 1MB", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array(1_048_577), {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          }),
      ),
    );
    await expect(
      invokeStored(openApiAdapter, {
        config,
        toolName: "pets.get",
        args: { petId: "1" },
        credentialValues: {},
        placements: [],
      }),
    ).resolves.toMatchObject({
      kind: "error",
      code: "upstream_http_error",
      message: expect.stringContaining("1048576-byte limit"),
    });
  });

  it("checks health and derives an identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ email: "ada@example.com", id: "pet-owner", name: "Ada" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(
      openApiAdapter.checkHealth({ config, credentialValues: {}, placements: [] }),
    ).resolves.toEqual({
      healthy: true,
      identity: {
        accountIdentifier: "ada@example.com",
        displayName: "Ada",
        externalIdentityId: "pet-owner",
      },
    });
  });

  it("applies ordered RFC 6902 patches without mutating the source", () => {
    const source = { paths: { "/old": { get: { operationId: "old" } } } };
    const patched = applySpecOverrides(source, [
      { op: "add", path: "/paths/~1new", value: { get: { operationId: "new" } } },
      { op: "replace", path: "/paths/~1old/get/operationId", value: "renamed" },
      { op: "test", path: "/paths/~1old/get/operationId", value: "renamed" },
      { op: "copy", from: "/paths/~1old", path: "/paths/~1copy" },
      { op: "move", from: "/paths/~1new", path: "/paths/~1moved" },
      { op: "remove", path: "/paths/~1copy" },
    ]);
    expect(source.paths["/old"].get.operationId).toBe("old");
    expect(patched).toMatchObject({
      paths: { "/old": { get: { operationId: "renamed" } }, "/moved": {} },
    });
  });
});

describe("OpenAPI argument containment", () => {
  const filesConfig = { inline: filesSpec };
  const invoke = (
    adapter: ReturnType<typeof createOpenApiAdapter>,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
    placements: Parameters<typeof openApiAdapter.invokeTool>[0]["placements"] = [],
    credentialValues: Readonly<Record<string, string>> = {},
  ) => invokeStored(adapter, { args, config: filesConfig, credentialValues, placements, toolName });

  it.each([
    [{ ownerId: "o", fileId: "f", extra: 1 }, "extra"],
    [{ ownerId: "o", fileId: "f", body: {} }, "body"],
    [{ ownerId: "o", fileId: "f", contentType: "application/json" }, "contentType"],
    [JSON.parse('{"ownerId":"o","fileId":"f","__proto__":{"admin":true}}'), "__proto__"],
  ])("refuses an argument the operation does not take: %j", async (args, name) => {
    const { adapter, fetch } = recordingAdapter();
    const result = await invoke(adapter, "files.getFile", args);
    expect(result).toMatchObject({ kind: "error", code: "invalid_arguments" });
    const message = result.kind === "error" ? result.message : "";
    expect(message).toContain(name);
    expect(message).toContain("ownerId, fileId, session, theme, Authorization");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says when an operation takes no arguments", async () => {
    const { adapter, fetch } = recordingAdapter();
    const result = await invoke(adapter, "status.getOperation", { verbose: true });
    expect(result).toMatchObject({
      kind: "error",
      code: "invalid_arguments",
      message: expect.stringContaining("takes no arguments"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [{ fileId: "f" }, "ownerId"],
    [{ ownerId: "o" }, "fileId"],
    [{ ownerId: "", fileId: "f" }, "ownerId"],
  ])("refuses a missing or empty path parameter: %j", async (args, name) => {
    const { adapter, fetch } = recordingAdapter();
    const result = await invoke(adapter, "files.getFile", args);
    expect(result).toMatchObject({
      kind: "error",
      code: "invalid_arguments",
      message: expect.stringContaining(name),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fills each placeholder once, so a value is never searched for another placeholder", async () => {
    const { adapter, requests } = recordingAdapter();
    await expect(
      invoke(adapter, "files.getFile", { ownerId: "{fileId}", fileId: "7" }),
    ).resolves.toMatchObject({ kind: "ok" });
    await expect(
      invoke(adapter, "files.getFile", { ownerId: "%7BfileId%7D", fileId: "7" }),
    ).resolves.toMatchObject({ kind: "ok" });
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/api/owners/%7BfileId%7D/files/7",
      "/api/owners/%257BfileId%257D/files/7",
    ]);
  });

  it.each([
    ["files.getFile", { ownerId: "..", fileId: "f" }],
    ["files.getFile", { ownerId: ".", fileId: "f" }],
    ["files.getFile", { ownerId: "o", fileId: ".." }],
    ["labels.getLabel", { label: "." }],
    ["labels.getLabel", { label: "" }],
  ])("refuses arguments that form a dot segment: %s %j", async (toolName, args) => {
    const { adapter, fetch } = recordingAdapter();
    await expect(invoke(adapter, toolName, args)).resolves.toMatchObject({
      kind: "error",
      code: "invalid_arguments",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps dot-like values that the URL parser leaves alone", async () => {
    const { adapter, requests } = recordingAdapter();
    for (const ownerId of ["...", "%2e%2E", "..%2Fadmin", ".hidden"]) {
      await expect(
        invoke(adapter, "files.getFile", { ownerId, fileId: "f" }),
      ).resolves.toMatchObject({ kind: "ok" });
    }
    await expect(invoke(adapter, "labels.getLabel", { label: "x" })).resolves.toMatchObject({
      kind: "ok",
    });
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/api/owners/.../files/f",
      "/api/owners/%252e%252E/files/f",
      "/api/owners/..%252Fadmin/files/f",
      "/api/owners/.hidden/files/f",
      "/api/labels/.x",
    ]);
  });

  it.each([["text/plain"], [5], ["APPLICATION/JSON"]])(
    "refuses a contentType the operation does not accept: %j",
    async (contentType) => {
      const { fetch } = recordingAdapter();
      const adapter = createOpenApiAdapter(fetch);
      const result = await invokeStored(adapter, {
        args: { body: { name: "Mochi" }, contentType },
        config,
        credentialValues: {},
        placements: [],
        toolName: "pets.create",
      });
      expect(result).toMatchObject({
        kind: "error",
        code: "invalid_arguments",
        message: expect.stringContaining("application/json, application/x-www-form-urlencoded"),
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("lets rendered authentication win over cookie and header arguments", async () => {
    const { adapter, requests } = recordingAdapter();
    await invoke(
      adapter,
      "files.getFile",
      { ownerId: "o", fileId: "f", session: "forged", Authorization: "Bearer forged" },
      [
        { carrier: "header", name: "Cookie", prefix: "session=", variable: "session" },
        { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "token" },
      ],
      { session: "real-session", token: "real-token" },
    );
    expect(requests[0]?.headers.get("cookie")).toBe("session=real-session");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer real-token");
  });

  it("sends cookie arguments when no authentication claims the cookie header", async () => {
    const { adapter, requests } = recordingAdapter();
    await invoke(adapter, "files.getFile", {
      ownerId: "o",
      fileId: "f",
      session: "a b",
      theme: "dark",
    });
    expect(requests[0]?.headers.get("cookie")).toBe("session=a%20b; theme=dark");
  });
});

/** A method suffix that is another operation's name, as a review found it. */
const suffixCollisionSpec = {
  openapi: "3.1.0",
  info: { title: "Suffix collision", version: "1" },
  servers: [{ url: "https://naming.example" }],
  paths: {
    "/3/account": { post: { operationId: "change", responses: {} } },
    "/account": { get: { operationId: "account.change", responses: {} } },
    "/account/current": { get: { operationId: "change-post", responses: {} } },
  },
};

/** Two operations of one method that plan one name. */
const methodCollisionSpec = {
  openapi: "3.1.0",
  info: { title: "Method collision", version: "1" },
  servers: [{ url: "https://naming.example" }],
  paths: {
    "/3/account": { get: { operationId: "detail", responses: {} } },
    "/4/account": { get: { operationId: "account.detail", responses: {} } },
  },
};

/** Two paths that differ only past where a name is cut. */
const longSegment = "x".repeat(300);
const longSegmentSpec = {
  openapi: "3.1.0",
  info: { title: "Long segments", version: "1" },
  servers: [{ url: "https://naming.example" }],
  paths: {
    [`/${longSegment}a`]: { get: { responses: {} } },
    [`/${longSegment}b`]: { get: { responses: {} } },
  },
};
const cutName = `${"x".repeat(240)}.getX${"x".repeat(236)}`;

describe("OpenAPI operation naming", () => {
  const excludeDelete = {
    exclude: [{ method: "delete" as const, path: "/items/{id}" }],
  };

  // The ways it could fail: two operations named alike, by a method suffix that
  // is another's name or the same suffix twice; a name past a tool name's 512
  // characters, or two cut to one; a call that runs an operation other than the
  // one its tool stored.
  it.each([
    [
      "every operation",
      { inline: namingSpec },
      [
        "account.accountDetails",
        "account.accountAddFavorite",
        "authentication.authenticationValidateKey",
        "items.getItems",
        "items.postItems",
        "items.fetchGet",
        "items.fetchDelete",
        "shared.getOperation",
        "widgets.replace",
      ],
    ],
    [
      "a filter",
      { inline: namingSpec, operationFilter: excludeDelete },
      [
        "account.accountDetails",
        "account.accountAddFavorite",
        "authentication.authenticationValidateKey",
        "items.getItems",
        "items.postItems",
        "items.fetch",
        "shared.getOperation",
        "widgets.replace",
      ],
    ],
    [
      "a suffix that is another name",
      { inline: suffixCollisionSpec },
      ["account.changePost2", "account.changeGet", "account.changePost"],
    ],
    [
      "one suffix twice",
      { inline: methodCollisionSpec },
      ["account.detailGet", "account.detailGet2"],
    ],
    ["names cut to fit", { inline: longSegmentSpec }, [`${cutName}Get`, `${cutName}Get2`]],
  ])(
    "names each operation once and invokes the one its tool stored (%s)",
    async (_, config, names) => {
      const { adapter, requests } = recordingAdapter();
      const { definitions, tools } = await adapter.resolveTools({ config });
      expect(definitions).toEqual({});
      expect(tools.map(({ name }) => name)).toEqual(names);
      for (const tool of tools) {
        const [method, path] = tool.description.split(" ") as [string, string];
        expect(tool.target).toEqual({ method: method.toLowerCase(), path });
        const args = Object.fromEntries(
          [...path.matchAll(/\{([^}]+)\}/gu)].map(([, name]) => [name!, "x"] as const),
        );
        await expect(
          adapter.invokeTool({
            args,
            config,
            credentialValues: {},
            placements: [],
            target: tool.target ?? null,
            toolName: tool.name,
          }),
        ).resolves.toMatchObject({ kind: "ok" });
        expect(requests.at(-1)).toMatchObject({ method });
        expect(requests.at(-1)?.url.pathname).toBe(path.replaceAll(/\{[^}]+\}/gu, "x"));
      }
    },
  );

  it.each([
    [null, undefined],
    [{ method: "delete", path: "/items/{id}" }, excludeDelete],
    [{ method: "get", path: "/items/{item}" }, undefined],
    [{ name: "items.fetchGet" }, undefined],
  ])("refuses a call whose target %j names no admitted operation", async (target, filter) => {
    const { adapter, fetch } = recordingAdapter();
    await expect(
      adapter.invokeTool({
        args: { id: "x" },
        config: { inline: namingSpec, ...(filter ? { operationFilter: filter } : {}) },
        credentialValues: {},
        placements: [],
        target,
        toolName: "items.fetchGet",
      }),
    ).resolves.toMatchObject({
      kind: "error",
      code: "invalid_arguments",
      message: 'OpenAPI tool "items.fetchGet" names no operation',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks health only against an admitted operation", async () => {
    const { adapter, requests } = recordingAdapter();
    const healthCheck = { args: { id: "me" }, operationId: "items/fetch" };
    await expect(
      adapter.checkHealth({
        config: { inline: namingSpec, healthCheck },
        credentialValues: {},
        placements: [],
      }),
    ).resolves.toEqual({ healthy: true });
    expect(requests[0]).toMatchObject({ method: "DELETE" });
    expect(requests[0]?.url.pathname).toBe("/items/me");
    await expect(
      adapter.checkHealth({
        config: { inline: namingSpec, healthCheck, operationFilter: excludeDelete },
        credentialValues: {},
        placements: [],
      }),
    ).resolves.toEqual({
      healthy: false,
      detail: "The configured health check operation was not found",
    });
  });
});

describe("OpenAPI shared definitions", () => {
  it("describes every tool exactly as the self-contained schemas stored before", async () => {
    const { definitions, tools } = await openApiAdapter.resolveTools({
      config: { inline: billingSpec },
    });
    const reached = new Set<string>();
    const described = Object.fromEntries(
      tools.map((tool) => {
        expect(tool.inputSchema).not.toHaveProperty("$defs");
        expect(tool.outputSchema ?? {}).not.toHaveProperty("$defs");
        for (const name of definitionClosure([tool.inputSchema, tool.outputSchema], definitions)) {
          reached.add(name);
        }
        return [
          tool.name,
          integrationSchemaDigest({
            inputSchema: standaloneToolSchema(tool.inputSchema, definitions),
            outputSchema: tool.outputSchema
              ? standaloneToolSchema(tool.outputSchema, definitions)
              : null,
          }),
        ] as const;
      }),
    );
    expect(described).toEqual(selfContainedDigests);
    expect([...reached].sort()).toEqual(
      Object.keys(billingSpec.components.schemas)
        .filter((name) => name !== "Error" && name !== "Legacy.Unused")
        .sort(),
    );
  });

  it("drops a response schema's own root $defs, which no reference in the document can reach", async () => {
    const { tools } = await openApiAdapter.resolveTools({
      config: {
        inline: {
          ...spec,
          paths: {
            "/inline": {
              get: {
                operationId: "inline.get",
                responses: {
                  "200": {
                    description: "Inline",
                    content: {
                      "application/json": {
                        schema: {
                          $defs: { Local: { type: "string" } },
                          properties: { pet: { $ref: "#/components/schemas/Pet" } },
                          type: "object",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(tools[0]?.outputSchema).toEqual({
      properties: { pet: { $ref: "#/$defs/Pet" } },
      type: "object",
    });
  });
});
