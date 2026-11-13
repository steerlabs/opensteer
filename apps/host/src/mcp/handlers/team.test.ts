import { TeamMessageIdSchema } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { createId, type Thread } from "@opensteer/core";
import {
  knowledge_read,
  knowledge_topics,
  knowledge_write,
  team_read,
  team_search,
  team_post,
} from "@opensteer/agent-tools/tools";
import type { RunCaller } from "../agent-caller.js";
import type { TeamKnowledgePort, TeamToolPort } from "../team-tool-port.js";
import { knowledgeToolHandlers, teamToolHandlers } from "./team.js";
const origin = {
  teamId: createId("deployment"),
  channelId: createId("teamChannel"),
  threadRootId: TeamMessageIdSchema.parse("1"),
};
function caller(runId = createId("run")): RunCaller {
  const thread = { id: createId("thread"), teamOrigin: origin } as Thread;
  return {
    kind: "run",
    key: `run:${runId}`,
    userId: createId("user"),
    accessMode: "full-access",
    thread,
    claims: { runId, threadId: thread.id },
  } as RunCaller;
}
describe("standing owner team authority", () => {
  it("attributes calls to the current Run without needing a team origin or request", async () => {
    const first = caller(),
      second = { ...caller(), thread: { ...first.thread, teamOrigin: null } as Thread };
    const source = {
      ...origin,
      messageId: TeamMessageIdSchema.parse("1"),
      audience: {
        teamName: "Acme",
        channelName: "support",
        channelKind: "public" as const,
        memberCount: 12,
        peopleOnly: false,
      },
    };
    const posted = vi
      .fn<TeamToolPort["post"]>()
      .mockResolvedValue({ messageId: TeamMessageIdSchema.parse("2"), source });
    const port = { post: posted } as unknown as TeamToolPort;
    const personalContext = vi.fn(async () => true);
    const handlers = teamToolHandlers({ port, personalContext });

    for (const c of [first, second]) {
      expect(
        await handlers.team_post({
          caller: c,
          input: {
            channelId: origin.channelId,
            threadRootId: origin.threadRootId,
            bodyMarkdown: "Result",
            attachmentPaths: [],
          },
          operationKey: "post",
        }),
      ).toEqual({ messageId: TeamMessageIdSchema.parse("2"), source });
    }
    expect(posted.mock.calls.map(([run]) => run.runId)).toEqual([
      first.claims.runId,
      second.claims.runId,
    ]);
    expect(personalContext).toHaveBeenCalledTimes(2);
    for (const tool of [
      team_read,
      team_search,
      team_post,
      knowledge_topics,
      knowledge_read,
      knowledge_write,
    ]) {
      for (const key of ["requestId", "teamRequestId", "ownerId", "taskId", "token", "url"]) {
        const input =
          tool.name === "team_search" || tool.name === "knowledge_read"
            ? { query: "help" }
            : tool.name === "team_post"
              ? { bodyMarkdown: "Result" }
              : tool.name === "knowledge_write"
                ? { topicId: createId("knowledgeTopic"), title: "Note", body: "Text" }
                : {};
        expect(tool.input.safeParse({ ...input, [key]: "another" }).success).toBe(false);
      }
    }
  });
  it("denies shared conversations and every non-Run caller", async () => {
    const port = { read: vi.fn() } as unknown as TeamToolPort;
    const handlers = teamToolHandlers({ port, personalContext: async () => false });
    const c = caller();
    await expect(
      handlers.team_read({ caller: c, input: {}, operationKey: "read" }),
    ).rejects.toThrow("other people share");
    await expect(
      handlers.team_read({
        caller: {
          kind: "connection",
          key: "connection:1",
          connectionId: "1",
          userId: c.userId,
          accessMode: "full-access",
        },
        input: {},
        operationKey: "read",
      }),
    ).rejects.toThrow("live Run");
    expect(port.read).not.toHaveBeenCalled();
  });
});

describe("team knowledge as the Run's owner", () => {
  it("rechecks personal context on every call and names a request only in a team thread", async () => {
    const topics = vi.fn<TeamKnowledgePort["topics"]>().mockResolvedValue({
      team: { id: origin.teamId, name: "Acme" },
      topics: [],
    });
    const port = { topics } as unknown as TeamKnowledgePort;
    const requestId = createId("teamAgentRequest");
    let personal = true;
    const handlers = knowledgeToolHandlers({
      port,
      requestForRun: async () => requestId,
      personalContext: async () => personal,
    });
    const teamRun = caller();
    const privateRun = { ...caller(), thread: { ...teamRun.thread, teamOrigin: null } as Thread };
    for (const c of [teamRun, privateRun])
      await handlers.knowledge_topics({ caller: c, input: {}, operationKey: "topics" });
    expect(topics.mock.calls.map(([knowledgeCaller]) => knowledgeCaller)).toEqual([
      { runId: teamRun.claims.runId, teamOrigin: { teamId: origin.teamId }, requestId },
      { runId: privateRun.claims.runId, teamOrigin: null, requestId: null },
    ]);
    // Someone else joined the conversation mid-task: its owner's team knowledge is gone.
    personal = false;
    await expect(
      handlers.knowledge_topics({ caller: privateRun, input: {}, operationKey: "topics" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      handlers.knowledge_topics({
        caller: {
          kind: "connection",
          key: "connection:1",
          connectionId: "1",
          userId: teamRun.userId,
          accessMode: "full-access",
        },
        input: {},
        operationKey: "topics",
      }),
    ).rejects.toThrow("live Run");
    expect(topics).toHaveBeenCalledTimes(2);
  });
});
