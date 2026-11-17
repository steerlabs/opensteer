import { describe, expect, it } from "vitest";
import { createId, type DeploymentId } from "@opensteer/core";
import {
  opensteer_knowledge_remove,
  opensteer_knowledge_save,
  opensteer_knowledge_read,
  opensteer_knowledge_topic_list,
} from "@opensteer/agent-tools/tools";
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
  let response: TeamLinkResult | undefined;
  const sent: { teamId: DeploymentId; frame: TeamLinkCallInput }[] = [];
  const knowledge = new PersonalTeamKnowledge(
    async () => links,
    (teamId) => ({
      async call(frame): Promise<TeamLinkResult> {
        sent.push({ teamId, frame });
        if (response) return response;
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
  return {
    links,
    sent,
    knowledge,
    runId,
    respond: (next: TeamLinkResult) => {
      response = next;
    },
  };
}

describe("an agent's team knowledge over its owner's links", () => {
  it.each([[], ["revoked"], ["needs_update"]] as const)(
    "denies every knowledge operation without an active link (%j)",
    async (...states) => {
      const f = fixture(states);
      const caller = { runId: f.runId, teamOrigin: null, requestId: null };
      for (const call of [
        () => f.knowledge.topics(caller, {}),
        () => f.knowledge.read(caller, { query: "hello" }),
        () =>
          f.knowledge.write(
            caller,
            opensteer_knowledge_save.input.parse({
              topicId: createId("knowledgeTopic"),
              title: "Hi",
              body: "Text",
            }),
          ),
      ]) {
        await expect(call()).rejects.toMatchObject({ code: "not_found" });
      }
      expect(f.sent).toEqual([]);
    },
  );

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

  it("strips note title/body before writes and decorates success and conflict with the stored origin", async () => {
    const f = fixture(["active"]);
    const caller = { runId: f.runId, teamOrigin: null, requestId: null };
    const topicId = createId("knowledgeTopic");
    const result = opensteer_knowledge_save.output.parse(
      await f.knowledge.write(
        caller,
        opensteer_knowledge_save.input.parse({
          topicId,
          title: "[Policy](opensteer:future)",
          body: "[answer][file]\n\n[file]: /private/secret.txt",
        }),
      ),
    );
    const frame = f.sent[0]!.frame;
    if (frame.type !== "knowledge.write" || !result.written) throw new Error("Expected write");
    expect(frame.input).toMatchObject({ title: "Policy", body: "answer\n\n" });
    expect(result.link).toBe(
      `[Note](https://team-0.example.invalid/knowledge/${topicId}?note=${result.noteId})`,
    );
    const current = {
      id: result.noteId,
      topicId,
      title: "Current policy",
      body: "Updated",
      version: 2,
      deleted: false,
      writtenAt: "2026-11-14T12:00:00.000Z",
      writer: { kind: "human" as const, userId: createId("user"), name: "Maya" },
      source: null,
    };
    f.respond({ kind: "knowledge.write", result: { written: false, current } });
    const conflict = opensteer_knowledge_save.output.parse(
      await f.knowledge.write(
        caller,
        opensteer_knowledge_save.input.parse({
          noteId: result.noteId,
          version: 1,
          body: "[new](/private/other.txt)",
        }),
      ),
    );
    expect(conflict).toMatchObject({
      written: false,
      current: {
        ...current,
        link: `[Current policy](https://team-0.example.invalid/knowledge/${topicId}?note=${result.noteId})`,
      },
    });
    expect(f.sent[1]!.frame).toMatchObject({ input: { body: "new", expectedVersion: 1 } });
    await expect(
      f.knowledge.write(
        caller,
        opensteer_knowledge_save.input.parse({
          topicId,
          title: "[ ](opensteer:future)",
          body: "Text",
        }),
      ),
    ).rejects.toThrow();
    expect(f.sent).toHaveLength(2);
  });

  it("enriches topics and note/history pages before bounding their serialized bytes", async () => {
    const f = fixture(["active"]);
    const caller = { runId: f.runId, teamOrigin: null, requestId: null };
    const topic = {
      id: createId("knowledgeTopic"),
      name: "Policies",
      description: "",
      canWrite: true,
      archived: false,
      audience: { everyone: true, people: 1 },
    };
    f.respond({ kind: "knowledge.topics", result: { topics: [topic] } });
    expect(
      opensteer_knowledge_topic_list.output.parse(await f.knowledge.topics(caller, {})).topics[0]!
        .link,
    ).toBe(`[Policies](https://team-0.example.invalid/knowledge/${topic.id})`);
    const notes = Array.from({ length: 3 }, () => ({
      id: createId("knowledgeNote"),
      topicId: topic.id,
      title: "😀".repeat(100),
      body: "a".repeat(65_536),
      version: 1,
      deleted: false,
      writtenAt: "2026-11-14T12:00:00.000Z",
      writer: { kind: "human" as const, userId: createId("user"), name: "Maya" },
      source: null,
    }));
    f.respond({
      kind: "knowledge.read",
      result: { notes, topics: [topic], nextBefore: null, truncated: false },
    });
    const { nextBefore, ...page } = await f.knowledge.read(caller, { query: "a" });
    const parsed = opensteer_knowledge_read.output.parse({ ...page, nextCursor: nextBefore });
    expect(Buffer.byteLength(JSON.stringify(parsed))).toBeLessThanOrEqual(200_000);
    for (const note of parsed.notes)
      expect(note.link).toContain(`/knowledge/${topic.id}?note=${note.id}`);
    expect(parsed.topics[0]!.link).toBe(
      `[Policies](https://team-0.example.invalid/knowledge/${topic.id})`,
    );
    expect(parsed.notes).toHaveLength(3);
    expect(parsed.truncated).toBe(true);
  });

  it("sends a new note with a fresh id and a change at the version the agent read", async () => {
    const f = fixture(["active"]);
    const run = { runId: f.runId, teamOrigin: null, requestId: null };
    const topicId = createId("knowledgeTopic");
    const noteId = createId("knowledgeNote");
    const write = (input: object) =>
      f.knowledge.write(run, opensteer_knowledge_save.input.parse(input));
    await write({ topicId, title: "Refunds", body: "30 days" });
    await write({ noteId, version: 3, body: "14 days" });
    await f.knowledge.write(run, {
      ...opensteer_knowledge_remove.input.parse({ noteId, version: 4 }),
      delete: true,
    });
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
