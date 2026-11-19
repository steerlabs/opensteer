import { createId, TeamMessageIdSchema } from "@opensteer/core";
import { expect, test, vi } from "vitest";
import { ItemTextStore } from "./item-text-store.js";
import { transcriptCard } from "./transcript-item-view.js";
import { ThreadTranscriptStore } from "./thread-transcript-store.js";
import { detailThread } from "../test-support/scoped-transcript-fixture.js";

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
        thread: detailThread(thread),
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

test("keeps sent and blocked Team delivery on the answering Run across status and history updates", () => {
  const store = new ThreadTranscriptStore();
  const base = { subscriptionId, generation: 1, scope };
  const running = {
    ...item,
    id: `run:${runId}`,
    kind: "run" as const,
    view: { status: "running" },
  };
  const sending = {
    state: "sending" as const,
    via: "tool" as const,
    answerMessageId: messageId,
    teamMessageId: null,
    reason: null,
  };
  const sent = {
    ...sending,
    state: "sent" as const,
    teamMessageId: TeamMessageIdSchema.parse("42"),
  };
  const blocked = { ...sending, state: "blocked" as const, reason: "Link revoked" };
  store.begin(1, false);
  expect(
    store.apply({
      ...base,
      type: "host.snapshot",
      throughSequence: "1",
      snapshot: {
        thread: detailThread(thread),
        items: [running],
        pendingRequests: [],
        activeItems: [],
        nextBefore: null,
      },
    }),
  ).toBe(true);
  expect(store.apply({ ...base, type: "host.synchronized", throughSequence: "1" })).toBe(true);
  const runCard = () => transcriptCard(store.getSnapshot().items.get(running.id)!);
  const apply = (value: Parameters<typeof transcriptCard>[0]) => {
    const through = store.getSnapshot().through!;
    expect(
      store.apply({
        ...base,
        type: "host.changes",
        fromSequence: through,
        throughSequence: value.revision,
        changes: [
          {
            operation: "upsert",
            entityKind: "item",
            sequence: value.revision,
            ordinal: 0,
            entityId: value.id,
            value,
          },
        ],
      }),
    ).toBe(true);
  };

  apply({ ...running, revision: "2", delivery: sending });
  apply({ ...running, revision: "3", delivery: sent });
  const completed = {
    ...running,
    revision: "4",
    replyMessageId: messageId,
    view: { status: "completed" },
    delivery: sent,
  };
  apply(completed);
  expect(runCard()).toMatchObject({
    delivery: sent,
    status: "completed",
    replyMessageId: messageId,
  });
  expect(
    store.installPage(
      {
        kind: "page",
        threadId: scope.threadId,
        nodeId: null,
        revision: "4",
        items: [{ ...running, revision: "3" }],
        nextBefore: null,
        nextAfter: null,
        hasMore: false,
      },
      1,
      "earlier",
    ),
  ).toBe(true);
  expect(runCard()).toMatchObject({ delivery: sent, status: "completed" });
  apply({ ...completed, revision: "5", delivery: blocked });
  expect(runCard()).toMatchObject({
    delivery: blocked,
    status: "completed",
    replyMessageId: messageId,
  });
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
    beforeId: boundary.id,
    beforePosition: boundary.position,
  });
  const latest = all.slice(-50);
  store.apply({
    ...address,
    type: "host.snapshot",
    throughSequence: "1",
    snapshot: {
      thread: detailThread(thread),
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

test("history pages land during a Run and keep an unhide or removal made while they were read", () => {
  const store = new ThreadTranscriptStore();
  store.begin(1, false);
  const address = { subscriptionId, generation: 1, scope };
  const message = (position: number, revision = "1") => {
    const id = createId("message");
    return { ...item, id, messageId: id, position: String(position), revision };
  };
  const all = Array.from({ length: 10 }, (_, index) => message((index + 1) * 10));
  const cursor = (boundary: typeof item) => ({
    deploymentId: createId("deployment"),
    viewerId: createId("user"),
    epoch: crypto.randomUUID(),
    threadId: scope.threadId,
    nodeId: null,
    beforeId: boundary.id,
    beforePosition: boundary.position,
  });
  const latest = all.slice(5);
  store.apply({
    ...address,
    type: "host.snapshot",
    throughSequence: "5",
    snapshot: {
      thread: detailThread(thread),
      items: latest,
      activeItems: [],
      pendingRequests: [],
      nextBefore: cursor(latest[0]!),
    },
  });
  store.apply({ ...address, type: "host.synchronized", throughSequence: "5" });
  let through = 5;
  const commit = (...changes: object[]) => {
    const from = String(through++);
    expect(
      store.apply({
        ...address,
        type: "host.changes",
        fromSequence: from,
        throughSequence: String(through),
        changes: changes.map((change, ordinal) => ({
          ...change,
          ordinal,
          sequence: String(through),
        })) as never,
      }),
    ).toBe(true);
  };
  const reply = message(200, "6");
  const unhidden = message(25, "7");
  const removed = all[3]!;
  const read = store.beginRead();
  // A Run streams a reply, an older message is unhidden and another is hidden while the page is read.
  commit({ operation: "upsert", entityKind: "item", entityId: reply.id, value: reply });
  commit({ operation: "upsert", entityKind: "item", entityId: unhidden.id, value: unhidden });
  commit({ operation: "remove", entityKind: "item", entityId: removed.id });
  expect(store.getSnapshot().items.has(unhidden.id)).toBe(false);
  expect(
    store.installPage(
      {
        kind: "page",
        threadId: scope.threadId,
        nodeId: null,
        revision: "5",
        items: all.slice(0, 5),
        hasMore: false,
        nextBefore: null,
        nextAfter: cursor(all[4]!),
      },
      1,
      "earlier",
      read,
    ),
  ).toBe(true);
  store.endRead(read);
  const ids = store.getSnapshot().historyIds;
  expect(ids).toContain(unhidden.id);
  expect(ids).not.toContain(removed.id);
  expect(ids).toEqual(
    [...all.filter(({ id }) => id !== removed.id), unhidden, reply]
      .sort((a, b) => Number(a.position) - Number(b.position))
      .map(({ id }) => id),
  );
  expect(store.getSnapshot().snapshot?.nextBefore).toBeNull();

  // Jumping to a message also lands while changes arrive.
  const jump = store.beginRead();
  commit({
    operation: "upsert",
    entityKind: "item",
    entityId: reply.id,
    value: { ...reply, revision: String(through + 1), view: { preview: "B" } },
  });
  expect(
    store.installPage(
      {
        kind: "page",
        threadId: scope.threadId,
        nodeId: null,
        revision: "8",
        items: all.slice(0, 3),
        hasMore: false,
        nextBefore: null,
        nextAfter: cursor(all[2]!),
      },
      1,
      "around",
      jump,
    ),
  ).toBe(true);
  store.endRead(jump);
  expect(store.getSnapshot().historyIds).toEqual(all.slice(0, 3).map(({ id }) => id));
});

test("an inline repair replaces the scope in place and keeps earlier pages that still meet it", () => {
  const store = new ThreadTranscriptStore();
  store.begin(1, false);
  const address = { subscriptionId, generation: 1, scope };
  const all = Array.from({ length: 80 }, (_, index) => {
    const id = createId("message");
    return { ...item, id, messageId: id, position: String(index + 1) };
  });
  const cursor = (boundary: typeof item) => ({
    deploymentId: createId("deployment"),
    viewerId: createId("user"),
    epoch: crypto.randomUUID(),
    threadId: scope.threadId,
    nodeId: null,
    beforeId: boundary.id,
    beforePosition: boundary.position,
  });
  const cut = (items: typeof all, throughSequence: string) =>
    store.apply({
      ...address,
      type: "host.snapshot",
      throughSequence,
      snapshot: {
        thread: detailThread(thread),
        items,
        activeItems: [],
        pendingRequests: [],
        nextBefore: cursor(items[0]!),
      },
    });
  cut(all.slice(30, 80), "1");
  store.apply({ ...address, type: "host.synchronized", throughSequence: "1" });
  store.installPage(
    {
      kind: "page",
      threadId: scope.threadId,
      nodeId: null,
      revision: "1",
      items: all.slice(0, 30),
      hasMore: false,
      nextBefore: null,
      nextAfter: cursor(all[29]!),
    },
    1,
    "earlier",
  );
  const edited = { ...all[79]!, revision: "9", view: { preview: "Edited while away" } };
  // The Host could not replay the gap and sends the latest window on the same subscription.
  expect(cut([...all.slice(31, 79), edited], "9")).toBe(true);
  const state = store.getSnapshot();
  expect(state.synchronized).toBe(true);
  expect(state.through).toBe("9");
  expect(state.historyIds).toEqual(
    [...all.slice(0, 31), ...all.slice(31, 79), edited].map(({ id }) => id),
  );
  expect(state.items.get(edited.id)).toBe(edited);
  expect(state.snapshot?.nextBefore).toBeNull();
});
