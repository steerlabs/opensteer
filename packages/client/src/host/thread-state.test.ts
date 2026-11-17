import { expect, it } from "vitest";
import { createId, SequenceSchema } from "@opensteer/core";
import type { ThreadSummary } from "./client.js";
import { ThreadStateProjection } from "./thread-state.js";

it("retains return hints across stale pages and clears them when the next scoped Task revision clears them", () => {
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
  projection.reconcile({ ...thread, returnHint: hint }, SequenceSchema.parse("2"));
  expect(projection.reconcile(thread, SequenceSchema.parse("1")).returnHint).toEqual(hint);
  projection.reconcile({ ...thread, returnHint: null }, SequenceSchema.parse("3"));
  expect(projection.reconcile(thread, SequenceSchema.parse("2")).returnHint).toBeNull();
});
