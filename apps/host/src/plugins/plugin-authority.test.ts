import { expect, test } from "vitest";
import { createId } from "@opensteer/core";
import type { OpensteerStore, PluginAgentStore } from "@opensteer/database";
import type { AgentCaller } from "../mcp/agent-caller.js";
import { PluginAuthority } from "./plugin-authority.js";

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
