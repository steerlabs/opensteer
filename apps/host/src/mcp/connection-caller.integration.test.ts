import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { agentTools } from "@opensteer/agent-tools";
import { createId, type ThreadAccessMode } from "@opensteer/core";
import {
  AgentConnectionStore,
  AgentOperationReceipts,
  type OpensteerStore,
} from "@opensteer/database";
import { describeStore, testModelSelection } from "@opensteer/database/test-support/store";
import { createTestWorkspace } from "@opensteer/database/test-support/workspace";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, expect } from "vitest";
import { AgentCallerResolver } from "./agent-caller.js";
import {
  ConnectionAuthenticator,
  connectionCredentialPrefix,
  credentialHash,
} from "./connections/connection-authenticator.js";
import { mcpResourceMetadataPath, mcpResourcePath } from "./connections/connection-oauth.js";
import { agentToolHandlers } from "./handlers/index.js";
import { ProductToolHandlers } from "./handlers/product.js";
import { OpensteerMcpService } from "./opensteer-mcp-service.js";

const servers: Server[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await withTimeout(
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
      2000,
      { timeoutError: () => new Error("MCP test server did not close") },
    );
  }
});

/** The real Host spine for connected agents: the store, resolver and MCP service. */
async function serveMcp(store: OpensteerStore) {
  const unavailable = new Proxy(
    {},
    {
      get: () => async () => {
        throw new Error("Unexpected tool");
      },
    },
  );
  const product = new ProductToolHandlers({
    store,
    isEnvironmentConnected: () => true,
  } as unknown as ConstructorParameters<typeof ProductToolHandlers>[0]);
  let service!: OpensteerMcpService;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString();
      const token = request.headers.authorization?.slice(7) ?? "";
      // As the Host route does once the connection routes accepted the credential.
      await service.handle(
        request,
        response,
        text ? JSON.parse(text) : undefined,
        token,
        token.startsWith(connectionCredentialPrefix) ? url.origin : undefined,
      );
    })().catch((error: unknown) =>
      response.destroy(error instanceof Error ? error : new Error("MCP test failed")),
    );
  });
  servers.push(server);
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    }),
    2000,
    { timeoutError: () => new Error("MCP test server did not listen") },
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP test did not listen");
  const url = new URL(`http://127.0.0.1:${address.port}${mcpResourcePath}`);
  service = new OpensteerMcpService({
    callers: new AgentCallerResolver({
      store,
      runs: {
        authenticate: async () => {
          throw new Error("Not a Run");
        },
      },
      connections: new ConnectionAuthenticator(new AgentConnectionStore(store.database)),
    }),
    handlers: agentToolHandlers({
      product,
      integrations: unavailable as never,
      triggers: unavailable as never,
      apps: unavailable as never,
      pluginInstall: async () => {
        throw new Error("Unexpected install");
      },
    }),
    receipts: new AgentOperationReceipts(store.database),
    store,
    publicUrl: new URL("http://runtime.invalid"),
  });
  return url;
}

async function connection(
  store: OpensteerStore,
  url: URL,
  input: {
    readonly userId: Parameters<AgentConnectionStore["create"]>[0]["userId"];
    readonly accessMode: ThreadAccessMode;
    readonly reach: Parameters<AgentConnectionStore["create"]>[0]["reach"];
  },
) {
  const connections = new AgentConnectionStore(store.database);
  const record = await connections.create({
    ...input,
    label: "Test agent",
    clientName: "Test agent",
    resource: url.href,
    expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
  });
  const token = `${connectionCredentialPrefix}${randomBytes(32).toString("base64url")}`;
  expect(await connections.activate(record.id, credentialHash(token))).toBe(true);
  const client = new Client({ name: "connected-agent", version: "1" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }) as unknown as Transport,
    { timeout: 5000 },
  );
  return { client, id: record.id, revoke: () => connections.revoke(input.userId, record.id) };
}

function errorText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  expect(result.isError).toBe(true);
  const [first] = result.content as { type: string; text: string }[];
  return first?.text ?? "";
}

describeStore("connected agents on the Opensteer MCP", (it) => {
  it("lists only connection tools and refuses a revoked connection on its open session", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-tools");
    const url = await serveMcp(storeFixture.store);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      reach: { kind: "user" },
    });
    const listed = (await agent.client.listTools()).tools.map(({ name }) => name);
    expect(listed).toEqual(
      agentTools.filter((tool) => tool.callers.includes("connection")).map(({ name }) => name),
    );
    expect(listed).not.toContain("thread_write");

    const read = await agent.client.callTool({
      name: "thread_read",
      arguments: { threadId: f.thread.id },
    });
    expect(read.isError).not.toBe(true);
    expect(read.structuredContent).toMatchObject({ thread: { id: f.thread.id } });

    await agent.revoke();
    // The open session's next request is refused before any tool runs.
    await expect(
      agent.client.callTool({ name: "thread_read", arguments: { threadId: f.thread.id } }),
    ).rejects.toThrow("Agent tools authorization is invalid or expired");
  });

  it("keeps a Workspace connection inside it and an approval-required one out of full-access changes", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-reach");
    const { thread: fullAccess } = await storeFixture.store.createThread({
      accessMode: "full-access",
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      idempotencyKey: "connection-full-access",
      modelSelection: testModelSelection,
      title: "Full access",
      workspaceId: f.workspace.id,
    });
    const project = await createTestWorkspace(storeFixture.store, {
      createdBy: f.userId,
      name: "Client",
      kind: "project",
      idempotencyKey: "connection-project",
      status: "ready",
      backing: {
        kind: "local-directory",
        ownerEnvironmentId: f.environmentId,
        storageAuthorityId: createId("storageAuthority"),
        bindingId: createId("workspaceBinding"),
        generation: 1,
      },
    });
    const url = await serveMcp(storeFixture.store);

    const scoped = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      reach: { kind: "workspace", workspaceId: project.id },
    });
    expect(
      errorText(
        await scoped.client.callTool({
          name: "thread_read",
          arguments: { threadId: f.thread.id },
        }),
      ),
    ).toBe("Target Thread is outside the caller's reach");
    const listed = await scoped.client.callTool({ name: "thread_list", arguments: {} });
    expect(listed.isError).not.toBe(true);
    expect(JSON.stringify(listed.structuredContent)).not.toContain(f.thread.id);
    expect(
      errorText(
        await scoped.client.callTool({
          name: "thread_list",
          arguments: { workspaceId: f.workspace.id },
        }),
      ),
    ).toBe("Caller can list Threads only in its Workspace");

    const cautious = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "approval-required",
      reach: { kind: "user" },
    });
    expect(
      errorText(
        await cautious.client.callTool({
          name: "thread_write",
          arguments: { threadId: fullAccess.id, input: { title: "Renamed" } },
        }),
      ),
    ).toContain("thread_write");
    expect(
      errorText(
        await cautious.client.callTool({ name: "project_create", arguments: { name: "Sneaky" } }),
      ),
    ).toBe("Changing settings requires full-access");
    expect((await storeFixture.store.getThreadForOwner(fullAccess.id, f.userId))?.title).toBe(
      "Full access",
    );
  });

  it("challenges an unauthenticated connection with its resource metadata", async ({
    storeFixture,
  }) => {
    const url = await serveMcp(storeFixture.store);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${connectionCredentialPrefix}${"x".repeat(43)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${url.origin}${mcpResourceMetadataPath}"`,
    );
  });
});
