import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import {
  AgentEventSchema,
  createId,
  OpensteerError,
  type AgentEvent,
  type Thread,
} from "@opensteer/core";
import { agentToolHostRoutePath } from "@opensteer/protocol/agent-tool-relay";
import type { RunCaller } from "./agent-caller.js";
import { OpensteerMcpService } from "./opensteer-mcp-service.js";
import { registerAgentToolRoute } from "./agent-tool-route.js";
import type { ToolCall } from "./handlers/types.js";
import { withTimeout } from "@opensteer/shared/withTimeout";

type Started = Extract<AgentEvent, { type: "tool.started" }>;
type Completed = Extract<AgentEvent, { type: "tool.completed" }>;
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
    store: { getThreadForOwner: async () => thread, requests: { get: async () => null } },
    publicUrl: new URL("http://host.test"),
  });
  const published: AgentEvent[] = [];
  const saved = new Map<string, { started: Started; completed: Completed | null }>();
  const activity = {
    start: vi.fn(
      async (
        context: { runId: string; threadId: string; environmentId: string },
        callId: string,
        name: string,
        args: unknown,
      ) => {
        const previous = saved.get(callId);
        if (previous) return { ...previous, replay: true };
        const started = AgentEventSchema.parse({
          ...context,
          type: "tool.started",
          eventId: createId("event"),
          sequence: "1",
          createdAt: new Date().toISOString(),
          data: { callId, tool: { namespace: "opensteer", name }, arguments: args },
        });
        if (started.type !== "tool.started") throw new Error("Wrong event");
        const pair = { started, completed: null };
        saved.set(callId, pair);
        return { ...pair, replay: false };
      },
    ),
    complete: vi.fn(async (started: Started, output: { text: string }, isError: boolean) => {
      const pair = saved.get(started.data.callId)!;
      if (pair.completed) return pair.completed;
      const completed = AgentEventSchema.parse({
        ...started,
        type: "tool.completed",
        eventId: createId("event"),
        sequence: "2",
        data: { callId: started.data.callId, output, isError },
      });
      if (completed.type !== "tool.completed") throw new Error("Wrong event");
      pair.completed = completed;
      return completed;
    }),
  };
  let changed: (() => void) | undefined;
  const app = Fastify();
  apps.push(app);
  registerAgentToolRoute(app, {
    callers,
    service,
    activity,
    publish: (events) => {
      published.push(...events);
    },
    realtime: {
      observe: (listener) => {
        changed = () => listener({ type: "host.requests-changed" } as never);
        return () => {
          changed = undefined;
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
    published,
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
  expect(f.published.map((event) => event.type)).toEqual([
    "tool.started",
    "tool.completed",
    "tool.started",
    "tool.completed",
    "tool.started",
    "tool.completed",
  ]);
  expect(f.published[2]!.data).toMatchObject({ arguments: null });
  expect(f.handler.mock.calls[0]![0].input).toMatchObject({ cursor: 2, limit: 10, query: "mail" });
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
  expect(f.published.map((event) => event.type)).toEqual(["tool.started", "tool.completed"]);
  expect(f.published[0]!.data).toMatchObject({
    callId: `harness:${f.caller.claims.runId}:1:${request.callId}`,
    arguments: { query: "mail", limit: 10 },
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
    expect(f.published.map((event) => event.type)).toEqual(["tool.started", "tool.completed"]);
  },
);
