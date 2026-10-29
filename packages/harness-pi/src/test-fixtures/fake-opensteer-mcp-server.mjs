// A Streamable HTTP MCP server standing in for Opensteer's own agent-tools and
// integration-tools servers, so the generated extension's MCP bridge is proved
// against a real @modelcontextprotocol/sdk server rather than a hand-rolled
// HTTP stub. The low-level Server is used rather than McpServer so the tool's
// inputSchema is the literal JSON Schema an Opensteer tool declares, which is
// what the extension's TypeBox conversion has to cope with.
//
// The SDK is resolved from absolute paths the caller supplies, because this
// package does not depend on it.
//
// Contract:
//   env OPENSTEER_MCP_SERVER_MODULE     @modelcontextprotocol/sdk/server/index.js
//   env OPENSTEER_MCP_TRANSPORT_MODULE  @modelcontextprotocol/sdk/server/streamableHttp.js
//   env OPENSTEER_MCP_TYPES_MODULE      @modelcontextprotocol/sdk/types.js
//   env OPENSTEER_MCP_TOKEN             the bearer every request must carry
//   env OPENSTEER_MCP_TOOLS             JSON array of tool names to expose
//   env OPENSTEER_MCP_LOG               optional JSONL path recording each request
//   env OPENSTEER_MCP_STALL             "initialize" | "tools/list": accept the
//                                       request and never answer it, so the
//                                       caller's own deadline is the only thing
//                                       that ends the wait
// stdout: one line "listening <url>" once bound.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const token = process.env.OPENSTEER_MCP_TOKEN ?? "";
const toolNames = JSON.parse(process.env.OPENSTEER_MCP_TOOLS ?? "[]");
const logPath = process.env.OPENSTEER_MCP_LOG;
const { Server } = await import(process.env.OPENSTEER_MCP_SERVER_MODULE);
const { StreamableHTTPServerTransport } = await import(process.env.OPENSTEER_MCP_TRANSPORT_MODULE);
const { CallToolRequestSchema, ListToolsRequestSchema } = await import(
  process.env.OPENSTEER_MCP_TYPES_MODULE
);

function log(entry) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

const tools = toolNames.map((name) => ({
  description: `Fake ${name}`,
  inputSchema: {
    additionalProperties: false,
    properties: {
      limit: { description: "How many", type: "integer" },
      mode: { description: "Which mode", enum: ["fast", "thorough"] },
      query: { description: "What to look for", type: "string" },
      tags: { items: { type: "string" }, type: "array" },
    },
    required: ["query"],
    type: "object",
  },
  name,
}));

const server = new Server(
  { name: "fake-opensteer", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => {
  log({ type: "list" });
  return { tools };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  log({ arguments: request.params.arguments, tool: request.params.name, type: "call" });
  if (request.params.arguments?.query === "fail") {
    return { content: [{ text: `${request.params.name} refused`, type: "text" }], isError: true };
  }
  // A tool that answers with a picture, the way computer use does: one text
  // block, one image block, and a block kind a Pi tool result has no place for.
  if (request.params.arguments?.query === "picture") {
    return {
      content: [
        { text: `${request.params.name}:observed`, type: "text" },
        { data: "aW1hZ2UtYnl0ZXM=", mimeType: "image/png", type: "image" },
        { data: "YXVkaW8tYnl0ZXM=", mimeType: "audio/wav", type: "audio" },
      ],
    };
  }
  return {
    content: [
      { text: `${request.params.name}:${request.params.arguments?.query ?? ""}`, type: "text" },
    ],
  };
});

const transports = new Map();

const stall = process.env.OPENSTEER_MCP_STALL;

const http = createServer((request, response) => {
  const authorization = request.headers.authorization ?? "";
  log({
    authorization: authorization === `Bearer ${token}` ? "ok" : authorization,
    type: "request",
  });
  if (authorization !== `Bearer ${token}`) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  void readBody(request).then((body) => {
    if (stall && body?.method === stall) {
      log({ stalled: stall, type: "stall" });
      // The socket stays open and nothing is ever written back.
      return;
    }
    const sessionId = request.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
    if (existing) {
      void existing.handleRequest(request, response, body);
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      onsessioninitialized: (id) => transports.set(id, transport),
      sessionIdGenerator: () => randomUUID(),
    });
    void server.connect(transport).then(() => transport.handleRequest(request, response, body));
  });
});

async function readBody(request) {
  if (request.method !== "POST") return undefined;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

http.listen(Number(process.env.OPENSTEER_MCP_PORT ?? 0), "127.0.0.1", () => {
  const address = http.address();
  process.stdout.write(`listening http://127.0.0.1:${address.port}/mcp\n`);
});
