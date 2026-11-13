import { describe, expect, it, vi } from "vitest";
import { createId, OpensteerError, TeamMessageIdSchema, TeamSourceSchema } from "@opensteer/core";
import { PersonalTeamRequestSchema } from "@opensteer/protocol";
import type { PersonalTeamRequestsStore } from "@opensteer/database/personal-team-requests-store";
import type { PersonalTeamLinksStore } from "@opensteer/database/personal-team-links-store";
import { TeamRunTools } from "./tools.js";
import { PersonalTeamRequests } from "./requests.js";
import type { TeamLinkCallInput, TeamLinkResult } from "../team-link-endpoint/contracts.js";

function fixture() {
  const source = TeamSourceSchema.parse({
    teamId: createId("deployment"),
    channelId: createId("teamChannel"),
    threadRootId: "1",
    messageId: "2",
    audience: {
      teamName: "Acme",
      channelName: "support",
      channelKind: "public",
      memberCount: 12,
      peopleOnly: false,
    },
  });
  let row = PersonalTeamRequestSchema.parse({
    teamId: source.teamId,
    requestId: createId("teamAgentRequest"),
    triggerMessageId: "2",
    taskId: createId("thread"),
    inputId: createId("message"),
    runId: createId("run"),
    source,
    terminalState: null,
    publicationState: "pending",
    replyMessageId: null,
  });
  const outcome = {
    runId: row.runId,
    state: "done" as const,
    finalMessage: "The completed answer",
    answerMessageId: createId("message"),
  };
  let remote: ReturnType<typeof TeamMessageIdSchema.parse> | null = null;
  let loseAck = false;
  let denied = false;
  let offline = false;
  const calls: TeamLinkCallInput[] = [];
  const requests = {
    async forRun() {
      return structuredClone(row);
    },
    async get() {
      return structuredClone(row);
    },
    async mirror() {
      return structuredClone(row);
    },
    async mirrors() {
      return [structuredClone(row)];
    },
    async remote() {},
    async forTeam() {
      return [structuredClone(row)];
    },
    async terminal(_team, _request, runId, terminalState) {
      row = { ...row, runId, terminalState };
    },
    async clearFreeze(_team, _request, clientMessageId) {
      if (row.clientMessageId === clientMessageId && row.publicationState === "pending")
        row = {
          ...row,
          answerPayload: null,
          answerMessageId: null,
          clientMessageId: null,
          deliveryVia: null,
        };
    },
    async freeze(_team, _request, input) {
      if (!row.answerPayload)
        row = {
          ...row,
          answerMessageId: input.answerMessageId,
          answerPayload: input.payload,
          clientMessageId: input.clientMessageId,
          deliveryVia: input.via,
        };
      return structuredClone(row);
    },
    async publication(
      _team,
      _request,
      publicationState,
      replyMessageId = null,
      blockedReason = null,
    ) {
      row = { ...row, publicationState, replyMessageId, blockedReason };
    },
  } satisfies Partial<PersonalTeamRequestsStore>;
  const call = async (input: TeamLinkCallInput): Promise<TeamLinkResult> => {
    calls.push(input);
    if (offline) throw new OpensteerError({ code: "runner_offline", message: "Offline" });
    if (denied) throw new OpensteerError({ code: "forbidden", message: "people-only" });
    if (input.type === "reconcile")
      return {
        kind: "reconciled",
        requests: input.requestIds.map((requestId) => ({
          requestId,
          request: { id: requestId, kind: "self", state: "working" },
        })),
      } as TeamLinkResult;
    if (input.type === "receipt") return { kind: "receipt", messageId: remote };
    if (input.type === "read") return { kind: "read", result: { source } } as TeamLinkResult;
    if (input.type === "post") {
      if (!input.bodyMarkdown.trim() && !input.attachmentIds.length)
        throw new OpensteerError({ code: "bad_request", message: "Empty post" });
      remote = TeamMessageIdSchema.parse("99");
      if (loseAck) {
        loseAck = false;
        throw new OpensteerError({ code: "runner_offline", message: "Disconnected after commit" });
      }
      return { kind: "receipt", messageId: remote };
    }
    return { kind: "ok" };
  };
  const admission = {
    admitTeamReturn: vi.fn(),
    admitTeamRequest: vi.fn(),
    cancelTeamRequest: vi.fn(),
  };
  const publisher = new PersonalTeamRequests({
    links: {} as PersonalTeamLinksStore,
    requests: requests as unknown as PersonalTeamRequestsStore,
    admission,
    runs: { outcome: async () => outcome },
    rpc: () => ({ call }),
  });
  return {
    source,
    requests,
    publisher,
    tools: new TeamRunTools(
      {} as PersonalTeamLinksStore,
      requests as unknown as PersonalTeamRequestsStore,
      () => ({ call }),
    ),
    outcome,
    calls,
    admission,
    row: () => row,
    offline: (value: boolean) => {
      offline = value;
    },
    loseAck: () => {
      loseAck = true;
    },
    deny: () => {
      denied = true;
    },
    claim: () => {
      remote = TeamMessageIdSchema.parse("42");
      row = {
        ...row,
        deliveryVia: "tool",
        clientMessageId: crypto.randomUUID(),
        answerPayload: { bodyMarkdown: "The tool answer", attachmentIds: [] },
      };
    },
  };
}

describe("durable team publication", () => {
  it("publishes the final answer after a definitively rejected tool post", async () => {
    const f = fixture();
    await expect(
      f.tools.post({ runId: f.row().runId!, operationId: "empty-post" }, f.source.teamId, {
        channelId: f.source.channelId,
        threadRootId: f.source.threadRootId!,
        bodyMarkdown: "",
        attachmentIds: [],
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await f.publisher.reconcileOne(f.row());
    expect(f.row()).toMatchObject({
      publicationState: "accepted",
      deliveryVia: "final",
      answerPayload: { bodyMarkdown: "The completed answer" },
    });
  });
  it("keeps the frozen tool payload when a post commits but its acknowledgement is lost", async () => {
    const f = fixture();
    f.loseAck();
    await expect(
      f.tools.post({ runId: f.row().runId!, operationId: "lost-ack" }, f.source.teamId, {
        channelId: f.source.channelId,
        threadRootId: f.source.threadRootId!,
        bodyMarkdown: "Tool answer",
        attachmentIds: [],
      }),
    ).rejects.toMatchObject({ code: "runner_offline" });
    await f.publisher.reconnect(f.source.teamId);
    expect(f.row()).toMatchObject({
      publicationState: "accepted",
      deliveryVia: "tool",
      answerPayload: { bodyMarkdown: "Tool answer" },
    });
    expect(f.calls.filter((c) => c.type === "post")).toHaveLength(1);
  });
  it("delivers terminal status for a legacy row terminalized before publication", async () => {
    const f = fixture();
    await f.requests.terminal(f.source.teamId, f.row().requestId, f.row().runId, "done");
    await f.publisher.reconnect(f.source.teamId);
    expect(f.calls.map((c) => c.type)).toEqual(["receipt", "receipt", "post", "status"]);
  });
  it("freezes the completion answer before posting and reports a finished Run", async () => {
    const f = fixture();
    await f.publisher.reconcileOne(f.row());
    expect(f.row()).toMatchObject({
      publicationState: "accepted",
      deliveryVia: "final",
      answerMessageId: f.outcome.answerMessageId,
      answerPayload: { bodyMarkdown: "The completed answer", attachmentIds: [] },
      terminalState: "done",
      replyMessageId: "99",
    });
    expect(f.calls.map((c) => c.type)).toEqual(["receipt", "post", "status"]);
    expect(f.calls[1]).toMatchObject({
      publication: true,
      clientMessageId: f.row().clientMessageId,
      requestId: f.row().requestId,
    });
  });
  it("reconciles a lost receipt first on reconnect, preserving the frozen answer without rerunning", async () => {
    const f = fixture();
    f.loseAck();
    await f.publisher.reconcileOne(f.row());
    expect(f.row()).toMatchObject({
      publicationState: "pending",
      terminalState: null,
      deliveryVia: "final",
    });
    f.outcome.finalMessage = "A later private answer";
    await f.publisher.reconnect(f.source.teamId);
    expect(f.row()).toMatchObject({
      publicationState: "accepted",
      answerPayload: { bodyMarkdown: "The completed answer" },
    });
    expect(f.calls.filter((c) => c.type === "post")).toHaveLength(1);
    expect(f.admission.admitTeamRequest).not.toHaveBeenCalled();
    expect(f.calls[2]?.type).toBe("receipt");
  });
  it("freezes before an offline receipt check so later private changes cannot replace the answer", async () => {
    const f = fixture();
    f.offline(true);
    await f.publisher.reconcileOne(f.row());
    expect(f.row()).toMatchObject({
      publicationState: "pending",
      answerPayload: { bodyMarkdown: "The completed answer" },
    });
    f.outcome.finalMessage = "A later private answer";
    f.offline(false);
    await f.publisher.reconnect(f.source.teamId);
    expect(f.calls.find((c) => c.type === "post")).toMatchObject({
      bodyMarkdown: "The completed answer",
    });
  });
  it("keeps tool attribution and suppresses the automatic final when the reply is already claimed", async () => {
    const f = fixture();
    f.claim();
    await f.publisher.reconnect(f.source.teamId);
    expect(f.row()).toMatchObject({
      publicationState: "accepted",
      deliveryVia: "tool",
      replyMessageId: "42",
      terminalState: "done",
    });
    expect(f.calls.some((c) => c.type === "post")).toBe(false);
  });
  it("blocks oversized final answers with an explicit reason", async () => {
    const f = fixture();
    f.outcome.finalMessage = "a".repeat(17_000);
    await f.publisher.reconcileOne(f.row());
    expect(f.row()).toMatchObject({
      publicationState: "blocked",
      blockedReason: expect.stringContaining("message limit"),
    });
    expect(f.calls.some((c) => c.type === "post")).toBe(false);
  });
  it("records a terminal block reason rather than presenting it as sent", async () => {
    const f = fixture();
    f.deny();
    await f.publisher.reconcileOne(f.row());
    expect(f.row()).toMatchObject({
      publicationState: "blocked",
      blockedReason: expect.stringContaining("people-only"),
    });
    expect(f.calls.some((c) => c.type === "post")).toBe(false);
  });
});
