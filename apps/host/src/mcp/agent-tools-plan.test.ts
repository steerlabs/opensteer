import { expect, it, vi } from "vitest";
import { RunAgentToolsPlanSchema } from "@opensteer/protocol";
import { agentToolsPlanForRun } from "../agents/agent-tools-plan.js";
it("keeps the plan stable across tasks and invalidates a warm plan when instructions or inventory change", () => {
  const input = {
    capabilities: { tabs: true, pages: true, computerUse: true, apps: true },
    url: "http://127.0.0.1/mcp",
    token: "first",
    purpose: "task" as const,
    accessMode: "full-access" as const,
  };
  const ordinary = agentToolsPlanForRun(input);
  expect(RunAgentToolsPlanSchema.parse(ordinary)).toEqual(ordinary);
  expect(ordinary.skills).toContain("opensteer:memory");
  expect(agentToolsPlanForRun({ ...input, token: "next" }).toolsRevision).toBe(
    ordinary.toolsRevision,
  );
  expect(agentToolsPlanForRun({ ...input, voiceCall: true }).toolsRevision).not.toBe(
    ordinary.toolsRevision,
  );
  // A broken settings.json reaches the agent's next Run, and a warm engine must not hide it.
  const broken = agentToolsPlanForRun({
    ...input,
    settingsError: {
      path: "/home/settings.json",
      line: 3,
      column: 5,
      message: "Unexpected token ','",
    },
  });
  expect(broken.instructions).toContain(
    "/home/settings.json line 3, column 5: Unexpected token ','",
  );
  expect(broken.toolsRevision).not.toBe(ordinary.toolsRevision);
});

vi.mock("@opensteer/shared/advertisedJsonSchema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opensteer/shared/advertisedJsonSchema")>();
  return { ...actual, advertisedJsonSchema: vi.fn(actual.advertisedJsonSchema) };
});

it("revises a warm plan when the schema engines see changes", async () => {
  const { advertisedJsonSchema } = await import("@opensteer/shared/advertisedJsonSchema");
  const input = {
    capabilities: { tabs: true, pages: true, computerUse: true, apps: true },
    url: "http://localhost/mcp",
    token: "token",
    purpose: "task" as const,
    accessMode: "auto" as const,
  };
  const before = agentToolsPlanForRun(input);
  vi.mocked(advertisedJsonSchema).mockReturnValueOnce({
    type: "object",
    properties: { added: { type: "string" } },
  });
  expect(agentToolsPlanForRun(input).toolsRevision).not.toBe(before.toolsRevision);
});

it("filters capability tools and invalidates a plan when driver reach changes", () => {
  const input = {
    url: "http://localhost/mcp",
    token: "test",
    purpose: "task" as const,
    accessMode: "full-access" as const,
    capabilities: { tabs: true, pages: true, computerUse: true, apps: true },
  };
  const ordinary = agentToolsPlanForRun(input);
  const none = agentToolsPlanForRun({
    ...input,
    capabilities: { tabs: false, pages: false, computerUse: false, apps: false },
  });
  expect(ordinary.tools).toContain("tab_list");
  expect(ordinary.tools).toContain("app_list");
  for (const name of [
    "tab_list",
    "tab_open",
    "show_to_person",
    "app_publish",
    "app_list",
    "computer_use",
  ])
    expect(none.tools).not.toContain(name);
  expect(
    agentToolsPlanForRun({ ...input, capabilities: { ...input.capabilities, pages: false } })
      .toolsRevision,
  ).not.toBe(ordinary.toolsRevision);
});
