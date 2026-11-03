import { withTimeout } from "@opensteer/shared/withTimeout";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createId, type Thread } from "@opensteer/core";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentCaller, RunCaller } from "./agent-caller.js";
import type { AgentToolHandlers } from "./handlers/index.js";
import { OpensteerMcpService } from "./opensteer-mcp-service.js";
import { MemoryOperationReceipts } from "./receipts.test-support.js";

const servers: Server[] = [];
afterEach(async () => {
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
function fixture() {
  const thread = {
    id: createId("thread"),
    workspaceId: createId("workspace"),
    lineageRootThreadId: createId("thread"),
    accessMode: "auto",
    environmentId: createId("environment"),
  } as Thread;
  const userId = createId("user");
  const run: RunCaller = {
    kind: "run",
    key: `run:${createId("run")}`,
    userId,
    accessMode: thread.accessMode,
    reach: { kind: "workspace", workspaceId: thread.workspaceId },
    thread,
    claims: {
      runId: createId("run"),
      threadId: thread.id,
      requestedBy: userId,
      workspaceId: thread.workspaceId,
      environmentId: thread.environmentId,
    } as RunCaller["claims"],
  };
  const callers = new Map<string, AgentCaller>([
    ["run", run],
    [
      "program",
      {
        kind: "program",
        key: "trigger:occurrence",
        userId,
        accessMode: thread.accessMode,
        reach: run.reach,
        anchor: thread,
        program: { kind: "trigger" } as never,
      },
    ],
    [
      "connection",
      {
        kind: "connection",
        key: "connection:mcn_test",
        connectionId: "mcn_test",
        userId,
        accessMode: thread.accessMode,
        reach: run.reach,
      },
    ],
  ]);
  const targets = new Map([[thread.id, thread]]);
  const messageId = createId("message");
  const personMessage = vi.fn(async () => ({ messageId, unnamedSecret: "private" }));
  const handlers = {
    person_message: personMessage,
    project_list: vi.fn(async () => ({
      projects: [],
      window: { byteCount: 0, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 },
    })),
    thread_message: vi.fn(async () => {
      throw new Error("Unexpected effect");
    }),
    plugin_install: vi.fn(async () => {
      throw new Error("Unexpected effect");
    }),
    integration_search: vi.fn(async () => ({ total: 0, nextOffset: null })),
  } as unknown as AgentToolHandlers;
  const options = {
    callers: {
      authenticate: vi.fn(async (token: string) => {
        const caller = callers.get(token);
        if (!caller) throw new Error("expired");
        return caller;
      }),
    },
    handlers,
    receipts: new MemoryOperationReceipts(),
    store: {
      getThreadForOwner: async (id: Thread["id"]) => targets.get(id) ?? null,
      findMainWorkspaceForOwner: async () => undefined,
      getAssignmentForOwner: async () => null,
    },
    publicUrl: new URL("http://127.0.0.1"),
  };
  return {
    thread,
    run,
    callers,
    targets,
    handlers,
    personMessage,
    options,
    service: new OpensteerMcpService(options),
  };
}
async function httpFixture() {
  const f = fixture();
  let service: OpensteerMcpService;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString();
      const token = request.headers.authorization?.slice(7) ?? "";
      await service.handle(request, response, text ? JSON.parse(text) : undefined, token);
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
  const url = new URL(`http://127.0.0.1:${address.port}/internal/v1/mcp`);
  service = new OpensteerMcpService({ ...f.options, publicUrl: url });
  return { ...f, service, url };
}
async function connect(url: URL, token: string) {
  const client = new Client({ name: "mcp-spine-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }) as unknown as Transport,
    { timeout: 5000 },
  );
  return client;
}
describe("Opensteer MCP spine", () => {
  it("lists integration and product tools on the same Run server", async () => {
    const f = await httpFixture();
    const client = await connect(f.url, "run");
    try {
      const names = (await client.listTools(undefined, { timeout: 5000 })).tools.map((t) => t.name);
      expect(names).toHaveLength(44);
      expect(names).toContain("integration_call");
      expect(names).toContain("thread_delegate");
      expect(client.getServerVersion()?.name).toBe("opensteer");
    } finally {
      await client.close();
      await f.service.close();
    }
  });
  it("keeps safe image metadata in native and structured MCP results", async () => {
    const f = await httpFixture();
    const image = {
      type: "image" as const,
      data: "aW1hZ2U=",
      mimeType: "image/png",
      _meta: { "codex/imageDetail": "original" as const },
    };
    f.handlers.computer = async () => ({
      content: [{ ...image, _meta: { ...image._meta, surpriseSecret: "hidden" } }],
    });
    const client = await connect(f.url, "run");
    try {
      const result = await client.callTool(
        { name: "computer", arguments: { code: "observe" } },
        undefined,
        { timeout: 5000 },
      );
      expect(result.content).toContainEqual(image);
      expect(result.structuredContent).toEqual({ content: [image] });
    } finally {
      await client.close();
      await f.service.close();
    }
  });
  it("lists only program tools and refuses a Run-only tool even if named directly", async () => {
    const f = await httpFixture();
    const client = await connect(f.url, "program");
    try {
      const names = (await client.listTools(undefined, { timeout: 5000 })).tools.map((t) => t.name);
      expect(names).toContain("thread_delegate");
      expect(names).toContain("integration_search");
      expect(names).not.toContain("computer");
      expect(names).not.toContain("person_show");
      await expect(
        f.service.callTool("program", "person_message", { message: "hi" }, { operationKey: "p" }),
      ).rejects.toThrow("unavailable to this caller");
      expect(f.personMessage).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await f.service.close();
    }
  });
  it("strips an unnamed secret and replays an operationKey across JSON-RPC identities", async () => {
    const f = fixture();
    const input = { message: "sent once", operationKey: "stable" };
    const result = await f.service.callTool("run", "person_message", input, {
      operationKey: "rpc-1",
    });
    expect(result).not.toHaveProperty("unnamedSecret");
    expect(f.options.callers.authenticate).toHaveBeenCalledTimes(1);
    for (const receipt of f.options.receipts.results.values()) {
      receipt.result.unnamedSecret = "stored before this projection";
    }
    expect(
      await f.service.callTool("run", "person_message", input, { operationKey: "rpc-2" }),
    ).toEqual({ messageId: result.messageId });
    expect(f.options.callers.authenticate).toHaveBeenCalledTimes(2);
    expect(f.personMessage).toHaveBeenCalledTimes(1);
    await expect(
      f.service.callTool(
        "run",
        "person_message",
        { ...input, message: "changed" },
        { operationKey: "rpc-3" },
      ),
    ).rejects.toThrow("different input");
  });
  it("fingerprints canonical input while preserving a nested operationKey", async () => {
    const f = fixture();
    const call = vi.fn<AgentToolHandlers["integration_call"]>(async () => ({
      content: [{ type: "text", text: "done" }],
    }));
    f.handlers.integration_call = call;
    const toolRef =
      "igr_11111111-1111-4111-8111-111111111111.itl_22222222-2222-4222-8222-222222222222." +
      "a".repeat(43);
    await f.service.callTool(
      "run",
      "integration_call",
      { toolRef, arguments: { b: 2, a: { operationKey: "nested" } }, operationKey: "canonical" },
      { operationKey: "1" },
    );
    await f.service.callTool(
      "run",
      "integration_call",
      { operationKey: "canonical", arguments: { a: { operationKey: "nested" }, b: 2 }, toolRef },
      { operationKey: "2" },
    );
    expect(call).toHaveBeenCalledTimes(1);
    await expect(
      f.service.callTool(
        "run",
        "integration_call",
        { toolRef, arguments: { a: { operationKey: "changed" }, b: 2 }, operationKey: "canonical" },
        { operationKey: "3" },
      ),
    ).rejects.toThrow("different input");
  });
  it("rechecks live authority on receipt replay", async () => {
    const f = fixture();
    const input = { message: "once", operationKey: "stable" };
    await f.service.callTool("run", "person_message", input, { operationKey: "1" });
    f.callers.delete("run");
    await expect(
      f.service.callTool("run", "person_message", input, { operationKey: "2" }),
    ).rejects.toThrow("expired");
    expect(f.personMessage).toHaveBeenCalledTimes(1);
  });
  it("refuses a target outside reach before its handler", async () => {
    const f = fixture();
    const target = { ...f.thread, id: createId("thread"), workspaceId: createId("workspace") };
    f.targets.set(target.id, target);
    await expect(
      f.service.callTool(
        "run",
        "thread_message",
        { threadId: target.id, message: "hello", delivery: "queue" },
        { operationKey: "reach" },
      ),
    ).rejects.toThrow("outside the caller's reach");
    expect(f.handlers.thread_message).not.toHaveBeenCalled();
  });
  it("refuses a stronger target Thread before its handler", async () => {
    const f = fixture();
    const target = { ...f.thread, id: createId("thread"), accessMode: "full-access" as const };
    f.targets.set(target.id, target);
    await expect(
      f.service.callTool(
        "run",
        "thread_message",
        { threadId: target.id, message: "hello", delivery: "report" },
        { operationKey: "mode" },
      ),
    ).rejects.toThrow("stronger access mode");
    expect(f.handlers.thread_message).not.toHaveBeenCalled();
  });
  it("requires full-access for settings", async () => {
    const f = fixture();
    await expect(
      f.service.callTool(
        "run",
        "plugin_install",
        { directory: "plugin" },
        { operationKey: "settings" },
      ),
    ).rejects.toThrow("requires full-access");
    expect(f.handlers.plugin_install).not.toHaveBeenCalled();
  });
  it("checks input before running a handler", async () => {
    const f = fixture();
    await expect(
      f.service.callTool(
        "run",
        "person_message",
        { message: "hi", attribution: "spoofed" },
        { operationKey: "invalid" },
      ),
    ).rejects.toThrow();
    expect(f.personMessage).not.toHaveBeenCalled();
  });
  it("serves a forgotten session with the current request's live token", async () => {
    const f = await httpFixture();
    const client = await connect(f.url, "run");
    try {
      await f.service.close();
      const result = await client.callTool({
        name: "person_message",
        arguments: { message: "after restart" },
      });
      expect(result.isError).not.toBe(true);
      expect(f.personMessage).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await f.service.close();
    }
  });
  it("refuses a bad Host or Origin and expired credentials", async () => {
    const f = fixture();
    for (const [headers, status] of [
      [{ host: "evil.test" }, 403],
      [{ host: "127.0.0.1", origin: "https://evil.test" }, 403],
      [{ host: "127.0.0.1" }, 401],
    ] as const) {
      const response = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
      await f.service.handle(
        { headers, method: "POST" } as never,
        response as never,
        {},
        "expired",
      );
      expect(response.statusCode).toBe(status);
    }
  });
  it("keeps connection credentials and Run credentials on their own routes", async () => {
    const f = fixture();
    const route = "https://connect.example";
    for (const [token, host, connectionOrigin, status] of [
      ["connection", "127.0.0.1", undefined, 403],
      ["run", "connect.example", route, 403],
      ["expired", "connect.example", route, 401],
    ] as const) {
      const response = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
      await f.service.handle(
        { headers: { host }, method: "POST" } as never,
        response as never,
        {},
        token,
        connectionOrigin,
      );
      expect(response.statusCode).toBe(status);
      if (status === 401)
        expect(response.setHeader).toHaveBeenCalledWith(
          "www-authenticate",
          `Bearer resource_metadata="${route}/.well-known/oauth-protected-resource/internal/v1/mcp"`,
        );
    }
  });
});
