import { createId } from "@opensteer/core";
import { expect, test, vi } from "vitest";
import { ItemTextStore } from "./item-text-store.js";
import { ThreadTranscriptStore } from "./thread-transcript-store.js";

const scope = { kind: "thread" as const, threadId: createId("thread") };
const subscriptionId = "detail:0" as const;
const createdAt = "2026-11-17T18:00:00.000Z";
const thread = {
  id: scope.threadId,
  title: "Fixture",
  revision: "1",
  status: "running" as const,
  purpose: "task" as const,
  askedAt: createdAt,
  doneAt: null,
  pendingRequestCount: 0,
  lastReplyPreview: null,
  failurePreview: null,
  latestRunCompletedAt: null,
};
const runId = createId("run");
const attemptId = createId("runAttempt");
const messageId = createId("message");
const item = {
  id: messageId,
  messageId,
  kind: "message" as const,
  revision: "1",
  position: "1",
  runId,
  attemptId,
  nodeId: null,
  isTurnStart: false,
  createdAt,
  view: { preview: "A" },
};

test("applies a whole commit while retaining structural identities on a content update", () => {
  const store = new ThreadTranscriptStore();
  store.begin(1, false);
  const base = { subscriptionId, generation: 1, scope };
  expect(
    store.apply({
      ...base,
      type: "host.snapshot",
      throughSequence: "1",
      snapshot: {
        thread,
        orderRevision: "0",
        inputQueueRevision: "0",
        items: [item],
        pendingRequests: [],
        activeItems: [],
        nextBefore: null,
      },
    }),
  ).toBe(true);
  expect(store.apply({ ...base, type: "host.synchronized", throughSequence: "1" })).toBe(true);
  const before = store.getSnapshot();
  const changed = vi.fn();
  store.subscribe(changed);
  expect(
    store.apply({
      ...base,
      type: "host.changes",
      fromSequence: "1",
      throughSequence: "2",
      changes: [
        {
          operation: "upsert",
          entityKind: "item",
          sequence: "2",
          ordinal: 0,
          entityId: item.id,
          value: { ...item, revision: "2", view: { preview: "B" } },
        },
      ],
    }),
  ).toBe(true);
  expect(store.getSnapshot().ids).toBe(before.ids);
  expect(changed).toHaveBeenCalledTimes(1);
  store.begin(2, true);
  expect(store.apply({ ...base, type: "host.removed", reason: "unavailable" })).toBe(false);
  expect(store.getSnapshot().items.get(item.id)?.view.preview).toBe("B");
});

test("notifies only the live item and requests one repair for a UTF-16 offset gap", () => {
  const store = new ItemTextStore();
  const changed = vi.fn();
  const unrelated = vi.fn();
  store.subscribe(item.id, changed);
  store.subscribe("unrelated", unrelated);
  store.generation(3);
  const frame = {
    type: "host.live" as const,
    subscriptionId,
    generation: 3,
    scope,
    liveBootId: crypto.randomUUID(),
    runId,
    attemptId,
    bindingGeneration: 1,
    streamId: "stream",
    itemId: item.id,
    afterSequence: "1",
  };
  expect(
    store.apply(
      { ...frame, update: { operation: "append", text: "🦊", offset: 0, totalLength: 2 } },
      "1",
    ),
  ).toBe("applied");
  const gap = {
    ...frame,
    update: { operation: "append" as const, text: "c", offset: 4, totalLength: 5 },
  };
  expect(store.apply(gap, "1")).toBe("repair");
  expect(store.apply(gap, "1")).toBe("ignored");
  expect(
    store.apply(
      {
        ...frame,
        update: {
          operation: "replace",
          text: "🦊bc",
          offset: 0,
          totalLength: 4,
          incomplete: false,
        },
      },
      "1",
    ),
  ).toBe("applied");
  expect(store.get(item.id)?.text).toBe("🦊bc");
  expect(changed).toHaveBeenCalledTimes(3);
  expect(unrelated).not.toHaveBeenCalled();
});
