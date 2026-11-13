import { describe, expect, it } from "vitest";
import { createId, type DeploymentId } from "@opensteer/core";
import { knowledge_write } from "@opensteer/agent-tools/tools";
import type { PersonalTeamLink } from "@opensteer/protocol";
import type { TeamLinkCallInput, TeamLinkResult } from "../team-link-endpoint/contracts.js";
import { PersonalTeamKnowledge } from "./knowledge.js";

function fixture(states: readonly PersonalTeamLink["state"][]) {
  const links = states.map((state, index): PersonalTeamLink => ({
    teamId: createId("deployment"),
    hostInstanceId: createId("hostInstance"),
    origin: `https://team-${index}.example.invalid`,
    teamName: `Team ${index}`,
    remoteLinkId: createId("teamLink"),
    ownerUserId: createId("user"),
    state,
    updateRequiredBy: null,
    lastContactAt: null,
  }));
  const sent: { teamId: DeploymentId; frame: TeamLinkCallInput }[] = [];
  const knowledge = new PersonalTeamKnowledge(
    async () => links,
    (teamId) => ({
      async call(frame): Promise<TeamLinkResult> {
        sent.push({ teamId, frame });
        if (frame.type === "knowledge.topics")
          return { kind: "knowledge.topics", result: { topics: [] } };
        if (frame.type === "knowledge.write" && "input" in frame)
          return {
            kind: "knowledge.write",
            result: {
              written: true,
              noteId: frame.input.noteId,
              topicId: frame.input.topicId ?? createId("knowledgeTopic"),
              version: (frame.input.expectedVersion ?? 0) + 1,
            },
          };
        throw new Error(`Unexpected ${frame.type}`);
      },
    }),
  );
  const runId = createId("run");
  return { links, sent, knowledge, runId };
}

describe("an agent's team knowledge over its owner's links", () => {
  it("names the asking request only to the team the Run's thread came from", async () => {
    const f = fixture(["active", "active"]);
    const [asking, other] = f.links.map((link) => link.teamId) as [DeploymentId, DeploymentId];
    const requestId = createId("teamAgentRequest");
    const thread = { runId: f.runId, teamOrigin: { teamId: asking }, requestId };
    expect(await f.knowledge.topics(thread, {})).toEqual({
      team: { id: asking, name: "Team 0" },
      topics: [],
    });
    await f.knowledge.topics(thread, { team: other });
    expect(f.sent).toEqual([
      { teamId: asking, frame: { type: "knowledge.topics", requestId } },
      { teamId: other, frame: { type: "knowledge.topics" } },
    ]);
  });

  it("asks which team when a private task's owner is in several, and skips links that are not active", async () => {
    const f = fixture(["active", "revoked", "active"]);
    const privateRun = { runId: f.runId, teamOrigin: null, requestId: null };
    await expect(f.knowledge.topics(privateRun, {})).rejects.toMatchObject({
      code: "bad_request",
      next: expect.stringContaining(f.links[2]!.teamId),
    });
    await expect(
      f.knowledge.topics(privateRun, { team: f.links[1]!.teamId }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(f.sent).toEqual([]);
    const single = fixture(["active", "needs_update"]);
    await single.knowledge.topics({ ...privateRun, runId: single.runId }, {});
    expect(single.sent).toEqual([
      { teamId: single.links[0]!.teamId, frame: { type: "knowledge.topics" } },
    ]);
  });

  it("sends a new note with a fresh id and a change at the version the agent read", async () => {
    const f = fixture(["active"]);
    const run = { runId: f.runId, teamOrigin: null, requestId: null };
    const topicId = createId("knowledgeTopic");
    const noteId = createId("knowledgeNote");
    const write = (input: object) => f.knowledge.write(run, knowledge_write.input.parse(input));
    await write({ topicId, title: "Refunds", body: "30 days" });
    await write({ noteId, version: 3, body: "14 days" });
    await write({ noteId, version: 4, delete: true });
    const inputs = f.sent.map(({ frame }) => ("input" in frame ? frame.input : undefined));
    expect(inputs).toEqual([
      {
        noteId: expect.any(String),
        topicId,
        expectedVersion: null,
        title: "Refunds",
        body: "30 days",
      },
      { noteId, expectedVersion: 3, body: "14 days" },
      { noteId, expectedVersion: 4, delete: true },
    ]);
  });
});
