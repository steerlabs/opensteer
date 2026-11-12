import { createId } from "@opensteer/core";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
import { HttpHostClient } from "./host-session-client.js";
import { TaskDrafts, taskDraftKey } from "./task-drafts.js";
import type { PersonalStreamCheckpoint, PersonalStreamCache } from "./personal-stream-cache.js";
import { taskFolderGroups, newTaskDefaults } from "./task-folders.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture(cache?: PersonalStreamCache) {
  const host = new MockPersonalHost(
    new MockHostClient({
      world: "first-run",
      latencyMs: 0,
      places: "absent",
      automations: "absent",
      subagents: "absent",
    }),
  );
  const client = new HttpHostClient({
    baseUrl: "http://mock-host",
    capabilities: [],
    fetch: host.fetch,
    webSocketFactory: host.connect,
    refreshIntervalMs: 0,
    ...(cache ? { streamCache: cache } : {}),
  });
  cleanups.push(() => {
    client.dispose();
    host.dispose();
  });
  return { host, client };
}
it("attaches once and atomically persists only the state already applied at its resume cursor", async () => {
  const commits: PersonalStreamCheckpoint[] = [];
  let client: HttpHostClient;
  const cache: PersonalStreamCache = {
    load: async () => null,
    remove: async () => {},
    commit: async (checkpoint, current) => {
      if (!current()) return;
      expect(checkpoint.snapshot.needsYou).toEqual(client.getSnapshot().needsYou);
      commits.push(checkpoint);
    },
  };
  const f = fixture(cache);
  client = f.client;
  await client.load();
  await vi.waitFor(() => expect(client.deploymentPosition()).toBe("0"));
  expect(client.getSnapshot().tasks?.entries).toEqual([]);
  client.activateThread(createId("thread"));
  client.activateThread(createId("thread"));
  expect(f.host.sockets.size).toBe(1);
  const socket = [...f.host.sockets][0]!;
  const subscriptions = socket.sent
    .map((row) => JSON.parse(row))
    .filter((row) => row.type === "client.subscribe");
  expect(subscriptions).toHaveLength(1);
  expect(subscriptions[0].cursor).toMatchObject({ apiVersion: hostApiVersion, afterSequence: "0" });
  expect(subscriptions[0]).not.toHaveProperty("workspaceId");
  f.host.publish([], "47");
  expect(client.deploymentPosition()).toBe("47");
  expect([...f.host.sockets]).toEqual([socket]);
  await vi.waitFor(() => expect(commits.at(-1)?.cursor.afterSequence).toBe("47"));
  expect(client.deploymentPosition()).toBe("47");
});
it("restores an applied cut only for the same Deployment, viewer and epoch", async () => {
  let held: PersonalStreamCheckpoint | null = null;
  const cache: PersonalStreamCache = {
    load: async () => held,
    remove: async () => {
      held = null;
    },
    commit: async (checkpoint, current) => {
      if (current()) held = structuredClone(checkpoint);
    },
  };
  const f = fixture(cache);
  await f.client.load();
  await vi.waitFor(() => expect(held).not.toBeNull());
  f.host.publish([], "51");
  await vi.waitFor(() => expect(held?.cursor.afterSequence).toBe("51"));
  f.client.dispose();
  const restored = new HttpHostClient({
    baseUrl: "http://mock-host",
    capabilities: [],
    fetch: f.host.fetch,
    webSocketFactory: f.host.connect,
    refreshIntervalMs: 0,
    streamCache: cache,
  });
  cleanups.push(() => restored.dispose());
  await restored.load();
  await vi.waitFor(() =>
    expect(
      [...f.host.sockets][0]?.sent.some((row) => JSON.parse(row).cursor?.afterSequence === "51"),
    ).toBe(true),
  );
  expect(restored.getSnapshot().savedViewReadiness?.tasksReady).toBe(true);
  restored.dispose();
  const saved = held! as PersonalStreamCheckpoint;
  held = { ...saved, cursor: { ...saved.cursor, apiVersion: hostApiVersion + 1 } };
  const fresh = new HttpHostClient({
    baseUrl: "http://mock-host",
    capabilities: [],
    fetch: f.host.fetch,
    webSocketFactory: f.host.connect,
    refreshIntervalMs: 0,
    streamCache: cache,
  });
  cleanups.push(() => fresh.dispose());
  await fresh.load();
  await vi.waitFor(() =>
    expect(
      [...f.host.sockets][0]?.sent.some((row) => JSON.parse(row).cursor?.afterSequence === "0"),
    ).toBe(true),
  );
});
it("keeps edits made while drafts load and purges only their viewer's partition", async () => {
  let finish!: (value: unknown) => void;
  const records = new Map<string, unknown>(),
    scope = { deploymentId: createId("deployment"), userId: createId("user") },
    target = { threadId: createId("thread") };
  const writes: unknown[] = [];
  const drafts = new TaskDrafts(scope, {
    load: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    save: async (_, value) => {
      records.set(scope.userId, value);
      writes.push(value);
    },
    remove: async () => {
      records.delete(scope.userId);
    },
  });
  const loading = drafts.load();
  await drafts.set(target, "New edit");
  finish({ [taskDraftKey(target)]: "Old saved edit" });
  await loading;
  expect(drafts.getSnapshot()[taskDraftKey(target)]).toBe("New edit");
  records.set("another-viewer", { secret: "Keep" });
  await drafts.remove();
  expect(drafts.getSnapshot()).toEqual({});
  expect(records.has(scope.userId)).toBe(false);
  expect(records.has("another-viewer")).toBe(true);
  expect(writes).toHaveLength(1);
});
it("keeps the agent-home folder first and derives task admission only from Host facts", () => {
  const f = fixture(),
    snapshot = f.host.client.getSnapshot(),
    home = snapshot.personalSettings!.agentHome;
  expect(taskFolderGroups(snapshot)[0]).toMatchObject({ folder: home, agentHome: true, tasks: [] });
  const local = snapshot.environments[0]!;
  const remote = { ...local, id: createId("environment"), can: { executeTasks: false } };
  expect(newTaskDefaults({ ...snapshot, environments: [remote, local] }).environments).toEqual([
    local,
  ]);
  expect(
    newTaskDefaults({ ...snapshot, can: { ...snapshot.can!, createTasks: false } }).canCreate,
  ).toBe(false);
});
it("restores absolute task versions so replay cannot undo a newer HTTP answer", async () => {
  const { ThreadStateProjection } = await import("./thread-state.js");
  const { AgentEventViewSchema, SequenceSchema } = await import("@opensteer/core");
  const mock = new MockHostClient({ latencyMs: 0 });
  try {
    const thread = { ...mock.getSnapshot().threads[0]!, status: "idle" as const },
      first = new ThreadStateProjection();
    first.reconcile(thread, SequenceSchema.parse("200"));
    const saved = JSON.parse(JSON.stringify(first.checkpoint()));
    const restored = new ThreadStateProjection();
    restored.restore(saved);
    restored.record(
      AgentEventViewSchema.parse({
        type: "thread.state-changed",
        threadId: thread.id,
        eventId: createId("event"),
        environmentId: thread.environmentId,
        runId: null,
        sequence: "150",
        createdAt: new Date().toISOString(),
        data: { status: "running", inputQueuePaused: false, pendingRequests: 0 },
      }),
    );
    expect(
      restored.reconcile({ ...thread, status: "running" }, SequenceSchema.parse("150")).status,
    ).toBe("idle");
  } finally {
    mock.dispose();
  }
});
