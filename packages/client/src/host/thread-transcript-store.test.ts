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
          text: "🦊abc",
          offset: 0,
          totalLength: 5,
          incomplete: false,
        },
      },
      "1",
    ),
  ).toBe("applied");
  expect(store.get(item.id)?.text).toBe("🦊abc");
  expect(changed).toHaveBeenCalledTimes(3);
  expect(unrelated).not.toHaveBeenCalled();
});

test("preserves incompleteness and fences late replies after closure and boot replacement", () => {
  const store = new ItemTextStore();
  store.generation(1);
  const address = {
    type: "host.live" as const,
    generation: 1,
    scope,
    subscriptionId,
    runId,
    attemptId,
    bindingGeneration: 2,
    streamId: "s",
    afterSequence: "3",
    itemId: item.id,
    liveBootId: crypto.randomUUID(),
  };
  const replace = {
    ...address,
    update: {
      operation: "replace" as const,
      offset: 0,
      totalLength: 2,
      text: "🦊",
      incomplete: true,
    },
  };
  expect(store.apply(replace, "2")).toBe("barrier");
  expect(store.apply(replace, "3")).toBe("applied");
  expect(
    store.apply(
      { ...address, update: { operation: "append", offset: 2, text: "b", totalLength: 3 } },
      "3",
    ),
  ).toBe("applied");
  expect(store.get(item.id)?.incomplete).toBe(true);
  expect(store.apply({ ...address, update: { operation: "close" } }, "3")).toBe("applied");
  expect(store.apply(replace, "3")).toBe("ignored");
  expect(store.get(item.id)).toBeUndefined();
  const newBoot = { ...replace, liveBootId: crypto.randomUUID() };
  expect(store.apply(newBoot, "3")).toBe("applied");
  expect(store.apply(replace, "3")).toBe("ignored");
  expect(store.apply({ ...newBoot, bindingGeneration: 1 }, "3")).toBe("ignored");
  expect(store.get(item.id)?.text).toBe("🦊");
});

test("an older stream's close leaves the replacement text installed", () => {
  const store = new ItemTextStore();
  store.generation(1);
  const frame = {
    type: "host.live" as const,
    generation: 1,
    scope,
    subscriptionId,
    runId,
    attemptId,
    bindingGeneration: 1,
    streamId: "old",
    afterSequence: "1",
    itemId: item.id,
    liveBootId: crypto.randomUUID(),
    update: { operation: "append" as const, offset: 0, totalLength: 1, text: "a" },
  };
  expect(store.apply(frame, "1")).toBe("applied");
  expect(store.apply({ ...frame, streamId: "new" }, "1")).toBe("applied");
  expect(store.apply({ ...frame, update: { operation: "close" } }, "1")).toBe("ignored");
  expect(store.get(item.id)?.streamId).toBe("new");
  expect(
    store.apply(
      { ...frame, streamId: "older-than-replacement", update: { operation: "close" } },
      "1",
    ),
  ).toBe("ignored");
});

test("sliding a history window retains a cursor immediately beside either evicted edge", () => {
  const store = new ThreadTranscriptStore();
  store.begin(1, false);
  const address = { subscriptionId, generation: 1, scope };
  const all = Array.from({ length: 300 }, (_, index) => {
    const id = createId("message");
    return { ...item, id, messageId: id, position: String(index + 1) };
  });
  const cursor = (boundary: typeof item) => ({
    deploymentId: createId("deployment"),
    viewerId: createId("user"),
    epoch: crypto.randomUUID(),
    threadId: scope.threadId,
    nodeId: null,
    orderRevision: "1",
    beforeId: boundary.id,
    beforePosition: boundary.position,
  });
  const latest = all.slice(-50);
  store.apply({
    ...address,
    type: "host.snapshot",
    throughSequence: "1",
    snapshot: {
      thread,
      orderRevision: "1",
      inputQueueRevision: "1",
      items: latest,
      activeItems: [],
      pendingRequests: [],
      nextBefore: cursor(latest[0]!),
    },
  });
  store.apply({ ...address, type: "host.synchronized", throughSequence: "1" });
  const page = (from: number, end: number) => ({
    kind: "page" as const,
    threadId: scope.threadId,
    nodeId: null,
    revision: "1",
    orderRevision: "1",
    items: all.slice(from, end),
    hasMore: from > 0,
    nextBefore: from ? cursor(all[from]!) : null,
    nextAfter: end < all.length ? cursor(all[end - 1]!) : null,
  });
  store.installPage(page(150, 250), 1, "earlier");
  store.installPage(page(50, 150), 1, "earlier");
  store.installPage(page(0, 50), 1, "earlier");
  expect(store.getSnapshot().ids).toEqual(all.slice(0, 250).map(({ id }) => id));
  expect(store.getSnapshot().snapshot?.nextAfter?.beforeId).toBe(all[249]!.id);
  store.installPage(page(250, 300), 1, "newer");
  expect(store.getSnapshot().ids).toEqual(all.slice(50).map(({ id }) => id));
  expect(store.getSnapshot().snapshot?.nextBefore?.beforeId).toBe(all[50]!.id);
});
