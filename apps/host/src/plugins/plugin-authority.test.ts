import { expect, test } from "vitest";
import { createId } from "@opensteer/core";
import type { OpensteerStore, PluginAgentStore } from "@opensteer/database";
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
    expect(authority.caller(key)).toBe(caller);
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
