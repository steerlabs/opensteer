import { createId } from "@opensteer/core";
import { afterEach, expect, test, vi } from "vitest";
import {
  personalAuthorityChangedReason,
  type ScopedClientMessage,
} from "@opensteer/protocol/personal-sync";
import {
  personalResourceKinds,
  PersonalResourceRevisionsSchema,
} from "@opensteer/protocol/resources";
import type { TranscriptItem, TranscriptOrderCursor } from "@opensteer/protocol/transcript";
import { MockPersonalSocket } from "../mock/mock-personal-host.js";
import { HttpHostClient } from "./host-session-client.js";
import {
  createPersonalStreamCache,
  personalCacheFormat,
  type PersonalStreamCache,
  type PersonalStreamCheckpoint,
} from "./personal-stream-cache.js";
import { ScopedPersonalStream } from "./scoped-personal-stream.js";
import { ScopedThreadReader, TranscriptBodies } from "./scoped-thread-reader.js";

const deploymentId = createId("deployment");
const viewerId = createId("user");
const session = {
  sessionId: createId("authSession"),
  sessionSurface: "canonical" as const,
  user: {
    id: viewerId,
    displayName: "Owner",
    email: "owner@example.test",
    image: null,
    emailVerified: true,
    disabledAt: null,
  },
  can: { createTasks: true, useVoice: true, manageComputers: true, managePrivateResources: true },
};
const epoch = crypto.randomUUID();
const threadId = createId("thread");
const runId = createId("run");
const messageId = createId("message");
const requestId = createId("request");
const nodeId = createId("executionNode");
const time = "2026-11-17T18:00:00.000Z";
const threadScope = { kind: "thread", threadId } as const;
const shellScope = { kind: "shell" } as const;
const task = {
  id: threadId,
  title: "Fixture",
  revision: "1",
  status: "running",
  purpose: "task",
  askedAt: time,
  doneAt: null,
  pendingRequestCount: 0,
  lastReplyPreview: null,
  failurePreview: null,
  latestRunCompletedAt: null,
} as const;
const item = {
  id: messageId,
  messageId,
  kind: "message",
  revision: "1",
  position: "1",
  runId,
  attemptId: null,
  nodeId: null,
  isTurnStart: false,
  createdAt: time,
  view: { preview: "A" },
} satisfies TranscriptItem;
const revisions = (revision: string) =>
  PersonalResourceRevisionsSchema.parse(
    Object.fromEntries(personalResourceKinds.map((kind) => [kind, revision])),
  );
const counts = { pendingRequestCount: 0, needsYouCount: 0, unreadTaskCount: 0 };
const cursor: TranscriptOrderCursor = {
  deploymentId,
  viewerId,
  epoch,
  threadId,
  nodeId: null,
  orderRevision: "1",
  beforeId: item.id,
  beforePosition: item.position,
};

function fixture(cache?: PersonalStreamCache) {
  const stream = new ScopedPersonalStream(cache);
  const sent: ScopedClientMessage[] = [];
  const detail = stream.detail(threadScope);
  stream.select(threadScope);
  stream.attach((frame) => sent.push(frame));
  const attach = sent[0] as Extract<ScopedClientMessage, { type: "client.attach" }>;
  const shell = {
    scope: shellScope,
    subscriptionId: "shell" as const,
    generation: attach.generation,
  };
  const { cursor: _cursor, ...address } = attach.selected!;
  const shellSnapshot = (throughSequence = "1", replacementEpoch = epoch) => ({
    ...shell,
    type: "host.snapshot" as const,
    throughSequence,
    snapshot: {
      deploymentId,
      viewerId,
      epoch: replacementEpoch,
      tasks: [task],
      visits: [],
      attention: [],
      counts,
      resourceRevisions: revisions("0"),
    },
  });
  const detailSnapshot = (items: TranscriptItem[] = [item]) => ({
    ...address,
    type: "host.snapshot" as const,
    throughSequence: "1",
    snapshot: {
      thread: task,
      items,
      activeItems: [],
      orderRevision: "1",
      inputQueueRevision: "1",
      pendingRequests: [],
      nextBefore: cursor,
    },
  });
  function syncShell() {
    expect(stream.receive(shellSnapshot())).toBe(true);
    expect(stream.receive({ ...shell, type: "host.synchronized", throughSequence: "1" })).toBe(
      true,
    );
  }
  function syncDetail() {
    expect(stream.receive(detailSnapshot())).toBe(true);
    expect(stream.receive({ ...address, type: "host.synchronized", throughSequence: "1" })).toBe(
      true,
    );
  }
  return {
    stream,
    sent,
    shell,
    address,
    detail,
    shellSnapshot,
    detailSnapshot,
    syncShell,
    syncDetail,
  };
}

afterEach(() => vi.useRealTimers());

test("buffers selected detail until shell authority is synchronized and rejects oversized or misaddressed frames", () => {
  const f = fixture();
  f.syncDetail();
  expect(f.detail.transcript.getSnapshot().items.size).toBe(0);
  expect(f.sent.some((frame) => frame.type === "client.ack")).toBe(false);
  expect(f.stream.receive({ ...f.detailSnapshot(), subscriptionId: "shell" })).toBe(false);
  expect(f.stream.receive(f.detailSnapshot([{ ...item, nodeId }]))).toBe(false);
  const big = Array.from({ length: 50 }, (_, index) => ({
    ...item,
    id: String(index),
    view: { preview: "🦊".repeat(490) },
    author: { kind: "human" as const, principalId: "a".repeat(255), displayName: "ℝ".repeat(150) },
  }));
  expect(f.stream.receive(f.detailSnapshot(big))).toBe(false);
  f.syncShell();
  expect(f.detail.transcript.getSnapshot().items.get(item.id)).toEqual(item);
  expect(
    f.sent.filter((frame) => frame.type === "client.ack").map((frame) => frame.subscriptionId),
  ).toEqual(["shell", f.address.subscriptionId]);
});

test("rejects details ahead of the cut and installs an entire mixed commit before acknowledging it", () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  const ahead = f.detailSnapshot();
  expect(
    f.stream.receive({
      ...ahead,
      snapshot: { ...ahead.snapshot, thread: { ...task, revision: "2" } },
    }),
  ).toBe(false);
  const notices = vi.fn();
  f.detail.transcript.subscribe(notices);
  expect(
    f.stream.receive({
      ...f.address,
      type: "host.changes",
      fromSequence: "1",
      throughSequence: "2",
      changes: [
        {
          entityKind: "thread",
          entityId: threadId,
          ordinal: 0,
          sequence: "2",
          operation: "upsert",
          value: { ...task, title: "Renamed", revision: "2" },
        },
        {
          entityKind: "run-queue",
          entityId: "run-queue",
          ordinal: 1,
          sequence: "2",
          operation: "upsert",
          value: { revision: "2", paused: true, runs: [] },
        },
        {
          entityKind: "request",
          entityId: requestId,
          ordinal: 2,
          sequence: "2",
          operation: "upsert",
          value: {
            id: requestId,
            revision: "2",
            status: "pending",
            kind: "person.question",
            title: "Question",
            threadId,
          },
        },
        { entityKind: "item", entityId: item.id, ordinal: 3, sequence: "2", operation: "remove" },
      ],
    }),
  ).toBe(true);
  expect(notices).toHaveBeenCalledTimes(1);
  const state = f.detail.transcript.getSnapshot();
  expect(state.through).toBe("2");
  expect(state.snapshot?.thread.title).toBe("Renamed");
  expect(state.snapshot?.queue?.paused).toBe(true);
  expect(state.snapshot?.pendingRequests[0]?.id).toBe(requestId);
  expect(state.items.has(item.id)).toBe(false);
  expect(f.sent.at(-1)).toMatchObject({ type: "client.ack", throughSequence: "2" });
});

test("fences a pending write at generation replacement and checkpoints installed removals with the cursor", async () => {
  const commits: PersonalStreamCheckpoint[] = [];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let pause = true;
  const f = fixture({
    load: async () => null,
    remove: async () => {},
    commit: async (checkpoint, current) => {
      if (checkpoint.kind === "detail" && pause) {
        pause = false;
        entered.resolve();
        await release.promise;
      }
      if (current()) commits.push(checkpoint);
    },
  });
  f.syncShell();
  f.syncDetail();
  await entered.promise;
  try {
    f.stream.receive({
      ...f.address,
      type: "host.snapshot-required",
      reason: "cursor-unavailable",
      throughSequence: "2",
    });
    const next = f.sent.at(-1) as Extract<ScopedClientMessage, { type: "client.subscribe" }>;
    expect(next.generation).toBeGreaterThan(f.address.generation);
    expect(next.cursor).toBeUndefined();
    f.stream.receive({
      ...f.address,
      type: "host.changes",
      fromSequence: "1",
      throughSequence: "2",
      changes: [],
    });
    const address = {
      subscriptionId: next.subscriptionId,
      generation: next.generation,
      scope: next.scope,
    };
    f.stream.receive({ ...f.detailSnapshot(), ...address });
    f.stream.receive({ ...address, type: "host.synchronized", throughSequence: "1" });
    f.stream.receive({
      ...address,
      type: "host.changes",
      fromSequence: "1",
      throughSequence: "2",
      changes: [
        { entityKind: "item", entityId: item.id, operation: "remove", sequence: "2", ordinal: 0 },
      ],
    });
  } finally {
    release.resolve();
  }
  await vi.waitFor(() => expect(commits.filter(({ kind }) => kind === "detail")).toHaveLength(1));
  expect(commits.at(-1)).toMatchObject({ cursor: { afterSequence: "2" }, state: { items: [] } });
});

test("restores matching resource watches on shell repair and ignores stale installed lists", () => {
  const f = fixture();
  f.syncShell();
  const release = f.stream.watchResource("machine", () => {});
  const frame = {
    type: "host.resource",
    subscriptionId: "shell",
    generation: f.shell.generation,
    kind: "machine",
  } as const;
  f.stream.receive({
    ...frame,
    revision: "2",
    view: { entries: [{ id: "a" }], complete: true, hasMore: false },
  });
  f.stream.receive({
    ...frame,
    revision: "1",
    view: { entries: [{ id: "old" }], complete: true, hasMore: false },
  });
  expect(f.stream.resources.get("machine")?.view.entries[0]?.id).toBe("a");
  f.stream.receive({
    ...f.shell,
    type: "host.snapshot-required",
    throughSequence: "3",
    reason: "cursor-unavailable",
  });
  expect(f.sent.at(-1)).toMatchObject({
    type: "client.resources.watch",
    interests: ["machine"],
    installed: { machine: "2" },
  });
  const watch = f.sent.at(-1) as Extract<ScopedClientMessage, { type: "client.resources.watch" }>;
  expect(watch.generation).toBeGreaterThan(f.shell.generation);
  f.stream.receive({
    ...f.shellSnapshot("3"),
    generation: watch.generation,
    snapshot: {
      ...f.shellSnapshot("3").snapshot,
      resourceRevisions: revisions("3"),
    },
  });
  f.stream.receive({
    ...frame,
    generation: watch.generation,
    revision: "2",
    view: { complete: true, hasMore: false, entries: [{ id: "old" }] },
  });
  expect(f.stream.resources.getKnownRevision("machine")).toBe("3");
  expect(f.stream.resources.getKnownRevision("tab")).toBe("3");
  release();
});

test("background cancels detail reads and foreground resumes its still-observed scopes", () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  const controller = f.detail.controller!;
  const other = { kind: "thread", threadId: createId("thread") } as const;
  const release = f.stream.observe(other);
  f.stream.setBackground(true);
  expect(controller.signal.aborted).toBe(true);
  expect(f.sent.filter(({ type }) => type === "client.unsubscribe")).toHaveLength(2);
  release();
  const start = f.sent.length;
  f.stream.setBackground(false);
  expect(f.sent.slice(start)).toEqual([
    expect.objectContaining({
      type: "client.subscribe",
      scope: threadScope,
      cursor: expect.objectContaining({ afterSequence: "1" }),
    }),
  ]);
});

test("drops an item read overtaken by a durable removal and retries an older queue response once", async () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  const point = Promise.withResolvers<unknown>();
  const queue = Promise.withResolvers<unknown>();
  const inputQueue = (revision: string) => ({
    ok: true,
    data: { threadId, revision, paused: false, steerRunId: null, items: [] },
  });
  const rpc = {
    "transcript.item.get": vi.fn(() => point.promise),
    "thread.inputQueue.get": vi
      .fn()
      .mockReturnValueOnce(queue.promise)
      .mockResolvedValueOnce(inputQueue("2")),
  } as unknown as import("@opensteer/protocol").HostApiClient;
  const reader = new ScopedThreadReader(f.detail, rpc, new TranscriptBodies());
  const read = reader.body(item.id);
  const readQueue = reader.queue();
  f.stream.receive({
    ...f.address,
    type: "host.changes",
    fromSequence: "1",
    throughSequence: "2",
    changes: [
      { entityKind: "item", entityId: item.id, operation: "remove", sequence: "2", ordinal: 0 },
      {
        entityKind: "collection",
        entityId: "input-queue",
        operation: "invalidate",
        sequence: "2",
        ordinal: 1,
        value: { revision: "2" },
      },
    ],
  });
  point.resolve({
    ok: true,
    data: { item, body: { kind: "text", text: "gone" }, truncated: false },
  });
  queue.resolve(inputQueue("1"));
  expect(await read).toBeUndefined();
  expect(await readQueue).toMatchObject({ revision: "2" });
  expect(rpc["thread.inputQueue.get"]).toHaveBeenCalledTimes(2);
  reader.dispose();
});

test("reviews the exact pending Request revision and drops the reviewed card when its revision changes", async () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  const earlier = Promise.withResolvers<unknown>();
  const later = Promise.withResolvers<unknown>();
  const readRequests = vi
    .fn()
    .mockReturnValueOnce(earlier.promise)
    .mockReturnValueOnce(later.promise);
  const rpc = {
    "thread.requests.list": readRequests,
    "thread.inputQueue.get": async () => ({
      ok: true,
      data: { threadId, revision: "1", paused: false, steerRunId: null, items: [] },
    }),
  } as unknown as import("@opensteer/protocol").HostApiClient;
  const reader = new ScopedThreadReader(f.detail, rpc, new TranscriptBodies());
  const change = (fromSequence: string, throughSequence: string) =>
    f.stream.receive({
      ...f.address,
      type: "host.changes",
      fromSequence,
      throughSequence,
      changes: [
        {
          entityKind: "request",
          entityId: requestId,
          ordinal: 0,
          sequence: throughSequence,
          operation: "upsert",
          value: {
            id: requestId,
            revision: throughSequence,
            status: "pending",
            kind: "person.question",
            title: "Question",
            threadId,
          },
        },
      ],
    });
  const result = (callId: string, revision: string) => ({
    ok: true,
    data: {
      threadId,
      reviewedRevisions: { [requestId]: revision },
      requests: [{ id: requestId, originatingThreadId: threadId, status: "pending", callId }],
    },
  });
  expect(change("1", "2")).toBe(true);
  expect(readRequests).toHaveBeenNthCalledWith(
    1,
    { threadId, review: [{ id: requestId, revision: "2" }] },
    expect.anything(),
  );
  earlier.resolve(result("first", "2"));
  await vi.waitFor(() => expect(reader.getSnapshot().requests[0]?.callId).toBe("first"));

  expect(change("2", "3")).toBe(true);
  expect(reader.getSnapshot().requests).toEqual([]);
  expect(readRequests).toHaveBeenNthCalledWith(
    2,
    { threadId, review: [{ id: requestId, revision: "3" }] },
    expect.anything(),
  );
  later.resolve(result("updated", "3"));
  await vi.waitFor(() => expect(reader.getSnapshot().requests[0]?.callId).toBe("updated"));
  reader.dispose();
});

test("retains the moved item's anchor across a history reset and refuses a response that omits it", async () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  const moved = { ...item, position: "9", revision: "2" };
  f.stream.receive({
    ...f.address,
    type: "host.changes",
    fromSequence: "1",
    throughSequence: "2",
    changes: [
      {
        entityKind: "item",
        entityId: item.id,
        operation: "upsert",
        sequence: "2",
        ordinal: 0,
        value: moved,
      },
    ],
  });
  const page = {
    kind: "page",
    threadId,
    nodeId: null,
    revision: "2",
    orderRevision: "2",
    hasMore: false,
    nextBefore: null,
  };
  const read = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, data: { kind: "history-reset", orderRevision: "2" } })
    .mockResolvedValueOnce({ ok: true, data: { ...page, items: [] } })
    .mockResolvedValueOnce({ ok: true, data: { kind: "history-reset", orderRevision: "2" } })
    .mockResolvedValueOnce({ ok: true, data: { ...page, items: [moved] } });
  const rpc = {
    "thread.items.page": read,
    "thread.inputQueue.get": vi.fn().mockResolvedValue({
      ok: true,
      data: { threadId, revision: "2", items: [], paused: false, steerRunId: null },
    }),
  } as unknown as import("@opensteer/protocol").HostApiClient;
  const reader = new ScopedThreadReader(f.detail, rpc, new TranscriptBodies());
  reader.setAnchor(item.id);
  await expect(reader.history("earlier")).rejects.toThrow("history anchor");
  const installed = f.detail.transcript.getSnapshot().items.get(item.id);
  await reader.history("earlier");
  expect(read).toHaveBeenLastCalledWith({ threadId, anchorItemId: item.id }, expect.anything());
  expect(f.detail.transcript.getSnapshot().items.get(item.id)).toBe(installed);
  reader.dispose();
});

test("bounds explicitly loaded bodies and inactive resource rows", () => {
  const bodies = new TranscriptBodies();
  const big = {
    item,
    threadId,
    nodeId: null,
    body: { kind: "text" as const, text: "🦊".repeat(200_000) },
    truncated: false,
  };
  for (let index = 0; index < 10; index++) bodies.put(String(index), big);
  expect(bodies.get("0", "1")).toBeUndefined();
  expect(bodies.get("9", "1")).toBe(big);
  const f = fixture();
  f.syncShell();
  for (const kind of personalResourceKinds)
    f.stream.receive({
      type: "host.resource",
      subscriptionId: "shell",
      generation: f.shell.generation,
      kind,
      revision: "1",
      view: {
        complete: true,
        hasMore: false,
        entries: Array.from({ length: 32 }, (_, index) => ({ id: String(index) })),
      },
    });
  expect(
    Object.values(f.stream.resources.checkpoint()).flatMap(({ view }) => view.entries),
  ).toHaveLength(256);
});

test("attaches without a cursor when a warm-cache preflight is retryable", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(
      Response.json(
        { ok: false, error: { code: "internal", message: "Starting", retryable: true } },
        { status: 503 },
      ),
    );
  const cache: PersonalStreamCache = {
    hasCheckpoints: async () => true,
    load: async () => null,
    commit: async () => {},
    remove: async () => {},
  };
  let socket: MockPersonalSocket;
  const connect = vi.fn(
    () =>
      (socket = new MockPersonalSocket((raw) => {
        const message = JSON.parse(raw) as ScopedClientMessage;
        if (message.type !== "client.attach") return;
        const address = {
          subscriptionId: "shell" as const,
          scope: shellScope,
          generation: message.generation,
        };
        socket.deliver({
          ...address,
          type: "host.snapshot",
          throughSequence: "1",
          snapshot: {
            deploymentId,
            viewerId,
            epoch,
            session,
            tasks: [task],
            visits: [],
            attention: [],
            counts,
            recentTaskIds: [threadId],
            activeTaskIds: [],
            resourceRevisions: revisions("0"),
          },
        });
        socket.deliver({ ...address, type: "host.synchronized", throughSequence: "1" });
      })),
  );
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    streamCache: cache,
    fetch,
    webSocketFactory: connect,
    capabilities: [],
  });
  try {
    client.activateThread(threadId);
    await client.load();
    expect(connect).toHaveBeenCalledTimes(1);
    const attach = JSON.parse(socket!.sent[0]!) as Extract<
      ScopedClientMessage,
      { type: "client.attach" }
    >;
    expect(attach.cursor).toBeUndefined();
    expect(attach.selected?.scope).toEqual(threadScope);
    expect(client.getSnapshot().connection).toBe("connected");
    expect(client.getSnapshot().tasks?.entries.map(({ thread }) => thread.id)).toEqual([threadId]);
    expect(client.getSnapshot().activeTasks).toEqual([]);
  } finally {
    client.dispose();
  }
});

test("uses no timers or network reads when an attached personal client is idle", async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValue(new Error("Unexpected idle read"));
  let socket: MockPersonalSocket;
  const connect = () =>
    (socket = new MockPersonalSocket((raw) => {
      const message = JSON.parse(raw) as ScopedClientMessage;
      if (message.type !== "client.attach") return;
      const address = {
        subscriptionId: "shell" as const,
        scope: shellScope,
        generation: message.generation,
      };
      socket.deliver({
        ...address,
        type: "host.snapshot",
        throughSequence: "0",
        snapshot: {
          deploymentId,
          viewerId,
          epoch,
          session,
          tasks: [],
          visits: [],
          attention: [],
          counts,
          resourceRevisions: revisions("0"),
          resources: [
            {
              kind: "machine",
              revision: "0",
              view: {
                entries: [{ id: "device", label: "Mac" }],
                complete: true,
                hasMore: false,
              },
            },
          ],
        },
      });
      socket.deliver({ ...address, type: "host.synchronized", throughSequence: "0" });
    }));
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    webSocketFactory: connect,
    fetch,
    capabilities: [],
  });
  try {
    await client.load();
    expect(client.getSnapshot().connection).toBe("connected");
    const frames = socket!.sent.length;
    expect(client.getSnapshot().resourceSummaries?.machine?.entries[0]?.label).toBe("Mac");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetch).not.toHaveBeenCalled();
    expect(socket!.sent).toHaveLength(frames);
  } finally {
    client.dispose();
  }
});

test("keeps a provisional item and its final message at one row identity", () => {
  const f = fixture();
  f.syncShell();
  f.stream.receive(f.detailSnapshot([]));
  f.stream.receive({ ...f.address, type: "host.synchronized", throughSequence: "1" });
  const attemptId = createId("runAttempt");
  const face = { ...item, attemptId, view: { preview: "" } };
  const address = {
    ...f.address,
    type: "host.live" as const,
    liveBootId: crypto.randomUUID(),
    runId,
    attemptId,
    bindingGeneration: 1,
    streamId: "reply",
    itemId: face.id,
    afterSequence: "1",
  };
  expect(
    f.stream.receive({
      ...address,
      item: face,
      update: { operation: "append", totalLength: 2, offset: 0, text: "🦊" },
    }),
  ).toBe(true);
  expect([...f.detail.transcript.getSnapshot().liveItems.keys()]).toEqual([item.id]);
  const structure = f.detail.transcript.getSnapshot();
  f.stream.receive({
    ...address,
    update: { operation: "append", totalLength: 3, offset: 2, text: "!" },
  });
  expect(f.detail.transcript.getSnapshot()).toBe(structure);
  f.stream.receive({
    ...f.address,
    type: "host.changes",
    fromSequence: "1",
    throughSequence: "2",
    changes: [
      {
        operation: "upsert",
        entityKind: "item",
        entityId: item.id,
        sequence: "2",
        ordinal: 0,
        value: { ...face, revision: "2", view: { preview: "🦊!" } },
      },
    ],
  });
  const final = f.detail.transcript.getSnapshot();
  expect(final.liveItems.size).toBe(0);
  expect(final.ids).toEqual([item.id]);
  f.stream.receive({ ...address, afterSequence: "2", update: { operation: "close" } });
  f.stream.receive({
    ...address,
    update: { operation: "replace", text: "stale", offset: 0, totalLength: 5, incomplete: false },
  });
  expect(f.detail.text.get(item.id)).toBeUndefined();
  expect(f.detail.transcript.getSnapshot()).toBe(final);
});

test("rejects a saved cut whose revision or authority does not match and ignores a read after logout", async () => {
  const saved = new Map<string, PersonalStreamCheckpoint>();
  const cache: PersonalStreamCache = {
    load: async (scope) => saved.get(scope.scopeKey) ?? null,
    commit: async (checkpoint, current) => {
      if (current()) saved.set(checkpoint.scope.scopeKey, checkpoint);
    },
    remove: async (scope) => {
      saved.delete(scope.scopeKey);
    },
  };
  const f = fixture(cache);
  f.syncShell();
  f.syncDetail();
  await vi.waitFor(() => expect(saved.size).toBe(2));

  const fresh = new ScopedPersonalStream(cache);
  fresh.select(threadScope);
  await fresh.restore({ deploymentId, viewerId, epoch: crypto.randomUUID() });
  const emit = vi.fn();
  fresh.attach(emit);
  expect(emit.mock.calls[0]?.[0].cursor).toBeUndefined();
  expect(fresh.detail(threadScope).transcript.getSnapshot().items.size).toBe(0);

  const held = { ...saved.get("shell")! };
  expect(held.kind).toBe("shell");
  if (held.kind !== "shell") throw new Error("Missing saved shell.");
  const gate = Promise.withResolvers<PersonalStreamCheckpoint | null>();
  const next = new ScopedPersonalStream({ ...cache, load: () => gate.promise });
  const reading = next.restore({ deploymentId, viewerId, epoch });
  next.clear(true);
  gate.resolve(held);
  await reading;
  expect(next.shell.getSnapshot().snapshot).toBeNull();
});

test("refuses raw tool text in a feed preview while keeping the stable tool identity", () => {
  const f = fixture();
  f.syncShell();
  const tool = {
    ...item,
    id: "tool:1",
    kind: "tool" as const,
    toolCallId: "1",
    view: { status: "done", preview: "synthetic-private-marker" },
  };
  const { messageId: _messageId, ...toolOnly } = tool;
  expect(f.stream.receive(f.detailSnapshot([toolOnly]))).toBe(false);
  expect(f.detail.transcript.getSnapshot().items.size).toBe(0);
  const safe = { ...toolOnly, view: { status: "done" } };
  expect(f.stream.receive(f.detailSnapshot([safe]))).toBe(true);
  expect(f.detail.transcript.getSnapshot().items.get(safe.id)).toEqual(safe);
});

test("evicts inactive scope previews before they exceed the structural budget", () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  const scopes = Array.from({ length: 22 }, () => ({
    kind: "thread" as const,
    threadId: createId("thread"),
  }));
  const details = scopes.map((scope) => {
    const release = f.stream.observe(scope);
    const address = f.sent.at(-1) as Extract<ScopedClientMessage, { type: "client.subscribe" }>;
    const snapshot = f.detailSnapshot(
      Array.from({ length: 50 }, (_, index) => ({
        ...item,
        id: String(index),
        position: String(index + 1),
      })),
    ).snapshot;
    f.stream.receive({
      subscriptionId: address.subscriptionId,
      generation: address.generation,
      scope,
      type: "host.snapshot",
      throughSequence: "1",
      snapshot: { ...snapshot, thread: { ...task, id: scope.threadId }, nextBefore: null },
    });
    const store = f.stream.detail(scope);
    expect(store.transcript.getSnapshot().items.size).toBe(50);
    release();
    return store;
  });
  expect(f.stream.detail(scopes[0]!) === details[0]).toBe(false);
  expect(f.stream.detail(scopes.at(-1)!) === details.at(-1)).toBe(true);
  expect(f.detail.transcript.getSnapshot().items.get(item.id)?.id).toBe(item.id);
});

test("reconnects from unaffected complete cuts when an authority close names a revoked slot", () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  const other = { kind: "thread", threadId: createId("thread") } as const;
  const release = f.stream.observe(other);
  const otherAttach = f.sent.at(-1) as Extract<ScopedClientMessage, { type: "client.subscribe" }>;
  const otherAddress = {
    scope: other,
    generation: otherAttach.generation,
    subscriptionId: otherAttach.subscriptionId,
  };
  f.stream.receive({
    ...f.detailSnapshot(),
    ...otherAddress,
    snapshot: {
      ...f.detailSnapshot().snapshot,
      thread: { ...task, id: other.threadId },
      nextBefore: null,
    },
  });
  f.stream.receive({ ...otherAddress, type: "host.synchronized", throughSequence: "1" });
  f.stream.revokeDetails([otherAddress.subscriptionId]);
  f.stream.attach((frame) => f.sent.push(frame));
  const recent = f.sent.filter((frame) => frame.type === "client.attach").at(-1);
  expect(recent?.cursor?.afterSequence).toBe("1");
  expect(recent?.selected?.cursor?.afterSequence).toBe("1");
  const replaced = f.sent.at(-1);
  expect(replaced).toMatchObject({ type: "client.subscribe", scope: other });
  expect(replaced && "cursor" in replaced).toBe(false);
  release();
});

test("replays a full saved history window with updated and removed active overlays", async () => {
  let serialized: string | null = null;
  const storage = {
    exists: async () => serialized !== null,
    read: async () => serialized,
    write: async (value: string, current: () => boolean) => {
      if (current()) serialized = value;
    },
    remove: async () => {
      serialized = null;
    },
  };
  const cache = createPersonalStreamCache(storage);
  const f = fixture(cache);
  const history = Array.from({ length: 50 }, (_, i) => {
    const id = createId("message");
    return { ...item, id, messageId: id, position: String(i + 3) };
  });
  const tool = {
    ...item,
    kind: "tool",
    id: "tool-a",
    toolCallId: "call-a",
    view: { status: "running" },
  } satisfies TranscriptItem;
  const { messageId: _unused, ...active } = tool;
  const other = { ...active, id: "tool-b", toolCallId: "call-b", position: "2" };
  f.syncShell();
  const frame = f.detailSnapshot(history);
  f.stream.receive({
    ...frame,
    snapshot: {
      ...frame.snapshot,
      nextBefore: null,
      activeItems: [active, other],
    },
  });
  f.stream.receive({ ...f.address, type: "host.synchronized", throughSequence: "1" });
  f.stream.receive({
    ...f.address,
    type: "host.changes",
    fromSequence: "1",
    throughSequence: "2",
    changes: [
      {
        sequence: "2",
        ordinal: 0,
        entityKind: "item",
        entityId: active.id,
        operation: "upsert",
        value: { ...active, revision: "2", view: { status: "running", title: "Updated" } },
      },
      { sequence: "2", ordinal: 1, entityKind: "item", entityId: other.id, operation: "remove" },
    ],
  });
  await vi.waitFor(() => expect(serialized).toContain('"afterSequence":"2"'));
  const fresh = new ScopedPersonalStream(createPersonalStreamCache(storage));
  fresh.select(threadScope);
  await fresh.restore({ deploymentId, viewerId, epoch });
  const sent: ScopedClientMessage[] = [];
  fresh.attach((message) => sent.push(message));
  const attach = sent[0] as Extract<ScopedClientMessage, { type: "client.attach" }>;
  expect(attach.selected?.cursor?.afterSequence).toBe("2");
  expect(fresh.detail(threadScope).transcript.getSnapshot().items.size).toBe(51);
  expect(fresh.detail(threadScope).transcript.getSnapshot().items.get(active.id)?.revision).toBe(
    "2",
  );
  expect(fresh.detail(threadScope).transcript.getSnapshot().items.has(other.id)).toBe(false);
});

test("refreshes a quiet input queue after two in-flight reads are overtaken", async () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  type QueueRead = Awaited<
    ReturnType<import("@opensteer/protocol").HostApiClient["thread.inputQueue.get"]>
  >;
  const first = Promise.withResolvers<QueueRead>();
  const second = Promise.withResolvers<QueueRead>();
  const answer = (revision: string): QueueRead => ({
    ok: true,
    data: { threadId, revision, paused: false, steerRunId: null, items: [] },
  });
  const queue = vi
    .fn<import("@opensteer/protocol").HostApiClient["thread.inputQueue.get"]>()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockResolvedValue(answer("3"));
  const reader = new ScopedThreadReader(
    f.detail,
    { "thread.inputQueue.get": queue } as unknown as import("@opensteer/protocol").HostApiClient,
    new TranscriptBodies(),
  );
  const invalidate = (fromSequence: string, throughSequence: string) =>
    f.stream.receive({
      ...f.address,
      type: "host.changes",
      fromSequence,
      throughSequence,
      changes: [
        {
          operation: "invalidate",
          entityKind: "collection",
          entityId: "input-queue",
          sequence: throughSequence,
          ordinal: 0,
          value: { revision: throughSequence },
        },
      ],
    });
  try {
    invalidate("1", "2");
    first.resolve(answer("1"));
    await vi.waitFor(() => expect(queue).toHaveBeenCalledTimes(2));
    invalidate("2", "3");
    second.resolve(answer("2"));
    await vi.waitFor(() =>
      expect(f.detail.transcript.getSnapshot().inputQueue?.revision).toBe("3"),
    );
  } finally {
    reader.dispose();
  }
});

test("does not install a history page that contains another node's item", async () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  const wrong = { ...item, nodeId, revision: "2", view: { preview: "Wrong scope" } };
  const read = vi.fn().mockResolvedValue({
    ok: true,
    data: {
      kind: "page",
      threadId,
      nodeId: null,
      items: [wrong],
      orderRevision: "1",
      revision: "2",
      nextBefore: null,
      hasMore: false,
    },
  });
  const reader = new ScopedThreadReader(
    f.detail,
    { "thread.items.page": read } as unknown as import("@opensteer/protocol").HostApiClient,
    new TranscriptBodies(),
    false,
  );
  try {
    await expect(reader.history("latest")).rejects.toThrow("scope");
    expect(f.detail.transcript.getSnapshot().items.get(item.id)?.view.preview).toBe("A");
  } finally {
    reader.dispose();
  }
});

test("hides an invalidated Request prefix until its current membership has been read", async () => {
  const f = fixture();
  f.syncShell();
  const frame = f.detailSnapshot();
  const summary = {
    id: requestId,
    status: "pending",
    kind: "person.question",
    title: "Review",
    revision: "1",
    threadId,
  };
  f.stream.receive({
    ...frame,
    snapshot: {
      ...frame.snapshot,
      pendingRequests: [summary],
      overlayCursors: { requests: "old" },
    },
  });
  f.stream.receive({ ...f.address, type: "host.synchronized", throughSequence: "1" });
  type Rpc = import("@opensteer/protocol").HostApiClient;
  const next = Promise.withResolvers<Awaited<ReturnType<Rpc["thread.overlays.page"]>>>();
  const overlays = vi.fn<Rpc["thread.overlays.page"]>().mockReturnValue(next.promise);
  const reader = new ScopedThreadReader(
    f.detail,
    {
      "thread.inputQueue.get": async () => ({
        ok: true,
        data: {
          threadId,
          revision: "1",
          paused: false,
          steerRunId: null,
          items: [],
        },
      }),
      "thread.requests.list": async () => ({
        ok: true,
        data: {
          threadId,
          requests: [{ id: requestId, originatingThreadId: threadId, status: "pending" }],
          reviewedRevisions: { [requestId]: "1" },
        },
      }),
      "thread.overlays.page": overlays,
    } as unknown as Rpc,
    new TranscriptBodies(),
  );
  try {
    await vi.waitFor(() => expect(reader.getSnapshot().requests).toHaveLength(1));
    f.stream.receive({
      ...f.address,
      type: "host.changes",
      fromSequence: "1",
      throughSequence: "2",
      changes: [
        {
          sequence: "2",
          ordinal: 0,
          operation: "invalidate",
          entityKind: "collection",
          entityId: "requests",
          value: { revision: "2" },
        },
      ],
    });
    expect(reader.getSnapshot()).toMatchObject({
      requests: [],
      moreRequests: false,
      requestsRefreshing: true,
    });
    expect(overlays).toHaveBeenCalledWith(
      { threadId, kind: "requests", expectedRevision: "2" },
      expect.anything(),
    );
    next.resolve({
      ok: true,
      data: { threadId, nodeId: null, kind: "requests", revision: "2", entries: [], next: null },
    });
    await vi.waitFor(() => expect(reader.getSnapshot().requestsRefreshing).toBe(false));
    expect(reader.getSnapshot().requests).toEqual([]);
  } finally {
    reader.dispose();
  }
});

test("a named socket close purges its task and resumes the unaffected scope", async () => {
  const other = { kind: "thread" as const, threadId: createId("thread") };
  const saved = new Map<string, PersonalStreamCheckpoint>();
  const cache: PersonalStreamCache = {
    hasCheckpoints: async () => false,
    load: async (key) => saved.get(key.scopeKey) ?? null,
    commit: async (checkpoint, current) => {
      if (current()) saved.set(checkpoint.scope.scopeKey, checkpoint);
    },
    remove: async (key) => {
      saved.delete(key.scopeKey);
    },
  };
  const sockets: MockPersonalSocket[] = [];
  const attachments: Extract<ScopedClientMessage, { type: "client.attach" }>[] = [];
  let revokedSlot: `detail:${0 | 1 | 2 | 3}` | undefined;
  const connect = () => {
    const connection = sockets.length;
    const socket = new MockPersonalSocket((raw) => {
      const frame = JSON.parse(raw) as ScopedClientMessage;
      const detail = (subscription: Extract<ScopedClientMessage, { type: "client.subscribe" }>) => {
        const { scope, subscriptionId, generation, cursor: resume } = subscription;
        if (scope.kind !== "thread" || subscriptionId === "shell") return;
        if (scope.threadId === other.threadId) revokedSlot = subscriptionId;
        if (connection > 0 && scope.threadId === other.threadId) {
          socket.deliver({
            type: "host.removed",
            scope,
            subscriptionId,
            generation,
            reason: "unavailable",
          });
          return;
        }
        const address = { scope, subscriptionId, generation, throughSequence: "1" };
        if (!resume)
          socket.deliver({
            ...address,
            type: "host.snapshot",
            snapshot: {
              thread: { ...task, id: scope.threadId },
              items: [item],
              activeItems: [],
              pendingRequests: [],
              orderRevision: "1",
              inputQueueRevision: "1",
              nextBefore: null,
            },
          });
        socket.deliver({ ...address, type: "host.synchronized" });
      };
      queueMicrotask(() => {
        if (frame.type === "client.subscribe") detail(frame);
        if (frame.type !== "client.attach") return;
        attachments.push(frame);
        const address = {
          generation: frame.generation,
          scope: shellScope,
          subscriptionId: "shell" as const,
          throughSequence: "1",
        };
        if (!frame.cursor)
          socket.deliver({
            ...address,
            type: "host.snapshot",
            snapshot: {
              deploymentId,
              viewerId,
              epoch,
              session,
              tasks: [task],
              visits: [],
              attention: [],
              counts,
              resourceRevisions: revisions("0"),
            },
          });
        socket.deliver({ ...address, type: "host.synchronized" });
        if (frame.selected) detail({ type: "client.subscribe", ...frame.selected });
      });
    });
    sockets.push(socket);
    return socket;
  };
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    streamCache: cache,
    webSocketFactory: connect,
    capabilities: [],
    reconnectBaseDelayMs: 1,
    reconnectMaxDelayMs: 1,
    fetch: async () =>
      Response.json({
        ok: false,
        error: { code: "not_found", message: "Unavailable", retryable: false },
      }),
  });
  const release = client.observeThread(other.threadId);
  try {
    client.activateThread(threadId);
    await client.load();
    await vi.waitFor(() => expect(saved.size).toBe(3));
    expect(client.getThreadTranscript(other.threadId)?.getSnapshot().entries).toHaveLength(1);
    sockets[0]!.emit("close", {
      code: 4003,
      reason: personalAuthorityChangedReason([revokedSlot!]),
    });
    expect(client.getThreadTranscript(other.threadId)?.getSnapshot().entries).toEqual([]);
    await vi.waitFor(() => expect(attachments).toHaveLength(2));
    expect(attachments[1]?.cursor?.afterSequence).toBe("1");
    expect(attachments[1]?.selected?.cursor?.afterSequence).toBe("1");
    await vi.waitFor(() => expect(saved.has(`thread:${other.threadId}`)).toBe(false));
    const restored = new ScopedPersonalStream(cache);
    restored.select(other);
    await restored.restore({ deploymentId, viewerId, epoch, session });
    expect(restored.detail(other).transcript.getSnapshot().items.size).toBe(0);
    expect(
      await cache.load({
        deploymentId,
        viewerId,
        epoch,
        format: personalCacheFormat,
        scopeKey: `thread:${threadId}`,
      }),
    ).not.toBeNull();
  } finally {
    release();
    client.dispose();
  }
});
