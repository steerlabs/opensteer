#!/usr/bin/env node
/**
 * Zero-dependency Opensteer CLI for automation scripts.
 * Talks to the Runner's loopback MCP proxy via OPENSTEER_MCP_URL and OPENSTEER_MCP_TOKEN.
 *
 * Usage:
 *   opensteer tools [--names]
 *   opensteer tool <name> [json]
 *   echo '{"message":"hi"}' | opensteer tool <name>
 */

const PROTOCOL_VERSION = "2025-11-25";

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  opensteer tools [--names]",
      "  opensteer tool <name> [json]",
      "",
      "Calls Opensteer tools through OPENSTEER_MCP_URL and OPENSTEER_MCP_TOKEN.",
    ].join("\n") + "\n",
  );
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseRpcPayload(text, contentType) {
  if (!text.trim()) return null;
  if (contentType && contentType.includes("text/event-stream")) {
    let last = null;
    for (const line of text.split(/\r?\n/u)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      last = JSON.parse(data);
    }
    return last;
  }
  return JSON.parse(text);
}

async function mcpRequest(url, token, sessionId, payload) {
  const headers = {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "mcp-protocol-version": PROTOCOL_VERSION,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(url, {
    body: JSON.stringify(payload),
    headers,
    method: "POST",
    redirect: "error",
  });
  const nextSessionId = response.headers.get("mcp-session-id") || sessionId;
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Opensteer MCP HTTP ${response.status}: ${text || response.statusText}`);
  }
  return {
    body: parseRpcPayload(text, response.headers.get("content-type") || ""),
    sessionId: nextSessionId,
  };
}

async function closeSession(url, token, sessionId) {
  if (!sessionId) return;
  await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": PROTOCOL_VERSION,
      "mcp-session-id": sessionId,
    },
    method: "DELETE",
    redirect: "error",
  }).catch(() => undefined);
}

async function withSession(fn) {
  const url = process.env.OPENSTEER_MCP_URL;
  const token = process.env.OPENSTEER_MCP_TOKEN;
  if (!url || !token) {
    throw new Error("OPENSTEER_MCP_URL and OPENSTEER_MCP_TOKEN must be set.");
  }
  let sessionId = null;
  try {
    const init = await mcpRequest(url, token, null, {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "opensteer-cli", version: "1" },
        protocolVersion: PROTOCOL_VERSION,
      },
    });
    if (init.body?.error) {
      throw new Error(init.body.error.message || "MCP initialize failed");
    }
    sessionId = init.sessionId;
    await mcpRequest(url, token, sessionId, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    return await fn(url, token, sessionId);
  } finally {
    await closeSession(url, token, sessionId);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    usage();
    process.exit(args.length === 0 ? 2 : 0);
  }
  const subcommand = args[0];
  if (subcommand === "tools") {
    const namesOnly = args.includes("--names");
    const tools = await withSession(async (url, token, sessionId) => {
      const response = await mcpRequest(url, token, sessionId, {
        id: 2,
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
      });
      if (response.body?.error) {
        throw new Error(response.body.error.message || "tools/list failed");
      }
      return response.body?.result?.tools ?? [];
    });
    if (namesOnly) {
      for (const tool of tools) {
        if (tool && typeof tool.name === "string") process.stdout.write(`${tool.name}\n`);
      }
    } else {
      process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`);
    }
    return;
  }

  if (subcommand === "tool") {
    const name = args[1];
    if (!name || name.startsWith("-")) {
      usage();
      process.exit(2);
    }
    const rawInput = args[2] !== undefined ? args[2] : (await readStdin()).trim();
    let toolArgs = {};
    if (rawInput.length > 0) {
      try {
        toolArgs = JSON.parse(rawInput);
      } catch (error) {
        throw new Error(
          `Tool input must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (toolArgs === null || typeof toolArgs !== "object" || Array.isArray(toolArgs)) {
        throw new Error("Tool input JSON must be an object.");
      }
    }
    const result = await withSession(async (url, token, sessionId) => {
      const response = await mcpRequest(url, token, sessionId, {
        id: 2,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: toolArgs, name },
      });
      if (response.body?.error) {
        throw new Error(response.body.error.message || `Tool ${name} failed`);
      }
      return response.body?.result ?? {};
    });
    const output =
      result.structuredContent !== undefined
        ? result.structuredContent
        : Array.isArray(result.content)
          ? result.content
              .filter((part) => part && part.type === "text" && typeof part.text === "string")
              .map((part) => part.text)
              .join("\n")
          : result;
    const serialized = typeof output === "string" ? output : JSON.stringify(output, null, 2);
    if (result.isError) {
      process.stderr.write(`${serialized}\n`);
      process.exit(1);
    }
    process.stdout.write(`${serialized}\n`);
    return;
  }

  usage();
  process.exit(2);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
