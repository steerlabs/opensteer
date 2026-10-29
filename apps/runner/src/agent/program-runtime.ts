export function triggerProgramRuntimeSource(programSpecifier: string): string {
  return `
import { readFileSync, writeFileSync } from "node:fs";
import program from ${JSON.stringify(programSpecifier)};

const event = deepFreeze(JSON.parse(readFileSync(requiredEnv("OPENSTEER_EVENT_PATH"), "utf8")));
const initialCapabilities = capabilities();
if (process.env.OPENSTEER_WATCH === "1") {
  process.stdin.resume();
  process.stdin.once("end", () => process.exit(1));
}
const opensteer = Object.freeze({
  callTool: (name, input = {}) => callTool(capabilities().mcp, name, input),
  capabilities,
  integrations: Object.freeze({
    callTool: (name, input = {}) => callTool(capabilities().integrationMcp, name, input),
    mcp: initialCapabilities.integrationMcp,
  }),
  mcp: initialCapabilities.mcp,
});

try {
  if (typeof program !== "function") throw new TypeError("Trigger program must export a default function");
  const value = await program(Object.freeze({
    capabilities: initialCapabilities,
    event,
    opensteer,
  }));
  if (process.env.OPENSTEER_WATCH === "1") {
    throw new Error("Watch Trigger programs must not resolve");
  }
  writeResult({ ok: true, value: value === undefined ? null : value });
} catch (error) {
  if (process.env.OPENSTEER_WATCH === "1") {
    console.error(safeError(error));
    process.exit(1);
  }
  writeResult({ ok: false, error: safeError(error) });
  process.exitCode = 1;
}

async function callTool(plan, name, input) {
  const client = createMcpClient(plan);
  try {
    return await client.callTool(name, input);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function createMcpClient(plan) {
  let nextId = 1;
  let sessionId;
  let initialized;

  async function post(message, expectBody = true) {
    const response = await fetch(plan.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: \`Bearer \${plan.token}\`,
        "content-type": "application/json",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(message),
      redirect: "error",
    });
    const returnedSession = response.headers.get("mcp-session-id");
    if (returnedSession) sessionId = returnedSession;
    if (!response.ok) throw new Error(\`Opensteer MCP request failed (\${response.status})\`);
    if (!expectBody || response.status === 202) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new Error("Opensteer MCP endpoint did not return JSON");
    }
    return response.json();
  }

  async function initialize() {
    if (initialized) return initialized;
    initialized = (async () => {
      const id = nextId++;
      const response = await post({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "opensteer-trigger-program", version: "1.0.0" },
        },
      });
      if (!response || response.id !== id || response.error) {
        throw new Error(response?.error?.message ?? "Opensteer MCP initialization failed");
      }
      await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, false);
    })();
    return initialized;
  }

  return {
    async callTool(name, input) {
      await initialize();
      const id = nextId++;
      const response = await post({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: input },
      });
      if (!response || response.id !== id || response.error) {
        throw new Error(response?.error?.message ?? \`Opensteer tool \${name} failed\`);
      }
      const result = response.result;
      if (result?.isError) {
        const message = Array.isArray(result.content)
          ? result.content.find((item) => item?.type === "text")?.text
          : undefined;
        throw new Error(message ?? \`Opensteer tool \${name} failed\`);
      }
      return result?.structuredContent ?? result;
    },
    async close() {
      if (!sessionId) return;
      await fetch(plan.url, {
        method: "DELETE",
        headers: {
          authorization: \`Bearer \${plan.token}\`,
          "mcp-session-id": sessionId,
        },
        redirect: "error",
      });
    },
  };
}

function capabilities() {
  const path = process.env.OPENSTEER_CAPABILITIES_PATH;
  if (path) return deepFreeze(JSON.parse(readFileSync(path, "utf8")));
  const mcp = {
    token: requiredEnv("OPENSTEER_MCP_TOKEN"),
    url: requiredEnv("OPENSTEER_MCP_URL"),
  };
  const integrationMcp = {
    token: requiredEnv("OPENSTEER_INTEGRATION_MCP_TOKEN"),
    url: requiredEnv("OPENSTEER_INTEGRATION_MCP_URL"),
  };
  const browserCdp = process.env.OPENSTEER_CDP_URL && process.env.OPENSTEER_CDP_TOKEN
    ? { token: process.env.OPENSTEER_CDP_TOKEN, url: process.env.OPENSTEER_CDP_URL }
    : null;
  return deepFreeze({ browserCdp, integrationMcp, mcp });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(\`Missing Trigger capability: \${name}\`);
  return value;
}

function safeError(error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  return message.slice(0, 20000);
}

function writeResult(value) {
  writeFileSync(3, JSON.stringify(value), { encoding: "utf8" });
}
`;
}
