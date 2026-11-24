import { createId } from "@opensteer/core";
import { expect, test, vi } from "vitest";
import { ItemTextStore } from "./item-text-store.js";
import { displayedItemIds, ThreadTranscriptStore } from "./thread-transcript-store.js";
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
  doneReason: null,
  pendingRequestCount: 0,
  lastReplyPreview: null,
  failurePreview: null,
  latestRunCompletedAt: null,
  environmentId: createId("environment"),
  harnessInstanceId: createId("harnessInstance"),
  runQueued: false,
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

test("pages accumulate whole, and a live row bounds the window with a cursor beside its evicted edge", () => {
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
  const earlier = (from: number, end: number) =>
    store.installPage(page(from, end), 1, {
      mode: "earlier",
      from: store.getSnapshot().snapshot!.nextBefore!,
    });
  expect(earlier(150, 250)).toBe("installed");
  expect(earlier(50, 150)).toBe("installed");
  expect(earlier(0, 50)).toBe("installed");
  // Every page the reader asked for is held: nothing they loaded leaves under them.
  expect(store.getSnapshot().ids).toEqual(all.map(({ id }) => id));
  expect(store.getSnapshot().snapshot?.nextBefore).toBeNull();
  expect(store.getSnapshot().newest).toBe(true);
  // Following the latest, the next live row bounds the window above the reader.
  const next = { ...item, id: createId("message"), position: "301", revision: "2" };
  store.apply({
    ...address,
    type: "host.changes",
    fromSequence: "1",
    throughSequence: "2",
    changes: [
      {
        operation: "upsert",
        entityKind: "item",
        sequence: "2",
        ordinal: 0,
        entityId: next.id,
        value: next,
      },
    ],
  } as never);
  expect(store.getSnapshot().historyIds).toEqual([...all.slice(51), next].map(({ id }) => id));
  expect(store.getSnapshot().snapshot?.nextBefore?.beforeId).toBe(all[51]!.id);
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
      { mode: "earlier", from: store.getSnapshot().snapshot!.nextBefore! },
      read,
    ),
  ).toBe("installed");
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
      { mode: "around" },
      jump,
    ),
  ).toBe("installed");
  store.endRead(jump);
  expect(store.getSnapshot().historyIds).toEqual(all.slice(0, 3).map(({ id }) => id));
});

test("a repair replaces the scope: no stale history, no older page, no omitted queue entry", () => {
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
  const waiting = (id: string) =>
    ({
      message: {
        id,
        revision: 0,
        author: { kind: "human", principalId: "me", displayName: "Me" },
        createdAt,
        preview: "Next",
        truncated: false,
      },
      input: { messageId: id, state: "pending", queueRank: "1" },
      ask: null,
      canEdit: true,
      canCancel: true,
      canMove: true,
      canSteer: true,
      lease: null,
    }) as never;
  const first = createId("message");
  const second = createId("message");
  const cut = (items: typeof all, throughSequence: string, entries: string[], inputs: string[]) =>
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
        queue: { revision: throughSequence, runs: [], paused: false, steerRunId: null, inputs },
        inputQueue: entries.map(waiting),
      } as never,
    });
  cut(all.slice(30, 80), "1", [first, second], [first, second as string]);
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
    { mode: "earlier", from: store.getSnapshot().snapshot!.nextBefore! },
  );
  const late = store.beginRead();
  store.liveItem({ ...all[79]!, revision: "1" }, "provisional", false);
  // The Host could not replay: the latest window, without a card it had hidden meanwhile, and
  // a queue whose second entry did not fit.
  expect(
    cut(
      [...all.slice(31, 79), { ...all[79]!, id: "provisional" as never }],
      "9",
      [first],
      [first, second],
    ),
  ).toBe(true);
  const state = store.getSnapshot();
  expect(state.synchronized).toBe(true);
  expect(state.historyIds[0]).toBe(all[31]!.id);
  expect(state.items.has(all[0]!.id)).toBe(false);
  expect(state.liveItems.has("provisional")).toBe(false);
  expect([...state.queueEntries.keys()]).toEqual([first]);
  expect(state.repairs).toBe(1);
  // A page read begun before the repair cannot bring old rows back.
  expect(
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
      { mode: "earlier", from: store.getSnapshot().snapshot!.nextBefore! },
      late,
    ),
  ).toBe("stale");
});

test("a held provisional card takes a new face and its place; a window of history shows none", () => {
  const store = new ThreadTranscriptStore();
  store.begin(1, false);
  const base = { subscriptionId, generation: 1, scope };
  const second = {
    ...item,
    id: createId("message"),
    messageId: createId("message"),
    position: "3",
  };
  const snapshot = (anchorItemId: string | null, nextAfter: object | null) => ({
    thread: detailThread(thread),
    items: [item, second],
    pendingRequests: [],
    activeItems: [],
    nextBefore: null,
    nextAfter,
    anchorItemId,
  });
  store.apply({
    ...base,
    type: "host.snapshot",
    throughSequence: "1",
    snapshot: snapshot(null, null),
  } as never);
  store.apply({ ...base, type: "host.synchronized", throughSequence: "1" });
  const order = () => {
    const state = store.getSnapshot();
    return displayedItemIds(state).map((id) =>
      id === "live" ? "live" : state.items.get(id)!.position,
    );
  };
  // A reply under way, first placed after both rows.
  const face = { ...item, id: "live" as never, position: "4" };
  store.liveItem(face, "live", false);
  expect(order()).toEqual(["1", "3", "live"]);
  // The stream was reidentified: the same card now stands between them.
  store.liveItem({ ...face, position: "2" }, "live", false);
  expect(order()).toEqual(["1", "live", "3"]);
  // The reader is held in a window of history: the card is not drawn into it.
  store.apply({
    ...base,
    type: "host.snapshot",
    throughSequence: "1",
    snapshot: snapshot(item.id, { ...cursorOf(second) }),
  } as never);
  expect(store.getSnapshot().newest).toBe(false);
  expect(displayedItemIds(store.getSnapshot())).not.toContain("live");
});

function cursorOf(row: { id: string; position: string }) {
  return {
    deploymentId: createId("deployment"),
    epoch: "00000000-0000-4000-8000-000000000001",
    viewerId: createId("user"),
    threadId: scope.threadId,
    nodeId: null,
    beforeId: row.id,
    beforePosition: row.position,
  };
}
