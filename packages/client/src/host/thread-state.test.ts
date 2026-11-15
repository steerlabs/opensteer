import { expect, it } from "vitest";
import { createId, AgentEventViewSchema, SequenceSchema } from "@opensteer/core";
import type { ThreadSummary } from "./client.js";
import { ThreadStateProjection } from "./thread-state.js";

it("retains return hints across stale pages and clears them through resumable state events", () => {
  const projection = new ThreadStateProjection();
  const thread = {
    id: createId("thread"),
    status: "idle",
    inputQueuePaused: false,
    pendingRequests: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as ThreadSummary;
  const hint = {
    eligible: true,
    eligibleAt: 123,
    sourceRunId: createId("run"),
    sessionRevision: "session:1:2",
  };
  const state = (sequence: string, returnHint: typeof hint | null) =>
    AgentEventViewSchema.parse({
      eventId: createId("event"),
      type: "thread.state-changed",
      threadId: thread.id,
      environmentId: createId("environment"),
      runId: null,
      sequence,
      createdAt: thread.updatedAt,
      data: { status: "idle", inputQueuePaused: false, pendingRequests: 0, returnHint },
    });
  projection.record(state("2", hint));
  expect(projection.reconcile(thread, SequenceSchema.parse("1")).returnHint).toEqual(hint);
  projection.record(state("3", null));
  expect(projection.reconcile(thread, SequenceSchema.parse("2")).returnHint).toBeNull();
});
