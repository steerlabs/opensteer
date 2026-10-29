// Derived from github.com/UsefulSoftwareCo/executor packages/plugins/mcp/src/sdk/connection.ts (MIT).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpAdapterConfig } from "./config.js";
import { mcpErrorStatus } from "./connection-pool.js";

export interface McpSession {
  readonly client: Client;
  readonly close: () => Promise<void>;
}

export class McpSessionError extends Error {
  readonly status: number | undefined;
  readonly transportFailure: boolean;

  constructor(
    message: string,
    options: { cause?: unknown; status?: number; transportFailure?: boolean } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "McpSessionError";
    this.status = options.status;
    this.transportFailure = options.transportFailure ?? true;
  }
}

type ClientTransport = Parameters<Client["connect"]>[0];

async function connected(transport: ClientTransport): Promise<McpSession> {
  const client = new Client({ name: "opensteer", version: "0.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    return { client, close: () => client.close() };
  } catch (cause) {
    await client.close().catch(() => undefined);
    const status = mcpErrorStatus(cause);
    throw new McpSessionError("Failed to connect to MCP server", {
      cause,
      ...(status !== undefined ? { status } : {}),
    });
  }
}

function endpoint(
  config: Extract<McpAdapterConfig, { transport: "remote" }>,
  query: Readonly<Record<string, string>>,
): URL {
  const url = new URL(config.endpoint);
  for (const [name, value] of Object.entries({ ...config.query, ...query }))
    url.searchParams.set(name, value);
  return url;
}

export async function connectMcp(input: {
  readonly config: McpAdapterConfig;
  readonly env?: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
}): Promise<McpSession> {
  if (input.config.transport === "stdio") {
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const processEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    return connected(
      new StdioClientTransport({
        command: input.config.command,
        ...(input.config.args ? { args: input.config.args } : {}),
        ...(input.config.cwd ? { cwd: input.config.cwd } : {}),
        env: { ...processEnv, ...input.config.env, ...input.env },
      }) as unknown as ClientTransport,
    );
  }
  const url = endpoint(input.config, input.query ?? {});
  const requestInit = {
    headers: { ...input.config.headers, ...input.headers },
    redirect: "manual" as const,
  };
  return connected(
    new StreamableHTTPClientTransport(url, {
      ...(input.fetch ? { fetch: input.fetch } : {}),
      requestInit,
    }) as unknown as ClientTransport,
  );
}

export async function listAllMcpTools(
  session: McpSession,
): Promise<readonly Record<string, unknown>[]> {
  const tools: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const response = await session.client.listTools(cursor ? { cursor } : undefined);
    tools.push(...response.tools);
    cursor = response.nextCursor;
    if (!cursor) return tools;
  }
  throw new McpSessionError("MCP tools/list exceeded 100 pages", { transportFailure: false });
}
