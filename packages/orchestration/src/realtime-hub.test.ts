import {
  SequenceSchema,
  createId,
  type AgentEvent,
  type Sequence,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import { type HostToClientMessage, type WorkspaceSnapshot } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { LiveRunRegistry, RealtimeHub, type RealtimeSink } from "./index.js";

describe("snapshot-before-live synchronization", () => {
  it("buffers an event committed while the snapshot is being read", async () => {
    const workspaceId = createId("workspace");
    const userId = createId("user");
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const store = {
      notificationState: viewerState(),
      workspaceMembershipForUser: async () => activeMembership(workspaceId, userId),
      workspaceSnapshot: async () => {
        await snapshotGate;
        return snapshot(workspaceId, "0");
      },
    } as unknown as OpensteerStore;
    const hub = new RealtimeHub({ store });
    const sink = new MemorySink();
    const subscribed = hub.subscribe({ afterSequence: sequence("0"), sink, userId, workspaceId });
    hub.publish(event(workspaceId, "1"));
    releaseSnapshot();
    const unsubscribe = await subscribed;
    expect(sink.messages.map((message) => message.type)).toEqual([
      "host.snapshot",
      "host.events",
      "host.synchronized",
    ]);
    unsubscribe();
  });

  it("buffers Browser Session invalidation while the initial snapshot is being read", async () => {
    const workspaceId = createId("workspace");
    const userId = createId("user");
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const store = {
      notificationState: viewerState(),
      workspaceMembershipForUser: async () => activeMembership(workspaceId, userId),
      workspaceSnapshot: async () => {
        await snapshotGate;
        return snapshot(workspaceId, "0");
      },
    } as unknown as OpensteerStore;
    const hub = new RealtimeHub({ store });
    const sink = new MemorySink();
    hub.registerConnection(userId, createId("authSession"), sink);
    const subscribed = hub.subscribe({ afterSequence: sequence("0"), sink, userId, workspaceId });
    hub.publishBrowserSessionsChanged(workspaceId, [userId]);
    // A second notice of the same kind says what the first one says.
    hub.publishBrowserSessionsChanged(workspaceId, [userId]);
    hub.publishTriggersChanged(workspaceId);
    releaseSnapshot();

    const unsubscribe = await subscribed;
    expect(sink.messages.map(({ type }) => type)).toEqual([
      "host.snapshot",
      "host.browser-sessions-changed",
      "host.triggers-changed",
      "host.synchronized",
    ]);
    unsubscribe();
  });

  it("keeps delivering in order when a publication arrives while its hole is being read", async () => {
    const workspaceId = createId("workspace");
    const userId = createId("user");
    const fills: {
      readonly after: Sequence;
      readonly resolve: (events: readonly AgentEvent[]) => void;
      readonly through: Sequence;
    }[] = [];
    const store = {
      eventsAfterWindow: (
        _workspace: WorkspaceId,
        after: Sequence,
        options: { readonly throughSequence: Sequence },
      ) =>
        new Promise((resolve) => {
          fills.push({
            after,
            resolve: (events) =>
              resolve({
                byteCount: 0,
                events,
                hasMore: false,
                scannedThrough: options.throughSequence,
              }),
            through: options.throughSequence,
          });
        }),
      notificationState: viewerState(),
      workspaceHead: async () => sequence("1"),
      workspaceMembershipForUser: async () => activeMembership(workspaceId, userId),
    } as unknown as OpensteerStore;
    const hub = new RealtimeHub({ gapFillDelayMs: 1, store });
    const sink = new MemorySink();
    const unsubscribe = await hub.subscribe({
      afterSequence: sequence("1"),
      sink,
      userId,
      workspaceId,
    });
    const delivered = () =>
      sink.messages.flatMap((message) =>
        message.type === "host.events" ? message.events.map(({ sequence }) => sequence) : [],
      );

    hub.publish(event(workspaceId, "5"));
    await waitUntil(() => fills.length === 1);
    expect(fills[0]).toMatchObject({ after: "1", through: "4" });
    // Sequence 3 is published while the read of 2–4 is in flight.
    hub.publish(event(workspaceId, "3"));
    fills[0]!.resolve([event(workspaceId, "2"), event(workspaceId, "3"), event(workspaceId, "4")]);
    await waitUntil(() => delivered().length === 4);
    expect(delivered()).toEqual(["2", "3", "4", "5"]);

    // The next hole is read and filled rather than stranded behind sequence 3.
    hub.publish(event(workspaceId, "7"));
    await waitUntil(() => fills.length === 2);
    expect(fills[1]).toMatchObject({ after: "5", through: "6" });
    fills[1]!.resolve([event(workspaceId, "6")]);
    await waitUntil(() => delivered().length === 6);
    expect(delivered()).toEqual(["2", "3", "4", "5", "6", "7"]);
    unsubscribe();
  });

  it("resynchronizes a live subscriber whose hole read never answers", async () => {
    const workspaceId = createId("workspace");
    const userId = createId("user");
    let fills = 0;
    let head = sequence("1");
    const store = {
      eventsAfterWindow: () => {
        fills += 1;
        return new Promise(() => undefined);
      },
      notificationState: viewerState(),
      workspaceHead: async () => head,
      workspaceMembershipForUser: async () => activeMembership(workspaceId, userId),
    } as unknown as OpensteerStore;
    const hub = new RealtimeHub({ gapFillDelayMs: 1, gapFillTimeoutMs: 20, store });
    const sink = new MemorySink();
    const other = new MemorySink("sink-2");
    await hub.subscribe({ afterSequence: sequence("1"), sink, userId, workspaceId });
    head = sequence("5");
    await hub.subscribe({ afterSequence: sequence("5"), sink: other, userId, workspaceId });

    // Sequence 5 arrives with 2–4 missing, and the read for them hangs. The
    // socket stays open, so nothing but a deadline on the read ends the wait.
    hub.publish(event(workspaceId, "5"));
    await waitUntil(() => fills === 1);
    await waitUntil(() => sink.closed !== undefined);
    expect(sink.messages.at(-1)).toMatchObject({
      reason: "cursor-expired",
      type: "host.resync-required",
      workspaceId,
    });
    expect(sink.closed).toEqual({ code: 4009, reason: "resync required" });

    hub.publish(event(workspaceId, "6"));
    await waitUntil(() => other.messages.some((message) => message.type === "host.events"));
    expect(sink.messages.filter((message) => message.type === "host.events")).toEqual([]);
    expect(other.closed).toBeUndefined();
  });

  it("sends a reconnecting subscriber's open streams in frames a client accepts", async () => {
    const workspaceId = createId("workspace");
    const userId = createId("user");
    const runId = createId("run");
    const threadId = createId("thread");
    const liveRuns = new LiveRunRegistry();
    liveRuns.observeCommitted([{ ...event(workspaceId, "1"), runId, threadId }]);
    const output = "x".repeat(50 * 1_024);
    liveRuns.apply({
      items: Array.from({ length: 21 }, (_value, index) => ({
        at: 0,
        callId: `call-${index}`,
        op: "append" as const,
        stream: "tool" as const,
        text: output,
      })),
      runId,
      threadId,
      workspaceId,
    });
    const store = {
      notificationState: viewerState(),
      workspaceMembershipForUser: async () => activeMembership(workspaceId, userId),
      workspaceSnapshot: async () => snapshot(workspaceId, "1"),
    } as unknown as OpensteerStore;
    const hub = new RealtimeHub({ liveRuns, store });
    const sink = new MemorySink();
    const unsubscribe = await hub.subscribe({
      afterSequence: sequence("0"),
      sink,
      userId,
      workspaceId,
    });
    await waitUntil(() => sink.messages.some((message) => message.type === "host.live"));
    const live = sink.messages.filter((message) => message.type === "host.live");
    for (const message of live) {
      expect(JSON.stringify(message).length).toBeLessThan(1_024 * 1_024);
    }
    expect(
      live.flatMap((message) => message.progress.items).filter((item) => item.stream === "tool"),
    ).toHaveLength(21);
    unsubscribe();
  });

  it("sends every open stream to a reconnecting subscriber, however many there are", async () => {
    const workspaceId = createId("workspace");
    const userId = createId("user");
    const liveRuns = new LiveRunRegistry();
    const output = "x".repeat(50 * 1_024);
    for (let runIndex = 0; runIndex < 2; runIndex += 1) {
      const runId = createId("run");
      const threadId = createId("thread");
      liveRuns.observeCommitted([{ ...event(workspaceId, "1"), runId, threadId }]);
      for (let batch = 0; batch < 4; batch += 1) {
        liveRuns.apply({
          items: Array.from({ length: 16 }, (_value, index) => ({
            at: 0,
            callId: `call-${batch}-${index}`,
            op: "append" as const,
            stream: "tool" as const,
            text: output,
          })),
          runId,
          threadId,
          workspaceId,
        });
      }
    }
    const store = {
      notificationState: viewerState(),
      workspaceMembershipForUser: async () => activeMembership(workspaceId, userId),
      workspaceSnapshot: async () => snapshot(workspaceId, "1"),
    } as unknown as OpensteerStore;
    const hub = new RealtimeHub({ liveRuns, store });
    const sink = new MemorySink();
    const unsubscribe = await hub.subscribe({
      afterSequence: sequence("0"),
      sink,
      userId,
      workspaceId,
    });
    const streams = () =>
      sink.messages
        .flatMap((message) => (message.type === "host.live" ? message.progress.items : []))
        .filter((item) => item.stream === "tool").length;
    await waitUntil(() => streams() === 128);
    unsubscribe();
  });

  it("splits replay into byte-bounded frames without changing the event cursor", async () => {
    const workspaceId = createId("workspace");
    const userId = createId("user");
    const replay = [event(workspaceId, "2"), event(workspaceId, "3")];
    const oneEventFrameBytes = Buffer.byteLength(
      JSON.stringify({ events: [replay[0]], type: "host.events" }),
      "utf8",
    );
    const store = {
      notificationState: viewerState(),
      eventsAfterWindow: async () => ({
        byteCount: Buffer.byteLength(JSON.stringify(replay), "utf8"),
        events: replay,
        hasMore: false,
        scannedThrough: sequence("3"),
      }),
      workspaceHead: async () => sequence("3"),
      workspaceMembershipForUser: async () => activeMembership(workspaceId, userId),
    } as unknown as OpensteerStore;
    const hub = new RealtimeHub({ maxWireBytes: oneEventFrameBytes + 1, store });
    const sink = new MemorySink();

    const unsubscribe = await hub.subscribe({
      afterSequence: sequence("1"),
      sink,
      userId,
      workspaceId,
    });

    expect(
      sink.messages
        .filter((message) => message.type === "host.events")
        .map((message) => message.events.map(({ sequence }) => sequence)),
    ).toEqual([["2"], ["3"]]);
    expect(sink.messages.at(-1)).toMatchObject({ sequence: "3", type: "host.synchronized" });
    unsubscribe();
  });

  it("delivers Browser Session invalidation to its viewers across Workspaces", async () => {
    const workspaceId = createId("workspace");
    const otherWorkspaceId = createId("workspace");
    const userId = createId("user");
    const store = {
      notificationState: viewerState(),
      workspaceMembershipForUser: async (requested: WorkspaceId) =>
        activeMembership(requested, userId),
      workspaceSnapshot: async (requested: WorkspaceId) => snapshot(requested, "0"),
    } as unknown as OpensteerStore;
    const hub = new RealtimeHub({ store });
    const sink = new MemorySink();
    const otherSink = new MemorySink("other");
    hub.registerConnection(userId, createId("authSession"), sink);
    hub.registerConnection(userId, createId("authSession"), otherSink);
    const unsubscribe = await hub.subscribe({
      afterSequence: sequence("0"),
      sink,
      userId,
      workspaceId,
    });
    const unsubscribeOther = await hub.subscribe({
      afterSequence: sequence("0"),
      sink: otherSink,
      userId,
      workspaceId: otherWorkspaceId,
    });

    hub.publishBrowserSessionsChanged(workspaceId, [userId]);
    await Promise.resolve();

    expect(sink.messages.at(-1)).toEqual({
      type: "host.browser-sessions-changed",
      workspaceId,
    });
    expect(otherSink.messages.map(({ type }) => type)).toContain("host.browser-sessions-changed");
    unsubscribe();
    unsubscribeOther();
  });
});

describe("live subscriber delivery failures", () => {
  it.each(["host.events", "host.live", "host.triggers-changed"] as const)(
    "closes only the failing subscriber when sending %s",
    async (type) => {
      const workspaceId = createId("workspace");
      const userId = createId("user");
      const store = {
        notificationState: viewerState(),
        workspaceMembershipForUser: async () => activeMembership(workspaceId, userId),
        workspaceSnapshot: async () => snapshot(workspaceId, "0"),
      } as unknown as OpensteerStore;
      const hub = new RealtimeHub({ store });
      const broken = new MemorySink("broken");
      const healthy = new MemorySink("healthy");
      const unsubscribe = await hub.subscribe({
        afterSequence: sequence("0"),
        sink: broken,
        userId,
        workspaceId,
      });
      const unsubscribeHealthy = await hub.subscribe({
        afterSequence: sequence("0"),
        sink: healthy,
        userId,
        workspaceId,
      });
      const close = vi.spyOn(broken, "close");
      const send = vi.spyOn(broken, "send").mockRejectedValue(new Error("socket is gone"));
      healthy.messages.length = 0;
      const publish = (value: string) => {
        if (type === "host.events") hub.publish(event(workspaceId, value));
        else if (type === "host.live")
          hub.publishLive({
            afterSequence: sequence("0"),
            progress: {
              items: [{ at: 0, op: "append", stream: "assistant", text: value }],
              runId: createId("run"),
              threadId: createId("thread"),
              workspaceId,
            },
          });
        else hub.publishTriggersChanged(workspaceId);
      };

      try {
        publish("1");
        publish("2");
        await waitUntil(() => healthy.messages.length === 2);
        expect(close).toHaveBeenCalledExactlyOnceWith(1011, "Workspace delivery failed");
        expect(send).toHaveBeenCalledTimes(1);

        publish("3");
        await waitUntil(() => healthy.messages.length === 3);
        expect(healthy.messages.map((message) => message.type)).toEqual([type, type, type]);
        expect(healthy.closed).toBeUndefined();
        expect(send).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        unsubscribe();
        unsubscribeHealthy();
      }
    },
  );

  it("unsubscribes without closing the sink", async () => {
    const workspaceId = createId("workspace");
    const userId = createId("user");
    const store = {
      notificationState: viewerState(),
      workspaceMembershipForUser: async () => activeMembership(workspaceId, userId),
      workspaceSnapshot: async () => snapshot(workspaceId, "0"),
    } as unknown as OpensteerStore;
    const hub = new RealtimeHub({ store });
    const sink = new MemorySink();
    const unsubscribe = await hub.subscribe({
      afterSequence: sequence("0"),
      sink,
      userId,
      workspaceId,
    });
    const close = vi.spyOn(sink, "close");
    const send = vi.spyOn(sink, "send");

    unsubscribe();
    unsubscribe();
    hub.publish(event(workspaceId, "1"));
    hub.publishTriggersChanged(workspaceId);
    await Promise.resolve();

    expect(send).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});

describe("connection-addressed messages", () => {
  it("closes every socket from the ended session before another event can be published", async () => {
    const userId = createId("user");
    const workspaceId = createId("workspace");
    const store = {
      notificationState: viewerState(),
      workspaceMembershipForUser: async () => activeMembership(workspaceId, userId),
      workspaceSnapshot: async () => snapshot(workspaceId, "0"),
    } as unknown as OpensteerStore;
    const hub = new RealtimeHub({ store });
    const endedSession = createId("authSession");
    const survivingSession = createId("authSession");
    const first = new MemorySink("ended-1");
    const second = new MemorySink("ended-2");
    const survivor = new MemorySink("survivor");
    hub.registerConnection(userId, endedSession, first);
    hub.registerConnection(userId, endedSession, second);
    hub.registerConnection(userId, survivingSession, survivor);
    await hub.subscribe({
      afterSequence: sequence("0"),
      sink: first,
      userId,
      workspaceId,
    });
    await hub.subscribe({
      afterSequence: sequence("0"),
      sink: survivor,
      userId,
      workspaceId,
    });
    first.messages.length = 0;
    survivor.messages.length = 0;

    hub.closeSession(endedSession);
    hub.publish(event(workspaceId, "1"));
    await Promise.resolve();

    expect(first.closed).toEqual({ code: 4003, reason: "Session ended" });
    expect(second.closed).toEqual({ code: 4003, reason: "Session ended" });
    expect(survivor.closed).toBeUndefined();
    expect(first.messages).toEqual([]);
    // A Run starting changes what a task list shows, so the survivor also
    // hears, directly rather than behind the event stream, that tasks changed.
    expect(survivor.messages).toEqual([
      { type: "host.tasks-changed" },
      expect.objectContaining({ events: [expect.objectContaining({ sequence: "1" })] }),
    ]);
  });

  it("keeps a failing socket from starving the rest of a broadcast", async () => {
    const hub = new RealtimeHub({ store: {} as unknown as OpensteerStore });
    const userId = createId("user");
    const broken: RealtimeSink = {
      id: "broken",
      close: () => undefined,
      send: async () => {
        throw new Error("socket is gone");
      },
    };
    const healthy = new MemorySink("healthy");
    const sessionId = createId("authSession");
    hub.registerConnection(userId, sessionId, broken);
    hub.registerConnection(userId, sessionId, healthy);

    expect(() => hub.broadcast({ type: "host.machines.changed" })).not.toThrow();
    await Promise.resolve();
    expect(healthy.messages).toEqual([{ type: "host.machines.changed" }]);
  });
});

function activeMembership(workspaceId: WorkspaceId, userId: UserId) {
  return {
    generation: 1,
    id: createId("workspaceMembership"),
    invitedBy: null,
    joinedAt: new Date(),
    role: "owner" as const,
    state: "active" as const,
    userId,
    workspaceId,
  };
}

class MemorySink implements RealtimeSink {
  closed: { readonly code: number; readonly reason: string } | undefined;
  readonly id: string;
  readonly messages: HostToClientMessage[] = [];
  constructor(id = "sink-1") {
    this.id = id;
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  async send(message: HostToClientMessage): Promise<void> {
    this.messages.push(message);
  }
}

function snapshot(workspaceId: WorkspaceId, value: string): WorkspaceSnapshot {
  const now = new Date().toISOString();
  return {
    notificationPreferences: [{ workspaceId, muted: false, revision: sequence("0") }],
    readStates: [],
    messages: [],
    messageWindows: [],
    pendingRequests: [],
    pendingRequestWindow: {
      byteCount: 2,
      hasMore: false,
      itemCount: 0,
      nextBefore: null,
      totalItems: 0,
    },
    runQueue: [],
    sequence: sequence(value),
    serializedBytes: 512,
    threadWindow: { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 },
    threads: [],
    workspace: {
      capacity: { kind: "managed-quota" },
      createdAt: now,
      homeThreadId: null,
      icon: null,
      id: workspaceId,
      kind: "main",
      location: { kind: "shared-storage" },
      name: "Workspace",
      status: "ready",
      storageIssue: null,
      updatedAt: now,
    },
  };
}

function viewerState() {
  return {
    readMarkerPage: async () => ({ markers: [], nextAfterThreadId: null }),
    listReadStates: async () => [],
    workspacePreferencePage: async () => ({ preferences: [], nextAfterWorkspaceId: null }),
  };
}

function event(workspaceId: WorkspaceId, value: string): AgentEvent {
  return {
    createdAt: new Date().toISOString(),
    data: { status: "running", startedBy: { kind: "platform", cause: "test" } },
    environmentId: createId("environment"),
    eventId: createId("event"),
    runId: createId("run"),
    sequence: sequence(value),
    threadId: createId("thread"),
    type: "run.started",
    workspaceId,
  };
}

function sequence(value: string): Sequence {
  return SequenceSchema.parse(value);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the subscriber");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
