import { describe, expect, it, vi } from "vitest";
import { agentToolFailureResult } from "@opensteer/agent-tools";
import { agentToolFailure } from "../agent-tool-failure.js";
import type { AgentCaller } from "../agent-caller.js";
import { PluginToolHandlers } from "./plugins.js";

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
