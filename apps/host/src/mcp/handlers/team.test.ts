import { describe, expect, it, vi } from "vitest";
import { createId, type Thread } from "@opensteer/core";
import { team_read, team_search, team_reply, sql } from "@opensteer/agent-tools/tools";
import type { RunCaller } from "../agent-caller.js";
import type { TeamToolPort } from "../team-tool-port.js";
import { teamToolHandlers } from "./team.js";
const origin = {
  teamId: createId("deployment"),
  channelId: createId("teamChannel"),
  threadRootId: "1",
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
describe("per-Run team authority", () => {
  it("uses only the current Run's request, even when the task was used by another request", async () => {
    const first = caller(),
      second = { ...caller(), thread: first.thread };
    const firstRequest = createId("teamAgentRequest"),
      secondRequest = createId("teamAgentRequest");
    const source = {
      ...origin,
      messageId: "1",
      audience: {
        teamName: "Acme",
        channelName: "support",
        channelKind: "public" as const,
        memberCount: 12,
        peopleOnly: false,
      },
    };
    const posted = vi.fn<TeamToolPort["reply"]>().mockResolvedValue({ messageId: "2", source });
    const port = { reply: posted } as unknown as TeamToolPort;
    const requestForRun = vi.fn(async (runId) =>
      runId === first.claims.runId ? firstRequest : secondRequest,
    );
    const handlers = teamToolHandlers({ port, requestForRun });
    for (const c of [first, second]) {
      expect(
        await handlers.team_reply({
          caller: c,
          input: { bodyMarkdown: "Result", attachmentPaths: [] },
          operationKey: "post",
        }),
      ).toEqual({ messageId: "2", source });
    }
    expect(posted.mock.calls.map(([run]) => run.requestId)).toEqual([firstRequest, secondRequest]);
    expect(requestForRun.mock.calls.map(([id]) => id)).toEqual([
      first.claims.runId,
      second.claims.runId,
    ]);
    for (const tool of [team_read, team_search, team_reply, sql]) {
      for (const key of ["requestId", "teamRequestId", "ownerId", "taskId", "token", "url"]) {
        const input =
          tool.name === "team_search"
            ? { query: "help" }
            : tool.name === "team_reply"
              ? { bodyMarkdown: "Result" }
              : {};
        expect(tool.input.safeParse({ ...input, [key]: "another" }).success).toBe(false);
      }
    }
  });
  it("denies a private follow-up in a bound task and every non-Run caller", async () => {
    const port = { read: vi.fn() } as unknown as TeamToolPort;
    const handlers = teamToolHandlers({ port, requestForRun: async () => null });
    const c = caller();
    await expect(
      handlers.team_read({ caller: c, input: {}, operationKey: "read" }),
    ).rejects.toThrow("no team request in this turn");
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
