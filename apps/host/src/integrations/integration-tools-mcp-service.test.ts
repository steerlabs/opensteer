import { createId, OpensteerError, requestReasonMaxLength } from "@opensteer/core";
import {
  IntegrationDefinitionSchema,
  createIntegrationId,
  integrationDefinitionSummary,
  isComputerAppDefinition,
  type IntegrationAccess,
  type IntegrationDefinition,
} from "@opensteer/integration-core";
import { computerAppTools } from "@opensteer/integration-core/computer-app-tools";
import {
  integrationDefinitionDigest,
  integrationSchemaDigest,
} from "@opensteer/integration-core/digest";
import { mkdir, writeFile } from "node:fs/promises";
import { computerAppIntegrations, integrationDefinitions } from "@opensteer/integration-catalog";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface McpCallExtra {
  readonly authInfo?: {
    readonly clientId: string;
    readonly extra?: Record<string, unknown>;
    readonly scopes: string[];
    readonly token: string;
  };
  readonly requestId: string | number;
  readonly sessionId?: string;
  readonly signal: AbortSignal;
}

const mcp = vi.hoisted(() => ({
  callHandler: undefined as
    | ((
        request: { params: { arguments?: unknown; name: string } },
        extra: McpCallExtra,
      ) => Promise<unknown>)
    | undefined,
  instructions: "",
  listHandler: undefined as (() => Promise<unknown>) | undefined,
  registrations: 0,
  transports: [] as ("detached" | "session")[],
}));

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class {
    constructor(_identity: unknown, options: { instructions?: string }) {
      mcp.instructions = options.instructions ?? "";
    }
    async close() {}
    async connect() {}
    setRequestHandler(
      _schema: unknown,
      handler: (
        request: { params: { arguments?: unknown; name: string } },
        extra: McpCallExtra,
      ) => Promise<unknown>,
    ) {
      mcp.registrations += 1;
      if (mcp.registrations % 2 === 1) mcp.listHandler = handler as () => Promise<unknown>;
      else mcp.callHandler = handler;
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: class {
    readonly sessionId = "test-session";
    onclose?: () => void;
    readonly #initialized: ((id: string) => void) | undefined;
    constructor(options: { onsessioninitialized?: (id: string) => void }) {
      this.#initialized = options.onsessioninitialized;
      mcp.transports.push(options.onsessioninitialized ? "session" : "detached");
    }
    async handleRequest() {
      this.#initialized?.(this.sessionId);
    }
  },
}));

import {
  IntegrationToolsMcpService,
  type IntegrationToolsRunScope,
  type IntegrationToolsTriggerScope,
} from "./integration-tools-mcp-service.js";

const invalidToken = "not-a-token";
const computerDefinition = computerAppIntegrations[0]!;
const definition = IntegrationDefinitionSchema.parse({
  adapter: "graphql",
  authMethods: [{ id: "none", kind: "none", label: "No authentication" }],
  config: {},
  description: "Linear issues management",
  id: "linear",
  name: "Linear",
  provider: "linear",
});

const scope = {
  aud: "opensteer-integration-tools" as const,
  bindingGeneration: 1,
  capabilityProfileId: "main" as const,
  environmentId: createId("environment"),
  exp: 2_000_000_000,
  iat: 1_900_000_000,
  iss: "opensteer-host",
  jti: "test-jti",
  membershipGeneration: 1,
  requestedBy: createId("user"),
  runId: createId("run"),
  runnerBootId: "boot-test",
  runnerId: createId("runner"),
  threadId: createId("thread"),
  workspaceId: createId("workspace"),
} satisfies IntegrationToolsRunScope;
const triggerScope = {
  aud: "opensteer-trigger-integration-tools" as const,
  environmentId: scope.environmentId,
  executionGeneration: 1,
  exp: scope.exp,
  iat: scope.iat,
  iss: "opensteer-host" as const,
  jti: "trigger-test-jti",
  occurrenceId: createId("triggerOccurrence"),
  requestedBy: scope.requestedBy,
  runnerBootId: scope.runnerBootId,
  runnerId: scope.runnerId,
  threadId: scope.threadId,
  toolContractVersion: 2,
  workspaceId: scope.workspaceId,
} satisfies IntegrationToolsTriggerScope;

describe("IntegrationToolsMcpService access classes", () => {
  beforeEach(() => {
    mcp.callHandler = undefined;
    mcp.instructions = "";
    mcp.listHandler = undefined;
    mcp.registrations = 0;
    mcp.transports = [];
  });

  /*
   * A Run outlives the Host process and its idle sweep, and keeps the MCP
   * session it was given: a session the Host no longer holds must be served
   * on the Run's token rather than refused, and only on a valid token.
   */
  it("serves a session the Host no longer holds, only for a valid token", async () => {
    const { service } = await createHarness({ inventory: [] });
    const forgotten = (token: string) => {
      const response = { end: vi.fn(), headersSent: false, setHeader: vi.fn(), statusCode: 200 };
      return {
        response,
        handled: service.handle(
          {
            headers: {
              host: "opensteer.example.test",
              "mcp-session-id": "session-from-before",
              origin: "https://opensteer.example.test",
            },
            method: "POST",
          } as never,
          response as never,
          { id: 2, jsonrpc: "2.0", method: "tools/list" },
          token,
        ),
      };
    };

    const served = forgotten("run-token");
    await served.handled;
    expect(served.response.statusCode).toBe(200);
    expect(mcp.transports).toEqual(["session", "detached"]);

    const refused = forgotten(invalidToken);
    await refused.handled;
    expect(refused.response.statusCode).toBe(401);
    expect(mcp.transports).toEqual(["session", "detached"]);
  });

  it("publishes the plain integration request contract and access-class guidance", async () => {
    const { listHandler } = await createHarness({ inventory: [] });
    const listed = (await listHandler()) as {
      tools: readonly {
        description: string;
        inputSchema: Readonly<Record<string, unknown>>;
        name: string;
      }[];
    };
    expect(listed.tools.map(({ name }) => name)).toEqual([
      "integration_search",
      "integration_describe",
      "integration_call",
      "integration_propose",
      "integration_request",
    ]);
    // The MCP SDK rejects a tools/list result whose inputSchema has no object
    // root, taking every tool with it.
    for (const tool of listed.tools) expect(tool.inputSchema).toMatchObject({ type: "object" });
    expect(mcp.instructions).toBe("");

    const search = listed.tools.find(({ name }) => name === "integration_search");
    expect(search?.description).toContain(
      "operations carry callable toolRefs, effect, account and connectionId; choose accounts by connectionId, not labels, and pass toolRefs unchanged. Tool summaries show aggregate readiness.",
    );
    expect(search?.description).toContain("read permits reads; writes require read-write");
    expect(search?.description).toContain("pass a nonempty query or choose provider/runnerId");
    const call = listed.tools.find(({ name }) => name === "integration_call");
    expect(call?.description).toContain("current account and access class");
    expect(call?.description).toContain("For a new toolRef, call integration_describe first.");
    const request = listed.tools.find(({ name }) => name === "integration_request");
    expect(request?.description).toContain(
      "For setup or account access, pass integration and access; for an uninstalled catalog entry, pass catalog and access.",
    );
    expect(request?.description).toContain("Existing pending requests are reused");
    expect(request?.description).toContain("never resubmit after a decline");
    expect(request?.description).not.toContain("requestSelection");
    // One object for every request shape: Claude Code drops tools whose input
    // root is a union. The Host still enforces each shape when called.
    expect(request?.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        access: expect.any(Object),
        account: expect.any(Object),
        app: expect.any(Object),
        catalog: { maxLength: 64, minLength: 1, type: "string" },
        integration: { maxLength: 64, minLength: 1, type: "string" },
        kind: { const: "computer-app" },
        reason: { maxLength: requestReasonMaxLength, minLength: 1, type: "string" },
        runnerId: expect.any(Object),
        server: expect.any(Object),
        workspaceId: expect.any(Object),
      },
      required: ["reason"],
      type: "object",
    });
    expect(request?.inputSchema).not.toHaveProperty("oneOf");
    expect(JSON.stringify(request?.inputSchema)).not.toContain("selection");
    const propose = listed.tools.find(({ name }) => name === "integration_propose");
    expect(propose?.inputSchema).toMatchObject({
      properties: {
        description: { maxLength: 240, minLength: 1, type: "string" },
        name: { maxLength: 80, minLength: 1, type: "string" },
      },
      required: ["reason", "source", "description"],
    });
  });

  it("returns access, effect, readiness, accounts, and live toolRefs without selection tokens", async () => {
    const entry = inventoryEntry();
    const callable = callableTool({
      entry,
      effect: "read",
      name: "issues.list",
      title: "List issues",
    });
    const { handler } = await createHarness({ callableTools: [callable], inventory: [entry] });
    const searched = result(
      await handler(
        { params: { arguments: { query: "Linear" }, name: "integration_search" } },
        callExtra("search"),
      ),
    );

    expect(searched).toMatchObject({
      catalog: expect.any(Array),
      nextOffset: null,
      operationNextOffset: null,
      operationTotal: 1,
      operations: [
        {
          account: "Work",
          effect: "read",
          integration: "Linear",
          name: "issues.list",
          connectionId: callable.grant.connectionId,
          title: "List issues",
          toolRef: toolReference(callable),
        },
      ],
      results: [
        {
          accounts: [
            {
              access: "read",
              account: "Work",
              connectionId: entry.accounts[0]!.connectionId,
              isDefault: true,
            },
          ],
          integration: "Linear",
          name: "linear",
          tools: [
            {
              effect: "read",
              name: "issues.list",
              readiness: { code: "READY" },
              title: "List issues",
            },
          ],
        },
      ],
      total: 1,
    });
    const serialized = JSON.stringify(searched);
    for (const removed of [
      "requestSelection",
      "connectionSelections",
      "readOnly",
      "isDefaultAccount",
    ]) {
      expect(serialized).not.toContain(removed);
    }
  });

  // Failure cases: catalog omissions under queries/provider/paging; repeated setup prose;
  // lost installation repair detail; lost account identity or callable refs; lost app state.
  it("measures complete search responses for empty and populated deployments", async () => {
    const active = inventoryEntry();
    const attention = inventoryEntry({ readinessCode: "REAUTHORIZATION_REQUIRED" });
    attention.installation.name = "attention";
    attention.installation.title = "Attention needed";
    attention.installation.provenance.definitionId = "attention";
    const callable = callableTool({
      entry: active,
      effect: "read",
      name: "issues.list",
      title: "List issues",
    });
    const mac = {
      name: "Studio Mac",
      ready: true,
      runnerId: createId("runner"),
      apps: [
        {
          name: "Notes",
          bundleId: "com.apple.Notes",
          access: "read" as const,
          status: "approved" as const,
          connectionId: createIntegrationId("connection"),
        },
        {
          name: "Calendar",
          bundleId: "com.apple.iCal",
          access: "read" as const,
          status: "blocked" as const,
          connectionId: createIntegrationId("connection"),
        },
      ],
    };
    const captures: Record<string, unknown> = {};
    for (const [fixture, inventory] of [
      ["all-uninstalled", []],
      ["populated", [active, attention]],
    ] as const) {
      const { handler } = await createHarness({
        definitions: integrationDefinitions,
        inventory,
        callableTools: fixture === "populated" ? [callable] : [],
        computerUseMacs: fixture === "populated" ? [mac] : [],
      });
      const response = result(
        await handler(
          {
            params: {
              name: "integration_search",
              arguments: { query: "no matching service", provider: "google", limit: 1, offset: 10 },
            },
          },
          callExtra(fixture),
        ),
      );
      const full = result(
        await handler(
          { params: { name: "integration_search", arguments: { provider: "linear" } } },
          callExtra(`${fixture}-full`),
        ),
      );
      expect(
        (response.catalog as { definitionId: string }[]).map((row) => row.definitionId).sort(),
      ).toEqual(integrationDefinitions.map((row) => row.id).sort());
      expect(full).toMatchObject({
        guidance: { catalog: expect.stringContaining("definitionId is the catalog argument") },
      });
      if (fixture === "populated") {
        expect(full).toMatchObject({
          guidance: {
            readiness: expect.stringContaining("REAUTHORIZATION_REQUIRED"),
            computers: expect.stringContaining("Do not repeat pending requests"),
          },
          results: expect.arrayContaining([
            expect.objectContaining({
              name: "attention",
              servers: [
                expect.objectContaining({
                  readiness: expect.objectContaining({ code: "REAUTHORIZATION_REQUIRED" }),
                }),
              ],
            }),
          ]),
        });
      }
      captures[fixture] = { bytes: Buffer.byteLength(JSON.stringify(full)), response: full };
    }
    if (process.env.OPENSTEER_SEARCH_EVIDENCE_DIR) {
      await mkdir(process.env.OPENSTEER_SEARCH_EVIDENCE_DIR, { recursive: true });
      await writeFile(
        `${process.env.OPENSTEER_SEARCH_EVIDENCE_DIR}/responses.json`,
        JSON.stringify(captures, null, 2),
      );
    }
    expect(JSON.stringify(captures)).not.toContain('"nextAction"');
    expect(Buffer.byteLength(JSON.stringify(captures["all-uninstalled"]))).toBeLessThan(14000);
    expect(Buffer.byteLength(JSON.stringify(captures.populated))).toBeLessThan(18000);
  });

  it("describes and calls an operation while preserving the schema digest fence", async () => {
    const entry = inventoryEntry();
    const callable = callableTool({
      entry,
      effect: "read",
      name: "issues.get",
      title: "Get issue",
    });
    const callTool = vi.fn(async () => ({ content: [{ text: "called", type: "text" }] }));
    const { handler } = await createHarness({
      callTool,
      callableTools: [callable],
      inventory: [entry],
      toolSchemas: {
        ...linearToolSchemas,
        definitions: {},
        schemaDigest: callable.tool.schemaDigest,
        status: "active",
      },
    });
    const toolRef = toolReference(callable);
    const described = await handler(
      { params: { arguments: { toolRef }, name: "integration_describe" } },
      callExtra("describe"),
    );
    // One page of text, header line first; structured content would repeat it.
    expect(described).not.toHaveProperty("structuredContent");
    const text = errorText(described);
    const newline = text.indexOf("\n");
    expect(JSON.parse(text.slice(0, newline))).toMatchObject({
      account: { alias: "Work", connectionId: callable.grant.connectionId, isDefault: true },
      cursor: 0,
      nextCursor: null,
      operation: { title: "Get issue" },
      path: "",
      toolRef,
    });
    expect(JSON.parse(text.slice(newline + 1))).toEqual(linearToolSchemas);
    await handler(
      { params: { arguments: { arguments: { id: "LIN-1" }, toolRef }, name: "integration_call" } },
      callExtra("call"),
    );
    // The asking Thread travels with the call, and its Run with it for the
    // one transport that needs one; every other transport ignores the Run.
    expect(callTool).toHaveBeenCalledWith(
      callable,
      { id: "LIN-1" },
      { run: scope, threadId: scope.threadId },
      expect.any(AbortSignal),
    );

    const stale = `${callable.grant.id}.${callable.tool.id}.${"z".repeat(43)}`;
    const refused = (await handler(
      { params: { arguments: { toolRef: stale }, name: "integration_call" } },
      callExtra("stale"),
    )) as { content: readonly { text: string }[]; isError: boolean };
    expect(refused).toEqual({
      content: [
        {
          text: "Integration operation schema changed; search and describe it again",
          type: "text",
        },
      ],
      isError: true,
    });
  });

  it("names the read-write fix when a write operation is blocked by a read grant", async () => {
    const entry = inventoryEntry({
      readinessCode: "ACCESS_GRANT_REQUIRED",
      toolEffect: "write",
    });
    const grant = effectiveGrant({
      access: "read",
      connectionId: entry.accounts[0]!.connectionId,
      installationId: entry.installation.id,
    });
    const writeTool = entry.tools[0]!;
    const { handler } = await createHarness({ grants: [grant], inventory: [entry] });
    const response = (await handler(
      {
        params: {
          arguments: { toolRef: `${grant.id}.${writeTool.id}.${writeTool.schemaDigest}` },
          name: "integration_call",
        },
      },
      callExtra("write-under-read"),
    )) as { content: readonly { text: string }[]; isError: boolean };
    expect(response).toEqual({
      content: [
        {
          text: 'Linear operation Create issue makes changes, and this Workspace has read access as Work. Call integration_request with integration "linear" and access "read-write"; do not retry this call until it is fulfilled.',
          type: "text",
        },
      ],
      isError: true,
    });
  });

  it("keeps an offline computer operation discoverable with its computer account and toolRef", async () => {
    const { callable, entry } = computerInventory("INTEGRATION_UNAVAILABLE");
    const { handler } = await createHarness({
      callableTools: [callable] as never,
      definitions: [computerDefinition],
      inventory: [entry] as never,
    });
    const searched = result(
      await handler(
        { params: { arguments: { query: "Messages" }, name: "integration_search" } },
        callExtra("offline-computer-search"),
      ),
    );
    expect(searched).toMatchObject({
      guidance: { readiness: expect.stringContaining("do not repeat access requests") },
      operations: [
        {
          account: "Studio Mac",
          connectionId: callable.grant.connectionId,
          toolRef: toolReference(callable as never),
        },
      ],
      results: [
        {
          servers: [
            {
              readiness: {
                code: "INTEGRATION_UNAVAILABLE",
                detail: "Studio Mac is offline. Messages will work again when it is back.",
              },
            },
          ],
          tools: [
            {
              readiness: { code: "INTEGRATION_UNAVAILABLE" },
            },
          ],
        },
      ],
    });
  });

  it("tells the agent to relay the recorded detail of an unusable installed service", async () => {
    const entry = inventoryEntry();
    const unavailable = {
      ...entry,
      readiness: {
        servers: entry.readiness.servers.map((readiness) => ({
          ...readiness,
          code: "INTEGRATION_UNAVAILABLE" as const,
          detail: "The OpenAPI document could not be compiled.",
        })),
        tools: entry.readiness.tools.map(({ readiness, toolId }) => ({
          readiness: {
            ...readiness,
            code: "INTEGRATION_UNAVAILABLE" as const,
            detail: "The OpenAPI document could not be compiled.",
          },
          toolId,
        })),
      },
    };
    const { handler } = await createHarness({ inventory: [unavailable] as never });
    const searched = result(
      await handler(
        { params: { arguments: { query: "Linear" }, name: "integration_search" } },
        callExtra("unusable-installation-search"),
      ),
    );

    expect(searched).toMatchObject({
      guidance: { readiness: expect.stringContaining("relay the recorded detail to the user") },
      results: [
        {
          servers: [
            {
              readiness: {
                code: "INTEGRATION_UNAVAILABLE",
                detail: "The OpenAPI document could not be compiled.",
              },
            },
          ],
        },
      ],
    });
  });

  it("tells the agent to relay the recorded detail of a broken computer-app installation", async () => {
    const { entry } = computerInventory("INTEGRATION_UNAVAILABLE");
    const broken = {
      ...entry,
      readiness: {
        servers: entry.readiness.servers.map((readiness) => ({
          ...readiness,
          connectionId: null,
          detail: "The installed computer app definition is invalid.",
        })),
        tools: entry.readiness.tools.map(({ readiness, toolId }) => ({
          readiness: {
            ...readiness,
            connectionId: null,
            detail: "The installed computer app definition is invalid.",
          },
          toolId,
        })),
      },
    };
    const { handler } = await createHarness({
      definitions: [computerDefinition],
      inventory: [broken] as never,
    });
    const searched = result(
      await handler(
        { params: { arguments: { query: "Messages" }, name: "integration_search" } },
        callExtra("broken-computer-installation-search"),
      ),
    );

    expect(searched).toMatchObject({
      guidance: { readiness: expect.stringContaining("relay the recorded detail to the user") },
      results: [
        {
          servers: [
            {
              readiness: {
                code: "INTEGRATION_UNAVAILABLE",
                detail: "The installed computer app definition is invalid.",
              },
            },
          ],
          tools: [
            {
              readiness: {
                code: "INTEGRATION_UNAVAILABLE",
                detail: "The installed computer app definition is invalid.",
              },
            },
          ],
        },
      ],
    });
  });

  it("recovers a narrowed computer write toolRef with read-write guidance", async () => {
    const { entry } = computerInventory("READY");
    const grant = effectiveGrant({
      access: "read-write",
      connectionId: entry.accounts[0]!.connectionId,
      installationId: entry.installation.id,
    });
    if (!isComputerAppDefinition(computerDefinition))
      throw new Error("Computer definition invalid");
    const send = computerDefinition.config.operations.find(({ effect }) => effect === "write")!;
    const oldToolRef = `${grant.id}.${createIntegrationId("tool")}.${integrationSchemaDigest({
      inputSchema: send.inputSchema,
      outputSchema: send.outputSchema,
    })}`;
    const { handler } = await createHarness({
      computerConnection: {
        access: "read",
        runnerName: "Studio Mac",
      },
      definitions: [computerDefinition],
      grants: [grant],
      inventory: [entry] as never,
    });
    const response = await handler(
      { params: { arguments: { toolRef: oldToolRef }, name: "integration_call" } },
      callExtra("narrowed-computer-write"),
    );
    expect(errorText(response)).toBe(
      'Studio Mac allows reading only. Ask for read-write to send: call integration_request with integration "apple-messages" and access "read-write"; do not retry this call until it is fulfilled.',
    );
  });

  it("does not guess which stale write a shared schema digest named", async () => {
    const { entry } = computerInventory("READY");
    const grant = effectiveGrant({
      access: "read-write",
      connectionId: entry.accounts[0]!.connectionId,
      installationId: entry.installation.id,
    });
    if (!isComputerAppDefinition(computerDefinition))
      throw new Error("Computer definition invalid");
    const send = computerDefinition.config.operations.find(({ effect }) => effect === "write");
    if (!send) throw new Error("Computer definition has no write operation");
    const ambiguousDefinition = IntegrationDefinitionSchema.parse({
      ...computerDefinition,
      config: {
        ...computerDefinition.config,
        operations: [
          ...computerDefinition.config.operations,
          { ...send, name: "forward_message", title: "Forward message" },
        ],
      },
    });
    const oldToolRef = `${grant.id}.${createIntegrationId("tool")}.${integrationSchemaDigest({
      inputSchema: send.inputSchema,
      outputSchema: send.outputSchema,
    })}`;
    const { handler } = await createHarness({
      computerConnection: { access: "read", runnerName: "Studio Mac" },
      definitions: [ambiguousDefinition],
      grants: [grant],
      inventory: [entry] as never,
    });

    const response = await handler(
      { params: { arguments: { toolRef: oldToolRef }, name: "integration_call" } },
      callExtra("ambiguous-narrowed-computer-write"),
    );

    expect(errorText(response)).toBe("Integration operation is no longer available; search again");
  });

  it("does not short-circuit a read-write request above a computer's read-only ceiling", async () => {
    const { entry } = computerInventory("READY");
    const grant = effectiveGrant({
      access: "read-write",
      connectionId: entry.accounts[0]!.connectionId,
      installationId: entry.installation.id,
    });
    const { handler, requests } = await createHarness({
      computerConnection: { access: "read", runnerName: "Studio Mac" },
      definitions: [computerDefinition],
      grants: [grant],
      inventory: [entry] as never,
    });
    const response = await handler(
      {
        params: {
          arguments: {
            access: "read-write",
            integration: entry.installation.name,
            reason: "Send a message",
          },
          name: "integration_request",
        },
      },
      callExtra("computer-widen"),
    );
    expect(errorText(response)).not.toContain("already has");
    expect(requests.createIntegrationAccessRequest).toHaveBeenCalledOnce();
  });

  it("requests plain access by installation name and deduplicates a second tool call", async () => {
    const entry = inventoryEntry({ readinessCode: "ACCESS_GRANT_REQUIRED" });
    const { handler, requests } = await createHarness({ inventory: [entry] });
    const args = { access: "read", integration: "linear", reason: "Read the issue" };
    const first = result(
      await handler(
        { params: { arguments: args, name: "integration_request" } },
        callExtra("request-1"),
      ),
    );
    const duplicate = result(
      await handler(
        { params: { arguments: args, name: "integration_request" } },
        callExtra("request-2"),
      ),
    );
    expect(first).toMatchObject({ kind: "integration.access", replayed: false, status: "pending" });
    expect(duplicate).toMatchObject({
      kind: "integration.access",
      replayed: true,
      requestId: first.requestId,
      status: "pending",
    });
    expect(requests.createIntegrationAccessRequest).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        access: "read",
        installationId: entry.installation.id,
        requestedServerId: entry.servers[0]!.id,
        targetWorkspaceId: scope.workspaceId,
      }),
    );
  });

  it("accepts installation and account ids without weakening requested read-write access", async () => {
    const entry = inventoryEntry({ skillsOnly: true });
    const { handler, requests } = await createHarness({ inventory: [entry] });
    await handler(
      {
        params: {
          arguments: {
            access: "read-write",
            account: entry.accounts[0]!.connectionId,
            integration: entry.installation.id,
            reason: "Use the skill",
          },
          name: "integration_request",
        },
      },
      callExtra("skills-only"),
    );
    expect(requests.createIntegrationAccessRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        access: "read-write",
        installationId: entry.installation.id,
        requestedConnectionId: entry.accounts[0]!.connectionId,
      }),
    );
  });

  it("opens catalog access directly while catalog without access stays install-only", async () => {
    const access = await createHarness({ inventory: [] });
    await access.handler(
      {
        params: {
          arguments: {
            access: "read-write",
            catalog: "linear",
            reason: "Create and update issues",
          },
          name: "integration_request",
        },
      },
      callExtra("catalog-access"),
    );
    expect(access.requests.createIntegrationAccessRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        access: "read-write",
        installationId: null,
        manifest: expect.objectContaining({
          definition: expect.objectContaining({ id: "linear" }),
          kind: "catalog",
        }),
        requestedConnectionId: null,
        requestedServerId: null,
        targetWorkspaceId: scope.workspaceId,
      }),
    );
    expect(access.requests.createIntegrationInstallRequest).not.toHaveBeenCalled();

    const install = await createHarness({ inventory: [] });
    await install.handler(
      {
        params: {
          arguments: { catalog: "linear", reason: "Install Linear" },
          name: "integration_request",
        },
      },
      callExtra("catalog-install-only"),
    );
    expect(install.requests.createIntegrationInstallRequest).toHaveBeenCalledOnce();
    expect(install.requests.createIntegrationAccessRequest).not.toHaveBeenCalled();

    const entry = inventoryEntry();
    const installedEntry = {
      ...entry,
      installation: {
        ...entry.installation,
        provenance: {
          ...entry.installation.provenance,
          definitionDigest: integrationDefinitionDigest(definition),
        },
      },
    };
    const installed = await createHarness({ inventory: [installedEntry] });
    await installed.handler(
      {
        params: {
          arguments: { access: "read", catalog: "linear", reason: "Read issues" },
          name: "integration_request",
        },
      },
      callExtra("catalog-access-installed"),
    );
    expect(installed.requests.createIntegrationAccessRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: entry.installation.id,
        manifest: null,
        requestedServerId: entry.servers[0]!.id,
      }),
    );
    expect(installed.requests.createIntegrationInstallRequest).not.toHaveBeenCalled();
  });

  // The ways it could fail: a proposal accepted without saying what the
  // service does, so the person reviews only a name; the description dropped
  // on its way to inspection, so the installation describes nothing.
  it("carries requested access through a proposal instead of opening an install Request", async () => {
    const description = "Boards, lists and cards for planning a team’s work.";
    const proposal = {
      authMethods: ["none"],
      description,
      digest: "p".repeat(43),
      kind: "mcp" as const,
      preview: { toolNames: [], transport: "streamable-http" },
      source: { type: "url" as const, url: "https://tools.example.test/mcp" },
    };
    const propose = vi.fn(async () => ({
      manifest: proposal,
      selectedAuth: "none" as const,
      status: "supported" as const,
    }));
    const { handler, requests } = await createHarness({ inventory: [], propose });
    const call = (input: Record<string, unknown>, key: string) =>
      handler(
        {
          params: {
            arguments: {
              access: "read",
              kind: "mcp",
              reason: "Read the remote service",
              source: proposal.source.url,
              ...input,
            },
            name: "integration_propose",
          },
        },
        callExtra(key),
      );

    for (const [key, input] of [
      ["undescribed", {}],
      ["multiline", { description: "Boards for planning.\nApproved by Opensteer" }],
      ["overlong", { description: "x".repeat(241) }],
    ] as const) {
      expect(errorText(await call(input, `proposal-${key}`))).toMatch(
        /^invalid_arguments: description: /u,
      );
    }
    expect(propose).not.toHaveBeenCalled();

    await call({ description: `  ${description}  ` }, "proposal-access");

    expect(propose).toHaveBeenCalledWith({
      description,
      kind: "mcp",
      source: proposal.source.url,
    });
    expect(requests.createIntegrationAccessRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        access: "read",
        installationId: null,
        manifest: { kind: "proposal", proposal },
        requestedConnectionId: null,
        requestedServerId: null,
      }),
    );
    expect(requests.createIntegrationInstallRequest).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "does not choose an arbitrary compatible server (named account: %s)",
    async (nameAccount) => {
      const entry = inventoryEntry({ readinessCode: "ACCESS_GRANT_REQUIRED" });
      const secondServerId = createIntegrationId("server");
      const secondServer = { ...entry.servers[0]!, id: secondServerId, name: "secondary" };
      const secondReadiness = {
        ...entry.readiness.servers[0]!,
        serverId: secondServerId,
      };
      const ambiguous = {
        ...entry,
        readiness: { ...entry.readiness, servers: [...entry.readiness.servers, secondReadiness] },
        servers: [...entry.servers, secondServer],
      };
      const { handler, requests } = await createHarness({ inventory: [ambiguous] });

      await handler(
        {
          params: {
            arguments: {
              access: "read",
              integration: "linear",
              reason: "Read issues",
              ...(nameAccount ? { account: entry.accounts[0]!.connectionId } : {}),
            },
            name: "integration_request",
          },
        },
        callExtra("ambiguous-server"),
      );
      expect(requests.createIntegrationAccessRequest).toHaveBeenCalledWith(
        expect.objectContaining({ requestedServerId: null, access: "read" }),
      );
    },
  );

  it("rejects an account that is not available for the selected integration", async () => {
    const entry = inventoryEntry({ readinessCode: "ACCESS_GRANT_REQUIRED" });
    const { handler, requests } = await createHarness({ inventory: [entry] });

    await expect(
      handler(
        {
          params: {
            arguments: {
              access: "read-write",
              account: createIntegrationId("connection"),
              integration: "linear",
              reason: "Update issues",
            },
            name: "integration_request",
          },
        },
        callExtra("missing-account"),
      ),
    ).resolves.toMatchObject({
      content: [
        {
          text: "The requested account is not available for this integration. Search again for its current account identity.",
        },
      ],
      isError: true,
    });
    expect(requests.createIntegrationAccessRequest).not.toHaveBeenCalled();
  });

  it("uses catalog ids directly and preserves Run and Trigger request origins", async () => {
    const run = await createHarness({ inventory: [] });
    await run.handler(
      {
        params: {
          arguments: { catalog: "linear", reason: "Install Linear" },
          name: "integration_request",
        },
      },
      callExtra("catalog-run"),
    );
    expect(run.requests.createIntegrationInstallRequest).toHaveBeenCalledWith(
      expect.objectContaining({ originatingRunId: scope.runId }),
    );

    const trigger = await createHarness({ inventory: [], triggerScope });
    await trigger.handler(
      {
        params: {
          arguments: { catalog: "linear", reason: "Install Linear" },
          name: "integration_request",
        },
      },
      callExtra("catalog-trigger"),
    );
    expect(trigger.requests.createIntegrationInstallRequest).toHaveBeenCalledWith(
      expect.objectContaining({ originatingOccurrenceId: triggerScope.occurrenceId }),
    );
  });

  it("keeps Trigger and non-main cross-Workspace targeting rules", async () => {
    const entry = inventoryEntry();
    const otherWorkspace = createId("workspace");
    const trigger = await createHarness({ inventory: [entry], triggerScope });
    const triggerResponse = await trigger.handler(
      {
        params: {
          arguments: {
            access: "read",
            integration: "linear",
            reason: "Use elsewhere",
            workspaceId: otherWorkspace,
          },
          name: "integration_request",
        },
      },
      callExtra("trigger-cross-workspace"),
    );
    expect(errorText(triggerResponse)).toBe(
      "A Trigger execution may only request integration access for its own Workspace. Omit workspaceId and request access where the Trigger runs.",
    );

    const specialized = await createHarness({
      inventory: [entry],
      runScope: { ...scope, capabilityProfileId: "workspace" },
    });
    const specializedResponse = await specialized.handler(
      {
        params: {
          arguments: {
            access: "read",
            integration: "linear",
            reason: "Use elsewhere",
            workspaceId: otherWorkspace,
          },
          name: "integration_request",
        },
      },
      callExtra("specialized-cross-workspace"),
    );
    expect(errorText(specializedResponse)).toBe(
      "Only a main-profile agent may target another Workspace",
    );
  });

  it.each([
    { catalog: definition.id, access: "read-write" },
    { integration: "linear", access: "read-write" },
  ])("refuses delegated integration requests before creating an approval: %j", async (input) => {
    const { handler, requests } = await createHarness({
      inventory: [inventoryEntry()],
      runScope: { ...scope, capabilityProfileId: "delegated" },
    });
    const response = await handler(
      {
        params: { arguments: { ...input, reason: "Use the account" }, name: "integration_request" },
      },
      callExtra("delegated-cloud-request"),
    );
    expect(errorText(response)).toContain(
      "This capability profile cannot request integration access.",
    );
    expect(requests.createIntegrationAccessRequest).not.toHaveBeenCalled();
    expect(requests.createIntegrationInstallRequest).not.toHaveBeenCalled();
  });

  it("refuses to widen the owner's Main for a lineage that runs below it", async () => {
    const entry = inventoryEntry();
    const channel = await createHarness({
      computerUseMacs: [{ name: "Alex's Mac", ready: true, runnerId: createId("runner") }],
      inventory: [entry],
      mainAccess: "withheld",
      propose: vi.fn(),
      runScope: { ...scope, capabilityProfileId: "workspace" },
    });
    const refusal =
      "This conversation runs for people other than the owner, so it cannot use or request the owner's personal integrations. Ask the owner to route it to a Workspace and grant the integration there.";
    const attempts = [
      { access: "read", integration: "linear", reason: "Read the issues" },
      { access: "read", catalog: "linear", reason: "Read the issues" },
      {
        access: "read",
        app: "Notes",
        kind: "computer-app",
        reason: "Read the notes",
        runnerId: createId("runner"),
      },
    ] as const;
    for (const [index, attempt] of attempts.entries()) {
      const response = await channel.handler(
        { params: { arguments: attempt, name: "integration_request" } },
        callExtra(`withheld-${index}`),
      );
      expect(errorText(response)).toBe(refusal);
    }
    const proposed = await channel.handler(
      {
        params: {
          arguments: {
            access: "read",
            description: "Issues and projects for software teams.",
            kind: "mcp",
            reason: "Read the issues",
            source: "https://mcp.example.test/mcp",
          },
          name: "integration_propose",
        },
      },
      callExtra("withheld-propose"),
    );
    expect(errorText(proposed)).toBe(refusal);
    expect(channel.requests.createIntegrationAccessRequest).not.toHaveBeenCalled();
    expect(channel.requests.createIntegrationInstallRequest).not.toHaveBeenCalled();
    expect(channel.requestComputerAppAccess).not.toHaveBeenCalled();

    // The same request from the owner's own Home lineage proceeds.
    const home = await createHarness({ inventory: [entry], mainAccess: "inherited" });
    const allowed = await home.handler(
      {
        params: {
          arguments: { access: "read", integration: "linear", reason: "Read the issues" },
          name: "integration_request",
        },
      },
      callExtra("inherited-request"),
    );
    expect(errorText(allowed)).not.toBe(refusal);
    expect(home.requests.createIntegrationAccessRequest).toHaveBeenCalledTimes(1);
  });

  it("reports already-covered access without creating another request", async () => {
    const entry = inventoryEntry();
    const grant = effectiveGrant({
      access: "read-write",
      connectionId: entry.accounts[0]!.connectionId,
      installationId: entry.installation.id,
    });
    const { handler, requests } = await createHarness({ grants: [grant], inventory: [entry] });
    const response = await handler(
      {
        params: {
          arguments: {
            access: "read",
            account: entry.accounts[0]!.connectionId,
            integration: "linear",
            reason: "Read an issue",
          },
          name: "integration_request",
        },
      },
      callExtra("already-granted"),
    );
    expect(errorText(response)).toContain(
      "This Workspace already has read-write access to Linear as Work. Use integration_search for current access and available operations; do not request it again.",
    );
    expect(requests.createIntegrationAccessRequest).not.toHaveBeenCalled();
  });

  it("opens a request for a covered account that stopped working instead of refusing it", async () => {
    // A grant answers nothing while its account is broken: the reconnect path
    // the readiness guidance points at must stay reachable through this tool.
    const entry = inventoryEntry({ readinessCode: "REAUTHORIZATION_REQUIRED" });
    const grant = effectiveGrant({
      access: "read-write",
      connectionId: entry.accounts[0]!.connectionId,
      installationId: entry.installation.id,
    });
    const { handler, requests } = await createHarness({ grants: [grant], inventory: [entry] });
    const response = await handler(
      {
        params: {
          arguments: {
            access: "read",
            account: entry.accounts[0]!.connectionId,
            integration: "linear",
            reason: "Reconnect the account",
          },
          name: "integration_request",
        },
      },
      callExtra("reconnect-covered"),
    );
    expect(errorText(response)).not.toContain("already has");
    expect(requests.createIntegrationAccessRequest).toHaveBeenCalledTimes(1);
  });
});

describe("integration_request computer-app variant", () => {
  const mac = { name: "Alex's Mac", ready: true, runnerId: scope.runnerId };

  it("hands a second identical ask the Request already waiting", async () => {
    const { handler } = await createHarness({ computerUseMacs: [mac], inventory: [] });
    const args = {
      access: "read" as const,
      app: "Notes",
      kind: "computer-app" as const,
      reason: "Read the shopping list",
    };
    const first = result(
      await handler(
        { params: { arguments: args, name: "integration_request" } },
        callExtra("computer-app-replay-1"),
      ),
    );
    const second = result(
      await handler(
        { params: { arguments: args, name: "integration_request" } },
        callExtra("computer-app-replay-2"),
      ),
    );

    expect(second).toMatchObject({ replayed: true, requestId: first.requestId });
  });

  it("refuses when no Mac here is set up at all", async () => {
    const { handler } = await createHarness({ inventory: [] });

    const response = await handler(
      {
        params: {
          arguments: {
            access: "read",
            app: "Notes",
            kind: "computer-app",
            reason: "Read the shopping list",
          },
          name: "integration_request",
        },
      },
      callExtra("computer-app-none"),
    );

    expect(errorText(response)).toContain("No Mac is set up for computer use.");
  });

  it("refuses a delegated Thread, which may use what it was given and never widen it", async () => {
    const { handler, requestComputerAppAccess } = await createHarness({
      computerUseMacs: [mac],
      inventory: [],
      runScope: { ...scope, capabilityProfileId: "delegated" },
    });

    const response = await handler(
      {
        params: {
          arguments: {
            access: "read",
            app: "Notes",
            kind: "computer-app",
            reason: "Read the shopping list",
          },
          name: "integration_request",
        },
      },
      callExtra("computer-app-delegated"),
    );

    expect(errorText(response)).toContain(
      "This capability profile cannot request integration access.",
    );
    expect(requestComputerAppAccess).not.toHaveBeenCalled();
  });

  it("enforces each request shape although the advertisement merges them", async () => {
    const { handler } = await createHarness({ inventory: [] });
    for (const [index, attempt] of [
      { kind: "computer-app", reason: "Read the notes" },
      { access: "read", reason: "Read the notes" },
      { access: "read", catalog: "linear", integration: "linear", reason: "Read the issues" },
    ].entries()) {
      const response = await handler(
        { params: { arguments: attempt, name: "integration_request" } },
        callExtra(`shape-${index}`),
      );
      expect(errorText(response)).toMatch(/^invalid_arguments: /u);
    }
  });
});

async function createHarness(input: {
  readonly installedComputerApps?: ReturnType<typeof vi.fn>;
  readonly computerAppHolders?: ReadonlyMap<
    string,
    { readonly runId: ReturnType<typeof createId<"run">>; readonly threadTitle: string | null }
  >;
  readonly computerSetupRequests?: readonly {
    readonly kind: "app";
    readonly definitionId: "macos-app";
    readonly runnerId: ReturnType<typeof createId<"runner">>;
    readonly access: IntegrationAccess;
    readonly app: { bundleId: string; displayName: string; teamId: null };
  }[];
  readonly pendingAccessRequests?: readonly {
    readonly request: { readonly targetWorkspaceId: ReturnType<typeof createId<"workspace">> };
    readonly requestedConnectionId: ReturnType<typeof createIntegrationId<"connection">>;
  }[];
  readonly callTool?: ReturnType<typeof vi.fn>;
  readonly callableTools?: readonly ReturnType<typeof callableTool>[];
  readonly computerConnection?: { readonly access: IntegrationAccess; readonly runnerName: string };
  readonly computerUseMacs?: readonly {
    readonly state?: "ready" | "offline" | "permission-required" | "unavailable";
    readonly appApproval?: "ask" | "automatic";
    readonly apps?: readonly {
      name: string;
      bundleId: string;
      access: IntegrationAccess;
      status: "approved" | "blocked";
      connectionId: ReturnType<typeof createIntegrationId<"connection">>;
    }[];
    readonly name: string;
    readonly ready: boolean;
    readonly runnerId: ReturnType<typeof createId<"runner">>;
  }[];
  readonly definitions?: readonly IntegrationDefinition[];
  readonly grants?: readonly ReturnType<typeof effectiveGrant>[];
  readonly inventory: readonly ReturnType<typeof inventoryEntry>[];
  /** What the store says about the asking Thread and the owner's Main. */
  readonly mainAccess?: "inherited" | "withheld" | null;
  readonly propose?: ReturnType<typeof vi.fn>;
  readonly runScope?: IntegrationToolsRunScope;
  /** What the store reads for the described tool. */
  readonly toolSchemas?: Record<string, unknown>;
  readonly triggerScope?: IntegrationToolsTriggerScope;
}) {
  const requestByCallId = new Map<
    string,
    { readonly id: ReturnType<typeof createId<"request">>; readonly kind: string; status: string }
  >();
  const accessByKey = new Map<
    string,
    { readonly id: ReturnType<typeof createId<"request">>; readonly kind: string; status: string }
  >();
  const createRequest = (
    kind: "integration.access" | "integration.install" | "computer.app.access",
    callId: string,
  ) => {
    const request = { id: createId("request"), kind, status: "pending" };
    requestByCallId.set(callId, request);
    return { events: [], replayed: false, request };
  };
  const requests = {
    createIntegrationAccessRequest: vi.fn(
      async (request: {
        readonly access: IntegrationAccess;
        readonly callId: string;
        readonly installationId: string | null;
        readonly requestedBy: string;
        readonly targetWorkspaceId: string;
      }) => {
        const key = [
          request.targetWorkspaceId,
          request.requestedBy,
          request.installationId,
          request.access,
        ].join(":");
        const existing = accessByKey.get(key);
        if (existing) {
          requestByCallId.set(request.callId, existing);
          return { events: [], replayed: true, request: existing };
        }
        const created = createRequest("integration.access", request.callId);
        accessByKey.set(key, created.request);
        return created;
      },
    ),
    createIntegrationInstallRequest: vi.fn(async (request: { readonly callId: string }) =>
      createRequest("integration.install", request.callId),
    ),
    findByCallIdentity: vi.fn(async (request: { readonly callId: string }) =>
      Promise.resolve(requestByCallId.get(request.callId) ?? null),
    ),
    listPendingIntegrationAccessRequests: vi.fn(async () => input.pendingAccessRequests ?? []),
  };
  const store = {
    getComputerConnectionForCall: vi.fn(async () =>
      input.computerConnection
        ? {
            ...input.computerConnection,
            connection: {} as never,
            runnerId: createId("runner"),
            runnerRevoked: false,
          }
        : null,
    ),
    listCallableTools: vi.fn(async () => input.callableTools ?? []),
    getToolSchemas: vi.fn(async () => input.toolSchemas ?? null),
    listComputerAppSetupRequests: vi.fn(async () => input.computerSetupRequests ?? []),
    listDiscoveryInventory: vi.fn(async () => input.inventory),
    listGrantedSkills: vi.fn(async () => []),
    listGrants: vi.fn(async () => input.grants ?? []),
    listMcpOAuthConnections: vi.fn(async () => []),
    requests,
  };
  const requestComputerAppAccess = vi.fn(
    async (request: { readonly app: string; readonly callId?: string }) => {
      if (request.app === "1Password") {
        throw new OpensteerError({
          code: "bad_request",
          message: "Opensteer does not operate password managers.",
        });
      }
      const key = `computer-app:${request.app}`;
      const existing = accessByKey.get(key);
      if (existing) {
        if (request.callId) requestByCallId.set(request.callId, existing);
        return {
          status: "pending",
          nextAction:
            "Approval is pending on Alex's Mac. Continue other work or end this turn; Opensteer continues this thread when it is resolved. Do not repeat the request.",
          replayed: true,
          request: existing,
          setupRequest: { id: "setup" },
        };
      }
      const created = createRequest("computer.app.access", request.callId ?? key);
      accessByKey.set(key, created.request);
      return {
        status: "pending",
        nextAction:
          "Approval is pending on Alex's Mac. Continue other work or end this turn; Opensteer continues this thread when it is resolved. Do not repeat the request.",
        replayed: false,
        request: created.request,
        setupRequest: { id: "setup" },
      };
    },
  );
  const service = new IntegrationToolsMcpService({
    definitions: input.definitions ?? [definition],
    getWorkspaceForOwner: vi.fn(async (workspaceId) => ({ id: workspaceId })),
    onWorkspaceEvent: vi.fn(),
    platform: {
      computerToolEnabled: async () => true,
      computerUseVersion: () => 2,
      callTool: input.callTool ?? vi.fn(),
      computerAppApprovals: {
        computerUseMachines: vi.fn(async () =>
          (input.computerUseMacs ?? []).map((mac) => ({
            state: "ready",
            appApproval: "ask",
            apps: [],
            ...mac,
          })),
        ),
        computerUseInventory: vi.fn(async () => ({
          machines: (input.computerUseMacs ?? []).map((mac) => ({
            state: "ready",
            appApproval: "ask",
            apps: [],
            ...mac,
          })),
          phones: [],
        })),
        // No phone is set up for agents in these scenarios.
        computerUsePhones: vi.fn(async () => []),
        installedComputerApps: input.installedComputerApps ?? vi.fn(),
        computerAppHolders: () => input.computerAppHolders ?? new Map(),
        requestComputerAppAccess,
      },
      listCallableTools: store.listCallableTools,
      listDiscoveryInventory: store.listDiscoveryInventory,
      listGrantedSkills: store.listGrantedSkills,
      mainAccess: vi.fn(async () => input.mainAccess ?? null),
      propose: input.propose ?? vi.fn(),
      store,
    } as never,
    publicUrl: new URL("https://opensteer.example.test"),
    runTokens: {
      authenticate: vi.fn(async (token: string) => {
        if (input.triggerScope || token === invalidToken) throw new Error("not a Run token");
        return input.runScope ?? scope;
      }),
    } as never,
    triggerTokens: {
      authenticate: vi.fn(async (token: string) => {
        if (token === invalidToken) throw new Error("not a Trigger token");
        return input.triggerScope ?? triggerScope;
      }),
    } as never,
  });
  await service.handle(
    {
      headers: { host: "opensteer.example.test", origin: "https://opensteer.example.test" },
      method: "POST",
    } as never,
    { end: vi.fn(), headersSent: false, setHeader: vi.fn() } as never,
    {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
        protocolVersion: "2025-06-18",
      },
    },
    "run-token",
  );
  if (!mcp.callHandler || !mcp.listHandler) throw new Error("MCP handlers were not registered");
  const callHandler = mcp.callHandler;
  // The real transport hands each call the scope its request's token proved.
  const authInfo = {
    clientId: "test",
    extra: { scope: input.triggerScope ?? input.runScope ?? scope },
    scopes: [],
    token: "run-token",
  };
  return {
    service,
    handler: (
      request: Parameters<typeof callHandler>[0],
      extra: McpCallExtra,
    ): ReturnType<typeof callHandler> => callHandler(request, { authInfo, ...extra }),
    listHandler: mcp.listHandler,
    requestComputerAppAccess,
    requests,
    store,
  };
}

function computerInventory(
  code: "INTEGRATION_UNAVAILABLE" | "READY",
  source: (typeof computerAppIntegrations)[number] = computerDefinition,
) {
  const installationId = createIntegrationId("installation");
  const serverId = createIntegrationId("server");
  const connectionId = createIntegrationId("connection");
  const grant = effectiveGrant({ access: "read", connectionId, installationId });
  const { inputSchema, outputSchema, ...material } = computerAppTools(
    source as never,
    "read",
    connectionId,
  )[0]!;
  const tool = {
    ...material,
    schemaDigest: integrationSchemaDigest({ inputSchema, outputSchema }),
    serverId,
  };
  const readiness = {
    code,
    connectionId,
    detail:
      code === "READY" ? null : "Studio Mac is offline. Messages will work again when it is back.",
    provider: null,
    requiredAccess: null,
    serverId,
  } as const;
  const installation = {
    createdAt: "2026-08-13T12:00:00.000Z",
    description: source.description,
    id: installationId,
    manifest: { definition: integrationDefinitionSummary(source) },
    name: source.id,
    provenance: {
      definitionDigest: integrationDefinitionDigest(source),
      definitionId: source.id,
    },
    revision: 1,
    sourceKind: "built-in" as const,
    status: "active" as const,
    title: source.name,
    trust: "built-in" as const,
    updatedAt: "2026-08-13T12:00:00.000Z",
    version: integrationDefinitionDigest(source),
  };
  const server = {
    connectionRequirement: { definitionId: source.id, kind: "computer" as const },
    id: serverId,
    installationId,
    name: "default",
    status: "active" as const,
    statusDetail: null,
    toolGeneration: 1,
    transport: { definitionId: source.id, type: "computer" as const },
    updatedAt: "2026-08-13T12:00:00.000Z",
  };
  return {
    callable: { grant, installation, server, tool },
    entry: {
      accounts: [{ access: "read" as const, account: "Studio Mac", connectionId, isDefault: true }],
      installation,
      readiness: { servers: [readiness], tools: [{ readiness, toolId: tool.id }] },
      servers: [server],
      skills: [],
      tools: [tool],
    },
  };
}

/** What the store holds for an `inventoryEntry` tool, and never lists. */
const linearToolSchemas = {
  inputSchema: { additionalProperties: false, properties: {}, type: "object" },
  outputSchema: { type: "object" },
};

function inventoryEntry(
  input: {
    readonly readinessCode?: "ACCESS_GRANT_REQUIRED" | "READY" | "REAUTHORIZATION_REQUIRED";
    readonly skillsOnly?: boolean;
    readonly toolEffect?: "read" | "write";
  } = {},
) {
  const installationId = createIntegrationId("installation");
  const serverId = createIntegrationId("server");
  const connectionId = createIntegrationId("connection");
  const toolId = createIntegrationId("tool");
  const toolEffect = input.toolEffect ?? "read";
  const readinessCode = input.readinessCode ?? "READY";
  const requiredAccess =
    readinessCode === "ACCESS_GRANT_REQUIRED"
      ? toolEffect === "read"
        ? "read"
        : "read-write"
      : null;
  const readiness = {
    code: readinessCode,
    connectionId,
    detail: null,
    provider: "linear",
    requiredAccess,
    serverId,
  } as const;
  const tool = {
    annotations: { readOnlyHint: toolEffect === "read" },
    connectionId: null,
    description: toolEffect === "read" ? "List issues" : "Create issue",
    id: toolId,
    name: toolEffect === "read" ? "issues.list" : "issues.create",
    schemaDigest: integrationSchemaDigest(linearToolSchemas),
    status: "active" as const,
    title: toolEffect === "read" ? "List issues" : "Create issue",
  };
  return {
    accounts: [{ access: "read" as const, account: "Work", connectionId, isDefault: true }],
    installation: {
      createdAt: "2026-08-13T12:00:00.000Z",
      description: "Linear integration",
      id: installationId,
      manifest: { definition },
      name: "linear",
      provenance: { definitionId: "linear" },
      revision: 1,
      sourceKind: "built-in" as const,
      status: "active" as const,
      title: "Linear",
      trust: "built-in" as const,
      updatedAt: "2026-08-13T12:00:00.000Z",
      version: "1",
    },
    readiness: {
      servers: [readiness],
      tools: input.skillsOnly ? [] : [{ readiness, toolId }],
    },
    servers: [
      {
        connectionRequirement: {
          definitionId: "linear",
          kind: "provider" as const,
          provider: "linear",
          providerApplicationRequired: false,
        },
        id: serverId,
        installationId,
        name: "default",
        status: "active" as const,
        statusDetail: null,
        toolGeneration: 1,
        transport: {
          adapter: "graphql" as const,
          definitionId: "linear",
          type: "adapter" as const,
        },
        updatedAt: "2026-08-13T12:00:00.000Z",
      },
    ],
    skills: input.skillsOnly
      ? [
          {
            description: "Summarize Linear issues",
            digest: "s".repeat(43),
            id: createIntegrationId("skill"),
            name: "summarize-issues",
            status: "active" as const,
          },
        ]
      : [],
    tools: input.skillsOnly ? [] : [tool],
  };
}

function callableTool(input: {
  readonly effect: "read" | "write";
  readonly entry: ReturnType<typeof inventoryEntry>;
  readonly name: string;
  readonly title: string;
}) {
  const inventoryTool = input.entry.tools[0]!;
  return {
    grant: effectiveGrant({
      access: input.effect === "read" ? "read" : "read-write",
      connectionId: input.entry.accounts[0]!.connectionId,
      installationId: input.entry.installation.id,
    }),
    installation: input.entry.installation,
    server: input.entry.servers[0]!,
    tool: {
      ...inventoryTool,
      annotations: { readOnlyHint: input.effect === "read" },
      name: input.name,
      title: input.title,
    },
  };
}

function effectiveGrant(input: {
  readonly access: IntegrationAccess;
  readonly connectionId: ReturnType<typeof createIntegrationId<"connection">>;
  readonly installationId: ReturnType<typeof createIntegrationId<"installation">>;
}) {
  return {
    access: input.access,
    alias: "Work",
    connectionId: input.connectionId,
    createdAt: "2026-08-13T12:00:00.000Z",
    id: createIntegrationId("grant"),
    installationId: input.installationId,
    isDefault: true,
    ownerUserId: scope.requestedBy,
    revokedAt: null,
    source: "explicit" as const,
    status: "active" as const,
    workspaceId: scope.workspaceId,
  };
}

function toolReference(callable: ReturnType<typeof callableTool>): string {
  return `${callable.grant.id}.${callable.tool.id}.${callable.tool.schemaDigest}`;
}

function callExtra(requestId: string | number): McpCallExtra {
  return {
    requestId,
    sessionId: "test-session",
    signal: new AbortController().signal,
  };
}

function result(value: unknown): Record<string, unknown> {
  const structured = (value as { structuredContent?: unknown }).structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
    throw new Error(`Expected a structured MCP result: ${JSON.stringify(value)}`);
  }
  return structured as Record<string, unknown>;
}

function errorText(value: unknown): string {
  return (value as { content: readonly { text: string }[] }).content[0]?.text ?? "";
}

describe("computer use discovery", () => {
  const definition = computerAppIntegrations.find(({ id }) => id === "macos-app")!;
  const connectionId = createIntegrationId("connection");
  const mac = {
    name: "Alex's Mac",
    ready: true,
    runnerId: scope.runnerId,
    state: "ready" as const,
    appApproval: "ask" as const,
    apps: [
      {
        name: "Notes",
        bundleId: "com.apple.Notes",
        access: "read" as const,
        status: "blocked" as const,
        connectionId,
      },
    ],
  };
  it("says a runnerId names no Mac of this person's and where to find the right one", async () => {
    const installedComputerApps = vi.fn();
    const { handler } = await createHarness({
      definitions: [definition],
      inventory: [],
      computerUseMacs: [mac],
      installedComputerApps,
    });
    const unknown = createId("runner");
    const answer = await handler(
      { params: { name: "integration_search", arguments: { runnerId: unknown } } },
      callExtra("mac-unknown"),
    );
    expect(answer).toMatchObject({ isError: true });
    expect(errorText(answer)).toBe(
      `No Mac set up for computer use has runnerId ${unknown}. Search "Computer use" with integration_search to list your Macs and their runnerIds.`,
    );
    expect(installedComputerApps).not.toHaveBeenCalled();
  });
  it("queries the Mac without icons and annotates blocked and unapproved results", async () => {
    const installedComputerApps = vi.fn(async () => ({
      total: 20,
      apps: [
        {
          identity: { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null },
          running: true,
        },
        {
          identity: { bundleId: "example.Notepad", displayName: "Notepad", teamId: null },
          running: false,
        },
      ],
    }));
    const { handler } = await createHarness({
      definitions: [definition],
      inventory: [],
      computerUseMacs: [mac],
      installedComputerApps,
    });
    const answer = result(
      await handler(
        {
          params: {
            name: "integration_search",
            arguments: { runnerId: mac.runnerId, query: "note", limit: 2, offset: 4 },
          },
        },
        callExtra("mac-installed"),
      ),
    );
    expect(installedComputerApps).toHaveBeenCalledWith(
      {
        actorUserId: scope.requestedBy,
        runnerId: mac.runnerId,
        query: "note",
        limit: 2,
        offset: 4,
        icons: false,
      },
      expect.any(Array),
    );
    expect(answer).toMatchObject({
      guidance: {
        computers: expect.stringContaining("blocked: only the person can unblock it on that Mac"),
      },
      computer: { runnerId: mac.runnerId, state: "ready", appApproval: "ask" },
      total: 20,
      nextOffset: 6,
      apps: [
        {
          name: "Notes",
          bundleId: "com.apple.Notes",
          status: "blocked",
        },
        {
          name: "Notepad",
          bundleId: "example.Notepad",
          status: "not-approved",
          // The row is already the listing, so it asks rather than searching again.
        },
      ],
    });
    expect(JSON.stringify(answer)).not.toContain("teamId");
    expect(JSON.stringify(answer)).not.toContain("iconPng");
  });
});
