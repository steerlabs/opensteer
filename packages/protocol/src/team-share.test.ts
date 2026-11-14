import { TeamRunRequestSchema } from "./team-link.js";
import { expect, it } from "vitest";
import { createId } from "@opensteer/core";
import {
  TeamShareBatchSchema,
  TeamShareOperationSchema,
  TeamShareRowSchema,
  teamShareBatchRows,
} from "./team-share.js";

function row() {
  return {
    kind: "text",
    publicId: crypto.randomUUID(),
    ordinal: "1",
    sequence: "1",
    author: { teamId: createId("deployment"), userId: createId("user") },
    authorKind: "human",
    clientMessageId: crypto.randomUUID(),
    bodyMarkdown: "Hello",
    threadRootPublicId: null,
    createdAt: new Date().toISOString(),
    editedAt: null,
    deletedAt: null,
    pinnedBy: null,
  };
}
it("admits only share-scoped text DTOs without member, request or local message authority", () => {
  const value = row();
  expect(TeamShareRowSchema.safeParse(value).success).toBe(true);
  for (const extra of [
    { id: "1" },
    { channelId: createId("teamChannel") },
    { agentRequestId: createId("teamAgentRequest") },
    { requests: [] },
    { author: { ...value.author, image: "https://partner.invalid/tracker" } },
  ])
    expect(TeamShareRowSchema.safeParse({ ...value, ...extra }).success).toBe(false);
  expect(TeamShareRowSchema.safeParse({ ...value, kind: "future" }).success).toBe(false);
  expect(
    TeamShareOperationSchema.safeParse({
      op: "pull",
      shareId: createId("teamChannel"),
      generation: 1,
      cursor: { created: "0", sequence: "0", publicId: "" },
    }).success,
  ).toBe(false);
});
it("bounds both sync rows and encoded batch bytes", () => {
  const batch = {
    rows: [row()],
    people: [],
    peopleOnly: false,
    cursor: { created: "1", sequence: "1", publicId: "" },
    more: false,
  };
  expect(TeamShareBatchSchema.safeParse(batch).success).toBe(true);
  expect(
    TeamShareBatchSchema.safeParse({
      ...batch,
      rows: Array.from({ length: teamShareBatchRows + 1 }, row),
    }).success,
  ).toBe(false);
  const large = { ...row(), bodyMarkdown: "x".repeat(10_000) };
  expect(TeamShareRowSchema.safeParse(large).success).toBe(true);
  expect(
    TeamShareBatchSchema.safeParse({
      ...batch,
      rows: Array.from({ length: teamShareBatchRows }, () => large),
    }).success,
  ).toBe(false);
});

it("keeps partner ask status free of local execution authority and private tool steps", () => {
  const status = {
    revision: "1",
    state: "awaiting_approval",
    consentExpiresAt: new Date().toISOString(),
    acceptedAt: null,
    expiresAt: null,
    finishedAt: null,
    failureCode: null,
    outcome: null,
    replyPublicId: null,
  };
  const operation = {
    op: "ask.status",
    shareId: crypto.randomUUID(),
    generation: 1,
    triggerPublicId: crypto.randomUUID(),
    target: row().author,
    status,
  };
  expect(TeamShareOperationSchema.safeParse(operation).success).toBe(true);
  for (const extra of [
    { resumeRunId: createId("run") },
    { requestId: createId("teamAgentRequest") },
    { steps: [{ kind: "read_files", count: 1 }] },
  ])
    expect(
      TeamShareOperationSchema.safeParse({ ...operation, status: { ...status, ...extra } }).success,
    ).toBe(false);
  expect(TeamRunRequestSchema.shape.request.shape.kind.safeParse(undefined).success).toBe(false);
});
