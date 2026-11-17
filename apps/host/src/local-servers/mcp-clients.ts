import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CredentialResponseRedactor } from "@opensteer/access/host";
import { refused } from "@opensteer/core";
import type { CallableIntegrationTool } from "@opensteer/database";
import { integrationSchemaDigest } from "@opensteer/integration-core/digest";
import type {
  IntegrationInstallationId,
  IntegrationServerId,
} from "@opensteer/integration-core/ids";
import type {
  IntegrationServer,
  IntegrationToolCatalog,
  IntegrationToolMaterial,
} from "@opensteer/integration-core/models";
import { createIntegrationId } from "@opensteer/integration-core/ids";
import { boundedToolDescription, boundedToolTitle } from "@opensteer/integration-core/tool-schemas";
import { ComputerMcpTransport } from "./computer-mcp-transport.js";

export const connectionTimeoutMs = 15_000;
export const toolCallTimeoutMs = 60_000;
export const maximumToolsPerServer = 2_000;
const maximumToolPages = 100;
const maximumToolResultBytes = 2 * 1_024 * 1_024;

/** An MCP client the Host holds, or is opening, for one of an installation's servers. */
export interface OpenClient {
  /** Aborted when the client is let go: an open under way ends where it is. */
  readonly cancel: AbortController;
  readonly client: Promise<UpstreamClient>;
  readonly installationId: IntegrationInstallationId;
}

export interface UpstreamClient {
  readonly client: Client;
  /** For a server a computer runs, its session's transport, which says why it ended. */
  readonly computer: ComputerMcpTransport | null;
  readonly fingerprint: string;
  /** Lets this client go, and not whichever client later holds its place. */
  readonly letGo: () => void;
}

export class McpClientPool {
  /**
   * Every MCP client the Host holds or is opening: by server and connection
   * for calls, and by server alone while a computer's server is listed.
   */
  readonly #clients = new Map<string, OpenClient>();
  readonly #onClientClosed: (client: Client) => void;
  #closed = false;

  constructor(options: { readonly onClientClosed: (client: Client) => void }) {
    this.#onClientClosed = options.onClientClosed;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * The client one call uses, shared with every other call on the same server
   * and connection while its approved launch stays current.
   */
  async client(
    callable: CallableIntegrationTool,
    connect: (signal: AbortSignal) => Promise<Client>,
  ): Promise<UpstreamClient> {
    const { server } = callable;
    const connectionId = callable.grant.connectionId;
    const key = `${server.id}:${connectionId ?? "deployment"}`;
    const fingerprint = integrationSchemaDigest({ connectionId, transport: server.transport });
    const current = this.#clients.get(key);
    if (current) {
      return current.client.then((value) => {
        if (value.fingerprint === fingerprint) return value;
        this.letGo(key, current);
        return this.client(callable, connect);
      });
    }
    return this.open(key, callable.installation.id, async (signal) => {
      const client = await connect(signal);
      return {
        client,
        // Kept here because the SDK lets go of a transport once it closes.
        computer: client.transport instanceof ComputerMcpTransport ? client.transport : null,
        fingerprint,
      };
    }).client;
  }

  /** Holds a client under `key` from the moment it starts opening. */
  open(
    key: string,
    installationId: IntegrationInstallationId,
    connect: (signal: AbortSignal) => Promise<Omit<UpstreamClient, "letGo">>,
  ): OpenClient {
    if (this.#closed) throw refused("conflict", "The integration platform has closed.");
    const cancel = new AbortController();
    const open: OpenClient = {
      cancel,
      client: connect(cancel.signal).then(
        (value) => {
          // A session that ended — a computer gone offline, a server that
          // stopped — leaves a client that can only fail, so it is not kept.
          value.client.onclose = () => {
            this.#onClientClosed(value.client);
            if (this.#clients.get(key) === open) this.#clients.delete(key);
          };
          return { ...value, letGo: () => this.letGo(key, open) };
        },
        (error: unknown) => {
          if (this.#clients.get(key) === open) this.#clients.delete(key);
          throw error;
        },
      ),
      installationId,
    };
    this.#clients.set(key, open);
    return open;
  }

  /** Lets a client go: one still opening stops there, and an open one closes. */
  letGo(key: string, open: OpenClient): void {
    if (this.#clients.get(key) === open) this.#clients.delete(key);
    open.cancel.abort();
    void open.client.then(({ client }) => client.close()).catch(() => undefined);
  }

  /**
   * An installation changed: every session its servers have open or are
   * opening ends — listings, and servers it retired or that wait on their
   * computer, included — and what is next opened reads it as it is now.
   */
  invalidateInstallation(installationId: IntegrationInstallationId): void {
    for (const [key, open] of this.#clients) {
      if (open.installationId === installationId) this.letGo(key, open);
    }
  }

  /** A server was removed or changed: every client of it goes, its listing included. */
  dropServer(serverId: IntegrationServer["id"] | IntegrationServerId): void {
    const prefix = `${serverId}:`;
    for (const [key, open] of this.#clients) {
      if (key.startsWith(prefix)) this.letGo(key, open);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const opens = [...this.#clients.values()];
    this.#clients.clear();
    for (const open of opens) open.cancel.abort();
    const settled = await Promise.allSettled(opens.map(({ client }) => client));
    await Promise.allSettled(
      settled.flatMap((result) =>
        result.status === "fulfilled" ? [result.value.client.close()] : [],
      ),
    );
  }
}

/**
 * Connects a client over its transport. Given up while opening, closing the
 * client ends its transport, which for a computer ends the session it is
 * starting there.
 */
export async function connectMcpClient(
  client: Client,
  transport: Transport,
  signal: AbortSignal | undefined,
  onFailure: (error: unknown) => unknown,
): Promise<Client> {
  const abandon = () => void client.close().catch(() => undefined);
  signal?.addEventListener("abort", abandon, { once: true });
  try {
    signal?.throwIfAborted();
    await client.connect(transport, {
      maxTotalTimeout: connectionTimeoutMs,
      timeout: connectionTimeoutMs,
    });
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw onFailure(error);
  } finally {
    signal?.removeEventListener("abort", abandon);
  }
}

/**
 * Every tool a server lists, page by page, as the Host records them. The
 * whole listing is bounded — by pages, by time, and by a cursor that comes
 * back — so a server that pages forever is refused rather than waited on.
 * An MCP tool's schema is self-contained, so a server's catalog shares nothing.
 */
export async function listTools(client: Client): Promise<readonly IntegrationToolMaterial[]> {
  const listed: Tool[] = [];
  const cursors = new Set<string>();
  const deadline = Date.now() + 4 * connectionTimeoutMs;
  let cursor: string | undefined;
  do {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || cursors.size >= maximumToolPages) {
      throw refused("conflict", "The MCP server did not finish listing its tools");
    }
    const page = await client.listTools(cursor === undefined ? undefined : { cursor }, {
      maxTotalTimeout: remaining,
      timeout: Math.min(connectionTimeoutMs, remaining),
    });
    listed.push(...page.tools);
    if (listed.length > maximumToolsPerServer) {
      throw refused("conflict", `MCP server exposes more than ${maximumToolsPerServer} tools`);
    }
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (cursors.has(cursor))
        throw refused("conflict", "The MCP server listed the same page twice");
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  return listed.map((tool): IntegrationToolMaterial => ({
    annotations: objectValue(tool.annotations ?? {}),
    connectionId: null,
    description: boundedToolDescription(tool.description),
    id: createIntegrationId("tool"),
    inputSchema: objectValue(tool.inputSchema),
    name: tool.name,
    outputSchema: tool.outputSchema ? objectValue(tool.outputSchema) : null,
    status: "active",
    title: boundedToolTitle(tool.title ?? tool.annotations?.title, tool.name),
  }));
}

export const emptyToolCatalog: IntegrationToolCatalog = { definitions: {}, tools: [] };

export function objectValue(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw refused("conflict", "MCP tool schema must be an object");
  }
  return value as Readonly<Record<string, unknown>>;
}

export function sanitizeToolResult<T>(
  result: T,
  responseRedactor: CredentialResponseRedactor | null,
): T {
  const serialized = JSON.stringify(result);
  if (serialized === undefined) throw refused("conflict", "Integration result is not serializable");
  if (Buffer.byteLength(serialized, "utf8") > maximumToolResultBytes) {
    throw refused("conflict", `Integration result exceeds ${maximumToolResultBytes} bytes`);
  }
  if (!responseRedactor) return result;
  // Secret numbers and booleans can be JSON scalars; preserve the MCP envelope.
  const redact = (value: unknown, protocol = false): unknown => {
    if (typeof value === "string") return responseRedactor.redactText(value);
    if (typeof value === "number" || typeof value === "boolean") {
      const text = String(value);
      const redacted = responseRedactor.redactText(text);
      return redacted === text ? value : redacted;
    }
    if (Array.isArray(value)) return value.map((entry) => redact(entry));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          protocol &&
          [
            "content",
            "structuredContent",
            "isError",
            "type",
            "text",
            "data",
            "mimeType",
            "_meta",
          ].includes(key)
            ? key
            : responseRedactor.redactText(key),
          protocol && (key === "type" || key === "isError")
            ? entry
            : protocol && key === "content" && Array.isArray(entry)
              ? entry.map((block) => redact(block, true))
              : redact(entry),
        ]),
      );
    return value;
  };
  return redact(JSON.parse(serialized), true) as T;
}

/** An MCP server's own error answer, as opposed to a connection that lost it. */
export function answeredMcpError(error: unknown): error is McpError {
  return (
    error instanceof McpError &&
    error.code !== ErrorCode.ConnectionClosed &&
    error.code !== ErrorCode.RequestTimeout
  );
}

export const safeMessageOptions = {
  fallback: "Integration operation failed",
  maximumLength: 1_000,
  singleLine: true,
} as const;
