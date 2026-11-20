import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentGrant, ThreadAccessMode } from "@opensteer/core";
import type { AgentCallerKind } from "@opensteer/agent-tools";
import { OpensteerMcpService } from "../mcp/opensteer-mcp-service.js";
import type { AgentCaller } from "../mcp/agent-caller.js";

export async function measureMcpContext(
  kind: AgentCallerKind,
  options?: {
    grant?: AgentGrant;
    accessMode?: ThreadAccessMode;
    connectionPasswords?: ConstructorParameters<
      typeof OpensteerMcpService
    >[0]["connectionPasswords"];
  },
) {
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
    ...(options?.connectionPasswords === undefined
      ? {}
      : { connectionPasswords: options.connectionPasswords }),
    callers: unavailable as never,
    store: unavailable as never,
  });
  const server = await service.createServer({
    kind,
    key: "context-budget",
    accessMode: options?.accessMode ?? "full-access",
    ...(kind === "run" ? { thread: { teamOrigin: null } } : {}),
    ...(kind === "connection"
      ? { grant: options?.grant ?? { scope: "everything" }, grantRevision: 1 }
      : {}),
  } as unknown as AgentCaller);
  const client = new Client({ name: "context-budget", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const { tools } = await client.listTools();
    return {
      instructions: client.getInstructions() ?? "",
      tools,
      toolsJson: JSON.stringify(
        kind === "connection"
          ? tools
          : tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      ),
    };
  } finally {
    await client.close();
    await server.close();
    await service.close();
  }
}
