import { AgentEventViewSchema, createId } from "@opensteer/core";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
import { HttpHostClient } from "./host-session-client.js";
import { defaultThreadPlacement } from "./thread-placement.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
async function fixture(count: number, fetchOverride?: (host: MockPersonalHost) => typeof fetch) {
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
      refreshIntervalMs: 0,
    });
  cleanups.push(() => {
    client.dispose();
    host.dispose();
  });
  return { mock, host, client };
}
it("installs consistent task windows and read states before readiness, then pages the recent prefix", async () => {
  const f = await fixture(103),
    seen: number[] = [];
  f.client.subscribe(() => {
    const snapshot = f.client.getSnapshot();
    if (snapshot.savedViewReadiness?.tasksReady) {
      const entries = snapshot.tasks!.entries;
      expect(
        entries.every(({ thread }) => snapshot.threadReadStates[thread.id] !== undefined),
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
  expect(f.client.getSnapshot().threadReadStates).toEqual({});
});
