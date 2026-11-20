import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { createId, OpensteerError, type Thread, type ToolOutput } from "@opensteer/core";
import type { AgentToolActivityStore } from "@opensteer/database";
import { agentToolHostRoutePath } from "@opensteer/protocol/agent-tool-relay";
import type { RunCaller } from "./agent-caller.js";
import { OpensteerMcpService } from "./opensteer-mcp-service.js";
import { registerAgentToolRoute } from "./agent-tool-route.js";
import type { ToolCall } from "./handlers/types.js";
import { withTimeout } from "@opensteer/shared/withTimeout";

type ToolCallRow = Awaited<ReturnType<AgentToolActivityStore["complete"]>>["call"] & {
  readonly arguments: unknown;
  readonly argumentDigest: Buffer | null;
  readonly provisional: boolean;
  readonly output: ToolOutput | null;
};
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function fixture() {
  const thread = {
    id: createId("thread"),
    environmentId: createId("environment"),
    accessMode: "full-access",
    purpose: "task",
    teamOrigin: null,
  } as Thread;
  const caller: RunCaller = {
    kind: "run",
    key: "run:root",
    userId: createId("user"),
    accessMode: "full-access",
    thread,
    claims: {
      runId: createId("run"),
      threadId: thread.id,
      environmentId: thread.environmentId,
      bindingGeneration: 1,
    } as RunCaller["claims"],
  };
  let live = true;
  const callers = {
    authenticate: vi.fn(async (token: string) => {
      if (token !== "run-token" || !live) throw new Error("Unauthorized");
      return caller;
    }),
  };
  const handler = vi.fn(async (_call: ToolCall<"computer_apps">) => ({
    total: 0,
    nextCursor: null,
  }));
  const service = new OpensteerMcpService({
    callers,
    handlers: { computer_apps: handler },
    store: {
      getThreadForOwner: async () => thread,
      threadOrigins: async () => new Map(),
      requests: { get: async () => null },
    },
    publicUrl: new URL("http://host.test"),
  });
  const saved = new Map<string, ToolCallRow>();
  const activity = {
    start: vi.fn<AgentToolActivityStore["start"]>(async (context, callId, name, args) => {
      const handle = { toolCallId: callId, origin: "host-harness" } as const;
      const previous = saved.get(callId);
      if (previous)
        return {
          handle,
          replay: true,
          completed: previous.output
            ? { output: previous.output, isError: previous.isError === true }
            : null,
        };
      saved.set(callId, {
        id: callId,
        callId,
        ...context,
        nodeId: null,
        attemptId: null,
        origin: handle.origin,
        status: "open",
        tool: { namespace: "opensteer", name },
        arguments: args,
        argumentDigest: null,
        provisional: false,
        integration: null,
        startedAt: new Date(),
        completedAt: null,
        completionOrder: null,
        output: null,
        isError: null,
      });
      return { handle, replay: false, completed: null };
    }),
    complete: vi.fn<AgentToolActivityStore["complete"]>(async (handle, output, isError) => {
      const previous = saved.get(handle.toolCallId)!;
      if (previous.status !== "open") return { call: previous, completed: false };
      const call = {
        ...previous,
        status: "completed" as const,
        completedAt: new Date(),
        output,
        isError,
      };
      saved.set(call.id, call);
      return { call, completed: true };
    }),
  };
  let changed: (() => void) | undefined;
  const app = Fastify();
  apps.push(app);
  registerAgentToolRoute(app, {
    callers,
    service,
    activity,
    realtime: {
      observeScopes: (_scopes, listener) => {
        changed = listener;
        return () => {
          changed = undefined;
          return true;
        };
      },
    },
  });
  const call = (
    input: Record<string, unknown>,
    token = "run-token",
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method: "POST",
      url: agentToolHostRoutePath,
      headers: { authorization: `Bearer ${token}`, ...headers },
      payload: input,
    });
  return {
    app,
    caller,
    service,
    handler,
    activity,
    saved,
    call,
    stop: () => {
      live = false;
      changed?.();
    },
  };
}

it("derives the Run from its token and matches MCP success, input, unknown-tool and tool-failure results", async () => {
  const f = fixture();
  const cases = [
    ["computer_apps", { query: "mail", cursor: "2" }],
    ["computer_apps", { unexpected: true }],
    ["missing", {}],
  ] as const;
  for (const [name, input] of cases) {
    const callId = crypto.randomUUID();
    const response = await f.call({ callId, name, input });
    expect(response.json()).toEqual(
      await f.service.callToolResult("run-token", name, input, { operationKey: `mcp:${callId}` }),
    );
  }
  expect([...f.saved.values()].map(({ status }) => status)).toEqual([
    "completed",
    "completed",
    "completed",
  ]);
  expect([...f.saved.values()][1]?.arguments).toBeNull();
  expect(f.handler.mock.calls[0]![0].input).toMatchObject({ cursor: 2, limit: 20, query: "mail" });
  expect(f.handler.mock.calls[0]![0].caller).toEqual(f.caller);
  expect(
    (
      await f.call({
        callId: crypto.randomUUID(),
        name: "computer_apps",
        input: { query: "mail" },
        caller: { kind: "connection" },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await f.call(
        { callId: crypto.randomUUID(), name: "computer_apps", input: { query: "mail" } },
        "foreign-token",
      )
    ).statusCode,
  ).toBe(401);
  f.handler.mockRejectedValueOnce(
    new OpensteerError({ code: "forbidden", message: "Access ended" }),
  );
  const refused = (
    await f.call({
      callId: crypto.randomUUID(),
      name: "computer_apps",
      input: { query: "mail" },
    })
  ).json();
  expect(refused).toMatchObject({
    isError: true,
    structuredContent: { error: { code: "access_denied", message: "Access ended", next: null } },
  });
  expect(JSON.parse(refused.content[0].text)).toEqual(refused.structuredContent);
});

it("joins in-flight retries, persists a single pair and replays without another effect", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>();
  f.handler.mockImplementation(async () => {
    entered.resolve();
    await held.promise;
    return { total: 0, nextCursor: null };
  });
  const request = {
    callId: crypto.randomUUID(),
    name: "computer_apps",
    input: { query: "mail" },
  };
  const first = f.call(request);
  await withTimeout(entered.promise, 1000, {
    timeoutError: () => new Error("Tool handler did not start"),
  });
  const second = f.call(request);
  held.resolve();
  expect((await first).json()).toEqual((await second).json());
  const replay = await f.call(request);
  expect(replay.json()).toMatchObject({ structuredContent: { total: 0 } });
  expect(f.handler).toHaveBeenCalledTimes(1);
  expect([...f.saved.values()]).toMatchObject([
    { status: "completed", startedAt: expect.any(Date) },
  ]);
  expect([...f.saved.values()][0]).toMatchObject({
    callId: `harness:${f.caller.claims.runId}:1:${request.callId}`,
    arguments: { query: "mail", limit: 20 },
  });
});

it.each(["Stop", "deadline"])(
  "%s aborts a pending handler, persists cancellation, and prevents its deferred effect",
  async (reason) => {
    const f = fixture();
    const entered = Promise.withResolvers<void>(),
      continueWork = Promise.withResolvers<void>();
    let effected = false;
    const settled = Promise.withResolvers<void>();
    f.handler.mockImplementation(async (call) => {
      try {
        entered.resolve();
        await continueWork.promise;
        await call.checkLive?.();
        effected = true;
        return { total: 0, nextCursor: null };
      } finally {
        settled.resolve();
      }
    });
    const pending = f.call(
      {
        callId: crypto.randomUUID(),
        name: "computer_apps",
        input: { query: "mail" },
      },
      "run-token",
      reason === "deadline" ? { "x-opensteer-deadline": String(Date.now() + 250) } : {},
    );
    await withTimeout(entered.promise, 1000, {
      timeoutError: () => new Error("Tool handler did not start"),
    });
    if (reason === "Stop") f.stop();
    const response = await withTimeout(Promise.resolve(pending), 1000, {
      timeoutError: () => new Error("Stop did not abort the pending tool call"),
    });
    expect(response.json()).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "outcome_unknown" } },
    });
    continueWork.resolve();
    await withTimeout(settled.promise, 1000, {
      timeoutError: () => new Error("Cancelled handler did not settle"),
    });
    expect(effected).toBe(false);
    expect([...f.saved.values()]).toMatchObject([
      { status: "completed", startedAt: expect.any(Date) },
    ]);
  },
);
