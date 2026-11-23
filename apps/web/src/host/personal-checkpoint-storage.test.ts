import { createId } from "@opensteer/core";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, expect, test, vi } from "vitest";
import { createPersonalStreamCache, type HostSnapshot } from "@opensteer/client/host";
import {
  checkpointDatabaseName,
  checkpointSessionMarker,
  dropOtherCheckpointFormats,
  checkpointSessionMaxAgeMs,
  indexedDbCheckpointStorage,
  keepCheckpointSession,
} from "./personal-checkpoint-storage.js";

const guard = { deploymentId: "dep", viewerId: "viewer", fence: 0 };
/** A key as the cache writes it: format, Deployment, viewer, epoch, scope, thread. */
const key = (scope: string) => JSON.stringify([66, "dep", "viewer", "e", scope, null]);
/** The session this origin holds for the Deployment. */
const signedIn = () => "session-1";

afterEach(() => vi.unstubAllGlobals());

test("windows sharing the database write their own scopes without rewriting each other's", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const first = indexedDbCheckpointStorage("checkpoints", signedIn);
  const second = indexedDbCheckpointStorage("checkpoints", signedIn);
  await Promise.all([
    first.write(key("shell"), "a1", guard),
    second.write(key("thread:b"), "b1", guard),
    first.write(key("thread:a"), "a2", guard),
    second.write(key("thread:a"), "b2", guard),
  ]);
  expect((await first.list()).map(({ key }) => key).toSorted()).toEqual(
    [key("shell"), key("thread:a"), key("thread:b")].toSorted(),
  );
  expect(await second.read(key("shell"))).toBe("a1");
  expect(await first.read(key("thread:b"))).toBe("b1");
  expect(["a2", "b2"]).toContain(await first.read(key("thread:a")));
  await second.remove([key("shell"), key("thread:a")]);
  expect(await first.list()).toEqual([expect.objectContaining({ key: key("thread:b"), bytes: 2 })]);
});

test("an aborted write leaves the previous value and index", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const storage = indexedDbCheckpointStorage("checkpoints", signedIn);
  await storage.write(key("thread:a"), "first", guard);
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore["put"]>
  ) {
    const request = put.apply(this, args);
    if (this.name === "index") this.transaction.abort();
    return request;
  });
  await expect(storage.write(key("thread:a"), "second", guard)).rejects.toBeDefined();
  vi.restoreAllMocks();
  expect(await storage.read(key("thread:a"))).toBe("first");
  expect(await storage.list()).toEqual([
    expect.objectContaining({ key: key("thread:a"), bytes: 5 }),
  ]);
});

test("a clear in one window refuses another window's write taken before it", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const first = indexedDbCheckpointStorage("checkpoints", signedIn);
  const second = indexedDbCheckpointStorage("checkpoints", signedIn);
  expect(await second.write(key("thread:a"), "a1", guard)).toBe(true);
  await Promise.all([
    first.clear((name) => name === key("thread:a"), { deploymentId: "dep", viewerId: "viewer" }),
    second.write(key("thread:a"), "a2", guard),
  ]);
  // Whichever transaction ran first, nothing written under the old fence survives the clear.
  expect(
    await indexedDbCheckpointStorage("checkpoints", signedIn).read(key("thread:a")),
  ).toBeNull();
  expect(await second.write(key("thread:a"), "a3", guard)).toBe(false);
  expect(await second.write(key("thread:a"), "a4", { ...guard, fence: 1 })).toBe(true);
});

test("a fresh renderer does not load what a cleared viewer saved through another", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const name = checkpointDatabaseName(66, "http://host");
  const first = createPersonalStreamCache(indexedDbCheckpointStorage(name, signedIn));
  const second = createPersonalStreamCache(indexedDbCheckpointStorage(name, signedIn));
  const viewer = { deploymentId: "dep", viewerId: "viewer" };
  const fence = await second.fence(viewer);
  await first.removeViewer(viewer);
  const checkpoint = {
    scope: { ...viewer, epoch: "e", scopeKey: "shell", format: 66 },
    cursor: { ...viewer, epoch: "e", scopeKey: "shell", afterSequence: "1" },
    kind: "shell",
    state: {},
  } as never;
  await second.commit(checkpoint, () => true, fence);
  const fresh = createPersonalStreamCache(indexedDbCheckpointStorage(name, signedIn));
  expect(await fresh.latestShell("dep")).toBeNull();
});

test("a sign-out whose IndexedDB clear fails leaves nothing readable, and the next start deletes it", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const stored = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (name: string) => stored.get(name) ?? null,
      setItem: (name: string, value: string) => void stored.set(name, value),
      removeItem: (name: string) => void stored.delete(name),
    },
  });
  const marker = checkpointSessionMarker("http://host");
  marker.held("dep", "session-1");
  const storage = indexedDbCheckpointStorage("checkpoints", marker.current);
  await storage.write(key("shell"), "private", guard);
  // Sign-out: the session ends, then the clear's transaction fails.
  marker.ended();
  vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (this: IDBObjectStore) {
    this.transaction.abort();
    return {} as IDBRequest<undefined>;
  });
  await expect(
    storage.clear(() => true, { deploymentId: "dep", viewerId: "viewer" }),
  ).rejects.toBeDefined();
  vi.restoreAllMocks();
  expect(await storage.read(key("shell"))).toBeNull();
  // The next person signs in here: the first person's entry is neither read nor kept.
  marker.held("dep", "session-2");
  const next = indexedDbCheckpointStorage("checkpoints", marker.current);
  expect(await next.read(key("shell"))).toBeNull();
  expect(await next.list()).toEqual([]);
  const raw = await new Promise<number>((resolve) => {
    const request = indexedDB.open("checkpoints", 1);
    request.onsuccess = () => {
      const count = request.result.transaction("checkpoints").objectStore("checkpoints").count();
      count.onsuccess = () => {
        request.result.close();
        resolve(count.result);
      };
    };
  });
  expect(raw).toBe(0);
});

test("every other format's database is deleted, for every origin", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  for (const name of [
    checkpointDatabaseName(64, "http://a"),
    checkpointDatabaseName(65, "http://b"),
    checkpointDatabaseName(66, "http://a"),
    checkpointDatabaseName(66, "http://b"),
    "opensteer-message-outbox",
  ])
    await indexedDbCheckpointStorage(name, signedIn).write(key("shell"), "x", guard);
  await dropOtherCheckpointFormats(66, "http://a");
  await vi.waitFor(async () =>
    expect((await indexedDB.databases()).map(({ name }) => name).sort()).toEqual([
      "opensteer-message-outbox",
      checkpointDatabaseName(66, "http://a"),
      checkpointDatabaseName(66, "http://b"),
    ]),
  );
});

test.each([
  ["absent", undefined],
  ["failing", () => Promise.reject(new Error("Not allowed."))],
])(
  "without a working database listing (%s), older formats are still deleted",
  async (_case, list) => {
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    const stored = new Map<string, string>();
    const localStorage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    };
    vi.stubGlobal("window", { localStorage });
    // One opened by an earlier build that did not register it, one this origin registered.
    const unregistered = checkpointDatabaseName(65, "http://a");
    await new Promise<void>((resolve) => {
      const request = factory.open(unregistered, 1);
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
    });
    const registered = checkpointDatabaseName(65, "http://b");
    await indexedDbCheckpointStorage(registered, signedIn).write(key("shell"), "x", guard);
    await indexedDbCheckpointStorage(checkpointDatabaseName(66, "http://a"), signedIn).write(
      key("shell"),
      "x",
      guard,
    );
    const real = factory.databases.bind(factory);
    Object.defineProperty(factory, "databases", { configurable: true, value: list });
    await dropOtherCheckpointFormats(66, "http://a");
    expect((await real()).map(({ name }) => name).toSorted()).toEqual([
      checkpointDatabaseName(66, "http://a"),
    ]);
    expect(localStorage.getItem("opensteer.personal-stream.databases")).toBe(
      JSON.stringify([checkpointDatabaseName(66, "http://a")]),
    );
  },
);

test("a late write from a window of an ended session never lands under the next one", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  let current: string | null = "session-1";
  const storage = indexedDbCheckpointStorage("checkpoints", () => current);
  // Another person signed in here before the first person's window flushed.
  current = "session-2";
  expect(await storage.write(key("shell"), "theirs", { ...guard, session: "session-1" })).toBe(
    false,
  );
  expect(await storage.read(key("shell"))).toBeNull();
  expect(await storage.write(key("shell"), "mine", { ...guard, session: "session-2" })).toBe(true);
});

/** A window whose localStorage is this map, as every window of one origin shares it. */
function sharedLocalStorage() {
  const stored = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (name: string) => stored.get(name) ?? null,
      setItem: (name: string, value: string) => void stored.set(name, value),
      removeItem: (name: string) => void stored.delete(name),
    },
  });
  return stored;
}
/** What the database holds on disk, read beside the storage: values and index entries. */
async function onDisk(name = "checkpoints") {
  return new Promise<{ values: number; index: number }>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("checkpoints");
      request.result.createObjectStore("index");
      request.result.createObjectStore("fences");
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const transaction = request.result.transaction(["checkpoints", "index"]);
      const values = transaction.objectStore("checkpoints").count();
      const index = transaction.objectStore("index").count();
      transaction.oncomplete = () => {
        request.result.close();
        resolve({ values: values.result, index: index.result });
      };
    };
  });
}
type Snapshot = Pick<HostSnapshot, "session" | "connection" | "deploymentId" | "sessionId">;
const confirmedAt = Date.parse("2026-11-19T12:00:00Z");

test("a marker past the session's longest life, or dated after now, loads nothing and sweeps", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  sharedLocalStorage();
  let now = confirmedAt;
  const marker = checkpointSessionMarker("http://host", () => now);
  marker.held("dep", "session-1");
  const storage = indexedDbCheckpointStorage("checkpoints", marker.current, marker.holds);
  expect(await storage.write(key("shell"), "private", guard)).toBe(true);
  expect(await storage.read(key("shell"))).toBe("private");
  // The device was offline while the session expired; the Host never said so.
  now = confirmedAt + checkpointSessionMaxAgeMs;
  expect(marker.current("dep")).toBeNull();
  expect(await storage.read(key("shell"))).toBeNull();
  expect(await storage.list()).toEqual([]);
  expect(await storage.write(key("thread:a"), "late", guard)).toBe(false);
  await storage.sweep();
  expect(await onDisk()).toEqual({ values: 0, index: 0 });
  // A clock set back makes a marker's age unknown: no session either.
  now = confirmedAt - 1;
  expect(marker.current("dep")).toBeNull();
});

test("the session ending by a 401 on any request removes the marker and sweeps at once", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  sharedLocalStorage();
  let now = confirmedAt;
  const marker = checkpointSessionMarker("http://host", () => now);
  const storage = indexedDbCheckpointStorage("checkpoints", marker.current, marker.holds);
  let snapshot: Snapshot = { session: "checking", connection: "connecting", deploymentId: null };
  const listeners = new Set<() => void>();
  const emit = (next: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };
  keepCheckpointSession(
    {
      getSnapshot: () => snapshot,
      subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    },
    marker,
    storage,
    () => now,
  );
  const sessionId = createId("authSession");
  // Only a connection the Host confirmed records the session.
  emit({
    session: "authenticated",
    connection: "offline",
    deploymentId: "dep",
    sessionId,
  });
  expect(marker.current("dep")).toBeNull();
  emit({ connection: "connected" });
  expect(marker.current("dep")).toBe(sessionId);
  // Each later confirmation renews it, so a session in use never ages out.
  now = confirmedAt + checkpointSessionMaxAgeMs - 1_000;
  emit({ connection: "connected" });
  now = confirmedAt + checkpointSessionMaxAgeMs + 1_000;
  expect(marker.current("dep")).toBe(sessionId);
  expect(await storage.write(key("shell"), "private", guard)).toBe(true);
  // The client's answer to a 401 on any request (and to every other end) is this state.
  emit({ session: "authentication-required" });
  expect(marker.current("dep")).toBeNull();
  await vi.waitFor(async () => expect(await onDisk()).toEqual({ values: 0, index: 0 }));
});

test("a start after the session expired offline deletes the database before anything reads it", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  sharedLocalStorage();
  let now = confirmedAt;
  const marker = checkpointSessionMarker("http://host", () => now);
  marker.held("dep", "session-1");
  const before = indexedDbCheckpointStorage("checkpoints", marker.current, marker.holds);
  expect(await before.write(key("shell"), "private", guard)).toBe(true);
  expect(await onDisk()).toEqual({ values: 1, index: 1 });
  now = confirmedAt + checkpointSessionMaxAgeMs;
  const order: string[] = [];
  const factory = indexedDB;
  const deleteDatabase = factory.deleteDatabase.bind(factory);
  const open = factory.open.bind(factory);
  vi.spyOn(factory, "deleteDatabase").mockImplementation((name) => {
    order.push(`delete ${name}`);
    return deleteDatabase(name);
  });
  vi.spyOn(factory, "open").mockImplementation((name, version) => {
    order.push(`open ${name}`);
    return open(name, version);
  });
  const restarted = indexedDbCheckpointStorage("checkpoints", marker.current, marker.holds);
  expect(await restarted.fences()).toBeDefined();
  expect(order.slice(0, 2)).toEqual(["delete checkpoints", "open checkpoints"]);
  vi.restoreAllMocks();
  expect(await onDisk()).toEqual({ values: 0, index: 0 });
});

test("a write whose session ends before its transaction commits is refused there", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  let asked = 0;
  // The writer is asked once, then the sign-out in another window ends the session before the
  // write's transaction runs (and that sign-out's own clear never lands).
  const storage = indexedDbCheckpointStorage("checkpoints", () =>
    asked++ === 0 ? "session-1" : null,
  );
  await storage.list().catch(() => undefined);
  asked = 0;
  expect(await storage.write(key("shell"), "late", guard)).toBe(false);
  expect(await onDisk()).toEqual({ values: 0, index: 0 });
});
