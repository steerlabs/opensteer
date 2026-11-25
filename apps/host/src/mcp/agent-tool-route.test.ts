import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import {
  createId,
  OpensteerError,
  type AgentGrant,
  type Thread,
  type ToolOutput,
} from "@opensteer/core";
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
function fixture(grant?: AgentGrant) {
  const thread = {
    id: createId("thread"),
    environmentId: createId("environment"),
    accessMode: "full-access",
    purpose: "task",
  } as Thread;
  let caller: RunCaller = {
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
    ...(grant
      ? {
          agentConnection: {
            agentConnectionId: "mcn_lineage",
            grant,
            grantRevision: 1,
            consentVersion: 2,
            accessMode: "full-access" as const,
          },
        }
      : {}),
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
  const settingsHandler = vi.fn(async (_call: ToolCall<"local_server_remove">) => ({
    ok: true as const,
  }));
  const service = new OpensteerMcpService({
    callers,
    handlers: { computer_apps: handler, local_server_remove: settingsHandler },
    store: {
      readTask: async () => thread,
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
    secretDigestKey: Buffer.alloc(32, 0x33),
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
    settingsHandler,
    activity,
    saved,
    call,
    stop: () => {
      live = false;
      changed?.();
    },
    /** A task access-mode edit committed: the next authentication sees the lowered mode. */
    setAccessMode: (next: Thread["accessMode"]) => {
      caller = { ...caller, accessMode: next, thread: { ...caller.thread, accessMode: next } };
    },
    /** A grant edit committed: the next authentication sees the new revision. */
    regrant: (next: AgentGrant) => {
      caller = {
        ...caller,
        agentConnection: { ...caller.agentConnection!, grant: next, grantRevision: 2 },
      };
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

it.each([
  ["an in-flight", "the last granted app"],
  ["a completed", "the last granted app"],
  ["an in-flight", "the app it ran on, while another stays granted"],
  ["a completed", "the app it ran on, while another stays granted"],
] as const)(
  "refuses %s replay once the grant withdraws %s, returning nothing it produced",
  async (stage, withdrawn) => {
    const app = (bundleId: string) =>
      ({
        kind: "computer-app",
        approvalId: `con_${crypto.randomUUID()}`,
        deviceId: createId("device"),
        app: { kind: "mac-app", bundleId, teamId: null },
      }) as const;
    const mail = app("com.apple.mail"),
      notes = app("com.apple.notes");
    const f = fixture({ scope: "selected", tasks: true, resources: [mail, notes] });
    const entered = Promise.withResolvers<void>(),
      held = Promise.withResolvers<void>();
    f.handler.mockImplementation(async () => {
      entered.resolve();
      await held.promise;
      return { total: 1, nextCursor: null, secret: "from the earlier grant" } as never;
    });
    const request = { callId: crypto.randomUUID(), name: "computer_apps", input: {} };
    const first = f.call(request);
    await withTimeout(entered.promise, 1000, {
      timeoutError: () => new Error("Tool handler did not start"),
    });
    if (stage === "a completed") {
      held.resolve();
      expect((await first).json()).toMatchObject({ structuredContent: { total: 1 } });
    }
    // The tool family stays offered when another app remains: only the recorded authority can
    // tell the earlier result apart.
    f.regrant({
      scope: "selected",
      tasks: true,
      resources: withdrawn === "the last granted app" ? [] : [notes],
    });
    const replay = (await f.call(request)).json();
    expect(replay).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "access_denied" } },
    });
    expect(JSON.stringify(replay)).not.toContain("from the earlier grant");
    held.resolve();
    await first;
    expect(f.handler).toHaveBeenCalledTimes(1);
  },
);

it("re-authenticates a native Run after activity.start so a mode lowered during that await refuses settings tools", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const baseStart = f.activity.start.getMockImplementation()!;
  f.activity.start.mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return baseStart(...args);
  });
  const pending = f.call({
    callId: crypto.randomUUID(),
    // A settings tool this release still has: the administration tools became the door (A5).
    name: "local_server_remove",
    input: { name: "parity-server" },
  });
  await withTimeout(entered.promise, 1_000, {
    timeoutError: () => new Error("activity.start did not begin"),
  });
  f.setAccessMode("approval-required");
  release.resolve();
  const response = (await pending).json();
  expect(response).toMatchObject({
    isError: true,
    structuredContent: {
      error: { code: "access_denied", message: "Changing settings requires full-access" },
    },
  });
  expect(f.settingsHandler).not.toHaveBeenCalled();
});

it("redacts secret fields before recording relay activity for admitted and refused commands (R1)", async () => {
  const admittedMarker = `relay-admitted-${crypto.randomUUID()}`;
  const refusedMarker = `relay-refused-${crypto.randomUUID()}`;
  const otherCmdMarker = `relay-server-secret-${crypto.randomUUID()}`;
  const received: unknown[] = [];
  const savedArgs: unknown[] = [];

  const app = Fastify();
  apps.push(app);
  const f = fixture();
  const callers = {
    authenticate: vi.fn(async (token: string) => {
      if (token !== "run-token") throw new Error("Unauthorized");
      return f.caller;
    }),
  };
  const commandHandler = vi.fn(async (call: ToolCall<"opensteer_command">) => {
    received.push(call.input);
    const cmd = call.input.command as { readonly type?: string; readonly triggerId?: string };
    if (cmd?.triggerId === "trg_refused") {
      throw new OpensteerError({ code: "bad_request", message: "Leave set out" });
    }
    return { status: "done" as const, result: { secretNames: ["TOKEN"], type: cmd?.type } };
  });
  const service = new OpensteerMcpService({
    callers,
    handlers: { opensteer_command: commandHandler },
    store: {
      readTask: async () => f.caller.thread,
      threadOrigins: async () => new Map(),
      requests: { get: async () => null },
    },
    publicUrl: new URL("http://host.test"),
  });
  registerAgentToolRoute(app, {
    callers,
    service,
    activity: {
      start: async (context, callId, name, args) => {
        savedArgs.push(args);
        return f.activity.start(context, callId, name, args);
      },
      complete: f.activity.complete,
    },
    secretDigestKey: Buffer.alloc(32, 0x33),
    realtime: { observeScopes: () => () => true },
  });

  const post = (input: unknown) =>
    app.inject({
      method: "POST",
      url: agentToolHostRoutePath,
      headers: { authorization: "Bearer run-token" },
      payload: { callId: crypto.randomUUID(), name: "opensteer_command", input },
    });

  // 1. Admitted trigger.secrets.set: live handler gets the value, recorded activity gets [redacted].
  const admittedRes = await post({
    command: { type: "trigger.secrets.set", triggerId: "trg_ok", set: { TOKEN: admittedMarker } },
  });
  expect(admittedRes.statusCode).toBe(200);
  expect(admittedRes.body).not.toContain(admittedMarker);

  // 2. Refused trigger.secrets.set: recorded activity STILL redacts the value.
  const refusedRes = await post({
    command: {
      type: "trigger.secrets.set",
      triggerId: "trg_refused",
      set: { TOKEN: refusedMarker },
    },
  });
  expect(refusedRes.statusCode).toBe(200);
  expect(refusedRes.body).not.toContain(refusedMarker);

  // 3. Another secret-bearing command (integration.server.secrets.set): also redacted.
  await post({
    command: {
      type: "integration.server.secrets.set",
      serverId: "srv_1",
      secrets: { API_KEY: otherCmdMarker },
    },
  });

  // 4. M1: Agent-chosen / misspelled keys (`Set`, `sett`, `input`) on a secret-bearing command.
  const misKeyMarker = `relay-miskey-${crypto.randomUUID()}`;
  const nestedInputMarker = `relay-nested-${crypto.randomUUID()}`;
  await post({
    command: {
      type: "trigger.secrets.set",
      triggerId: "trg_miskey",
      Set: { TOKEN: misKeyMarker },
      input: { set: { TOKEN: nestedInputMarker } },
    },
  });

  expect(JSON.stringify(received[0])).toContain(admittedMarker);
  const allSaved = JSON.stringify(savedArgs);
  expect(allSaved).not.toContain(admittedMarker);
  expect(allSaved).not.toContain(refusedMarker);
  expect(allSaved).not.toContain(otherCmdMarker);
  expect(allSaved).not.toContain(misKeyMarker);
  expect(allSaved).not.toContain(nestedInputMarker);
  expect(savedArgs[0]).toMatchObject({
    command: { type: "trigger.secrets.set", triggerId: "trg_ok", set: "[redacted]" },
  });
  expect(savedArgs[1]).toMatchObject({
    command: { type: "trigger.secrets.set", triggerId: "trg_refused", set: "[redacted]" },
  });
  expect(savedArgs[2]).toMatchObject({
    command: {
      type: "integration.server.secrets.set",
      serverId: "srv_1",
      secrets: "[redacted]",
    },
  });
  expect(savedArgs[3]).toMatchObject({
    command: {
      type: "trigger.secrets.set",
      triggerId: "trg_miskey",
      Set: "[redacted]",
      input: "[redacted]",
    },
  });
});

it("refuses to register the agent tool relay without a non-empty secretDigestKey", () => {
  const f = fixture();
  const app = Fastify();
  apps.push(app);
  expect(() =>
    registerAgentToolRoute(app, {
      callers: { authenticate: async () => f.caller },
      service: f.service,
      activity: f.activity,
      secretDigestKey: Buffer.alloc(0),
      realtime: { observeScopes: () => () => true },
    }),
  ).toThrow("Agent tool relay route requires a non-empty secretDigestKey.");
});
