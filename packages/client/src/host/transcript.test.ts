import {
  createId,
  SequenceSchema,
  type AgentEventView as AgentEvent,
  type Request,
  type ThreadInputQueue,
} from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { mockBrowserSignInRequest } from "../mock/mock-chrome-sign-ins.js";
import type { TranscriptEntry } from "./client.js";
import { LiveStreamLedger } from "./live-progress.js";
import { requestReceipt, visibleTranscript } from "./transcript.js";

const now = "2026-08-09T20:00:00.000Z";
const environmentId = createId("environment");
const threadId = createId("thread");
const runId = createId("run");

function event<Type extends AgentEvent["type"]>(
  type: Type,
  data: Extract<AgentEvent, { type: Type }>["data"],
  overrides: { createdAt?: string; runId?: AgentEvent["runId"] } = {},
): Extract<AgentEvent, { type: Type }> {
  return {
    createdAt: overrides.createdAt ?? now,
    data,
    environmentId,
    eventId: createId("event"),
    runId: "runId" in overrides ? overrides.runId : runId,
    sequence: "1",
    threadId,
    type,
  } as Extract<AgentEvent, { type: Type }>;
}

/*
 * History read over HTTP can tell the ledger a stream completed before any of
 * the Run's live frames arrive. Failure modes:
 * - a completion for a Run the ledger has never seen is forgotten, and a late
 *   frame from before it draws the stale partial beside the final answer;
 * - remembering that completion must not block the Run's next stream;
 * - a completion read for a Run that already ended must not bring it back.
 */
describe("LiveStreamLedger completions", () => {
  const at = (sequence: string) => SequenceSchema.parse(sequence);
  const frame = (afterSequence: string, text: string, frameRunId = runId) => ({
    afterSequence: at(afterSequence),
    progress: {
      items: [{ at: 0, op: "append" as const, stream: "assistant" as const, text }],
      runId: frameRunId,
      threadId,
    },
  });
  const answered = (sequence: string, eventRunId = runId) => ({
    ...event(
      "assistant.message",
      { content: [{ text: "Alpha done.", type: "text" }], messageId: createId("message") },
      { runId: eventRunId },
    ),
    sequence: at(sequence),
  });

  it("remembers a completion for a Run it has not seen stream", () => {
    const ledger = new LiveStreamLedger();
    ledger.complete(answered("2"));

    expect(ledger.apply(frame("1", "Alpha ")).changed).toBeNull();
    expect(ledger.threadRuns(threadId)).toEqual([]);
    expect(ledger.apply(frame("2", "Beta")).changed?.streams).toEqual([
      { key: { stream: "assistant" }, length: 4, tail: "Beta" },
    ]);
  });

  it("does not bring back a Run that ended when an older completion is read", () => {
    const ended = createId("run");
    const ledger = new LiveStreamLedger();
    ledger.complete({
      ...event("run.completed", { replyMessageId: null, status: "completed" }, { runId: ended }),
      sequence: at("5"),
    });
    ledger.complete(answered("4", ended));

    expect(ledger.apply(frame("6", "late", ended)).changed).toBeNull();
    expect(ledger.threadRuns(threadId)).toEqual([]);
  });
});

describe("visibleTranscript", () => {
  const queuedId = createId("message");
  const shownId = createId("message");
  const entries: TranscriptEntry[] = [
    {
      author: { displayName: "Owner", kind: "human", principalId: "user:test-owner" },
      body: "Do the work",
      createdAt: now,
      id: shownId,
      kind: "message",
      messageKind: "input",
      runId,
    },
    {
      createdAt: now,
      error: null,
      id: `run:${runId}`,
      kind: "run",
      replyMessageId: null,
      runId,
      status: "running",
    },
    {
      author: { displayName: "Owner", kind: "human", principalId: "user:test-owner" },
      body: "And then this",
      createdAt: now,
      id: queuedId,
      kind: "message",
      messageKind: "input",
      runId: null,
    },
  ];

  function queue(items: ThreadInputQueue["items"]): ThreadInputQueue {
    return { items, paused: false, steerRunId: runId, threadId };
  }

  function queued(id: typeof queuedId): ThreadInputQueue["items"][number] {
    return {
      canCancel: true,
      canEdit: true,
      canMove: true,
      canSteer: true,
      lease: null,
      input: {
        teamRequestId: null,
        teamSource: null,
        assignmentId: null,
        cancelReason: null,
        causalChainId: createId("causalChain"),
        createdAt: now,
        deliveredAt: null,
        messageId: id,
        policy: "queue",
        replyTarget: null,
        runId: null,
        state: "pending",
        threadId,
        updatedAt: now,
      },
      message: {
        author: { displayName: "Owner", kind: "human", principalId: "user:test-owner" },
        content: [{ text: "And then this", type: "text" }],
        createdAt: now,
        id,
        kind: "input",
        runId: null,
        sequence: SequenceSchema.parse("2"),
        threadId,
      },
    };
  }

  it("hides exactly the messages the queue still holds", () => {
    const visible = visibleTranscript(entries, queue([queued(queuedId)]));
    expect(visible.map((entry) => entry.id)).toEqual([shownId, `run:${runId}`]);
  });
});

describe("a Chrome sign-in's receipt", () => {
  const site = "https://brex.com";
  const ended = (value: Record<string, unknown>) =>
    requestReceipt({
      ...mockBrowserSignInRequest(site, 1),
      resolvedAt: "2026-08-07T19:30:00.000Z",
      resolvedBy: "usr_0192f4a1-0000-4000-8000-000000000001",
      response: { kind: "external", value },
      status: "fulfilled",
    } as Extract<Request, { status: "fulfilled" }>);

  it("says what reached the browser, never that the site accepted it", () => {
    expect(ended({ outcome: "not-signed-in" }).outcome).toBe("Chrome not signed in");
    expect(ended({ outcome: "applied", profileName: null, sourceName: "Work" }).outcome).toBe(
      "Copied Chrome sign-in for brex.com",
    );
  });
});
