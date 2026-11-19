import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, expect, test, vi } from "vitest";
import { createPersonalStreamCache } from "@opensteer/client/host";
import {
  checkpointDatabaseName,
  dropOtherCheckpointFormats,
  indexedDbCheckpointStorage,
} from "./personal-checkpoint-storage.js";

const guard = { deploymentId: "dep", viewerId: "viewer", fence: 0 };

afterEach(() => vi.unstubAllGlobals());

test("windows sharing the database write their own scopes without rewriting each other's", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const first = indexedDbCheckpointStorage("checkpoints");
  const second = indexedDbCheckpointStorage("checkpoints");
  await Promise.all([
    first.write("shell", "a1", guard),
    second.write("thread:b", "b1", guard),
    first.write("thread:a", "a2", guard),
    second.write("thread:a", "b2", guard),
  ]);
  expect((await first.list()).map(({ key }) => key).sort()).toEqual([
    "shell",
    "thread:a",
    "thread:b",
  ]);
  expect(await second.read("shell")).toBe("a1");
  expect(await first.read("thread:b")).toBe("b1");
  expect(["a2", "b2"]).toContain(await first.read("thread:a"));
  await second.remove(["shell", "thread:a"]);
  expect(await first.list()).toEqual([expect.objectContaining({ key: "thread:b", bytes: 2 })]);
});

test("an aborted write leaves the previous value and index", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const storage = indexedDbCheckpointStorage("checkpoints");
  await storage.write("thread:a", "first", guard);
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore["put"]>
  ) {
    const request = put.apply(this, args);
    if (this.name === "index") this.transaction.abort();
    return request;
  });
  await expect(storage.write("thread:a", "second", guard)).rejects.toBeDefined();
  vi.restoreAllMocks();
  expect(await storage.read("thread:a")).toBe("first");
  expect(await storage.list()).toEqual([expect.objectContaining({ key: "thread:a", bytes: 5 })]);
});

test("a clear in one window refuses another window's write taken before it", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const first = indexedDbCheckpointStorage("checkpoints");
  const second = indexedDbCheckpointStorage("checkpoints");
  expect(await second.write("thread:a", "a1", guard)).toBe(true);
  // Both land together: the clear's transaction and the late write never interleave.
  await Promise.all([
    first.clear((key) => key === "thread:a", { deploymentId: "dep", viewerId: "viewer" }),
    second.write("thread:a", "a2", guard),
  ]);
  // Whichever transaction ran first, nothing written under the old fence survives the clear.
  const held = await indexedDbCheckpointStorage("checkpoints").read("thread:a");
  expect(held === null || held === "a2").toBe(true);
  expect(await second.write("thread:a", "a3", guard)).toBe(false);
  expect(await first.read("thread:a")).toBeNull();
  expect(await second.write("thread:a", "a4", { ...guard, fence: 1 })).toBe(true);
});

test("a fresh renderer does not load what a cleared viewer saved through another", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const name = checkpointDatabaseName(66, "http://host");
  const first = createPersonalStreamCache(indexedDbCheckpointStorage(name));
  const second = createPersonalStreamCache(indexedDbCheckpointStorage(name));
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
  const fresh = createPersonalStreamCache(indexedDbCheckpointStorage(name));
  expect(await fresh.latestShell("dep")).toBeNull();
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
    await indexedDbCheckpointStorage(name).write("shell", "x", guard);
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
    await indexedDbCheckpointStorage(registered).write("shell", "x", guard);
    await indexedDbCheckpointStorage(checkpointDatabaseName(66, "http://a")).write(
      "shell",
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
