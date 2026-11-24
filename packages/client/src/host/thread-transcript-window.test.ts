import { createId } from "@opensteer/core";
import type { TranscriptItem } from "@opensteer/protocol/transcript";
import { expect, test } from "vitest";
import {
  displayedItemIds,
  ThreadTranscriptStore,
  transcriptWindowItems,
} from "./thread-transcript-store.js";
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

/** One row per position, as the folded steps of one long turn read on screen. */
const all: TranscriptItem[] = Array.from({ length: 900 }, (_, index) => {
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
    isTurnStart: false,
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
  nextAfter: end < all.length ? cursor(all[end - 1]!) : null,
});

/**
 * A synchronized store holding `all[from, end)`, with the cursors a Host cut would give it. A
 * `latest` cut reaches the foot: the rows after it have yet to happen, and arrive live.
 */
function windowOf(from: number, end: number, latest = false) {
  const store = new ThreadTranscriptStore();
  store.begin(1, false);
  const cut = page(from, end);
  store.apply({
    ...address,
    type: "host.snapshot",
    throughSequence: "1",
    snapshot: {
      thread: detailThread(thread),
      items: cut.items,
      activeItems: [],
      pendingRequests: [],
      nextBefore: cut.nextBefore,
      nextAfter: latest ? null : cut.nextAfter,
    },
  });
  store.apply({ ...address, type: "host.synchronized", throughSequence: "1" });
  return store;
}

const held = (store: ThreadTranscriptStore) => store.getSnapshot().historyIds;
const range = (from: number, end: number) => all.slice(from, end).map(({ id }) => id);
const newer = (store: ThreadTranscriptStore, from: number, end: number) =>
  store.installPage(page(from, end), 1, {
    mode: "newer",
    from: store.getSnapshot().snapshot!.nextAfter!,
  });
const earlier = (store: ThreadTranscriptStore, from: number, end: number) =>
  store.installPage(page(from, end), 1, {
    mode: "earlier",
    from: store.getSnapshot().snapshot!.nextBefore!,
  });

test("a newer page the reader asked for is never undone by the earlier page that follows it", () => {
  // The reader reads one long turn that starts at 300 and runs past the window's end: folded, it is
  // one row on screen, so the window's 250 items are barely a screen and its top is always near.
  const store = windowOf(200, 450);
  store.setFollowing(() => false);
  // Load newer, then an earlier page, then Load newer on to the latest: what the reader loads is
  // theirs, so neither direction undoes the other, and every tap moves on.
  expect(newer(store, 450, 550)).toBe("installed");
  expect(earlier(store, 100, 200)).toBe("installed");
  expect(held(store)).toEqual(range(100, 550));
  for (let from = 550; from < 900; from += 100)
    expect(
      store.installPage({ ...page(from, Math.min(from + 100, 900)) }, 1, {
        mode: "newer",
        from: store.getSnapshot().snapshot!.nextAfter!,
      }),
    ).toBe("installed");
  expect(held(store)).toEqual(range(100, 900));
  expect(store.getSnapshot().newest).toBe(true);
  // Following the latest again, the next live row bounds the window above the reader.
  store.setFollowing(() => true);
  const next = { ...all[899]!, id: createId("message"), position: "901" } as TranscriptItem;
  append(store, [next]);
  expect(held(store)).toHaveLength(transcriptWindowItems);
  expect(held(store).at(-1)).toBe(next.id);
});

test("a follower's next live row bounds a window the reader paged out", () => {
  const store = windowOf(640, 890, true);
  for (let from = 540; from >= 140; from -= 100)
    expect(earlier(store, from, from + 100)).toBe("installed");
  expect(held(store)).toEqual(range(140, 890));
  store.setFollowing(() => true);
  const next = { ...all[889]!, id: createId("message"), position: "891" } as TranscriptItem;
  append(store, [next]);
  expect(held(store)).toHaveLength(transcriptWindowItems);
  expect(held(store).at(-1)).toBe(next.id);
  expect(store.getSnapshot().snapshot?.nextBefore?.beforeId).toBe(held(store)[0]);
});

test("live rows never take back what a reader paged in: one folded turn of 650 keeps its reply", () => {
  // The reader paged back four times through one long turn; its reply is the row's last item.
  const store = windowOf(650, 900, true);
  for (let from = 550; from >= 250; from -= 100)
    expect(earlier(store, from, from + 100)).toBe("installed");
  expect(held(store)).toEqual(range(250, 900));
  // A removal alone bounds nothing, even for a follower: the window did not grow.
  store.setFollowing(() => true);
  const removedAt = store.getSnapshot().through!;
  const after = String(Number(removedAt) + 1);
  store.apply({
    ...address,
    type: "host.changes",
    fromSequence: removedAt,
    throughSequence: after,
    changes: [
      {
        operation: "remove" as const,
        entityKind: "item" as const,
        sequence: after,
        ordinal: 0,
        entityId: all[400]!.id,
      },
    ],
  });
  const loaded = range(250, 900).filter((id) => id !== all[400]!.id);
  expect(held(store)).toEqual(loaded);
  // An unrelated row arrives live while they read: it waits a page away; everything loaded stays.
  store.setFollowing(() => false);
  const next = { ...all[899]!, id: createId("message"), position: "901" } as TranscriptItem;
  append(store, [next]);
  expect(held(store)).toEqual(loaded);
  expect(store.getSnapshot().newest).toBe(false);
});

test("a reader elsewhere stays bounded however many streamed blocks finish past what they hold", () => {
  const store = windowOf(640, 890, true);
  store.setFollowing(() => false);
  // Each block streams in as a provisional card, then finishes as a durable row.
  for (let at = 890; at < 900; at += 1) {
    store.liveItem({ ...all[at]!, revision: "0" }, all[at]!.id, false);
    append(store, [all[at]!]);
  }
  expect(held(store)).toEqual(range(640, 890));
  expect(store.getSnapshot().newest).toBe(false);
  expect(store.getSnapshot().snapshot?.nextAfter?.beforeId).toBe(all[889]!.id);
});

test("a page that no longer continues the window's edge is dropped, never spliced in", () => {
  const store = windowOf(200, 450);
  const stale = store.getSnapshot().snapshot!.nextAfter!;
  expect(newer(store, 450, 550)).toBe("installed");
  // A second read from the edge the first page already moved on from.
  expect(store.installPage(page(450, 550), 1, { mode: "newer", from: stale })).toBe("moved");
  expect(store.installPage(page(100, 200), 1, { mode: "earlier", from: cursor(all[300]!) })).toBe(
    "moved",
  );
  expect(held(store)).toEqual(range(200, 550));
});

test("live rows at the foot give way above a reader following the latest", () => {
  const store = windowOf(640, 890, true);
  store.setFollowing(() => true);
  live(store, 890, 900);
  expect(held(store)).toEqual(range(650, 900));
  expect(store.getSnapshot().newest).toBe(true);
  expect(store.getSnapshot().snapshot?.nextBefore?.beforeId).toBe(all[650]!.id);
});

test("live rows let go of the latest, not of a reader holding the window's top", () => {
  const store = windowOf(640, 890, true);
  store.setFollowing(() => false);
  live(store, 890, 900);
  // The rows on screen stay; the window stops at the bound and the latest is a page away.
  expect(held(store)).toEqual(range(640, 890));
  expect(store.getSnapshot().newest).toBe(false);
  expect(store.getSnapshot().snapshot?.nextAfter?.beforeId).toBe(all[889]!.id);
  expect(store.getSnapshot().snapshot?.nextBefore?.beforeId).toBe(all[640]!.id);
  // Further live rows land past the window's foot: they wait for the reader's next page.
  live(store, 890, 900);
  expect(held(store)).toEqual(range(640, 890));
});

test("a reader holding a long turn at work keeps what they see; the latest is a page away", () => {
  // The reader stopped following, and the row on screen is a turn still at work: every live row
  // lands in it. What they see stays put, and the window lets go of the latest instead.
  const store = windowOf(640, 890, true);
  store.setFollowing(() => false);
  for (let from = 890; from < 900; from += 2) live(store, from, from + 2);
  expect(held(store)).toEqual(range(640, 890));
  expect(store.getSnapshot().newest).toBe(false);
  expect(store.getSnapshot().snapshot?.nextAfter?.beforeId).toBe(all[889]!.id);
});

test("a follower stays live and bounded however long the turn at work runs", () => {
  const store = windowOf(640, 890, true);
  store.setFollowing(() => true);
  for (let from = 890; from < 900; from += 2) live(store, from, from + 2);
  expect(held(store)).toEqual(range(650, 900));
  expect(store.getSnapshot().newest).toBe(true);
});

test("a jump that lands at the foot follows live rows, so paging back from it leaves no gap", () => {
  const store = windowOf(0, 250);
  // The jump's page reaches the latest: nothing lies past its foot.
  expect(store.installPage({ ...page(800, 890), nextAfter: null }, 1, { mode: "around" })).toBe(
    "installed",
  );
  expect(store.getSnapshot().newest).toBe(true);
  live(store, 890, 891);
  expect(held(store).at(-1)).toBe(all[890]!.id);
  expect(earlier(store, 700, 800)).toBe("installed");
  expect(held(store)).toEqual(range(700, 891));
  expect(store.checkpoint()?.items.at(-1)?.id).toBe(all[890]!.id);
});

test("a live commit that removes the row the screen starts at still keeps the rest of the screen", () => {
  const store = windowOf(640, 890, true);
  store.setFollowing(() => false);
  const through = store.getSnapshot().through!;
  const next = String(Number(through) + 1);
  expect(
    store.apply({
      ...address,
      type: "host.changes",
      fromSequence: through,
      throughSequence: next,
      changes: [
        {
          operation: "remove" as const,
          entityKind: "item" as const,
          sequence: next,
          ordinal: 0,
          entityId: all[640]!.id,
        },
        ...all.slice(890, 900).map((value, index) => ({
          operation: "upsert" as const,
          entityKind: "item" as const,
          sequence: next,
          ordinal: index + 1,
          entityId: value.id,
          value: { ...value, revision: next },
        })),
      ],
    }),
  ).toBe(true);
  // Everything the reader was shown stays but the row removed; what just arrived waits a page away.
  expect(held(store)).toEqual(range(641, 890));
  expect(store.getSnapshot().newest).toBe(false);
  // A removal alone bounds nothing: the window did not grow.
  const removedAt = store.getSnapshot().through!;
  const after = String(Number(removedAt) + 1);
  store.apply({
    ...address,
    type: "host.changes",
    fromSequence: removedAt,
    throughSequence: after,
    changes: [
      {
        operation: "remove" as const,
        entityKind: "item" as const,
        sequence: after,
        ordinal: 0,
        entityId: all[700]!.id,
      },
    ],
  });
  expect(held(store)).toEqual(range(641, 890).filter((id) => id !== all[700]!.id));
  expect(held(store)).toHaveLength(248);
});

test("rows that arrived while the final page was read wait a page away, never a burst into the window", () => {
  const store = windowOf(450, 700);
  const read = store.beginRead();
  // The final page is read while 100 rows land live past it (the window drops them for now).
  live(store, 800, 900);
  expect(
    store.installPage(
      { ...page(700, 800), nextAfter: null },
      1,
      { mode: "newer", from: store.getSnapshot().snapshot!.nextAfter! },
      read,
    ),
  ).toBe("installed");
  store.endRead(read);
  // The page the reader asked for lands whole; the rows that arrived past it are a tap away.
  expect(held(store)).toEqual(range(450, 800));
  expect(store.getSnapshot().newest).toBe(false);
  expect(store.getSnapshot().snapshot?.nextAfter?.beforeId).toBe(all[799]!.id);
});

test("a page whose last row was removed while it was read leaves the window following live", () => {
  const store = windowOf(400, 650);
  const read = store.beginRead();
  const through = store.getSnapshot().through!;
  const next = String(Number(through) + 1);
  // The final page's last row is removed while the page is read.
  expect(
    store.apply({
      ...address,
      type: "host.changes",
      fromSequence: through,
      throughSequence: next,
      changes: [
        {
          operation: "remove" as const,
          entityKind: "item" as const,
          sequence: next,
          ordinal: 0,
          entityId: all[699]!.id,
        },
      ],
    }),
  ).toBe(true);
  expect(
    store.installPage(
      { ...page(650, 700), nextAfter: null },
      1,
      { mode: "newer", from: store.getSnapshot().snapshot!.nextAfter! },
      read,
    ),
  ).toBe("installed");
  store.endRead(read);
  expect(held(store)).toEqual(range(400, 699));
  expect(store.getSnapshot().newest).toBe(true);
  expect(store.getSnapshot().snapshot?.nextAfter ?? null).toBeNull();
  // The next live row still lands.
  live(store, 700, 701);
  expect(held(store).at(-1)).toBe(all[700]!.id);
});

/** A latest cut of `rows[from, end)` that reaches the foot, synchronized. */
function latestOf(rows: readonly TranscriptItem[], from: number, end: number) {
  const store = new ThreadTranscriptStore();
  store.begin(1, false);
  store.apply({
    ...address,
    type: "host.snapshot",
    throughSequence: "1",
    snapshot: {
      thread: detailThread(thread),
      items: rows.slice(from, end),
      activeItems: [],
      pendingRequests: [],
      nextBefore: cursor(rows[from]!),
      nextAfter: null,
    },
  });
  store.apply({ ...address, type: "host.synchronized", throughSequence: "1" });
  return store;
}

test("the rows on screen keep their Run's card, however far above them the Run began", () => {
  // A Run that began at 200 runs on live: the window gives way above the follower, past the card.
  const run = {
    ...all[200]!,
    id: `run:${runId}`,
    kind: "run" as const,
    view: { status: "running" },
  } as TranscriptItem;
  const rows = all.map((row, index) => (index === 200 ? run : row));
  const store = latestOf(rows, 150, 400);
  store.setFollowing(() => true);
  live(store, 400, 500);
  expect(held(store)).toEqual(range(250, 500));
  expect(held(store)).not.toContain(run.id);
  expect(store.getSnapshot().items.get(run.id)).toBe(run);
  const shown = displayedItemIds(store.getSnapshot());
  expect(shown.indexOf(run.id)).toBe(shown.indexOf(held(store)[0]!) - 1);
  // The held card still takes the Run's updates.
  append(store, [{ ...run, view: { status: "completed" } }]);
  expect(store.getSnapshot().items.get(run.id)?.view.status).toBe("completed");
});

test("a Run's card above the window is drawn with the Run's own steps, not before a message sent into it", () => {
  const run = {
    ...all[100]!,
    id: `run:${runId}`,
    kind: "run" as const,
    view: { status: "running" },
  } as TranscriptItem;
  const steer = {
    ...all[300]!,
    messageKind: "input" as const,
    isTurnStart: true,
  } as TranscriptItem;
  const rows = all.map((row, index) => (index === 100 ? run : index === 300 ? steer : row));
  const store = latestOf(rows, 50, 300);
  store.setFollowing(() => true);
  // The Run goes on past a steer; the window gives way above the follower to start at the steer.
  append(store, rows.slice(300, 550));
  expect(held(store)[0]).toBe(steer.id);
  const shown = displayedItemIds(store.getSnapshot());
  expect(shown.slice(0, 3)).toEqual([steer.id, run.id, rows[301]!.id]);
});

test("a follower watching a provisional card keeps it as rows arrive after it", () => {
  const store = windowOf(640, 890, true);
  const card = { ...all[890]!, id: "live-card", revision: "0" };
  store.liveItem(card, card.id, false);
  store.setFollowing(() => true);
  live(store, 891, 900);
  expect(store.getSnapshot().newest).toBe(true);
  expect(displayedItemIds(store.getSnapshot())).toContain(card.id);
  expect(held(store).at(-1)).toBe(all[899]!.id);
});

test("a Run's held card goes once the window holds none of the Run's rows", () => {
  const other = createId("run");
  const run = {
    ...all[100]!,
    id: `run:${runId}`,
    kind: "run" as const,
    view: { status: "completed" },
  } as TranscriptItem;
  const rows = all.map((row, index) =>
    index === 100 ? run : index >= 400 ? { ...row, runId: other } : row,
  ) as TranscriptItem[];
  const store = latestOf(rows, 100, 350);
  store.setFollowing(() => true);
  append(store, rows.slice(350, 450));
  // Rows of the Run remain below its card's place: the card is held.
  expect(held(store)).not.toContain(run.id);
  expect(store.getSnapshot().items.has(run.id)).toBe(true);
  append(store, rows.slice(450, 650));
  // None of the Run's rows remain: nothing reads it, and it goes.
  expect(held(store).some((id) => store.getSnapshot().items.get(id)?.runId === runId)).toBe(false);
  expect(store.getSnapshot().items.has(run.id)).toBe(false);
});

test("a screen showing only a provisional card past every durable row keeps it through an earlier page", () => {
  const store = windowOf(640, 890, true);
  const card = { ...all[890]!, id: "live-card", revision: "0" };
  store.liveItem(card, card.id, false);
  store.setFollowing(() => false);
  expect(earlier(store, 540, 640)).toBe("installed");
  expect(store.getSnapshot().newest).toBe(true);
  expect(displayedItemIds(store.getSnapshot())).toContain(card.id);
  expect(held(store).at(-1)).toBe(all[889]!.id);
});

test("a repair's cut brings the Run cards its rows read from, so a reply after a steer survives it", () => {
  const run = {
    ...all[100]!,
    id: `run:${runId}`,
    kind: "run" as const,
    view: { status: "completed" },
  } as TranscriptItem;
  // The steer was edited since the window read it: the cut carries its newer revision.
  const steer = {
    ...all[300]!,
    revision: "2",
    messageKind: "input" as const,
    isTurnStart: true,
  } as TranscriptItem;
  const store = windowOf(200, 450);
  const through = store.getSnapshot().through!;
  // The Host repairs the scope around the reply: the cut starts at the steer, far below the card.
  store.apply({
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
      nextAfter: cursor(all[329]!),
    },
  });
  expect(store.getSnapshot().repairs).toBe(1);
  expect(store.getSnapshot().items.get(run.id)).toEqual(run);
  expect(held(store)).not.toContain(run.id);
  expect(displayedItemIds(store.getSnapshot()).slice(0, 3)).toEqual([
    steer.id,
    run.id,
    all[301]!.id,
  ]);
});

test("a checkpoint carries the Run cards its saved rows read from, so a resume keeps the reply", () => {
  const run = {
    ...all[100]!,
    id: `run:${runId}`,
    kind: "run" as const,
    view: { status: "completed" },
  } as TranscriptItem;
  const store = windowOf(640, 890, true);
  const through = store.getSnapshot().through!;
  // The cut came without it; reading back, an earlier page brought the Run card the rows read
  // from. The reader's screen is at the foot, which stays live.
  store.setFollowing(() => false);
  expect(earlier(store, 540, 640)).toBe("installed");
  expect(
    store.installPage({ ...page(440, 540), runs: [run] }, 1, {
      mode: "earlier",
      from: store.getSnapshot().snapshot!.nextBefore!,
    }),
  ).toBe("installed");
  const saved = store.checkpoint();
  expect(saved?.runs?.map(({ id }) => id)).toEqual([run.id]);
  // Resumed from it, the card is there for the rows again.
  const resumed = new ThreadTranscriptStore();
  resumed.begin(1, false);
  resumed.apply({ ...address, type: "host.snapshot", throughSequence: through, snapshot: saved! });
  expect(resumed.getSnapshot().items.get(run.id)).toEqual(run);
});

test("a reply committing past a window short of the latest waits there, never across the gap", () => {
  // The reader opened an older stretch of a Run still at work; its reply streams far below.
  const store = windowOf(200, 400);
  const reply = { ...all[800]!, revision: "0" };
  store.liveItem(reply, reply.id, false);
  expect(displayedItemIds(store.getSnapshot())).not.toContain(reply.id);
  append(store, [all[800]!]);
  expect(held(store)).toEqual(range(200, 400));
  expect(displayedItemIds(store.getSnapshot())).not.toContain(reply.id);
  expect(store.getSnapshot().snapshot?.nextAfter?.beforeId).toBe(all[399]!.id);
});

function live(store: ThreadTranscriptStore, from: number, end: number) {
  append(store, all.slice(from, end));
}

/** Lands `rows` live, in one commit. */
function append(store: ThreadTranscriptStore, rows: readonly TranscriptItem[]) {
  const through = store.getSnapshot().through!;
  expect(
    store.apply({
      ...address,
      type: "host.changes",
      fromSequence: through,
      throughSequence: String(Number(through) + 1),
      changes: rows.map((value, ordinal) => ({
        operation: "upsert" as const,
        entityKind: "item" as const,
        sequence: String(Number(through) + 1),
        ordinal,
        entityId: value.id,
        value: { ...value, revision: String(Number(through) + 1) },
      })),
    }),
  ).toBe(true);
}
