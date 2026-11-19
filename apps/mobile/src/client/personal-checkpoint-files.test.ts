import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import { expect, test, vi } from "vitest";
import {
  dropEarlierCheckpointFormats,
  fileCheckpointStorage,
} from "./personal-checkpoint-files.js";

const directory = "/private/personal-stream-v66";
const viewer = { deploymentId: "dep", viewerId: "viewer" };
const other = { deploymentId: "dep", viewerId: "other" };
const guard = { ...viewer, fence: 0 };
/** A saved record as the cache writes it: its scope and the fence it was taken under. */
const record = (owner: typeof viewer, fence: number, words: string) =>
  JSON.stringify({ scope: { ...owner, epoch: "e", scopeKey: "shell", format: 66 }, fence, words });
const files = async (fs: MemoryPrivateFilesystem) => (await fs.listFiles(directory)).toSorted();

test("keeps one file per scope and an interrupted write leaves the previous value", async () => {
  const fs = new MemoryPrivateFilesystem();
  const storage = fileCheckpointStorage(fs, directory);
  await storage.write("shell", record(viewer, 0, "s1"), guard);
  await storage.write("thread:a", record(viewer, 0, "a1"), guard);
  await storage.write("thread:a", record(viewer, 0, "a2"), guard);
  expect((await storage.list()).map(({ key }) => key).toSorted()).toEqual(["shell", "thread:a"]);
  expect(await storage.read("thread:a")).toBe(record(viewer, 0, "a2"));

  vi.spyOn(fs, "writeFileAtomic").mockRejectedValue(new Error("The phone ran out of space."));
  await expect(storage.write("thread:a", record(viewer, 0, "a3"), guard)).rejects.toThrow();
  vi.restoreAllMocks();
  const reopened = fileCheckpointStorage(fs, directory);
  expect(await reopened.read("thread:a")).toBe(record(viewer, 0, "a2"));
  expect((await reopened.list()).map(({ key }) => key).toSorted()).toEqual(["shell", "thread:a"]);
});

test.each([0, 1, 2])(
  "a sign-out interrupted after step %i leaves no private file once the app starts again",
  async (failAt) => {
    const fs = new MemoryPrivateFilesystem();
    const storage = fileCheckpointStorage(fs, directory);
    await storage.write("shell", record(viewer, 0, "shell"), guard);
    await storage.write("thread:a", record(viewer, 0, "a"), guard);
    await storage.write("thread:b", record(viewer, 0, "b"), guard);
    await storage.write("other", record(other, 0, "kept"), { ...other, fence: 0 });
    // Step 0 raises the fence; each later step deletes one file. The app dies at `failAt`.
    let step = 0;
    const write = fs.writeFileAtomic.bind(fs);
    const remove = fs.removeFile.bind(fs);
    const interrupt = <T>(run: () => Promise<T>) => {
      if (step++ === failAt + 1) throw new Error("The app was closed.");
      return run();
    };
    vi.spyOn(fs, "writeFileAtomic").mockImplementation((path, content) =>
      interrupt(() => write(path, content)),
    );
    vi.spyOn(fs, "removeFile").mockImplementation((path) => interrupt(() => remove(path)));
    await expect(storage.clear((key) => key !== "other", viewer)).rejects.toThrow(
      "The app was closed.",
    );
    vi.restoreAllMocks();

    const restarted = fileCheckpointStorage(fs, directory);
    expect((await restarted.list()).map(({ key }) => key)).toEqual(["other"]);
    for (const key of ["shell", "thread:a", "thread:b"])
      expect(await restarted.read(key)).toBeNull();
    // Only the fences and the other viewer's record are left on disk.
    expect(await files(fs)).toHaveLength(2);
    expect(await files(fs)).toContain("fences.json");
    expect(await restarted.write("thread:a", record(viewer, 0, "late"), guard)).toBe(false);
  },
);

test("files nothing lists, journals and records under an older fence are deleted on start", async () => {
  const fs = new MemoryPrivateFilesystem();
  const storage = fileCheckpointStorage(fs, directory);
  await storage.write("thread:a", record(viewer, 0, "a"), guard);
  const [saved] = await files(fs);
  // A write the app never finished, a stray file, and a record that predates the fence.
  fs.put(`${directory}/${saved}.new`, "thread:a\n1\n" + record(viewer, 0, "half"));
  fs.put(`${directory}/stray.json`, "private");
  fs.put(
    `${directory}/fences.json`,
    JSON.stringify({
      all: 0,
      deployments: {},
      viewers: { [JSON.stringify(["dep", "viewer"])]: 1 },
    }),
  );
  const restarted = fileCheckpointStorage(fs, directory);
  expect(await restarted.list()).toEqual([]);
  expect(await files(fs)).toEqual(["fences.json"]);
});

test("earlier formats' saved state is removed on start, whatever its files", async () => {
  const fs = new MemoryPrivateFilesystem();
  fs.put("/private/personal-stream-v64/checkpoints.json", "[]");
  fs.put("/private/personal-stream-v65/index.json", "{}");
  fs.put("/private/personal-stream-v65/0123456789abcdef.json", "thread:a\nold");
  fs.put("/private/personal-stream-v65/0123456789abcdef.json.new", "thread:a\nhalf");
  const current = fileCheckpointStorage(fs, directory);
  await current.write("thread:a", record(viewer, 0, "new"), guard);
  await dropEarlierCheckpointFormats(fs, "/private", 66);
  expect(await fs.listFiles("/private/personal-stream-v64")).toEqual([]);
  expect(await fs.listFiles("/private/personal-stream-v65")).toEqual([]);
  expect(await fileCheckpointStorage(fs, directory).read("thread:a")).toBe(
    record(viewer, 0, "new"),
  );
});
