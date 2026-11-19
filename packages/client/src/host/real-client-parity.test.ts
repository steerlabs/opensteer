import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
import { requestDecisionRevision } from "./client.js";
import type { ScopedClientMessage } from "@opensteer/protocol/personal-sync";
import { memoryCheckpointStorage } from "../test-support/memory-checkpoint-storage.js";
import { HttpHostClient } from "./host-session-client.js";
import { createPersonalStreamCache } from "./personal-stream-cache.js";

/*
 * The real client over the scoped wire: every value comes from protocol frames and Host reads,
 * never from the mock's own model, so a HostSnapshot field nothing fills shows up here.
 */

const open: { client: HttpHostClient; host: MockPersonalHost }[] = [];
afterEach(() => {
  for (const { client, host } of open.splice(0)) {
    client.dispose();
    host.dispose();
  }
});

async function connect(seed = new MockHostClient({ latencyMs: 0 })) {
  const host = new MockPersonalHost(seed);
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    fetch: host.fetch,
    webSocketFactory: host.connect,
    capabilities: [],
  });
  open.push({ client, host });
  await client.load();
  return { client, host };
}

it("lists the Requests this person answers, and drops one once it is answered", async () => {
  const { client, host } = await connect();
  const pending = host.client.getSnapshot().waitingRequests;
  expect(pending.length).toBeGreaterThan(0);
  await vi.waitFor(() =>
    expect(
      client
        .getSnapshot()
        .waitingRequests.map(({ request }) => request.id)
        .sort(),
    ).toEqual(pending.map(({ request }) => request.id).sort()),
  );
  const answered = pending.find(({ request }) => request.kind === "plugin.approval")!;
  const reviewed = await client.readRequest(
    answered.request.originatingThreadId,
    answered.request.id,
  );
  await client.dispatch({
    type: "request.respond",
    idempotencyKey: "answer-approval",
    requestId: answered.request.id,
    ...requestDecisionRevision(reviewed!),
    response: { kind: "external", value: { decision: "declined" } },
  });
  await vi.waitFor(() =>
    expect(
      client
        .getSnapshot()
        .waitingRequests.some(({ request }) => request.id === answered.request.id),
    ).toBe(false),
  );
});

it("fills every snapshot field the UI reads while a task works, asks and queues", async () => {
  const { client, host } = await connect(new MockHostClient({ latencyMs: 0, places: "absent" }));
  const kinds = [
    "settings",
    "identity",
    "owner-profile",
    "machine",
    "environment",
    "harness",
    "harness-catalog",
  ] as const;
  const releases = kinds.map((kind) => client.watchPersonalResource(kind, () => undefined));
  const handedOut = Object.values(host.client.getSnapshot().assignments)[0]!;
  const thread = host.client
    .getSnapshot()
    .threads.find(({ id }) => id === handedOut.parentThreadId)!;
  releases.push(client.observeThread(thread.id));
  await client.dispatch({
    type: "thread.sendMessage",
    threadId: thread.id,
    idempotencyKey: "queued-follow-up",
    content: [{ type: "text", text: "Also check Android" }],
    delivery: "queue",
  });
  try {
    await vi.waitFor(() => {
      const snapshot = client.getSnapshot();
      const view = client.getThreadTranscript(thread.id)!.getSnapshot();
      expect({
        connection: snapshot.connection,
        user: snapshot.user !== null,
        thread: snapshot.threads.some(({ id }) => id === thread.id),
        listed: snapshot.tasks?.entries.some((entry) => entry.thread.id === thread.id),
        active: snapshot.activeTasks.some((entry) => entry.thread.id === thread.id),
        waitingRequests: snapshot.waitingRequests.length > 0,
        attention: (snapshot.attentionSummaries?.length ?? 0) > 0,
        needsYouCount: (snapshot.needsYouCount ?? 0) > 0,
        settings: snapshot.personalSettings !== null,
        identity: snapshot.identityConfig !== null,
        machines: snapshot.machines.length > 0,
        environments: snapshot.environments.length > 0,
        harnesses: snapshot.harnesses.length > 0,
        subagents: view.entries.some((entry) => entry.kind === "node"),
        assignment: snapshot.assignments[handedOut.id] !== undefined,
        requests: view.requests.length > 0,
        runs: view.runQueue.some((run) => run.threadId === thread.id),
        queued: view.inputQueue?.items.some((item) =>
          JSON.stringify(item).includes("Also check Android"),
        ),
      }).toEqual({
        connection: "connected",
        user: true,
        thread: true,
        listed: true,
        active: true,
        waitingRequests: true,
        attention: true,
        needsYouCount: true,
        settings: true,
        identity: true,
        machines: true,
        environments: true,
        harnesses: true,
        subagents: true,
        assignment: true,
        requests: true,
        runs: true,
        queued: true,
      });
    });
    const view = () => client.getThreadTranscript(thread.id)!.getSnapshot();
    const run = view().runQueue.find((entry) => entry.threadId === thread.id)!;
    await client.dispatch({
      type: "run.interrupt",
      threadId: thread.id,
      runId: run.id,
      idempotencyKey: "finish",
    });
    await vi.waitFor(() => {
      expect(view().runQueue.some(({ id }) => id === run.id)).toBe(false);
      expect(client.getSnapshot().activeTasks.some((entry) => entry.thread.id === thread.id)).toBe(
        false,
      );
    });
  } finally {
    for (const release of releases) release();
  }
});

it("reads watched resources beside the socket's attach on a cold start, and once", async () => {
  const host = new MockPersonalHost(new MockHostClient({ latencyMs: 0 }));
  const reads: string[] = [];
  let readsAtAttach: string[] | undefined;
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/resources.detail.get"))
        reads.push(JSON.parse(url.searchParams.get("input")!).kind);
      return host.fetch(input, init);
    },
    webSocketFactory: () => {
      const socket = host.connect();
      const send = socket.send.bind(socket);
      socket.send = (data: string) => {
        if (JSON.parse(data).type === "client.attach") readsAtAttach ??= [...reads];
        send(data);
      };
      return socket;
    },
    capabilities: [],
  });
  open.push({ client, host });
  const kinds = ["environment", "identity", "settings"] as const;
  const releases = kinds.map((kind) => client.watchPersonalResource(kind, () => undefined));
  try {
    await client.load();
    // Main painted these from the same read as the shell; they must not wait for the push.
    expect(readsAtAttach?.sort()).toEqual([...kinds]);
    await vi.waitFor(() => {
      const shown = client.getSnapshot();
      expect(shown.personalSettings).not.toBeNull();
      expect(shown.identityConfig).not.toBeNull();
      expect(shown.environments.length).toBeGreaterThan(0);
    });
    // The Host's revision push matches what was read, so nothing is read twice.
    await client.refresh();
    expect(reads.sort()).toEqual([...kinds]);
  } finally {
    for (const release of releases) release();
  }
});

it("moves only the published app's version, so an open app view rereads", async () => {
  const { client, host } = await connect();
  const published = "app_00000000-0000-4000-8000-000000000001";
  const other = "app_00000000-0000-4000-8000-000000000002";
  const before = client.getSnapshot().appVersions ?? {};
  const [socket] = host.sockets;
  socket!.deliver({ type: "host.apps.changed", appIds: [published] } as never);
  await vi.waitFor(() =>
    expect(client.getSnapshot().appVersions?.[published]).toBe((before[published] ?? 0) + 1),
  );
  expect(client.getSnapshot().appVersions?.[other]).toBeUndefined();
});

it("a warm start from cache claims no resource it does not hold, reads each once beside the attach", async () => {
  const host = new MockPersonalHost(new MockHostClient({ latencyMs: 0 }));
  const storage = memoryCheckpointStorage();
  const kinds = ["environment", "identity", "settings"] as const;
  const start = () => {
    const reads: string[] = [];
    const attaches: Extract<ScopedClientMessage, { type: "client.attach" }>[] = [];
    let readsAtAttach: string[] | undefined;
    const client = new HttpHostClient({
      baseUrl: "http://scoped-host",
      streamCache: createPersonalStreamCache(storage),
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname.endsWith("/resources.detail.get"))
          reads.push(JSON.parse(url.searchParams.get("input")!).kind);
        return host.fetch(input, init);
      },
      webSocketFactory: () => {
        const socket = host.connect();
        const send = socket.send.bind(socket);
        socket.send = (data: string) => {
          const frame = JSON.parse(data) as ScopedClientMessage;
          if (frame.type === "client.attach") {
            attaches.push(frame);
            readsAtAttach ??= [...reads];
          }
          send(data);
        };
        return socket;
      },
      capabilities: [],
    });
    open.push({ client, host });
    const releases = kinds.map((kind) => client.watchPersonalResource(kind, () => undefined));
    return { client, reads, attaches, readsAtAttach: () => readsAtAttach, releases };
  };
  const first = start();
  await first.client.load();
  await vi.waitFor(() => expect(first.client.getSnapshot().personalSettings).not.toBeNull());
  first.client.flushSavedState();
  await vi.waitFor(() =>
    expect([...storage.values.keys()].some((key) => key.includes("shell"))).toBe(true),
  );
  for (const release of first.releases) release();

  const warm = start();
  try {
    await warm.client.load();
    // The saved shell resumes; resources were never saved, so none is claimed or painted from disk.
    expect(warm.attaches[0]?.cursor).toBeDefined();
    expect(warm.attaches[0]?.installed).toEqual({});
    expect(warm.readsAtAttach()?.sort()).toEqual([...kinds]);
    await vi.waitFor(() => {
      const shown = warm.client.getSnapshot();
      expect(shown.personalSettings).toEqual(host.client.getSnapshot().personalSettings);
      expect(shown.identityConfig).not.toBeNull();
      expect(shown.environments.length).toBeGreaterThan(0);
    });
    await warm.client.refresh();
    expect(warm.reads.sort()).toEqual([...kinds]);
  } finally {
    for (const release of warm.releases) release();
  }
});
