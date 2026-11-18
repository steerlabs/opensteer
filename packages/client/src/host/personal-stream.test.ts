import { AppIdSchema, createId, SequenceSchema, TabSchema } from "@opensteer/core";
import { afterEach, expect, test, vi } from "vitest";
import {
  personalAuthorityChangedReason,
  personalChangesFrameMaxBytes,
  type ScopedClientMessage,
} from "@opensteer/protocol/personal-sync";
import {
  personalResourceKinds,
  PersonalResourceRevisionsSchema,
} from "@opensteer/protocol/resources";
import type { TranscriptItem, TranscriptOrderCursor } from "@opensteer/protocol/transcript";
import { MockPersonalHost, MockPersonalSocket } from "../mock/mock-personal-host.js";
import { MockHostClient } from "../mock/mock-host-client.js";
import { HttpHostClient } from "./host-session-client.js";
import type { ClientLifecycle } from "./lifecycle.js";
import {
  createPersonalStreamCache,
  personalCacheFormat,
  type PersonalStreamCache,
  type PersonalStreamCheckpoint,
} from "./personal-stream-cache.js";
import { ScopedPersonalStream } from "./scoped-personal-stream.js";
import { ScopedThreadReader, TranscriptBodies } from "./scoped-thread-reader.js";
import { nodeTranscriptCard } from "./transcript-item-view.js";

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

test("carries a scoped task update into held rows and drops old task pages after a cursor reset", async () => {
  const mock = new MockHostClient({ latencyMs: 0 });
  const done = mock
    .getSnapshot()
    .threads.find(({ status, listed }) => listed && status === "idle")!;
  await mock.setTaskDone(done.id, true);
  const page = await mock.rpc["tasks.page"]({ done: true, limit: 50 });
  if (!page.ok) throw new Error("The Done task fixture is missing.");
  page.data.asOfSequence = SequenceSchema.parse("900");
  const row = page.data.tasks.find(({ thread }) => thread.id === done.id)!;
  row.thread.pendingRequests = 0;
  const late = Promise.withResolvers<Response>();
  let reads = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    if (!new URL(String(input)).pathname.endsWith("/tasks.page"))
      return new Response(null, { status: 404 });
    if (reads++ === 0) return Response.json(page);
    return late.promise;
  });
  let socket: MockPersonalSocket;
  let address = { subscriptionId: "shell" as const, scope: shellScope, generation: 0 };
  let head = "900";
  let status: "running" | "idle" = "running";
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    fetch,
    capabilities: [],
    webSocketFactory: () =>
      (socket = new MockPersonalSocket((raw) => {
        const frame = JSON.parse(raw) as ScopedClientMessage;
        if (frame.type !== "client.attach" && frame.type !== "client.subscribe") return;
        if (frame.type === "client.subscribe" && frame.scope.kind !== "shell") return;
        address = { ...address, generation: frame.generation };
        socket.deliver({
          ...address,
          type: "host.snapshot",
          throughSequence: head,
          snapshot: {
            deploymentId,
            viewerId,
            epoch,
            session,
            tasks: [{ ...task, status, revision: head }],
            visits: [],
            attention: [],
            counts,
            resourceRevisions: revisions("0"),
          },
        });
        socket.deliver({ ...address, type: "host.synchronized", throughSequence: head });
      })),
  });
  try {
    await client.load();
    await client.loadDoneTasks();
    const doneRow = () =>
      Object.values(client.getSnapshot().doneTasks)
        .flatMap(({ entries }) => entries)
        .find(({ thread }) => thread.id === done.id)?.thread;
    expect(doneRow()?.status).toBe("idle");
    head = "901";
    socket!.deliver({
      ...address,
      type: "host.changes",
      fromSequence: "900",
      throughSequence: head,
      changes: [
        {
          entityKind: "task",
          entityId: done.id,
          ordinal: 0,
          sequence: head,
          operation: "upsert",
          value: {
            ...task,
            id: row.thread.id,
            title: row.thread.title,
            revision: head,
            status: "failed",
            inputQueuePaused: true,
            doneAt: row.thread.doneAt,
            pendingRequestCount: 1,
          },
        },
      ],
    });
    expect(doneRow()).toMatchObject({
      status: "failed",
      inputQueuePaused: true,
      pendingRequests: 0,
    });

    const request = client.loadDoneTasks();
    await vi.waitFor(() => expect(reads, "The old task page never started").toBe(2));
    head = "2";
    status = "idle";
    socket!.deliver({
      ...address,
      type: "host.snapshot-required",
      reason: "cursor-unavailable",
      throughSequence: head,
    });
    expect(client.getSnapshot().tasks?.entries[0]?.thread.status).toBe("idle");
    late.resolve(Response.json(page));
    await request;
    expect(doneRow()).toBeUndefined();
    expect(client.getSnapshot().connection).toBe("connected");
  } finally {
    late.resolve(Response.json(page));
    client.dispose();
    mock.dispose();
  }
});

test("refreshes a loaded Done window after a hidden shell replacement, once on replay", async () => {
  const mock = new MockHostClient({ latencyMs: 0 });
  const host = new MockPersonalHost(mock);
  let foreground = () => {};
  let background = () => {};
  const lifecycle: ClientLifecycle = {
    getSnapshot: () => ({ network: "online", visibility: "foreground" }),
    onForeground: (listener) => {
      foreground = listener;
      return () => {};
    },
    onBackground: (listener) => {
      background = listener;
      return () => {};
    },
    onNetworkChange: () => () => {},
  };
  let reads = 0;
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    capabilities: [],
    lifecycle,
    fetch: (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/tasks.page")) reads++;
      return host.fetch(input, init);
    },
    webSocketFactory: host.connect,
  });
  try {
    await client.load();
    await client.loadDoneTasks();
    expect(reads).toBe(1);
    const [socket] = host.sockets;
    const attach = JSON.parse(socket!.sent[0]!) as Extract<
      ScopedClientMessage,
      { type: "client.attach" }
    >;
    background();
    socket!.deliver({
      type: "host.snapshot-required",
      reason: "scope-invalidated",
      subscriptionId: "shell",
      scope: shellScope,
      generation: attach.generation,
      throughSequence: String(mock.getSnapshot().revision),
    });
    await vi.waitFor(() => expect(client.getSnapshot().connection).toBe("connected"));
    expect(reads).toBe(1);

    foreground();
    await client.load();
    await vi.waitFor(() => expect(reads).toBe(2));
    const [resumed] = host.sockets;
    expect(JSON.parse(resumed!.sent[0]!).cursor).toBeDefined();

    background();
    foreground();
    await client.load();
    expect(reads).toBe(2);
  } finally {
    client.dispose();
    host.dispose();
  }
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

test("restarts an interrupted catalog read when the same revision is reopened", async () => {
  const host = new MockPersonalHost();
  const environment = host.client.getSnapshot().environments[0]!;
  const account = createId("harnessInstance");
  const model = (modelId: string) => ({
    modelId,
    providerId: "openai",
    displayName: modelId,
    isDefault: false,
    options: [],
  });
  const reply = (revision: string, modelId: string, next: string | null) =>
    Response.json({
      ok: true,
      data: {
        revision,
        next,
        data: {
          kind: "harness-catalog",
          environments: [
            {
              ...environment,
              harnessCatalogs: [
                {
                  status: "ready",
                  driverKind: "codex",
                  harnessInstanceId: account,
                  continuationIdentity: {
                    driverKind: "codex",
                    continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
                  },
                  models: [model(modelId)],
                },
              ],
            },
          ],
        },
      },
    });
  let firstRead = true;
  let secondPageSignal: AbortSignal | null | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const { kind, cursor, expectedRevision } = JSON.parse(url.searchParams.get("input") ?? "{}");
    if (url.pathname !== "/v1/rpc/resources.detail.get" || kind !== "harness-catalog")
      return host.fetch(input, init);
    if (!cursor) return reply(expectedRevision, "first-model", "next");
    if (firstRead) {
      secondPageSignal = init?.signal;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }
    return reply(expectedRevision, "second-model", null);
  };
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    fetch,
    webSocketFactory: host.connect,
    capabilities: [],
  });
  const releaseEnvironment = client.watchPersonalResource("environment", () => {});
  let release = client.watchPersonalResource("harness-catalog", () => {});
  const models = () =>
    client
      .getSnapshot()
      .environments.find(({ id }) => id === environment.id)
      ?.harnessCatalogs.find(({ harnessInstanceId }) => harnessInstanceId === account)
      ?.models.map(({ modelId }) => modelId);
  try {
    await client.load();
    await vi.waitFor(
      () => {
        expect(secondPageSignal).toBeDefined();
        expect(models()).toEqual(["first-model"]);
      },
      { timeout: 1000 },
    );
    release();
    expect(secondPageSignal?.aborted).toBe(true);
    firstRead = false;
    release = client.watchPersonalResource("harness-catalog", () => {});
    await vi.waitFor(() => expect(models()).toEqual(["first-model", "second-model"]), {
      timeout: 1000,
    });
  } finally {
    release();
    releaseEnvironment();
    client.dispose();
    host.dispose();
  }
});

test("retains stale tab inventory until replacement and keeps its independent layout", async () => {
  const tab = TabSchema.parse({
    tabId: "page",
    kind: "page",
    title: "Page",
    computer: { computerId: createId("runner"), name: "Mac" },
    groupId: null,
    state: "open",
    openedBy: "person",
    usedBy: [],
    createdAt: time,
    updatedAt: time,
    url: "https://example.test/",
    profile: null,
  });
  const tabsByPage = ["page", "next", "third", "fourth", "fifth"].map((tabId) =>
    TabSchema.parse({ ...tab, tabId }),
  );
  const layout = {
    revision: 1,
    items: tabsByPage.map(({ tabId }) => ({ kind: "tab" as const, tabId })),
  };
  const view = { entries: [], complete: true, hasMore: false };
  let socket: MockPersonalSocket;
  let generation = 0;
  const replacement = Promise.withResolvers<Response>();
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
    const { kind, expectedRevision, cursor } = JSON.parse(
      new URL(String(url)).searchParams.get("input")!,
    );
    if (expectedRevision === "2") return replacement.promise;
    const page = Number(cursor ?? 0);
    const next = kind === "tab" && page + 1 < tabsByPage.length ? String(page + 1) : null;
    return Response.json({
      ok: true,
      data: {
        revision: "1",
        data: {
          kind,
          tabs: {
            tabs: kind === "tab" ? [tabsByPage[page]] : [],
            layout,
            complete: !next,
          },
        },
        next,
      },
    });
  });
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    fetch,
    capabilities: [],
    webSocketFactory: () =>
      (socket = new MockPersonalSocket((raw) => {
        const frame = JSON.parse(raw) as ScopedClientMessage;
        if (frame.type !== "client.attach") return;
        generation = frame.generation;
        const address = { generation, scope: shellScope, subscriptionId: "shell" as const };
        socket.deliver({
          ...address,
          type: "host.snapshot",
          throughSequence: "1",
          snapshot: {
            deploymentId,
            viewerId,
            epoch,
            session,
            tasks: [],
            visits: [],
            attention: [],
            counts,
            resourceRevisions: revisions("1"),
            resources: [
              { kind: "tab", revision: "1", view },
              { kind: "tab-layout", revision: "1", view },
            ],
          },
        });
        socket.deliver({ ...address, type: "host.synchronized", throughSequence: "1" });
      })),
  });
  const releaseTab = client.watchPersonalResource("tab", () => {});
  const releaseLayout = client.watchPersonalResource("tab-layout", () => {});
  const tabs = client.getSnapshot().tabs;
  try {
    await client.load();
    await vi.waitFor(() => {
      expect([...tabs.rows.keys()]).toEqual(tabsByPage.map(({ tabId }) => tabId));
      expect(tabs.complete).toBe(true);
      expect(tabs.layout).toEqual(layout);
    });
    const held = tabs.get(tab.tabId);
    socket!.deliver({
      type: "host.resource",
      subscriptionId: "shell",
      generation,
      kind: "tab",
      revision: "2",
      view,
    });
    expect(tabs.get(tab.tabId)).toBe(held);
    expect(tabs.complete).toBe(false);
    expect(tabs.layout).toEqual(layout);

    replacement.resolve(
      Response.json({
        ok: true,
        data: {
          revision: "2",
          data: { kind: "tab", tabs: { tabs: [], layout, complete: true } },
          next: null,
        },
      }),
    );
    await vi.waitFor(() => {
      expect(tabs.get(tab.tabId)).toBeUndefined();
      expect(tabs.complete).toBe(true);
      expect(tabs.layout).toEqual(layout);
    });
  } finally {
    releaseTab();
    releaseLayout();
    client.dispose();
  }
});

test.each(["message", "reasoning"] as const)(
  "keeps provisional %s in its original slot and lets the durable text win",
  async (kind) => {
    const f = fixture();
    f.syncShell();
    f.stream.receive(f.detailSnapshot([]));
    f.stream.receive({ ...f.address, type: "host.synchronized", throughSequence: "1" });
    const attemptId = createId("runAttempt");
    const { messageId: _messageId, ...base } = item;
    const face =
      kind === "message"
        ? { ...item, attemptId, view: {} }
        : {
            ...base,
            kind,
            id: "thought",
            attemptId,
            blockId: "thought",
            bindingGeneration: 1,
            view: {},
          };
    const final = { ...face, revision: "3", view: { preview: "The authoritative text." } };
    const tool = {
      ...base,
      kind: "tool" as const,
      id: "search",
      toolCallId: "search",
      position: "2",
      revision: "2",
      view: { status: "done" },
    };
    type Rpc = import("@opensteer/protocol").HostApiClient;
    const rpc = {
      "thread.inputQueue.get": async () => ({
        ok: true,
        data: { threadId, revision: "1", paused: false, steerRunId: null, items: [] },
      }),
      "thread.items.page": async () => ({
        ok: true,
        data: {
          kind: "page",
          threadId,
          nodeId: null,
          revision: "3",
          orderRevision: "1",
          items: [final, tool],
          nextBefore: null,
          hasMore: false,
        },
      }),
    } as unknown as Rpc;
    const reader = new ScopedThreadReader(f.detail, rpc, new TranscriptBodies());
    const address = {
      ...f.address,
      type: "host.live" as const,
      liveBootId: crypto.randomUUID(),
      runId,
      attemptId,
      bindingGeneration: 1,
      streamId: "draft",
      itemId: face.id,
      afterSequence: "1",
    };
    const upsert = (value: TranscriptItem, fromSequence: string) =>
      f.stream.receive({
        ...f.address,
        type: "host.changes",
        fromSequence,
        throughSequence: value.revision,
        changes: [
          {
            operation: "upsert",
            entityKind: "item",
            entityId: value.id,
            sequence: value.revision,
            ordinal: 0,
            value,
          },
        ],
      });
    try {
      if (kind === "reasoning") {
        f.stream.receive({
          ...address,
          item: face,
          update: { operation: "append", totalLength: 0, offset: 0, text: "" },
        });
        expect(reader.getSnapshot().entries).toEqual([]);
      }
      expect(
        f.stream.receive({
          ...address,
          ...(kind === "message" ? { item: face } : {}),
          update: { operation: "append", totalLength: 2, offset: 0, text: "🦊" },
        }),
      ).toBe(true);
      upsert(tool, "1");
      const draft = reader.getSnapshot().entries;
      expect(draft.map(({ id }) => id)).toEqual([face.id, tool.id]);
      expect(draft[0]).toMatchObject(
        kind === "message" ? { streaming: true } : { state: "streaming" },
      );
      f.stream.receive({
        ...address,
        update: { operation: "append", totalLength: 3, offset: 2, text: "!" },
      });
      expect(f.detail.text.get(face.id)?.text).toBe("🦊!");
      expect(reader.getSnapshot().entries).toBe(draft);
      if (kind === "message") upsert(final, "2");
      else await reader.history("latest");
      const settled = reader.getSnapshot().entries;
      expect(settled.map(({ id }) => id)).toEqual([face.id, tool.id]);
      expect(settled[0]).toMatchObject(
        kind === "message"
          ? { body: "The authoritative text." }
          : { state: "done", text: "The authoritative text." },
      );
      expect(settled[0]).not.toHaveProperty("streaming", true);
      expect(settled[1]).toBe(draft[1]);
      f.stream.receive({ ...address, afterSequence: "2", update: { operation: "close" } });
      f.stream.receive({
        ...address,
        update: {
          operation: "replace",
          text: "stale",
          offset: 0,
          totalLength: 5,
          incomplete: false,
        },
      });
      expect(f.detail.text.get(face.id)).toBeUndefined();
    } finally {
      reader.dispose();
    }
  },
);

test("keeps the latest publication and distinct place markers across overlapping pages", () => {
  const f = fixture();
  const { messageId: _messageId, ...base } = item;
  const appId = AppIdSchema.parse("app_11111111-1111-4111-8111-111111111111");
  const publication = {
    ...base,
    kind: "app" as const,
    id: `app:${appId}`,
    appId,
    position: "4",
    view: { title: "Budget 3" },
  };
  const middle = {
    ...base,
    kind: "place" as const,
    id: "place:middle",
    position: "2",
    place: {
      tabId: TabSchema.shape.tabId.parse("page"),
      title: "Between publications",
      site: null,
    },
  };
  const revisited = { ...middle, id: "place:revisited", position: "3" };
  f.syncShell();
  f.stream.receive(f.detailSnapshot([revisited, publication]));
  f.stream.receive({ ...f.address, type: "host.synchronized", throughSequence: "1" });
  const page = {
    kind: "page" as const,
    threadId,
    nodeId: null,
    items: [
      { ...publication, revision: "0", position: "1", view: { title: "Budget 1" } },
      middle,
      revisited,
    ],
    revision: "1",
    orderRevision: "1",
    hasMore: false,
    nextBefore: null,
  };
  const { generation } = f.detail.transcript.getSnapshot();
  f.detail.transcript.installPage(page, generation, "earlier");
  f.detail.transcript.installPage(page, generation, "earlier");
  const state = f.detail.transcript.getSnapshot();
  expect(state.ids).toEqual([middle.id, revisited.id, publication.id]);
  expect(state.items.get(publication.id)).toEqual(publication);
  expect(state.items.get(revisited.id)).toEqual(revisited);
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

test("pages a node across a missed window and ignores a released holder's earlier read", async () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  const scope = { kind: "node", threadId, nodeId } as const;
  const release = f.stream.observe(scope);
  const subscription = f.sent.at(-1);
  if (subscription?.type !== "client.subscribe" || subscription.scope.kind !== "node")
    throw new Error("Missing node subscription");
  const address = {
    scope,
    subscriptionId: subscription.subscriptionId,
    generation: subscription.generation,
  };
  const { messageId: _messageId, ...base } = item;
  const lines = Array.from({ length: 107 }, (_, index) => ({
    ...base,
    kind: "node-message" as const,
    id: `line:${index + 1}`,
    position: String(index + 1),
    nodeId,
    view: { preview: `Message ${index + 1}` },
  }));
  const boundary = (row: (typeof lines)[number]) => ({
    ...cursor,
    nodeId,
    beforeId: row.id,
    beforePosition: row.position,
  });
  f.stream.receive({
    ...f.detailSnapshot([lines.at(-1)!]),
    ...address,
    snapshot: {
      ...f.detailSnapshot([lines.at(-1)!]).snapshot,
      nextBefore: boundary(lines.at(-1)!),
    },
  });
  f.stream.receive({ ...address, type: "host.synchronized", throughSequence: "1" });
  type Rpc = import("@opensteer/protocol").HostApiClient;
  const held = Promise.withResolvers<Awaited<ReturnType<Rpc["node.items.page"]>>>();
  const page = (from: number, end: number): Awaited<ReturnType<Rpc["node.items.page"]>> => ({
    ok: true,
    data: {
      kind: "page",
      threadId,
      nodeId,
      revision: "1",
      orderRevision: "1",
      items: lines.slice(from, end),
      hasMore: from !== 0,
      nextBefore: from === 0 ? null : boundary(lines[from]!),
    },
  });
  const read = vi
    .fn<Rpc["node.items.page"]>()
    .mockReturnValueOnce(held.promise)
    .mockResolvedValueOnce(page(6, 106))
    .mockResolvedValueOnce(page(0, 6));
  const detail = f.stream.detail(scope);
  const rpc = { "node.items.page": read } as unknown as Rpc;
  const previous = new ScopedThreadReader(detail, rpc, new TranscriptBodies(), false);
  const current = new ScopedThreadReader(detail, rpc, new TranscriptBodies(), false);
  try {
    const pending = previous.history("earlier");
    previous.dispose();
    held.resolve(page(6, 106));
    await pending;
    expect(detail.transcript.getSnapshot().ids).toEqual([lines.at(-1)!.id]);
    await current.history("earlier");
    expect(detail.transcript.getSnapshot().snapshot?.nextBefore).toEqual(boundary(lines[6]!));
    await current.history("earlier");
    const state = detail.transcript.getSnapshot();
    expect(state.snapshot?.nextBefore).toBeNull();
    expect(state.ids.map((id) => nodeTranscriptCard(state.items.get(id)!))).toEqual(
      lines.map((row) => expect.objectContaining({ id: row.id, text: row.view.preview })),
    );
    expect(read.mock.calls.map(([request]) => request.nodeId)).toEqual([nodeId, nodeId, nodeId]);
  } finally {
    previous.dispose();
    current.dispose();
    release();
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

test("rejects a valid changes object padded past its encoded frame cap", () => {
  const stream = new ScopedPersonalStream();
  const frame = JSON.stringify({
    type: "host.changes",
    scope: threadScope,
    subscriptionId: "detail:0",
    generation: 1,
    fromSequence: "1",
    throughSequence: "2",
    changes: [],
  });
  const padded = frame.padEnd(personalChangesFrameMaxBytes + 1);
  expect(stream.receive(JSON.parse(frame), frame.length)).toBe(true);
  expect(stream.receive(JSON.parse(frame), personalChangesFrameMaxBytes)).toBe(true);
  expect(() => stream.receive(JSON.parse(padded), padded.length)).toThrow(/encoded limit/);
});
