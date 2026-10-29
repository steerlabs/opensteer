// Derived from github.com/UsefulSoftwareCo/executor packages/plugins/mcp/src/sdk/discover.ts and invoke.ts (MIT).
import { createHash } from "node:crypto";
import {
  renderAuthPlacements,
  type AdapterHealthResult,
  type AdapterToolDefinition,
  type AdapterToolResult,
  type IntegrationAdapter,
} from "@opensteer/integration-core";
import { errorResult, isAbortError, timeoutResult } from "../shared.js";
import { connectMcp, listAllMcpTools, type McpSession } from "./connection.js";
import { McpConnectionPool, mcpErrorStatus } from "./connection-pool.js";
import { McpAdapterConfigSchema, type McpAdapterConfig } from "./config.js";

const connectionPool = new McpConnectionPool<McpSession>();

export function closeMcpAdapterConnections(): Promise<void> {
  return connectionPool.close();
}

function toolDefinition(tool: Record<string, unknown>): AdapterToolDefinition {
  const name = String(tool.name ?? "tool");
  return {
    annotations:
      typeof tool.annotations === "object" && tool.annotations !== null
        ? (tool.annotations as Record<string, unknown>)
        : {},
    description: typeof tool.description === "string" ? tool.description : `MCP tool ${name}`,
    inputSchema:
      typeof tool.inputSchema === "object" && tool.inputSchema !== null
        ? (tool.inputSchema as Record<string, unknown>)
        : { type: "object", properties: {} },
    name,
    ...(typeof tool.outputSchema === "object" && tool.outputSchema !== null
      ? { outputSchema: tool.outputSchema as Record<string, unknown> }
      : {}),
  };
}

function poolKey(
  config: McpAdapterConfig,
  connectionId: string | undefined,
  credentialValues: Readonly<Record<string, string>>,
  rendered: ReturnType<typeof renderAuthPlacements>,
): string {
  if (connectionId) return `connection:${connectionId}`;
  return createHash("sha256")
    .update(
      JSON.stringify({
        endpoint:
          config.transport === "remote"
            ? config.endpoint
            : `${config.command}\0${config.args?.join("\0") ?? ""}`,
        credentials: Object.entries(credentialValues).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
        placements: {
          env: Object.entries(rendered.env).sort(([left], [right]) => left.localeCompare(right)),
          headers: Object.entries(rendered.headers).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
          query: Object.entries(rendered.query).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        },
      }),
    )
    .digest("base64url");
}

function deadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`MCP operation timed out after ${timeoutMs}ms`);
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

async function discover(
  config: McpAdapterConfig,
  fetch_: typeof globalThis.fetch,
  credentialValues: Readonly<Record<string, string>> = {},
  placements: Parameters<typeof renderAuthPlacements>[0] = [],
): Promise<readonly Record<string, unknown>[]> {
  const rendered = renderAuthPlacements(placements, credentialValues);
  const session = await deadline(
    connectMcp({
      config,
      env: rendered.env,
      fetch: fetch_,
      headers: rendered.headers,
      query: rendered.query,
    }),
    config.timeoutMs,
  );
  try {
    return await deadline(listAllMcpTools(session), config.timeoutMs);
  } finally {
    await session.close().catch(() => undefined);
  }
}

function mcpFailure(cause: unknown): AdapterToolResult {
  const status = mcpErrorStatus(cause);
  if (status === 401)
    return errorResult("connection_rejected", "The MCP server rejected the connection", { status });
  if (status === 403)
    return errorResult("oauth_scope_insufficient", "The MCP OAuth grant lacks a required scope", {
      status,
    });
  if (isAbortError(cause) || status === 408) return timeoutResult("The MCP operation timed out");
  return errorResult(
    "upstream_http_error",
    cause instanceof Error ? cause.message : "MCP operation failed",
    status ? { status } : undefined,
  );
}

export function createMcpAdapter(
  fetch_: typeof globalThis.fetch = globalThis.fetch,
): IntegrationAdapter {
  return {
    kind: "mcp",
    parseConfig(config: unknown): McpAdapterConfig {
      return McpAdapterConfigSchema.parse(config);
    },
    credentialDisclosure(config: unknown) {
      const parsed = McpAdapterConfigSchema.parse(config);
      return {
        check: true,
        destinations: parsed.transport === "remote" ? [new URL(parsed.endpoint).origin] : [],
      };
    },
    async snapshotConfig(config: unknown) {
      return McpAdapterConfigSchema.parse(config);
    },
    async resolveTools(input) {
      const config = McpAdapterConfigSchema.parse(input.config);
      // A listed tool is self-contained: any `$defs` it has stay inside its own schemas.
      return {
        definitions: {},
        tools: (
          await discover(config, fetch_, input.credentialValues ?? {}, input.placements ?? [])
        ).map((tool) => toolDefinition(tool)),
      };
    },
    async invokeTool(input): Promise<AdapterToolResult> {
      const config = McpAdapterConfigSchema.parse(input.config);
      let rendered: ReturnType<typeof renderAuthPlacements>;
      try {
        rendered = renderAuthPlacements(input.placements, input.credentialValues);
      } catch (cause) {
        return errorResult(
          "connection_rejected",
          cause instanceof Error ? cause.message : "Credential rendering failed",
        );
      }
      try {
        const result = await deadline(
          connectionPool.withConnection(
            poolKey(config, input.connectionId, input.credentialValues, rendered),
            () =>
              connectMcp({
                config,
                env: rendered.env,
                fetch: fetch_,
                headers: rendered.headers,
                query: rendered.query,
              }),
            // The server validates arguments against the tool it lists; its error reaches the agent.
            (session) =>
              deadline(
                session.client.callTool({ name: input.toolName, arguments: input.args }),
                config.timeoutMs,
              ),
          ),
          config.timeoutMs,
        );
        if (
          typeof result === "object" &&
          result !== null &&
          "isError" in result &&
          result.isError === true
        ) {
          return errorResult(
            "upstream_http_error",
            `MCP tool ${input.toolName} returned an error`,
            {
              result,
            },
          );
        }
        return { kind: "ok", value: result };
      } catch (cause) {
        return mcpFailure(cause);
      }
    },
    async checkHealth(input): Promise<AdapterHealthResult> {
      const config = McpAdapterConfigSchema.parse(input.config);
      try {
        const rendered = renderAuthPlacements(input.placements, input.credentialValues);
        const session = await deadline(
          connectMcp({
            config,
            env: rendered.env,
            fetch: fetch_,
            headers: rendered.headers,
            query: rendered.query,
          }),
          config.timeoutMs,
        );
        try {
          await deadline(listAllMcpTools(session), config.timeoutMs);
          return { healthy: true };
        } finally {
          await session.close().catch(() => undefined);
        }
      } catch (cause) {
        return {
          healthy: false,
          detail: cause instanceof Error ? cause.message : "MCP health check failed",
        };
      }
    },
  };
}

export const mcpAdapter = createMcpAdapter((target, init) => globalThis.fetch(target, init));
