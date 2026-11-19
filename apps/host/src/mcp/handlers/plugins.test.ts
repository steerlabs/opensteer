import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { AgentCaller } from "../agent-caller.js";
import type { PluginHostProvider } from "../../plugins/engine-protocol.js";
import { localNamespace } from "../../plugins/provider-names.js";
import { PluginToolHandlers } from "./plugins.js";

it("pages an agent's plugin list once over every entry while names change between pages", async () => {
  const ids = Array.from({ length: 30 }, () => `app_device_${randomUUID()}`);
  // A device's name, and so its slug, can change while an agent pages; its id cannot.
  let named = (index: number) => `Calendar ${String(index).padStart(2, "0")}`;
  const providers = (): PluginHostProvider[] =>
    ids.map((id, index) => ({
      id,
      name: named(index),
      slug: localNamespace(named(index).toLowerCase().replaceAll(" ", "-"), id),
      version: `dpl_${id}`,
      tools: [],
    }));
  const handlers = new PluginToolHandlers({
    service: { list: async () => [], installed: async () => [] },
    localProviders: { providers: async () => providers() },
    authority: { admit: () => ({ caller: "agent:test", mode: "automatic" }) },
    settings: { settings: async () => [] },
  } as unknown as PluginToolHandlers["options"]);
  const caller = { kind: "run", userId: "usr_test", key: "run:test" } as unknown as AgentCaller;
  const list = (cursor?: string) =>
    handlers.list({ caller, input: cursor ? { cursor } : {}, operationKey: "list" });
  const first = await list();
  expect(first.cursor).not.toBeNull();
  named = (index) => `Calendar ${String(99 - index).padStart(2, "0")}`;
  const second = await list(first.cursor!);
  expect(second.cursor).toBeNull();
  const seen = [...first.local, ...second.local].map(({ id }) => id);
  expect(seen).toHaveLength(ids.length);
  expect(new Set(seen)).toEqual(new Set(ids));
});
