import { expect, it, vi } from "vitest";
import { RunAgentToolsPlanSchema } from "@opensteer/protocol";
import { agentToolsPlanForRun } from "../agents/agent-tools-plan.js";
it("keeps standing team inventory stable across tasks and invalidates a warm plan when instructions or inventory change", () => {
  const input = {
    url: "http://127.0.0.1/mcp",
    token: "first",
    purpose: "task" as const,
    accessMode: "full-access" as const,
  };
  const ordinary = agentToolsPlanForRun(input),
    team = agentToolsPlanForRun({ ...input, teamsAvailable: true, knowledge: true }),
    linked = agentToolsPlanForRun({ ...input, teamsAvailable: true, knowledge: true });
  const knowledgeTools = ["knowledge_topics", "knowledge_read", "knowledge_write"];
  expect(RunAgentToolsPlanSchema.parse(ordinary)).toEqual(ordinary);
  for (const name of [...knowledgeTools, "team_read"]) expect(ordinary.tools).not.toContain(name);
  expect(team.tools).toEqual(
    expect.arrayContaining(["team_read", "team_search", "team_post", ...knowledgeTools]),
  );
  // Standing access has the same plan in every task.
  expect(linked.tools).toEqual(expect.arrayContaining(knowledgeTools));
  expect(linked).toEqual(team);
  expect(linked.toolsRevision).not.toBe(ordinary.toolsRevision);
  expect(team.skills).toContain("opensteer:memory");
  expect(ordinary.skills).toContain("opensteer:memory");
  expect(team.toolsRevision).not.toBe(ordinary.toolsRevision);
  expect(agentToolsPlanForRun({ ...input, token: "next" }).toolsRevision).toBe(
    ordinary.toolsRevision,
  );
  expect(agentToolsPlanForRun({ ...input, voiceCall: true }).toolsRevision).not.toBe(
    ordinary.toolsRevision,
  );
});

vi.mock("@opensteer/shared/advertisedJsonSchema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opensteer/shared/advertisedJsonSchema")>();
  return { ...actual, advertisedJsonSchema: vi.fn(actual.advertisedJsonSchema) };
});

it("revises a warm plan when the schema engines see changes", async () => {
  const { advertisedJsonSchema } = await import("@opensteer/shared/advertisedJsonSchema");
  const input = {
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
