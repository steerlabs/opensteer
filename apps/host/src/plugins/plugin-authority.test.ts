import { expect, test } from "vitest";
import { createId } from "@opensteer/core";
import type { OpensteerStore, PluginAgentStore } from "@opensteer/database";
import type { AgentCaller } from "../mcp/agent-caller.js";
import { PluginAuthority, pluginCaller } from "./plugin-authority.js";
import { PluginExecutions } from "./plugin-executions.js";

test.each(["page", "webhook"])(
  "rechecks standing access for an owner %s after the engine startup wait",
  async (operation) => {
    const owner = createId("user");
    const authority = new PluginAuthority({
      store: {} as OpensteerStore,
      settings: {
        settings: async () => [{ pluginId: "app_test", access: "off" }],
      } as unknown as PluginAgentStore,
      owner: async () => owner,
    });
    expect(
      await authority.authorize({
        caller: "personal",
        mode: "automatic",
        operation,
        plugin: "app_test",
      }),
    ).toMatchObject({ allowed: false });
  },
);

test.each(["all", "read-only", "off"] as const)(
  "background execution requires all access: %s",
  async (access) => {
    const authority = new PluginAuthority({
      store: {} as OpensteerStore,
      settings: {
        settings: async () => [{ pluginId: "app_test", access }],
      } as unknown as PluginAgentStore,
      owner: async () => createId("user"),
    });
    expect(
      await authority.authorize({
        caller: "personal",
        mode: "automatic",
        operation: "background",
        plugin: "app_test",
      }),
    ).toMatchObject({ allowed: access === "all" });
  },
);

test("retires completed occurrences while retaining a handed-off execution", async () => {
  const authority = new PluginAuthority({
    store: {} as OpensteerStore,
    settings: {} as PluginAgentStore,
    owner: async () => createId("user"),
  });
  const caller = {
    kind: "program",
    key: "trigger:occurrence",
    userId: createId("user"),
    accessMode: "full-access",
    anchor: { id: createId("thread") },
    program: { kind: "trigger" },
  } as unknown as import("../mcp/agent-caller.js").AgentCaller;
  let key = "";
  await authority.scoped(caller, async () => {
    key = authority.admit(caller).caller;
    authority.execution("pending", key, true);
  });
  expect(authority.caller(key)).toBe(caller);
  await authority.scoped(caller, async () => {
    authority.execution("pending", key, false);
    expect(authority.caller(key)).toBeUndefined();
  });
  expect(authority.caller(key)).toBeUndefined();
  for (let occurrence = 0; occurrence < 30; occurrence++) {
    const next = { ...caller, key: `trigger:${occurrence}` };
    await authority.scoped(next, async () => {
      key = authority.admit(next).caller;
    });
    expect(authority.caller(key)).toBeUndefined();
  }
});

test("a full-access Run is refused every operation that is not listed for agents", async () => {
  const owner = createId("user");
  const authority = new PluginAuthority({
    store: {
      getThreadForOwner: async () => ({ accessMode: "full-access" }),
      assertActiveGrant: async () => undefined,
    } as unknown as OpensteerStore,
    settings: { settings: async () => [] } as unknown as PluginAgentStore,
    owner: async () => owner,
  });
  const caller = {
    kind: "run",
    userId: owner,
    thread: { id: createId("thread") },
    accessMode: "full-access",
    claims: { runId: createId("run") },
  } as unknown as AgentCaller;
  await authority.scoped(caller, async () => {
    const context = authority.admit(caller);
    expect(await authority.authorize({ ...context, operation: "search" })).toMatchObject({
      allowed: true,
    });
    for (const operation of ["scheduleApprovals", "detail", "manage", "anOperationAddedLater"])
      expect(
        await authority.authorize({ ...context, operation, plugin: "app_test" }),
        operation,
      ).toMatchObject({ allowed: false });
  });
});

test("a plugin execution resumes only under the lineage and grant revision that started it", async () => {
  const userId = createId("user");
  const thread = { id: createId("thread"), accessMode: "full-access" };
  const lineaged = (
    agentConnectionId: string,
    grantRevision: number,
    accessMode: "full-access" | "approval-required" = "full-access",
  ) =>
    ({
      kind: "run",
      key: "run:plugin",
      userId,
      accessMode,
      thread,
      claims: { runId: createId("run"), threadId: thread.id },
      agentConnection: {
        agentConnectionId,
        grant: { scope: "everything" },
        grantRevision,
        consentVersion: 2,
        accessMode: "full-access",
      },
    }) as unknown as AgentCaller;
  const started = lineaged("mcn_first", 1);
  const row = {
    id: "pex_started",
    ownerUserId: userId,
    caller: `${pluginCaller(started).caller}:1`,
    mode: "automatic",
    state: "completed",
    requestId: null,
    result: {
      data: { secret: "read under revision 1" },
      targets: [{ plugin: "app_test", version: "v1", write: false }],
    },
    reason: null,
    admittedAccessMode: "full-access",
  };
  let allowResult = true;
  const executions = new PluginExecutions({
    records: { execution: async (id: string) => (id === row.id ? row : null) },
    authority: {
      scoped: async (_caller: unknown, work: () => Promise<unknown>) => work(),
      assert: async () => {},
      admit: pluginCaller,
      canReadResult: async (_context: unknown, _mode: unknown) => allowResult,
    },
    service: { request: async () => true },
  } as unknown as ConstructorParameters<typeof PluginExecutions>[0]);
  expect(await executions.resume(started, row.id)).toMatchObject({
    result: { secret: "read under revision 1" },
  });
  const { agentConnection: _, ...owner } = started as AgentCaller & { agentConnection: unknown };
  // A later revision, another connection, the person's own work, or the same lineage after its
  // effective mode dropped: none gets the earlier result.
  for (const later of [lineaged("mcn_first", 2), lineaged("mcn_second", 1), owner as AgentCaller]) {
    const refused = await executions.resume(later, row.id).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    expect(refused).toMatchObject({ error: { code: "forbidden" } });
    expect(JSON.stringify(refused)).not.toContain("read under revision 1");
  }
  allowResult = false;
  const lowerMode = await executions.resume(lineaged("mcn_first", 1, "approval-required"), row.id);
  expect(lowerMode).toMatchObject({ status: "completed" });
  expect(lowerMode).not.toHaveProperty("result");
});
