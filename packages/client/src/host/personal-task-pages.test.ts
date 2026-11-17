import { withTimeout } from "@opensteer/shared/withTimeout";
import { AgentEventViewSchema, createId, SequenceSchema } from "@opensteer/core";
import { ClientToHostMessageSchema } from "@opensteer/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
import { HttpHostClient } from "./host-session-client.js";
import type { ClientLifecycle, ClientLifecycleSnapshot } from "./lifecycle.js";
import { taskList } from "./task-list.js";
import { defaultThreadPlacement } from "./thread-placement.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
async function fixture(
  count: number,
  fetchOverride?: (host: MockPersonalHost) => typeof fetch,
  lifecycle?: ClientLifecycle,
) {
  let clock = 0;
  const mock = new MockHostClient({
    world: "first-run",
    latencyMs: 0,
    places: "absent",
    automations: "absent",
    subagents: "absent",
    now: () => new Date(1000 * ++clock),
  });
  const placement = defaultThreadPlacement(
    mock.getSnapshot().environments,
    mock.getSnapshot().harnesses,
  )!;
  for (let index = 0; index < count; index++)
    await mock.createThread({
      title: `Task ${index}`,
      accessMode: "full-access",
      environmentId: placement.environmentId,
      harnessInstanceId: placement.harnessInstanceId,
      modelSelection: placement.modelSelection,
    });
  const host = new MockPersonalHost(mock),
    client = new HttpHostClient({
      baseUrl: "http://mock-host",
      capabilities: ["quiet-tasks-v1"],
      fetch: fetchOverride?.(host) ?? host.fetch,
      webSocketFactory: host.connect,
      ...(lifecycle && { lifecycle }),
    });
  cleanups.push(() => {
    client.dispose();
    host.dispose();
  });
  return { mock, host, client };
}
it("installs consistent task windows and completion state before readiness, then pages the recent prefix", async () => {
  const f = await fixture(103),
    seen: number[] = [];
  f.client.subscribe(() => {
    const snapshot = f.client.getSnapshot();
    if (snapshot.savedViewReadiness?.tasksReady) {
      const entries = snapshot.tasks!.entries;
      expect(
        entries.every(
          ({ thread }) => thread.lastVisitedAt === null && thread.latestRunCompletedAt === null,
        ),
      ).toBe(true);
      seen.push(entries.length);
    }
  });
  await f.client.load();
  await vi.waitFor(() => expect(f.client.getSnapshot().tasks?.entries).toHaveLength(100));
  expect(f.client.getSnapshot().tasks?.window.hasMore).toBe(true);
  await f.client.loadEarlierTasks();
  expect(f.client.getSnapshot().tasks?.entries).toHaveLength(103);
  expect(f.client.getSnapshot().tasks?.window.hasMore).toBe(false);
  expect(seen).toContain(100);
  expect(seen).toContain(103);
});
it("fills all active windows after the bounded attach", async () => {
  const f = await fixture(103);
  for (const [index, thread] of f.mock.getSnapshot().threads.entries()) {
    const event = AgentEventViewSchema.parse({
      type: "thread.state-changed",
      threadId: thread.id,
      eventId: createId("event"),
      environmentId: thread.environmentId,
      runId: null,
      sequence: String(1000 + index),
      createdAt: new Date().toISOString(),
      data: { status: "running", inputQueuePaused: false, pendingRequests: 0 },
    });
    if (event.type !== "thread.state-changed") throw new Error("Expected task state.");
    f.mock.applyThreadStateChanged(event);
  }
  await f.client.load();
  await vi.waitFor(() =>
    expect(f.client.getSnapshot().activeTasks, "active task windows never filled").toHaveLength(
      103,
    ),
  );
  expect(f.client.getSnapshot().tasks?.entries).toHaveLength(100);
  expect(f.host.sockets.size).toBe(1);
});
it("coalesces dirty notices during a task read and reads again after the accepted cut", async () => {
  const gate = Promise.withResolvers<Response>();
  let recentReads = 0;
  const f = await fixture(2, (host) => async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)),
      raw = url.searchParams.get("input") ?? init?.body,
      payload = typeof raw === "string" ? JSON.parse(raw) : {};
    if (url.pathname.endsWith("/tasks.list") && !payload.active && !payload.done) {
      recentReads++;
      if (recentReads === 1) return gate.promise;
    }
    return host.fetch(input, init);
  });
  await f.client.load();
  await vi.waitFor(() => expect(f.client.getSnapshot().tasks?.entries).toHaveLength(2));
  const socket = [...f.host.sockets][0]!;
  socket.deliver({ type: "host.tasks-changed" });
  await vi.waitFor(() => expect(recentReads).toBe(1));
  socket.deliver({ type: "host.tasks-changed" });
  socket.deliver({ type: "host.tasks-changed" });
  const page = await f.mock.rpc["tasks.list"]({});
  gate.resolve(Response.json(page));
  await vi.waitFor(() => expect(recentReads, "dirty read was never renewed").toBe(2));
  expect(f.client.getSnapshot().tasks?.entries).toHaveLength(2);
});
it("discards a task page that finishes after logout and follows the Host's Done state", async () => {
  const gate = Promise.withResolvers<Response>();
  let hold = false,
    started = false,
    signedOut = false;
  const f = await fixture(103, (host) => async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)),
      raw = url.searchParams.get("input") ?? init?.body,
      payload = typeof raw === "string" ? JSON.parse(raw) : {};
    if (signedOut && url.pathname.endsWith("/bootstrap.get"))
      return Response.json(
        { ok: false, error: { code: "unauthorized", message: "Sign in", retryable: false } },
        { status: 401 },
      );
    if (hold && url.pathname.endsWith("/tasks.list") && payload.before) {
      started = true;
      return gate.promise;
    }
    return host.fetch(input, init);
  });
  await f.client.load();
  await vi.waitFor(() => expect(f.client.getSnapshot().tasks?.entries).toHaveLength(100));
  const task = f.client.getSnapshot().tasks!.entries[0]!.thread;
  await f.client.setTaskDone(task.id, true);
  await vi.waitFor(() =>
    expect(
      Object.values(f.client.getSnapshot().doneTasks).some((page) =>
        page.entries.some(({ thread }) => thread.id === task.id),
      ),
    ).toBe(true),
  );
  hold = true;
  const loading = f.client.loadEarlierTasks();
  await vi.waitFor(() => expect(started, "history page never began").toBe(true));
  signedOut = true;
  await f.client.refresh();
  expect(f.client.getSnapshot().session).toBe("authentication-required");
  gate.resolve(Response.json(await f.mock.rpc["tasks.list"]({ before: "100" })));
  await loading;
  expect(f.client.getSnapshot().tasks).toBeNull();
  expect(f.client.getSnapshot().activeTasks).toEqual([]);
  expect(f.client.getSnapshot().threadVisits).toEqual({});
});

it("keeps a visit and a newer active projection when an older task page arrives late", async () => {
  const gate = Promise.withResolvers<Response>();
  let held = false;
  let waiting = false;
  const f = await fixture(1, (host) => async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (held && url.pathname.endsWith("/tasks.list")) {
      waiting = true;
      return gate.promise;
    }
    return host.fetch(input, init);
  });
  await f.client.load();
  await vi.waitFor(() => expect(f.client.getSnapshot().tasks?.entries).toHaveLength(1));
  const thread = f.client.getSnapshot().tasks!.entries[0]!.thread;
  const stale = await f.mock.rpc["tasks.list"]({});
  if (!stale.ok) throw new Error("Task fixture is missing");
  stale.data.tasks[0]!.thread.latestRunCompletedAt = "2026-01-02T00:00:00.000Z";
  stale.data.tasks[0]!.lastReply = "From the late page";
  held = true;
  const socket = [...f.host.sockets][0]!;
  socket.deliver({ type: "host.tasks-changed" });
  await vi.waitFor(() => expect(waiting, "Task read never reached its gate").toBe(true));
  socket.deliver({
    type: "host.thread-visits",
    visits: [{ threadId: thread.id as never, lastVisitedAt: "2026-01-03T00:00:00.000Z" }],
  });
  f.host.publish(
    [
      AgentEventViewSchema.parse({
        type: "thread.state-changed",
        threadId: thread.id,
        eventId: createId("event"),
        environmentId: thread.environmentId,
        runId: null,
        sequence: "1000",
        createdAt: "2026-01-04T00:00:00.000Z",
        data: {
          status: "running",
          inputQueuePaused: false,
          pendingRequests: 0,
          latestRunCompletedAt: null,
        },
      }),
    ],
    "1000",
  );
  gate.resolve(Response.json(stale));
  await vi.waitFor(() =>
    expect(f.client.getSnapshot().tasks!.entries[0]!.lastReply, "late page never landed").toBe(
      "From the late page",
    ),
  );
  expect(f.client.getSnapshot().tasks!.entries[0]!.thread).toMatchObject({
    lastVisitedAt: "2026-01-03T00:00:00.000Z",
    latestRunCompletedAt: null,
    status: "running",
  });
  expect(f.client.getSnapshot().threadVisits[thread.id]).toBe("2026-01-03T00:00:00.000Z");
});

it.each(["recent", "active", "done"] as const)(
  "does not resurrect a removed task from an in-flight %s page",
  async (scope) => {
    const f = await fixture(
      1,
      (host) =>
        (...args) =>
          host.fetch(...args),
    );
    const thread = f.mock.getSnapshot().threads[0]!;
    if (scope === "done") await f.mock.setTaskDone(thread.id, true);
    if (scope === "active") {
      const event = AgentEventViewSchema.parse({
        type: "thread.state-changed",
        threadId: thread.id,
        environmentId: thread.environmentId,
        runId: null,
        eventId: createId("event"),
        sequence: "1000",
        createdAt: new Date().toISOString(),
        data: { status: "running", pendingRequests: 0, inputQueuePaused: false },
      });
      if (event.type !== "thread.state-changed") throw new Error("Wrong event");
      f.mock.applyThreadStateChanged(event);
    }
    await f.client.load();
    await f.client.loadDoneTasks();
    const entries = () =>
      scope === "recent"
        ? f.client.getSnapshot().tasks!.entries
        : scope === "active"
          ? f.client.getSnapshot().activeTasks
          : Object.values(f.client.getSnapshot().doneTasks)[0]!.entries;
    await vi.waitFor(
      () =>
        expect(
          entries().some((entry) => entry.thread.id === thread.id),
          "Task never appeared in its page",
        ).toBe(true),
      { timeout: 1000 },
    );
    const captured = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = f.host.fetch;
    let held = false;
    vi.spyOn(f.host, "fetch").mockImplementation(async (...args) => {
      const response = await original(...args);
      const url = new URL(String(args[0]));
      const input = JSON.parse(url.searchParams.get("input") ?? "{}");
      const matches =
        scope === "active"
          ? input.active
          : scope === "done"
            ? input.done
            : !input.active && !input.done;
      if (!held && url.pathname.endsWith("/tasks.list") && matches) {
        held = true;
        captured.resolve();
        await withTimeout(release.promise, 1000, {
          timeoutError: () => new Error("Held task page never released"),
        });
      }
      return response;
    });
    for (const socket of f.host.sockets) socket.deliver({ type: "host.tasks-changed" });
    await withTimeout(captured.promise, 1000, {
      timeoutError: () => new Error("Task page never reached its gate"),
    });
    f.host.publish(
      [
        AgentEventViewSchema.parse({
          type: "task.removed",
          threadId: thread.id,
          environmentId: thread.environmentId,
          runId: null,
          eventId: createId("event"),
          sequence: "100000",
          createdAt: new Date().toISOString(),
          data: {},
        }),
      ],
      "100000",
    );
    expect(entries().some((entry) => entry.thread.id === thread.id)).toBe(false);
    const beforeMerge = entries();
    const merged = Promise.withResolvers<void>();
    const stop = f.client.subscribe(() => {
      if (entries() !== beforeMerge) merged.resolve();
    });
    try {
      release.resolve();
      await withTimeout(merged.promise, 1000, {
        timeoutError: () => new Error("Task page never merged"),
      });
      expect(entries().some((entry) => entry.thread.id === thread.id)).toBe(false);
    } finally {
      release.resolve();
      stop();
    }
  },
);

function threadState(
  thread: { readonly id: string; readonly environmentId: string },
  sequence: string,
  data: { status: "idle" | "running"; inputQueuePaused?: boolean },
) {
  const event = AgentEventViewSchema.parse({
    type: "thread.state-changed",
    threadId: thread.id,
    eventId: createId("event"),
    environmentId: thread.environmentId,
    runId: null,
    sequence,
    createdAt: new Date().toISOString(),
    data: { inputQueuePaused: false, pendingRequests: 0, ...data },
  });
  if (event.type !== "thread.state-changed") throw new Error("Expected task state.");
  return event;
}

function countTaskReads(reads: { count: number }) {
  return (host: MockPersonalHost): typeof fetch =>
    async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/tasks.list")) reads.count++;
      return host.fetch(input, init);
    };
}

it("carries a task's live state into every held copy without rereading the list", async () => {
  const reads = { count: 0 };
  const f = await fixture(2, countTaskReads(reads));
  const [working, done] = f.mock.getSnapshot().threads;
  f.mock.applyThreadStateChanged(threadState(working!, "1000", { status: "running" }));
  await f.mock.setTaskDone(done!.id, true);
  await f.client.load();
  await f.client.loadDoneTasks();
  const copies = (id: string) => {
    const snapshot = f.client.getSnapshot();
    return [
      ...(snapshot.tasks?.entries ?? []),
      ...snapshot.activeTasks,
      ...Object.values(snapshot.doneTasks).flatMap((page) => page.entries),
    ]
      .filter(({ thread }) => thread.id === id)
      .map(({ thread }) => thread);
  };
  await vi.waitFor(() =>
    expect(taskList(f.client.getSnapshot()).working.map(({ threadId }) => threadId)).toEqual([
      working!.id,
    ]),
  );
  expect(copies(working!.id).length, "recent and active pages both hold the task").toBe(2);
  const before = reads.count;
  // Straight onto the stream: changing the mock would resend a whole snapshot and mask this.
  f.host.publish(
    [
      threadState(working!, "5000", { status: "idle" }),
      threadState(done!, "5001", { status: "idle", inputQueuePaused: true }),
    ],
    "5001",
  );
  await vi.waitFor(() =>
    expect(copies(working!.id).map(({ status }) => status)).toEqual(["idle", "idle"]),
  );
  const doneCopy = Object.values(f.client.getSnapshot().doneTasks)
    .flatMap((page) => page.entries)
    .find(({ thread }) => thread.id === done!.id);
  expect(doneCopy?.thread.inputQueuePaused, "the Done page follows too").toBe(true);
  expect(copies(done!.id).every(({ inputQueuePaused }) => inputQueuePaused)).toBe(true);
  expect(taskList(f.client.getSnapshot()).working).toEqual([]);
  expect(reads.count, "the row followed the event, not a list reread").toBe(before);
});

it("rereads tasks on the way back when their notice arrived hidden", async () => {
  let visibility: ClientLifecycleSnapshot["visibility"] = "foreground";
  const shown = new Set<() => void>(),
    hidden = new Set<() => void>();
  const lifecycle: ClientLifecycle = {
    getSnapshot: () => ({ network: "online", visibility }),
    onBackground: (listener) => (hidden.add(listener), () => void hidden.delete(listener)),
    onForeground: (listener) => (shown.add(listener), () => void shown.delete(listener)),
    onNetworkChange: () => () => undefined,
    socketTrustWindowMs: Number.POSITIVE_INFINITY,
  };
  const turn = (next: typeof visibility) => {
    visibility = next;
    for (const listener of next === "background" ? hidden : shown) listener();
  };
  const reads = { count: 0 };
  const f = await fixture(1, countTaskReads(reads), lifecycle);
  await f.client.load();
  await vi.waitFor(() => expect(f.client.getSnapshot().tasks?.entries).toHaveLength(1));
  const socket = [...f.host.sockets][0]!;
  const send = socket.send.bind(socket);
  const probe = Promise.withResolvers<string>();
  const deferPong = vi.spyOn(socket, "send").mockImplementation((data) => {
    const frame = ClientToHostMessageSchema.safeParse(typeof data === "string" && JSON.parse(data));
    if (frame.success && frame.data.type === "client.ping") probe.resolve(frame.data.nonce);
    else send(data);
  });
  turn("background");
  const hiddenAt = reads.count;
  socket.deliver({ type: "host.tasks-changed" });
  socket.deliver({ type: "host.tasks-changed" });
  expect(reads.count, "nothing is read while hidden").toBe(hiddenAt);
  turn("foreground");
  const nonce = await withTimeout(probe.promise, 1000, {
    timeoutError: () => new Error("Foreground never probed the held socket"),
  });
  expect(reads.count, "nothing is read until the probe is answered").toBe(hiddenAt);
  deferPong.mockRestore();
  socket.deliver({ type: "host.pong", nonce });
  await vi.waitFor(() =>
    expect(reads.count, "the hidden task notices were never reread").toBeGreaterThan(hiddenAt),
  );
  await f.client.refresh();
  expect(reads.count, "one reread per task scope answers the whole burst").toBe(hiddenAt + 3);
  const answered = reads.count;
  turn("background");
  turn("foreground");
  await f.client.refresh();
  expect(reads.count, "a quiet return rereads nothing").toBe(answered);
});

function fakeLifecycle(socketTrustWindowMs: number) {
  let visibility: ClientLifecycleSnapshot["visibility"] = "foreground";
  const shown = new Set<() => void>(),
    hidden = new Set<() => void>();
  const lifecycle: ClientLifecycle = {
    getSnapshot: () => ({ network: "online", visibility }),
    onBackground: (listener) => (hidden.add(listener), () => void hidden.delete(listener)),
    onForeground: (listener) => (shown.add(listener), () => void shown.delete(listener)),
    onNetworkChange: () => () => undefined,
    socketTrustWindowMs,
  };
  const turn = (next: typeof visibility) => {
    visibility = next;
    for (const listener of next === "background" ? hidden : shown) listener();
  };
  return { lifecycle, turn };
}

it("answers a hidden notice and a replayed subscription with one read per task scope", async () => {
  // Like a phone: a socket hidden past this is replaced on the way back.
  const { lifecycle, turn } = fakeLifecycle(0);
  const reads = { count: 0 };
  const f = await fixture(1, countTaskReads(reads), lifecycle);
  await f.client.load();
  await vi.waitFor(() => expect(f.client.getSnapshot().tasks?.entries).toHaveLength(1));
  // A recorded event lets the Host answer the new subscription by replay, not a snapshot.
  const thread = f.mock.getSnapshot().threads[0]!;
  f.host.publish([threadState(thread, "5000", { status: "idle" })], "5000");
  const [first] = [...f.host.sockets];
  turn("background");
  first!.deliver({ type: "host.tasks-changed" });
  const before = reads.count;
  turn("foreground");
  await vi.waitFor(() =>
    expect(reads.count, "a resumed subscription never caught up on tasks").toBe(before + 3),
  );
  await f.client.refresh();
  expect(reads.count, "the foreground and the replay share one read").toBe(before + 3);
  expect([...f.host.sockets]).not.toContain(first);
});

it("keeps a task notice owed when the read that answers it fails", async () => {
  const { lifecycle, turn } = fakeLifecycle(Number.POSITIVE_INFINITY);
  const reads = { count: 0 };
  let failing = false;
  const f = await fixture(
    1,
    (host) => async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/tasks.list")) {
        reads.count++;
        if (failing) return new Response("unavailable", { status: 503 });
      }
      return host.fetch(input, init);
    },
    lifecycle,
  );
  await f.client.load();
  await vi.waitFor(() => expect(f.client.getSnapshot().tasks?.entries).toHaveLength(1));
  turn("background");
  [...f.host.sockets][0]!.deliver({ type: "host.tasks-changed" });
  failing = true;
  const before = reads.count;
  turn("foreground");
  await vi.waitFor(() => expect(reads.count, "the owed read never ran").toBe(before + 3));
  failing = false;
  // Each return asks again; only one whose notice is still owed reads anything.
  await vi.waitFor(() => {
    turn("background");
    turn("foreground");
    expect(reads.count, "a failed read dropped what was owed").toBeGreaterThanOrEqual(before + 6);
  });
  await f.client.refresh();
  expect(reads.count, "an answered notice is not read again").toBe(before + 6);
});

it("pages keep their reader's Request count when the stream's thread state is newer", async () => {
  const reads = { count: 0 };
  const f = await fixture(1, countTaskReads(reads));
  await f.client.load();
  await vi.waitFor(() => expect(f.client.getSnapshot().tasks?.entries).toHaveLength(1));
  const thread = f.mock.getSnapshot().threads[0]!;
  const socket = [...f.host.sockets][0]!;
  // The stream's count includes inputs this reader cannot answer; the page's does not.
  socket.deliver({
    type: "host.events",
    events: [
      {
        ...threadState(thread, "900000", { status: "idle" }),
        data: { status: "idle", inputQueuePaused: false, pendingRequests: 1 },
      },
    ],
    throughSequence: SequenceSchema.parse("900000"),
  });
  const before = reads.count;
  socket.deliver({ type: "host.tasks-changed" });
  await vi.waitFor(() => expect(reads.count).toBe(before + 3));
  await f.client.refresh();
  expect(f.client.getSnapshot().tasks!.entries[0]!.thread.pendingRequests).toBe(0);
});

it("drops thread state, and answers in flight, from before a stream that restarted below it", async () => {
  const gate = Promise.withResolvers<void>();
  const reads = { count: 0 };
  let hold = false,
    oldPage: unknown = null;
  const f = await fixture(1, (host) => async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith("/tasks.list")) {
      reads.count++;
      if (hold) return gate.promise.then(() => Response.json(oldPage));
    }
    return host.fetch(input, init);
  });
  await f.client.load();
  await vi.waitFor(() => expect(f.client.getSnapshot().tasks?.entries).toHaveLength(1));
  const thread = f.mock.getSnapshot().threads[0]!;
  const working = () =>
    taskList(f.client.getSnapshot()).working.some(({ threadId }) => threadId === thread.id);
  const [first] = [...f.host.sockets];
  // A stream numbered far past what this Host now holds, as after a restored database.
  first!.deliver({
    type: "host.events",
    events: [threadState(thread, "900000", { status: "running" })],
    throughSequence: SequenceSchema.parse("900000"),
  });
  await vi.waitFor(() => expect(working()).toBe(true));
  // A recent-list read from the old history is still in flight across the reset.
  const old = await f.mock.rpc["tasks.list"]({});
  if (!old.ok) throw new Error("Task fixture is missing");
  old.data.asOfSequence = SequenceSchema.parse("900000");
  old.data.tasks[0]!.thread.status = "running";
  old.data.tasks[0]!.lastReply = "From the old history";
  oldPage = old;
  hold = true;
  first!.deliver({ type: "host.tasks-changed" });
  await vi.waitFor(() => expect(reads.count, "the old read never started").toBe(3));
  first!.deliver({ type: "host.resync-required", reason: "cursor-ahead" });
  await vi.waitFor(() =>
    expect(
      [...f.host.sockets].some((socket) => socket !== first),
      "never resubscribed",
    ).toBe(true),
  );
  await vi.waitFor(() => expect(working(), "the restarted stream's idle state lost").toBe(false));
  hold = false;
  // A notice under the new stream makes each held read go again once its old answer is handled.
  [...f.host.sockets].find((socket) => socket !== first)!.deliver({ type: "host.tasks-changed" });
  gate.resolve();
  await vi.waitFor(() =>
    expect(reads.count, "the old answers were never handled").toBeGreaterThanOrEqual(6),
  );
  await f.client.refresh();
  expect(working(), "an answer from the old history restored its state").toBe(false);
  expect(f.client.getSnapshot().tasks!.entries[0]!.lastReply).not.toBe("From the old history");
});
