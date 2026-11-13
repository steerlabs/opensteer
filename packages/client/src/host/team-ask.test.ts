import { describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import { NeedsYouTeamAskEntrySchema, TeamAgentRequestSchema } from "@opensteer/protocol";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
import { HttpHostClient } from "./host-session-client.js";
import { needsYouIndex, settleTeamAsk } from "./needs-you.js";
import { teamAskStatuses } from "../team/ask-status.js";

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

it("projects consent without inventing a local task, and settles only the acknowledged ask", () => {
  const mock = new MockHostClient({ latencyMs: 0, teamAsks: [ask] });
  try {
    const page = mock.getSnapshot().needsYou!;
    const index = needsYouIndex(page);
    expect(index.entries).toContainEqual(ask);
    expect([...index.byTask.values()].flat().every((entry) => entry.kind === "request")).toBe(true);
    const settled = settleTeamAsk(page, teamId, ask.requestId)!;
    expect(settled.count).toBe(page.count - 1);
    expect(settled.entries).toEqual(page.entries.filter((entry) => entry.kind !== "team-ask"));
    expect(settleTeamAsk(settled, teamId, ask.requestId)).toBe(settled);
    expect(settleTeamAsk(page, createId("deployment"), ask.requestId)).toBe(page);
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
  it("reconciles an acknowledgement without removing another card or double-counting a later refusal", async () => {
    const second = { ...ask, requestId: createId("teamAgentRequest") };
    const mock = new MockHostClient({ latencyMs: 0, teamAsks: [ask, second] });
    const transport = new MockPersonalHost(mock);
    const client = new HttpHostClient({
      baseUrl: "http://mock-host",
      fetch: transport.fetch,
      webSocketFactory: transport.connect,
      refreshIntervalMs: 0,
    });
    try {
      await client.load();
      await vi.waitFor(() => expect(client.getSnapshot().needsYou?.entries).toContainEqual(ask), {
        timeout: 1000,
      });
      await client.dispatch({
        type: "teams.ask.decide",
        teamId,
        requestId: ask.requestId,
        decision,
      });
      expect(client.getSnapshot().needsYou?.entries).not.toContainEqual(ask);
      expect(client.getSnapshot().needsYou?.entries).toContainEqual(second);
      const count = client.getSnapshot().needsYou!.count;
      await expect(
        client.dispatch({ type: "teams.ask.decide", teamId, requestId: ask.requestId, decision }),
      ).rejects.toThrow();
      expect(client.getSnapshot().needsYou!.count).toBe(count);
    } finally {
      client.dispose();
      mock.dispose();
    }
  });
});
