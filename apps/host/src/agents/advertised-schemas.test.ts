import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { agentCapabilityProfiles, toolsForCapabilityProfile } from "@opensteer/agent-tools";
import { createId } from "@opensteer/core";
import { advertisedJsonSchema } from "@opensteer/shared/advertisedJsonSchema";
import { expect, it, vi } from "vitest";
import { AgentToolsMcpService } from "./agent-tools-mcp-service.js";
import { IntegrationToolsMcpService } from "../integrations/integration-tools-mcp-service.js";
import { measureMcpContext } from "./agent-context-budget.test-support.js";

type AgentOptions = ConstructorParameters<typeof AgentToolsMcpService>[0];
type IntegrationOptions = ConstructorParameters<typeof IntegrationToolsMcpService>[0];

// Verify actual tools/list, not a second registration implementation. Reject
// malformed IDs, formats, bounds and extra fields before any handler runs.
it("advertises compact schemas for every profile while preserving useful constraints", async () => {
  for (const { id } of agentCapabilityProfiles) {
    const context = await measureMcpContext(id);
    const listed = JSON.parse(context.product!.toolsJson) as {
      name: string;
      inputSchema: Record<string, unknown>;
    }[];
    expect(listed.map(({ name }) => name)).toEqual(
      toolsForCapabilityProfile(id).map(({ name }) => name),
    );
    for (const definition of toolsForCapabilityProfile(id)) {
      expect(listed.find(({ name }) => name === definition.name)!.inputSchema).toEqual(
        advertisedJsonSchema(
          toJsonSchemaCompat(definition.inputSchema, { strictUnions: true, pipeStrategy: "input" }),
        ),
      );
    }
    for (const { toolsJson } of Object.values(context)) {
      expect(toolsJson).not.toMatch(/"(?:pattern|\$schema)":/u);
      // Anthropic rejects a tool whose input root is a union, and Claude Code
      // then drops it without telling the model.
      for (const { name, inputSchema } of JSON.parse(toolsJson) as {
        name: string;
        inputSchema: Record<string, unknown>;
      }[]) {
        expect({ name, type: inputSchema.type }).toEqual({ name, type: "object" });
        expect({ name, keys: Object.keys(inputSchema) }).not.toEqual(
          expect.objectContaining({
            keys: expect.arrayContaining([expect.stringMatching(/^(?:oneOf|anyOf|allOf)$/u)]),
          }),
        );
      }
    }
  }
});

it("keeps full product validation and valid dispatch over MCP", async () => {
  const handle = vi.fn(async (_token: string, input: unknown) => ({
    type: "thread.message.result" as const,
    requestId: (input as { requestId: string }).requestId,
    result: { accepted: true },
  }));
  const service = new AgentToolsMcpService({
    agentControl: { handle } as unknown as AgentOptions["agentControl"],
    store: {} as AgentOptions["store"],
    tokens: {} as AgentOptions["tokens"],
    publicUrl: new URL("http://localhost"),
  });
  const server = await service.createServer({
    control: { handle } as unknown as AgentOptions["agentControl"],
    profileId: "main",
    scope: "run",
    subjectId: "fixture",
    toolContractVersion: null,
  });
  const client = new Client({ name: "schema-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const transport: Transport = {
    start: () => b.start(),
    close: () => b.close(),
    send: (message, options) =>
      b.send(message, {
        ...options,
        authInfo: { clientId: "fixture", token: "fixture", scopes: [] },
      }),
  };
  b.onmessage = (message, extra) => transport.onmessage?.(message, extra);
  b.onclose = () => transport.onclose?.();
  try {
    await server.connect(a);
    await client.connect(transport);
    const valid = { delivery: "queue", message: "hello", threadId: createId("thread") };
    for (const [name, args, field] of [
      ["thread_message", { ...valid, threadId: "invalid" }, "threadId"],
      ["thread_message", { ...valid, extra: true }, "extra"],
      ["request_list", { limit: 0 }, "limit"],
      ["trigger_write", { action: "create", source: { kind: "schedule", at: "invalid" } }, "at"],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(field);
    }
    expect(handle).not.toHaveBeenCalled();
    expect((await client.callTool({ name: "thread_message", arguments: valid })).isError).not.toBe(
      true,
    );
    expect(handle).toHaveBeenCalledExactlyOnceWith(
      "fixture",
      expect.objectContaining({
        delivery: "queue",
        content: [{ type: "text", text: "hello" }],
        threadId: valid.threadId,
      }),
    );
  } finally {
    await client.close();
    await server.close();
    await service.close();
  }
});

it("keeps integration validation and custom-handler errors over MCP", async () => {
  const service = new IntegrationToolsMcpService({
    definitions: [],
    getWorkspaceForOwner: async () => null,
    onWorkspaceEvent: () => {},
    publicUrl: new URL("http://localhost"),
    platform: {} as IntegrationOptions["platform"],
    runTokens: {} as IntegrationOptions["runTokens"],
    triggerTokens: {} as IntegrationOptions["triggerTokens"],
  });
  const scope = { runId: createId("run"), capabilityProfileId: "main" } as Parameters<
    IntegrationToolsMcpService["createServer"]
  >[0];
  const server = service.createServer(scope);
  const client = new Client({ name: "schema-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const transport: Transport = {
    start: () => b.start(),
    close: () => b.close(),
    send: (message, options) =>
      b.send(message, {
        ...options,
        authInfo: { clientId: "fixture", token: "fixture", scopes: [], extra: { scope } },
      }),
  };
  b.onmessage = (message, extra) => transport.onmessage?.(message, extra);
  b.onclose = () => transport.onclose?.();
  try {
    await server.connect(a);
    await client.connect(transport);
    for (const [name, args, field] of [
      ["integration_search", { limit: 0 }, "limit"],
      [
        "integration_request",
        { integration: "mail", access: "read", reason: "fixture", account: "invalid" },
        "account",
      ],
      ["integration_describe", { toolRef: "invalid" }, "toolRef"],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(field);
    }
    // Unknown tools retain the custom handler's explicit, actionable response.
    const unknown = await client.callTool({ name: "unknown", arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.content)).toContain("not available");
  } finally {
    await client.close();
    await server.close();
    await service.close();
  }
});
