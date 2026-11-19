import { createId } from "@opensteer/core";
import {
  type PersonalResumeCursor,
  type PersonalScope,
  type ScopedHostMessage,
  ScopedHostMessageSchema,
} from "@opensteer/protocol/personal-sync";
import {
  PersonalResourceRevisionsSchema,
  personalResourceKinds,
} from "@opensteer/protocol/resources";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, test, vi } from "vitest";
import { encodePersonalFrame, PersonalSyncSocket } from "./personal-sync.js";

const scope = { kind: "shell" as const };
const deploymentId = createId("deployment");
const viewerId = createId("user");
const epoch = crypto.randomUUID();
const cursor: PersonalResumeCursor = {
  deploymentId,
  viewerId,
  epoch,
  scopeKey: "shell",
  afterSequence: "1",
};
const snapshot = {
  deploymentId,
  viewerId,
  epoch,
  tasks: [],
  visits: [],
  attention: [],
  attentionHasMore: false,
  activeTaskIds: [],
  activeNextBefore: null,
  recentTaskIds: [],
  nextBefore: null,
  taskCounts: { active: 0, open: 0 },
  counts: { pendingRequestCount: 0, needsYouCount: 0, unreadTaskCount: 0 },
  resourceRevisions: PersonalResourceRevisionsSchema.parse(
    Object.fromEntries(personalResourceKinds.map((kind) => [kind, "0"])),
  ),
};

const subscription = (generation: number) => ({
  type: "client.subscribe" as const,
  subscriptionId: "shell" as const,
  scope,
  generation,
});

function deadline<T>(promise: Promise<T>, message: string) {
  return withTimeout(promise, 1000, { timeoutError: () => new Error(message) });
}

test("registers before the cut and drains a later commit without another wake", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  const frames: unknown[] = [];
  let reads = 0;
  const socket = new PersonalSyncSocket({
    async read(_scope, after) {
      reads++;
      if (after)
        return {
          throughSequence: "2",
          cursor: { ...cursor, afterSequence: "2" },
          frames: [
            {
              type: "host.changes",
              scope,
              fromSequence: after.afterSequence,
              throughSequence: "2",
              changes: [],
            },
          ],
        };
      entered.resolve();
      await release.promise;
      return {
        throughSequence: "1",
        cursor,
        frames: [{ type: "host.snapshot", scope, snapshot, throughSequence: "1" }],
      };
    },
    async send(raw, guard) {
      if (!guard()) return false;
      const frame = ScopedHostMessageSchema.parse(JSON.parse(raw));
      frames.push(frame);
      if (frame.type === "host.changes") delivered.resolve();
      return true;
    },
    close() {},
  });
  try {
    socket.subscribe(subscription(1));
    await deadline(entered.promise, "First cut did not start");
    socket.wake("2");
    socket.wake("1");
    release.resolve();
    await deadline(delivered.promise, "Committed work was left waiting for a later wake");
    expect(reads).toBe(2);
    expect(frames).toMatchObject([
      { type: "host.snapshot", generation: 1, throughSequence: "1" },
      { type: "host.synchronized", generation: 1, throughSequence: "1" },
      { type: "host.changes", generation: 1, throughSequence: "2" },
    ]);
  } finally {
    release.resolve();
    socket.close("test finished");
  }
});

test("cannot dispatch an old generation after replacing the same slot", async () => {
  const oldEntered = Promise.withResolvers<void>();
  const oldMaySend = Promise.withResolvers<void>();
  const oldDone = Promise.withResolvers<void>();
  const newDone = Promise.withResolvers<void>();
  const delivered: number[] = [];
  const closed = vi.fn();
  const socket = new PersonalSyncSocket({
    read: async () => ({
      throughSequence: "1",
      cursor,
      frames: [{ type: "host.snapshot", scope, snapshot, throughSequence: "1" }],
    }),
    async send(raw, guard) {
      const frame = ScopedHostMessageSchema.parse(JSON.parse(raw));
      if (frame.type === "host.text") throw new Error("Unexpected live text");
      if (frame.generation === 1) {
        oldEntered.resolve();
        await oldMaySend.promise;
        oldDone.resolve();
      }
      if (!guard()) return false;
      delivered.push(frame.generation);
      if (frame.type === "host.synchronized") newDone.resolve();
      return true;
    },
    close: closed,
  });
  try {
    socket.subscribe(subscription(1));
    await deadline(oldEntered.promise, "The old snapshot did not reach transport");
    socket.subscribe(subscription(2));
    await deadline(newDone.promise, "Replacement did not synchronize");
    socket.ack({ subscriptionId: "shell", generation: 1, throughSequence: "42" });
    oldMaySend.resolve();
    await deadline(oldDone.promise, "The old transport attempt did not settle");
    expect(delivered).toEqual([2, 2]);
    expect(closed).not.toHaveBeenCalled();
  } finally {
    oldMaySend.resolve();
    socket.close("test finished");
  }
});

test("holds selected detail until the initial shell is dispatched", async () => {
  const shellStarted = Promise.withResolvers<void>();
  const releaseShell = Promise.withResolvers<void>();
  const detailSent = Promise.withResolvers<void>();
  const sent: string[] = [];
  const selected = { kind: "thread" as const, threadId: createId("thread") };
  const socket = new PersonalSyncSocket({
    async read(requested) {
      if (requested.kind === "shell") {
        shellStarted.resolve();
        await deadline(releaseShell.promise, "Shell cut was not released");
        return {
          throughSequence: "1",
          cursor,
          frames: [{ type: "host.snapshot", scope, snapshot, throughSequence: "1" }],
        };
      }
      return {
        throughSequence: "1",
        cursor: null,
        frames: [{ type: "host.removed", scope: selected, reason: "unavailable" }],
      };
    },
    async send(raw, guard) {
      if (!guard()) return false;
      const frame = ScopedHostMessageSchema.parse(JSON.parse(raw));
      sent.push(frame.type);
      if (frame.type === "host.removed") detailSent.resolve();
      return true;
    },
    close() {},
  });
  try {
    socket.attach({
      type: "client.attach",
      apiVersion: 64,
      generation: 1,
      interests: [],
      installed: {},
      selected: { generation: 1, scope: selected, subscriptionId: "detail:0" },
    });
    await deadline(shellStarted.promise, "Shell cut never started");
    expect(sent).toEqual([]);
    releaseShell.resolve();
    await deadline(detailSent.promise, "Detail did not dispatch after the shell");
    expect(sent).toEqual(["host.snapshot", "host.synchronized", "host.removed"]);
  } finally {
    releaseShell.resolve();
    socket.close("test finished");
  }
});

test("rejects a guessed acknowledgement before the durable frame dispatches", async () => {
  const reserved = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const closed = vi.fn();
  const socket = new PersonalSyncSocket({
    read: async () => ({
      throughSequence: "1",
      cursor,
      frames: [{ type: "host.snapshot", scope, snapshot, throughSequence: "1" }],
    }),
    async send(_raw, dispatch) {
      reserved.resolve();
      await deadline(release.promise, "Transport did not release");
      return dispatch();
    },
    close: closed,
  });
  try {
    socket.subscribe({ ...subscription(1), cursor });
    await deadline(reserved.promise, "Durable frame did not reserve credit");
    socket.ack({ subscriptionId: "shell", generation: 1, throughSequence: "1" });
    expect(closed).toHaveBeenCalledWith("Acknowledgement is ahead of delivered state");
  } finally {
    release.resolve();
    socket.close("test finished");
  }
});

test("a thread authority change fences a held node-only dispatch", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<boolean>();
  const node = {
    kind: "node" as const,
    threadId: createId("thread"),
    nodeId: createId("executionNode"),
  };
  const close = vi.fn();
  const socket = new PersonalSyncSocket({
    async read() {
      return {
        throughSequence: "1",
        cursor: null,
        frames: [{ type: "host.removed", scope: node, reason: "unavailable" }],
      };
    },
    async send(_raw, dispatch) {
      entered.resolve();
      await deadline(release.promise, "Node transport was never released");
      const ok = dispatch();
      finished.resolve(ok);
      return ok;
    },
    close,
  });
  try {
    socket.subscribe({
      type: "client.subscribe",
      subscriptionId: "detail:1",
      generation: 1,
      scope: node,
    });
    await deadline(entered.promise, "Node frame was never built");
    const fence = socket.suspendAuthority(new Set([`thread:${node.threadId}`]));
    fence.committed();
    release.resolve();
    expect(await deadline(finished.promise, "Node dispatch did not settle")).toBe(false);
    expect(close).toHaveBeenCalledWith("Personal authority changed: detail:1");
  } finally {
    release.resolve();
    socket.close("test finished");
  }
});

test("a commit too large for one frame is repaired inline by a snapshot on the same generation", async () => {
  const frames: ScopedHostMessage[] = [];
  const repaired = Promise.withResolvers<void>();
  const changes = Array.from({ length: 12 }, (_, ordinal) => {
    const id = createId("thread");
    return {
      sequence: "2",
      ordinal,
      entityId: id,
      entityKind: "task" as const,
      operation: "upsert" as const,
      value: {
        id,
        title: "Task",
        revision: "2",
        status: "idle" as const,
        purpose: "task" as const,
        askedAt: "2026-01-01T00:00:00.000Z",
        doneAt: null,
        doneReason: null,
        pendingRequestCount: 0,
        lastReplyPreview: "\u0001".repeat(1050),
        failurePreview: null,
        latestRunCompletedAt: null,
      },
    };
  });
  const read = vi.fn(async (_scope: PersonalScope, after: PersonalResumeCursor | null) =>
    after
      ? {
          throughSequence: "2",
          cursor: { ...cursor, afterSequence: "2" },
          frames: [
            {
              type: "host.changes" as const,
              scope,
              fromSequence: "1",
              throughSequence: "2",
              changes,
            },
          ],
        }
      : {
          throughSequence: "2",
          cursor: { ...cursor, afterSequence: "2" },
          frames: [{ type: "host.snapshot" as const, scope, snapshot, throughSequence: "2" }],
        },
  );
  const closed = vi.fn();
  const socket = new PersonalSyncSocket({
    read,
    async send(raw, guard) {
      if (!guard()) return false;
      const frame = ScopedHostMessageSchema.parse(JSON.parse(raw));
      frames.push(frame);
      if (frame.type === "host.snapshot") repaired.resolve();
      return true;
    },
    close: closed,
  });
  try {
    socket.subscribe({ ...subscription(1), cursor });
    await deadline(repaired.promise, "The oversized commit was not repaired by a snapshot");
    expect(read.mock.calls.map(([, after]) => after?.afterSequence ?? null)).toEqual(["1", null]);
    expect(frames).toMatchObject([
      { type: "host.snapshot", generation: 1, throughSequence: "2" },
      { type: "host.synchronized", generation: 1, throughSequence: "2" },
    ]);
    expect(closed).not.toHaveBeenCalled();
  } finally {
    socket.close("test finished");
  }
});

test("a synchronized socket does no state or resource work during five idle minutes", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => ({
    throughSequence: "1",
    cursor,
    frames: [{ type: "host.snapshot" as const, scope, snapshot, throughSequence: "1" }],
  }));
  const readResources = vi.fn(async () => [
    {
      kind: "settings" as const,
      revision: "0",
      view: { entries: [], complete: true, hasMore: false },
    },
  ]);
  const send = vi.fn(async (_raw: string, guard: () => boolean) => guard());
  const socket = new PersonalSyncSocket({ read, readResources, send, close() {} });
  try {
    socket.attach({
      type: "client.attach",
      apiVersion: 64,
      generation: 1,
      interests: ["settings"],
      installed: {},
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(readResources).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(3);
    socket.ack({ subscriptionId: "shell", generation: 1, throughSequence: "1" });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(readResources).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(3);
  } finally {
    socket.close("test finished");
    vi.useRealTimers();
  }
});

test("coalesces live text for its synchronized detail after the durable barrier", async () => {
  vi.useFakeTimers();
  const threadId = createId("thread");
  const detail = { kind: "thread", threadId } as const;
  const other = { kind: "thread", threadId: createId("thread") } as const;
  const frames: ScopedHostMessage[] = [];
  const socket = new PersonalSyncSocket({
    async read(scope, resume) {
      if (scope.kind !== "thread") throw new Error("Unexpected scope");
      const throughSequence = resume ? "2" : "1";
      return {
        throughSequence,
        cursor: {
          ...cursor,
          scopeKey: `thread:${scope.threadId}`,
          afterSequence: throughSequence,
        },
        frames: resume
          ? [
              {
                type: "host.changes",
                scope,
                throughSequence,
                fromSequence: resume.afterSequence,
                changes: [],
              },
            ]
          : [],
      };
    },
    async send(encoded, current) {
      if (!current()) return false;
      frames.push(ScopedHostMessageSchema.parse(JSON.parse(encoded)));
      return true;
    },
    close() {},
  });
  const update = {
    runId: createId("run"),
    attemptId: createId("runAttempt"),
    bindingGeneration: 1,
    liveBootId: crypto.randomUUID(),
    streamId: "assistant",
    itemId: "message:assistant",
    afterSequence: "2",
  };
  try {
    socket.subscribe({
      type: "client.subscribe",
      subscriptionId: "detail:0",
      scope: detail,
      generation: 3,
    });
    socket.subscribe({
      type: "client.subscribe",
      subscriptionId: "detail:1",
      scope: other,
      generation: 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(frames.filter((frame) => frame.type === "host.synchronized")).toHaveLength(2);
    for (const text of ["a", "answer"]) {
      socket.offerLive(detail, {
        ...update,
        update: {
          operation: "replace",
          offset: 0,
          totalLength: text.length,
          text,
          incomplete: false,
        },
      });
    }
    await vi.advanceTimersByTimeAsync(49);
    expect(frames.filter((frame) => frame.type === "host.live")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(frames.filter((frame) => frame.type === "host.live")).toEqual([]);
    socket.wake("2");
    await vi.advanceTimersByTimeAsync(0);
    expect(
      frames.filter((frame) => "subscriptionId" in frame && frame.subscriptionId === "detail:0"),
    ).toMatchObject([
      { type: "host.synchronized", generation: 3, throughSequence: "1" },
      { type: "host.changes", generation: 3, throughSequence: "2" },
      {
        type: "host.live",
        generation: 3,
        scope: detail,
        afterSequence: "2",
        update: { text: "answer" },
      },
    ]);
    expect(frames.filter((frame) => frame.type === "host.live")).toHaveLength(1);
  } finally {
    socket.close("test finished");
    vi.useRealTimers();
  }
});

test.each(["acknowledged", "unacknowledged"] as const)(
  "keeps a pressured cut while another scope streams until its credit is %s",
  async (outcome) => {
    vi.useFakeTimers();
    const detail = { kind: "thread", threadId: createId("thread") } as const;
    const closed = vi.fn();
    const frames: ScopedHostMessage[] = [];
    const read = vi.fn(async (requested: PersonalScope, after: PersonalResumeCursor | null) => {
      if (requested.kind === "node") throw new Error("Unexpected node scope");
      if (requested.kind === "thread")
        return {
          throughSequence: "1",
          cursor: { ...cursor, scopeKey: `thread:${requested.threadId}` as const },
          frames: [],
        };
      if (!after)
        return {
          throughSequence: "1",
          cursor,
          frames: [{ type: "host.snapshot" as const, scope, snapshot, throughSequence: "1" }],
        };
      return {
        throughSequence: "3",
        cursor: { ...cursor, afterSequence: "3" },
        frames: [128, 1].map((count, index) => {
          const sequence = String(index + 2);
          return {
            type: "host.changes" as const,
            scope,
            fromSequence: String(index + 1),
            throughSequence: sequence,
            changes: Array.from({ length: count }, (_, ordinal) => ({
              sequence,
              ordinal,
              entityKind: "visit" as const,
              entityId: `visit-${ordinal}`,
              operation: "remove" as const,
            })),
          };
        }),
      };
    });
    const socket = new PersonalSyncSocket({
      read,
      async send(encoded, guard) {
        if (!guard()) return false;
        frames.push(ScopedHostMessageSchema.parse(JSON.parse(encoded)));
        return true;
      },
      close: closed,
    });
    const update = {
      runId: createId("run"),
      attemptId: createId("runAttempt"),
      bindingGeneration: 1,
      liveBootId: crypto.randomUUID(),
      streamId: "assistant",
      itemId: "message:assistant",
      afterSequence: "1",
    };
    const shellReads = () => read.mock.calls.filter(([target]) => target.kind === "shell").length;
    const delivered = () =>
      frames.filter((frame) => frame.type === "host.changes").map((frame) => frame.throughSequence);
    try {
      socket.subscribe(subscription(1));
      socket.subscribe({
        type: "client.subscribe",
        subscriptionId: "detail:0",
        scope: detail,
        generation: 1,
      });
      await vi.advanceTimersByTimeAsync(0);
      socket.wake("3", new Set(["shell"]));
      await vi.advanceTimersByTimeAsync(0);
      expect(delivered()).toEqual(["2"]);
      for (let tick = 0; tick < 49; tick++) {
        socket.offerLive(detail, {
          ...update,
          update: {
            operation: "replace",
            offset: 0,
            totalLength: 1,
            text: String(tick % 10),
            incomplete: false,
          },
        });
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(frames.filter((frame) => frame.type === "host.live")).toHaveLength(1);
      expect(frames.filter((frame) => frame.type === "host.text")).toHaveLength(48);
      expect(shellReads()).toBe(2);
      expect(delivered()).toEqual(["2"]);
      expect(closed).not.toHaveBeenCalled();
      if (outcome === "acknowledged") {
        socket.ack({ subscriptionId: "shell", generation: 1, throughSequence: "2" });
        await vi.advanceTimersByTimeAsync(100);
        expect(delivered()).toEqual(["2", "3"]);
        expect(shellReads()).toBe(2);
        expect(closed).not.toHaveBeenCalled();
      } else {
        socket.ack({ subscriptionId: "shell", generation: 1, throughSequence: "1" });
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(closed).not.toHaveBeenCalled();
        expect(delivered()).toEqual(["2"]);
        expect(shellReads()).toBe(2);
      }
    } finally {
      socket.close("test finished");
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  },
);

test("live text out of credit pauses its scope until the client acknowledges", async () => {
  vi.useFakeTimers();
  const detail = { kind: "thread", threadId: createId("thread") } as const;
  const closed = vi.fn();
  const frames: ScopedHostMessage[] = [];
  const socket = new PersonalSyncSocket({
    read: async () => ({
      throughSequence: "1",
      cursor: { ...cursor, scopeKey: `thread:${detail.threadId}` as const },
      frames: [],
    }),
    async send(encoded, guard) {
      if (!guard()) return false;
      frames.push(ScopedHostMessageSchema.parse(JSON.parse(encoded)));
      return true;
    },
    close: closed,
  });
  const live = () =>
    frames.filter((frame) => frame.type === "host.live" || frame.type === "host.text").length;
  const text = "x".repeat(12 * 1024);
  const offer = (index: number) =>
    socket.offerLive(detail, {
      runId: createId("run"),
      attemptId: createId("runAttempt"),
      bindingGeneration: 1,
      liveBootId: crypto.randomUUID(),
      streamId: `tool:${index}`,
      itemId: `tool:${index}`,
      afterSequence: "1",
      update: {
        operation: "replace",
        offset: 0,
        totalLength: text.length,
        text,
        incomplete: false,
      },
    });
  try {
    socket.subscribe({
      type: "client.subscribe",
      subscriptionId: "detail:0",
      scope: detail,
      generation: 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 40; index++) {
      offer(index);
      await vi.advanceTimersByTimeAsync(100);
    }
    const paused = live();
    expect(paused).toBeGreaterThan(10);
    expect(paused).toBeLessThan(40);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(live()).toBe(paused);
    expect(closed).not.toHaveBeenCalled();
    socket.ack({ subscriptionId: "detail:0", generation: 1, throughSequence: "1" });
    await vi.advanceTimersByTimeAsync(100);
    expect(live()).toBeGreaterThan(paused);
    expect(closed).not.toHaveBeenCalled();
  } finally {
    socket.close("test finished");
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  }
});

test("addresses a shared encoded body exactly as stringifying the whole frame", () => {
  const threadId = createId("thread");
  const frame = {
    type: "host.changes" as const,
    scope: { kind: "thread" as const, threadId },
    fromSequence: "1",
    throughSequence: "2",
    changes: [
      {
        sequence: "2",
        ordinal: 0,
        entityKind: "visit" as const,
        entityId: "visit-é\u{1f600}",
        operation: "remove" as const,
      },
    ],
  };
  for (const address of [
    { subscriptionId: "detail:0" as const, generation: 1 },
    { subscriptionId: "detail:3" as const, generation: 4096 },
  ]) {
    const whole = JSON.stringify({ type: frame.type, ...address, ...omitType(frame) });
    const { encoded, bytes } = encodePersonalFrame(frame, address);
    expect(encoded).toBe(whole);
    expect(bytes).toBe(Buffer.byteLength(whole));
  }
});

function omitType<T extends { type: string }>(frame: T) {
  const { type: _type, ...rest } = frame;
  return rest;
}

const liveScope = { kind: "thread", threadId: createId("thread") } as const;

function liveSocket(frames: ScopedHostMessage[], guard: () => boolean = () => true) {
  return new PersonalSyncSocket({
    read: async (requested) => ({
      throughSequence: "1",
      cursor: {
        ...cursor,
        scopeKey: requested.kind === "shell" ? "shell" : `thread:${requested.threadId}`,
      },
      frames: [],
    }),
    async send(encoded, current) {
      if (!guard() || !current()) return false;
      frames.push(ScopedHostMessageSchema.parse(JSON.parse(encoded)));
      return true;
    },
    close() {},
  });
}

function liveText(stream: string, text: string, overrides: { runId?: string } = {}) {
  return {
    runId: (overrides.runId ?? liveRun) as ReturnType<typeof createId<"run">>,
    attemptId: liveAttempt,
    bindingGeneration: 1,
    liveBootId: liveBoot,
    streamId: stream,
    itemId: stream,
    afterSequence: "1",
    update: {
      operation: "replace" as const,
      offset: 0,
      totalLength: text.length,
      text,
      incomplete: false,
    },
  };
}
const liveRun = createId("run");
const liveAttempt = createId("runAttempt");
const liveBoot = crypto.randomUUID();

test("names a live stream once, then appends with frames of at most 50 bytes of overhead", async () => {
  vi.useFakeTimers();
  const frames: ScopedHostMessage[] = [];
  const socket = liveSocket(frames);
  try {
    socket.subscribe({
      type: "client.subscribe",
      subscriptionId: "detail:0",
      scope: liveScope,
      generation: 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    const paragraph = "word ".repeat(200);
    for (let end = 40; end <= paragraph.length; end += 40) {
      socket.offerLive(liveScope, liveText("tool:a", paragraph.slice(0, end)), {
        immediate: true,
      });
      await vi.advanceTimersByTimeAsync(0);
    }
    const live = frames.filter((frame) => frame.type === "host.live" || frame.type === "host.text");
    expect(live[0]).toMatchObject({
      type: "host.live",
      handle: 1,
      update: { operation: "replace" },
    });
    const appends = live.slice(1);
    expect(appends).toHaveLength(24);
    for (const [index, frame] of appends.entries()) {
      expect(frame).toEqual({
        type: "host.text",
        h: 1,
        o: 40 * (index + 1),
        n: 40 * (index + 2),
        t: "word ".repeat(8),
      });
      expect(JSON.stringify(frame).length - 40).toBeLessThanOrEqual(50);
    }
  } finally {
    socket.close("test finished");
    vi.useRealTimers();
  }
});

test("a resync and a new generation each name the stream again under a new handle", async () => {
  vi.useFakeTimers();
  const frames: ScopedHostMessage[] = [];
  let tail = "first";
  const socket = new PersonalSyncSocket({
    read: async () => ({
      throughSequence: "1",
      cursor: { ...cursor, scopeKey: `thread:${liveScope.threadId}` as const },
      frames: [],
    }),
    readLive: () => [liveText("tool:a", tail)],
    async send(encoded, current) {
      if (!current()) return false;
      frames.push(ScopedHostMessageSchema.parse(JSON.parse(encoded)));
      return true;
    },
    close() {},
  });
  const subscribe = (generation: number) =>
    socket.subscribe({
      type: "client.subscribe",
      subscriptionId: "detail:0",
      scope: liveScope,
      generation,
    });
  const live = () =>
    frames.filter((frame) => frame.type === "host.live" || frame.type === "host.text");
  try {
    subscribe(1);
    await vi.advanceTimersByTimeAsync(100);
    tail = "first second";
    socket.offerLive(liveScope, liveText("tool:a", tail), { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(live()).toMatchObject([
      { type: "host.live", generation: 1, handle: 1, update: { text: "first" } },
      { type: "host.text", h: 1, o: 5, n: 12, t: " second" },
    ]);
    socket.resyncLive({
      type: "client.live.resync",
      subscriptionId: "detail:0",
      generation: 1,
      runId: liveRun,
      streamIds: ["tool:a"],
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(live()[2]).toMatchObject({
      type: "host.live",
      generation: 1,
      handle: 2,
      update: { operation: "replace", text: "first second" },
    });
    // The stream continues mid-flight across a new generation of the same slot.
    subscribe(2);
    await vi.advanceTimersByTimeAsync(100);
    tail = "first second third";
    socket.offerLive(liveScope, liveText("tool:a", tail), { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(live().slice(3)).toMatchObject([
      { type: "host.live", generation: 2, handle: 3, update: { text: "first second" } },
      { type: "host.text", h: 3, o: 12, n: 18, t: " third" },
    ]);
  } finally {
    socket.close("test finished");
    vi.useRealTimers();
  }
});

test("never drops a queued close behind other streams past the live cap", async () => {
  vi.useFakeTimers();
  const frames: ScopedHostMessage[] = [];
  let open = false;
  const socket = liveSocket(frames, () => open);
  try {
    socket.subscribe({
      type: "client.subscribe",
      subscriptionId: "detail:0",
      scope: liveScope,
      generation: 1,
    });
    open = true;
    await vi.advanceTimersByTimeAsync(0);
    open = false;
    const { update: _text, ...closing } = liveText("tool:closing", "");
    socket.offerLive(liveScope, { ...closing, update: { operation: "close" } });
    for (let index = 0; index < 40; index++)
      socket.offerLive(liveScope, liveText(`tool:${index}`, "x".repeat(4096)));
    open = true;
    await vi.advanceTimersByTimeAsync(100);
    const live = frames.filter((frame) => frame.type === "host.live");
    expect(live.length).toBeLessThan(41);
    expect(live).toContainEqual(
      expect.objectContaining({ streamId: "tool:closing", update: { operation: "close" } }),
    );
  } finally {
    socket.close("test finished");
    vi.useRealTimers();
  }
});

test("encodes a shared cut once and still refuses it on a socket that lost authority before sending", async () => {
  const threadId = createId("thread");
  const detail = { kind: "thread", threadId } as const;
  const frame = {
    type: "host.snapshot" as const,
    scope: detail,
    throughSequence: "1",
    snapshot: { probe: "shared" },
  };
  const shared = {
    throughSequence: "1",
    cursor: { ...cursor, scopeKey: `thread:${threadId}` as const },
    frames: [frame] as never[],
  };
  const stringify = vi.spyOn(JSON, "stringify");
  const sent: string[][] = [[], []];
  const sockets: PersonalSyncSocket[] = [];
  for (const index of [0, 1])
    sockets.push(
      new PersonalSyncSocket({
        read: async () => shared,
        async send(encoded, guard) {
          // The second device loses access after its frame was encoded and before dispatch.
          if (index === 1 && encoded.includes('"host.snapshot"'))
            sockets[1]!.suspendAuthority(new Set([`thread:${threadId}`]));
          if (!guard()) return false;
          sent[index]!.push(encoded);
          return true;
        },
        close() {},
      }),
    );
  try {
    for (const socket of sockets)
      socket.subscribe({
        type: "client.subscribe",
        subscriptionId: "detail:0",
        scope: detail,
        generation: 1,
      });
    await vi.waitFor(
      () => expect(sent[0]!.some((raw) => raw.includes("synchronized"))).toBe(true),
      {
        timeout: 1000,
      },
    );
    const bodies = stringify.mock.calls.filter(
      ([value]) =>
        typeof value === "object" &&
        value !== null &&
        "snapshot" in value &&
        value.snapshot === frame.snapshot,
    );
    stringify.mockRestore();
    expect(bodies).toHaveLength(1);
    expect(sent[0]![0]).toBe(
      JSON.stringify({
        type: "host.snapshot",
        subscriptionId: "detail:0",
        generation: 1,
        ...omitType(frame),
      }),
    );
    expect(sent[1]).toEqual([]);
  } finally {
    stringify.mockRestore();
    for (const socket of sockets) socket.close("test finished");
  }
});
