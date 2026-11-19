import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, expect, test, vi } from "vitest";
import { indexedDbCheckpointStorage } from "./personal-checkpoint-storage.js";

afterEach(() => vi.unstubAllGlobals());

test("windows sharing the database write their own scopes without rewriting each other's", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const first = indexedDbCheckpointStorage("checkpoints");
  const second = indexedDbCheckpointStorage("checkpoints");
  await Promise.all([
    first.write("shell", "a1"),
    second.write("thread:b", "b1"),
    first.write("thread:a", "a2"),
    second.write("thread:a", "b2"),
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
  await storage.write("thread:a", "first");
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore["put"]>
  ) {
    const request = put.apply(this, args);
    if (this.name === "index") this.transaction.abort();
    return request;
  });
  await expect(storage.write("thread:a", "second")).rejects.toBeDefined();
  vi.restoreAllMocks();
  expect(await storage.read("thread:a")).toBe("first");
  expect(await storage.list()).toEqual([expect.objectContaining({ key: "thread:a", bytes: 5 })]);
});
