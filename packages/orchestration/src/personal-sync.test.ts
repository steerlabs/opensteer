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
import { PersonalSyncSocket } from "./personal-sync.js";

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
  activeHasMore: false,
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
  const resourceRevisions = vi.fn(() => ({ settings: "0" }));
  const send = vi.fn(async (_raw: string, guard: () => boolean) => guard());
  const socket = new PersonalSyncSocket({ read, resourceRevisions, send, close() {} });
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
    expect(resourceRevisions).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(3);
    socket.ack({ subscriptionId: "shell", generation: 1, throughSequence: "1" });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(resourceRevisions).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(3);
  } finally {
    socket.close("test finished");
    vi.useRealTimers();
  }
});

test("pushes only watched revisions that differ from what the client installed", async () => {
  const current = new Map<string, string>([
    ["settings", "4"],
    ["machine", "9.0123456789abcdef.2"],
  ]);
  const frames: ScopedHostMessage[] = [];
  const sent = Promise.withResolvers<void>();
  const socket = new PersonalSyncSocket({
    read: async () => ({
      throughSequence: "1",
      cursor,
      frames: [{ type: "host.snapshot" as const, scope, snapshot, throughSequence: "1" }],
    }),
    resourceRevisions: (kinds) =>
      Object.fromEntries(kinds.map((kind) => [kind, current.get(kind) ?? "0"])),
    async send(raw, guard) {
      if (!guard()) return false;
      const frame = ScopedHostMessageSchema.parse(JSON.parse(raw));
      frames.push(frame);
      if (frame.type === "host.resource") sent.resolve();
      return true;
    },
    close() {},
  });
  const resources = () => frames.filter((frame) => frame.type === "host.resource");
  try {
    // A resume whose installed revisions are all current is told nothing.
    socket.attach({
      type: "client.attach",
      apiVersion: 64,
      generation: 1,
      interests: ["settings", "machine"],
      installed: { settings: "4", machine: "9.0123456789abcdef.2" },
    });
    await vi.waitFor(() =>
      expect(frames.some((frame) => frame.type === "host.synchronized")).toBe(true),
    );
    expect(resources()).toEqual([]);
    // A kind nobody watches never reaches the socket.
    current.set("tab", "5");
    socket.resourcesChanged(new Set(["tab"]));
    // A runtime fact moves one watched kind; only that kind is sent.
    current.set("machine", "9.0123456789abcdef.3");
    socket.resourcesChanged(new Set(["machine", "tab"]));
    await deadline(sent.promise, "The changed revision was never pushed");
    expect(resources()).toMatchObject([
      { type: "host.resource", generation: 1, revisions: { machine: "9.0123456789abcdef.3" } },
    ]);
    expect(Object.keys((resources()[0] as { revisions: object }).revisions)).toEqual(["machine"]);
  } finally {
    socket.close("test finished");
  }
});

test("a socket whose shell read is refused hears no resource revision", async () => {
  const resourceRevisions = vi.fn(() => ({ settings: "4" }));
  const send = vi.fn(async () => true);
  const closed = Promise.withResolvers<string>();
  const socket = new PersonalSyncSocket({
    read: async () => {
      throw Object.assign(new Error("Deployment subscription forbidden"), { code: "forbidden" });
    },
    resourceRevisions,
    send,
    close: (reason) => closed.resolve(reason),
  });
  socket.attach({
    type: "client.attach",
    apiVersion: 64,
    generation: 1,
    interests: ["settings"],
    installed: {},
  });
  socket.resourcesChanged(new Set(["settings"]));
  await deadline(closed.promise, "The refused socket was never closed");
  expect(resourceRevisions).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
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
    expect(frames.filter((frame) => frame.subscriptionId === "detail:0")).toMatchObject([
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
      expect(frames.filter((frame) => frame.type === "host.live")).toHaveLength(49);
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
  const live = () => frames.filter((frame) => frame.type === "host.live").length;
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
