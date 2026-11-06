import { connectionInstructions, toolsFor } from "@opensteer/agent-tools";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  createId,
  OpensteerError,
  type Thread,
  type Request,
  shortRequestHoldMs,
  requestHoldLimitMs,
} from "@opensteer/core";
import { MANAGED_MEMORY_WAKE_SKIPPED } from "@opensteer/triggers";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentCaller, RunCaller } from "./agent-caller.js";
import type { AgentToolHandlers } from "./handlers/index.js";
import { RequestHold } from "./request-hold.js";
import { requestPendingGuidance } from "@opensteer/shared/requestGuidance";
import { OpensteerMcpService } from "./opensteer-mcp-service.js";
import { ProductToolHandlers } from "./handlers/product.js";

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
  const personMessage = vi.fn(
    async (_call: import("./handlers/index.js").ToolCall<"person_message">) => ({
      messageId,
      unnamedSecret: "private",
    }),
  );
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
  const changes = new Set<
    Parameters<import("@opensteer/orchestration").RealtimeHub["observe"]>[0]
  >();
  const holdSnapshot = vi.fn<
    ConstructorParameters<typeof RequestHold>[0]["store"]["requests"]["holdSnapshot"]
  >(async () => null);
  const markToolDelivered = vi.fn(async () => "delivered" as const);
  const outcome = vi.fn(async (request: Request) =>
    request.status === "pending" ? null : { request, text: `Answered ${request.status}` },
  );
  const stopHeldRun = vi.fn(async () => null);
  const options = {
    realtime: {
      observe: (
        listener: Parameters<import("@opensteer/orchestration").RealtimeHub["observe"]>[0],
      ) => {
        changes.add(listener);
        return () => {
          changes.delete(listener);
        };
      },
    },
    callers: {
      authenticate: vi.fn(async (token: string) => {
        const caller = callers.get(token);
        if (!caller) throw new Error("expired");
        return caller;
      }),
    },
    handlers,

    store: {
      requests: {
        get: vi.fn(async () => null),
        holdSnapshot,
        markToolDelivered,
        personSteerCount: vi.fn(async () => 0),
      },
      getThreadForOwner: async (id: Thread["id"]) => targets.get(id) ?? null,
      findMainWorkspaceForOwner: async () => undefined,
      getAssignmentForOwner: async () => null,
    },
    publicUrl: new URL("http://127.0.0.1"),
    onToolError: vi.fn(),
  };
  const configuredOptions = {
    ...options,
    longRequestHold: vi.fn(async (_caller: RunCaller) => false),
    requestHold: new RequestHold({
      store: { ...options.store, stopHeldRun },
      continuations: { outcome },
      onStopped: vi.fn(),
    }),
  };
  return {
    holdSnapshot,
    markToolDelivered,
    outcome,
    stopHeldRun,
    change: () => {
      for (const listener of changes) listener({ type: "host.tasks-changed" });
    },
    thread,
    run,
    callers,
    targets,
    handlers,
    personMessage,
    options: configuredOptions,
    service: new OpensteerMcpService(configuredOptions),
  };
}
async function httpFixture() {
  const f = fixture();
  await f.service.close();
  let service: OpensteerMcpService;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString();
      const token = request.headers.authorization?.slice(7) ?? "";
      const body = text ? JSON.parse(text) : undefined;
      await service.handle(
        request,
        response,
        body,
        token,
        token === "connection" ? service.options.publicUrl.origin : undefined,
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
  it.each([
    "pending",
    "pending-active",
    "settled",
    "live",
    "other-run",
    "integration",
    "program",
  ] as const)("keeps non-held results and pending guidance compatible (%s)", async (state) => {
    const f = await httpFixture();
    const requestId = createId("request");
    Object.assign(f.options.store.requests, {
      get: vi.fn(async () => ({
        id: requestId,
        mode: state === "live" ? "live" : "durable",
        status: state === "settled" ? "fulfilled" : "pending",
        originatingRunId: state === "other-run" ? createId("run") : f.run.claims.runId,
      })),
    });
    const pending = { requestId, kind: "browser.access", status: "pending", replayed: false };
    Object.assign(f.handlers, {
      sign_in: async () => pending,
      browser_profile_request: async () => pending,
      integration_request: async () => pending,
      integration_call: async () => ({
        content: [{ type: "text", text: JSON.stringify(pending) }],
        structuredContent: pending,
      }),
    });
    try {
      let sessionId = "detached-parking-test";
      if (state === "pending-active") {
        const initialized = await fetch(f.url, {
          method: "POST",
          headers: {
            authorization: "Bearer run",
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "parking", version: "1" },
            },
          }),
        });
        sessionId = initialized.headers.get("mcp-session-id")!;
        await initialized.arrayBuffer();
      }
      const response = await fetch(f.url, {
        method: "POST",
        headers: {
          authorization: state === "program" ? "Bearer program" : "Bearer run",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": sessionId,
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "pending-call",
          method: "tools/call",
          params:
            state === "program"
              ? {
                  name: "integration_request",
                  arguments: { catalog: "google-gmail", access: "read", reason: "Read email" },
                }
              : state === "integration"
                ? {
                    name: "integration_call",
                    arguments: {
                      toolRef:
                        "igr_00000000-0000-4000-8000-000000000001.itl_00000000-0000-4000-8000-000000000001.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                      arguments: {},
                    },
                  }
                : state === "settled"
                  ? { name: "sign_in", arguments: { site: "example.com", reason: "Check email" } }
                  : {
                      name: "browser_profile_request",
                      arguments: {
                        reason: "Check email",
                        suggestion: { kind: "new", suggestedName: "Personal" },
                      },
                    },
        }),
      });
      const body = await response.json();
      expect(body.error).toBeUndefined();
      expect(body.result.isError, JSON.stringify(body)).not.toBe(true);
      expect(response.headers.get("x-opensteer-request-pending")).toBeNull();
      if (state.startsWith("pending"))
        expect(body.result.content.map((part: { text: string }) => part.text).join("\n")).toContain(
          requestPendingGuidance,
        );
      if (state === "integration") expect(f.options.store.requests.get).not.toHaveBeenCalled();
    } finally {
      await f.service.close();
    }
  });
  it.each([false, true])(
    "holds a Request until answered, including an early answer (%s)",
    async (early) => {
      const f = await httpFixture();
      const request = {
        id: createId("request"),
        status: early ? "declined" : "pending",
        payload: { kind: "browser.access" },
      } as Request;
      const read = Promise.withResolvers<void>();
      f.holdSnapshot.mockImplementation(async () => {
        read.resolve();
        return {
          request,
          run: { status: "running", phase: "turn", voiceSessionId: null },
          steered: false,
          queued: false,
        };
      });
      Object.assign(f.handlers, {
        browser_profile_request: async () => ({
          requestId: request.id,
          kind: "browser.access",
          status: "pending",
          replayed: false,
        }),
      });
      f.options.longRequestHold.mockResolvedValue(true);
      const client = await connect(f.url, "run");
      f.options.longRequestHold.mockResolvedValue(false);
      const wait = vi.spyOn(f.options.requestHold, "wait");
      try {
        let returned = false;
        const call = client
          .callTool(
            {
              name: "browser_profile_request",
              arguments: { reason: "Read email", suggestion: { kind: "user_choice" } },
            },
            undefined,
            { timeout: 2000 },
          )
          .then((result) => {
            returned = true;
            return result;
          });
        await withTimeout(read.promise, 1000, {
          timeoutError: () => new Error("Hold never read its Request"),
        });
        if (!early) expect(returned).toBe(false);
        Object.assign(request, { status: "declined" });
        const result = await call;
        expect(result).toMatchObject({
          structuredContent: { status: "declined" },
          content: [expect.anything(), { type: "text", text: "Answered declined" }],
        });
        expect(f.markToolDelivered).toHaveBeenCalledOnce();
        expect(wait.mock.calls[0]?.[0].limitMs).toBe(requestHoldLimitMs);
      } finally {
        await client.close();
        await f.service.close();
      }
    },
  );

  it("counts handler work against the absolute short hold deadline", async () => {
    const f = await httpFixture();
    const request = {
      id: createId("request"),
      status: "pending",
      payload: { kind: "browser.access" },
    } as Request;
    f.holdSnapshot.mockResolvedValue({
      request,
      run: { status: "running", phase: "turn", voiceSessionId: null },
      steered: false,
      queued: false,
    });
    const realNow = Date.now;
    const clock = vi.spyOn(Date, "now");
    Object.assign(f.handlers, {
      browser_profile_request: async () => {
        clock.mockImplementation(() => realNow() + shortRequestHoldMs);
        return {
          requestId: request.id,
          kind: "browser.access",
          status: "pending",
          replayed: false,
        };
      },
    });
    const client = await connect(f.url, "run");
    try {
      const result = await client.callTool(
        {
          name: "browser_profile_request",
          arguments: { reason: "Read email", suggestion: { kind: "user_choice" } },
        },
        undefined,
        { timeout: 2000 },
      );
      expect(result.isError).toBe(true);
      expect(f.stopHeldRun).toHaveBeenCalledWith(f.run.claims, "limit");
    } finally {
      clock.mockRestore();
      await client.close();
      await f.service.close();
    }
  });

  it.each(["run", "short-run", "program", "connection"])(
    "selects SSE only for a long-hold Run on stateful and detached sessions (%s)",
    async (kind) => {
      const f = await httpFixture();
      f.options.longRequestHold.mockResolvedValue(kind === "run");
      const token = kind === "short-run" ? "run" : kind;
      const post = (body: object, sessionId?: string) =>
        fetch(f.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          },
          body: JSON.stringify(body),
        });
      try {
        const initialized = await post({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "transport", version: "1" },
          },
        });
        expect(initialized.headers.get("content-type")).toContain(
          kind === "run" ? "text/event-stream" : "application/json",
        );
        const sessionId = initialized.headers.get("mcp-session-id")!;
        await initialized.text();
        for (const id of [sessionId, "forgotten"]) {
          const response = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, id);
          expect(response.headers.get("content-type")).toContain(
            kind === "run" ? "text/event-stream" : "application/json",
          );
          await response.text();
        }
      } finally {
        await f.service.close();
      }
    },
  );

  it("keeps an active SSE response out of the idle sweep and starts idle time at completion", async () => {
    const f = await httpFixture();
    f.options.longRequestHold.mockResolvedValue(true);
    const created = vi.spyOn(f.service, "createServer");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.personMessage.mockImplementation(async () => {
      entered.resolve();
      await withTimeout(release.promise, 2000, {
        timeoutError: () => new Error("Held handler never released"),
      });
      return { messageId: createId("message"), unnamedSecret: "private" };
    });
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const post = (body: object, sessionId?: string) =>
      fetch(f.url, {
        method: "POST",
        headers: {
          authorization: "Bearer run",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify(body),
      });
    let heldBody: Promise<string> | undefined;
    try {
      const initialized = await post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "idle", version: "1" },
        },
      });
      const sessionId = initialized.headers.get("mcp-session-id")!;
      await initialized.text();
      const response = await post(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "person_message", arguments: { message: "waiting" } },
        },
        sessionId,
      );
      heldBody = response.text();
      await withTimeout(entered.promise, 1000, {
        timeoutError: () => new Error("SSE handler never started"),
      });
      now += 31 * 60_000;
      await (await post({ jsonrpc: "2.0", id: 3, method: "tools/list" }, sessionId)).text();
      expect(created).toHaveBeenCalledOnce();
      release.resolve();
      expect(await heldBody).toContain("messageId");
      now += 29 * 60_000;
      await (await post({ jsonrpc: "2.0", id: 4, method: "tools/list" }, sessionId)).text();
      expect(created).toHaveBeenCalledOnce();
      now += 31 * 60_000;
      await (await post({ jsonrpc: "2.0", id: 5, method: "tools/list" }, sessionId)).text();
      expect(created).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      clock.mockRestore();
      await f.service.close();
      if (heldBody) await heldBody.catch(() => undefined);
    }
  });

  it("lists integration and product tools on the same Run server", async () => {
    const f = await httpFixture();
    const client = await connect(f.url, "run");
    try {
      const names = (await client.listTools(undefined, { timeout: 5000 })).tools.map((t) => t.name);
      expect(names).toEqual(toolsFor(f.run).map((t) => t.name));
      expect(names).not.toContain("thread_wait");
      expect(names).toContain("integration_call");
      expect(names).toContain("thread_delegate");
      expect(client.getServerVersion()?.name).toBe("opensteer");
      expect(client.getInstructions()).toBeUndefined();
    } finally {
      await client.close();
      await f.service.close();
    }
  });
  it("reserves internal capacity and bounds each connection including detached calls", async () => {
    const f = await httpFixture();
    const initialize = () =>
      fetch(f.url, {
        method: "POST",
        headers: {
          authorization: "Bearer connection",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "capacity", version: "1" },
          },
        }),
      });
    try {
      for (let i = 0; i < 8; i++) expect((await initialize()).status).toBe(200);
      expect((await initialize()).status).toBe(503);
      const client = await connect(f.url, "run");
      await client.close();
      const detached = await fetch(f.url, {
        method: "POST",
        headers: {
          authorization: "Bearer connection",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": "forgotten",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      expect(detached.status).toBe(503);
    } finally {
      await f.service.close();
    }
  });
  it("releases capacity when initialization fails without a session", async () => {
    const f = await httpFixture();
    try {
      for (let i = 0; i < 8; i++) {
        const response = await fetch(f.url, {
          method: "POST",
          headers: {
            authorization: "Bearer connection",
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        });
        expect(response.headers.get("mcp-session-id")).toBeNull();
        expect((await response.json()).error).toBeDefined();
      }
      const client = await connect(f.url, "connection");
      await client.close();
    } finally {
      await f.service.close();
    }
  });
  it("counts in-flight detached servers and frees revoked sessions", async () => {
    const f = await httpFixture();
    const finish = new Set<() => void>();
    f.handlers.thread_wait = async () =>
      new Promise((resolve) => {
        finish.add(() => resolve({ status: "timed_out", messages: [] }));
      });
    const send = () =>
      fetch(f.url, {
        method: "POST",
        headers: {
          authorization: "Bearer connection",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": "detached",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "thread_wait", arguments: { threadId: f.thread.id } },
        }),
      });
    const pending = Array.from({ length: 8 }, () => send());
    try {
      await vi.waitFor(() => expect(finish.size).toBe(8), { timeout: 2000 });
      expect((await send()).status).toBe(503);
      const caller = f.callers.get("connection")!;
      f.callers.delete("connection");
      const ended = Promise.allSettled(pending);
      f.change();
      expect((await ended).every((result) => result.status === "rejected")).toBe(true);
      f.callers.set("connection", caller);
      for (const resolve of finish) resolve();
      const client = await connect(f.url, "connection");
      await client.close();
    } finally {
      for (const resolve of finish) resolve();
      await f.service.close();
    }
  });
  it.each(["run", "connection"])(
    "preserves safe Request details for %s without exposing payloads or answers",
    async (token) => {
      const f = fixture();
      const request = {
        id: createId("request"),
        kind: "browser.password-sign-in",
        status: "pending",
        createdAt: new Date().toISOString(),
        originatingThreadId: f.thread.id,
        targetWorkspaceId: f.thread.workspaceId,
        presentation: { kind: "confirm", title: "Sign in to Example" },
        payload: {
          kind: "browser.password-sign-in",
          reason: "Check the account",
          loginSecret: "private-payload",
        },
        response: { password: "private-answer" },
      };
      const window = {
        hasMore: false,
        nextBefore: null,
        totalItems: 2,
        itemCount: 2,
        byteCount: 0,
      };
      const page = {
        requests: [
          request,
          {
            ...request,
            id: createId("request"),
            kind: "harness.input",
            payload: { kind: "harness.input" },
          },
        ],
        window,
      };
      const product = new ProductToolHandlers({
        store: {
          requests: {
            visiblePage: async () => page,
            connectionPage: async () => page,
            withdraw: async () => ({ request: { ...request, status: "withdrawn" }, events: [] }),
          },
        },
        onWorkspaceEvent: vi.fn(),
      } as unknown as ConstructorParameters<typeof ProductToolHandlers>[0]);
      f.handlers.request_list = (call) => product.request_list(call);
      f.handlers.request_withdraw = (call) => product.request_withdraw(call);
      try {
        const result = await f.service.callTool(
          token,
          "request_list",
          {},
          { operationKey: "list" },
        );
        expect(result).toMatchObject({
          requests: [
            { id: request.id, title: "Sign in to Example", reason: "Check the account" },
            { kind: "harness.input", reason: null },
          ],
          window,
        });
        expect(JSON.stringify(result)).not.toMatch(
          /private-payload|private-answer|presentation|payload|response/,
        );
        if (token === "run") {
          const withdrawn = await f.service.callTool(
            token,
            "request_withdraw",
            { requestId: request.id },
            { operationKey: "withdraw" },
          );
          expect(withdrawn).toMatchObject({
            request: {
              title: "Sign in to Example",
              reason: "Check the account",
              status: "withdrawn",
            },
          });
          expect(JSON.stringify(withdrawn)).not.toMatch(
            /private-payload|private-answer|payload|response/,
          );
        }
      } finally {
        await f.service.close();
      }
    },
  );
  it("resolves a caller once per HTTP request before invoking the tool", async () => {
    const f = await httpFixture();
    try {
      f.options.callers.authenticate.mockClear();
      const response = await fetch(f.url, {
        method: "POST",
        headers: {
          authorization: "Bearer run",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": "single-request",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "person_message", arguments: { message: "one authority" } },
        }),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).result.isError).not.toBe(true);
      expect(f.options.callers.authenticate).toHaveBeenCalledOnce();
    } finally {
      await f.service.close();
    }
  });
  it("filters settings and user-wide tools from the advertised inventory", async () => {
    const f = await httpFixture();
    const client = await connect(f.url, "connection");
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain("settings_write");
      expect(names).not.toContain("computer_list");
      expect(names).toContain("request_list");
    } finally {
      await client.close();
      await f.service.close();
    }
  });
  it("keeps safe image metadata and sends each image once", async () => {
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
      expect(result.content).toEqual([image]);
      expect(JSON.stringify(result)).not.toContain("surpriseSecret");
      // A screenshot is large; a structured copy would send it to the model twice.
      expect(result.structuredContent).toBeUndefined();
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
      expect(names).toContain("thread_wait");
      expect(client.getInstructions()).toBeUndefined();
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
  it("returns a program the exact skipped memory wake text it matches on", async () => {
    const f = await httpFixture();
    vi.mocked(f.handlers.thread_message).mockRejectedValueOnce(
      new OpensteerError({ code: "conflict", message: MANAGED_MEMORY_WAKE_SKIPPED }),
    );
    const client = await connect(f.url, "program");
    try {
      await expect(
        client.callTool({
          name: "thread_message",
          arguments: { delivery: "queue", message: "Light pass due", threadId: f.thread.id },
        }),
      ).resolves.toMatchObject({
        isError: true,
        content: [{ type: "text", text: MANAGED_MEMORY_WAKE_SKIPPED }],
      });
    } finally {
      await client.close();
      await f.service.close();
    }
  });
  it("gives a model the whole refusal in both halves of the result", async () => {
    const f = await httpFixture();
    vi.mocked(f.handlers.thread_message).mockRejectedValueOnce(
      new OpensteerError({
        code: "conflict",
        message: "That Thread is busy.",
        next: "Queue it with thread_message.",
        reason: "thread-busy",
      }),
    );
    const client = await connect(f.url, "run");
    try {
      const text = "That Thread is busy. Queue it with thread_message.";
      await expect(
        client.callTool({
          name: "thread_message",
          arguments: { delivery: "queue", message: "Hello", threadId: f.thread.id },
        }),
      ).resolves.toMatchObject({
        isError: true,
        content: [{ type: "text", text }],
        structuredContent: {
          error: { code: "conflict", message: text, reason: "thread-busy", retryable: false },
        },
      });
      expect(f.options.onToolError).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await f.service.close();
    }
  });
  it.each([
    ["request_list", {}, "Try once more"],
    [
      "thread_message",
      { delivery: "queue", message: "Hello" },
      "It may have taken effect, so check before retrying.",
    ],
  ] as const)(
    "keeps an unexpected failure out of %s's result and logs it",
    async (name, args, advice) => {
      const f = await httpFixture();
      const failure = new Error('relation "credentials" does not exist');
      Object.assign(f.handlers, {
        [name]: async () => {
          throw failure;
        },
      });
      const client = await connect(f.url, "run");
      try {
        const result = await client.callTool({
          name,
          arguments: name === "request_list" ? args : { ...args, threadId: f.thread.id },
        });
        expect(result).toMatchObject({
          isError: true,
          structuredContent: { error: { code: "internal", retryable: false } },
        });
        const text = (result.content as [{ text: string }])[0].text;
        expect(text).toContain(advice);
        expect(JSON.stringify(result)).not.toContain("credentials");
        expect(f.options.onToolError).toHaveBeenCalledWith(failure, name);
      } finally {
        await client.close();
        await f.service.close();
      }
    },
  );
  it("orients only connections on initialize and omits Run-only tools", async () => {
    const f = await httpFixture();
    const client = await connect(f.url, "connection");
    try {
      expect(client.getInstructions()).toBe(connectionInstructions);
      const names = (await client.listTools(undefined, { timeout: 5000 })).tools.map((t) => t.name);
      expect(names).toContain("thread_delegate");
      expect(names).toContain("thread_wait");
      expect(names).not.toContain("browser_profile_write");
      expect(names).not.toContain("computer");
      expect(names).not.toContain("sign_in");
      expect(names).not.toContain("person_message");
    } finally {
      await client.close();
      await f.service.close();
    }
  });
  it("strips unnamed output fields and leaves domain retry identity intact", async () => {
    const f = fixture();
    const input = { message: "sent once", operationKey: "stable" };
    expect(
      await f.service.callTool("run", "person_message", input, { operationKey: "rpc-1" }),
    ).not.toHaveProperty("unnamedSecret");
    await f.service.callTool("run", "person_message", input, { operationKey: "rpc-2" });
    expect(f.personMessage).toHaveBeenCalledTimes(2);
    expect(f.personMessage.mock.calls.map(([call]) => call.operationKey)).toEqual([
      "stable",
      "stable",
    ]);
  });
  it("rechecks live authority on a new call", async () => {
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
  it("reports a result outside its contract as the Host's failure, not the arguments'", async () => {
    const f = await httpFixture();
    f.handlers.integration_search = async () => ({ total: "many" }) as never;
    const client = await connect(f.url, "run");
    try {
      const result = await client.callTool(
        { name: "integration_search", arguments: { query: "notes" } },
        undefined,
        { timeout: 5000 },
      );
      expect(result).toMatchObject({ isError: true });
      const text = (result.content as [{ text: string }])[0].text;
      expect(text).toMatch(/^Opensteer hit an internal error\. /u);
      expect(text).not.toContain("invalid_arguments");
      // Where the result broke the contract goes to the log, never what it held.
      const [logged] = vi.mocked(f.options.onToolError).mock.calls[0]!;
      expect(String(logged)).toContain("total");
      expect(String(logged)).not.toContain("many");
    } finally {
      await client.close();
      await f.service.close();
    }
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
  it("uses the caller already authenticated by the resource route", async () => {
    const f = fixture();
    const caller = f.callers.get("connection")!;
    const response = { once: vi.fn(), statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
    await f.service.handle(
      { headers: { host: "127.0.0.1" }, method: "POST", auth: { extra: { caller } } } as never,
      response as never,
      {},
      "connection",
      f.options.publicUrl.origin,
    );
    expect(response.statusCode).toBe(400);
    expect(f.options.callers.authenticate).not.toHaveBeenCalled();
    await f.service.close();
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
