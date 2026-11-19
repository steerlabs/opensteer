import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import { expect, test, vi } from "vitest";
import {
  dropEarlierCheckpointFormats,
  fileCheckpointStorage,
} from "./personal-checkpoint-files.js";

const directory = "/private/personal-stream";
const guard = { deploymentId: "dep", viewerId: "viewer", fence: 0 };

test("keeps one file per scope and an interrupted write leaves the previous value", async () => {
  const files = new MemoryPrivateFilesystem();
  const storage = fileCheckpointStorage(files, directory);
  await storage.write("shell", "s1", guard);
  await storage.write("thread:a", "a1", guard);
  await storage.write("thread:a", "a2", guard);
  expect((await storage.list()).map(({ key }) => key).sort()).toEqual(["shell", "thread:a"]);
  expect(await storage.read("thread:a")).toBe("a2");

  const write = files.writeFileAtomic.bind(files);
  vi.spyOn(files, "writeFileAtomic").mockImplementation(async (path, content) => {
    if (!path.endsWith("index.json")) throw new Error("The phone ran out of space.");
    await write(path, content);
  });
  await expect(storage.write("thread:a", "a3", guard)).rejects.toThrow();
  await expect(storage.write("thread:b", "b1", guard)).rejects.toThrow();
  vi.restoreAllMocks();
  const reopened = fileCheckpointStorage(files, directory);
  expect(await reopened.read("thread:a")).toBe("a2");
  expect(await reopened.read("thread:b")).toBeNull();
  // A key whose file never landed is still listed, so removing its viewer removes it.
  await reopened.remove((await reopened.list()).map(({ key }) => key));
  expect(await reopened.list()).toEqual([]);
});

test("a clear raises the fence a stale write is refused by, also after reopening", async () => {
  const files = new MemoryPrivateFilesystem();
  const storage = fileCheckpointStorage(files, directory);
  expect(await storage.write("thread:a", "a1", guard)).toBe(true);
  await storage.clear((key) => key === "thread:a", { deploymentId: "dep", viewerId: "viewer" });
  expect(await storage.write("thread:a", "a2", guard)).toBe(false);
  const reopened = fileCheckpointStorage(files, directory);
  expect(await reopened.read("thread:a")).toBeNull();
  expect(await reopened.write("thread:a", "a3", guard)).toBe(false);
  expect(await reopened.write("thread:a", "a4", { ...guard, fence: 1 })).toBe(true);
});

test("earlier formats' saved state is removed on start", async () => {
  const files = new MemoryPrivateFilesystem();
  await files.writeFileAtomic("/private/personal-stream-v64/checkpoints.json", "[]");
  const v65 = fileCheckpointStorage(files, "/private/personal-stream-v65");
  await v65.write("thread:a", "old", guard);
  // Format 65's index listed its entries at the top level.
  await files.writeFileAtomic(
    "/private/personal-stream-v65/index.json",
    JSON.stringify({ "thread:a": { savedAt: 1, bytes: 3 } }),
  );
  const leftover = (await files.directoryEmpty("/private/personal-stream-v65")) === false;
  const current = fileCheckpointStorage(files, "/private/personal-stream-v66");
  await current.write("thread:a", "new", guard);
  await dropEarlierCheckpointFormats(files, "/private", 66);
  expect(await files.fileExists("/private/personal-stream-v64/checkpoints.json")).toBe(false);
  expect(leftover).toBe(true);
  expect(await files.fileExists("/private/personal-stream-v65/index.json")).toBe(false);
  expect(await files.directoryEmpty("/private/personal-stream-v65")).toBe(true);
  expect(
    await fileCheckpointStorage(files, "/private/personal-stream-v65").read("thread:a"),
  ).toBeNull();
  expect(await fileCheckpointStorage(files, "/private/personal-stream-v66").read("thread:a")).toBe(
    "new",
  );
});
