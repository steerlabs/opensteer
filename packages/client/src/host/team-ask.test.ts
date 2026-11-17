import { describe, expect, it, vi, onTestFinished } from "vitest";
import { createId } from "@opensteer/core";
import {
  NeedsYouTeamAskEntrySchema,
  TeamAgentRequestSchema,
  type NeedsYouPage,
  type NeedsYouTeamAskEntry,
  type TeamAgentRequest,
} from "@opensteer/protocol";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
import { HttpHostClient } from "./host-session-client.js";
import { taskList } from "./task-list.js";
import { waitingInputs } from "./waiting-inputs.js";
import { teamAskOwnerControl, teamAskStatuses } from "../team/ask-status.js";

const teamId = createId("deployment");
const ownerUserId = createId("user");
const channelId = createId("teamChannel");
const at = "2026-11-13T12:00:00.000Z";
const ask = NeedsYouTeamAskEntrySchema.parse({
  kind: "team-ask",
  teamId,
  requestId: createId("teamAgentRequest"),
  createdAt: at,
  consentExpiresAt: "2026-11-20T12:00:00.000Z",
  presentation: {
    asker: { teamUserId: createId("user"), displayName: "Tim", actor: "agent" },
    bodyMarkdown: "Please review this proposal",
    attachments: [],
    destination: { teamId, channelId, threadRootId: "1" },
    audience: {
      teamName: "Acme",
      channelName: "general",
      channelKind: "public",
      memberCount: 2,
      peopleOnly: false,
    },
  },
});

/** The same ask from another team thread, which the Host admits into a task of its own. */
function askIn(threadRootId: string) {
  return NeedsYouTeamAskEntrySchema.parse({
    ...ask,
    requestId: createId("teamAgentRequest"),
    presentation: {
      ...ask.presentation,
      destination: { ...ask.presentation.destination, threadRootId },
    },
  });
}

function listed(page: NeedsYouPage | null | undefined, requestId: string) {
  const entry = page?.entries.find((row) => row.kind === "team-ask" && row.requestId === requestId);
  return entry?.kind === "team-ask" ? entry : undefined;
}

it("admits an ask into a task of its own as a gated waiting input that Needs you opens", () => {
  const mock = new MockHostClient({ latencyMs: 0, teamAsks: [ask] });
  try {
    const page = mock.getSnapshot().needsYou!;
    const entry = listed(page, ask.requestId)!;
    expect(entry.task).toMatchObject({ revision: 0 });
    const threadId = entry.task!.threadId;
    expect(mock.getSnapshot().threads.find(({ id }) => id === threadId)).toMatchObject({
      teamOrigin: ask.presentation.destination,
      title: "Tim · #general",
    });
    expect(
      taskList(mock.getSnapshot()).working.find((row) => row.threadId === threadId),
    ).toMatchObject({ line: "Tim's agent: Please review this proposal", tone: "needs-you" });
    mock.activateThread(threadId);
    expect(
      waitingInputs(mock.getThreadTranscript(threadId)?.getSnapshot().inputQueue!, {
        needsYou: page,
        ownsLease: () => false,
      }),
    ).toMatchObject([
      {
        approving: false,
        asker: "Tim's agent",
        canEdit: true,
        consent: { line: "Replies in #general · 2 people", sharedWith: [] },
        consentExpiresAt: ask.consentExpiresAt,
        kind: "ask",
        requestId: ask.requestId,
        revision: 0,
        teamId,
        text: "Please review this proposal",
      },
    ]);
  } finally {
    mock.dispose();
  }
});

it("folds status updates by sequence and keeps multiple targets beside their trigger", () => {
  const waiting = TeamAgentRequestSchema.parse({
    id: ask.requestId,
    kind: "ask",
    consentExpiresAt: ask.consentExpiresAt,
    ownerUserId,
    channelId,
    threadRootId: "1",
    triggerMessageId: "2",
    state: "awaiting_approval",
    steps: [],
    createdAt: at,
    acceptedAt: null,
    expiresAt: null,
    finishedAt: null,
    replyMessageId: null,
    failureCode: null,
    changeSeq: "1",
  });
  const declined = TeamAgentRequestSchema.parse({ ...waiting, state: "declined", changeSeq: "2" });
  const other = TeamAgentRequestSchema.parse({
    ...waiting,
    id: createId("teamAgentRequest"),
    ownerUserId: createId("user"),
  });
  expect(
    teamAskStatuses([declined, other, waiting], "2", (id) =>
      id === ownerUserId ? "Maya" : "Sam",
    ).map((row) => row.label),
  ).toEqual(["Maya · Declined", "Waiting for Sam"]);
  for (const [state, failureCode, replyMessageId, label] of [
    ["working", null, null, "Working"],
    ["done", null, "3", "Answered"],
    ["failed", "expired", null, "Expired"],
    ["cancelled", null, null, "Cancelled"],
  ] as const) {
    const request = TeamAgentRequestSchema.parse({
      ...waiting,
      state,
      failureCode,
      replyMessageId,
    });
    expect(teamAskStatuses([request], "2", () => "Maya")[0]?.label).toBe(`Maya · ${label}`);
    expect(teamAskStatuses([request], "1", () => "Maya")).toEqual([]);
  }
});

describe.each(["approve", "decline"] as const)("%s decision", (decision) => {
  it("settles only the answered ask at once, carries it out in its task, and refuses a repeat without double-counting", async () => {
    const second = askIn("2");
    const mock = new MockHostClient({ latencyMs: 0, teamAsks: [ask, second] });
    const transport = new MockPersonalHost(mock);
    const client = new HttpHostClient({
      baseUrl: "http://mock-host",
      fetch: transport.fetch,
      webSocketFactory: transport.connect,
    });
    try {
      await client.load();
      await vi.waitFor(
        () => expect(listed(client.getSnapshot().needsYou, ask.requestId)?.task).toBeDefined(),
        { timeout: 1000 },
      );
      const threadId = listed(client.getSnapshot().needsYou, ask.requestId)!.task!.threadId;
      client.activateThread(threadId);
      await vi.waitFor(
        () =>
          expect(
            client.getThreadTranscript(threadId)?.getSnapshot().inputQueue?.items,
          ).toHaveLength(1),
        { timeout: 1000 },
      );
      await client.decideTeamAsk(
        decision === "approve"
          ? { decision, expectedRevision: 0, requestId: ask.requestId, teamId }
          : { decision, requestId: ask.requestId, teamId },
      );
      const snapshot = client.getSnapshot();
      expect(listed(snapshot.needsYou, ask.requestId)).toBeUndefined();
      expect(listed(snapshot.needsYou, second.requestId)).toBeDefined();
      const queue = client.getThreadTranscript(threadId)?.getSnapshot().inputQueue;
      if (decision === "approve") {
        const waiting = waitingInputs(queue!, { ownsLease: () => false });
        // Approving until the team confirms; then it joins the line and a Run takes it.
        expect(waiting).toMatchObject([{ approving: true, canEdit: false, kind: "ask" }]);
        await vi.waitFor(
          () =>
            expect(
              mock.getSnapshot().transcripts[threadId]?.some((entry) => entry.kind === "run"),
              "the approved ask never started a Run",
            ).toBe(true),
          { timeout: 1000 },
        );
      } else {
        expect(queue).toBeNull();
        // The ask was all its task ever held, so the task goes with it.
        expect(mock.getSnapshot().threads.some(({ id }) => id === threadId)).toBe(false);
        expect(mock.getSnapshot().threadLookups[threadId]).toBe("missing");
      }
      const count = client.getSnapshot().needsYou!.count;
      await expect(
        client.decideTeamAsk(
          decision === "approve"
            ? { decision, expectedRevision: 0, requestId: ask.requestId, teamId }
            : { decision, requestId: ask.requestId, teamId },
        ),
      ).rejects.toThrow();
      expect(client.getSnapshot().needsYou!.count).toBe(count);
    } finally {
      client.dispose();
      transport.dispose();
      mock.dispose();
    }
  });
});

it("approves only the version of the ask the person saw", async () => {
  const mock = new MockHostClient({ latencyMs: 0, teamAsks: [ask] });
  try {
    const threadId = listed(mock.getSnapshot().needsYou, ask.requestId)!.task!.threadId;
    const messageId = listed(mock.getSnapshot().needsYou, ask.requestId)!.task!.messageId;
    const editor = await mock.editWaitingMessage(threadId, messageId);
    await editor.save([{ type: "text", text: "Please review the pricing section only" }], 0);
    expect(listed(mock.getSnapshot().needsYou, ask.requestId)?.task?.revision).toBe(1);
    await expect(
      mock.decideTeamAsk({
        decision: "approve",
        expectedRevision: 0,
        requestId: ask.requestId,
        teamId,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(listed(mock.getSnapshot().needsYou, ask.requestId)).toBeDefined();
    await mock.decideTeamAsk({
      decision: "approve",
      expectedRevision: 1,
      requestId: ask.requestId,
      teamId,
    });
    expect(listed(mock.getSnapshot().needsYou, ask.requestId)).toBeUndefined();
  } finally {
    mock.dispose();
  }
});

it("refreshes the loaded Needs you range without losing an older review or retaining settled cards", async () => {
  const asks = Array.from({ length: 105 }, (_, i) => ({
    ...askIn(String(i + 1)),
    createdAt: new Date(Date.parse(at) - i * 1000).toISOString(),
  }));
  let rows = [...asks];
  const mock = new MockHostClient({ latencyMs: 0, teamAsks: asks });
  const transport = new MockPersonalHost(mock);
  const client = new HttpHostClient({
    baseUrl: "http://mock-host",
    webSocketFactory: transport.connect,

    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname !== "/v1/rpc/needsYou.get") return transport.fetch(input, init);
      const query = JSON.parse(url.searchParams.get("input") ?? String(init?.body));
      const offset = query.before ? Number(query.before) : 0;
      const entries = rows.slice(offset, offset + 50);
      const end = offset + entries.length;
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            count: rows.length,
            entries,
            window: {
              byteCount: 100,
              itemCount: entries.length,
              totalItems: rows.length,
              hasMore: end < rows.length,
              nextBefore: end < rows.length ? String(end) : null,
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  try {
    await client.load();
    await vi.waitFor(
      () =>
        expect([...transport.sockets][0]?.sent.length, "client never subscribed").toBeGreaterThan(
          0,
        ),
      { timeout: 1000 },
    );
    transport.invalidateShell();
    await vi.waitFor(
      () =>
        expect(
          client.getSnapshot().needsYou?.entries,
          "first Needs you page never arrived",
        ).toHaveLength(50),
      { timeout: 1000 },
    );
    await client.loadEarlierNeedsYou();
    const older = asks[99]!;
    expect(client.getSnapshot().needsYou?.entries).toContainEqual(older);
    rows = [
      {
        ...ask,
        requestId: createId("teamAgentRequest"),
        createdAt: new Date(Date.parse(at) + 1000).toISOString(),
      },
      ...asks.filter((entry) => entry !== asks[50] && entry !== asks[51]),
    ];
    transport.invalidateShell();
    await vi.waitFor(
      () =>
        expect(client.getSnapshot().needsYou?.count, "Needs you refresh never arrived").toBe(
          rows.length,
        ),
      { timeout: 1000 },
    );
    const refreshed = client.getSnapshot().needsYou!;
    expect(refreshed.entries).toContainEqual(older);
    expect(refreshed.entries).not.toContainEqual(asks[50]);
    expect(refreshed.entries).not.toContainEqual(asks[51]);
    expect(
      new Set(
        refreshed.entries.map((entry) =>
          entry.kind === "team-ask" ? entry.requestId : entry.request.id,
        ),
      ).size,
    ).toBe(refreshed.entries.length);
    await client.loadEarlierNeedsYou();
    expect(client.getSnapshot().needsYou?.entries).toEqual(rows);
  } finally {
    client.dispose();
    transport.dispose();
    mock.dispose();
  }
});

it("gives an ask's owner the chat control only for the copy they would approve", () => {
  const waiting = TeamAgentRequestSchema.parse({
    id: ask.requestId,
    kind: "ask",
    consentExpiresAt: ask.consentExpiresAt,
    ownerUserId,
    channelId,
    threadRootId: "1",
    triggerMessageId: "2",
    state: "awaiting_approval",
    steps: [],
    createdAt: at,
    acceptedAt: null,
    expiresAt: null,
    finishedAt: null,
    replyMessageId: null,
    failureCode: null,
    changeSeq: "1",
  });
  const threadId = createId("thread");
  const messageId = createId("message");
  const page = (entry: NeedsYouTeamAskEntry): NeedsYouPage => ({
    count: 1,
    entries: [entry],
    window: {
      byteCount: 1,
      hasMore: false,
      itemCount: 1,
      nextBefore: null,
      totalItems: 1,
    },
  });
  const control = (
    request: TeamAgentRequest,
    entry: NeedsYouTeamAskEntry | null,
    viewerUserId: string = ownerUserId,
  ) =>
    teamAskOwnerControl({
      needsYou: entry ? page(entry) : null,
      request,
      teamId,
      viewerUserId,
    });
  const unedited = { ...ask, task: { threadId, messageId, revision: 0 } };
  expect(control(waiting, unedited)).toEqual({
    expectedRevision: 0,
    kind: "decide",
    requestId: ask.requestId,
    teamId,
    threadId,
  });
  expect(control(waiting, { ...ask, task: { threadId, messageId, revision: 2 } })).toEqual({
    kind: "review-edited",
    messageId,
    threadId,
  });
  // Everyone else, an ask not yet admitted, a failed one and a settled one keep the status line.
  expect(control(waiting, unedited, createId("user"))).toEqual({ kind: "none" });
  expect(control(waiting, null)).toEqual({ kind: "none" });
  expect(control(waiting, { ...ask, failureReason: "The task could not start." })).toEqual({
    kind: "none",
  });
  expect(control({ ...waiting, state: "working" }, unedited)).toEqual({ kind: "none" });
  expect(control({ ...waiting, pendingRemote: true }, unedited)).toEqual({ kind: "none" });
});

it.each(["rename", "done", "done-and-reopen", "message"] as const)(
  "preserves a mock ask task adopted by %s",
  async (adoption) => {
    const mock = new MockHostClient({ latencyMs: 0, teamAsks: [ask] });
    onTestFinished(() => mock.dispose());
    const task = listed(mock.getSnapshot().needsYou, ask.requestId)!.task!;
    if (adoption === "rename") await mock.renameThread(task.threadId, "My adopted task");
    if (adoption === "done" || adoption === "done-and-reopen")
      await mock.setTaskDone(task.threadId, true);
    if (adoption === "done-and-reopen") await mock.setTaskDone(task.threadId, false);
    if (adoption === "message")
      await mock.dispatch({
        type: "thread.sendMessage",
        threadId: task.threadId,
        content: [{ type: "text", text: "Keep this task" }],
        delivery: "queue",
        idempotencyKey: "adopt-message",
      });
    await mock.decideTeamAsk({ decision: "decline", teamId: ask.teamId, requestId: ask.requestId });
    expect(mock.getSnapshot().threads.some((thread) => thread.id === task.threadId)).toBe(true);
  },
);
