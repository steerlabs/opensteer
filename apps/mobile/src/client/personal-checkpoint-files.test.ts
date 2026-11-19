import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import { expect, test, vi } from "vitest";
import { fileCheckpointStorage } from "./personal-checkpoint-files.js";

const directory = "/private/personal-stream";

test("keeps one file per scope and an interrupted write leaves the previous value", async () => {
  const files = new MemoryPrivateFilesystem();
  const storage = fileCheckpointStorage(files, directory);
  await storage.write("shell", "s1");
  await storage.write("thread:a", "a1");
  await storage.write("thread:a", "a2");
  expect((await storage.list()).map(({ key }) => key).sort()).toEqual(["shell", "thread:a"]);
  expect(await storage.read("thread:a")).toBe("a2");

  const write = files.writeFileAtomic.bind(files);
  vi.spyOn(files, "writeFileAtomic").mockImplementation(async (path, content) => {
    if (!path.endsWith("index.json")) throw new Error("The phone ran out of space.");
    await write(path, content);
  });
  await expect(storage.write("thread:a", "a3")).rejects.toThrow();
  await expect(storage.write("thread:b", "b1")).rejects.toThrow();
  vi.restoreAllMocks();
  const reopened = fileCheckpointStorage(files, directory);
  expect(await reopened.read("thread:a")).toBe("a2");
  expect(await reopened.read("thread:b")).toBeNull();
  // A key whose file never landed is still listed, so removing its viewer removes it.
  await reopened.remove((await reopened.list()).map(({ key }) => key));
  expect(await reopened.list()).toEqual([]);
});
