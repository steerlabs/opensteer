import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AgentGrant, ThreadAccessMode, UserId } from "@opensteer/core";
import { AgentConnectionStore, type OpensteerStore } from "@opensteer/database";
import { randomBytes } from "node:crypto";
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
    }) as unknown as Transport,
  );
  return {
    id: record.id,
    /** One tool call as the agent reads it. */
    call: async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as {
        readonly isError?: boolean;
        readonly content?: readonly { readonly type: string; readonly text?: string }[];
        readonly structuredContent?: Record<string, unknown>;
      },
    close: async () => {
      await client.close().catch(() => undefined);
    },
  };
}
