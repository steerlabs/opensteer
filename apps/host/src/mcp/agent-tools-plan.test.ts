import { expect, it, vi } from "vitest";
import { RunAgentToolsPlanSchema } from "@opensteer/protocol";
import { agentToolsPlanForRun } from "../agents/agent-tools-plan.js";
it("keeps team inventory permanent per task and invalidates a warm plan when instructions or inventory change", () => {
  const input = {
    url: "http://127.0.0.1/mcp",
    token: "first",
    purpose: "task" as const,
    accessMode: "full-access" as const,
  };
  const ordinary = agentToolsPlanForRun(input),
    team = agentToolsPlanForRun({ ...input, teamBound: true });
  const knowledgeTools = ["knowledge_topics", "knowledge_read", "knowledge_write"];
  expect(RunAgentToolsPlanSchema.parse(ordinary)).toEqual(ordinary);
  expect(ordinary.tools).toEqual(expect.arrayContaining(knowledgeTools));
  expect(ordinary.tools).not.toContain("team_read");
  expect(team.tools).toEqual(
    expect.arrayContaining(["team_read", "team_search", "team_reply", ...knowledgeTools]),
  );
  expect(agentToolsPlanForRun({ ...input, personalContext: false }).tools).not.toEqual(
    expect.arrayContaining(knowledgeTools),
  );
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

it("revises a warm plan when the advertised schema changes", async () => {
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
