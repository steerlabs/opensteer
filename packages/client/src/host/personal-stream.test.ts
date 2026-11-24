import { AppIdSchema, createId, SequenceSchema, TabSchema } from "@opensteer/core";
import { afterEach, describe, expect, it, test, vi } from "vitest";
import {
  personalChangesFrameMaxBytes,
  type ScopedClientMessage,
} from "@opensteer/protocol/personal-sync";
import type { PersonalResourceRevisions } from "@opensteer/protocol/resources";
import type { TranscriptItem, TranscriptOrderCursor } from "@opensteer/protocol/transcript";
import { MockPersonalHost, MockPersonalSocket } from "../mock/mock-personal-host.js";
import { MockHostClient } from "../mock/mock-host-client.js";
import { HttpHostClient } from "./host-session-client.js";
import type { ClientLifecycle } from "./lifecycle.js";
import type { PersonalStreamCache } from "./personal-stream-cache.js";
import { ScopedPersonalStream, type PersonalResourcePort } from "./scoped-personal-stream.js";
import { ScopedThreadReader, TranscriptBodies } from "./scoped-thread-reader.js";
import { nodeTranscriptCard } from "./transcript-item-view.js";
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
const counts = {
  pendingRequestCount: 0,
  pendingRequestsRevision: "0",
  needsYouCount: 0,
  unreadTaskCount: 0,
};
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

test("buffers selected detail until shell authority is synchronized and rejects oversized or misaddressed frames", () => {
  const f = fixture();
  f.syncDetail();
  expect(f.detail.transcript.getSnapshot().items.size).toBe(0);
  expect(f.sent.some((frame) => frame.type === "client.ack")).toBe(false);
  expect(f.stream.receive({ ...f.detailSnapshot(), subscriptionId: "shell" })).toBe(false);
  expect(f.stream.receive(f.detailSnapshot([{ ...item, nodeId }]))).toBe(false);
  const big = Array.from({ length: 10 }, (_, index) => ({
    ...item,
    id: String(index),
    text: "a".repeat(120 * 1024),
  }));
  const oversized = f.detailSnapshot(big);
  // The Host measures encoded frames; the client checks the bytes it received.
  expect(() =>
    f.stream.receive(oversized, new TextEncoder().encode(JSON.stringify(oversized)).length),
  ).toThrow("exceeds its encoded limit");
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
      snapshot: { ...ahead.snapshot, thread: { ...detailThread(task), revision: "2" } },
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
          value: { ...detailThread(task), title: "Renamed", revision: "2" },
        },
        {
          entityKind: "run-queue",
          entityId: threadId,
          ordinal: 1,
          sequence: "2",
          operation: "upsert",
          value: { revision: "2", paused: true, runs: [], steerRunId: null, inputs: [] },
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

test("restores resource watches on shell repair and ignores revisions for an old generation", () => {
  const changed: PersonalResourceRevisions[] = [];
  const f = fixture(undefined, {
    interests: () => ({ interests: ["machine"], installed: { machine: "2" } }),
    changed: (revisions) => changed.push(revisions),
  });
  expect(f.sent[0]).toMatchObject({ interests: ["machine"], installed: { machine: "2" } });
  f.syncShell();
  const frame = { type: "host.resource", subscriptionId: "shell" } as const;
  f.stream.receive({ ...frame, generation: f.shell.generation, revisions: { machine: "3" } });
  expect(changed).toEqual([{ machine: "3" }]);
  // A frame that does not follow the held cut resubscribes the shell and restates the watch.
  f.stream.receive({
    ...f.shell,
    type: "host.changes",
    fromSequence: "2",
    throughSequence: "3",
    changes: [],
  });
  const watch = f.sent.at(-1) as Extract<ScopedClientMessage, { type: "client.resources.watch" }>;
  expect(watch).toMatchObject({
    type: "client.resources.watch",
    interests: ["machine"],
    installed: { machine: "2" },
  });
  expect(watch.generation).toBeGreaterThan(f.shell.generation);
  f.stream.receive({ ...frame, generation: f.shell.generation, revisions: { machine: "4" } });
  expect(changed).toEqual([{ machine: "3" }]);
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

test("drops an item read overtaken by a durable removal", async () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  const point = Promise.withResolvers<unknown>();
  const rpc = {
    "transcript.item.get": vi.fn(() => point.promise),
  } as unknown as import("@opensteer/protocol").HostApiClient;
  const reader = new ScopedThreadReader(f.detail, rpc, new TranscriptBodies());
  const read = reader.body(item.id);
  f.stream.receive({
    ...f.address,
    type: "host.changes",
    fromSequence: "1",
    throughSequence: "2",
    changes: [
      { entityKind: "item", entityId: item.id, operation: "remove", sequence: "2", ordinal: 0 },
    ],
  });
  point.resolve({
    ok: true,
    data: { item, body: { kind: "text", text: "gone" }, truncated: false },
  });
  expect(await read).toBeUndefined();
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
    { threadId, review: [{ id: requestId, revision: "2" }], deviceAccessRequests: "include" },
    expect.anything(),
  );
  earlier.resolve(result("first", "2"));
  await vi.waitFor(() => expect(reader.getSnapshot().requests[0]?.callId).toBe("first"));

  expect(change("2", "3")).toBe(true);
  expect(reader.getSnapshot().requests).toEqual([]);
  expect(readRequests).toHaveBeenNthCalledWith(
    2,
    { threadId, review: [{ id: requestId, revision: "3" }], deviceAccessRequests: "include" },
    expect.anything(),
  );
  later.resolve(result("updated", "3"));
  await vi.waitFor(() => expect(reader.getSnapshot().requests[0]?.callId).toBe("updated"));
  reader.dispose();
});

test("a failed Request read tries again while the Request stays pending, and stops with the scope", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  const readRequests = vi
    .fn()
    // The RPC client answers a lost connection, as any failure, with a result.
    .mockResolvedValueOnce({
      ok: false,
      error: { code: "unavailable", message: "Connection lost", retryable: true },
    })
    .mockResolvedValueOnce({
      ok: false,
      error: { code: "internal", message: "Busy", retryable: true },
    })
    .mockResolvedValue({
      ok: true,
      data: {
        threadId,
        reviewedRevisions: { [requestId]: "2" },
        requests: [{ id: requestId, originatingThreadId: threadId, status: "pending" }],
      },
    });
  const rpc = {
    "thread.requests.list": readRequests,
  } as unknown as import("@opensteer/protocol").HostApiClient;
  const reader = new ScopedThreadReader(f.detail, rpc, new TranscriptBodies());
  f.stream.receive({
    ...f.address,
    type: "host.changes",
    fromSequence: "1",
    throughSequence: "2",
    changes: [
      {
        entityKind: "request",
        entityId: requestId,
        ordinal: 0,
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
    ],
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(reader.getSnapshot().requests).toEqual([]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(readRequests).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(readRequests).toHaveBeenCalledTimes(3);
  expect(reader.getSnapshot().requests.map(({ id }) => id)).toEqual([requestId]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(readRequests).toHaveBeenCalledTimes(3);
  reader.dispose();
  expect(vi.getTimerCount()).toBe(0);
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
    hasMore: false,
    nextBefore: null,
  };
  const read = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, data: { kind: "history-reset" } })
    .mockResolvedValueOnce({ ok: true, data: { ...page, items: [] } })
    .mockResolvedValueOnce({ ok: true, data: { kind: "history-reset" } })
    .mockResolvedValueOnce({ ok: true, data: { ...page, items: [moved] } });
  const rpc = {
    "thread.items.page": read,
    "thread.inputQueue.get": vi.fn().mockResolvedValue({
      ok: true,
      data: { threadId, revision: "2", items: [], paused: false, steerRunId: null },
    }),
  } as unknown as import("@opensteer/protocol").HostApiClient;
  const reader = new ScopedThreadReader(f.detail, rpc, new TranscriptBodies());
  f.detail.anchorTo(item.id);
  await expect(reader.history("earlier")).rejects.toThrow("history anchor");
  const installed = f.detail.transcript.getSnapshot().items.get(item.id);
  await reader.history("earlier");
  expect(read).toHaveBeenLastCalledWith({ threadId, anchorItemId: item.id }, expect.anything());
  expect(f.detail.transcript.getSnapshot().items.get(item.id)).toBe(installed);
  reader.dispose();
});

test("the scope's anchor follows the reader: set by a jump, cleared on return to latest", async () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  const old = { ...item, id: "old", messageId: createId("message"), position: "0" };
  const page = (items: TranscriptItem[], newest: boolean) => ({
    ok: true,
    data: {
      kind: "page",
      threadId,
      nodeId: null,
      revision: "1",
      hasMore: false,
      nextBefore: null,
      nextAfter: newest ? null : { ...cursor, beforeId: items.at(-1)!.id, beforePosition: "0" },
      items,
    },
  });
  const read = vi
    .fn()
    .mockResolvedValueOnce(page([old], false))
    .mockResolvedValueOnce(page([item], true));
  const reader = new ScopedThreadReader(
    f.detail,
    { "thread.items.page": read } as unknown as import("@opensteer/protocol").HostApiClient,
    new TranscriptBodies(),
  );
  const resubscribe = () => {
    f.stream.setBackground(true);
    f.stream.setBackground(false);
    return f.sent.at(-1) as Extract<ScopedClientMessage, { type: "client.subscribe" }>;
  };
  const anchors = () =>
    f.sent.flatMap((frame) =>
      frame.type === "client.anchor" ? [frame.anchorItemId ?? "latest"] : [],
    );
  await reader.history("around", old.messageId);
  expect(f.detail.anchor).toBe(old.id);
  await reader.history("latest");
  expect(f.detail.anchor).toBeUndefined();
  // The open subscription heard each move, so a repair centres where the reader is.
  expect(anchors()).toEqual([old.messageId, old.id, "latest"]);
  expect(resubscribe().anchorItemId).toBeUndefined();
  reader.dispose();
});

test("scrolling tells nobody; a jump is told at once, and paging keeps the reader's row", async () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  const earlier = { ...item, id: "earlier", messageId: createId("message"), position: "0" };
  const linked = { ...item, id: "linked", messageId: createId("message"), position: "0" };
  const page = (items: TranscriptItem[]) => ({
    ok: true,
    data: {
      kind: "page",
      threadId,
      nodeId: null,
      revision: "1",
      hasMore: false,
      nextBefore: null,
      nextAfter: null,
      items,
    },
  });
  const read = vi
    .fn()
    .mockResolvedValueOnce(page([earlier]))
    .mockResolvedValueOnce(page([linked, item]));
  const reader = new ScopedThreadReader(
    f.detail,
    { "thread.items.page": read } as unknown as import("@opensteer/protocol").HostApiClient,
    new TranscriptBodies(),
  );
  const anchors = () =>
    f.sent.flatMap((frame) =>
      frame.type === "client.anchor" ? [frame.anchorItemId ?? "latest"] : [],
    );
  // The view can be asked where the reader is; it is never told so as they scroll.
  let inView: string | undefined = earlier.id;
  reader.setMeasure(() => inView);
  await reader.history("earlier");
  expect(anchors()).toEqual([]);
  // A jump is the reader's move: the Host hears its target at once, then the row it landed on.
  await reader.history("around", linked.messageId);
  expect(anchors()).toEqual([linked.messageId, linked.id]);
  // Once the view has revealed the jump, a repair measures the row in view and centres there.
  reader.revealed();
  inView = linked.id;
  const repair = f.detailSnapshot();
  f.stream.receive({ ...repair, snapshot: { ...repair.snapshot, anchorItemId: linked.id } });
  expect(f.detail.anchor).toBe(linked.id);
  expect(reader.getSnapshot().repairs).toBe(1);
  reader.dispose();
});

test("a link opened while the scope resubscribes waits for its cut and lands, rather than reporting the message missing", async () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  const linked = { ...item, id: "linked", messageId: createId("message"), position: "0" };
  const read = vi.fn().mockResolvedValue({
    ok: true,
    data: {
      kind: "page",
      threadId,
      nodeId: null,
      revision: "1",
      hasMore: false,
      nextBefore: null,
      nextAfter: null,
      items: [linked, item],
    },
  });
  const reader = new ScopedThreadReader(
    f.detail,
    { "thread.items.page": read } as unknown as import("@opensteer/protocol").HostApiClient,
    new TranscriptBodies(),
  );
  f.stream.setBackground(true);
  const jump = reader.history("around", linked.messageId);
  f.stream.setBackground(false);
  const subscribe = f.sent.at(-1) as Extract<ScopedClientMessage, { type: "client.subscribe" }>;
  const address = {
    scope: subscribe.scope,
    subscriptionId: subscribe.subscriptionId,
    generation: subscribe.generation,
  };
  expect(read).not.toHaveBeenCalled();
  f.stream.receive({ ...f.detailSnapshot(), ...address });
  f.stream.receive({ ...address, type: "host.synchronized", throughSequence: "1" });
  await jump;
  expect(read).toHaveBeenCalledTimes(1);
  expect(f.detail.transcript.getSnapshot().items.has(linked.id)).toBe(true);
  expect(f.detail.anchor).toBe(linked.id);
  reader.dispose();
});

test("a live reset keeps only the streams it names: every other stream's text and held frame goes", () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  const attemptId = createId("runAttempt");
  const kept = { runId, streamId: "kept" };
  const dropped = { runId: createId("run"), streamId: "dropped" };
  const live = (stream: { runId: string; streamId: string }, itemId: string, after = "1") =>
    f.stream.receive({
      ...f.address,
      type: "host.live",
      handle: 1,
      liveBootId: "00000000-0000-4000-8000-000000000001",
      attemptId,
      bindingGeneration: 1,
      ...stream,
      itemId,
      afterSequence: after,
      update: { operation: "replace", text: "words", offset: 0, totalLength: 5, incomplete: false },
    } as never);
  live(kept, "node:a");
  live(dropped, "node:b");
  // A frame past the cut waits for it; its stream is not one the reset names.
  live({ runId: dropped.runId, streamId: "later" }, "node:c", "2");
  expect(f.detail.text.get("node:b")?.text).toBe("words");
  expect(f.stream.receive({ ...f.address, type: "host.live-reset", open: [kept] } as never)).toBe(
    true,
  );
  expect(f.detail.text.get("node:a")?.text).toBe("words");
  expect(f.detail.text.get("node:b")).toBeUndefined();
  f.stream.receive({
    ...f.address,
    type: "host.changes",
    fromSequence: "1",
    throughSequence: "2",
    changes: [],
  });
  expect(f.detail.text.get("node:c"), "a held frame of a closed stream applied").toBeUndefined();
});

test("a history page the store refused (its change journal overflowed) is read again, not reported done", async () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  const linked = { ...item, id: "linked", messageId: createId("message"), position: "0" };
  const answers: ((value: unknown) => void)[] = [];
  const read = vi.fn(() => new Promise((resolve) => answers.push(resolve)));
  const reader = new ScopedThreadReader(
    f.detail,
    { "thread.items.page": read } as unknown as import("@opensteer/protocol").HostApiClient,
    new TranscriptBodies(),
  );
  const page = {
    ok: true,
    data: {
      kind: "page",
      threadId,
      nodeId: null,
      revision: "1",
      hasMore: false,
      nextBefore: null,
      nextAfter: null,
      items: [linked, item],
    },
  };
  let settled = false;
  const jump = reader.history("around", linked.messageId).then(() => (settled = true));
  await vi.waitFor(() => expect(answers).toHaveLength(1));
  // More changes land while the page flies than the store keeps for it.
  for (let frame = 0; frame < 16; frame++) {
    const accepted = f.stream.receive({
      ...f.address,
      type: "host.changes",
      fromSequence: String(1 + frame),
      throughSequence: String(2 + frame),
      changes: Array.from({ length: 128 }, (_, index) => ({
        entityKind: "item",
        entityId: `busy:${frame}:${index}`,
        operation: "upsert",
        sequence: String(2 + frame),
        ordinal: index,
        value: {
          ...item,
          id: `busy:${frame}:${index}`,
          messageId: createId("message"),
          position: String(10 + frame * 128 + index),
        },
      })),
    } as never);
    expect(accepted).toBe(true);
  }
  answers[0]!(page);
  await vi.waitFor(() => expect(answers, "the refused page was never read again").toHaveLength(2));
  expect(settled).toBe(false);
  answers[1]!(page);
  await jump;
  expect(f.detail.transcript.getSnapshot().items.has(linked.id)).toBe(true);
  reader.dispose();
});

describe("the reader's intended position", () => {
  /** A synced detail and a reader whose page reads the test answers by hand, in any order. */
  function positioned() {
    const f = fixture();
    f.syncShell();
    f.syncDetail();
    const targets = Array.from({ length: 4 }, (_, index) => ({
      ...item,
      id: `target-${index}`,
      messageId: createId("message"),
      position: String(index - 10),
    }));
    // Each target's page holds only it and the latest row, so a page for one omits the others.
    const pending: {
      query: { aroundMessageId?: string; anchorItemId?: string };
      answer: () => void;
      fail: () => void;
    }[] = [];
    const read = vi.fn(
      (query: { aroundMessageId?: string; anchorItemId?: string }) =>
        new Promise((resolve, reject) => {
          const target = targets.find(
            ({ messageId, id }) => messageId === query.aroundMessageId || id === query.anchorItemId,
          );
          const items = target ? [target, item] : [item];
          pending.push({
            query,
            fail: () => reject(new TypeError("The connection was lost.")),
            answer: () =>
              resolve({
                ok: true,
                data: {
                  kind: "page",
                  threadId,
                  nodeId: null,
                  revision: "1",
                  hasMore: false,
                  nextBefore: null,
                  nextAfter: null,
                  items,
                },
              }),
          });
        }),
    );
    const reader = new ScopedThreadReader(
      f.detail,
      { "thread.items.page": read } as unknown as import("@opensteer/protocol").HostApiClient,
      new TranscriptBodies(),
    );
    const settle = async () => {
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    };
    return { f, targets, pending, reader, settle };
  }

  it("a jump overtaken by a newer one lands nothing and says so, so no route reports it missing", async () => {
    const { f, targets, pending, reader, settle } = positioned();
    const first = reader.history("around", targets[0]!.messageId);
    const second = reader.history("around", targets[1]!.messageId);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    // The older page answers first: it is for a move the reader no longer wants.
    pending[0]!.answer();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!.answer();
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    await settle();
    expect(f.detail.anchor).toBe(targets[1]!.id);
    expect(f.detail.transcript.getSnapshot().items.has(targets[0]!.id)).toBe(false);
    reader.dispose();
  });

  it("a jump whose read fails after the reader scrolled away reports nothing; one still current reports its failure", async () => {
    const { f, targets, pending, reader } = positioned();
    const jump = reader.history("around", targets[0]!.messageId);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    // A newer move (a link to another message) is asked for while the first read is out.
    const newer = reader.history("around", targets[2]!.messageId);
    pending[0]!.fail();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!.answer();
    await expect(newer).resolves.toBe(true);
    await expect(jump, "a superseded jump's failure reached its caller").resolves.toBe(false);
    expect(f.detail.anchor).toBe(targets[2]!.id);
    // A jump stays the reader's position through scrolling: nothing a scroll does supersedes it.
    const latest = reader.history("latest");
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    pending[2]!.answer();
    await expect(latest).resolves.toBe(true);
    expect(f.detail.anchor).toBeUndefined();
    // A failure of the move still current is the caller's to show.
    const current = reader.history("around", targets[3]!.messageId);
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    pending[3]!.fail();
    await expect(current).rejects.toThrow("connection was lost");
    reader.dispose();
  });

  it("a jump to a waiting message is a move: an older history jump answering after it lands nothing", async () => {
    const { f, targets, pending, reader } = positioned();
    const older = reader.history("around", targets[0]!.messageId);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    // The waiting message stands at the foot: the web jumps to it by returning to the latest.
    const waiting = reader.history("latest");
    // The older jump's page answers first; it is for a move the reader no longer wants.
    pending[0]!.answer();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!.answer();
    await expect(waiting).resolves.toBe(true);
    await expect(older, "the older jump spoke after the waiting-message jump").resolves.toBe(false);
    expect(f.detail.anchor).toBeUndefined();
    expect(f.detail.transcript.getSnapshot().items.has(targets[0]!.id)).toBe(false);
    reader.dispose();
  });

  it("a resubscription's first cut does not erase a jump made after it subscribed", async () => {
    const { f, targets, pending, reader } = positioned();
    f.stream.setBackground(true);
    f.stream.setBackground(false);
    const subscribe = f.sent.at(-1) as Extract<ScopedClientMessage, { type: "client.subscribe" }>;
    expect(subscribe.anchorItemId).toBeUndefined();
    // A link is opened while that cut is in flight.
    void reader.history("around", targets[2]!.messageId);
    const address = {
      scope: subscribe.scope,
      subscriptionId: subscribe.subscriptionId,
      generation: subscribe.generation,
    };
    const cut = f.detailSnapshot();
    f.stream.receive({ ...cut, ...address, snapshot: { ...cut.snapshot, anchorItemId: null } });
    expect(f.detail.anchor, "the cut erased the newer jump").toBe(targets[2]!.messageId);
    expect(pending).toHaveLength(0);
    reader.dispose();
  });

  it("a jump owns the position through scrolling and a repair: the repair centres on its target, and it lands", async () => {
    const { f, targets, pending, reader } = positioned();
    // The view, asked, would say the reader is on targets[1]; they scrolled there after linking.
    reader.setMeasure(() => targets[1]!.id);
    const jump = reader.history("around", targets[3]!.messageId);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const repair = f.detailSnapshot();
    f.stream.receive({ ...repair, snapshot: { ...repair.snapshot, anchorItemId: null } });
    expect(f.detail.anchor, "the repair took a measurement over the jump").toBe(
      targets[3]!.messageId,
    );
    // The page asked for before the repair is read again in the new cut, for the same jump.
    pending.shift()!.answer();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0]!.query.aroundMessageId).toBe(targets[3]!.messageId);
    pending.shift()!.answer();
    await expect(jump).resolves.toBe(true);
    expect(f.detail.anchor).toBe(targets[3]!.id);
    reader.dispose();
  });

  it("a jump read but not yet revealed keeps the position: a repair rereads its target, and only the reveal ends it", async () => {
    const { f, targets, pending, reader } = positioned();
    // The view, asked, would name the row the reader was on before the jump.
    reader.setMeasure(() => targets[0]!.id);
    const jump = reader.history("around", targets[3]!.messageId);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending.shift()!.answer();
    await expect(jump).resolves.toBe(true);
    // Before the view has scrolled to it, a repair prepared around the old place replaces the page.
    const repair = f.detailSnapshot();
    f.stream.receive({ ...repair, snapshot: { ...repair.snapshot, anchorItemId: null } });
    expect(f.detail.anchor, "the repair measured over the jump").toBe(targets[3]!.messageId);
    // The jump's target is read again, and installs, so the view can still reveal it.
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0]!.query.aroundMessageId).toBe(targets[3]!.messageId);
    pending.shift()!.answer();
    await vi.waitFor(() =>
      expect(f.detail.transcript.getSnapshot().items.has(targets[3]!.id)).toBe(true),
    );
    // The view reveals it: the move has landed, and the next repair measures again.
    reader.revealed();
    const later = f.detailSnapshot();
    f.stream.receive({ ...later, snapshot: { ...later.snapshot, anchorItemId: null } });
    expect(f.detail.anchor).toBe(targets[0]!.id);
    reader.dispose();
  });

  it("a view that cannot tell where the reader is (mid-layout) keeps the last place, not the latest", async () => {
    const { f, targets, reader } = positioned();
    f.detail.anchorTo(targets[1]!.id);
    reader.setMeasure(() => null);
    const repair = f.detailSnapshot();
    f.stream.receive({ ...repair, snapshot: { ...repair.snapshot, anchorItemId: null } });
    expect(f.detail.anchor, "a measurement that could not tell was taken for the latest").toBe(
      targets[1]!.id,
    );
    reader.dispose();
  });

  it("a repair with no jump under way rereads around the row in view, measured once at the repair", async () => {
    const { f, targets, pending, reader } = positioned();
    let measured = 0;
    reader.setMeasure(() => {
      measured++;
      return targets[1]!.id;
    });
    const repair = f.detailSnapshot();
    f.stream.receive({ ...repair, snapshot: { ...repair.snapshot, anchorItemId: null } });
    expect(measured).toBe(1);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0]!.query.anchorItemId).toBe(targets[1]!.id);
    pending[0]!.answer();
    await vi.waitFor(() =>
      expect(f.detail.transcript.getSnapshot().items.has(targets[1]!.id)).toBe(true),
    );
    expect(f.detail.anchor).toBe(targets[1]!.id);
    reader.dispose();
  });

  it("under any interleaving of jumps, returns to latest, scrolls, failures, repairs and resubscribes, only the latest move speaks, and a repair outside a move uses the row in view", async () => {
    let seed = 11;
    const next = (limit: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % limit;
    };
    for (let run = 0; run < 80; run++) {
      const { f, targets, pending, reader, settle } = positioned();
      const asked: { promise: Promise<boolean>; move: number }[] = [];
      let moves = 0;
      let last: { kind: "jump" | "latest"; target: number } | null = null;
      // Where the view says the reader is, if asked: scrolling changes it and tells nobody.
      let inView: number | undefined;
      reader.setMeasure(() => (inView === undefined ? undefined : targets[inView]!.id));
      for (let step = 0; step < 14; step++) {
        const action = next(8);
        if (action <= 1) {
          const target = next(targets.length);
          moves++;
          last = { kind: "jump", target };
          asked.push({
            promise: reader.history("around", targets[target]!.messageId),
            move: moves,
          });
        } else if (action === 2) {
          moves++;
          last = { kind: "latest", target: -1 };
          // Expo's and web's Return to latest: the same call, judged by what it resolves.
          asked.push({ promise: reader.history("latest"), move: moves });
        } else if (action === 3) {
          inView = next(targets.length);
        } else if (action === 4) {
          f.stream.receive(f.detailSnapshot());
        } else if (action === 5) {
          f.stream.setBackground(true);
          f.stream.setBackground(false);
          const subscribe = f.sent.at(-1) as Extract<
            ScopedClientMessage,
            { type: "client.subscribe" }
          >;
          const address = {
            scope: subscribe.scope,
            subscriptionId: subscribe.subscriptionId,
            generation: subscribe.generation,
          };
          const cut = f.detailSnapshot();
          f.stream.receive({
            ...cut,
            ...address,
            snapshot: { ...cut.snapshot, anchorItemId: subscribe.anchorItemId ?? null },
          });
          f.stream.receive({ ...address, type: "host.synchronized", throughSequence: "1" });
        } else if (pending.length) {
          // Some reads fail: a failure, too, may speak only for the latest move.
          const read = pending.splice(next(pending.length), 1)[0]!;
          if (action === 6) read.answer();
          else read.fail();
        }
        await settle();
      }
      for (let guard = 0; guard < 50 && pending.length; guard++) {
        pending.shift()!.answer();
        await settle();
      }
      const outcomes = await Promise.allSettled(asked.map(({ promise }) => promise));
      const label = `run ${run}`;
      for (const [index, { move }] of asked.entries()) {
        const outcome = outcomes[index]!;
        const latest = move === moves;
        if (outcome.status === "rejected")
          expect(latest, `${label}: a superseded move ${index} reported a failure`).toBe(true);
        else if (outcome.value)
          expect(latest, `${label}: a superseded move ${index} landed`).toBe(true);
      }
      const final = outcomes.at(-1);
      const landed = final?.status === "fulfilled" && final.value === true;
      if (last?.kind === "jump" && landed)
        expect(f.detail.anchor, label).toBe(targets[last.target]!.id);
      if (last?.kind === "latest" && landed) expect(f.detail.anchor, label).toBeUndefined();
      reader.dispose();
    }
  });
});

test("a conversation's Request reads under churn wait for quiet like every other read, and land once it comes", async () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  const requestId = createId("request");
  const reads: ((value: unknown) => void)[] = [];
  const list = vi.fn(() => new Promise((resolve) => reads.push(resolve)));
  const reader = new ScopedThreadReader(
    f.detail,
    { "thread.requests.list": list } as unknown as import("@opensteer/protocol").HostApiClient,
    new TranscriptBodies(),
  );
  const pend = (revision: number) =>
    f.stream.receive({
      ...f.address,
      type: "host.changes",
      fromSequence: String(revision - 1),
      throughSequence: String(revision),
      changes: [
        {
          entityKind: "request",
          entityId: requestId,
          ordinal: 0,
          sequence: String(revision),
          operation: "upsert",
          value: {
            id: requestId,
            revision: String(revision),
            status: "pending",
            kind: "person.question",
            title: "Question",
            threadId,
          },
        },
      ],
    } as never);
  const answer = () => {
    for (const resolve of reads.splice(0))
      resolve({
        ok: true,
        data: {
          threadId,
          requests: [],
          window: { byteCount: 0, hasMore: false, itemCount: 0, nextBefore: null },
        },
      });
  };
  vi.useFakeTimers();
  try {
    // The Request changes every 50 ms while each read is out: faster than a read answers.
    for (let revision = 2; revision < 22; revision++) {
      pend(revision);
      await vi.advanceTimersByTimeAsync(50);
      answer();
    }
    expect(list.mock.calls.length, "every change restarted the Request read").toBeLessThan(6);
    // Quiet again: it reads once more for the current Request.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reads.length).toBe(1);
  } finally {
    reader.dispose();
  }
});

test("bounds explicitly loaded bodies", () => {
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
        cut();
        socket.deliver({ ...address, type: "host.synchronized", throughSequence: head });
      })),
  });
  const cut = () =>
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
        ...shellLists,
      },
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
    // The Host's history moved back: it repairs the shell inline with an older cut.
    cut();
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
    background();
    host.repairShell();
    expect(client.getSnapshot().connection).toBe("connected");
    expect(reads).toBe(1);

    foreground();
    await client.load();
    await vi.waitFor(() => expect(reads, "the Done window was never refreshed").toBe(2));

    background();
    foreground();
    await client.load();
    expect(reads).toBe(2);
  } finally {
    client.dispose();
    host.dispose();
  }
});

test("a foreground probe answered by frames rather than its pong still resumes the conversation", async () => {
  vi.useFakeTimers();
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
  // A slow link: the pong to the foreground probe never comes back in time.
  let holdPong = false;
  const subscribes: string[] = [];
  const connect = () => {
    const socket = host.connect();
    const send = socket.send.bind(socket);
    socket.send = (data) => {
      const frame = JSON.parse(String(data)) as { type: string; subscriptionId?: string };
      if (holdPong && frame.type === "client.ping") return;
      if (frame.type === "client.subscribe" && frame.subscriptionId !== "shell")
        subscribes.push(frame.subscriptionId!);
      send(data);
    };
    return socket;
  };
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    capabilities: [],
    lifecycle,
    fetch: host.fetch,
    webSocketFactory: connect,
    // A client that watches its socket's liveness, as the apps do.
    realtimeLiveness: { idleMs: 60_000, deadlineMs: 10_000 },
  });
  try {
    await client.load();
    const task = mock.getSnapshot().threads.find(({ listed }) => listed)!;
    client.activateThread(task.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(subscribes).toHaveLength(1);
    // In the background the conversation's subscription is let go.
    background();
    holdPong = true;
    foreground();
    await vi.advanceTimersByTimeAsync(100);
    // Work arrives over the socket while the pong is still out: the socket is alive.
    await mock.dispatch({
      type: "thread.sendMessage",
      threadId: task.id,
      content: [{ type: "text", text: "Arrives while the pong is slow" }],
      delivery: "queue",
      idempotencyKey: "probe-progress",
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(subscribes, "the conversation was never resumed").toHaveLength(2);
    expect(client.getSnapshot().connection).toBe("connected");
  } finally {
    client.dispose();
    host.dispose();
  }
});

/** Saves one synchronized shell and selected-thread cut, as a previous run of the app would. */
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
          ...shellLists,
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
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetch).not.toHaveBeenCalled();
    expect(socket!.sent).toHaveLength(frames);
  } finally {
    client.dispose();
  }
});

test("keeps reading a catalog a screen still shows after a hand watch ends", async () => {
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
  const secondPage = Promise.withResolvers<void>();
  let secondPageSignal: AbortSignal | null | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const { kind, cursor } = JSON.parse(url.searchParams.get("input") ?? "{}");
    if (url.pathname !== "/v1/rpc/resources.detail.get" || kind !== "harness-catalog")
      return host.fetch(input, init);
    if (!cursor) return reply(String(host.client.getSnapshot().revision), "first-model", "next");
    secondPageSignal ??= init?.signal;
    return secondPage.promise.then(() =>
      reply(String(host.client.getSnapshot().revision), "second-model", null),
    );
  };
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    fetch,
    webSocketFactory: host.connect,
    capabilities: [],
  });
  const release = client.watchPersonalResource("harness-catalog", () => {});
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
      },
      { timeout: 1000 },
    );
    // Half an inventory never paints: the first page waits for the rest.
    expect(models()).toBeUndefined();
    // The screen read `environments`, which keeps its catalog watched for this viewer.
    release();
    expect(secondPageSignal?.aborted).toBe(false);
    secondPage.resolve();
    await vi.waitFor(() => expect(models()).toEqual(["first-model", "second-model"]), {
      timeout: 1000,
    });
  } finally {
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
  let socket: MockPersonalSocket;
  let generation = 0;
  let pushed = false;
  const replacement = Promise.withResolvers<Response>();
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
    const { kind, cursor } = JSON.parse(new URL(String(url)).searchParams.get("input")!);
    if (pushed && kind === "tab") return replacement.promise;
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
            ...shellLists,
          },
        });
        socket.deliver({ ...address, type: "host.synchronized", throughSequence: "1" });
        socket.deliver({
          type: "host.resource",
          subscriptionId: "shell",
          generation,
          revisions: { tab: "1", "tab-layout": "1" },
        });
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
    pushed = true;
    socket!.deliver({
      type: "host.resource",
      subscriptionId: "shell",
      generation,
      revisions: { tab: "2" },
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
      handle: 1,
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

test("keeps the eight most recently shown inactive tasks whole while they fit the text budget", () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  const scopes = Array.from({ length: 12 }, () => ({
    kind: "thread" as const,
    threadId: createId("thread"),
  }));
  // Each window is far past the old 2 MiB budget for every inactive task together.
  const text = "x".repeat(16 * 1024);
  const details = scopes.map((scope) => {
    const release = f.stream.observe(scope);
    const address = f.sent.at(-1) as Extract<ScopedClientMessage, { type: "client.subscribe" }>;
    const snapshot = f.detailSnapshot(
      Array.from({ length: 50 }, (_, index) => ({
        ...item,
        id: String(index),
        position: String(index + 1),
        text,
      })),
    ).snapshot;
    const at = { subscriptionId: address.subscriptionId, generation: address.generation, scope };
    expect(
      f.stream.receive({
        ...at,
        type: "host.snapshot",
        throughSequence: "1",
        snapshot: {
          ...snapshot,
          thread: detailThread({ ...task, id: scope.threadId }),
          nextBefore: null,
        },
      }),
    ).toBe(true);
    f.stream.receive({ ...at, type: "host.synchronized", throughSequence: "1" });
    const store = f.stream.detail(scope);
    expect(store.transcript.getSnapshot().items.size).toBe(50);
    release();
    return store;
  });
  const kept = details.map((detail, index) => f.stream.peekDetail(scopes[index]!) === detail);
  expect(kept).toEqual([...Array<boolean>(4).fill(false), ...Array<boolean>(8).fill(true)]);
  for (const detail of details.slice(4))
    expect(detail.transcript.getSnapshot().items.size).toBe(50);
  expect(f.detail.transcript.getSnapshot().items.get(item.id)?.id).toBe(item.id);
});

test("tells its owner whenever it lets an inactive task go", () => {
  const released = vi.fn();
  const stream = new ScopedPersonalStream(undefined, undefined, undefined, released);
  const sent: ScopedClientMessage[] = [];
  stream.attach((frame) => sent.push(frame));
  const scopes = Array.from({ length: 3 }, () => ({
    kind: "thread" as const,
    threadId: createId("thread"),
  }));
  // Observed and released without a cut: an empty inactive scope is let go at once.
  for (const scope of scopes) stream.observe(scope)();
  expect(released).toHaveBeenCalledTimes(3);
  for (const scope of scopes) expect(stream.peekDetail(scope)).toBeUndefined();
});

test("past the text budget keeps only the two most recently shown inactive tasks", () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  const scopes = Array.from({ length: 4 }, () => ({
    kind: "thread" as const,
    threadId: createId("thread"),
  }));
  // Each window holds about 6M characters of inline text: two together pass 12M, three 18M.
  const text = "x".repeat(120 * 1024);
  const details = scopes.map((scope) => {
    const release = f.stream.observe(scope);
    const address = f.sent.at(-1) as Extract<ScopedClientMessage, { type: "client.subscribe" }>;
    const at = { subscriptionId: address.subscriptionId, generation: address.generation, scope };
    const snapshot = f.detailSnapshot(
      Array.from({ length: 50 }, (_, index) => ({
        ...item,
        id: String(index),
        position: String(index + 1),
        text,
      })),
    ).snapshot;
    expect(
      f.stream.receive({
        ...at,
        type: "host.snapshot",
        throughSequence: "1",
        snapshot: {
          ...snapshot,
          thread: detailThread({ ...task, id: scope.threadId }),
          nextBefore: null,
        },
      }),
    ).toBe(true);
    f.stream.receive({ ...at, type: "host.synchronized", throughSequence: "1" });
    const store = f.stream.detail(scope);
    release();
    return store;
  });
  expect(details.map((detail, index) => f.stream.peekDetail(scopes[index]!) === detail)).toEqual([
    false,
    false,
    true,
    true,
  ]);
});

test("a catch-up left before it is synchronized is dropped: the kept rows are the last ones shown", () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  f.stream.select(undefined);
  f.stream.select(threadScope);
  const next = f.sent.findLast((frame) => frame.type === "client.subscribe") as Extract<
    ScopedClientMessage,
    { type: "client.subscribe" }
  >;
  const at = {
    subscriptionId: next.subscriptionId,
    generation: next.generation,
    scope: next.scope,
  };
  const shown = f.detail.transcript.getSnapshot();
  const notices = vi.fn();
  f.detail.transcript.subscribe(notices);
  f.stream.receive({
    ...at,
    type: "host.changes",
    fromSequence: "1",
    throughSequence: "2",
    changes: [
      {
        entityKind: "item",
        entityId: "partial",
        ordinal: 0,
        sequence: "2",
        operation: "upsert",
        value: { ...item, id: "partial", revision: "2", position: "2" },
      },
    ],
  });
  // Left again before the Host says it is caught up.
  f.stream.select(undefined);
  const kept = f.detail.transcript.getSnapshot();
  expect(kept.items.has("partial")).toBe(false);
  expect(kept.items).toBe(shown.items);
  expect(kept.through).toBe("1");
  expect(notices).toHaveBeenCalledTimes(1);
  // The next visit resumes from what was shown, so the Host replays the commit whole.
  f.stream.select(threadScope);
  const again = f.sent.findLast((frame) => frame.type === "client.subscribe") as Extract<
    ScopedClientMessage,
    { type: "client.subscribe" }
  >;
  expect(again.cursor?.afterSequence).toBe("1");
});

test("publishes a resubscription's catch-up once, whole, when it is synchronized", () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  // Leave the task and come back: it resumes from its cursor with its rows still drawn.
  f.stream.select(undefined);
  f.stream.select(threadScope);
  const next = f.sent.findLast((frame) => frame.type === "client.subscribe") as Extract<
    ScopedClientMessage,
    { type: "client.subscribe" }
  >;
  expect(next.cursor?.afterSequence).toBe("1");
  const at = {
    subscriptionId: next.subscriptionId,
    generation: next.generation,
    scope: next.scope,
  };
  expect(f.detail.transcript.getSnapshot()).toMatchObject({ synchronized: false });
  expect(f.detail.transcript.getSnapshot().items.has(item.id)).toBe(true);
  const notices = vi.fn();
  f.detail.transcript.subscribe(notices);
  const commits = 100;
  for (let index = 1; index <= commits; index++) {
    const id = `replayed-${index}`;
    expect(
      f.stream.receive({
        ...at,
        type: "host.changes",
        fromSequence: String(index),
        throughSequence: String(index + 1),
        changes: [
          {
            entityKind: "item",
            entityId: id,
            ordinal: 0,
            sequence: String(index + 1),
            operation: "upsert",
            value: { ...item, id, revision: String(index + 1), position: String(index + 1) },
          },
        ],
      }),
    ).toBe(true);
  }
  // Each commit is applied and acknowledged, but nothing renders a half-caught-up task.
  expect(notices).not.toHaveBeenCalled();
  expect(f.detail.transcript.getSnapshot().items.size).toBe(commits + 1);
  expect(f.sent.filter((frame) => frame.type === "client.ack").at(-1)).toMatchObject({
    throughSequence: String(commits + 1),
  });
  f.stream.receive({ ...at, type: "host.synchronized", throughSequence: String(commits + 1) });
  expect(notices).toHaveBeenCalledTimes(1);
  expect(f.detail.transcript.getSnapshot()).toMatchObject({
    synchronized: true,
    through: String(commits + 1),
  });
  // Once synchronized, each change is published as it lands.
  f.stream.receive({
    ...at,
    type: "host.changes",
    fromSequence: String(commits + 1),
    throughSequence: String(commits + 2),
    changes: [
      {
        entityKind: "item",
        entityId: item.id,
        ordinal: 0,
        sequence: String(commits + 2),
        operation: "remove",
      },
    ],
  });
  expect(notices).toHaveBeenCalledTimes(2);
});

test("publishes a subscription's first snapshot with its synchronization, not before", () => {
  const f = fixture();
  f.syncShell();
  const notices = vi.fn();
  f.detail.transcript.subscribe(notices);
  f.stream.receive(f.detailSnapshot());
  expect(notices).not.toHaveBeenCalled();
  f.stream.receive({ ...f.address, type: "host.synchronized", throughSequence: "1" });
  expect(notices).toHaveBeenCalledTimes(1);
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
      thread: detailThread({ ...task, id: other.threadId }),
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

test("keeps the waiting-message tray from queue values and reads only entries the cut left out", async () => {
  const f = fixture();
  f.syncShell();
  const waiting = (id: string, preview: string) => ({
    message: {
      id: id as import("@opensteer/core").MessageId,
      revision: 0,
      author: { kind: "human" as const, principalId: viewerId, displayName: "Owner" },
      createdAt: time,
      preview,
      truncated: false,
    },
    input: {
      messageId: id as import("@opensteer/core").MessageId,
      state: "pending" as const,
      queueRank: "1",
    },
    ask: null,
    canEdit: true,
    canCancel: true,
    canMove: true,
    canSteer: false,
    lease: null,
  });
  const a = createId("message");
  const b = createId("message");
  const c = createId("message");
  const queue = (revision: string, inputs: string[]) => ({
    revision,
    runs: [],
    paused: false,
    steerRunId: null,
    inputs: inputs as import("@opensteer/core").MessageId[],
  });
  const snapshot = f.detailSnapshot();
  f.stream.receive({
    ...snapshot,
    snapshot: { ...snapshot.snapshot, queue: queue("1", [a, b]), inputQueue: [waiting(a, "A")] },
  });
  f.stream.receive({ ...f.address, type: "host.synchronized", throughSequence: "1" });
  const read = vi.fn(async () => ({
    ok: true as const,
    data: {
      threadId,
      revision: "1",
      paused: false,
      steerRunId: null,
      items: [waiting(a, "stale A"), waiting(b, "B")],
    },
  }));
  const reader = new ScopedThreadReader(
    f.detail,
    { "thread.inputQueue.get": read } as unknown as import("@opensteer/protocol").HostApiClient,
    new TranscriptBodies(),
  );
  try {
    // The cut had room for A only; one read fills B and never overrides the pushed A.
    await vi.waitFor(() =>
      expect(reader.getSnapshot().inputQueue?.items.map(({ message }) => message.preview)).toEqual([
        "A",
        "B",
      ]),
    );
    const trays: (readonly string[] | null)[] = [];
    reader.subscribe(() =>
      trays.push(
        reader.getSnapshot().inputQueue?.items.map(({ message }) => message.preview) ?? null,
      ),
    );
    f.stream.receive({
      ...f.address,
      type: "host.changes",
      fromSequence: "1",
      throughSequence: "2",
      changes: [
        {
          entityKind: "queue-entry",
          entityId: c,
          operation: "upsert",
          sequence: "2",
          ordinal: 0,
          value: waiting(c, "C"),
        },
        {
          entityKind: "run-queue",
          entityId: threadId,
          operation: "upsert",
          sequence: "2",
          ordinal: 1,
          value: queue("2", [c, a]),
        },
        { entityKind: "queue-entry", entityId: b, operation: "remove", sequence: "2", ordinal: 2 },
      ],
    });
    expect(trays).toEqual([["C", "A"]]);
    expect(read).toHaveBeenCalledTimes(1);
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

type Subscribe = Extract<ScopedClientMessage, { type: "client.subscribe" }>;
type DetailAddress = Pick<Subscribe, "scope" | "subscriptionId" | "generation">;

/** A Host that answers attach and subscribe with a cut, and lets a test push commits. */
function scriptedHost(
  options: {
    readonly tasks?: readonly object[];
    readonly items?: TranscriptItem[];
    readonly lists?: Readonly<Record<string, unknown>>;
  } = {},
) {
  let tasks = (options.tasks ?? [task]) as (typeof task)[];
  let lists = options.lists;
  const items = options.items ?? [item];
  const sent: ScopedClientMessage[] = [];
  let socket!: MockPersonalSocket;
  let head = 1;
  let shell = { subscriptionId: "shell" as const, scope: shellScope, generation: 0 };
  const details = new Map<string, DetailAddress>();
  const delivered = new Map<string, string>();
  const shellCut = (synchronized = true) => {
    delivered.set("shell", String(head));
    socket.deliver({
      ...shell,
      type: "host.snapshot",
      throughSequence: String(head),
      snapshot: {
        deploymentId,
        viewerId,
        epoch,
        session,
        tasks,
        visits: [],
        attention: [],
        counts,
        ...shellLists,
        ...(lists as typeof shellLists | undefined),
      },
    });
    if (synchronized)
      socket.deliver({ ...shell, type: "host.synchronized", throughSequence: String(head) });
  };
  const detailCut = ({ scope, subscriptionId, generation }: DetailAddress) => {
    if (scope.kind !== "thread" || subscriptionId === "shell") return;
    const address = { scope, subscriptionId, generation };
    details.set(scope.threadId, address);
    delivered.set(scope.threadId, String(head));
    socket.deliver({
      ...address,
      type: "host.snapshot",
      throughSequence: String(head),
      snapshot: {
        thread: detailThread(
          tasks.find(({ id }) => id === scope.threadId) ?? { ...task, id: scope.threadId },
        ),
        items,
        activeItems: [],
        pendingRequests: [],
        nextBefore: null,
        queue: { revision: "1", runs: [], paused: false, steerRunId: null, inputs: [] },
        inputQueue: [],
      },
    });
    socket.deliver({ ...address, type: "host.synchronized", throughSequence: String(head) });
  };
  const connect = () =>
    (socket = new MockPersonalSocket((raw) => {
      const frame = JSON.parse(raw) as ScopedClientMessage;
      sent.push(frame);
      if (frame.type === "client.attach") {
        shell = { ...shell, generation: frame.generation };
        queueMicrotask(() => {
          shellCut();
          if (frame.selected) detailCut(frame.selected);
        });
      }
      if (frame.type === "client.subscribe")
        queueMicrotask(() => {
          if (frame.subscriptionId === "shell") {
            shell = { ...shell, generation: frame.generation };
            shellCut();
          } else detailCut(frame);
        });
    }));
  return {
    connect,
    sent,
    socket: () => socket,
    head: () => String(head),
    details,
    /** The Host could not replay the shell: an inline snapshot of these rows, on the same generation. */
    repairShell(next: readonly object[], nextLists?: Readonly<Record<string, unknown>>) {
      tasks = next as (typeof task)[];
      lists = nextLists ?? lists;
      head++;
      shellCut(false);
    },
    /** Delivers one commit to the shell and/or a detail scope. */
    commit(
      shellChanges: readonly unknown[],
      detail?: { threadId: string; changes: readonly unknown[] },
    ) {
      head++;
      const through = String(head);
      const rows = (changes: readonly unknown[]) =>
        changes.map((change, ordinal) => ({
          ...(change as object),
          sequence: through,
          ordinal,
        }));
      // Each subscription's feed chains from the last commit it was sent.
      if (shellChanges.length) {
        socket.deliver({
          ...shell,
          type: "host.changes",
          fromSequence: delivered.get("shell") ?? "1",
          throughSequence: through,
          changes: rows(shellChanges),
        } as never);
        delivered.set("shell", through);
      }
      const address = detail && details.get(detail.threadId);
      if (address) {
        socket.deliver({
          ...address,
          type: "host.changes",
          fromSequence: delivered.get(detail.threadId) ?? "1",
          throughSequence: through,
          changes: rows(detail.changes),
        } as never);
        delivered.set(detail.threadId, through);
      }
      return through;
    },
    live(threadId: string, itemId: string, text: string, offset = 0) {
      const address = details.get(threadId)!;
      socket.deliver({
        ...address,
        type: "host.live",
        handle: 1,
        liveBootId: "00000000-0000-4000-8000-000000000001",
        runId,
        attemptId: createId("runAttempt"),
        bindingGeneration: 1,
        streamId: "reply",
        itemId,
        afterSequence: String(head),
        update: { operation: "append", text, offset, totalLength: offset + text.length },
      } as never);
    },
  };
}

function scriptedClient(host: ReturnType<typeof scriptedHost>, fetch?: typeof globalThis.fetch) {
  return new HttpHostClient({
    baseUrl: "http://scoped-host",
    webSocketFactory: host.connect,
    capabilities: [],
    fetch:
      fetch ??
      (async () =>
        Response.json({
          ok: false,
          error: { code: "not_found", message: "Unavailable", retryable: false },
        })),
  });
}

test("a shell repair on an open socket keeps the connection, its reconnect work and live text", async () => {
  const host = scriptedHost();
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({
      ok: false,
      error: { code: "not_found", message: "Unavailable", retryable: false },
    }),
  );
  const client = scriptedClient(host, fetch);
  try {
    client.activateThread(threadId);
    await client.load();
    await vi.waitFor(() =>
      expect(client.getThreadTranscript(threadId)?.getSnapshot().synchronized).toBe(true),
    );
    const connections: string[] = [];
    client.subscribe(() => connections.push(client.getSnapshot().connection));
    const reads = fetch.mock.calls.length;
    const repaired = client.refresh();
    host.live(threadId, "live-reply", "Hello");
    await repaired;
    await vi.waitFor(() =>
      expect(
        host.sent.filter((frame) => frame.type === "client.subscribe"),
        "the shell repair was never sent",
      ).toHaveLength(1),
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(client.getThreadItemText(threadId)?.get("live-reply")?.text).toBe("Hello");
    expect(connections.every((connection) => connection === "connected")).toBe(true);
    expect(fetch.mock.calls.length).toBe(reads);
  } finally {
    client.dispose();
  }
});

test("a task shown again draws its kept rows at once from the same reader, until the stream lets it go", async () => {
  const others = Array.from({ length: 9 }, () => ({ ...task, id: createId("thread") }));
  const host = scriptedHost({ tasks: [task, ...others] });
  const client = scriptedClient(host);
  const synchronized = (id: string) =>
    vi.waitFor(() => expect(client.getThreadTranscript(id)?.getSnapshot().synchronized).toBe(true));
  try {
    client.activateThread(threadId);
    await client.load();
    await synchronized(threadId);
    const reader = client.getThreadTranscript(threadId)!;
    client.activateThread(others[0]!.id);
    await synchronized(others[0]!.id);
    // Before the task is shown again, its first frame already has its rows.
    const parked = client.getThreadTranscript(threadId);
    expect(parked).toBe(reader);
    expect(parked?.getSnapshot().entries.map(({ id }) => id)).toContain(item.id);
    expect(parked?.getSnapshot().synchronized).toBe(false);
    client.activateThread(threadId);
    expect(client.getThreadTranscript(threadId)).toBe(reader);
    await synchronized(threadId);
    // Past the tasks the stream keeps, the reader goes with its scope.
    for (const other of others) {
      client.activateThread(other.id);
      await synchronized(other.id);
    }
    expect(client.getThreadTranscript(threadId)).toBeUndefined();
  } finally {
    client.dispose();
  }
});

test("an early detail past the buffer is set aside and resubscribed after the shell cut", () => {
  const f = fixture();
  f.stream.receive(f.detailSnapshot());
  for (let sequence = 1; sequence <= 130; sequence++)
    f.stream.receive({
      ...f.address,
      type: "host.changes",
      fromSequence: String(sequence),
      throughSequence: String(sequence + 1),
      changes: [],
    });
  expect(f.sent.filter((frame) => frame.type === "client.subscribe")).toHaveLength(0);
  f.syncShell();
  expect(f.sent.filter((frame) => frame.type === "client.subscribe")).toMatchObject([
    { subscriptionId: f.address.subscriptionId, scope: threadScope },
  ]);
  expect(f.detail.transcript.getSnapshot().items.size).toBe(0);
});

const upsert = (entityKind: string, entityId: string, value: unknown) => ({
  operation: "upsert",
  entityKind,
  entityId,
  value,
});

test("a whole Run arrives as values: no resubscribe after attach and no connection change", async () => {
  const host = scriptedHost({ tasks: [{ ...task, status: "idle" }] });
  const client = scriptedClient(host);
  try {
    client.activateThread(threadId);
    await client.load();
    await vi.waitFor(() =>
      expect(client.getThreadTranscript(threadId)?.getSnapshot().synchronized).toBe(true),
    );
    const subscribes = () => host.sent.filter((frame) => frame.type === "client.subscribe").length;
    const attached = subscribes();
    const connections = new Set<string>();
    client.subscribe(() => connections.add(client.getSnapshot().connection));
    const reader = client.getThreadTranscript(threadId)!;
    let revision = 1;
    const row = (status: "running" | "idle", extra: object = {}) => ({
      ...task,
      status,
      revision: String(++revision),
      ...extra,
    });
    const queue = (runs: object[], inputs: string[]) => ({
      revision: String(revision),
      runs,
      paused: false,
      steerRunId: null,
      inputs,
    });
    const run = (status: string) => ({
      id: runId,
      revision: String(revision),
      status,
      finishing: false,
      createdAt: time,
      runOrdinal: 1,
    });
    const tool = (status: string) => ({
      ...item,
      kind: "tool",
      id: "tool-1",
      toolCallId: "call-1",
      position: "2",
      revision: String(revision),
      messageId: undefined,
      view: { status },
    });
    const node = (status: string) => ({
      ...item,
      kind: "node",
      id: "node:1",
      executionNodeId: nodeId,
      position: "3",
      revision: String(revision),
      messageId: undefined,
      view: { status },
    });
    const waitingId = createId("message");
    const waiting = {
      message: {
        id: waitingId,
        revision: 0,
        author: { kind: "human", principalId: viewerId, displayName: "Owner" },
        createdAt: time,
        preview: "Next",
        truncated: false,
      },
      input: { messageId: waitingId, state: "pending", queueRank: "1" },
      ask: null,
      canEdit: true,
      canCancel: true,
      canMove: true,
      canSteer: true,
      lease: null,
    };
    const strip = <T extends object>(value: T) => JSON.parse(JSON.stringify(value)) as T;
    // The Run starts.
    let next = row("running");
    host.commit([upsert("task", threadId, next)], {
      threadId,
      changes: [
        upsert("thread", threadId, detailThread(next)),
        upsert("run-queue", threadId, queue([run("running")], [])),
      ],
    });
    expect(client.getSnapshot().activeTasks.map(({ thread }) => thread.id)).toEqual([threadId]);
    expect(reader.getSnapshot().runQueue).toMatchObject([{ id: runId, status: "running" }]);
    // A tool and a subagent run, and the person queues a message.
    revision++;
    host.commit([], {
      threadId,
      changes: [
        upsert("item", "tool-1", strip(tool("running"))),
        upsert("item", "node:1", strip(node("running"))),
      ],
    });
    revision++;
    host.commit([], {
      threadId,
      changes: [
        upsert("queue-entry", waitingId, waiting),
        upsert("run-queue", threadId, queue([run("running")], [waitingId])),
      ],
    });
    expect(reader.getSnapshot().inputQueue?.items.map(({ message }) => message.id)).toEqual([
      waitingId,
    ]);
    revision++;
    host.commit([], {
      threadId,
      changes: [
        upsert("item", "node:1", strip(node("done"))),
        upsert("item", "tool-1", strip(tool("done"))),
      ],
    });
    // The Run takes the queued message and finishes.
    next = row("idle", { latestRunCompletedAt: time });
    host.commit([upsert("task", threadId, next)], {
      threadId,
      changes: [
        upsert("thread", threadId, detailThread(next)),
        upsert("run-queue", threadId, queue([], [])),
        { operation: "remove", entityKind: "queue-entry", entityId: waitingId },
      ],
    });
    expect(client.getSnapshot().activeTasks).toEqual([]);
    expect(reader.getSnapshot()).toMatchObject({ runQueue: [], inputQueue: { items: [] } });
    expect(reader.getSnapshot().entries.map(({ id }) => id)).toEqual([item.id, "tool-1", "node:1"]);
    expect(subscribes()).toBe(attached);
    expect([...connections]).toEqual(["connected"]);
  } finally {
    client.dispose();
  }
});

test("every running task stays listed while others finish, and loaded task pages survive a change", async () => {
  const running = Array.from({ length: 12 }, (_, index) => ({
    ...task,
    id: createId("thread"),
    title: `Task ${index + 1}`,
    askedAt: new Date(Date.parse(time) - index * 60_000).toISOString(),
  }));
  const settled = Array.from({ length: 25 }, (_, index) => ({
    ...task,
    id: createId("thread"),
    title: `Settled ${index + 1}`,
    status: "idle" as const,
    askedAt: new Date(Date.parse(time) - (index + 20) * 60_000).toISOString(),
  }));
  const host = scriptedHost({
    tasks: [...running, ...settled],
    lists: {
      activeTaskIds: running.map(({ id }) => id),
      recentTaskIds: [...running, ...settled].slice(0, 25).map(({ id }) => id),
      nextBefore: "older",
    },
  });
  const older = createId("thread");
  const pages: unknown[] = [];
  const client = scriptedClient(host, async (input) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith("/tasks.page")) return new Response(null, { status: 404 });
    pages.push(JSON.parse(url.searchParams.get("input") ?? "{}"));
    const listed = new MockHostClient({ latencyMs: 0 }).getSnapshot().threads[0]!;
    return Response.json({
      ok: true,
      data: {
        asOfSequence: host.head(),
        tasks: [
          {
            thread: {
              ...detailThread({ ...task, id: older, title: "Older", status: "idle" }).thread,
              askedAt: "2026-11-01T00:00:00.000Z",
              environmentId: listed.environmentId,
            },
            lastReply: null,
            failure: null,
          },
        ],
        window: { nextBefore: null, hasMore: false, totalItems: 1, byteCount: 0, itemCount: 1 },
      },
    });
  });
  try {
    await client.load();
    expect(client.getSnapshot().activeTasks).toHaveLength(12);
    await client.loadEarlierTasks();
    expect(pages).toEqual([{ before: "older", limit: 50 }]);
    const ids = () => client.getSnapshot().tasks?.entries.map(({ thread }) => thread.id) ?? [];
    expect(ids()).toContain(older);
    host.commit(
      running.slice(0, 10).map((row, index) =>
        upsert("task", row.id, {
          ...row,
          status: "idle",
          revision: "2",
          latestRunCompletedAt: time,
          title: `Finished ${index}`,
        }),
      ),
    );
    expect(client.getSnapshot().activeTasks.map(({ thread }) => thread.id)).toEqual(
      running.slice(10).map(({ id }) => id),
    );
    expect(ids()).toContain(older);
    expect(ids()).toHaveLength(12 + 25 + 1);
    expect(host.sent.filter((frame) => frame.type === "client.subscribe")).toEqual([]);
    expect(pages).toHaveLength(1);
  } finally {
    client.dispose();
  }
});

test("keeps a visit that arrives before its task", () => {
  const f = fixture();
  f.syncShell();
  const later = createId("thread");
  const commit = (fromSequence: string, change: object) =>
    f.stream.receive({
      ...f.shell,
      type: "host.changes",
      fromSequence,
      throughSequence: String(Number(fromSequence) + 1),
      changes: [{ ...change, sequence: String(Number(fromSequence) + 1), ordinal: 0 }],
    });
  commit("1", upsert("visit", later, { threadId: later, lastVisitedAt: time, revision: "2" }));
  commit("2", upsert("task", later, { ...task, id: later, revision: "3" }));
  const state = f.stream.shell.getSnapshot();
  expect(state.tasks.has(later)).toBe(true);
  expect(state.visits.get(later)?.lastVisitedAt).toBe(time);
});

test("acknowledges live text about every 32 KiB so a long reply keeps flowing, and stops once unobserved", () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  const chunk = "x".repeat(4000);
  const attempt = createId("runAttempt");
  let offset = 0;
  const live = () => {
    f.stream.receive({
      ...f.address,
      type: "host.live",
      handle: 1,
      liveBootId: "00000000-0000-4000-8000-000000000001",
      runId,
      attemptId: attempt,
      bindingGeneration: 1,
      streamId: "reply",
      itemId: "live-reply",
      afterSequence: "1",
      update: { operation: "append", text: chunk, offset, totalLength: offset + chunk.length },
    });
    offset += chunk.length;
  };
  const acks = () => f.sent.filter((frame) => frame.type === "client.ack").length;
  const before = acks();
  for (let index = 0; index < 160; index++) live();
  // 640 KB of text, far past the Host's 256 KiB pause, arrived and was acknowledged as it came.
  expect(f.detail.text.get("live-reply")?.totalLength).toBe(offset);
  expect(acks() - before).toBeGreaterThanOrEqual(18);
  // Compact text frames for the named stream spend the same credit, by their wire bytes.
  const compact = acks();
  for (let index = 0; index < 40; index++) {
    const frame = { type: "host.text", h: 1, o: offset, n: offset + chunk.length, t: chunk };
    f.stream.receive(frame, JSON.stringify(frame).length);
    offset += chunk.length;
  }
  expect(f.detail.text.get("live-reply")?.totalLength).toBe(offset);
  expect(acks() - compact).toBeGreaterThanOrEqual(4);
  f.stream.setBackground(true);
  const background = acks();
  for (let index = 0; index < 20; index++) live();
  expect(acks()).toBe(background);
  f.stream.setBackground(false);
  f.stream.select(undefined);
  const released = acks();
  for (let index = 0; index < 20; index++) live();
  expect(acks()).toBe(released);
});

test("shows a task's new return hint from its republished thread value, with no read", async () => {
  const host = scriptedHost({ tasks: [{ ...task, status: "idle" }] });
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({
      ok: false,
      error: { code: "not_found", message: "Unavailable", retryable: false },
    }),
  );
  const client = scriptedClient(host, fetch);
  try {
    client.activateThread(threadId);
    await client.load();
    await vi.waitFor(() =>
      expect(client.getThreadTranscript(threadId)?.getSnapshot().synchronized).toBe(true),
    );
    const reads = fetch.mock.calls.length;
    const hint = { eligible: true, sessionRevision: "7", sourceRunId: runId, eligibleAt: 1_000 };
    const value = detailThread({ ...task, status: "idle" as const, revision: "2" });
    host.commit([], {
      threadId,
      changes: [
        upsert("thread", threadId, { ...value, thread: { ...value.thread, returnHint: hint } }),
      ],
    });
    expect(client.getSnapshot().threads.find(({ id }) => id === threadId)?.returnHint).toEqual(
      hint,
    );
    expect(fetch.mock.calls.length).toBe(reads);
    expect(host.sent.filter((frame) => frame.type === "client.subscribe")).toEqual([]);
  } finally {
    client.dispose();
  }
});

test("opening a task reads each follow-up once, beside its snapshot, and the family's open work only when the newest page is not all of it", async () => {
  const calls: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(String(input));
    const name = url.pathname.slice("/v1/rpc/".length);
    calls.push(name);
    if (name === "thread.assignments.list")
      return Response.json({
        ok: true,
        data: {
          assignments: [],
          threadId,
          window: { byteCount: 0, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 },
        },
      });
    return Response.json(
      { ok: false, error: { code: "not_found", message: "Unavailable", retryable: false } },
      { status: 404 },
    );
  });
  let socket: MockPersonalSocket;
  let detailSent = 0;
  const connect = () =>
    (socket = new MockPersonalSocket((raw) => {
      const message = JSON.parse(raw) as ScopedClientMessage;
      const deliverDetail = (
        subscription: Pick<
          Extract<ScopedClientMessage, { type: "client.subscribe" }>,
          "scope" | "subscriptionId" | "generation"
        >,
      ) => {
        const address = {
          scope: subscription.scope,
          subscriptionId: subscription.subscriptionId,
          generation: subscription.generation,
          throughSequence: "1",
        };
        detailSent++;
        socket.deliver({
          ...address,
          type: "host.snapshot",
          snapshot: {
            thread: detailThread(task),
            items: [item],
            activeItems: [],
            pendingRequests: [],
            nextBefore: null,
          },
        } as never);
        socket.deliver({ ...address, type: "host.synchronized" } as never);
      };
      queueMicrotask(() => {
        if (message.type === "client.subscribe") deliverDetail(message);
        if (message.type !== "client.attach") return;
        const shell = {
          scope: shellScope,
          subscriptionId: "shell" as const,
          generation: message.generation,
          throughSequence: "1",
        };
        socket.deliver({
          ...shell,
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
        socket.deliver({ ...shell, type: "host.synchronized" });
      });
    }));
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    fetch,
    webSocketFactory: connect,
    capabilities: ["task-family-v1"],
  });
  try {
    await client.load();
    calls.length = 0;
    client.activateThread(threadId);
    await vi.waitFor(() => expect(detailSent).toBe(1));
    await vi.waitFor(() => expect(calls).toContain("thread.browserUsage.get"));
    expect(calls.sort()).toEqual([
      "thread.assignments.list",
      "thread.browserUsage.get",
      "triggers.list",
    ]);
  } finally {
    client.dispose();
  }
});

test("a repaired task drops an open assignment its reread no longer returns, and a read in flight across the repair installs nothing", async () => {
  const seed = Object.values(new MockHostClient({ latencyMs: 0 }).getSnapshot().assignments)[0]!;
  const finished = {
    ...seed,
    id: createId("delegation"),
    parentThreadId: threadId,
    status: "open" as const,
  };
  const stale = {
    ...seed,
    id: createId("delegation"),
    parentThreadId: threadId,
    status: "open" as const,
  };
  const lists: ((assignments: (typeof seed)[]) => void)[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const name = new URL(String(input)).pathname.slice("/v1/rpc/".length);
    if (name === "thread.assignments.list") {
      const assignments = await new Promise<(typeof seed)[]>((resolve) => lists.push(resolve));
      return Response.json({
        ok: true,
        data: {
          assignments,
          threadId,
          window: {
            byteCount: 0,
            hasMore: false,
            itemCount: assignments.length,
            nextBefore: null,
            totalItems: assignments.length,
          },
        },
      });
    }
    return Response.json(
      { ok: false, error: { code: "not_found", message: "Unavailable", retryable: false } },
      { status: 404 },
    );
  });
  let socket: MockPersonalSocket;
  let detail: Extract<ScopedClientMessage, { type: "client.subscribe" }> | undefined;
  const deliverDetail = () => {
    const address = {
      scope: detail!.scope,
      subscriptionId: detail!.subscriptionId,
      generation: detail!.generation,
      throughSequence: "1",
    };
    socket.deliver({
      ...address,
      type: "host.snapshot",
      snapshot: {
        thread: detailThread(task),
        items: [item],
        activeItems: [],
        pendingRequests: [],
        nextBefore: null,
      },
    } as never);
    socket.deliver({ ...address, type: "host.synchronized" } as never);
  };
  const connect = () =>
    (socket = new MockPersonalSocket((raw) => {
      const message = JSON.parse(raw) as ScopedClientMessage;
      queueMicrotask(() => {
        if (message.type === "client.subscribe") {
          detail = message;
          deliverDetail();
        }
        if (message.type !== "client.attach") return;
        const shell = {
          scope: shellScope,
          subscriptionId: "shell" as const,
          generation: message.generation,
          throughSequence: "1",
        };
        socket.deliver({
          ...shell,
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
        socket.deliver({ ...shell, type: "host.synchronized" });
      });
    }));
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    fetch,
    webSocketFactory: connect,
  });
  const held = () => Object.keys(client.getSnapshot().assignments).sort();
  try {
    await client.load();
    client.activateThread(threadId);
    await vi.waitFor(() => expect(lists).toHaveLength(1));
    lists[0]!([finished]);
    await vi.waitFor(() => expect(held()).toEqual([finished.id]));
    // A repair while the task is open: the feed's update that finished the assignment was skipped.
    deliverDetail();
    await vi.waitFor(() => expect(lists).toHaveLength(2));
    // A second repair lands while that reread flies: its answer is from before it, and is not installed.
    deliverDetail();
    lists[1]!([finished, stale]);
    await vi.waitFor(() => expect(lists).toHaveLength(3));
    expect(held()).toEqual([finished.id]);
    lists[2]!([]);
    await vi.waitFor(() => expect(held()).toEqual([]));
  } finally {
    client.dispose();
  }
});

test("a resubscribed task reads its assignments again; one pushed while that read flies is kept though the read omits it", async () => {
  const seed = Object.values(new MockHostClient({ latencyMs: 0 }).getSnapshot().assignments)[0]!;
  const finished = {
    ...seed,
    id: createId("delegation"),
    parentThreadId: threadId,
    status: "open" as const,
  };
  const fresh = {
    ...seed,
    id: createId("delegation"),
    parentThreadId: threadId,
    status: "open" as const,
    revision: 5,
  };
  const lists: ((assignments: (typeof seed)[]) => void)[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const name = new URL(String(input)).pathname.slice("/v1/rpc/".length);
    if (name === "thread.assignments.list") {
      const assignments = await new Promise<(typeof seed)[]>((resolve) => lists.push(resolve));
      return Response.json({
        ok: true,
        data: {
          assignments,
          threadId,
          window: {
            byteCount: 0,
            hasMore: false,
            itemCount: assignments.length,
            nextBefore: null,
            totalItems: assignments.length,
          },
        },
      });
    }
    return Response.json(
      { ok: false, error: { code: "not_found", message: "Unavailable", retryable: false } },
      { status: 404 },
    );
  });
  let socket: MockPersonalSocket;
  let detail: Extract<ScopedClientMessage, { type: "client.subscribe" }> | undefined;
  const deliverDetail = () => {
    const address = {
      scope: detail!.scope,
      subscriptionId: detail!.subscriptionId,
      generation: detail!.generation,
      throughSequence: "1",
    };
    socket.deliver({
      ...address,
      type: "host.snapshot",
      snapshot: {
        thread: detailThread(task),
        items: [item],
        activeItems: [],
        pendingRequests: [],
        nextBefore: null,
      },
    } as never);
    socket.deliver({ ...address, type: "host.synchronized" } as never);
  };
  const connect = () =>
    (socket = new MockPersonalSocket((raw) => {
      const message = JSON.parse(raw) as ScopedClientMessage;
      queueMicrotask(() => {
        if (message.type === "client.ping")
          socket.deliver({ type: "host.pong", nonce: message.nonce } as never);
        if (message.type === "client.subscribe") {
          detail = message;
          deliverDetail();
        }
        if (message.type !== "client.attach") return;
        const shell = {
          scope: shellScope,
          subscriptionId: "shell" as const,
          generation: message.generation,
          throughSequence: "1",
        };
        socket.deliver({
          ...shell,
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
        socket.deliver({ ...shell, type: "host.synchronized" });
      });
    }));
  let foreground = () => {};
  let background = () => {};
  const lifecycle: ClientLifecycle = {
    getSnapshot: () => ({ network: "online", visibility: "foreground" }),
    onForeground: (listener) => ((foreground = listener), () => {}),
    onBackground: (listener) => ((background = listener), () => {}),
    onNetworkChange: () => () => {},
  };
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    fetch,
    lifecycle,
    webSocketFactory: connect,
  });
  const held = () => Object.keys(client.getSnapshot().assignments).sort();
  try {
    await client.load();
    client.activateThread(threadId);
    await vi.waitFor(() => expect(lists).toHaveLength(1));
    lists[0]!([finished]);
    await vi.waitFor(() => expect(held()).toEqual([finished.id]));
    // The app goes away and comes back: a new subscription, which may have skipped the change
    // that finished the assignment.
    background();
    foreground();
    await vi.waitFor(() =>
      expect(lists, "the new subscription never read assignments").toHaveLength(2),
    );
    // While that read flies, another assignment is handed out and pushed.
    socket!.deliver({
      scope: detail!.scope,
      subscriptionId: detail!.subscriptionId,
      generation: detail!.generation,
      type: "host.changes",
      fromSequence: "1",
      throughSequence: "2",
      changes: [
        {
          entityKind: "assignment",
          entityId: fresh.id,
          operation: "upsert",
          sequence: "2",
          ordinal: 0,
          value: fresh,
        },
      ],
    } as never);
    await vi.waitFor(() => expect(held()).toEqual([finished.id, fresh.id].sort()));
    // The read's answer is from before that push: the finished one goes, the new one stays.
    lists[1]!([]);
    await vi.waitFor(() => expect(held()).toEqual([fresh.id]));
  } finally {
    client.dispose();
  }
});

test("a subagent progress tick notifies only that row's text subscriber, not the task view", () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  const reader = new ScopedThreadReader(f.detail, {} as never, new TranscriptBodies());
  const entries = reader.getSnapshot().entries;
  const view = vi.fn();
  const row = vi.fn();
  const other = vi.fn();
  reader.subscribe(view);
  f.detail.text.subscribe("node:a", row);
  f.detail.text.subscribe("node:b", other);
  const attemptId = createId("runAttempt");
  for (let tick = 1; tick <= 5; tick++)
    f.stream.receive({
      ...f.address,
      type: "host.live",
      handle: 1,
      liveBootId: "00000000-0000-4000-8000-000000000001",
      runId,
      attemptId,
      bindingGeneration: 1,
      streamId: "progress",
      itemId: "node:a",
      afterSequence: "1",
      update: {
        operation: "replace",
        text: `step ${tick}`,
        offset: 0,
        totalLength: 6,
        incomplete: false,
      },
    });
  expect(f.detail.text.get("node:a")?.text).toBe("step 5");
  expect(row).toHaveBeenCalledTimes(5);
  expect(other).not.toHaveBeenCalled();
  expect(view).not.toHaveBeenCalled();
  expect(reader.getSnapshot().entries).toBe(entries);
  reader.dispose();
});

test("reads handle frames through the stream its host.live named, repairs a gap by its identity and drops a replaced generation's handles", () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  const attempt = createId("runAttempt");
  const name = (address: typeof f.address, handle: number, text: string) =>
    f.stream.receive({
      ...address,
      type: "host.live",
      handle,
      liveBootId: "00000000-0000-4000-8000-000000000001",
      runId,
      attemptId: attempt,
      bindingGeneration: 1,
      streamId: "reply",
      itemId: "live-reply",
      afterSequence: "1",
      update: {
        operation: "replace",
        text,
        offset: 0,
        totalLength: text.length,
        incomplete: false,
      },
    });
  const text = () => f.detail.text.get("live-reply")?.text;
  name(f.address, 7, "Hel");
  expect(f.stream.receive({ type: "host.text", h: 7, o: 3, n: 5, t: "lo" })).toBe(true);
  expect(text()).toBe("Hello");
  // A handle this socket never named is not anyone's stream.
  expect(f.stream.receive({ type: "host.text", h: 99, o: 5, n: 6, t: "!" })).toBe(true);
  expect(text()).toBe("Hello");

  // A lost append leaves a gap; the repair asks for the stream the handle named.
  f.stream.receive({ type: "host.text", h: 7, o: 9, n: 12, t: "rld" });
  expect(f.sent.at(-1)).toEqual({
    type: "client.live.resync",
    subscriptionId: f.address.subscriptionId,
    generation: f.address.generation,
    runId,
    streamIds: ["reply"],
  });
  expect(text()).toBe("Hello");

  // A new generation mid-stream: the old handle no longer reaches the scope.
  f.stream.select(undefined);
  f.stream.select(threadScope);
  const subscribe = f.sent.findLast((frame) => frame.type === "client.subscribe");
  if (subscribe?.type !== "client.subscribe" || subscribe.scope.kind !== "thread")
    throw new Error("The detail did not resubscribe");
  const next = {
    subscriptionId: subscribe.subscriptionId as typeof f.address.subscriptionId,
    generation: subscribe.generation,
    scope: subscribe.scope,
  };
  expect(next.generation).toBeGreaterThan(f.address.generation);
  f.stream.receive({
    ...next,
    type: "host.snapshot",
    throughSequence: "1",
    snapshot: f.detailSnapshot().snapshot,
  });
  f.stream.receive({ ...next, type: "host.synchronized", throughSequence: "1" });
  f.stream.receive({ type: "host.text", h: 7, o: 0, n: 3, t: "old", incomplete: false });
  expect(text()).toBeUndefined();
  name(next, 8, "Hello wor");
  f.stream.receive({ type: "host.text", h: 8, o: 9, n: 11, t: "ld" });
  expect(text()).toBe("Hello world");
});

/** Open or Done tasks as `tasks.page` lists them: the full Thread view of each. */
function taskPageResponse(
  host: ReturnType<typeof scriptedHost>,
  rows: readonly {
    id: string;
    askedAt: string;
    doneAt?: string | null;
    title?: string;
    status?: "idle" | "running";
    doneReason?: "quiet";
    runQueued?: boolean;
  }[],
  window: { nextBefore: string | null; totalItems?: number },
) {
  const environmentId = new MockHostClient({ latencyMs: 0 }).getSnapshot().threads[0]!
    .environmentId;
  return Response.json({
    ok: true,
    data: {
      asOfSequence: host.head(),
      tasks: rows.map((row) => ({
        thread: {
          ...detailThread({
            ...task,
            id: row.id as typeof task.id,
            title: row.title ?? "Older",
            status: row.status ?? "idle",
            doneAt: (row.doneAt ?? null) as null,
          }).thread,
          doneReason: row.doneReason ?? null,
          askedAt: row.askedAt,
          environmentId,
        },
        lastReply: null,
        failure: null,
        ...(row.runQueued === undefined ? {} : { runQueued: row.runQueued }),
      })),
      window: {
        nextBefore: window.nextBefore,
        hasMore: window.nextBefore !== null,
        ...(window.totalItems === undefined ? {} : { totalItems: window.totalItems }),
        byteCount: 0,
        itemCount: rows.length,
      },
    },
  });
}

const minutesBefore = (minutes: number) =>
  new Date(Date.parse(time) - minutes * 60_000).toISOString();

describe("task lists from the shell and its pages", () => {
  it("refills the settled list when synchronization arrives, counting settled tasks only", async () => {
    // 25 newer Runs at work, and the Host's settled window of only three.
    const active = Array.from({ length: 25 }, (_, index) => ({
      ...task,
      id: createId("thread"),
      askedAt: minutesBefore(index),
    }));
    const settled = Array.from({ length: 3 }, (_, index) => ({
      ...task,
      id: createId("thread"),
      status: "idle" as const,
      askedAt: minutesBefore(100 + index),
    }));
    const host = scriptedHost({
      tasks: [...active, ...settled],
      lists: {
        activeTaskIds: active.map(({ id }) => id),
        recentTaskIds: settled.map(({ id }) => id),
        nextBefore: "settled-cursor",
      },
    });
    const pages: unknown[] = [];
    const client = scriptedClient(host, async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/tasks.page")) return new Response(null, { status: 404 });
      pages.push(JSON.parse(url.searchParams.get("input") ?? "{}"));
      return taskPageResponse(
        host,
        Array.from({ length: 22 }, (_, index) => ({
          id: createId("thread"),
          askedAt: minutesBefore(200 + index),
        })),
        { nextBefore: null, totalItems: 25 },
      );
    });
    try {
      await client.load();
      await vi.waitFor(() => expect(pages, "the settled list was never refilled").toHaveLength(1));
      expect(pages[0]).toEqual({ before: "settled-cursor", limit: 50 });
      await vi.waitFor(() => expect(client.getSnapshot().tasks?.entries).toHaveLength(50));
    } finally {
      client.dispose();
    }
  });

  it("lists every running task, paging those past the shell's active window", async () => {
    const shown = Array.from({ length: 2 }, (_, index) => ({
      ...task,
      id: createId("thread"),
      askedAt: minutesBefore(index),
    }));
    const host = scriptedHost({
      tasks: shown,
      lists: { activeTaskIds: shown.map(({ id }) => id), activeNextBefore: "active-0" },
    });
    const pages: unknown[] = [];
    const more = Array.from({ length: 3 }, (_, index) => ({
      id: createId("thread"),
      askedAt: minutesBefore(10 + index),
      status: "running" as const,
    }));
    const client = scriptedClient(host, async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/tasks.page")) return new Response(null, { status: 404 });
      pages.push(JSON.parse(url.searchParams.get("input") ?? "{}"));
      return taskPageResponse(host, more, { nextBefore: null, totalItems: 5 });
    });
    try {
      await client.load();
      await vi.waitFor(() =>
        expect(client.getSnapshot().activeTasks, "the active page never arrived").toHaveLength(5),
      );
      expect(pages).toEqual([{ active: true, before: "active-0", limit: 50 }]);
    } finally {
      client.dispose();
    }
  });

  it("keeps the newest tasks however many pages are loaded, and rereads them after a shell repair", async () => {
    const settled = Array.from({ length: 25 }, (_, index) => ({
      ...task,
      id: createId("thread"),
      status: "idle" as const,
      askedAt: minutesBefore(index),
    }));
    const lists = { recentTaskIds: settled.map(({ id }) => id), nextBefore: "page-0" };
    const host = scriptedHost({ tasks: settled, lists });
    const reads: string[] = [];
    const pageIds = Array.from({ length: 300 }, () => createId("thread"));
    const client = scriptedClient(host, async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/tasks.page")) return new Response(null, { status: 404 });
      const before = JSON.parse(url.searchParams.get("input") ?? "{}").before as string;
      reads.push(before);
      const page = Number(before.split("-")[1]);
      return taskPageResponse(
        host,
        Array.from({ length: 25 }, (_, index) => ({
          id: pageIds[page * 25 + index]!,
          askedAt: minutesBefore(1_000 + page * 25 + index),
        })),
        { nextBefore: page < 11 ? `page-${page + 1}` : null, totalItems: 325 },
      );
    });
    try {
      await client.load();
      for (let page = 0; page < 12; page++) await client.loadEarlierTasks();
      const ids = () => client.getSnapshot().tasks?.entries.map(({ thread }) => thread.id) ?? [];
      expect(ids()).toHaveLength(325);
      expect(ids()[0]).toBe(settled[0]!.id);
      // The Host repairs the shell inline: the loaded window stays on screen and is read again.
      reads.length = 0;
      host.repairShell(settled, lists);
      expect(ids()).toHaveLength(325);
      await vi.waitFor(() =>
        expect(reads, "the loaded window was not read again").toEqual(
          Array.from({ length: 12 }, (_, page) => `page-${page}`),
        ),
      );
      await vi.waitFor(() => expect(ids()).toHaveLength(325));
    } finally {
      client.dispose();
    }
  });

  it("pages every running task past the shell's window, however many continuations", async () => {
    const shown = { ...task, id: createId("thread") };
    const host = scriptedHost({
      tasks: [shown],
      lists: { activeTaskIds: [shown.id], activeNextBefore: "active-0" },
    });
    const reads: string[] = [];
    const client = scriptedClient(host, async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/tasks.page")) return new Response(null, { status: 404 });
      const before = JSON.parse(url.searchParams.get("input") ?? "{}").before as string;
      reads.push(before);
      const page = Number(before.split("-")[1]);
      return taskPageResponse(
        host,
        Array.from({ length: 3 }, (_, index) => ({
          id: createId("thread"),
          askedAt: minutesBefore(10 + page * 3 + index),
          status: "running" as const,
          // A Run waits on its account getting ready: the page says so beside the Thread.
          runQueued: index === 0,
        })),
        { nextBefore: page < 2 ? `active-${page + 1}` : null, totalItems: 10 },
      );
    });
    try {
      await client.load();
      await vi.waitFor(() =>
        expect(client.getSnapshot().activeTasks, "the active pages stopped early").toHaveLength(10),
      );
      expect(reads).toEqual(["active-0", "active-1", "active-2"]);
      expect(
        client.getSnapshot().activeTasks.filter(({ thread }) => thread.runQueued),
        "a continued task lost its queued-account reason",
      ).toHaveLength(3);
    } finally {
      client.dispose();
    }
  });

  it("keeps the open and active lists right as pushed rows change, move and leave, one at a time", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      ...task,
      id: createId("thread"),
      status: (index % 3 === 0 ? "running" : "idle") as "running" | "idle",
      askedAt: minutesBefore(index * 2),
    }));
    const lists = {
      recentTaskIds: rows.filter(({ status }) => status !== "running").map(({ id }) => id),
      activeTaskIds: rows.filter(({ status }) => status === "running").map(({ id }) => id),
    };
    const host = scriptedHost({ tasks: rows, lists });
    const client = scriptedClient(host);
    let seed = 5;
    const next = (limit: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % limit;
    };
    const statuses = ["running", "waiting", "idle", "failed"] as const;
    type Row = Omit<(typeof rows)[number], "status" | "doneAt" | "revision"> & {
      readonly status: string;
      readonly doneAt: string | null;
      readonly revision: string;
    };
    const current = new Map<string, Row>(rows.map((row) => [row.id, row]));
    try {
      await client.load();
      for (let step = 0; step < 150; step++) {
        const id = [...current.keys()][next(current.size)]!;
        const row = current.get(id)!;
        if (current.size > 5 && next(8) === 0) {
          // Archived or deleted: the Host removes the row.
          current.delete(id);
          host.commit([{ entityKind: "task", entityId: id, operation: "remove" } as never]);
          continue;
        }
        const revision = String(10 + step);
        const status = statuses[next(statuses.length)]!;
        const changed = {
          ...row,
          revision,
          status,
          // Some changes move the task in the order, as a new ask would.
          askedAt: next(4) === 0 ? minutesBefore(next(200)) : row.askedAt,
          // Only a settled task can be Done.
          doneAt: (status === "idle" || status === "failed") && next(4) === 0 ? time : null,
        };
        current.set(id, changed);
        host.commit([upsert("task", id, changed)]);
        const snapshot = client.getSnapshot();
        const open = snapshot.tasks!.entries.map(({ thread }) => thread);
        const label = `step ${step}`;
        // Sorted in task order, with no task twice.
        for (let index = 1; index < open.length; index++)
          expect(
            open[index - 1]!.askedAt > open[index]!.askedAt ||
              (open[index - 1]!.askedAt === open[index]!.askedAt &&
                open[index - 1]!.id > open[index]!.id),
            label,
          ).toBe(true);
        // Exactly the open tasks the client holds.
        const expected = [...current.values()]
          .filter(({ doneAt }) => doneAt === null)
          .map(({ id: task }) => task)
          .sort();
        expect(open.map(({ id: task }) => task).sort(), label).toEqual(expected);
        expect(
          snapshot.activeTasks.map(({ thread }) => thread.id),
          label,
        ).toEqual(
          open
            .filter(({ status }) => status === "running" || status === "waiting")
            .map(({ id: task }) => task),
        );
      }
    } finally {
      client.dispose();
    }
  });

  it("a task page dropped for a newer cut leaves no trace in the task's state", async () => {
    const settled = Array.from({ length: 25 }, (_, index) => ({
      ...task,
      id: createId("thread"),
      status: "idle" as const,
      askedAt: minutesBefore(index),
    }));
    const lists = { recentTaskIds: settled.map(({ id }) => id), nextBefore: "page-0" };
    const host = scriptedHost({ tasks: settled, lists });
    const older = createId("thread");
    const answers: ((response: Response) => void)[] = [];
    const client = scriptedClient(host, async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/tasks.page")) return new Response(null, { status: 404 });
      return new Promise<Response>((resolve) => answers.push(resolve));
    });
    /** The page, answered as of `asOf`: the older task at work, or settled. */
    const page = async (asOf: string, status: "running" | "idle") => {
      const response = taskPageResponse(
        host,
        [{ id: older, askedAt: minutesBefore(1_000), status }],
        { nextBefore: null, totalItems: 1 },
      );
      const body = (await response.json()) as { data: { asOfSequence: string } };
      body.data.asOfSequence = asOf;
      return Response.json(body);
    };
    try {
      await client.load();
      const loading = client.loadEarlierTasks();
      await vi.waitFor(() => expect(answers).toHaveLength(1));
      host.repairShell(settled, lists);
      // An answer read against the replaced cut, far ahead of the next: it must not be recorded.
      answers[0]!(await page("900", "running"));
      await vi.waitFor(() => expect(answers).toHaveLength(2));
      answers[1]!(await page(host.head(), "idle"));
      await loading;
      const shown = client.getSnapshot().tasks?.entries.find(({ thread }) => thread.id === older);
      expect(shown?.thread.status, "a dropped page's state outranked the current one").toBe("idle");
    } finally {
      client.dispose();
    }
  });

  it("a Load earlier in flight across a shell repair still reads to the depth asked for", async () => {
    const settled = Array.from({ length: 25 }, (_, index) => ({
      ...task,
      id: createId("thread"),
      status: "idle" as const,
      askedAt: minutesBefore(index),
    }));
    const lists = { recentTaskIds: settled.map(({ id }) => id), nextBefore: "page-0" };
    const host = scriptedHost({ tasks: settled, lists });
    const answers: ((response: Response) => void)[] = [];
    const pageIds = Array.from({ length: 100 }, () => createId("thread"));
    const page = (index: number) =>
      taskPageResponse(
        host,
        Array.from({ length: 25 }, (_, row) => ({
          id: pageIds[index * 25 + row]!,
          askedAt: minutesBefore(1_000 + index * 25 + row),
        })),
        { nextBefore: index < 3 ? `page-${index + 1}` : null, totalItems: 125 },
      );
    const client = scriptedClient(host, async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/tasks.page")) return new Response(null, { status: 404 });
      return new Promise<Response>((resolve) => answers.push(resolve));
    });
    try {
      await client.load();
      const loading = client.loadEarlierTasks();
      await vi.waitFor(() => expect(answers).toHaveLength(1));
      host.repairShell(settled, lists);
      answers[0]!(page(0));
      // The page read before the repair is read again from the new cut, to the same depth.
      for (let index = 0; index < 2; index++) {
        await vi.waitFor(() => expect(answers.length).toBe(index + 2));
        answers[index + 1]!(page(index));
      }
      await loading;
      expect(client.getSnapshot().tasks?.entries).toHaveLength(75);
    } finally {
      client.dispose();
    }
  });

  it("Done follows pushed moves under any interleaving, and its count is the Host's", async () => {
    const quiet = { ...task, id: createId("thread"), status: "idle" as const };
    const older = {
      id: createId("thread"),
      askedAt: minutesBefore(500),
      doneAt: minutesBefore(400),
    };
    const host = scriptedHost({ tasks: [quiet], lists: { recentTaskIds: [quiet.id] } });
    const answers: ((response: Response) => void)[] = [];
    const client = scriptedClient(host, async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/tasks.page")) return new Response(null, { status: 404 });
      return new Promise<Response>((resolve) => answers.push(resolve));
    });
    const done = () => Object.values(client.getSnapshot().doneTasks)[0];
    try {
      await client.load();
      const opening = client.loadDoneTasks();
      await vi.waitFor(() => expect(answers, "the Done page was never read").toHaveLength(1));
      // The task goes quietly to Done after the page's cut, before its answer arrives.
      host.commit([
        upsert("task", quiet.id, { ...quiet, revision: "2", doneAt: time, doneReason: "quiet" }),
      ]);
      answers[0]!(taskPageResponse(host, [older], { nextBefore: null, totalItems: 1 }));
      // The page from before the move is not shown: Done is read again.
      await vi.waitFor(() => expect(answers, "Done was never read again").toHaveLength(2));
      expect(done()).toBeUndefined();
      const current = [
        { id: quiet.id, askedAt: quiet.askedAt, doneAt: time, doneReason: "quiet" as const },
        older,
      ];
      answers[1]!(taskPageResponse(host, current, { nextBefore: null, totalItems: 2 }));
      await opening;
      expect(done()!.entries.find(({ thread }) => thread.id === quiet.id)?.thread.doneReason).toBe(
        "quiet",
      );
      expect(done()!.window.totalItems).toBe(2);

      // An edit to a Done task moves nothing: no read, and the count stays the Host's two.
      host.commit([
        upsert("task", older.id, {
          ...task,
          id: older.id,
          status: "idle",
          revision: "3",
          askedAt: older.askedAt,
          doneAt: older.doneAt,
          title: "Renamed",
        }),
      ]);
      expect(done()!.window.totalItems).toBe(2);
      // Reopened, a task this client holds leaves the Done rows at once. The count is the Host's
      // last answer until the Host is asked again, once the pushes rest.
      host.commit([upsert("task", quiet.id, { ...quiet, revision: "4", doneAt: null })]);
      expect(done()!.entries.some(({ thread }) => thread.id === quiet.id)).toBe(false);
      expect(done()!.window.totalItems).toBe(2);
      await vi.waitFor(() => expect(answers).toHaveLength(3), { timeout: 2_000 });
      answers[2]!(taskPageResponse(host, [older], { nextBefore: null, totalItems: 1 }));
      await vi.waitFor(() => expect(done()!.window.totalItems).toBe(1));
    } finally {
      client.dispose();
    }
  });
  it("follows off-page moves in and out of Done in its count, reading the count once the pushes rest", async () => {
    const held = Array.from({ length: 50 }, (_, index) => ({
      id: createId("thread"),
      askedAt: minutesBefore(500 + index),
      doneAt: minutesBefore(400 + index),
    }));
    // Done tasks this client never loaded: one past the held page, one open the Host never sent.
    const offPage = { ...task, id: createId("thread"), status: "idle" as const };
    const host = scriptedHost({ tasks: [task], lists: { recentTaskIds: [task.id] } });
    const reads: { input: { limit?: number }; resolve: (response: Response) => void }[] = [];
    const client = scriptedClient(host, async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/tasks.page")) return new Response(null, { status: 404 });
      const query = JSON.parse(url.searchParams.get("input") ?? "{}") as { limit?: number };
      return new Promise<Response>((resolve) => reads.push({ input: query, resolve }));
    });
    const done = () => Object.values(client.getSnapshot().doneTasks)[0];
    try {
      await client.load();
      const opening = client.loadDoneTasks();
      await vi.waitFor(() => expect(reads).toHaveLength(1));
      reads[0]!.resolve(taskPageResponse(host, held, { nextBefore: "done-1", totalItems: 60 }));
      await opening;
      expect(done()!.window.totalItems).toBe(60);
      vi.useFakeTimers();

      // Reopened elsewhere, a Done task past the held page: the row alone does not say it was Done.
      host.commit([upsert("task", offPage.id, { ...offPage, revision: "2", doneAt: null })]);
      // Archived elsewhere, another one: an id-only remove.
      host.commit([
        { entityKind: "task", entityId: createId("thread"), operation: "remove" } as never,
      ]);
      await vi.advanceTimersByTimeAsync(999);
      expect(reads, "the count was read before the pushes rested").toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(reads).toHaveLength(2);
      expect(reads[1]!.input.limit).toBe(1);
      reads[1]!.resolve(
        taskPageResponse(host, held.slice(0, 1), { nextBefore: "x", totalItems: 58 }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(done()!.window.totalItems, "an off-page reopen and archive left the badge stale").toBe(
        58,
      );

      // Done just now: the row is placed in the held list at once; the number still waits for the
      // Host, which here already counted it when its read took its cut (HTTP ahead of the push).
      host.commit([
        upsert("task", offPage.id, {
          ...offPage,
          revision: "3",
          doneAt: time,
          doneReason: "quiet",
        }),
      ]);
      expect(done()!.entries[0]!.thread.id).toBe(offPage.id);
      expect(done()!.window.totalItems).toBe(58);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reads).toHaveLength(3);
      reads[2]!.resolve(
        taskPageResponse(host, held.slice(0, 1), { nextBefore: "x", totalItems: 59 }),
      );
      await vi.advanceTimersByTimeAsync(0);
      // The number always equals the Host's last answer: no push is added on top of it.
      expect(done()!.window.totalItems).toBe(59);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(done()!.window.totalItems).toBe(59);
      // C4: a held row reopened elsewhere, whose push arrives after a count that already left it out.
      reads.length = 0;
      host.commit([
        upsert("task", held[1]!.id, {
          ...task,
          id: held[1]!.id,
          status: "idle",
          revision: "4",
          askedAt: held[1]!.askedAt,
          doneAt: null,
        }),
      ]);
      expect(done()!.entries.some(({ thread }) => thread.id === held[1]!.id)).toBe(false);
      expect(done()!.window.totalItems, "a push was taken off the Host's count").toBe(59);
      await vi.advanceTimersByTimeAsync(1_000);
      reads[0]!.resolve(
        taskPageResponse(host, held.slice(0, 1), { nextBefore: "x", totalItems: 58 }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(done()!.window.totalItems).toBe(58);
    } finally {
      client.dispose();
    }
  });

  it("the Done count is the Host's answer at the latest sequence, whatever order two reads and a push arrive in", async () => {
    // Done read at sequence 1 holds 10; a push at sequence 2 makes it 9 on the Host.
    const rows = Array.from({ length: 50 }, (_, index) => ({
      id: createId("thread"),
      askedAt: minutesBefore(500 + index),
      doneAt: minutesBefore(400 + index),
    }));
    const cases = [];
    for (const firstPageCut of [1, 2])
      for (const firstPageAnswersFirst of [true, false])
        for (const reopenBeforePush of [true, false])
          cases.push({ firstPageCut, firstPageAnswersFirst, reopenBeforePush });
    for (const { firstPageCut, firstPageAnswersFirst, reopenBeforePush } of cases) {
      const label = JSON.stringify({ firstPageCut, firstPageAnswersFirst, reopenBeforePush });
      const host = scriptedHost({ tasks: [task], lists: { recentTaskIds: [task.id] } });
      const reads: { input: { limit?: number }; resolve: (response: Response) => void }[] = [];
      const client = scriptedClient(host, async (input) => {
        const url = new URL(String(input));
        if (!url.pathname.endsWith("/tasks.page")) return new Response(null, { status: 404 });
        const query = JSON.parse(url.searchParams.get("input") ?? "{}") as { limit?: number };
        return new Promise<Response>((resolve) => reads.push({ input: query, resolve }));
      });
      /** The Host's answer read at `cut`: the count is 10 before the push, 9 after. */
      const answer = async (cut: number) => {
        const response = taskPageResponse(host, rows, {
          nextBefore: "done-1",
          totalItems: cut >= 2 ? 9 : 10,
        });
        const body = (await response.json()) as { data: { asOfSequence: string } };
        body.data.asOfSequence = String(cut);
        return Response.json(body);
      };
      const done = () => Object.values(client.getSnapshot().doneTasks)[0];
      try {
        await client.load();
        const opening = client.loadDoneTasks();
        await vi.waitFor(() => expect(reads).toHaveLength(1));
        reads[0]!.resolve(await answer(1));
        await opening;
        vi.useFakeTimers();
        const reopened = createId("thread");
        const push = () =>
          host.commit([
            upsert("task", reopened, { ...task, id: reopened, revision: "2", doneAt: null }),
          ]);
        // The person opens Done again (a first page), before or after the push arrives.
        if (!reopenBeforePush) push();
        void client.loadDoneTasks();
        if (reopenBeforePush) push();
        await vi.advanceTimersByTimeAsync(1_000);
        const firstPage = reads.find(({ input }, index) => index > 0 && input.limit !== 1)!;
        const count = reads.find(({ input }) => input.limit === 1)!;
        expect(firstPage && count, `${label}: both reads should be out`).toBeTruthy();
        const order = firstPageAnswersFirst
          ? [
              () => firstPage.resolve(answer(firstPageCut) as never),
              () => count.resolve(answer(2) as never),
            ]
          : [
              () => count.resolve(answer(2) as never),
              () => firstPage.resolve(answer(firstPageCut) as never),
            ];
        for (const step of order) {
          step();
          await vi.advanceTimersByTimeAsync(0);
        }
        await vi.advanceTimersByTimeAsync(5_000);
        expect(done()!.window.totalItems, label).toBe(9);
      } finally {
        client.dispose();
        vi.useRealTimers();
      }
    }
  });

  it("a new shell cut drops the held count's horizon, so a restored Host's lower count is taken", async () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
      id: createId("thread"),
      askedAt: minutesBefore(500 + index),
      doneAt: minutesBefore(400 + index),
    }));
    const lists = { recentTaskIds: [task.id] };
    const host = scriptedHost({ tasks: [task], lists });
    const reads: { input: { limit?: number }; resolve: (response: Response) => void }[] = [];
    const client = scriptedClient(host, async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/tasks.page")) return new Response(null, { status: 404 });
      const query = JSON.parse(url.searchParams.get("input") ?? "{}") as { limit?: number };
      return new Promise<Response>((resolve) => reads.push({ input: query, resolve }));
    });
    const answer = async (asOf: string, count: number) => {
      const response = taskPageResponse(host, rows, { nextBefore: "done-1", totalItems: count });
      const body = (await response.json()) as { data: { asOfSequence: string } };
      body.data.asOfSequence = asOf;
      return Response.json(body);
    };
    const done = () => Object.values(client.getSnapshot().doneTasks)[0];
    try {
      await client.load();
      const opening = client.loadDoneTasks();
      await vi.waitFor(() => expect(reads).toHaveLength(1));
      // Read through 150 while the socket was behind.
      reads[0]!.resolve(await answer("150", 40));
      await opening;
      expect(done()!.window.totalItems).toBe(40);
      // The Host is restored, same Deployment and epoch, to 120 with different Done membership,
      // and sends its new cut.
      host.repairShell([task], lists);
      // Done is read again in the new cut; the restored Host's count at 120 is the one to show.
      await vi.waitFor(() => expect(reads.length).toBeGreaterThan(1), { timeout: 3_000 });
      for (const read of reads.slice(1)) read.resolve(await answer("120", 33));
      await vi.waitFor(() =>
        expect(done()!.window.totalItems, "the restored Host's count was refused").toBe(33),
      );
    } finally {
      client.dispose();
    }
  });

  it("a Done continuation never sets the count: a fresher count read in between stands", async () => {
    const held = Array.from({ length: 50 }, (_, index) => ({
      id: createId("thread"),
      askedAt: minutesBefore(500 + index),
      doneAt: minutesBefore(400 + index),
    }));
    const older = Array.from({ length: 50 }, (_, index) => ({
      id: createId("thread"),
      askedAt: minutesBefore(900 + index),
      doneAt: minutesBefore(800 + index),
    }));
    const host = scriptedHost({ tasks: [task], lists: { recentTaskIds: [task.id] } });
    const reads: {
      input: { limit?: number; before?: string };
      resolve: (response: Response) => void;
    }[] = [];
    const client = scriptedClient(host, async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/tasks.page")) return new Response(null, { status: 404 });
      const query = JSON.parse(url.searchParams.get("input") ?? "{}") as {
        limit?: number;
        before?: string;
      };
      return new Promise<Response>((resolve) => reads.push({ input: query, resolve }));
    });
    const done = () => Object.values(client.getSnapshot().doneTasks)[0];
    try {
      await client.load();
      const opening = client.loadDoneTasks();
      await vi.waitFor(() => expect(reads).toHaveLength(1));
      reads[0]!.resolve(taskPageResponse(host, held, { nextBefore: "done-1", totalItems: 100 }));
      await opening;
      expect(done()!.window.totalItems).toBe(100);
      vi.useFakeTimers();
      // An off-page task is reopened elsewhere: the count is read again once the pushes rest.
      const reopened = createId("thread");
      host.commit([
        upsert("task", reopened, { ...task, id: reopened, revision: "2", doneAt: null }),
      ]);
      // Load earlier starts before that count read answers; its page is held.
      void client.loadEarlierDoneTasks();
      await vi.advanceTimersByTimeAsync(1_000);
      const continuation = reads.find(({ input }) => input.before === "done-1")!;
      const count = reads.find(({ input }) => input.limit === 1)!;
      expect(continuation && count, "both reads should be out").toBeTruthy();
      count.resolve(taskPageResponse(host, held.slice(0, 1), { nextBefore: "x", totalItems: 99 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(done()!.window.totalItems).toBe(99);
      // The continuation answers after it, with no count of its own.
      continuation.resolve(taskPageResponse(host, older, { nextBefore: null }));
      await vi.advanceTimersByTimeAsync(0);
      expect(done()!.entries.length).toBe(100);
      expect(done()!.window.totalItems, "a continuation put back an older count").toBe(99);
    } finally {
      client.dispose();
    }
  });

  it("keeps Done's count from its first page; a continuation does not carry one", async () => {
    const host = scriptedHost({ tasks: [task], lists: { recentTaskIds: [task.id] } });
    const rows = Array.from({ length: 3 }, (_, index) => ({
      id: createId("thread"),
      askedAt: minutesBefore(500 + index),
      doneAt: minutesBefore(400 + index),
    }));
    const client = scriptedClient(host, async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/tasks.page")) return new Response(null, { status: 404 });
      const before = JSON.parse(url.searchParams.get("input") ?? "{}").before as string | undefined;
      return before
        ? taskPageResponse(host, rows.slice(2), { nextBefore: null })
        : taskPageResponse(host, rows.slice(0, 2), { nextBefore: "page-1", totalItems: 3 });
    });
    const done = () => Object.values(client.getSnapshot().doneTasks)[0];
    try {
      await client.load();
      await client.loadDoneTasks();
      await vi.waitFor(() => expect(done()?.entries).toHaveLength(3));
      expect(done()!.window.totalItems).toBe(3);
    } finally {
      client.dispose();
    }
  });
});

test("after a repair the reader reads again the latest page, its loaded overlay pages and the queue tail", async () => {
  const f = fixture();
  f.syncShell();
  const base = f.detailSnapshot();
  f.stream.receive({
    ...base,
    snapshot: { ...base.snapshot, nextBefore: null, overlayCursors: { requests: "more" } },
  });
  f.stream.receive({ ...f.address, type: "host.synchronized", throughSequence: "1" });
  const request = (id: string) => ({
    id,
    revision: "1",
    status: "pending",
    kind: "person.question",
    title: "Question",
    threadId,
  });
  const extra = createId("request");
  const missing = createId("message");
  const rpc = {
    "thread.overlays.page": vi.fn(async () => ({
      ok: true,
      data: {
        threadId,
        nodeId: null,
        kind: "requests",
        revision: "1",
        entries: [request(extra)],
        next: null,
      },
    })),
    "thread.items.page": vi.fn(async () => ({
      ok: true,
      data: {
        kind: "page",
        threadId,
        nodeId: null,
        revision: "2",
        items: [item],
        hasMore: false,
        nextBefore: null,
        nextAfter: null,
      },
    })),
    "thread.inputQueue.get": vi.fn(async () => ({
      ok: true,
      data: { threadId, revision: "2", paused: false, steerRunId: null, items: [] },
    })),
    "thread.requests.list": vi.fn(async () => ({
      ok: true,
      data: { threadId, reviewedRevisions: {}, requests: [] },
    })),
  } as unknown as import("@opensteer/protocol").HostApiClient;
  const reader = new ScopedThreadReader(f.detail, rpc, new TranscriptBodies());
  try {
    await reader.loadMoreOverlays("requests");
    expect(f.detail.transcript.getSnapshot().snapshot?.pendingRequests.map(({ id }) => id)).toEqual(
      [extra],
    );
    // The Host's repair is centred on an older position and its queue had no room for one entry.
    f.stream.receive({
      ...base,
      throughSequence: "2",
      snapshot: {
        ...base.snapshot,
        nextBefore: null,
        nextAfter: { ...cursor, beforeId: item.id },
        anchorItemId: item.id,
        overlayCursors: { requests: "more" },
        queue: { revision: "2", runs: [], paused: false, steerRunId: null, inputs: [missing] },
        inputQueue: [],
      },
    });
    expect(f.detail.transcript.getSnapshot().snapshot?.pendingRequests).toEqual([]);
    await vi.waitFor(() => {
      expect(rpc["thread.items.page"]).toHaveBeenCalledWith({ threadId }, expect.anything());
      expect(rpc["thread.overlays.page"]).toHaveBeenCalledTimes(2);
      expect(rpc["thread.inputQueue.get"]).toHaveBeenCalledTimes(1);
      expect(f.detail.transcript.getSnapshot().newest).toBe(true);
    });
  } finally {
    reader.dispose();
  }
});

test("a stream sent again after a live reset replaces the text already held", () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  const attempt = createId("runAttempt");
  const frame = (update: object) => ({
    ...f.address,
    type: "host.live" as const,
    liveBootId: "00000000-0000-4000-8000-000000000001",
    runId,
    attemptId: attempt,
    bindingGeneration: 1,
    handle: 9,
    streamId: "reply",
    itemId: "live-reply",
    afterSequence: "1",
    update,
  });
  f.stream.receive(frame({ operation: "append", text: "Hello", offset: 0, totalLength: 5 }));
  // Frames were dropped under pressure; the Host sends the whole open stream again.
  const resent = "Hello, the rest of the reply";
  f.stream.receive(
    frame({
      operation: "replace",
      text: resent,
      offset: 0,
      totalLength: resent.length,
      incomplete: false,
    }),
  );
  expect(f.detail.text.get("live-reply")?.text).toBe(resent);
  // The same text sent once more changes nothing and asks for nothing.
  const sent = f.sent.length;
  f.stream.receive(
    frame({
      operation: "replace",
      text: resent,
      offset: 0,
      totalLength: resent.length,
      incomplete: false,
    }),
  );
  expect(f.detail.text.get("live-reply")?.text).toBe(resent);
  f.stream.receive(
    frame({
      operation: "append",
      text: "!",
      offset: resent.length,
      totalLength: resent.length + 1,
    }),
  );
  expect(f.detail.text.get("live-reply")?.text).toBe(`${resent}!`);
  expect(f.sent.slice(sent).some((message) => message.type === "client.live.resync")).toBe(false);
});

test("an answered secret form is sent and never kept in the client's state", async () => {
  const host = scriptedHost();
  const commands: unknown[] = [];
  const client = scriptedClient(host, async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/commands.dispatch")) {
      commands.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, data: { type: "request.respond", wasDuplicate: false } });
    }
    return new Response(null, { status: 404 });
  });
  try {
    client.activateThread(threadId);
    await client.load();
    await client.dispatch({
      idempotencyKey: "request-secret:test",
      expectedRevision: "1",
      requestId,
      response: { answers: { token: ["do-not-retain"] }, kind: "form" },
      type: "request.respond",
    });
    expect(JSON.stringify(commands)).toContain("do-not-retain");
    expect(JSON.stringify(client.getSnapshot())).not.toContain("do-not-retain");
    expect(JSON.stringify(client.getThreadTranscript(threadId)?.getSnapshot())).not.toContain(
      "do-not-retain",
    );
  } finally {
    client.dispose();
  }
});

describe("reads that race a repair", () => {
  /** A synced detail whose queue lists `inputs`, with `entries` carried, and an overlay cursor. */
  function racing(inputs: string[], entries: string[]) {
    const f = fixture();
    f.syncShell();
    const base = f.detailSnapshot();
    const cut = (throughSequence: string, extra: object = {}) => ({
      ...base,
      throughSequence,
      snapshot: {
        ...base.snapshot,
        nextBefore: null,
        overlayCursors: { tools: "tools-1" },
        queue: {
          revision: throughSequence,
          runs: [],
          paused: true,
          steerRunId: null,
          inputs: inputs as never[],
        },
        inputQueue: entries.map((id) => waitingEntry(id, `v${throughSequence}`)),
        ...extra,
      },
    });
    f.stream.receive(cut("1"));
    f.stream.receive({ ...f.address, type: "host.synchronized", throughSequence: "1" });
    return { ...f, cut };
  }
  function waitingEntry(id: string, preview: string, canSteer = false) {
    return {
      message: {
        id,
        revision: 0,
        author: { kind: "human", principalId: viewerId, displayName: "Owner" },
        createdAt: time,
        preview,
        truncated: false,
      },
      input: { messageId: id, state: "pending", queueRank: "1" },
      ask: null,
      canEdit: true,
      canCancel: true,
      canMove: true,
      canSteer,
      lease: null,
    } as never;
  }
  const held = <T>() => {
    const answers: ((value: T) => void)[] = [];
    const fn = vi.fn(() => new Promise<T>((resolve) => answers.push(resolve)));
    return { fn, answers };
  };

  it("a queue read taken before a repair installs nothing, and the current cut is read again", async () => {
    const head = createId("message");
    const tail = createId("message");
    const f = racing([head, tail], [head]);
    const queue = held<unknown>();
    const reader = new ScopedThreadReader(
      f.detail,
      { "thread.inputQueue.get": queue.fn } as never,
      new TranscriptBodies(),
    );
    try {
      await vi.waitFor(() => expect(queue.fn).toHaveBeenCalledTimes(1));
      // Another device steers the tail; the Host repairs with a cut that still omits it.
      f.stream.receive(f.cut("2"));
      const answer = (preview: string, canSteer: boolean) => ({
        ok: true,
        data: {
          threadId,
          revision: "2",
          paused: true,
          steerRunId: null,
          items: [waitingEntry(head, preview), waitingEntry(tail, preview, canSteer)],
        },
      });
      queue.answers[0]!(answer("old", false));
      await vi.waitFor(() =>
        expect(queue.fn, "the current cut's tail was never read").toHaveBeenCalledTimes(2),
      );
      expect(f.detail.transcript.getSnapshot().queueEntries.has(tail)).toBe(false);
      queue.answers[1]!(answer("new", true));
      await vi.waitFor(() =>
        expect(reader.getSnapshot().inputQueue?.items.at(-1)?.canSteer).toBe(true),
      );
    } finally {
      reader.dispose();
    }
  });

  it("a queue read answered as of an earlier cut than the one installed is not installed, and is read again", async () => {
    vi.useFakeTimers();
    const head = createId("message");
    const tail = createId("message");
    const f = racing([head, tail], [head]);
    f.stream.receive(f.cut("2"));
    const queue = held<unknown>();
    const reader = new ScopedThreadReader(
      f.detail,
      { "thread.inputQueue.get": queue.fn } as never,
      new TranscriptBodies(),
    );
    const answer = (asOfSequence: string) => ({
      ok: true,
      data: {
        threadId,
        revision: asOfSequence,
        asOfSequence,
        paused: true,
        steerRunId: null,
        items: [waitingEntry(head, "v"), waitingEntry(tail, `as of ${asOfSequence}`)],
      },
    });
    try {
      await vi.waitFor(() => expect(queue.fn).toHaveBeenCalledTimes(1));
      queue.answers[0]!(answer("1"));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.detail.transcript.getSnapshot().queueEntries.has(tail)).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(queue.fn, "the stale queue was never read again").toHaveBeenCalledTimes(2);
      queue.answers[1]!(answer("2"));
      await vi.advanceTimersByTimeAsync(0);
      expect(reader.getSnapshot().inputQueue?.items.at(-1)?.message.preview).toBe("as of 2");
    } finally {
      reader.dispose();
    }
  });

  it("two queue reads each overtaken by a repair install nothing; the third, current, fills the tail", async () => {
    const head = createId("message");
    const tail = createId("message");
    const f = racing([head, tail], [head]);
    const queue = held<unknown>();
    const reader = new ScopedThreadReader(
      f.detail,
      { "thread.inputQueue.get": queue.fn } as never,
      new TranscriptBodies(),
    );
    const answer = (preview: string, revision: string) => ({
      ok: true,
      data: {
        threadId,
        revision,
        asOfSequence: revision,
        paused: true,
        steerRunId: null,
        items: [waitingEntry(head, preview), waitingEntry(tail, preview)],
      },
    });
    try {
      await vi.waitFor(() => expect(queue.fn).toHaveBeenCalledTimes(1));
      f.stream.receive(f.cut("2"));
      queue.answers[0]!(answer("first", "1"));
      await vi.waitFor(() => expect(queue.fn).toHaveBeenCalledTimes(2));
      // Overtaken again before it answers.
      f.stream.receive(f.cut("3"));
      queue.answers[1]!(answer("second", "2"));
      await vi.waitFor(() => expect(queue.fn).toHaveBeenCalledTimes(3));
      expect(f.detail.transcript.getSnapshot().queueEntries.has(tail)).toBe(false);
      queue.answers[2]!(answer("third", "3"));
      await vi.waitFor(() =>
        expect(reader.getSnapshot().inputQueue?.items.at(-1)?.message.preview).toBe("third"),
      );
    } finally {
      reader.dispose();
    }
  });

  it("an overlay page in flight across a repair still leaves the loaded pages read again", async () => {
    const f = racing([], []);
    const pages = held<unknown>();
    const reader = new ScopedThreadReader(
      f.detail,
      { "thread.overlays.page": pages.fn } as never,
      new TranscriptBodies(),
    );
    const tool = (id: string) => ({
      ...item,
      kind: "tool",
      id,
      toolCallId: id,
      messageId: undefined,
      view: { status: "running" },
    });
    const page = (id: string) => ({
      ok: true,
      data: {
        threadId,
        nodeId: null,
        kind: "tools",
        revision: "1",
        entries: [tool(id)],
        next: null,
      },
    });
    try {
      const loading = reader.loadMoreOverlays("tools");
      await vi.waitFor(() => expect(pages.fn).toHaveBeenCalledTimes(1));
      f.stream.receive(f.cut("2"));
      pages.answers[0]!(page("stale"));
      await vi.waitFor(() =>
        expect(pages.fn, "the loaded page was never read again").toHaveBeenCalledTimes(2),
      );
      pages.answers[1]!(page("current"));
      await loading;
      const ids = [...f.detail.transcript.getSnapshot().activeIds];
      expect(ids).toEqual(["current"]);
    } finally {
      reader.dispose();
    }
  });

  it("a jump overtaken by a repair lands in the new cut, and a newer jump wins", async () => {
    const f = racing([], []);
    const pages = held<unknown>();
    const reader = new ScopedThreadReader(
      f.detail,
      { "thread.items.page": pages.fn } as never,
      new TranscriptBodies(),
    );
    const target = { ...item, id: createId("message"), position: "0" };
    target.messageId = target.id as never;
    const later = { ...item, id: createId("message"), position: "0" };
    later.messageId = later.id as never;
    const page = (found: TranscriptItem) => ({
      ok: true,
      data: {
        kind: "page",
        threadId,
        nodeId: null,
        revision: "2",
        items: [found],
        hasMore: false,
        nextBefore: null,
        nextAfter: { ...cursor, beforeId: found.id, beforePosition: found.position },
      },
    });
    try {
      const jump = reader.history("around", target.messageId);
      await vi.waitFor(() => expect(pages.fn).toHaveBeenCalledTimes(1));
      f.stream.receive(f.cut("2"));
      pages.answers[0]!(page(target));
      await vi.waitFor(() => expect(pages.fn).toHaveBeenCalledTimes(2));
      pages.answers[1]!(page(target));
      await jump;
      expect(f.detail.transcript.getSnapshot().items.has(target.id)).toBe(true);
      expect(f.detail.anchor).toBe(target.id);

      // A second jump while a repair's reread flies: the jump is what lands.
      f.stream.receive(f.cut("3"));
      await vi.waitFor(() => expect(pages.fn).toHaveBeenCalledTimes(3));
      const second = reader.history("around", later.messageId);
      pages.answers[2]!(page(target));
      await vi.waitFor(() => expect(pages.fn).toHaveBeenCalledTimes(4));
      pages.answers[3]!(page(later));
      await second;
      expect(f.detail.anchor).toBe(later.id);
      expect(f.detail.transcript.getSnapshot().items.has(target.id)).toBe(false);
    } finally {
      reader.dispose();
    }
  });
});

test("a repair snapshot retires stale live text for finalized items and checkpoint packs oversized live windows by bytes", () => {
  const f = fixture();
  f.syncShell();
  f.syncDetail();
  const replyId = createId("message");
  f.stream.receive({
    type: "host.live",
    subscriptionId: f.address.subscriptionId,
    generation: f.address.generation,
    handle: 1,
    scope: f.detail.scope,
    liveBootId: crypto.randomUUID(),
    runId: createId("run"),
    attemptId: createId("runAttempt"),
    bindingGeneration: 1,
    itemId: replyId,
    streamId: replyId,
    afterSequence: "1",
    update: {
      operation: "replace",
      offset: 0,
      totalLength: 10,
      text: "partial...",
      incomplete: false,
    },
  });
  expect(f.detail.text.get(replyId)?.text).toBe("partial...");

  // Repair snapshot delivers the finalized message item without a separate close frame.
  const finalItem = {
    ...item,
    id: replyId,
    messageId: replyId,
    position: "2",
    revision: "2",
    text: "Complete final answer",
    view: { preview: "Complete final answer", published: true },
  };
  f.stream.receive({
    ...f.detailSnapshot([finalItem]),
    throughSequence: "2",
  });
  expect(f.detail.text.get(replyId)).toBeUndefined();
  expect(f.detail.transcript.getSnapshot().items.get(replyId)).toMatchObject({
    id: replyId,
    text: "Complete final answer",
  });

  // When a live thread grows past the 1 MiB checkpoint ceiling, `checkpoint()` packs the newest
  // contiguous suffix that fits instead of dropping the whole save.
  const largeItems = Array.from({ length: 6 }, (_, index) => {
    const id = createId("message");
    return {
      ...item,
      id,
      messageId: id,
      position: String(10 + index),
      revision: String(10 + index),
      text: "z".repeat(250 * 1024),
      view: { preview: "z".repeat(100), published: true },
    };
  });
  for (const [index, large] of largeItems.entries()) {
    f.stream.receive({
      type: "host.changes",
      subscriptionId: f.address.subscriptionId,
      generation: f.address.generation,
      scope: f.detail.scope,
      fromSequence: index === 0 ? "2" : String(9 + index),
      throughSequence: String(10 + index),
      changes: [
        {
          sequence: String(10 + index),
          ordinal: 0,
          entityKind: "item",
          entityId: large.id,
          operation: "upsert",
          value: large,
        },
      ],
    });
  }
  const saved = f.detail.transcript.checkpoint();
  expect(saved).toBeDefined();
  expect(saved!.items.length).toBeGreaterThan(0);
  expect(saved!.items.length).toBeLessThan(largeItems.length);
  expect(saved!.items.at(-1)?.id).toBe(largeItems.at(-1)!.id);
  expect(saved!.nextBefore?.beforeId).toBe(saved!.items[0]?.id);
});

test("retains browser usage for first paint across task switches, revalidates on revisit in one update (or none if unchanged), and merges incremental runs without duplicating thread summaries", async () => {
  const threadA = createId("thread");
  const threadB = createId("thread");
  const sessionId = `bsn_${crypto.randomUUID()}`;
  const runsA = Array.from({ length: 24 }, () => createId("run"));
  const sortedRunsA = [...runsA].sort();
  const extraRunA = createId("run");
  const itemsFor = (runIds: readonly ReturnType<typeof createId<"run">>[]) =>
    runIds.map((runId, index) => {
      const id = createId("message");
      return {
        ...item,
        id,
        messageId: id,
        runId,
        position: String(index + 1),
        revision: "1",
        view: { preview: `Turn ${index + 1}` },
      };
    });
  const itemsA = itemsFor(runsA);
  const itemsB = itemsFor([createId("run")]);
  const taskA = { ...task, id: threadA, title: "Task A" };
  const taskB = { ...task, id: threadB, title: "Task B" };
  const makeUse = (tid: string, runId: string | null, tabId: string | null, title: string) => ({
    sessionId,
    threadId: tid,
    runId,
    tabId,
    pageTitle: title,
    pageSite: tabId ? "https://docs.example" : null,
    firstUsedAt: "2026-11-23T00:00:00.000Z",
    lastUsedAt: "2026-11-23T00:00:01.000Z",
  });
  let versionA = 1;
  const usageCalls: { threadId: string; runIds: string[] }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const name = new URL(String(input)).pathname.slice("/v1/rpc/".length);
    if (name === "thread.assignments.list") {
      const tid = new URL(String(input)).searchParams.get("threadId")!;
      return Response.json({
        ok: true,
        data: {
          assignments: [],
          threadId: tid,
          window: { byteCount: 0, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 },
        },
      });
    }
    if (name === "thread.browserUsage.get") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        threadId: string;
        runIds: string[];
      };
      expect("runsOnly" in body).toBe(false);
      expect(body.runIds.length).toBeLessThanOrEqual(16);
      usageCalls.push(body);
      if (body.threadId === threadA) {
        const membership = makeUse(threadA, null, null, `V${versionA}`);
        const runUses = body.runIds.map((rid) =>
          makeUse(threadA, rid, `tab-${rid.slice(-6)}`, `V${versionA}-${rid.slice(-4)}`),
        );
        return Response.json({
          ok: true,
          data: {
            threadId: threadA,
            uses: [membership, ...runUses],
          },
        });
      }
      return Response.json({ ok: true, data: { threadId: body.threadId, uses: [] } });
    }
    return Response.json(
      { ok: false, error: { code: "not_found", message: "Unavailable", retryable: false } },
      { status: 404 },
    );
  });
  let socket!: MockPersonalSocket;
  let lastDetailA: Extract<ScopedClientMessage, { type: "client.subscribe" }> | undefined;
  let detailASyncs = 0;
  const connect = () =>
    (socket = new MockPersonalSocket((raw) => {
      const message = JSON.parse(raw) as ScopedClientMessage;
      queueMicrotask(() => {
        if (message.type === "client.subscribe" && message.scope.kind === "thread") {
          const tid = message.scope.threadId;
          if (tid === threadA) lastDetailA = message;
          const address = {
            scope: message.scope,
            subscriptionId: message.subscriptionId,
            generation: message.generation,
            throughSequence: "1",
          };
          socket.deliver({
            ...address,
            type: "host.snapshot",
            snapshot: {
              thread: detailThread(tid === threadA ? taskA : taskB),
              items: tid === threadA ? itemsA : itemsB,
              activeItems: [],
              pendingRequests: [],
              nextBefore: null,
            },
          } as never);
          socket.deliver({ ...address, type: "host.synchronized" } as never);
          if (tid === threadA) detailASyncs += 1;
        }
        if (message.type !== "client.attach") return;
        const shell = {
          scope: shellScope,
          subscriptionId: "shell" as const,
          generation: message.generation,
          throughSequence: "1",
        };
        socket.deliver({
          ...shell,
          type: "host.snapshot",
          snapshot: {
            deploymentId,
            viewerId,
            epoch,
            session,
            tasks: [taskA, taskB],
            visits: [],
            attention: [],
            counts,
            ...shellLists,
          },
        });
        socket.deliver({ ...shell, type: "host.synchronized" });
      });
    }));
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    fetch,
    webSocketFactory: connect,
  });
  try {
    await client.load();
    // 1. Opening task A with 24 runs batches by 16 (16 + 8) and deduplicates thread-level summaries.
    client.activateThread(threadA);
    await vi.waitFor(() => expect(usageCalls).toHaveLength(2));
    expect(usageCalls).toEqual([
      { threadId: threadA, runIds: sortedRunsA.slice(0, 16) },
      { threadId: threadA, runIds: sortedRunsA.slice(16) },
    ]);
    await vi.waitFor(() =>
      expect(client.getSnapshot().browserUsage?.[threadA]).toEqual({ loading: false, error: null }),
    );
    const initialUsesA = client.getSnapshot().browserUses.filter((use) => use.threadId === threadA);
    expect(initialUsesA).toHaveLength(1 + runsA.length);

    // 2. Switching away to task B keeps task A's browserUses retained in the snapshot.
    client.activateThread(threadB);
    await vi.waitFor(() => expect(usageCalls).toHaveLength(3));
    expect(client.getSnapshot().browserUses.filter((use) => use.threadId === threadA)).toEqual(
      initialUsesA,
    );

    // 3. Revisiting unchanged task A paints retained uses immediately (loading: false),
    //    always revalidates on show, and causes ZERO browserUses snapshot updates when unchanged.
    let unchangedUpdates = 0;
    let unchangedRef = client.getSnapshot().browserUses;
    const stopUnchanged = client.subscribe(() => {
      const snap = client.getSnapshot();
      expect(snap.browserUsage?.[threadA]?.loading).toBe(false);
      if (snap.browserUses !== unchangedRef) {
        unchangedRef = snap.browserUses;
        unchangedUpdates += 1;
      }
    });
    client.activateThread(threadA);
    await vi.waitFor(() => expect(detailASyncs).toBe(2));
    await vi.waitFor(() => expect(usageCalls).toHaveLength(5));
    await Promise.resolve();
    stopUnchanged();
    expect(unchangedUpdates).toBe(0);
    expect(client.getSnapshot().browserUses.filter((use) => use.threadId === threadA)).toEqual(
      initialUsesA,
    );

    // 4. Leaving task A, server usage changing while A is hidden WITHOUT any notice
    //    (e.g., older v65 Host or subscribed-only RealtimeHub), then revisiting A:
    //    - last known V1 uses stay visible immediately (never blanked or set loading: true)
    //    - one revalidation runs (2 batches for 24 runs) and lands in ONE snapshot update with V2.
    client.activateThread(threadB);
    await vi.waitFor(() => expect(usageCalls).toHaveLength(6));
    versionA = 2;
    expect(client.getSnapshot().browserUses.filter((use) => use.threadId === threadA)).toEqual(
      initialUsesA,
    );
    let usageUpdates = 0;
    let lastBrowserUses = client.getSnapshot().browserUses;
    const stopCounting = client.subscribe(() => {
      const snap = client.getSnapshot();
      expect(snap.browserUsage?.[threadA]?.loading).toBe(false);
      if (snap.browserUses !== lastBrowserUses) {
        lastBrowserUses = snap.browserUses;
        usageUpdates += 1;
      }
    });
    client.activateThread(threadA);
    await vi.waitFor(() => expect(usageCalls).toHaveLength(8));
    await vi.waitFor(() =>
      expect(
        client
          .getSnapshot()
          .browserUses.find((use) => use.threadId === threadA && use.runId === null)?.pageTitle,
      ).toBe("V2"),
    );
    stopCounting();
    expect(usageUpdates).toBe(1);
    expect(usageCalls.slice(6, 8)).toEqual([
      { threadId: threadA, runIds: sortedRunsA.slice(0, 16) },
      { threadId: threadA, runIds: sortedRunsA.slice(16) },
    ]);

    // 5. A new Run arriving in shown task A triggers ONE incremental read whose response
    //    replaces thread-level rows (no duplicates) while preserving prior Runs' uses.
    versionA = 3;
    const extraMessageId = createId("message");
    socket.deliver({
      type: "host.changes",
      subscriptionId: lastDetailA!.subscriptionId,
      generation: lastDetailA!.generation,
      scope: lastDetailA!.scope,
      fromSequence: "1",
      throughSequence: "2",
      changes: [
        {
          sequence: "2",
          ordinal: 0,
          entityKind: "item",
          entityId: extraMessageId,
          operation: "upsert",
          value: {
            ...item,
            id: extraMessageId,
            messageId: extraMessageId,
            runId: extraRunA,
            position: String(runsA.length + 1),
            revision: "2",
            view: { preview: "Extra turn" },
          },
        },
      ],
    } as never);
    await vi.waitFor(() => expect(usageCalls).toHaveLength(9));
    expect(usageCalls[8]).toEqual({
      threadId: threadA,
      runIds: [extraRunA],
    });
    await vi.waitFor(() =>
      expect(
        client
          .getSnapshot()
          .browserUses.some((use) => use.threadId === threadA && use.runId === extraRunA),
      ).toBe(true),
    );
    const finalUsesA = client.getSnapshot().browserUses.filter((use) => use.threadId === threadA);
    const finalMembershipsA = finalUsesA.filter((use) => use.runId === null);
    expect(finalMembershipsA).toHaveLength(1);
    expect(finalMembershipsA[0]?.pageTitle).toBe("V3");
    expect(finalUsesA).toHaveLength(1 + runsA.length + 1);
  } finally {
    client.dispose();
  }
});

test("browser usage retention follows reader eviction, drops on task tombstone, and refreshes on notice/profile changes", async () => {
  const threads = Array.from({ length: 11 }, (_, index) => ({
    ...task,
    id: createId("thread"),
    title: `Task ${index}`,
  }));
  const sessionId = `bsn_${crypto.randomUUID()}`;
  const profileId = `bpr_${crypto.randomUUID()}`;
  const runsByThread = new Map(threads.map((t) => [t.id, createId("run")]));
  const itemsByThread = new Map(
    threads.map((t) => {
      const id = createId("message");
      return [
        t.id,
        [
          {
            ...item,
            id,
            messageId: id,
            runId: runsByThread.get(t.id)!,
            position: "1",
            revision: "1",
            view: { preview: t.title },
          },
        ],
      ];
    }),
  );
  const titleByThread = new Map<string, string>(threads.map((t, index) => [t.id, `V1-${index}`]));
  let profileArchived = false;
  let holdNextUsageFor: string | null = null;
  let releaseHeldUsage: (() => void) | null = null;
  const usageCalls: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    const name = url.pathname.slice("/v1/rpc/".length);
    if (name === "thread.assignments.list") {
      const tid = url.searchParams.get("threadId")!;
      return Response.json({
        ok: true,
        data: {
          assignments: [],
          threadId: tid,
          window: { byteCount: 0, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 },
        },
      });
    }
    if (name === "resources.detail.get") {
      const asked = JSON.parse(url.searchParams.get("input")!) as { kind: string };
      if (asked.kind === "browser-profile") {
        return Response.json({
          ok: true,
          data: {
            kind: "browser-profile",
            revision: profileArchived ? "2" : "1",
            next: null,
            data: {
              kind: "browser-profile",
              profiles: profileArchived
                ? []
                : [{ id: profileId, name: "Work", homeRunnerId: null, revision: 1 }],
              deletions: [],
            },
          },
        });
      }
    }
    if (name === "thread.browserUsage.get") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { threadId: string; runIds: string[] };
      usageCalls.push(body.threadId);
      const snapshotTitle = titleByThread.get(body.threadId) ?? "Unknown";
      const archivedAtCall = profileArchived;
      if (holdNextUsageFor === body.threadId) {
        holdNextUsageFor = null;
        await new Promise<void>((resolve) => {
          releaseHeldUsage = resolve;
        });
      }
      return Response.json({
        ok: true,
        data: {
          threadId: body.threadId,
          uses: archivedAtCall
            ? []
            : [
                {
                  sessionId,
                  threadId: body.threadId,
                  runId: null,
                  tabId: null,
                  pageTitle: snapshotTitle,
                  pageSite: "https://example.test",
                  firstUsedAt: "2026-11-23T00:00:00.000Z",
                  lastUsedAt: "2026-11-23T00:00:01.000Z",
                },
              ],
        },
      });
    }
    return Response.json(
      { ok: false, error: { code: "not_found", message: "Unavailable", retryable: false } },
      { status: 404 },
    );
  });
  let socket!: MockPersonalSocket;
  let shellGen = 0;
  let shellSeq = 1;
  const connect = () =>
    (socket = new MockPersonalSocket((raw) => {
      const message = JSON.parse(raw) as ScopedClientMessage;
      queueMicrotask(() => {
        if (message.type === "client.subscribe" && message.scope.kind === "thread") {
          const tid = message.scope.threadId;
          const t = threads.find((entry) => entry.id === tid)!;
          const address = {
            scope: message.scope,
            subscriptionId: message.subscriptionId,
            generation: message.generation,
            throughSequence: "1",
          };
          socket.deliver({
            ...address,
            type: "host.snapshot",
            snapshot: {
              thread: detailThread(t),
              items: itemsByThread.get(tid)!,
              activeItems: [],
              pendingRequests: [],
              nextBefore: null,
            },
          } as never);
          socket.deliver({ ...address, type: "host.synchronized" } as never);
        }
        if (message.type === "client.resources.watch") {
          if (message.interests.includes("browser-profile")) {
            socket.deliver({
              type: "host.resource",
              scope: shellScope,
              subscriptionId: "shell",
              generation: shellGen,
              throughSequence: String(shellSeq),
              revisions: { "browser-profile": profileArchived ? "2" : "1" },
              reply: true,
            } as never);
          }
          return;
        }
        if (message.type !== "client.attach") return;
        shellGen = message.generation;
        const shell = {
          scope: shellScope,
          subscriptionId: "shell" as const,
          generation: message.generation,
          throughSequence: String(shellSeq),
        };
        socket.deliver({
          ...shell,
          type: "host.snapshot",
          snapshot: {
            deploymentId,
            viewerId,
            epoch,
            session,
            tasks: threads,
            visits: [],
            attention: [],
            counts,
            ...shellLists,
          },
        });
        socket.deliver({ ...shell, type: "host.synchronized" });
        if (message.selected?.scope.kind === "thread") {
          const tid = message.selected.scope.threadId;
          const t = threads.find((entry) => entry.id === tid)!;
          const address = {
            scope: message.selected.scope,
            subscriptionId: message.selected.subscriptionId,
            generation: message.selected.generation,
            throughSequence: "1",
          };
          socket.deliver({
            ...address,
            type: "host.snapshot",
            snapshot: {
              thread: detailThread(t),
              items: itemsByThread.get(tid)!,
              activeItems: [],
              pendingRequests: [],
              nextBefore: null,
            },
          } as never);
          socket.deliver({ ...address, type: "host.synchronized" } as never);
        }
      });
    }));
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    fetch,
    webSocketFactory: connect,
    reconnectBaseDelayMs: 5,
    reconnectMaxDelayMs: 10,
  });
  try {
    await client.load();

    // 1. Retention follows the reader (ScopedPersonalStream keeps 8 inactive details + 1 active).
    for (let index = 0; index < threads.length; index++) {
      client.activateThread(threads[index]!.id);
      await vi.waitFor(() => expect(usageCalls).toHaveLength(index + 1));
      await vi.waitFor(() =>
        expect(client.getSnapshot().browserUsage?.[threads[index]!.id]?.loading).toBe(false),
      );
    }
    const retainedIds = new Set(client.getSnapshot().browserUses.map((use) => use.threadId));
    expect(retainedIds.size).toBe(9);
    expect(retainedIds.has(threads[0]!.id)).toBe(false);
    expect(retainedIds.has(threads[1]!.id)).toBe(false);
    expect(client.getSnapshot().browserUsage?.[threads[0]!.id]).toBeUndefined();
    expect(client.getSnapshot().browserUsage?.[threads[1]!.id]).toBeUndefined();
    expect(retainedIds.has(threads[2]!.id)).toBe(true);
    expect(retainedIds.has(threads[10]!.id)).toBe(true);

    // 2. Notice during in-flight refresh, then switching away before it completes, then returning:
    //    must refresh on return and pick up the latest page title (never keep stale data).
    const taskA = threads[10]!.id;
    const taskB = threads[9]!.id;
    titleByThread.set(taskA, "V2-inflight");
    holdNextUsageFor = taskA;
    const callsBeforeNotice = usageCalls.length;
    socket.deliver({ type: "host.browser-usage-changed", threadIds: [taskA] } as never);
    await vi.waitFor(() => expect(usageCalls.length).toBe(callsBeforeNotice + 1));
    // Switch away to taskB while taskA's refresh is still in flight.
    client.activateThread(taskB);
    await vi.waitFor(() => expect(usageCalls.length).toBe(callsBeforeNotice + 2));
    // Complete the abandoned in-flight read for taskA; taskA's retained title stays V1-10 for first paint.
    releaseHeldUsage!();
    releaseHeldUsage = null;
    await Promise.resolve();
    expect(client.getSnapshot().browserUses.find((use) => use.threadId === taskA)?.pageTitle).toBe(
      "V1-10",
    );
    // Return to taskA: first paint has V1-10, and revalidation refreshes to V3-returned!
    titleByThread.set(taskA, "V3-returned");
    client.activateThread(taskA);
    await vi.waitFor(() =>
      expect(
        client.getSnapshot().browserUses.find((use) => use.threadId === taskA)?.pageTitle,
      ).toBe("V3-returned"),
    );

    // 3. Notice arriving while an earlier refresh is in flight on a SHOWN task:
    //    the pre-notice response must not suppress the post-notice refresh.
    titleByThread.set(taskA, "V4-pre-second-notice");
    holdNextUsageFor = taskA;
    socket.deliver({ type: "host.browser-usage-changed", threadIds: [taskA] } as never);
    await vi.waitFor(() => expect(releaseHeldUsage).not.toBeNull());
    // Second notice lands while V4 read is still in flight.
    titleByThread.set(taskA, "V5-post-second-notice");
    socket.deliver({ type: "host.browser-usage-changed", threadIds: [taskA] } as never);
    const releaseV4 = releaseHeldUsage!;
    releaseHeldUsage = null;
    releaseV4();
    await vi.waitFor(() =>
      expect(
        client.getSnapshot().browserUses.find((use) => use.threadId === taskA)?.pageTitle,
      ).toBe("V5-post-second-notice"),
    );

    // 4. Tombstoning an inactive retained task through the shell drops its browser usage immediately.
    const tombstoned = threads[8]!.id;
    expect(client.getSnapshot().browserUses.some((use) => use.threadId === tombstoned)).toBe(true);
    expect(client.getSnapshot().browserUsage?.[tombstoned]).toBeDefined();
    shellSeq += 1;
    socket.deliver({
      type: "host.changes",
      subscriptionId: "shell",
      generation: shellGen,
      scope: shellScope,
      fromSequence: String(shellSeq - 1),
      throughSequence: String(shellSeq),
      changes: [
        {
          sequence: String(shellSeq),
          ordinal: 0,
          entityKind: "task",
          entityId: tombstoned,
          operation: "remove",
        },
      ],
    } as never);
    expect(client.getSnapshot().browserUses.some((use) => use.threadId === tombstoned)).toBe(false);
    expect(client.getSnapshot().browserUsage?.[tombstoned]).toBeUndefined();

    // 5. Archiving a browser profile (live `browser-profile` resource revision bump) refreshes
    //    the currently shown task's browser usage without needing `host.browser-usage-changed`.
    const stopProfileWatch = client.subscribe(() => void client.getSnapshot().browserProfiles);
    void client.getSnapshot().browserProfiles;
    await vi.waitFor(() => expect(client.getSnapshot().browserProfiles).toHaveLength(1));
    profileArchived = true;
    const callsBeforeProfileBump = usageCalls.length;
    socket.deliver({
      type: "host.resource",
      scope: shellScope,
      subscriptionId: "shell",
      generation: shellGen,
      throughSequence: String(shellSeq),
      revisions: { "browser-profile": "2" },
    } as never);
    await vi.waitFor(() => expect(usageCalls.length).toBeGreaterThan(callsBeforeProfileBump));
    await vi.waitFor(() =>
      expect(client.getSnapshot().browserUses.some((use) => use.threadId === taskA)).toBe(false),
    );
    stopProfileWatch();

    // 6. Reconnect: retained threads keep last known data visible and revalidate on revisit.
    profileArchived = false;
    const retainedTarget = threads[7]!.id;
    const beforeReconnectCalls = usageCalls.length;
    socket.close();
    await vi.waitFor(() => expect(usageCalls.length).toBeGreaterThan(beforeReconnectCalls));
    expect(client.getSnapshot().browserUses.some((use) => use.threadId === retainedTarget)).toBe(
      true,
    );
    const afterReconnectCalls = usageCalls.length;
    client.activateThread(retainedTarget);
    await vi.waitFor(() => expect(usageCalls.length).toBe(afterReconnectCalls + 1));
    expect(usageCalls.at(-1)).toBe(retainedTarget);
  } finally {
    client.dispose();
  }
});
