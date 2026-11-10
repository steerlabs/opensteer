import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentCallerKind } from "@opensteer/agent-tools";
import { OpensteerMcpService } from "../mcp/opensteer-mcp-service.js";
import type { AgentCaller } from "../mcp/agent-caller.js";

export async function measureMcpContext(kind: AgentCallerKind) {
  const unavailable = new Proxy(
    {},
    {
      get: () => {
        throw new Error("Registration accessed a handler dependency");
      },
    },
  );
  const service = new OpensteerMcpService({
    publicUrl: new URL("http://localhost"),
    handlers: unavailable as never,
    callers: unavailable as never,
    store: unavailable as never,
    knowledge: true,
  });
  const server = service.createServer({
    kind,
    key: "context-budget",
    accessMode: "full-access",
    reach: { kind: "user" },
  } as AgentCaller);
  const client = new Client({ name: "context-budget", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const { tools } = await client.listTools();
    return {
      instructions: client.getInstructions() ?? "",
      toolsJson: JSON.stringify(
        tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      ),
    };
  } finally {
    await client.close();
    await server.close();
    await service.close();
  }
}
