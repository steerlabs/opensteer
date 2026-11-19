import { createId } from "@opensteer/core";
import { afterEach, expect, test, vi } from "vitest";
import {
  personalAuthorityChangedReason,
  type ScopedClientMessage,
} from "@opensteer/protocol/personal-sync";
import type { TranscriptItem, TranscriptOrderCursor } from "@opensteer/protocol/transcript";
import { MockPersonalSocket } from "../mock/mock-personal-host.js";
import { HttpHostClient } from "./host-session-client.js";
import {
  createPersonalStreamCache,
  personalCacheFormat,
  type PersonalStreamCache,
  type PersonalStreamCheckpoint,
} from "./personal-stream-cache.js";
import { ScopedPersonalStream, type PersonalResourcePort } from "./scoped-personal-stream.js";
import { memoryCheckpointStorage } from "../test-support/memory-checkpoint-storage.js";
import { detailThread } from "../test-support/scoped-transcript-fixture.js";

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
  doneReason: null,
  pendingRequestCount: 0,
  lastReplyPreview: null,
  failurePreview: null,
  latestRunCompletedAt: null,
  environmentId: createId("environment"),
  harnessInstanceId: createId("harnessInstance"),
  runQueued: false,
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
const counts = { pendingRequestCount: 0, needsYouCount: 0, unreadTaskCount: 0 };
const shellLists = {
  activeTaskIds: [],
  activeNextBefore: null,
  recentTaskIds: [],
  nextBefore: null,
  taskCounts: { active: 0, open: 0 },
  attentionHasMore: false,
};
const cursor: TranscriptOrderCursor = {
  deploymentId,
  viewerId,
  epoch,
  threadId,
  nodeId: null,
  beforeId: item.id,
  beforePosition: item.position,
};

function fixture(cache?: PersonalStreamCache, resources?: PersonalResourcePort) {
  const stream = new ScopedPersonalStream(cache, resources);
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
      session,
      tasks: [task],
      visits: [],
      attention: [],
      counts,
      ...shellLists,
    },
  });
  const detailSnapshot = (items: TranscriptItem[] = [item]) => ({
    ...address,
    type: "host.snapshot" as const,
    throughSequence: "1",
    snapshot: {
      thread: detailThread(task),
      items,
      activeItems: [],
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

test("fences a pending write at generation replacement and checkpoints installed removals with the cursor", async () => {
  const commits: PersonalStreamCheckpoint[] = [];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let pause = true;
  const f = fixture({
    ...createPersonalStreamCache(memoryCheckpointStorage()),
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
  f.stream.flushCheckpoints();
  await entered.promise;
  try {
    // A frame that skips part of the feed makes the client start the scope over.
    f.stream.receive({
      ...f.address,
      type: "host.changes",
      fromSequence: "4",
      throughSequence: "5",
      changes: [],
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
  f.stream.flushCheckpoints();
  await vi.waitFor(() => expect(commits.filter(({ kind }) => kind === "detail")).toHaveLength(1));
  expect(commits.at(-1)).toMatchObject({ cursor: { afterSequence: "2" }, state: { items: [] } });
});

async function savedCache() {
  const storage = memoryCheckpointStorage();
  const cache = createPersonalStreamCache(storage);
  const f = fixture(cache);
  f.syncShell();
  f.syncDetail();
  f.stream.flushCheckpoints();
  await vi.waitFor(() => expect(storage.values.size).toBe(2));
  return { storage, cache };
}

function warmClient(
  cache: PersonalStreamCache,
  reply: (
    socket: MockPersonalSocket,
    attach: Extract<ScopedClientMessage, { type: "client.attach" }>,
  ) => void,
) {
  const reads: string[] = [];
  const order: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    reads.push(String(input));
    order.push("http");
    return Response.json(
      { ok: false, error: { code: "not_found", message: "Unavailable", retryable: false } },
      { status: 404 },
    );
  });
  let socket: MockPersonalSocket;
  const connect = vi.fn(() => {
    order.push("socket");
    return (socket = new MockPersonalSocket((raw) => {
      const message = JSON.parse(raw) as ScopedClientMessage;
      if (message.type === "client.attach") reply(socket, message);
    }));
  });
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    streamCache: cache,
    fetch,
    webSocketFactory: connect,
    capabilities: [],
  });
  return { client, connect, order, reads, socket: () => socket };
}

test("a warm start opens the socket with no HTTP read first and paints the saved cut once the attach reply resumes it", async () => {
  const { cache } = await savedCache();
  const painted: (readonly string[] | undefined)[] = [];
  let attach: Extract<ScopedClientMessage, { type: "client.attach" }> | undefined;
  const warm = warmClient(cache, (socket, message) => {
    attach = message;
    painted.push(warm.client.getSnapshot().tasks?.entries.map(({ thread }) => thread.id));
    const shell = {
      subscriptionId: "shell" as const,
      scope: shellScope,
      generation: message.generation,
    };
    queueMicrotask(() => {
      socket.deliver({ ...shell, type: "host.synchronized", throughSequence: "1" });
      const selected = message.selected!;
      socket.deliver({
        subscriptionId: selected.subscriptionId,
        scope: selected.scope,
        generation: selected.generation,
        type: "host.synchronized",
        throughSequence: "1",
      });
    });
  });
  try {
    warm.client.activateThread(threadId);
    await warm.client.load();
    expect(warm.order[0]).toBe("socket");
    expect(attach?.cursor?.afterSequence).toBe("1");
    expect(attach?.expectedSessionId).toBe(session.sessionId);
    expect(attach?.selected?.cursor?.afterSequence).toBe("1");
    // Nothing saved was shown before the Host answered the attach.
    expect(painted).toEqual([undefined]);
    expect(warm.client.getSnapshot().connection).toBe("connected");
    expect(warm.client.getSnapshot().user?.id).toBe(viewerId);
    expect(warm.client.getSnapshot().tasks?.entries.map(({ thread }) => thread.id)).toEqual([
      threadId,
    ]);
    expect(warm.client.getThreadTranscript(threadId)?.getSnapshot().entries).toHaveLength(1);
  } finally {
    warm.client.dispose();
  }
});

test("a saved cut for another session is discarded on attach and never shown", async () => {
  const { cache, storage } = await savedCache();
  const otherViewer = createId("user");
  const otherTask = { ...task, id: createId("thread") };
  const seen = new Set<string>();
  const warm = warmClient(cache, (socket, message) => {
    const address = {
      subscriptionId: "shell" as const,
      scope: shellScope,
      generation: message.generation,
    };
    queueMicrotask(() => {
      socket.deliver({
        ...address,
        type: "host.snapshot",
        throughSequence: "7",
        snapshot: {
          deploymentId,
          viewerId: otherViewer,
          epoch,
          session: {
            ...session,
            sessionId: createId("authSession"),
            user: { ...session.user, id: otherViewer },
          },
          tasks: [otherTask],
          visits: [],
          attention: [],
          counts,
          ...shellLists,
          recentTaskIds: [otherTask.id],
        },
      });
      socket.deliver({ ...address, type: "host.synchronized", throughSequence: "7" });
    });
  });
  const stop = warm.client.subscribe(() => {
    for (const entry of warm.client.getSnapshot().tasks?.entries ?? []) seen.add(entry.thread.id);
  });
  try {
    await warm.client.load();
    expect(warm.client.getSnapshot().user?.id).toBe(otherViewer);
    expect([...seen]).toEqual([otherTask.id]);
    await vi.waitFor(() => expect(storage.values.size).toBe(0));
  } finally {
    stop();
    warm.client.dispose();
  }
});

test("a saved cut whose epoch the attach reply does not confirm is never shown, and a read after logout is ignored", async () => {
  const { cache, storage } = await savedCache();
  const fresh = new ScopedPersonalStream(cache);
  fresh.select(threadScope);
  await fresh.restore();
  const sent: ScopedClientMessage[] = [];
  fresh.attach((frame) => sent.push(frame));
  const attach = sent[0] as Extract<ScopedClientMessage, { type: "client.attach" }>;
  expect(attach.cursor?.afterSequence).toBe("1");
  expect(fresh.shell.getSnapshot().snapshot).toBeNull();
  expect(fresh.detail(threadScope).transcript.getSnapshot().items.size).toBe(0);
  const shell = {
    scope: shellScope,
    subscriptionId: "shell" as const,
    generation: attach.generation,
  };
  const replaced = crypto.randomUUID();
  fresh.receive({
    ...shell,
    type: "host.snapshot",
    throughSequence: "1",
    snapshot: {
      deploymentId,
      viewerId,
      epoch: replaced,
      session,
      tasks: [],
      visits: [],
      attention: [],
      counts,
      ...shellLists,
    },
  });
  fresh.receive({ ...shell, type: "host.synchronized", throughSequence: "1" });
  expect(fresh.shell.getSnapshot().snapshot).toMatchObject({ epoch: replaced, tasks: [] });
  expect(fresh.detail(threadScope).transcript.getSnapshot().items.size).toBe(0);
  await vi.waitFor(() => expect(storage.values.size).toBe(0));

  const again = await savedCache();
  const gate = Promise.withResolvers<void>();
  const next = new ScopedPersonalStream({
    ...again.cache,
    latestShell: async (id) => {
      await gate.promise;
      return again.cache.latestShell(id);
    },
  });
  const reading = next.restore();
  next.clear(true);
  gate.resolve();
  await reading;
  const after: ScopedClientMessage[] = [];
  next.attach((frame) => after.push(frame));
  expect(
    (after[0] as Extract<ScopedClientMessage, { type: "client.attach" }>).cursor,
  ).toBeUndefined();
});

test("replays a full saved history window with updated and removed active overlays", async () => {
  const storage = memoryCheckpointStorage();
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
  f.stream.flushCheckpoints();
  await vi.waitFor(() =>
    expect(
      [...storage.values.values()].some(({ value }) => value.includes('"afterSequence":"2"')),
    ).toBe(true),
  );
  const fresh = new ScopedPersonalStream(createPersonalStreamCache(storage));
  fresh.select(threadScope);
  await fresh.restore();
  const sent: ScopedClientMessage[] = [];
  fresh.attach((message) => sent.push(message));
  const attach = sent[0] as Extract<ScopedClientMessage, { type: "client.attach" }>;
  expect(attach.selected?.cursor?.afterSequence).toBe("2");
  fresh.receive({
    scope: shellScope,
    subscriptionId: "shell",
    generation: attach.generation,
    type: "host.synchronized",
    throughSequence: "1",
  });
  // The saved cut stays unpublished until the Host answers on its own subscription.
  expect(fresh.detail(threadScope).transcript.getSnapshot().items.size).toBe(0);
  const selected = attach.selected!;
  fresh.receive({
    scope: selected.scope,
    subscriptionId: selected.subscriptionId,
    generation: selected.generation,
    type: "host.synchronized",
    throughSequence: "2",
  });
  expect(fresh.detail(threadScope).transcript.getSnapshot().items.size).toBe(51);
  expect(fresh.detail(threadScope).transcript.getSnapshot().items.get(active.id)?.revision).toBe(
    "2",
  );
  expect(fresh.detail(threadScope).transcript.getSnapshot().items.has(other.id)).toBe(false);
});

test("a named socket close purges its task and resumes the unaffected scope", async () => {
  const other = { kind: "thread" as const, threadId: createId("thread") };
  const saved = new Map<string, PersonalStreamCheckpoint>();
  const base = createPersonalStreamCache(memoryCheckpointStorage());
  const cache: PersonalStreamCache = {
    ...base,
    commit: async (checkpoint, current, fence) => {
      await base.commit(checkpoint, current, fence);
      if (current()) saved.set(checkpoint.scope.scopeKey, checkpoint);
    },
    removeThread: async (identity, id) => {
      await base.removeThread(identity, id);
      saved.delete(`thread:${id}`);
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
              thread: detailThread({ ...task, id: scope.threadId }),
              items: [item],
              activeItems: [],
              pendingRequests: [],
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
              ...shellLists,
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
    client.flushSavedState();
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
    expect(
      await cache.load({
        deploymentId,
        viewerId,
        epoch,
        format: personalCacheFormat,
        scopeKey: `thread:${other.threadId}`,
      }),
    ).toBeNull();
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

test("a burst of durable frames writes one checkpoint, for the changed scope only, after 2 s", async () => {
  vi.useFakeTimers();
  const storage = memoryCheckpointStorage();
  const writes: string[] = [];
  const write = storage.write;
  storage.write = async (key, value, guard) => {
    writes.push(JSON.parse(key)[4] as string);
    return write(key, value, guard);
  };
  const f = fixture(createPersonalStreamCache(storage));
  f.syncShell();
  f.syncDetail();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(writes.sort()).toEqual(["shell", `thread:${threadId}`]);
  writes.length = 0;
  for (let sequence = 2; sequence <= 21; sequence++)
    f.stream.receive({
      ...f.address,
      type: "host.changes",
      fromSequence: String(sequence - 1),
      throughSequence: String(sequence),
      changes: [
        {
          sequence: String(sequence),
          ordinal: 0,
          entityKind: "item",
          entityId: item.id,
          operation: "upsert",
          value: { ...item, revision: String(sequence) },
        },
      ],
    });
  await vi.advanceTimersByTimeAsync(1_999);
  expect(writes).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(writes).toEqual([`thread:${threadId}`]);
  const saved = await createPersonalStreamCache(storage).load({
    deploymentId,
    viewerId,
    epoch,
    scopeKey: `thread:${threadId}`,
    format: personalCacheFormat,
  });
  expect(saved?.cursor.afterSequence).toBe("21");
  // Going to the background writes what changed at once.
  f.stream.receive({
    ...f.address,
    type: "host.changes",
    fromSequence: "21",
    throughSequence: "22",
    changes: [],
  });
  f.stream.setBackground(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(writes).toEqual([`thread:${threadId}`, `thread:${threadId}`]);
});

test("a task observed after the socket opened paints its saved cut and resumes from it", async () => {
  const { cache } = await savedCache();
  const stream = new ScopedPersonalStream(cache);
  const sent: ScopedClientMessage[] = [];
  stream.attach((frame) => sent.push(frame));
  const attach = sent[0] as Extract<ScopedClientMessage, { type: "client.attach" }>;
  const shell = {
    scope: shellScope,
    subscriptionId: "shell" as const,
    generation: attach.generation,
  };
  stream.receive({
    ...shell,
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
      ...shellLists,
    },
  });
  stream.receive({ ...shell, type: "host.synchronized", throughSequence: "1" });
  sent.length = 0;
  const release = stream.observe(threadScope);
  // The saved cut is read before the subscription, so it can carry a cursor.
  expect(sent).toEqual([]);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toMatchObject({ type: "client.subscribe", cursor: { afterSequence: "1" } });
  expect(stream.detail(threadScope).transcript.getSnapshot().items.has(item.id)).toBe(true);
  release();
});

function attachedWith(
  cache: PersonalStreamCache,
  tasks: readonly (typeof task)[],
): {
  stream: ScopedPersonalStream;
  sent: ScopedClientMessage[];
  shell: { scope: typeof shellScope; subscriptionId: "shell"; generation: number };
} {
  const stream = new ScopedPersonalStream(cache);
  const sent: ScopedClientMessage[] = [];
  stream.attach((frame) => sent.push(frame));
  const attach = sent[0] as Extract<ScopedClientMessage, { type: "client.attach" }>;
  const shell = {
    scope: shellScope,
    subscriptionId: "shell" as const,
    generation: attach.generation,
  };
  stream.receive({
    ...shell,
    type: "host.snapshot",
    throughSequence: "1",
    snapshot: {
      deploymentId,
      viewerId,
      epoch,
      session,
      tasks: [...tasks],
      visits: [],
      attention: [],
      counts,
      ...shellLists,
    },
  });
  stream.receive({ ...shell, type: "host.synchronized", throughSequence: "1" });
  sent.length = 0;
  return { stream, sent, shell };
}

test("a saved task the shell does not list is never shown before the Host answers, and a removal drops it", async () => {
  const { cache, storage } = await savedCache();
  // The task was purged while this device was away: the shell no longer lists it.
  const { stream, sent } = attachedWith(cache, []);
  const shown: number[] = [];
  const detail = stream.detail(threadScope);
  detail.transcript.subscribe(() => shown.push(detail.transcript.getSnapshot().items.size));
  stream.observe(threadScope);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  const subscribe = sent[0] as Extract<ScopedClientMessage, { type: "client.subscribe" }>;
  // The saved cut still supplies the resume cursor, but nothing from it is published.
  expect(subscribe.cursor?.afterSequence).toBe("1");
  expect(detail.transcript.getSnapshot().items.size).toBe(0);
  stream.receive({
    scope: subscribe.scope,
    subscriptionId: subscribe.subscriptionId,
    generation: subscribe.generation,
    type: "host.removed",
    reason: "unavailable",
  });
  stream.flushCheckpoints();
  expect(shown.every((size) => size === 0)).toBe(true);
  await vi.waitFor(() =>
    expect([...storage.values.keys()].some((key) => key.includes(`thread:${threadId}`))).toBe(
      false,
    ),
  );
});

test("a task the shell removes takes its saved cut with it, from memory and disk", async () => {
  const { cache, storage } = await savedCache();
  const { stream, shell } = attachedWith(cache, [task]);
  const release = stream.observe(threadScope);
  await vi.waitFor(() =>
    expect(stream.detail(threadScope).transcript.getSnapshot().items.size).toBe(1),
  );
  release();
  stream.receive({
    ...shell,
    type: "host.changes",
    fromSequence: "1",
    throughSequence: "2",
    changes: [
      { entityKind: "task", entityId: threadId, operation: "remove", sequence: "2", ordinal: 0 },
    ],
  });
  expect(stream.peekDetail(threadScope)?.transcript.getSnapshot().items.size ?? 0).toBe(0);
  await vi.waitFor(() =>
    expect([...storage.values.keys()].some((key) => key.includes(`thread:${threadId}`))).toBe(
      false,
    ),
  );
});

test("a refusal before any viewer is known still clears that Deployment's saved state", async () => {
  const { cache, storage } = await savedCache();
  const stream = new ScopedPersonalStream(cache, undefined, deploymentId);
  stream.clear(true);
  await vi.waitFor(() => expect(storage.values.size).toBe(0));
  expect(await new ScopedPersonalStream(cache, undefined, deploymentId).restore()).toBeUndefined();
});

test("stalled saved-state storage never holds the attach", async () => {
  const { cache } = await savedCache();
  const late = Promise.withResolvers<void>();
  const stalled: PersonalStreamCache = {
    ...cache,
    latestShell: async (id) => {
      await late.promise;
      return cache.latestShell(id);
    },
  };
  let attach: Extract<ScopedClientMessage, { type: "client.attach" }> | undefined;
  const warm = warmClient(stalled, (_socket, message) => {
    attach = message;
  });
  try {
    void warm.client.load();
    await vi.waitFor(() => expect(attach).toBeDefined(), { timeout: 1_000 });
    expect(attach?.cursor).toBeUndefined();
  } finally {
    late.resolve();
    warm.client.dispose();
  }
});
