import { createId } from "@opensteer/core";
import {
  type PersonalResumeCursor,
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
      apiVersion: 62,
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

test("shell repair keeps resource interests for the replacement generation", async () => {
  const repair = Promise.withResolvers<void>();
  const updated = Promise.withResolvers<void>();
  const socket = new PersonalSyncSocket({
    async read(_scope, after) {
      if (after?.afterSequence === "0")
        return {
          throughSequence: "1",
          cursor: null,
          frames: [
            {
              type: "host.snapshot-required",
              scope,
              throughSequence: "1",
              reason: "cursor-unavailable",
            },
          ],
        };
      return {
        throughSequence: "1",
        cursor,
        frames: [{ type: "host.snapshot", scope, snapshot, throughSequence: "1" }],
      };
    },
    async readResources(interests) {
      return interests.map((kind) => ({
        kind,
        revision: "1",
        view: { entries: [], complete: true, hasMore: false },
      }));
    },
    async send(raw, guard) {
      if (!guard()) return false;
      const frame = ScopedHostMessageSchema.parse(JSON.parse(raw));
      if (frame.type === "host.snapshot-required") repair.resolve();
      if (frame.type === "host.resource" && frame.generation === 2 && frame.kind === "settings")
        updated.resolve();
      return true;
    },
    close() {},
  });
  try {
    socket.attach({
      type: "client.attach",
      apiVersion: 62,
      generation: 1,
      interests: ["settings"],
      installed: {},
      cursor: { ...cursor, afterSequence: "0" },
    });
    await deadline(repair.promise, "Expired shell did not ask for repair");
    socket.subscribe(subscription(2));
    await deadline(updated.promise, "Replacement shell lost its settings watch");
  } finally {
    socket.close("test finished");
  }
});

test("oversized encoded commits dispatch a bounded repair", async () => {
  const delivered = Promise.withResolvers<ScopedHostMessage>();
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
  const socket = new PersonalSyncSocket({
    read: async () => ({
      throughSequence: "2",
      cursor: { ...cursor, afterSequence: "2" },
      frames: [{ type: "host.changes", scope, fromSequence: "1", throughSequence: "2", changes }],
    }),
    async send(raw, guard) {
      if (!guard()) return false;
      delivered.resolve(ScopedHostMessageSchema.parse(JSON.parse(raw)));
      return true;
    },
    close() {},
  });
  try {
    socket.subscribe({ ...subscription(1), cursor });
    expect(
      await deadline(delivered.promise, "Oversized commit did not request repair"),
    ).toMatchObject({
      type: "host.snapshot-required",
      reason: "replay-overflow",
      throughSequence: "2",
    });
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
      apiVersion: 62,
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
