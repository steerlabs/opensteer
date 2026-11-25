import { createId } from "@opensteer/core";
import type { TranscriptItem } from "@opensteer/protocol/transcript";
import { expect, test } from "vitest";
import { displayedItemIds, ThreadTranscriptStore } from "./thread-transcript-store.js";
import { detailThread } from "../test-support/scoped-transcript-fixture.js";

const scope = { kind: "thread" as const, threadId: createId("thread") };
const address = { subscriptionId: "detail:0" as const, generation: 1, scope };
const createdAt = "2026-11-23T22:18:21.000Z";
const thread = {
  id: scope.threadId,
  title: "Fixture",
  revision: "1",
  status: "idle" as const,
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
const authority = {
  deploymentId: createId("deployment"),
  viewerId: createId("user"),
  epoch: crypto.randomUUID(),
};
const runId = createId("run");
const attemptId = createId("runAttempt");

const all: TranscriptItem[] = Array.from({ length: 400 }, (_, index) => {
  const id = createId("message");
  return {
    id,
    messageId: id,
    kind: "message" as const,
    revision: "1",
    position: String(index + 1),
    runId,
    attemptId,
    nodeId: null,
    isTurnStart: index % 20 === 0,
    createdAt,
    view: { preview: `Step ${index}` },
  };
});
type Item = TranscriptItem;

const cursor = (boundary: Item) => ({
  ...authority,
  threadId: scope.threadId,
  nodeId: null,
  beforeId: boundary.id,
  beforePosition: boundary.position,
});

const page = (from: number, end: number) => ({
  kind: "page" as const,
  threadId: scope.threadId,
  nodeId: null,
  revision: "1",
  items: all.slice(from, end),
  hasMore: from > 0,
  nextBefore: from > 0 ? cursor(all[from]!) : null,
  nextAfter: null,
});

function tailWindow(from: number, end: number, rows: readonly TranscriptItem[] = all) {
  const store = new ThreadTranscriptStore();
  store.begin(1, false);
  const items = rows.slice(from, end);
  store.apply(
    {
      ...address,
      type: "host.snapshot",
      throughSequence: "1",
      snapshot: {
        thread: detailThread(thread),
        items,
        activeItems: [],
        pendingRequests: [],
        nextBefore: from > 0 ? cursor(items[0]!) : null,
        nextAfter: null,
      },
    },
    authority,
  );
  store.apply({ ...address, type: "host.synchronized", throughSequence: "1" }, authority);
  return store;
}

const held = (store: ThreadTranscriptStore) => store.getSnapshot().historyIds;
const range = (from: number, end: number) => all.slice(from, end).map(({ id }) => id);
const earlier = (store: ThreadTranscriptStore, from: number, end: number) =>
  store.installPage(page(from, end), 1, {
    mode: "earlier",
    from: store.getSnapshot().snapshot!.nextBefore!,
  });

test("live rows always append to the tail and never detach, even past hundreds of items", () => {
  const store = tailWindow(350, 380);
  // Paging earlier extends backward without dropping the live tail.
  expect(earlier(store, 250, 350)).toBe("installed");
  expect(earlier(store, 150, 250)).toBe("installed");
  expect(earlier(store, 50, 150)).toBe("installed");
  expect(held(store)).toEqual(range(50, 380));

  // New live rows (including newly sent messages) land directly at the tail without detaching.
  append(store, all.slice(380, 400));
  expect(held(store)).toEqual(range(50, 400));
  expect(store.getSnapshot().snapshot?.nextAfter).toBeNull();

  // Provisional live cards remain visible at the tail across earlier pages.
  const card = { ...all[399]!, id: "live-card", position: "401", revision: "0" };
  store.liveItem(card, card.id, false);
  expect(earlier(store, 0, 50)).toBe("installed");
  expect(displayedItemIds(store.getSnapshot())).toContain(card.id);
  expect(store.getSnapshot().snapshot?.nextBefore).toBeNull();
});

test("expanding history disables disk checkpointing while preserving cursor resume", () => {
  const store = tailWindow(350, 400);
  expect(store.getSnapshot().expanded).toBe(false);
  expect(store.canCheckpoint()).toBe(true);
  expect(store.canResume()).toBe(true);

  expect(earlier(store, 250, 350)).toBe("installed");
  expect(store.getSnapshot().expanded).toBe(true);
  expect(store.canCheckpoint()).toBe(false);
  expect(store.checkpoint()).toBeUndefined();
  expect(store.canResume()).toBe(true);
});

test("a page that no longer continues the window's top edge is dropped, never spliced in", () => {
  const store = tailWindow(200, 300);
  const stale = store.getSnapshot().snapshot!.nextBefore!;
  expect(earlier(store, 100, 200)).toBe("installed");
  expect(store.installPage(page(100, 200), 1, { mode: "earlier", from: stale })).toBe("moved");
  expect(held(store)).toEqual(range(100, 300));
});

test("deferred work pages splice in place, clear deferredWork when finished, and survive live updates", () => {
  const toolAnchor: TranscriptItem = {
    id: "tool:1",
    kind: "tool",
    revision: "1",
    position: "10",
    runId,
    attemptId,
    nodeId: null,
    isTurnStart: false,
    createdAt,
    toolCallId: "call_1",
    view: { status: "completed", title: "Step 1" },
    deferredWork: {
      itemCount: 3,
      startedAt: createdAt,
      endedAt: "2026-11-23T23:28:21.000Z",
      onlyThinking: false,
    },
  };
  const reply: TranscriptItem = {
    ...all[0]!,
    position: "20",
  };
  const store = tailWindow(0, 2, [toolAnchor, reply]);

  // A live revision bump on the anchor preserves its deferredWork until hydrated.
  append(store, [{ ...toolAnchor, deferredWork: undefined, revision: "2" } as TranscriptItem]);
  const updatedAnchor = store.getSnapshot().items.get("tool:1");
  expect(updatedAnchor?.kind === "tool" && updatedAnchor.deferredWork?.itemCount).toBe(3);

  const hidden: TranscriptItem[] = [11, 12, 13].map((pos) => ({
    id: `tool:${pos}`,
    kind: "tool" as const,
    revision: "1",
    position: String(pos),
    runId,
    attemptId,
    nodeId: null,
    isTurnStart: false,
    createdAt,
    toolCallId: `call_${pos}`,
    view: { status: "completed", title: `Step ${pos}` },
  }));

  // First partial page keeps deferredWork on the anchor.
  expect(
    store.installDeferredWorkPage(
      {
        kind: "page",
        threadId: scope.threadId,
        nodeId: null,
        revision: "2",
        items: hidden.slice(1),
        hasMore: true,
        nextBefore: cursor(hidden[1]!),
        nextAfter: null,
      },
      1,
      "tool:1",
    ),
  ).toBe("installed");
  expect(
    (store.getSnapshot().items.get("tool:1") as Extract<TranscriptItem, { kind: "tool" }>)
      .deferredWork,
  ).toBeDefined();

  // Final page clears deferredWork and orders all items chronologically.
  expect(
    store.installDeferredWorkPage(
      {
        kind: "page",
        threadId: scope.threadId,
        nodeId: null,
        revision: "2",
        items: hidden.slice(0, 1),
        hasMore: false,
        nextBefore: null,
        nextAfter: null,
      },
      1,
      "tool:1",
    ),
  ).toBe("installed");
  expect(
    (store.getSnapshot().items.get("tool:1") as Extract<TranscriptItem, { kind: "tool" }>)
      .deferredWork,
  ).toBeUndefined();
  expect(held(store)).toEqual(["tool:1", "tool:11", "tool:12", "tool:13", reply.id]);
});

test("a repair's cut brings the Run cards its rows read from, drawn beside the Run's steps", () => {
  const run = {
    ...all[100]!,
    id: `run:${runId}`,
    kind: "run" as const,
    view: { status: "completed" },
  } as TranscriptItem;
  const steer = {
    ...all[300]!,
    revision: "2",
    messageKind: "input" as const,
    isTurnStart: true,
  } as TranscriptItem;
  const store = tailWindow(200, 350);
  const through = store.getSnapshot().through!;
  store.apply(
    {
      ...address,
      type: "host.snapshot",
      throughSequence: through,
      snapshot: {
        thread: detailThread(thread),
        items: [steer, ...all.slice(301, 330)],
        runs: [run],
        activeItems: [],
        pendingRequests: [],
        nextBefore: cursor(steer),
        nextAfter: null,
      },
    },
    authority,
  );
  expect(store.getSnapshot().repairs).toBe(1);
  expect(store.getSnapshot().items.get(run.id)).toEqual(run);
  expect(held(store)).not.toContain(run.id);
  expect(displayedItemIds(store.getSnapshot()).slice(0, 3)).toEqual([
    steer.id,
    run.id,
    all[301]!.id,
  ]);
});

test("a tail checkpoint carries the Run cards its saved rows read from", () => {
  const run = {
    ...all[100]!,
    id: `run:${runId}`,
    kind: "run" as const,
    view: { status: "completed" },
  } as TranscriptItem;
  const store = new ThreadTranscriptStore();
  store.begin(1, false);
  store.apply(
    {
      ...address,
      type: "host.snapshot",
      throughSequence: "1",
      snapshot: {
        thread: detailThread(thread),
        items: all.slice(350, 400),
        runs: [run],
        activeItems: [],
        pendingRequests: [],
        nextBefore: cursor(all[350]!),
        nextAfter: null,
      },
    },
    authority,
  );
  store.apply({ ...address, type: "host.synchronized", throughSequence: "1" }, authority);
  const saved = store.checkpoint();
  expect(saved?.runs?.map(({ id }) => id)).toEqual([run.id]);
  expect(saved?.nextAfter).toBeNull();
  const resumed = new ThreadTranscriptStore();
  resumed.begin(1, false);
  resumed.apply({ ...address, type: "host.snapshot", throughSequence: "1", snapshot: saved! });
  expect(resumed.getSnapshot().items.get(run.id)).toEqual(run);
});

/** Lands `rows` live, in one commit. */
function append(store: ThreadTranscriptStore, rows: readonly TranscriptItem[]) {
  const through = store.getSnapshot().through!;
  const nextSeq = String(Number(through) + 1);
  expect(
    store.apply({
      ...address,
      type: "host.changes",
      fromSequence: through,
      throughSequence: nextSeq,
      changes: rows.map((value, ordinal) => ({
        operation: "upsert" as const,
        entityKind: "item" as const,
        sequence: nextSeq,
        ordinal,
        entityId: value.id,
        value: { ...value, revision: nextSeq },
      })),
    }),
  ).toBe(true);
}
