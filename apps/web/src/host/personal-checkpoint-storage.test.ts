import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, expect, test, vi } from "vitest";
import { createPersonalStreamCache } from "@opensteer/client/host";
import {
  checkpointDatabaseName,
  checkpointSessionMarker,
  dropOtherCheckpointFormats,
  indexedDbCheckpointStorage,
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
