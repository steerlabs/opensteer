import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export async function callMcpTool(
  origin: string | URL,
  token: string,
  name: string,
  args: Record<string, unknown>,
) {
  const client = new Client({ name: "host-tool-integration", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/internal/v1/mcp", origin), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }) as unknown as Transport,
      { timeout: 10000 },
    );
    return await client.callTool({ name, arguments: args }, undefined, { timeout: 10000 });
  } finally {
    await client.close();
  }
}
