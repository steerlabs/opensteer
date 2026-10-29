import { afterEach, describe, expect, it, vi } from "vitest";
import { createIntegrationId, type IntegrationConnectionId } from "@opensteer/integration-core";

const mocked = vi.hoisted(() => {
  const callTool = vi.fn(
    async (input: unknown): Promise<{ content: unknown[]; isError?: boolean }> => ({
      content: [{ type: "text", text: JSON.stringify(input) }],
    }),
  );
  const close = vi.fn(async () => undefined);
  const session = { client: { callTool }, close };
  return {
    callTool,
    close,
    connectMcp: vi.fn(async () => session),
    listAllMcpTools: vi.fn(async () => [
      {
        name: "lookup",
        description: "Look something up",
        inputSchema: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
          additionalProperties: false,
        },
        outputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
    ]),
  };
});

vi.mock("./connection.js", () => ({
  connectMcp: mocked.connectMcp,
  listAllMcpTools: mocked.listAllMcpTools,
}));

import { closeMcpAdapterConnections, mcpAdapter } from "./adapter.js";
import { McpConnectionPool } from "./connection-pool.js";
import { probeMcpEndpointShape } from "./probe-shape.js";

const remoteConfig = {
  transport: "remote" as const,
  endpoint: "https://mcp.example/mcp",
};

afterEach(async () => {
  await closeMcpAdapterConnections();
  vi.clearAllMocks();
});

describe("MCP adapter", () => {
  it("runs config -> SDK discovery -> invoke with rendered remote auth", async () => {
    await expect(mcpAdapter.resolveTools({ config: remoteConfig })).resolves.toEqual({
      definitions: {},
      tools: [
        {
          annotations: { readOnlyHint: true },
          description: "Look something up",
          inputSchema: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
            additionalProperties: false,
          },
          name: "lookup",
          outputSchema: { type: "object" },
        },
      ],
    });
    await expect(
      mcpAdapter.invokeTool({
        config: remoteConfig,
        toolName: "lookup",
        args: { id: "42" },
        credentialValues: { token: "secret", tenant: "acme" },
        placements: [
          { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "token" },
          { carrier: "query", name: "tenant", variable: "tenant" },
        ],
      }),
    ).resolves.toMatchObject({ kind: "ok" });
    expect(mocked.connectMcp).toHaveBeenLastCalledWith(
      expect.objectContaining({
        headers: { Authorization: "Bearer secret" },
        query: { tenant: "acme" },
      }),
    );
    expect(mocked.callTool).toHaveBeenCalledWith({ name: "lookup", arguments: { id: "42" } });
  });

  it("uses env-carrier auth for stdio", async () => {
    await mcpAdapter.invokeTool({
      config: { transport: "stdio", command: "fake-mcp" },
      toolName: "lookup",
      args: { id: "1" },
      credentialValues: { apiKey: "stdio-secret" },
      placements: [{ carrier: "env", name: "API_KEY", variable: "apiKey" }],
    });
    expect(mocked.connectMcp).toHaveBeenCalledWith(
      expect.objectContaining({ env: { API_KEY: "stdio-secret" } }),
    );
  });

  it("keys pooled remote sessions by connectionId instead of credential material", async () => {
    const invoke = (connectionId: IntegrationConnectionId) =>
      mcpAdapter.invokeTool({
        args: { id: "1" },
        config: remoteConfig,
        connectionId,
        credentialValues: { token: "same-token" },
        placements: [
          { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "token" },
        ],
        toolName: "lookup",
      });

    await invoke(createIntegrationId("connection"));
    await invoke(createIntegrationId("connection"));
    expect(mocked.connectMcp).toHaveBeenCalledTimes(2);
  });

  it("calls the tool without listing tools, leaving its arguments to the server", async () => {
    mocked.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "id is required" }],
      isError: true,
    });
    await expect(
      mcpAdapter.invokeTool({
        config: remoteConfig,
        toolName: "lookup",
        args: {},
        credentialValues: {},
        placements: [],
      }),
    ).resolves.toMatchObject({
      kind: "error",
      code: "upstream_http_error",
      details: { result: { content: [{ text: "id is required" }], isError: true } },
    });
    expect(mocked.callTool).toHaveBeenCalledWith({ name: "lookup", arguments: {} });
    expect(mocked.listAllMcpTools).not.toHaveBeenCalled();
  });

  it("maps connection/scope/upstream failures", async () => {
    for (const [status, code] of [
      [401, "connection_rejected"],
      [403, "oauth_scope_insufficient"],
      [500, "upstream_http_error"],
    ] as const) {
      mocked.callTool.mockRejectedValueOnce(Object.assign(new Error(`HTTP ${status}`), { status }));
      await expect(
        mcpAdapter.invokeTool({
          config: { ...remoteConfig, endpoint: `https://mcp-${status}.example/mcp` },
          toolName: "lookup",
          args: { id: "1" },
          credentialValues: {},
          placements: [],
        }),
      ).resolves.toMatchObject({ kind: "error", code });
    }
  });

  it("maps an MCP deadline to upstream_timeout", async () => {
    mocked.callTool.mockImplementationOnce(() => new Promise(() => undefined));
    await expect(
      mcpAdapter.invokeTool({
        config: { ...remoteConfig, timeoutMs: 5 },
        toolName: "lookup",
        args: { id: "1" },
        credentialValues: {},
        placements: [],
      }),
    ).resolves.toMatchObject({ kind: "error", code: "upstream_timeout" });
  });
});

describe("MCP connection pool hardening", () => {
  it("keeps one idle connection per key and evicts a rejected session", async () => {
    const pool = new McpConnectionPool<{ close: () => Promise<void>; id: number }>();
    let nextId = 0;
    const closed: number[] = [];
    const connect = vi.fn(async () => {
      const id = ++nextId;
      return { id, close: async () => void closed.push(id) };
    });
    expect(
      await pool.withConnection("identity", connect, async (connection) => connection.id),
    ).toBe(1);
    expect(
      await pool.withConnection("identity", connect, async (connection) => connection.id),
    ).toBe(1);
    await expect(
      pool.withConnection("identity", connect, async () => {
        throw Object.assign(new Error("HTTP 401"), { status: 401 });
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(closed).toContain(1);
    expect(
      await pool.withConnection("identity", connect, async (connection) => connection.id),
    ).toBe(2);
    await pool.close();
    expect(closed).toContain(2);
  });

  it("redials once when a reused session returns 404", async () => {
    const pool = new McpConnectionPool<{ close: () => Promise<void>; id: number }>();
    let id = 0;
    const connect = async () => ({ id: ++id, close: async () => undefined });
    await pool.withConnection("identity", connect, async (connection) => connection.id);
    const result = await pool.withConnection("identity", connect, async (connection) => {
      if (connection.id === 1) throw Object.assign(new Error("HTTP 404"), { status: 404 });
      return connection.id;
    });
    expect(result).toBe(2);
  });
});

describe("MCP endpoint shape probe", () => {
  it("recognizes streamable HTTP JSON-RPC", async () => {
    await expect(
      probeMcpEndpointShape("https://mcp.example", {
        fetch: vi.fn(
          async () =>
            new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        ) as typeof fetch,
      }),
    ).resolves.toEqual({ kind: "mcp", requiresAuth: false, transport: "streamable-http" });
  });

  it("detects Bearer auth and rejects legacy SSE endpoints", async () => {
    await expect(
      probeMcpEndpointShape("https://mcp.example", {
        fetch: vi.fn(
          async () =>
            new Response(JSON.stringify({ error: "invalid_token" }), {
              status: 401,
              headers: { "www-authenticate": 'Bearer error="invalid_token"' },
            }),
        ) as typeof fetch,
      }),
    ).resolves.toMatchObject({ kind: "mcp", requiresAuth: true });

    const fetch_ = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 405 }))
      .mockResolvedValueOnce(
        new Response("event: endpoint\ndata: /messages\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    await expect(
      probeMcpEndpointShape("https://mcp.example", { fetch: fetch_ as typeof fetch }),
    ).resolves.toEqual({
      category: "wrong-shape",
      kind: "not-mcp",
      reason: "unexpected initialize status 405",
    });
    expect(fetch_).toHaveBeenCalledTimes(1);
  });

  it("uses matching RFC 9728 metadata for a non-compliant bare 401", async () => {
    const fetch_ = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"errors":["Unauthorized"]}', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            resource: "https://mcp.example/mcp",
            authorization_servers: ["https://identity.example"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    await expect(
      probeMcpEndpointShape("https://mcp.example/mcp", { fetch: fetch_ as typeof fetch }),
    ).resolves.toMatchObject({ kind: "mcp", requiresAuth: true });
    expect(String(fetch_.mock.calls[1]?.[0])).toContain(
      "/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("rejects a non-MCP HTML response", async () => {
    await expect(
      probeMcpEndpointShape("https://example.com", {
        fetch: vi.fn(
          async () =>
            new Response("<html></html>", {
              status: 200,
              headers: { "content-type": "text/html" },
            }),
        ) as typeof fetch,
      }),
    ).resolves.toMatchObject({ kind: "not-mcp", category: "wrong-shape" });
  });
});
