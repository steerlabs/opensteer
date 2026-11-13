import { TeamMessageIdSchema } from "@opensteer/core";
import { expect, it } from "vitest";
import { createId } from "@opensteer/core";
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
    team = agentToolsPlanForRun({ ...input, teamBound: true, knowledge: true }),
    linked = agentToolsPlanForRun({ ...input, knowledge: true });
  const knowledgeTools = ["knowledge_topics", "knowledge_read", "knowledge_write"];
  expect(RunAgentToolsPlanSchema.parse(ordinary)).toEqual(ordinary);
  for (const name of [...knowledgeTools, "team_read"]) expect(ordinary.tools).not.toContain(name);
  expect(team.tools).toEqual(
    expect.arrayContaining(["team_read", "team_search", "team_reply", ...knowledgeTools]),
  );
  // An owner linked to a team gets knowledge in a private task too, without the team-thread tools.
  expect(linked.tools).toEqual(expect.arrayContaining(knowledgeTools));
  expect(linked.tools).not.toContain("team_read");
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

it("loads current sourced channel instructions without changing permanent team inventory", () => {
  const input = {
    url: "http://127.0.0.1/mcp",
    token: "token",
    purpose: "task" as const,
    accessMode: "auto" as const,
    teamBound: true,
  };
  const source = {
    teamId: createId("deployment"),
    channelId: createId("teamChannel"),
    threadRootId: TeamMessageIdSchema.parse("1"),
    messageId: TeamMessageIdSchema.parse("2"),
    audience: {
      teamName: "Acme",
      channelName: "Support",
      channelKind: "private" as const,
      memberCount: 3,
      peopleOnly: false,
    },
  };
  const privateTurn = agentToolsPlanForRun(input);
  const asked = agentToolsPlanForRun({
    ...input,
    teamContext: {
      ownerDisplayName: "Maya Chen",
      instructionsMarkdown: "Cite the checklist.",
      source,
    },
  });
  expect(asked.tools).toEqual(privateTurn.tools);
  expect(asked.instructions).toContain("Maya Chen");
  expect(asked.instructions).toContain(JSON.stringify(source));
  expect(asked.instructions).toContain("Cite the checklist.");
  const edited = agentToolsPlanForRun({
    ...input,
    teamContext: {
      ownerDisplayName: "Maya Chen",
      instructionsMarkdown: "Cite and date the checklist.",
      source,
    },
  });
  expect(edited.toolsRevision).not.toBe(asked.toolsRevision);
  expect(asked.toolsRevision).not.toBe(privateTurn.toolsRevision);
  expect(agentToolsPlanForRun({ ...input, accessMode: "approval-required" }).tools).not.toContain(
    "settings_write",
  );
});
