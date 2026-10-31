import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createId,
  RunnerCapabilitySchema,
  type AgentCapabilityProfileId,
  type Thread,
  type Workspace,
} from "@opensteer/core";
import { AgentToolsMcpService } from "./agent-tools-mcp-service.js";
import { IntegrationToolsMcpService } from "../integrations/integration-tools-mcp-service.js";
import type { AgentControlRunScope } from "./agent-control-service.js";

type AgentOptions = ConstructorParameters<typeof AgentToolsMcpService>[0];
type IntegrationOptions = ConstructorParameters<typeof IntegrationToolsMcpService>[0];

export async function measureMcpContext(profileId: AgentCapabilityProfileId) {
  // Measure the complete eligible inventory, including negotiated tools, without executing handlers.
  const unavailable = new Proxy(
    {},
    {
      get: () => {
        throw new Error("Registration accessed a handler dependency");
      },
    },
  );
  const threadId = createId("thread");
  const run = { threadId, requestedBy: createId("user") } as AgentControlRunScope;
  const product = new AgentToolsMcpService({
    allowMainChatRunScreenShow: true,
    runnerCapabilities: async () => RunnerCapabilitySchema.options,
    agentControl: unavailable as AgentOptions["agentControl"],
    publicUrl: new URL("http://localhost"),
    store: {
      getThreadForOwner: async () =>
        ({ id: threadId, role: "conversation", capabilityProfileId: profileId }) as Thread,
      findMainWorkspaceForOwner: async () => ({ homeThreadId: threadId }) as Workspace,
    },
    tokens: unavailable as AgentOptions["tokens"],
  });
  const integrations = new IntegrationToolsMcpService({
    definitions: [],
    getWorkspaceForOwner: async () => {
      throw new Error("Registration accessed a Workspace");
    },
    onWorkspaceEvent: () => {
      throw new Error("Registration emitted an event");
    },
    platform: { computerToolEnabled: () => true } as unknown as IntegrationOptions["platform"],
    publicUrl: new URL("http://localhost"),
    runTokens: unavailable as IntegrationOptions["runTokens"],
    triggerTokens: unavailable as IntegrationOptions["triggerTokens"],
  });
  const servers = {
    product: await product.createServer({
      control: unavailable as AgentOptions["agentControl"],
      profileId,
      run,
      scope: "run",
      subjectId: "context-budget",
      toolContractVersion: null,
    }),
    integrations: integrations.createServer(
      (profileId === "trigger" ? {} : { runId: "context-budget" }) as Parameters<
        IntegrationToolsMcpService["createServer"]
      >[0],
    ),
  };
  const result: Record<string, { instructions: string; toolsJson: string }> = {};
  for (const [name, server] of Object.entries(servers)) {
    const client = new Client({ name: "context-budget", version: "1" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    try {
      if (name === "integrations") {
        const send = clientTransport.send.bind(clientTransport);
        clientTransport.send = (message, options) =>
          send(message, {
            ...options,
            authInfo: {
              token: "context-budget",
              clientId: "context-budget",
              scopes: [],
              extra: { scope: profileId === "trigger" ? {} : { runId: "context-budget" } },
            },
          });
      }
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      result[name] = {
        instructions: client.getInstructions() ?? "",
        toolsJson: JSON.stringify(
          tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        ),
      };
    } finally {
      await client.close();
      await server.close();
    }
  }
  return result;
}
