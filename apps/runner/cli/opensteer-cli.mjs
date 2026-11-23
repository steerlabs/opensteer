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
const EXIT_OK = 0;
const EXIT_LOCAL = 1;
const EXIT_REFUSED = 2;
const EXIT_UNKNOWN = 3;

class CliExitError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

const PROVABLY_NO_EFFECT_CODES = new Set([
  "access_denied",
  "bad_request",
  "declined_by_person",
  "forbidden",
  "invalid_arguments",
  "invalid_input",
  "not_found",
  "organization_not_allowed",
  "unauthenticated",
  "unauthorized",
  "unsupported",
]);

function isOutcomeUnknownCode(code) {
  return code === "outcome_unknown" || code === "outcome-unknown";
}

function errorCodeFromPayload(value) {
  if (!value || typeof value !== "object") return null;
  if (value.error && typeof value.error === "object" && typeof value.error.code === "string") {
    return value.error.code;
  }
  if (typeof value.code === "string") return value.code;
  if (value.data && typeof value.data === "object" && typeof value.data.code === "string") {
    return value.data.code;
  }
  return null;
}

function isOutcomeUnknownPayload(value) {
  if (!value || typeof value !== "object") return false;
  if (isOutcomeUnknownCode(value.code)) return true;
  if (value.outcome === "unknown") return true;
  if (value.error && typeof value.error === "object" && isOutcomeUnknownCode(value.error.code)) {
    return true;
  }
  if (value.data && typeof value.data === "object" && isOutcomeUnknownCode(value.data.code)) {
    return true;
  }
  return false;
}

function isOutcomeUnknownText(text) {
  return (
    typeof text === "string" &&
    /\b(?:OperationOutcomeUnknown|outcome_unknown|outcome-unknown)\b/u.test(text)
  );
}

/**
 * Exit 2 means provably nothing happened (AA4). Every other tool failure exits 3 so scripts
 * never blindly retry a partial or uncertain write.
 */
function isProvablyNoEffectToolError(result, serialized) {
  if (
    isOutcomeUnknownPayload(result?.structuredContent) ||
    isOutcomeUnknownPayload(result) ||
    isOutcomeUnknownText(serialized)
  ) {
    return false;
  }
  let code = errorCodeFromPayload(result?.structuredContent) ?? errorCodeFromPayload(result);
  if (!code && typeof serialized === "string" && serialized.trim().startsWith("{")) {
    try {
      code = errorCodeFromPayload(JSON.parse(serialized));
    } catch {
      code = null;
    }
  }
  return code !== null && PROVABLY_NO_EFFECT_CODES.has(code);
}

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  opensteer tools [--names]",
      "  opensteer tool <name> [json]",
      "",
      "Calls Opensteer tools through OPENSTEER_MCP_URL and OPENSTEER_MCP_TOKEN.",
      "",
      "Exit codes:",
      "  0  Done",
      "  1  Usage or local error (nothing was sent)",
      "  2  Refused before running (provably nothing happened)",
      "  3  Outcome unknown (effect may have happened; check before retrying)",
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

async function mcpRequest(url, token, sessionId, payload, options = {}) {
  const headers = {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "mcp-protocol-version": PROTOCOL_VERSION,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const mayHaveEffect = options.mayHaveEffect === true;
  let response;
  let text;
  try {
    response = await fetch(url, {
      body: JSON.stringify(payload),
      headers,
      method: "POST",
      redirect: "error",
    });
    text = await response.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliExitError(
      `Opensteer MCP transport error: ${message}`,
      mayHaveEffect ? EXIT_UNKNOWN : EXIT_LOCAL,
    );
  }
  const nextSessionId = response.headers.get("mcp-session-id") || sessionId;
  if (!response.ok) {
    let parsedError = null;
    try {
      parsedError = text.trim() ? JSON.parse(text) : null;
    } catch {
      parsedError = null;
    }
    const refusedBeforeEffect =
      [400, 401, 403, 404].includes(response.status) &&
      !isOutcomeUnknownPayload(parsedError) &&
      !isOutcomeUnknownText(text);
    throw new CliExitError(
      `Opensteer MCP HTTP ${response.status}: ${text || response.statusText}`,
      mayHaveEffect
        ? refusedBeforeEffect
          ? EXIT_REFUSED
          : EXIT_UNKNOWN
        : response.status >= 500 ||
            isOutcomeUnknownPayload(parsedError) ||
            isOutcomeUnknownText(text)
          ? EXIT_UNKNOWN
          : EXIT_REFUSED,
    );
  }
  try {
    return {
      body: parseRpcPayload(text, response.headers.get("content-type") || ""),
      sessionId: nextSessionId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliExitError(
      `Opensteer MCP response parse error: ${message}`,
      mayHaveEffect ? EXIT_UNKNOWN : EXIT_LOCAL,
    );
  }
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
    throw new CliExitError("OPENSTEER_MCP_URL and OPENSTEER_MCP_TOKEN must be set.", EXIT_LOCAL);
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
      throw new CliExitError(
        init.body.error.message || "MCP initialize failed",
        isOutcomeUnknownPayload(init.body.error) ? EXIT_UNKNOWN : EXIT_REFUSED,
      );
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
    process.exit(args.length === 0 ? EXIT_LOCAL : EXIT_OK);
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
        throw new CliExitError(
          response.body.error.message || "tools/list failed",
          isOutcomeUnknownPayload(response.body.error) ? EXIT_UNKNOWN : EXIT_REFUSED,
        );
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
      process.exit(EXIT_LOCAL);
    }
    const rawInput = args[2] !== undefined ? args[2] : (await readStdin()).trim();
    let toolArgs = {};
    if (rawInput.length > 0) {
      try {
        toolArgs = JSON.parse(rawInput);
      } catch (error) {
        throw new CliExitError(
          `Tool input must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          EXIT_LOCAL,
        );
      }
      if (toolArgs === null || typeof toolArgs !== "object" || Array.isArray(toolArgs)) {
        throw new CliExitError("Tool input JSON must be an object.", EXIT_LOCAL);
      }
    }
    const result = await withSession(async (url, token, sessionId) => {
      const response = await mcpRequest(
        url,
        token,
        sessionId,
        {
          id: 2,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: toolArgs, name },
        },
        { mayHaveEffect: true },
      );
      if (response.body?.error) {
        const rpcCode = response.body.error.code;
        const payloadCode = errorCodeFromPayload(response.body.error);
        const provablyNoEffect =
          !isOutcomeUnknownPayload(response.body.error) &&
          !isOutcomeUnknownText(response.body.error.message) &&
          (rpcCode === -32601 ||
            rpcCode === -32602 ||
            (payloadCode !== null && PROVABLY_NO_EFFECT_CODES.has(payloadCode)));
        throw new CliExitError(
          response.body.error.message || `Tool ${name} failed`,
          provablyNoEffect ? EXIT_REFUSED : EXIT_UNKNOWN,
        );
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
      process.exit(isProvablyNoEffectToolError(result, serialized) ? EXIT_REFUSED : EXIT_UNKNOWN);
    }
    process.stdout.write(`${serialized}\n`);
    return;
  }

  usage();
  process.exit(EXIT_LOCAL);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(error instanceof CliExitError ? error.exitCode : EXIT_LOCAL);
});
