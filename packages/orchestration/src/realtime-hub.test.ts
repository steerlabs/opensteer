import {
  SequenceSchema,
  createId,
  type AgentEvent,
  type Sequence,
  type UserId,
  type DeploymentId,
} from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import {
  BrowserSurfaceIdSchema,
  type HostToClientMessage,
  type DeploymentSnapshot,
} from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { LiveRunRegistry, RealtimeHub, type RealtimeSink } from "./index.js";
describe("snapshot-before-live synchronization", () => {
  it("sends show once only to opted-in subscriptions of the personal owner, without replay", async () => {
    const deploymentId = createId("deployment");
    const userId = createId("user");
    const hub = new RealtimeHub({
      store: {
        notificationState: viewerState(),
        database: personalDatabase(deploymentId, userId),
        deploymentSnapshot: async (deploymentId: DeploymentId) => snapshot(deploymentId, "0"),
      } as unknown as OpensteerStore,
    });
    const subscriptions = [
      {
        userId,
        personShow: "accept" as const,
      },
      {
        userId,
      },
    ];
    const sinks = subscriptions.map(() => new MemorySink());
    const releases = await Promise.all(
      subscriptions.map((subscription, index) =>
        hub.subscribe({
          deploymentId,
          ...subscription,
          afterSequence: sequence("0"),
          sink: sinks[index]!,
        }),
      ),
    );
    try {
      const message = {
        type: "host.show" as const,
        runId: createId("run"),
        threadId: createId("thread"),
        target: {
          tabId: BrowserSurfaceIdSchema.parse("gmail"),
        },
      };
      expect(await hub.showToPerson(userId, message)).toBe(1);
      for (const [index, sink] of sinks.entries())
        expect(sink.messages.filter((message) => message.type === "host.show")).toEqual(
          index === 0 ? [message] : [],
        );
      releases[0]!();
      const reconnect = new MemorySink();
      releases.push(
        await hub.subscribe({
          deploymentId,
          ...subscriptions[0]!,
          afterSequence: sequence("0"),
          sink: reconnect,
        }),
      );
      expect(reconnect.messages.some((message) => message.type === "host.show")).toBe(false);
      for (const release of releases) release();
      expect(await hub.showToPerson(userId, message)).toBe(0);
    } finally {
      for (const release of releases) release();
    }
  });
  it.each([false, true])(
    "projects place events for opt-in %s without holding live progress or resetting the stream",
    async (opted) => {
      const deploymentId = createId("deployment");
      const userId = createId("user");
      const deploymentSnapshot = vi.fn(async () => snapshot(deploymentId, "0"));
      const store = {
        notificationState: viewerState(),
        database: personalDatabase(deploymentId, userId),
        deploymentSnapshot,
      } as unknown as OpensteerStore;
      const hub = new RealtimeHub({
        store,
      });
      const sink = new MemorySink();
      const unsubscribe = await hub.subscribe({
        deploymentId,
        afterSequence: sequence("0"),
        sink,
        userId,
        ...(opted
          ? {
              placeEvents: "include" as const,
            }
          : {}),
      });
      try {
        expect(deploymentSnapshot).toHaveBeenCalledWith({
          listedOnly: true,
          viewerId: userId,
          ...(opted
            ? {
                placeEvents: "include",
              }
            : {}),
        });
        const place = {
          ...event(deploymentId, "1"),
          type: "place.entered",
          runId: createId("run"),
          data: {
            place: {
              kind: "browser",
              sessionId: "bsn_11111111-1111-4111-8111-111111111111",
              surfaceId: "A",
            },
            title: "Page",
            site: null,
          },
        } as AgentEvent;
        const synchronizations = () =>
          sink.messages.filter((message) => message.type === "host.synchronized").length;
        await vi.waitFor(
          () => expect(synchronizations(), "the subscription never synchronized").toBe(1),
          {
            timeout: 1000,
          },
        );
        hub.publish(place);
        const progress = {
          items: [
            {
              at: 0,
              op: "append" as const,
              stream: "assistant" as const,
              text: "Hi",
            },
          ],
          runId: place.runId!,
          threadId: place.threadId,
        };
        hub.publishLive({
          afterSequence: sequence("1"),
          progress,
        });
        // A client that left the place event out never waits on it: its frame
        // follows the last event it was sent, and nothing resets its streams.
        await vi.waitFor(
          () =>
            expect(
              sink.messages.find((message) => message.type === "host.live"),
              "the live frame never arrived",
            ).toMatchObject({
              afterSequence: sequence(opted ? "1" : "0"),
            }),
          {
            timeout: 1000,
          },
        );
        expect(synchronizations()).toBe(1);
        expect(
          sink.messages
            .flatMap((message) => (message.type === "host.events" ? message.events : []))
            .some((entry) => entry.type === "place.entered"),
        ).toBe(opted);
        const next = event(deploymentId, "2");
        hub.publish(next);
        await vi.waitFor(
          () =>
            expect(sink.messages).toContainEqual({
              type: "host.events",
              throughSequence: next.sequence,
              events: [next],
            }),
          {
            timeout: 1000,
          },
        );
      } finally {
        unsubscribe();
      }
    },
  );
  it("switches node watches at the delivery boundary and filters durable and live detail", async () => {
    const deploymentId = createId("deployment");
    const userId = createId("user");
    const nodeId = createId("executionNode");
    const otherNodeId = createId("executionNode");
    const hub = new RealtimeHub({
      store: {
        notificationState: viewerState(),
        database: personalDatabase(deploymentId, userId),
        deploymentSnapshot: async () => snapshot(deploymentId, "0"),
      } as unknown as OpensteerStore,
    });
    const sink = new MemorySink();
    const release = await hub.subscribe({
      deploymentId,
      afterSequence: sequence("0"),
      sink,
      userId,
      placeEvents: "include",
    });
    const detail = (value: string, id = nodeId): AgentEvent => ({
      ...event(deploymentId, value),
      type: "node.message",
      data: {
        nodeId: id,
        text: value,
      },
    });
    const received = () =>
      sink.messages.flatMap((message) => (message.type === "host.events" ? message.events : []));
    const watch = (id: typeof nodeId | null) =>
      hub.watchNode({
        sinkId: sink.id,
        nodeId: id,
      });
    try {
      const first = detail("1");
      hub.publish(first);
      hub.publishLive({
        afterSequence: sequence("1"),
        progress: {
          runId: first.runId!,
          threadId: first.threadId,
          items: [
            {
              callId: "child-tool",
              nodeId,
              stream: "tool",
              op: "append",
              at: 0,
              text: "private",
            },
            {
              nodeId,
              stream: "node",
              op: "replace",
              length: 7,
              text: "working",
            },
          ],
        },
      });
      await vi.waitFor(
        () =>
          expect(sink.messages.find((message) => message.type === "host.live")).toMatchObject({
            afterSequence: "0",
            progress: {
              items: [
                {
                  nodeId,
                  stream: "node",
                  op: "replace",
                  length: 7,
                  text: "working",
                },
              ],
            },
          }),
        {
          timeout: 1_000,
        },
      );
      expect(received()).toEqual([]);
      watch(nodeId);
      // Events queued on either side of the watch must stay on their side of its acknowledgement.
      hub.publish(detail("2"));
      hub.publish(detail("3", otherNodeId));
      watch(otherNodeId);
      hub.publish(detail("4"));
      hub.publish(detail("5", otherNodeId));
      hub.publishLive({
        afterSequence: sequence("5"),
        progress: {
          runId: first.runId!,
          threadId: first.threadId,
          items: [
            {
              callId: "child-tool",
              nodeId,
              stream: "tool",
              op: "append",
              at: 0,
              text: "private",
            },
            {
              callId: "other-tool",
              nodeId: otherNodeId,
              stream: "tool",
              op: "append",
              at: 0,
              text: "visible",
            },
          ],
        },
      });
      await vi.waitFor(
        () =>
          expect(sink.messages.filter((message) => message.type === "host.live")).toHaveLength(2),
        {
          timeout: 1_000,
        },
      );
      expect(received().map((event) => event.sequence)).toEqual(["2", "5"]);
      expect(sink.messages.filter((message) => message.type === "host.node-watched")).toEqual([
        {
          type: "host.node-watched",
          nodeId,
          sequence: "1",
        },
        {
          type: "host.node-watched",
          nodeId: otherNodeId,
          sequence: "3",
        },
      ]);
      const secondLive = sink.messages.filter((message) => message.type === "host.live")[1]!;
      expect(secondLive.progress.items).toEqual([
        {
          callId: "other-tool",
          nodeId: otherNodeId,
          stream: "tool",
          op: "append",
          at: 0,
          text: "visible",
        },
      ]);
      expect(secondLive.afterSequence).toBe("5");
      watch(null);
      hub.publish(detail("6", otherNodeId));
      hub.publish(event(deploymentId, "7"));
      await vi.waitFor(() => expect(received().at(-1)?.sequence).toBe("7"), {
        timeout: 1_000,
      });
      expect(received().map((event) => event.sequence)).toEqual(["2", "5", "7"]);
    } finally {
      release();
    }
  });
  it("sends a running tool's output so far to a reader that starts watching its subagent", async () => {
    const deploymentId = createId("deployment");
    const userId = createId("user");
    const nodeId = createId("executionNode");
    const liveRuns = new LiveRunRegistry();
    const seed = event(deploymentId, "1");
    liveRuns.observeCommitted([seed]);
    const hub = new RealtimeHub({
      liveRuns,
      store: {
        notificationState: viewerState(),
        database: personalDatabase(deploymentId, userId),
        deploymentSnapshot: async () => snapshot(deploymentId, "1"),
      } as unknown as OpensteerStore,
    });
    const sink = new MemorySink();
    const release = await hub.subscribe({
      deploymentId,
      afterSequence: sequence("0"),
      sink,
      userId,
    });
    try {
      const progress = {
        runId: seed.runId!,
        threadId: seed.threadId,
        items: [
          {
            callId: "child-tool",
            nodeId,
            stream: "tool" as const,
            op: "append" as const,
            at: 0,
            text: "so far",
          },
        ],
      };
      const frame = liveRuns.apply(progress);
      if (frame) hub.publishLive(frame);
      hub.watchNode({
        sinkId: sink.id,
        nodeId,
      });
      await vi.waitFor(
        () =>
          expect(sink.messages.filter((message) => message.type === "host.live")).toHaveLength(1),
        {
          timeout: 1_000,
        },
      );
      expect(sink.messages.find((message) => message.type === "host.live")).toMatchObject({
        progress: {
          items: [
            {
              callId: "child-tool",
              nodeId,
              stream: "tool",
              op: "replace",
              length: 6,
              text: "so far",
            },
          ],
        },
      });
    } finally {
      release();
    }
  });
  it("acknowledges a watch requested during synchronization after its replay boundary", async () => {
    const deploymentId = createId("deployment");
    const userId = createId("user");
    const nodeId = createId("executionNode");
    const ready = Promise.withResolvers<DeploymentSnapshot>();
    const liveRuns = new LiveRunRegistry();
    const seed = event(deploymentId, "1");
    const progress = {
      runId: seed.runId!,
      threadId: seed.threadId,
      items: [
        {
          callId: "child-tool",
          nodeId,
          stream: "tool" as const,
          op: "append" as const,
          at: 0,
          text: "private",
        },
        {
          nodeId,
          stream: "node" as const,
          op: "replace" as const,
          length: 4,
          text: "work",
        },
      ],
    };
    liveRuns.observeCommitted([seed]);
    liveRuns.apply(progress);
    const hub = new RealtimeHub({
      liveRuns,
      store: {
        notificationState: viewerState(),
        database: personalDatabase(deploymentId, userId),
        deploymentSnapshot: async () => ready.promise,
      } as unknown as OpensteerStore,
    });
    const sink = new MemorySink();
    const pending = hub.subscribe({ deploymentId, afterSequence: sequence("0"), sink, userId });
    hub.watchNode({
      sinkId: sink.id,
      nodeId,
    });
    const second: AgentEvent = {
      ...seed,
      sequence: sequence("2"),
      type: "node.message",
      data: {
        nodeId,
        text: "before watch",
      },
    };
    hub.publish(second);
    ready.resolve(snapshot(deploymentId, "1"));
    const release = await pending;
    try {
      await vi.waitFor(
        () =>
          expect(sink.messages.filter((message) => message.type === "host.live")).toHaveLength(1),
        {
          timeout: 1_000,
        },
      );
      expect(sink.messages.filter((message) => message.type === "host.node-watched")).toEqual([
        {
          type: "host.node-watched",
          nodeId,
          sequence: "2",
        },
      ]);
      expect(
        sink.messages.flatMap((message) => (message.type === "host.events" ? message.events : [])),
      ).toEqual([]);
      expect(sink.messages.find((message) => message.type === "host.live")).toMatchObject({
        progress: {
          items: [
            {
              callId: "child-tool",
              nodeId,
              stream: "tool",
              op: "replace",
              length: 7,
              text: "private",
            },
            {
              nodeId,
              stream: "node",
              op: "replace",
              length: 4,
              text: "work",
            },
          ],
        },
      });
      hub.publish({
        ...second,
        sequence: sequence("3"),
        eventId: createId("event"),
      });
      await vi.waitFor(
        () =>
          expect(
            sink.messages.flatMap((message) =>
              message.type === "host.events" ? message.events.map((event) => event.sequence) : [],
            ),
          ).toEqual(["3"]),
        {
          timeout: 1_000,
        },
      );
      const unwatched = new MemorySink("unwatched");
      const stop = await hub.subscribe({
        deploymentId,
        afterSequence: sequence("0"),
        sink: unwatched,
        userId,
      });
      try {
        await vi.waitFor(
          () =>
            expect(unwatched.messages.some((message) => message.type === "host.live")).toBe(true),
          {
            timeout: 1_000,
          },
        );
        expect(
          unwatched.messages.flatMap((message) =>
            message.type === "host.live" ? message.progress.items : [],
          ),
        ).toEqual([
          {
            nodeId,
            stream: "node",
            op: "replace",
            length: 4,
            text: "work",
          },
        ]);
      } finally {
        stop();
      }
      liveRuns.observeCommitted([
        {
          ...seed,
          sequence: sequence("4"),
          type: "node.completed",
          data: {
            nodeId,
            status: "completed",
            result: null,
            usage: null,
          },
        },
      ]);
      expect(
        liveRuns
          .threadFrames(seed.threadId)
          .flatMap((frame) => frame.progress.items)
          .some((item) => item.stream === "node"),
      ).toBe(false);
      liveRuns.observeCommitted([
        {
          ...seed,
          sequence: sequence("5"),
          type: "run.completed",
          data: {
            ...seed.data,
            status: "completed",
            replyMessageId: null,
          },
        },
      ]);
      expect(liveRuns.threadFrames(seed.threadId)).toEqual([]);
    } finally {
      release();
    }
  });
  it("counts broad notices once at publication, before socket fanout", () => {
    const hub = new RealtimeHub({
      store: {} as OpensteerStore,
    });
    const summary = JSON.stringify({
      windowMs: 1,
      triggers: {
        refresh: 6,
      },
      starts: {
        refresh: 6,
      },
    });
    hub.publishBrowserSessionsChanged(
      [createId("user"), createId("user")],
      "browser.catalog-flush",
    );
    hub.broadcast(
      {
        type: "host.machines.changed",
      },
      "computer-apps.status",
    );
    hub.sendToUsers(
      [createId("user")],
      {
        type: "host.machine.access.session.started",
      } as HostToClientMessage,
      "machine.access",
    );
    hub.broadcast({
      type: "host.tasks-changed",
    });
    expect(JSON.parse(hub.bootstrapDiagnostics.report(summary)!.notices as string)).toEqual({
      "host.browser-sessions-changed/browser.catalog-flush": 1,
      "host.machines.changed/computer-apps.status": 1,
      "host.machine.access.session.started/machine.access": 1,
    });
  });
  it.each([undefined, "omit"] as const)(
    "passes snapshotMessages=%s to the store",
    async (snapshotMessages) => {
      const deploymentId = createId("deployment");
      const userId = createId("user");
      const deploymentSnapshot = vi.fn(async () => snapshot(deploymentId, "0"));
      const store = {
        notificationState: viewerState(),
        database: personalDatabase(deploymentId, userId),
        deploymentSnapshot,
      } as unknown as OpensteerStore;
      const hub = new RealtimeHub({
        store,
      });
      const sink = new MemorySink();
      const unsubscribe = await hub.subscribe({
        deploymentId,
        afterSequence: sequence("0"),
        sink,
        userId,
        ...(snapshotMessages
          ? {
              snapshotMessages,
            }
          : {}),
      });
      try {
        expect(deploymentSnapshot).toHaveBeenCalledWith({
          listedOnly: true,
          viewerId: userId,
          ...(snapshotMessages
            ? {
                omitMessages: true,
              }
            : {}),
        });
      } finally {
        unsubscribe();
      }
    },
  );
  it("buffers an event committed while the snapshot is being read", async () => {
    const deploymentId = createId("deployment");
    const userId = createId("user");
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const store = {
      notificationState: viewerState(),
      database: personalDatabase(deploymentId, userId),
      deploymentSnapshot: async () => {
        await snapshotGate;
        return snapshot(deploymentId, "0");
      },
    } as unknown as OpensteerStore;
    const hub = new RealtimeHub({
      store,
    });
    const sink = new MemorySink();
    const subscribed = hub.subscribe({ deploymentId, afterSequence: sequence("0"), sink, userId });
    hub.publish(event(deploymentId, "1"));
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
    const deploymentId = createId("deployment");
    const userId = createId("user");
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const store = {
      notificationState: viewerState(),
      database: personalDatabase(deploymentId, userId),
      deploymentSnapshot: async () => {
        await snapshotGate;
        return snapshot(deploymentId, "0");
      },
    } as unknown as OpensteerStore;
    const hub = new RealtimeHub({
      store,
    });
    const sink = new MemorySink();
    hub.registerConnection(userId, createId("authSession"), sink);
    const subscribed = hub.subscribe({ deploymentId, afterSequence: sequence("0"), sink, userId });
    hub.publishBrowserSessionsChanged([userId]);
    // A second notice of the same kind says what the first one says.
    hub.publishBrowserSessionsChanged([userId]);
    hub.publishTriggersChanged();
    releaseSnapshot();
    const unsubscribe = await subscribed;
    expect(sink.messages.map(({ type }) => type)).toEqual([
      "host.snapshot",
      "host.browser-sessions-changed",
      "host.triggers-changed",
      "host.synchronized",
    ]);
    expect(
      sink.messages.filter((message) => message.type === "host.browser-sessions-changed"),
    ).toEqual([
      {
        type: "host.browser-sessions-changed",
      },
    ]);
    unsubscribe();
  });
  it("keeps delivering in order when a publication arrives while its hole is being read", async () => {
    const deploymentId = createId("deployment");
    const userId = createId("user");
    const fills: {
      readonly after: Sequence;
      readonly resolve: (events: readonly AgentEvent[]) => void;
      readonly through: Sequence;
    }[] = [];
    const store = {
      eventsAfterWindow: (
        after: Sequence,
        options: {
          readonly throughSequence: Sequence;
        },
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
      deploymentHead: async () => sequence("1"),
      database: personalDatabase(deploymentId, userId),
    } as unknown as OpensteerStore;
    const hub = new RealtimeHub({
      gapFillDelayMs: 1,
      store,
    });
    const sink = new MemorySink();
    const unsubscribe = await hub.subscribe({
      deploymentId,
      afterSequence: sequence("1"),
      sink,
      userId,
    });
    const delivered = () =>
      sink.messages.flatMap((message) =>
        message.type === "host.events" ? message.events.map(({ sequence }) => sequence) : [],
      );
    hub.publish(event(deploymentId, "5"));
    await waitUntil(() => fills.length === 1);
    expect(fills[0]).toMatchObject({
      after: "1",
      through: "4",
    });
    // Sequence 3 is published while the read of 2–4 is in flight.
    hub.publish(event(deploymentId, "3"));
    fills[0]!.resolve([
      event(deploymentId, "2"),
      event(deploymentId, "3"),
      event(deploymentId, "4"),
    ]);
    await waitUntil(() => delivered().length === 4);
    expect(delivered()).toEqual(["2", "3", "4", "5"]);

    // The next hole is read and filled rather than stranded behind sequence 3.
    hub.publish(event(deploymentId, "7"));
    await waitUntil(() => fills.length === 2);
    expect(fills[1]).toMatchObject({
      after: "5",
      through: "6",
    });
    fills[1]!.resolve([event(deploymentId, "6")]);
    await waitUntil(() => delivered().length === 6);
    expect(delivered()).toEqual(["2", "3", "4", "5", "6", "7"]);
    unsubscribe();
  });
  it("resynchronizes a live subscriber whose hole read never answers", async () => {
    const deploymentId = createId("deployment");
    const userId = createId("user");
    let fills = 0;
    let head = sequence("1");
    const store = {
      eventsAfterWindow: () => {
        fills += 1;
        return new Promise(() => undefined);
      },
      notificationState: viewerState(),
      deploymentHead: async () => head,
      database: personalDatabase(deploymentId, userId),
    } as unknown as OpensteerStore;
    const hub = new RealtimeHub({
      gapFillDelayMs: 1,
      gapFillTimeoutMs: 20,
      store,
    });
    const sink = new MemorySink();
    const other = new MemorySink("sink-2");
    await hub.subscribe({ deploymentId, afterSequence: sequence("1"), sink, userId });
    head = sequence("5");
    await hub.subscribe({ deploymentId, afterSequence: sequence("5"), sink: other, userId });

    // Sequence 5 arrives with 2–4 missing, and the read for them hangs. The
    // socket stays open, so nothing but a deadline on the read ends the wait.
    hub.publish(event(deploymentId, "5"));
    await waitUntil(() => fills === 1);
    await waitUntil(() => sink.closed !== undefined);
    expect(sink.messages.at(-1)).toMatchObject({
      reason: "cursor-expired",
      type: "host.resync-required",
    });
    expect(sink.closed).toEqual({
      code: 4009,
      reason: "resync required",
    });
    hub.publish(event(deploymentId, "6"));
    await waitUntil(() => other.messages.some((message) => message.type === "host.events"));
    expect(sink.messages.filter((message) => message.type === "host.events")).toEqual([]);
    expect(other.closed).toBeUndefined();
  });
  it("sends a reconnecting subscriber's open streams in frames a client accepts", async () => {
    const deploymentId = createId("deployment");
    const userId = createId("user");
    const runId = createId("run");
    const threadId = createId("thread");
    const liveRuns = new LiveRunRegistry();
    liveRuns.observeCommitted([
      {
        ...event(deploymentId, "1"),
        runId,
        threadId,
      },
    ]);
    const output = "x".repeat(50 * 1_024);
    liveRuns.apply({
      items: Array.from(
        {
          length: 21,
        },
        (_value, index) => ({
          at: 0,
          callId: `call-${index}`,
          op: "append" as const,
          stream: "tool" as const,
          text: output,
        }),
      ),
      runId,
      threadId,
    });
    const store = {
      notificationState: viewerState(),
      database: personalDatabase(deploymentId, userId),
      deploymentSnapshot: async () => snapshot(deploymentId, "1"),
    } as unknown as OpensteerStore;
    const hub = new RealtimeHub({
      liveRuns,
      store,
    });
    const sink = new MemorySink();
    const unsubscribe = await hub.subscribe({
      deploymentId,
      afterSequence: sequence("0"),
      sink,
      userId,
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
    const deploymentId = createId("deployment");
    const userId = createId("user");
    const liveRuns = new LiveRunRegistry();
    const output = "x".repeat(50 * 1_024);
    for (let runIndex = 0; runIndex < 2; runIndex += 1) {
      const runId = createId("run");
      const threadId = createId("thread");
      liveRuns.observeCommitted([
        {
          ...event(deploymentId, "1"),
          runId,
          threadId,
        },
      ]);
      for (let batch = 0; batch < 4; batch += 1) {
        liveRuns.apply({
          items: Array.from(
            {
              length: 16,
            },
            (_value, index) => ({
              at: 0,
              callId: `call-${batch}-${index}`,
              op: "append" as const,
              stream: "tool" as const,
              text: output,
            }),
          ),
          runId,
          threadId,
        });
      }
    }
    const store = {
      notificationState: viewerState(),
      database: personalDatabase(deploymentId, userId),
      deploymentSnapshot: async () => snapshot(deploymentId, "1"),
    } as unknown as OpensteerStore;
    const hub = new RealtimeHub({
      liveRuns,
      store,
    });
    const sink = new MemorySink();
    const unsubscribe = await hub.subscribe({
      deploymentId,
      afterSequence: sequence("0"),
      sink,
      userId,
    });
    const streams = () =>
      sink.messages
        .flatMap((message) => (message.type === "host.live" ? message.progress.items : []))
        .filter((item) => item.stream === "tool").length;
    await waitUntil(() => streams() === 128);
    unsubscribe();
  });
  it("splits replay into byte-bounded frames without changing the event cursor", async () => {
    const deploymentId = createId("deployment");
    const userId = createId("user");
    const replay = [event(deploymentId, "2"), event(deploymentId, "3")];
    const oneEventFrameBytes = Buffer.byteLength(
      JSON.stringify({
        events: [replay[0]],
        throughSequence: replay[0]!.sequence,
        type: "host.events",
      }),
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
      deploymentHead: async () => sequence("3"),
      database: personalDatabase(deploymentId, userId),
    } as unknown as OpensteerStore;
    const hub = new RealtimeHub({
      maxWireBytes: oneEventFrameBytes + 1,
      store,
    });
    const sink = new MemorySink();
    const unsubscribe = await hub.subscribe({
      deploymentId,
      afterSequence: sequence("1"),
      sink,
      userId,
    });
    expect(
      sink.messages
        .filter((message) => message.type === "host.events")
        .map((message) => message.events.map(({ sequence }) => sequence)),
    ).toEqual([["2"], ["3"]]);
    expect(sink.messages.at(-1)).toMatchObject({
      sequence: "3",
      type: "host.synchronized",
    });
    unsubscribe();
  });
  it("delivers Browser Session invalidation to its viewers across connections", async () => {
    const deploymentId = createId("deployment");

    const userId = createId("user");
    const store = {
      notificationState: viewerState(),
      database: personalDatabase(deploymentId, userId),
      deploymentSnapshot: async (requested: DeploymentId) => snapshot(requested, "0"),
    } as unknown as OpensteerStore;
    const hub = new RealtimeHub({
      store,
    });
    const sink = new MemorySink();
    const otherSink = new MemorySink("other");
    hub.registerConnection(userId, createId("authSession"), sink);
    hub.registerConnection(userId, createId("authSession"), otherSink);
    const unsubscribe = await hub.subscribe({
      deploymentId,
      afterSequence: sequence("0"),
      sink,
      userId,
    });
    const unsubscribeOther = await hub.subscribe({
      deploymentId,
      afterSequence: sequence("0"),
      sink: otherSink,
      userId,
    });
    hub.publishBrowserSessionsChanged([userId]);
    await Promise.resolve();
    expect(sink.messages.at(-1)).toEqual({
      type: "host.browser-sessions-changed",
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
      const deploymentId = createId("deployment");
      const userId = createId("user");
      const store = {
        notificationState: viewerState(),
        database: personalDatabase(deploymentId, userId),
        deploymentSnapshot: async () => snapshot(deploymentId, "0"),
      } as unknown as OpensteerStore;
      const hub = new RealtimeHub({
        store,
      });
      const broken = new MemorySink("broken");
      const healthy = new MemorySink("healthy");
      const unsubscribe = await hub.subscribe({
        deploymentId,
        afterSequence: sequence("0"),
        sink: broken,
        userId,
      });
      const unsubscribeHealthy = await hub.subscribe({
        deploymentId,
        afterSequence: sequence("0"),
        sink: healthy,
        userId,
      });
      const close = vi.spyOn(broken, "close");
      const send = vi.spyOn(broken, "send").mockRejectedValue(new Error("socket is gone"));
      healthy.messages.length = 0;
      const publish = (value: string) => {
        if (type === "host.events") hub.publish(event(deploymentId, value));
        else if (type === "host.live")
          hub.publishLive({
            afterSequence: sequence("0"),
            progress: {
              items: [
                {
                  at: 0,
                  op: "append",
                  stream: "assistant",
                  text: value,
                },
              ],
              runId: createId("run"),
              threadId: createId("thread"),
            },
          });
        else hub.publishTriggersChanged();
      };
      try {
        publish("1");
        publish("2");
        await waitUntil(() => healthy.messages.length === 2);
        expect(close).toHaveBeenCalledExactlyOnceWith(1011, "Deployment delivery failed");
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
    const deploymentId = createId("deployment");
    const userId = createId("user");
    const store = {
      notificationState: viewerState(),
      database: personalDatabase(deploymentId, userId),
      deploymentSnapshot: async () => snapshot(deploymentId, "0"),
    } as unknown as OpensteerStore;
    const hub = new RealtimeHub({
      store,
    });
    const sink = new MemorySink();
    const unsubscribe = await hub.subscribe({
      deploymentId,
      afterSequence: sequence("0"),
      sink,
      userId,
    });
    const close = vi.spyOn(sink, "close");
    const send = vi.spyOn(sink, "send");
    unsubscribe();
    unsubscribe();
    hub.publish(event(deploymentId, "1"));
    hub.publishTriggersChanged();
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
describe("connection-addressed messages", () => {
  it("closes every socket from the ended session before another event can be published", async () => {
    const userId = createId("user");
    const deploymentId = createId("deployment");
    const store = {
      notificationState: viewerState(),
      database: personalDatabase(deploymentId, userId),
      deploymentSnapshot: async () => snapshot(deploymentId, "0"),
    } as unknown as OpensteerStore;
    const hub = new RealtimeHub({
      store,
    });
    const endedSession = createId("authSession");
    const survivingSession = createId("authSession");
    const first = new MemorySink("ended-1");
    const second = new MemorySink("ended-2");
    const survivor = new MemorySink("survivor");
    hub.registerConnection(userId, endedSession, first);
    hub.registerConnection(userId, endedSession, second);
    hub.registerConnection(userId, survivingSession, survivor);
    await hub.subscribe({ deploymentId, afterSequence: sequence("0"), sink: first, userId });
    await hub.subscribe({ deploymentId, afterSequence: sequence("0"), sink: survivor, userId });
    first.messages.length = 0;
    survivor.messages.length = 0;
    hub.closeSession(endedSession);
    hub.publish(event(deploymentId, "1"));
    await Promise.resolve();
    expect(first.closed).toEqual({
      code: 4003,
      reason: "Session ended",
    });
    expect(second.closed).toEqual({
      code: 4003,
      reason: "Session ended",
    });
    expect(survivor.closed).toBeUndefined();
    expect(first.messages).toEqual([]);
    // A Run starting changes what a task list shows, so the survivor also
    // hears, directly rather than behind the event stream, that tasks changed.
    expect(survivor.messages).toEqual([
      {
        type: "host.tasks-changed",
      },
      expect.objectContaining({
        events: [
          expect.objectContaining({
            sequence: "1",
          }),
        ],
      }),
    ]);
  });
  it("tells the Host's own observers when a person's agent connections change", () => {
    const hub = new RealtimeHub({
      store: {} as unknown as OpensteerStore,
    });
    const observed: string[] = [];
    hub.observe((change) => observed.push(change.type));

    // Open MCP sessions and waits learn of a revoked connection this way, even
    // when none of the person's devices is connected.
    hub.publishConnectionsChanged(createId("user"));
    expect(observed).toEqual(["host.connections-changed"]);
  });
  it("keeps a failing socket from starving the rest of a broadcast", async () => {
    const hub = new RealtimeHub({
      store: {} as unknown as OpensteerStore,
    });
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
    expect(() =>
      hub.broadcast({
        type: "host.machines.changed",
      }),
    ).not.toThrow();
    await Promise.resolve();
    expect(healthy.messages).toEqual([
      {
        type: "host.machines.changed",
      },
    ]);
  });
});
function personalDatabase(deploymentId: DeploymentId, ownerId: UserId) {
  return {
    selectFrom(table: string) {
      let requested = ownerId;
      const query = {
        innerJoin: () => query,
        select: () => query,
        orderBy: () => query,
        where(column: string, _operator: string, value: UserId) {
          if (column === "personalSettings.ownerId") requested = value;
          return query;
        },
        executeTakeFirst: async () => {
          if (table === "deployments") return { deploymentShape: { kind: "personal" } };
          if (table === "users") return { id: ownerId, disabledAt: null };
          return requested === ownerId ? { ownerId } : undefined;
        },
        executeTakeFirstOrThrow: async () => {
          if (table !== "deploymentEventState")
            throw new Error("Unexpected personal identity query");
          return { deploymentId };
        },
      };
      return query;
    },
  };
}
class MemorySink implements RealtimeSink {
  closed:
    | {
        readonly code: number;
        readonly reason: string;
      }
    | undefined;
  readonly id: string;
  readonly messages: HostToClientMessage[] = [];
  constructor(id = "sink-1") {
    this.id = id;
  }
  close(code: number, reason: string): void {
    this.closed = {
      code,
      reason,
    };
  }
  async send(message: HostToClientMessage): Promise<void> {
    this.messages.push(message);
  }
}
function snapshot(deploymentId: DeploymentId, value: string): DeploymentSnapshot {
  const window = { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 };
  const tasks = { tasks: [], readStates: [], window };
  return {
    deploymentId,
    readStates: [],
    messages: [],
    messageWindows: [],
    pendingRequests: [],
    pendingRequestWindow: window,
    runQueue: [],
    sequence: sequence(value),
    serializedBytes: 512,
    threadWindow: window,
    threads: [],
    tasks: { recent: tasks, active: tasks, done: tasks },
    needsYou: { count: 0, entries: [], window },
    resources: {
      appTabs: [],
      browser: {
        available: false,
        placements: [],
        profiles: [],
        groups: { rows: [], complete: true },
        tabs: [],
      },
    },
  };
}
function viewerState() {
  return {
    readMarkerPage: async () => ({
      markers: [],
      nextAfterThreadId: null,
    }),
    listReadStates: async () => [],
    workspacePreferencePage: async () => ({
      preferences: [],
      nextAfterDeploymentId: null,
    }),
  };
}
function event(
  _deploymentId: DeploymentId,
  value: string,
): Extract<
  AgentEvent,
  {
    type: "run.started";
  }
> {
  return {
    createdAt: new Date().toISOString(),
    data: {
      status: "running",
      startedAt: new Date().toISOString(),
      personWaiting: false,
      startedBy: {
        kind: "platform",
        cause: "test",
      },
    },
    environmentId: createId("environment"),
    eventId: createId("event"),
    runId: createId("run"),
    sequence: sequence(value),
    threadId: createId("thread"),
    type: "run.started",
  };
}
function sequence(value: string): Sequence {
  return SequenceSchema.parse(value);
}
async function waitUntil(predicate: () => boolean): Promise<void> {
  await vi.waitFor(
    () => expect(predicate(), "The subscriber never reached the expected state").toBe(true),
    { timeout: 2_000 },
  );
}
it.each([false, true])("sends tool previews only to opted-in subscribers (%s)", async (opted) => {
  const deploymentId = createId("deployment");
  const userId = createId("user");
  const hub = new RealtimeHub({
    store: {
      notificationState: viewerState(),
      database: personalDatabase(deploymentId, userId),
      deploymentSnapshot: async () => snapshot(deploymentId, "0"),
    } as unknown as OpensteerStore,
  });
  const sink = new MemorySink();
  const release = await hub.subscribe({
    deploymentId,
    afterSequence: sequence("0"),
    sink,
    userId,
    ...(opted
      ? {
          toolOutputs: "preview" as const,
        }
      : {}),
  });
  try {
    await vi.waitFor(
      () =>
        expect(
          sink.messages.some((message) => message.type === "host.synchronized"),
          "subscription never synchronized",
        ).toBe(true),
      {
        timeout: 1000,
      },
    );
    const text = "tool output\n".repeat(2000);
    hub.publish({
      ...event(deploymentId, "1"),
      type: "tool.completed",
      data: {
        callId: "call",
        isError: false,
        output: {
          text,
        },
      },
    });
    await vi.waitFor(
      () =>
        expect(
          sink.messages.some((message) => message.type === "host.events"),
          "tool completion never arrived",
        ).toBe(true),
      {
        timeout: 1000,
      },
    );
    const batch = sink.messages.find((message) => message.type === "host.events");
    const completed =
      batch?.type === "host.events"
        ? batch.events.find((event) => event.type === "tool.completed")
        : undefined;
    expect(completed?.type).toBe("tool.completed");
    if (completed?.type !== "tool.completed") throw new Error("Tool completion missing");
    expect(completed.data.output.text === text).toBe(!opted);
    expect(completed.data.outputPreview).toEqual(
      opted
        ? {
            bytes: Buffer.byteLength(text),
            cut: true,
            digest: expect.any(String),
          }
        : undefined,
    );
  } finally {
    release();
  }
});
