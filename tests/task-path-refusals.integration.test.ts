import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
  type Transport,
} from "../apps/host/src/mcp/mcp-sdk-client.test-support.js";
import type { AgentGrant } from "../packages/core/src/index.js";
import { AgentConnectionStore } from "../packages/database/src/index.js";
import {
  connectionCredentialPrefix,
  credentialHash,
} from "../apps/host/src/mcp/connections/connection-authenticator.js";
import { mcpResourcePath } from "../apps/host/src/mcp/connections/connection-oauth.js";
import {
  acceptCallerRun,
  connectCallerMachine,
  createMachineAccessDatabase,
  startPrivateMachineHost,
  type CallerMachine,
  type PrivateMachineHost,
  waitForExecute,
} from "../apps/host/src/runtime/private-machine-host.test-support.js";
import { testRpcData, testRpcRequest } from "../apps/host/src/server/test-host-api-request.js";

/**
 * The refusals on the task path, on a real Home: its own runtime, store and HTTP mapping, and
 * its MCP endpoint for a connected agent. Each row is who asks, what, and the status, code and
 * words the Home answers with. For a connected agent, a task outside its grant reads exactly like
 * one that does not exist: the two answers are the same bytes.
 */
const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;
const missingTask = () => `thr_${randomUUID()}`;
const model = { modelId: "gpt-5.6-sol", options: { effort: "low" }, providerId: "openai" };

integration("the task path's refusals on a real Home", () => {
  let database: Awaited<ReturnType<typeof createMachineAccessDatabase>>;
  let host: PrivateMachineHost;
  let caller: CallerMachine;
  let ownerTask: string;
  const clients: Client[] = [];

  beforeAll(async () => {
    database = await createMachineAccessDatabase(process.env.OPENSTEER_TEST_DATABASE_URL!);
    host = await startPrivateMachineHost(database.url);
    caller = await connectCallerMachine(host, {
      name: "Studio Mac",
      token: host.hostingRunnerEnrollmentToken,
    });
    const created = await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        environmentId: caller.environmentId,
        harnessInstanceId: caller.harnessInstanceId,
        idempotencyKey: "owner-task",
        modelSelection: model,
        title: "The person's own task",
        type: "thread.create",
      },
      { headers: host.ownerHeaders },
    );
    if (created.type !== "thread.create") throw new Error("Thread command mismatch.");
    ownerTask = created.thread.id;
  }, 60_000);
  afterAll(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await caller?.close();
    await host?.close();
    await database?.drop();
  });

  /** A command as the person's app sends it: the HTTP status and the body, exactly. */
  async function person(command: Readonly<Record<string, unknown>>) {
    const response = await testRpcRequest(
      host.origin,
      "commands.dispatch",
      { idempotencyKey: randomUUID(), ...command } as never,
      { headers: host.ownerHeaders },
    );
    return { status: response.status, body: (await response.json()) as unknown };
  }

  /** A connected agent signed in over MCP, holding this grant. */
  async function agent(grant: AgentGrant) {
    const endpoint = new URL(mcpResourcePath, host.origin);
    const connections = new AgentConnectionStore(host.store.database);
    const record = await connections.create({
      userId: host.ownerId,
      label: "Research assistant",
      clientName: "Research assistant",
      resource: endpoint.href,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      accessMode: "full-access",
      grant,
    });
    const token = connectionCredentialPrefix + randomBytes(32).toString("base64url");
    expect(await connections.activate(record.id, credentialHash(token))).toBe(true);
    const client = new Client({ name: "connected-agent", version: "1" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }) as unknown as Transport,
      { timeout: 10_000 },
    );
    return client;
  }

  const refused = (status: number, code: string, message: string) => ({
    status,
    body: { ok: false, error: { code, message, retryable: false } },
  });

  it.each([
    {
      what: "change the AI engine of a task that does not exist",
      command: () => ({
        type: "thread.execution.update",
        threadId: missingTask(),
        harnessInstanceId: caller.harnessInstanceId,
        modelSelection: model,
      }),
      answer: refused(404, "not_found", "Thread not found"),
    },
    {
      what: "change a task's AI engine to one its computer does not have",
      command: () => ({
        type: "thread.execution.update",
        threadId: ownerTask,
        harnessInstanceId: `hin_${randomUUID()}`,
        modelSelection: model,
      }),
      answer: refused(409, "conflict", "AI engine is unavailable"),
    },
    {
      what: "steer a waiting message of a task that does not exist",
      command: () => ({
        type: "thread.input.steer",
        threadId: missingTask(),
        messageId: `msg_${randomUUID()}`,
        expectedRunId: `run_${randomUUID()}`,
      }),
      answer: refused(404, "not_found", "Thread not found"),
    },
    {
      what: "rename a task that does not exist",
      command: () => ({ type: "thread.rename", threadId: missingTask(), title: "Renamed" }),
      answer: refused(404, "not_found", "Thread not found"),
    },
    {
      what: "mark a task that does not exist Done",
      command: () => ({ type: "thread.done.set", threadId: missingTask(), done: true }),
      answer: refused(404, "not_found", "Task not found"),
    },
    {
      what: "reopen a task that does not exist",
      command: () => ({ type: "thread.done.set", threadId: missingTask(), done: false }),
      answer: refused(404, "not_found", "Task not found"),
    },
    {
      what: "start a task under a parent that does not exist",
      command: () => ({
        type: "thread.create",
        environmentId: caller.environmentId,
        harnessInstanceId: caller.harnessInstanceId,
        modelSelection: model,
        parentThreadId: missingTask(),
        title: "A child",
      }),
      answer: refused(404, "not_found", "Parent thread not found"),
    },
    {
      what: "send a browser page to a task that does not exist",
      command: () => ({
        type: "thread.sendMessage",
        threadId: missingTask(),
        delivery: "queue",
        content: [
          {
            type: "browser-page",
            sessionId: `bsn_${randomUUID()}`,
            tabId: "tab-1",
            title: "A page",
            url: "https://example.com/",
          },
        ],
      }),
      answer: refused(404, "not_found", "Thread not found"),
    },
  ])("you: $what", async ({ command, answer }) => {
    expect(await person(command())).toEqual(answer);
  });

  /** An MCP session with this bearer, at this address. */
  async function mcp(url: URL, bearer: string) {
    const client = new Client({ name: "task-path", version: "1" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${bearer}` } },
      }) as unknown as Transport,
      { timeout: 10_000 },
    );
    return client;
  }

  /** The tool's answer for a task outside the caller's reach and for one that does not exist. */
  async function outsideAndMissing(client: Client, name: string, args: Record<string, unknown>) {
    const missing = missingTask();
    const outside = await client.callTool({ name, arguments: { ...args, taskId: ownerTask } });
    const absent = await client.callTool({ name, arguments: { ...args, taskId: missing } });
    return { outside: JSON.stringify(outside).replaceAll(ownerTask, missing), absent };
  }

  const tasks: AgentGrant = { scope: "selected", tasks: true, resources: [] };
  /** "Task is unavailable", as an agent tool answers it, with no advice. */
  const unavailable = (code: string) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: { code, message: "Task is unavailable", next: null } }),
      },
    ],
    structuredContent: { error: { code, message: "Task is unavailable", next: null } },
    isError: true,
  });

  describe("a connected agent", () => {
    it("is answered the same for a task outside its grant as for one that does not exist: interrupt", async () => {
      const client = await agent(tasks);
      const { outside, absent } = await outsideAndMissing(client, "opensteer_task_interrupt", {});
      expect(outside).toBe(JSON.stringify(absent));
      expect(absent).toEqual(unavailable("not_found"));
    });

    it("is answered the same for an invalid request to a tool it does not hold as to one that does not exist", async () => {
      const client = await agent(tasks);
      const held = (await client.listTools()).tools.map((tool: { name: string }) => tool.name);
      // A connected agent's own surface: resume and the queue are a Run's, not its own.
      expect(held).not.toContain("opensteer_task_resume");
      const invalid = { unexpected: true };
      const notHeld = await client.callTool({ name: "opensteer_task_resume", arguments: invalid });
      const absent = await client.callTool({ name: "opensteer_no_such_tool", arguments: invalid });
      expect(
        JSON.stringify(notHeld).replaceAll("opensteer_task_resume", "opensteer_no_such_tool"),
      ).toBe(JSON.stringify(absent));
      expect(absent).toEqual({
        content: [
          { type: "text", text: "MCP error -32602: Tool opensteer_no_such_tool not found" },
        ],
        isError: true,
      });
    });
  });

  describe("a Run in a connected agent's lineage", () => {
    let run: Client;
    beforeAll(async () => {
      const client = await agent(tasks);
      const executed = waitForExecute(caller.primary.socket);
      const created = await client.callTool({
        name: "opensteer_task_create",
        arguments: { title: "The agent's task", message: "Work on it", operationKey: "lineage" },
      });
      expect(created.isError, JSON.stringify(created.content)).not.toBe(true);
      const taken = await acceptCallerRun(host, caller, await executed);
      run = await mcp(new URL(taken.integrationTools.url), taken.toolsToken);
    }, 60_000);
    const messageId = `msg_${randomUUID()}`;
    it.each([
      { what: "resume", name: "opensteer_task_resume", args: {} },
      { what: "interrupt", name: "opensteer_task_interrupt", args: {} },
      {
        what: "cancel a waiting message",
        name: "opensteer_task_queue",
        args: { action: "cancel", messageId },
      },
      {
        what: "move a waiting message",
        name: "opensteer_task_queue",
        args: { action: "move", messageId, beforeMessageId: null },
      },
    ])(
      "is answered the same for a task outside its lineage as for one that does not exist: $what",
      async ({ name, args }) => {
        const { outside, absent } = await outsideAndMissing(run, name, args);
        expect(outside).toBe(JSON.stringify(absent));
        // A Run is told access_denied where the connected agent itself is told not_found.
        expect(absent).toEqual(unavailable("access_denied"));
      },
    );
  });

  // Last: it needs the task's computer gone.
  it("you: change a task's AI engine, keeping its conversation, while its computer is away", async () => {
    await caller.close();
    expect(
      await person({
        type: "thread.execution.update",
        threadId: ownerTask,
        harnessInstanceId: caller.harnessInstanceId,
        modelSelection: model,
        continuation: { expectedProviderSessionId: null },
      }),
    ).toEqual(
      refused(
        409,
        "conflict",
        "Connect an updated Runner before changing this conversation's AI engine",
      ),
    );
  });
});
