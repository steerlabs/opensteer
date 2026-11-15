import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createId,
  OpensteerError,
  parseReferenceHref,
  ThreadIdSchema,
  type AgentEventView,
  type ReferenceId,
} from "@opensteer/core";
import type {
  AvailableReference,
  ReferenceResolveInput,
  ReferenceResolveResult,
} from "@opensteer/protocol";
import type { HostSnapshot } from "../host/client.js";
import { MockHostClient } from "../mock/mock-host-client.js";
import { ReferenceStore } from "./store.js";
import { localReference, localTeamReference } from "./local.js";
import { refTarget, teamPageTarget } from "./destination.js";

const fixture = new MockHostClient({ latencyMs: 0 });
const base = fixture.getSnapshot();
fixture.dispose();
const stores: ReferenceStore[] = [];
afterEach(() => {
  for (const store of stores) store.dispose();
  stores.length = 0;
  vi.useRealTimers();
});
function setup() {
  vi.useFakeTimers({ toFake: ["Date"] });
  let snapshot: HostSnapshot = {
    ...base,
    session: "authenticated",
    connection: "connected",
    threads: [],
    activeTasks: [],
    tasks: null,
    doneTasks: {},
    transcripts: {},
    requests: {},
    waitingRequests: [],
    inputQueues: {},
    threadAutomations: {},
    machines: [],
  };
  let changed = () => {};
  const calls: {
    input: ReferenceResolveInput;
    signal: AbortSignal | undefined;
    answer: ReturnType<typeof Promise.withResolvers<ReferenceResolveResult>>;
  }[] = [];
  const read = vi.fn((input: ReferenceResolveInput, signal?: AbortSignal) => {
    const answer = Promise.withResolvers<ReferenceResolveResult>();
    calls.push({ input, signal, answer });
    return answer.promise;
  });
  const store = new ReferenceStore({
    resolveReferences: read,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      changed = listener;
      return () => {
        changed = () => {};
      };
    },
  });
  stores.push(store);
  return {
    store,
    read,
    calls,
    snapshot: () => snapshot,
    update: (patch: Partial<HostSnapshot>) => {
      snapshot = { ...snapshot, ...patch };
      changed();
    },
  };
}
const task = (id: ReferenceId, title = "Resolved"): AvailableReference => ({
  status: "available",
  kind: "task",
  id: ThreadIdSchema.parse(id),
  title,
});
async function called(calls: readonly unknown[], count: number) {
  await vi.waitFor(() => expect(calls).toHaveLength(count), { timeout: 1000 });
}
function threadEvent(
  threadId: string,
  type: "thread.state-changed" | "task.removed",
): AgentEventView {
  return {
    type,
    threadId,
    data:
      type === "task.removed"
        ? {}
        : { title: "Renamed", status: "completed", inputQueuePaused: false, pendingRequests: 0 },
  } as unknown as AgentEventView;
}
it("uses genuinely held metadata without RPC, including hidden chips, and keeps snapshots stable", async () => {
  const { store, read, update } = setup();
  const thread = { ...base.threads[0]!, id: createId("thread"), title: "Held **title**" };
  update({ threads: [thread] });
  const ref = parseReferenceHref(`opensteer:${thread.id}`)!;
  const first = store.read(ref.id);
  store.subscribe(ref.id, () => {}, { enabled: false });
  store.subscribe(ref.id, () => {});
  await Promise.resolve();
  expect(first).toMatchObject({ state: "available", value: { title: "Held title" } });
  expect(store.read(ref.id)).toBe(first);
  expect(read).not.toHaveBeenCalled();
  expect(
    localReference(
      { ...base, transcripts: {}, inputQueues: {} },
      { kind: "run", id: createId("run") },
    ),
  ).toBeNull();
});
it("shares a microtask batch across consumers, deduplicates IDs and splits 65 with only one flight", async () => {
  const { store, calls } = setup();
  const ids = Array.from({ length: 65 }, () => createId("thread"));
  for (const id of ids) store.subscribe(id, () => {});
  store.subscribe(ids[0]!, () => {});
  expect(calls).toHaveLength(0);
  await called(calls, 1);
  expect(calls[0]!.input.ids).toEqual(ids.slice(0, 64));
  const extra = createId("thread");
  store.subscribe(extra, () => {});
  await Promise.resolve();
  expect(calls).toHaveLength(1);
  calls[0]!.answer.resolve({ results: ids.slice(0, 64).map((id) => task(id)) });
  await called(calls, 2);
  expect(calls[1]!.input.ids).toEqual([ids[64], extra]);
  calls[1]!.answer.resolve({ results: [task(ids[64]!), task(extra)] });
  await vi.waitFor(() => expect(store.read(extra).state).toBe("available"), { timeout: 1000 });
});
it("does no work for hidden or released chips and resolves on visibility retention", async () => {
  const { store, calls } = setup();
  const id = createId("thread");
  store.subscribe(id, () => {}, { enabled: false });
  const release = store.subscribe(id, () => {});
  release();
  await Promise.resolve();
  expect(calls).toHaveLength(0);
  store.subscribe(id, () => {});
  await called(calls, 1);
  calls[0]!.answer.resolve({ results: [task(id)] });
});
it.each([new Error("offline"), new OpensteerError({ code: "unauthorized", message: "Sign in" })])(
  "keeps failed lookups clickable and retries only on open/recovery: %s",
  async (error) => {
    const { store, calls } = setup();
    const id = createId("thread");
    store.subscribe(id, () => {});
    await called(calls, 1);
    calls[0]!.answer.reject(error);
    await vi.waitFor(() => expect(store.read(id).state).toBe("failed"), { timeout: 1000 });
    store.read(id);
    store.subscribe(id, () => {});
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    const retry = store.resolve(id);
    await called(calls, 2);
    calls[1]!.answer.resolve({ results: [task(id)] });
    expect(await retry).toMatchObject({ status: "available" });
  },
);
it.each(["available", "unavailable"] as const)(
  "revalidates cached %s after 30 seconds only on mount/open",
  async (status) => {
    const { store, calls } = setup();
    const id = createId("thread");
    const first = store.resolve(id);
    await called(calls, 1);
    calls[0]!.answer.resolve({ results: [status === "available" ? task(id) : { status, id }] });
    await first;
    const release = store.subscribe(id, () => {});
    vi.setSystemTime(Date.now() + 30_001);
    store.read(id);
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    release();
    store.subscribe(id, () => {});
    await called(calls, 2);
    calls[1]!.answer.resolve({ results: [task(id, "New")] });
  },
);
it("tracks held renames without unrelated redraws, and removal overrides an older held copy", async () => {
  const { store, calls, update } = setup();
  const id = createId("thread");
  const thread = { ...base.threads[0]!, id, title: "Old" };
  update({ threads: [thread] });
  const listener = vi.fn();
  store.subscribe(id, listener);
  update({ revision: 1000 });
  expect(listener).not.toHaveBeenCalled();
  update({ threads: [{ ...thread, title: "Renamed" }] });
  expect(store.read(id)).toMatchObject({ value: { title: "Renamed" } });
  expect(listener).toHaveBeenCalledTimes(1);
  store.accept(threadEvent(id, "task.removed"));
  expect(store.read(id)).toEqual({ state: "unavailable" });
  vi.setSystemTime(Date.now() + 30_001);
  const answer = store.resolve(id);
  await called(calls, 1);
  calls[0]!.answer.resolve({ results: [{ status: "unavailable", id }] });
  await answer;
  expect(store.read(id)).toEqual({ state: "unavailable" });
  store.accept(threadEvent(id, "thread.state-changed"));
  expect(store.read(id).state).toBe("available");
});
it("invalidates dependent titles, drops pre-event answers and merges the next batch", async () => {
  const { store, calls } = setup();
  const threadId = createId("thread"),
    id = createId("message");
  const first = store.resolve(id);
  await called(calls, 1);
  calls[0]!.answer.resolve({
    results: [
      {
        status: "available",
        kind: "message",
        id,
        threadId,
        location: "transcript",
        title: "Message · Old",
      },
    ],
  });
  await first;
  store.subscribe(id, () => {});
  store.accept(threadEvent(threadId, "thread.state-changed"));
  await called(calls, 2);
  store.accept(threadEvent(threadId, "task.removed"));
  expect(store.read(id).state).toBe("unavailable");
  calls[1]!.answer.resolve({
    results: [
      { status: "available", kind: "message", id, threadId, location: "transcript", title: "Late" },
    ],
  });
  await Promise.resolve();
  expect(store.read(id).state).toBe("unavailable");
});
it("refreshes visible remote entries on reconnect and out-of-band revisions", async () => {
  const { store, calls, update } = setup();
  const id = createId("thread");
  const promise = store.resolve(id);
  await called(calls, 1);
  calls[0]!.answer.resolve({ results: [task(id)] });
  await promise;
  store.subscribe(id, () => {});
  update({ connection: "offline" });
  update({ connection: "connected" });
  await called(calls, 2);
  calls[1]!.answer.resolve({ results: [task(id)] });
  const machine = createId("runner");
  store.subscribe(machine, () => {}, { enabled: false });
  update({ machineRevision: 100 });
  expect(calls).toHaveLength(2);
});
it.each(["sessionId", "deploymentId", "user"] as const)(
  "resets the owner generation on %s change and rejects late work",
  async (field) => {
    const { store, calls, update, snapshot } = setup();
    const id = createId("thread");
    const first = store.resolve(id);
    const rejected = expect(first).rejects.toThrow();
    await called(calls, 1);
    update(
      field === "user"
        ? { user: { ...snapshot().user!, id: createId("user") } }
        : { [field]: "other" },
    );
    expect(calls[0]!.signal?.aborted).toBe(true);
    calls[0]!.answer.resolve({ results: [task(id, "Private old title")] });
    await rejected;
    expect(store.read(id)).toEqual({ state: "unresolved" });
  },
);
it("bounds idle metadata to 1024, keeps retained entries, and settles disposal", async () => {
  const { store, calls } = setup();
  const id = createId("thread");
  const pending = store.resolve(id);
  const rejected = expect(pending).rejects.toThrow();
  await called(calls, 1);
  store.dispose();
  await rejected;
  calls[0]!.answer.resolve({ results: [task(id)] });
  expect(store.read(id)).toEqual({ state: "unresolved" });
  const snapshot: HostSnapshot = {
    ...base,
    session: "authenticated",
    connection: "connected",
    threads: [],
    activeTasks: [],
    tasks: null,
    doneTasks: {},
  };
  const bounded = new ReferenceStore({
    getSnapshot: () => snapshot,
    resolveReferences: async ({ ids }) => ({ results: ids.map((id) => task(id)) }),
  });
  stores.push(bounded);
  const retained = createId("thread");
  bounded.subscribe(retained, () => {});
  const ids = Array.from({ length: 1025 }, () => createId("thread"));
  await Promise.all(ids.map((id) => bounded.resolve(id)));
  expect(bounded.read(retained).state).toBe("available");
  expect(bounded.read(ids[0]!).state).toBe("unresolved");
  expect(bounded.read(ids.at(-1)!).state).toBe("available");
});
describe("destinations", () => {
  it("preserves each resource's navigation context", () => {
    const threadId = createId("thread"),
      anchorMessageId = createId("message");
    const runId = createId("run"),
      requestId = createId("request"),
      attachmentId = createId("attachment");
    expect(refTarget(task(threadId))).toEqual({ kind: "task", threadId });
    expect(
      refTarget({
        status: "available",
        kind: "run",
        id: runId,
        title: "Run",
        threadId,
        anchorMessageId,
      }),
    ).toEqual({ kind: "run", runId, threadId, anchorMessageId });
    expect(
      refTarget({
        status: "available",
        kind: "request",
        id: requestId,
        title: "Approval",
        threadId,
        requestStatus: "fulfilled",
      }),
    ).toEqual({ kind: "request", threadId, requestId, status: "fulfilled" });
    expect(
      refTarget({
        status: "available",
        kind: "message",
        id: anchorMessageId,
        title: "Message",
        threadId,
        location: "input-queue",
      }),
    ).toEqual({ kind: "message", threadId, messageId: anchorMessageId, location: "input-queue" });
    expect(
      refTarget({
        status: "available",
        kind: "attachment",
        id: attachmentId,
        title: "File",
        threadId: null,
        messageId: null,
      }),
    ).toEqual({ kind: "attachment", attachmentId });
    const triggerId = createId("trigger"),
      runnerId = createId("runner");
    expect(
      refTarget({ status: "available", kind: "automation", id: triggerId, title: "Daily" }),
    ).toEqual({ kind: "automation", triggerId });
    expect(
      refTarget({ status: "available", kind: "computer", id: runnerId, title: "Mac" }),
    ).toEqual({ kind: "computer", runnerId });
  });
  it("maps team pages without discovery and only reads names from their attached origin", () => {
    const origin = "https://team.example",
      topicId = createId("knowledgeTopic"),
      noteId = createId("knowledgeNote");
    const page = { origin, target: { kind: "knowledge-note" as const, topicId, noteId } };
    expect(teamPageTarget(page)).toEqual(page.target);
    expect(
      localTeamReference(page, { origin, notes: [{ id: noteId, topicId, title: "Held note" }] }),
    ).toEqual({ title: "Held note" });
    expect(
      localTeamReference(page, {
        origin: "https://unverified.example",
        notes: [{ id: noteId, topicId, title: "Wrong" }],
      }),
    ).toBeNull();
    expect(localTeamReference(page, { origin })).toBeNull();
  });
});

it("prefers a newer resolve to old held data, and authoritative absence stays until a later held update", async () => {
  const { store, calls, update } = setup();
  const id = createId("thread");
  const thread = { ...base.threads[0]!, id, title: "Older held title" };
  update({ threads: [thread] });
  const fresh = store.resolve(id, { refresh: true });
  await called(calls, 1);
  calls[0]!.answer.resolve({ results: [task(id, "Newer Host title")] });
  await fresh;
  expect(store.read(id)).toMatchObject({ value: { title: "Newer Host title" } });
  const missing = store.resolve(id, { refresh: true });
  await called(calls, 2);
  calls[1]!.answer.resolve({ results: [{ status: "unavailable", id }] });
  await missing;
  update({ revision: 100 });
  expect(store.read(id)).toEqual({ state: "unavailable" });
  update({ threads: [{ ...thread, title: "Later authoritative title" }] });
  expect(store.read(id)).toMatchObject({ value: { title: "Later authoritative title" } });
});
it("does not re-resolve a remote message when a parent state event repeats its held title", async () => {
  const { store, calls, update } = setup();
  const threadId = createId("thread"),
    id = createId("message");
  update({ threads: [{ ...base.threads[0]!, id: threadId, title: "Renamed" }] });
  const resolved = store.resolve(id);
  await called(calls, 1);
  calls[0]!.answer.resolve({
    results: [
      {
        status: "available",
        kind: "message",
        id,
        threadId,
        title: "Message · Renamed",
        location: "transcript",
      },
    ],
  });
  await resolved;
  store.subscribe(id, () => {});
  store.accept(threadEvent(threadId, "thread.state-changed"));
  await Promise.resolve();
  expect(calls).toHaveLength(1);
});

it("discards a child answer when its previously unknown parent was removed during the batch", async () => {
  const { store, calls } = setup();
  const id = createId("message"),
    threadId = createId("thread");
  const resolving = store.resolve(id);
  await called(calls, 1);
  store.accept(threadEvent(threadId, "task.removed"));
  calls[0]!.answer.resolve({
    results: [
      {
        status: "available",
        kind: "message",
        id,
        threadId,
        title: "Old answer",
        location: "transcript",
      },
    ],
  });
  expect(await resolving).toEqual({ status: "unavailable", id });
  expect(store.read(id)).toEqual({ state: "unavailable" });
});
it("holds automatic work while disconnected and sends one batch on connection recovery", async () => {
  const { store, calls, update } = setup();
  update({ connection: "offline" });
  const id = createId("thread");
  store.subscribe(id, () => {});
  await Promise.resolve();
  expect(calls).toHaveLength(0);
  store.reconnect();
  update({ connection: "connected" });
  await called(calls, 1);
  calls[0]!.answer.resolve({ results: [task(id)] });
});

