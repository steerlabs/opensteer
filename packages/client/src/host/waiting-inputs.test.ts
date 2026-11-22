import { mockInputQueue } from "../mock/mock-scoped-personal.js";
import { expect, it } from "vitest";
import {
  MessageRevisionViewSchema,
  ThreadInputQueueViewSchema,
  createId,
  type ThreadInputQueue,
} from "@opensteer/core";
import { messageRevisionRows, waitingInputs } from "./waiting-inputs.js";

const threadId = createId("thread");
const viewerId = createId("user");
const at = "2026-11-14T12:00:00.000Z";
const person = {
  displayName: "Alex",
  kind: "human",
  principalId: `user:${viewerId}`,
  userId: viewerId,
} as const;
const mayaId = createId("user");
const maya = {
  displayName: "Maya",
  kind: "human",
  principalId: `user:${mayaId}`,
  userId: mayaId,
} as const;

function item(
  text: string,
  author: object,
  options: {
    readonly lease?: { leaseId: string; deviceLabel: string; expiresAt: string } | null;
    readonly revision?: number;
  } = {},
) {
  const messageId = createId("message");
  return {
    canCancel: true,
    canEdit: true,
    canMove: true,
    canSteer: true,
    input: {
      assignmentId: null,
      cancelReason: null,
      causalChainId: createId("causalChain"),
      createdAt: at,
      deliveredAt: null,
      messageId,
      policy: "queue",
      replyTarget: null,
      runId: null,
      state: "pending",
      threadId,
      updatedAt: at,
    },
    lease: options.lease ?? null,
    message: {
      author,
      content: [{ text, type: "text" }],
      createdAt: at,
      id: messageId,
      kind: "input",
      runId: null,
      sequence: "1",
      threadId,
      ...(options.revision ? { edit: { editedAt: at, revision: options.revision } } : {}),
    },
  };
}

function queue(items: readonly object[], paused = false): ThreadInputQueue {
  return ThreadInputQueueViewSchema.parse({ items, paused, steerRunId: null, threadId });
}

it("lists what waits for the agent in order: the person's messages", () => {
  const followUp = item("Delegation result", {
    displayName: "Researcher",
    kind: "agent",
    runId: createId("run"),
    threadId: createId("thread"),
  });
  const own = item("Draft the reply", person, {
    lease: { deviceLabel: "Chrome on Mac", expiresAt: at, leaseId: "lease-mine-0000001" },
  });
  const released = item("Check the invoice", maya, { revision: 1 });
  const held = item("And the refund", person, {
    lease: { deviceLabel: "Alex's iPad", expiresAt: at, leaseId: "lease-other-000001" },
  });
  const list = waitingInputs(
    mockInputQueue(
      queue([followUp, own, released, held]),
      "0",
      (leaseId) => leaseId === "lease-mine-0000001",
    ),
  );
  expect(list.map(({ kind, text }) => [kind, text])).toEqual([
    ["message", "Draft the reply"],
    ["message", "Check the invoice"],
    ["message", "And the refund"],
  ]);
  // A follow-up ahead of every message means none of them is next.
  expect(list.some((input) => input.kind === "message" && input.next)).toBe(false);
  expect(list[0]!.lease).toEqual({ kind: "mine" });
  expect(list[1]).toMatchObject({ edit: { revision: 1 }, revision: 1, lease: { kind: "none" } });
  expect(list[2]!.lease).toEqual({
    deviceLabel: "Alex's iPad",
    expiresAt: at,
    kind: "other",
  });

  const [first] = waitingInputs(mockInputQueue(queue([own]), "0", () => false));
  expect(first).toMatchObject({ kind: "message", next: true });
  const [paused] = waitingInputs(mockInputQueue(queue([own], true), "0", () => false));
  expect(paused).toMatchObject({ next: false });
});

it("names each version for its history: another person's original, then the person's edits", () => {
  const revision = (n: number, author: object, deviceLabel: string | null) =>
    MessageRevisionViewSchema.parse({
      author,
      content: [{ text: `Version ${n}`, type: "text" }],
      createdAt: at,
      deviceLabel,
      revision: n,
    });
  expect(
    messageRevisionRows(
      [
        revision(2, person, "Alex's iPhone"),
        revision(1, person, "Chrome on Mac"),
        revision(0, maya, null),
      ],
      viewerId,
    ).map(({ by, current, device, original, text }) => ({ by, current, device, original, text })),
  ).toEqual([
    { by: "You", current: true, device: "Alex's iPhone", original: false, text: "Version 2" },
    { by: "You", current: false, device: "Chrome on Mac", original: false, text: "Version 1" },
    { by: "Maya", current: false, device: null, original: true, text: "Version 0" },
  ]);
});
