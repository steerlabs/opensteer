import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AgentGrant, ThreadAccessMode, UserId } from "@opensteer/core";
import { AgentConnectionStore, type OpensteerStore } from "@opensteer/database";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import {
  connectionCredentialPrefix,
  credentialHash,
} from "../mcp/connections/connection-authenticator.js";
import { mcpResourcePath } from "../mcp/connections/connection-oauth.js";

/**
 * A connected agent of the Home's owner, signed in over MCP to a real Host with `grant`, as the
 * consent page leaves one: its row active, its bearer on every request.
 */
export async function connectAgent(
  host: { readonly origin: string | URL; readonly ownerId: UserId; readonly store: OpensteerStore },
  grant: AgentGrant,
  accessMode: ThreadAccessMode = "full-access",
  route: {
    /** Where requests go when the Home's origin is reached through its tunnel (loopback here). */
    readonly via?: string | URL;
    /** How long one tool call may take (the client's own bound). */
    readonly callTimeoutMs?: number;
  } = {},
) {
  const connections = new AgentConnectionStore(host.store.database);
  const record = await connections.create({
    userId: host.ownerId,
    label: "Data app agent",
    clientName: "Data app agent",
    accessMode,
    resource: new URL(mcpResourcePath, host.origin).href,
    expiresAt: new Date(Date.now() + 60 * 60_000),
    grant,
  });
  const token = `${connectionCredentialPrefix}${randomBytes(32).toString("base64url")}`;
  if (!(await connections.activate(record.id, credentialHash(token))))
    throw new Error("The connection did not activate");
  const client = new Client({ name: "data-app-agent", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpResourcePath, host.origin), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      ...(route.via ? { fetch: tunnelFetch(new URL(route.via)) } : {}),
    }) as unknown as Transport,
  );
  return {
    id: record.id,
    /** One tool call as the agent reads it. */
    call: async (name: string, args: Record<string, unknown>) =>
      (await client.callTool(
        { name, arguments: args },
        undefined,
        route.callTimeoutMs ? { timeout: route.callTimeoutMs } : undefined,
      )) as {
        readonly isError?: boolean;
        readonly content?: readonly { readonly type: string; readonly text?: string }[];
        readonly structuredContent?: Record<string, unknown>;
      },
    /** The connection's tool list, as its client is sent it. */
    tools: async () => (await client.listTools()).tools,
    close: async () => {
      await client.close().catch(() => undefined);
    },
  };
}

/**
 * Requests to the Home's canonical origin delivered over loopback, as its tunnel delivers them:
 * the origin's host in `Host`, https in `x-forwarded-proto` (fetch itself cannot set `Host`).
 */
function tunnelFetch(via: URL): typeof fetch {
  return async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    headers.set("host", target.host);
    headers.set("x-forwarded-proto", "https");
    const body =
      init?.body === undefined || init.body === null ? undefined : String(init.body as string);
    return await new Promise<Response>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: via.hostname,
          port: via.port,
          path: `${target.pathname}${target.search}`,
          method: init?.method ?? "GET",
          headers: Object.fromEntries(headers.entries()),
          ...(init?.signal ? { signal: init.signal } : {}),
        },
        (incoming) => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers))
            if (value !== undefined)
              responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
          const status = incoming.statusCode ?? 500;
          resolve(
            new Response(
              status === 204 || status === 304
                ? null
                : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
              { status, headers: responseHeaders },
            ),
          );
        },
      );
      outgoing.once("error", reject);
      if (body !== undefined) outgoing.write(body);
      outgoing.end();
    });
  };
}
