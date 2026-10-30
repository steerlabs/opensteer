import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import { SavedViewCache } from "./saved-view-cache.js";
import { createId, WorkspaceIdSchema } from "@opensteer/core";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { MockHostClient } from "@opensteer/client/mock";
import {
  type HostClient,
  type HostSnapshot,
  type SavedHostView,
  type SavedViewScope,
  type SavedViewStore,
  createMemorySavedViews,
  HttpHostClient,
  type WebSocketClient,
} from "@opensteer/client/host";
import { afterEach, expect, it, vi } from "vitest";
import { SavedViewPresentation } from "./saved-view-presentation.js";
function presentation(options: { readonly store: SavedViewStore; readonly now?: () => Date }) {
  return new SavedViewPresentation({
    cache: new SavedViewCache({
      store: options.store,
      files: new MemoryPrivateFilesystem(),
      directory: "/private/denials",
    }),
    ...(options.now ? { now: options.now } : {}),
  });
}
const scope = (): SavedViewScope => ({
  schema: 1,
  epoch: hostApiVersion,
  loginId: globalThis.crypto.randomUUID(),
  hostIdentity: {
    deploymentId: createId("deployment"),
    hostInstanceId: createId("hostInstance"),
    hostKeyFingerprint: `sha256:${"a".repeat(43)}`,
  },
});
const pendingHome = { status: "unknown" } as const;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());
async function fixture() {
  const mock = new MockHostClient({ latencyMs: 0 });
  await mock.load();
  let snapshot: HostSnapshot = {
    ...mock.getSnapshot(),
    savedViewReadiness: { tasksReady: false, home: pendingHome, workspaceRefusal: 0 },
  };
  const listeners = new Set<() => void>();
  const client = new Proxy(mock, {
    get(target, property) {
      if (property === "getSnapshot") return () => snapshot;
      if (property === "subscribe")
        return (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as HostClient;
  const s = scope();
  const saved: SavedHostView = {
    ...s,
    userId: snapshot.user!.id,
    capturedAt: "2026-10-29T00:00:00.000Z",
    home: {
      workspaceId: WorkspaceIdSchema.parse(snapshot.homeWorkspaceId),
      threadId: null,
      messages: [],
    },
    tasks: [],
  };
  const publish = (patch: Partial<HostSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  return {
    mock,
    client,
    s,
    saved,
    publish,
    listeners,
    snapshot: () => snapshot,
    dispose: () => mock.dispose(),
  };
}
it("loads in parallel, replaces surfaces independently with fresh-empty and never falls back", async () => {
  const f = await fixture(),
    store = createMemorySavedViews();
  await store.write(f.saved, () => true);
  const controller = presentation({ store });
  controller.select(f.s.hostIdentity.deploymentId, f.s, () => true);
  controller.attach(f.client);
  await vi.waitFor(() => expect(controller.getSnapshot().tasks.source).toBe("saved"));
  f.publish({
    savedViewReadiness: { tasksReady: true, home: pendingHome, workspaceRefusal: 0 },
    tasks: {
      entries: [],
      window: { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 },
    },
  });
  expect(controller.getSnapshot().tasks.source).toBe("live");
  expect(controller.getSnapshot().home.source).toBe("saved");
  f.publish({
    savedViewReadiness: {
      tasksReady: true,
      home: { status: "absent", workspaceId: f.snapshot().homeWorkspaceId! },
      workspaceRefusal: 0,
    },
  });
  expect(controller.getSnapshot().home.source).toBe("live");
  controller.select(f.s.hostIdentity.deploymentId, f.s, () => true);
  controller.attach(f.client);
  expect(controller.getSnapshot().home.source).toBe("live");
  controller.dispose();
  f.dispose();
});
it("discards a late disk read wholesale even when only one fresh surface arrived", async () => {
  const f = await fixture(),
    gate = deferred<SavedHostView | null>();
  const controller = presentation({
    store: {
      load: () => gate.promise,
      write: async () => undefined,
      invalidate: async () => undefined,
    },
  });
  controller.select(f.s.hostIdentity.deploymentId, f.s, () => true);
  controller.attach(f.client);
  f.publish({ savedViewReadiness: { tasksReady: true, home: pendingHome, workspaceRefusal: 0 } });
  gate.resolve(f.saved);
  await gate.promise;
  await Promise.resolve();
  expect(controller.getSnapshot().home.source).toBe("pending");
  expect(controller.getSnapshot().tasks.source).toBe("live");
  controller.dispose();
  f.dispose();
});
it.each(["switch", "logout", "refusal", "dispose", "different-user"] as const)(
  "fences delayed reads across %s",
  async (reason) => {
    const f = await fixture(),
      read = deferred<SavedHostView | null>(),
      started = deferred<void>();
    let current = true;
    const store: SavedViewStore = {
      load: async () => {
        started.resolve();
        return read.promise;
      },
      write: async () => undefined,
      invalidate: async () => undefined,
    };
    const controller = presentation({ store });
    controller.select(f.s.hostIdentity.deploymentId, f.s, () => current);
    controller.attach(f.client);
    await started.promise;
    const frames: string[] = [];
    controller.subscribe(() => frames.push(controller.getSnapshot().home.source));
    if (reason === "switch") {
      controller.select(createId("deployment"), null, () => true);
      controller.select(f.s.hostIdentity.deploymentId, null, () => true);
    }
    if (reason === "logout") {
      current = false;
      controller.block();
    }
    if (reason === "dispose") controller.dispose();
    if (reason === "refusal")
      f.publish({
        savedViewReadiness: { tasksReady: false, home: pendingHome, workspaceRefusal: 1 },
      });
    if (reason === "different-user")
      f.publish({ user: { ...f.snapshot().user!, id: createId("user") } });
    read.resolve(f.saved);
    await read.promise;
    await new Promise<void>((done) => setTimeout(done, 0));
    expect(frames).not.toContain("saved");
    expect(controller.getSnapshot().home.source).not.toBe("saved");
    controller.dispose();
    expect(f.listeners.size).toBe(0);
    f.dispose();
  },
);
it("captures ready installed models after debounce, retains the latest tail while browsing history and flushes without rereads", async () => {
  const f = await fixture(),
    store = createMemorySavedViews(),
    write = vi.spyOn(store, "write");
  const latest = vi.spyOn(f.client, "loadLatestTranscript"),
    activate = vi.spyOn(f.client, "activateThread"),
    dispatch = vi.spyOn(f.client, "dispatch");
  const controller = presentation({ store });
  controller.select(f.s.hostIdentity.deploymentId, f.s, () => true);
  controller.attach(f.client);
  const threadId = f.snapshot().homeThreadId!;
  f.publish({
    savedViewReadiness: {
      tasksReady: true,
      home: {
        status: "window",
        workspaceId: f.snapshot().homeWorkspaceId!,
        threadId,
        latest: true,
      },
      workspaceRefusal: 0,
    },
  });
  vi.useFakeTimers();
  await controller.flush();
  const tail = write.mock.calls.at(-1)?.[0].home;
  f.publish({
    transcripts: { ...f.snapshot().transcripts, [threadId]: [] },
    savedViewReadiness: {
      tasksReady: true,
      home: {
        status: "window",
        workspaceId: f.snapshot().homeWorkspaceId!,
        threadId,
        latest: false,
      },
      workspaceRefusal: 0,
    },
  });
  await controller.flush();
  expect(write.mock.calls.at(-1)?.[0].home).toEqual(tail);
  expect(latest).not.toHaveBeenCalled();
  expect(activate).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  controller.dispose();
  f.dispose();
});

it.each(["fresh-empty", "switch", "different-user", "logout", "refusal", "dispose"] as const)(
  "fences an in-flight write across %s",
  async (reason) => {
    const f = await fixture(),
      started = deferred<void>(),
      release = deferred<void>(),
      committed: SavedHostView[] = [];
    const controller = presentation({
      store: {
        load: async () => null,
        invalidate: async () => undefined,
        write: async (view, lease) => {
          started.resolve();
          await release.promise;
          if (lease()) committed.push(view);
        },
      },
    });
    controller.select(f.s.hostIdentity.deploymentId, f.s, () => true);
    controller.attach(f.client);
    f.publish({ savedViewReadiness: { tasksReady: true, home: pendingHome, workspaceRefusal: 0 } });
    const writing = controller.flush();
    await started.promise;
    if (reason === "fresh-empty")
      f.publish({
        tasks: {
          entries: [],
          window: { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 },
        },
        activeTasks: [],
      });
    if (reason === "switch") {
      controller.select(createId("deployment"), null, () => true);
      controller.select(f.s.hostIdentity.deploymentId, f.s, () => true);
      controller.attach(f.client);
    }
    if (reason === "different-user")
      f.publish({ user: { ...f.snapshot().user!, id: createId("user") } });
    if (reason === "logout") controller.block();
    if (reason === "refusal")
      f.publish({
        savedViewReadiness: { tasksReady: false, home: pendingHome, workspaceRefusal: 1 },
      });
    if (reason === "dispose") controller.dispose();
    release.resolve();
    await writing;
    expect(committed).toEqual([]);
    expect(controller.getSnapshot().home.source).not.toBe("saved");
    controller.dispose();
    f.dispose();
  },
);
it("debounces projection changes for two seconds and distinguishes offline/unavailable labels without claiming health", async () => {
  const f = await fixture(),
    store = createMemorySavedViews();
  await store.write(f.saved, () => true);
  const write = vi.spyOn(store, "write"),
    controller = presentation({ store });
  controller.select(f.s.hostIdentity.deploymentId, f.s, () => true);
  controller.attach(f.client);
  await vi.waitFor(() => expect(controller.getSnapshot().tasks.source).toBe("saved"));
  controller.connection("offline", false);
  expect(controller.getSnapshot().tasks).toMatchObject({ label: "Offline · Saved view" });
  controller.connection("online", true);
  expect(controller.getSnapshot().home).toMatchObject({ label: "Unavailable · Saved view" });
  controller.connection("online", false);
  expect(controller.getSnapshot().home).toMatchObject({ label: "Updating…" });
  vi.useFakeTimers();
  f.publish({ savedViewReadiness: { tasksReady: true, home: pendingHome, workspaceRefusal: 0 } });
  await vi.advanceTimersByTimeAsync(1_999);
  expect(write).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(write).toHaveBeenCalledTimes(1);
  controller.dispose();
  expect(vi.getTimerCount()).toBe(0);
  f.dispose();
});
it("keeps failed key deletion blocked across switch-away/back until foreground cleanup succeeds", async () => {
  const f = await fixture(),
    memory = createMemorySavedViews();
  await memory.write(f.saved, () => true);
  let fail = true;
  const store = {
    ...memory,
    invalidate: async (id: string) => {
      if (fail) throw new Error("locked");
      await memory.invalidate(id);
    },
  };
  const controller = presentation({ store });
  controller.select(f.s.hostIdentity.deploymentId, f.s, () => true);
  controller.attach(f.client);
  await vi.waitFor(() => expect(controller.getSnapshot().home.source).toBe("saved"));
  f.publish({ savedViewReadiness: { tasksReady: false, home: pendingHome, workspaceRefusal: 1 } });
  await vi.waitFor(() =>
    expect(controller.getSnapshot().failure).toMatch(/cleanup could not be completed/u),
  );
  controller.select(createId("deployment"), null, () => true);
  controller.select(f.s.hostIdentity.deploymentId, f.s, () => true);
  await Promise.resolve();
  await Promise.resolve();
  expect(controller.getSnapshot().home.source).toBe("blocked");
  fail = false;
  await controller.retryInvalidation();
  expect(await memory.load(f.s, () => true)).toBeNull();
  controller.dispose();
  f.dispose();
});

it("reconciles deferred successful deletion across same-Deployment reselection and captures again", async () => {
  const f = await fixture(),
    started = deferred<void>(),
    release = deferred<void>();
  const memory = createMemorySavedViews();
  await memory.write(f.saved, () => true);
  const write = vi.spyOn(memory, "write");
  const controller = presentation({
    store: {
      ...memory,
      invalidate: async (id) => {
        started.resolve();
        await release.promise;
        await memory.invalidate(id);
      },
    },
  });
  controller.select(f.s.hostIdentity.deploymentId, f.s, () => true);
  controller.attach(f.client);
  await vi.waitFor(() => expect(controller.getSnapshot().home.source).toBe("saved"));
  f.publish({ savedViewReadiness: { tasksReady: false, home: pendingHome, workspaceRefusal: 1 } });
  await started.promise;
  controller.select(f.s.hostIdentity.deploymentId, f.s, () => true);
  controller.attach(f.client);
  expect(controller.getSnapshot().home.source).toBe("blocked");
  release.resolve();
  await vi.waitFor(() => expect(controller.getSnapshot().failure).toBeNull());
  expect(controller.getSnapshot().home.source).not.toBe("saved");
  f.publish({ savedViewReadiness: { tasksReady: true, home: pendingHome, workspaceRefusal: 1 } });
  await vi.waitFor(async () => {
    await controller.flush();
    expect(write).toHaveBeenCalledTimes(1);
  });
  expect(await memory.load(f.s, () => true)).toMatchObject({ userId: f.saved.userId });
  controller.dispose();
  f.dispose();
});

it.each([true, false])(
  "preserves the captured Home tail after an unshown snapshot and failed replacement history (omitted=%s)",
  async (messagesOmitted) => {
    const mock = new MockHostClient({ latencyMs: 0, places: "absent" });
    await mock.load();
    const bootstrap = await mock.rpc["bootstrap.get"]({});
    if (!bootstrap.ok) throw new Error(bootstrap.error.message);
    const boot = bootstrap.data;
    const result = await mock.rpc["thread.events.list"]({
      threadId: mock.getSnapshot().homeThreadId!,
    });
    if (!result.ok) throw new Error(result.error.message);
    const initial = result.data;
    const text = "Keep this useful tail";
    const now = new Date().toISOString();
    const message = {
      id: createId("message"),
      threadId: initial.threadId,
      runId: null,
      kind: "input",
      author: {
        kind: "human",
        userId: boot.user.id,
        principalId: `user:${boot.user.id}`,
        displayName: boot.user.displayName,
      },
      sequence: "7",
      createdAt: now,
      content: [{ type: "text", text }],
    };
    const page = {
      ...initial,
      readState: { ...initial.readState, asOfSequence: "7" },
      events: [
        {
          eventId: createId("event"),
          sequence: "7",
          createdAt: now,
          workspaceId: initial.thread.workspaceId,
          environmentId: initial.thread.environmentId,
          threadId: initial.threadId,
          runId: null,
          type: "message.created",
          data: {
            message,
            input: {
              assignmentId: null,
              cancelReason: null,
              causalChainId: createId("causalChain"),
              createdAt: now,
              deliveredAt: now,
              messageId: message.id,
              policy: "queue",
              replyTarget: null,
              runId: null,
              state: "delivered",
              threadId: initial.threadId,
              updatedAt: now,
            },
          },
        },
      ],
    };
    const history: ReturnType<typeof Promise.withResolvers<Response>>[] = [];
    const events = new EventTarget();
    const socket: WebSocketClient = {
      binaryType: "blob",
      readyState: 1,
      addEventListener: events.addEventListener.bind(events) as WebSocketClient["addEventListener"],
      close: () => {},
      send: () => {},
    };
    const host = new HttpHostClient({
      baseUrl: "https://host.test",
      prefetchHome: true,
      refreshIntervalMs: 0,
      webSocketFactory: () => socket,
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const name = url.pathname.slice("/v1/rpc/".length);
        if (name === "thread.events.list") {
          const read = Promise.withResolvers<Response>();
          history.push(read);
          return read.promise;
        }
        const rpc = Reflect.get(mock.rpc, name) as (payload: unknown) => Promise<unknown>;
        return Response.json(await rpc(JSON.parse(String(init?.body ?? "{}"))));
      },
    });
    const s = scope();
    s.hostIdentity.deploymentId = boot.deploymentId;
    const store = createMemorySavedViews();
    const write = vi.spyOn(store, "write");
    const controller = presentation({ store });
    try {
      controller.select(s.hostIdentity.deploymentId, s, () => true);
      controller.attach(host);
      await host.load();
      history[0]!.resolve(Response.json({ ok: true, data: page }));
      await vi.waitFor(() =>
        expect(host.getSnapshot().savedViewReadiness?.home.status).toBe("window"),
      );
      await controller.flush();
      const useful = [{ voice: "mine", text }];
      expect((await store.load(s, () => true))?.home?.messages).toEqual(useful);
      write.mockClear();
      events.dispatchEvent(new Event("open"));
      events.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "host.snapshot",
            snapshot: {
              workspace: boot.homeWorkspace,
              sequence: "7",
              threads: [initial.thread],
              threadWindow: {
                byteCount: 2,
                hasMore: false,
                itemCount: 1,
                nextBefore: null,
                totalItems: 1,
              },
              messages: [],
              messageWindows: [],
              ...(messagesOmitted ? { messagesOmitted: true } : {}),
              pendingRequests: [],
              pendingRequestWindow: {
                byteCount: 2,
                hasMore: false,
                itemCount: 0,
                nextBefore: null,
                totalItems: 0,
              },
              runQueue: [],
              readStates: [],
              notificationPreferences: [],
              serializedBytes: 256,
            },
          }),
        }),
      );
      await controller.flush();
      expect((await store.load(s, () => true))?.home?.messages).toEqual(useful);
      host.activateThread(initial.threadId);
      await vi.waitFor(() => expect(history).toHaveLength(2));
      await controller.flush();
      expect((await store.load(s, () => true))?.home?.messages).toEqual(useful);
      history[1]!.resolve(
        Response.json(
          { ok: false, error: { code: "internal", message: "Lost history", retryable: true } },
          { status: 500 },
        ),
      );
      await vi.waitFor(() =>
        expect(host.getSnapshot().threadLookups[initial.threadId]).toBe("failed"),
      );
      await controller.flush();
      expect((await store.load(s, () => true))?.home?.messages).toEqual(useful);
      expect(write.mock.calls.length).toBeGreaterThan(0);
      for (const [view] of write.mock.calls) expect(view.home?.messages).toEqual(useful);
    } finally {
      controller.dispose();
      host.dispose();
      mock.dispose();
      for (const read of history) read.resolve(Response.json({ ok: true, data: page }));
    }
  },
);
