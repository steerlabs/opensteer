import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { agentToolFailureResult } from "@opensteer/agent-tools";
import { agentToolFailure } from "../agent-tool-failure.js";
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

const caller = { kind: "run", userId: "user_1" } as unknown as AgentCaller;

function catalogTool(page: { items: unknown[]; cursor: string | null; feed: { status: string } }) {
  const service = { catalogList: vi.fn(async () => page) };
  const handlers = new PluginToolHandlers({
    service,
    authority: {
      admit: () => ({ caller: "run", mode: "automatic" }),
      scoped: (_caller: unknown, work: () => unknown) => work(),
    },
  } as unknown as PluginToolHandlers["options"]).handlers();
  return () =>
    handlers.opensteer_plugin_catalog!({ caller, input: { search: "mail" }, operationKey: "k" });
}

describe("opensteer_plugin_catalog", () => {
  it("lists what the feed lists", async () => {
    const read = catalogTool({
      items: [
        {
          id: "mail",
          name: "Mail",
          description: "Send mail\nand more",
          auth: [{ method: "key", kind: "secrets", label: "API key" }],
        },
      ],
      cursor: null,
      feed: { status: "listed" },
    });
    expect(await read()).toEqual({
      items: [{ id: "mail", name: "Mail", description: "Send mail", accounts: ["API key"] }],
      cursor: null,
    });
  });

  it("refuses with a typed reason to retry when the feed can't be read, never an empty list", async () => {
    for (const status of ["unavailable", "off"]) {
      const read = catalogTool({ items: [], cursor: null, feed: { status } });
      const error = await read().then(
        () => undefined,
        (reason: unknown) => reason,
      );
      const result = agentToolFailureResult(agentToolFailure(error, "read"));
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error).toEqual({
        code: "catalog_unavailable",
        message: "The plugin catalog can't be reached right now.",
        next: expect.stringContaining("Retry opensteer_plugin_catalog"),
      });
    }
  });
});

it("names discover, never a lookup it lacks, when a connection omits the namespace", async () => {
  const handlers = new PluginToolHandlers({
    sessions: () => ({}),
    authority: {
      admit: () => ({ caller: "agent:test", mode: "automatic" }),
      scoped: (_caller: unknown, work: () => unknown) => work(),
    },
  } as unknown as PluginToolHandlers["options"]).handlers();
  const connection = {
    kind: "connection",
    userId: "usr_test",
    key: "connection:test",
    connectionId: "test",
    grant: { scope: "everything" },
    grantRevision: 1,
    accessMode: "full-access",
  } as unknown as AgentCaller;
  const refusal = await handlers.plugin_execute!({
    caller: connection,
    input: { code: "return 1" },
    operationKey: "no-namespace",
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(refusal).toMatchObject({
    code: "bad_request",
    message: "Supply the one plugin namespace from discover.",
  });
  const shown = agentToolFailureResult(agentToolFailure(refusal, "write", undefined, true), {
    tools: new Set(["discover", "plugin_call", "plugin_execute", "plugin_resume"]),
  });
  expect(shown.structuredContent.error.message).toBe(
    "Supply the one plugin namespace from discover.",
  );
});
