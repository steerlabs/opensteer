import { TeamMessageIdSchema } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { createId, type Thread } from "@opensteer/core";
import {
  opensteer_knowledge_read,
  opensteer_knowledge_topic_list,
  opensteer_knowledge_save,
  opensteer_team_read,
  opensteer_team_search,
  opensteer_team_post,
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
        await handlers.opensteer_team_post({
          caller: c,
          input: {
            channelId: origin.channelId,
            threadId: origin.threadRootId,
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
      opensteer_team_read,
      opensteer_team_search,
      opensteer_team_post,
      opensteer_knowledge_topic_list,
      opensteer_knowledge_read,
      opensteer_knowledge_save,
    ]) {
      for (const key of ["requestId", "teamRequestId", "ownerId", "taskId", "token", "url"]) {
        const input =
          tool.name === "opensteer_team_search" || tool.name === "opensteer_knowledge_read"
            ? { query: "help" }
            : tool.name === "opensteer_team_post"
              ? { bodyMarkdown: "Result" }
              : tool.name === "opensteer_knowledge_save"
                ? { topicId: createId("knowledgeTopic"), title: "Note", body: "Text" }
                : {};
        expect(tool.input.safeParse({ ...input, [key]: "another" }).success).toBe(false);
      }
    }
  });
  it("reads older messages by cursor and newer ones after a message the agent saw", async () => {
    const read = vi.fn<TeamToolPort["read"]>().mockResolvedValue({
      source: { ...origin, messageId: TeamMessageIdSchema.parse("5") },
      page: { messages: [], hasMore: false },
    } as unknown as Awaited<ReturnType<TeamToolPort["read"]>>);
    const handlers = teamToolHandlers({
      port: { read } as unknown as TeamToolPort,
      personalContext: async () => true,
    });
    for (const input of [
      { channelId: origin.channelId, cursor: "4" },
      { channelId: origin.channelId, afterMessageId: TeamMessageIdSchema.parse("4") },
    ])
      await handlers.opensteer_team_read({ caller: caller(), input, operationKey: "read" });
    expect(read.mock.calls.map(([, query]) => query)).toEqual([
      { channelId: origin.channelId, before: "4" },
      { channelId: origin.channelId, after: "4" },
    ]);
    expect(
      opensteer_team_read.input.safeParse({
        channelId: origin.channelId,
        cursor: "4",
        afterMessageId: "4",
      }).success,
    ).toBe(false);
  });

  it("denies shared conversations and every non-Run caller", async () => {
    const port = { read: vi.fn() } as unknown as TeamToolPort;
    const handlers = teamToolHandlers({ port, personalContext: async () => false });
    const c = caller();
    await expect(
      handlers.opensteer_team_read({ caller: c, input: {}, operationKey: "read" }),
    ).rejects.toThrow("other people share");
    await expect(
      handlers.opensteer_team_read({
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
      await handlers.opensteer_knowledge_topic_list({
        caller: c,
        input: {},
        operationKey: "topics",
      });
    expect(topics.mock.calls.map(([knowledgeCaller]) => knowledgeCaller)).toEqual([
      { runId: teamRun.claims.runId, teamOrigin: { teamId: origin.teamId }, requestId },
      { runId: privateRun.claims.runId, teamOrigin: null, requestId: null },
    ]);
    // Someone else joined the conversation mid-task: its owner's team knowledge is gone.
    personal = false;
    await expect(
      handlers.opensteer_knowledge_topic_list({
        caller: privateRun,
        input: {},
        operationKey: "topics",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      handlers.opensteer_knowledge_topic_list({
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
