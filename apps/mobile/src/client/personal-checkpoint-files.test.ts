import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import { expect, test, vi } from "vitest";
import {
  dropEarlierCheckpointFormats,
  fileCheckpointStorage,
} from "./personal-checkpoint-files.js";

const directory = "/private/personal-stream-v66";
const deploymentId = "dep";
const viewer = { deploymentId, viewerId: "viewer" };
const guard = { ...viewer, fence: 0 };
/** A key as the cache writes it: format, Deployment, viewer, epoch, scope, thread. */
const key = (scope: string) => JSON.stringify([66, deploymentId, "viewer", "e", scope, null]);
const record = (words: string) =>
  JSON.stringify({
    scope: { ...viewer, epoch: "e", scopeKey: "shell", format: 66 },
    fence: 0,
    words,
  });
/** The session store's answer: which sign-in holds the Deployment now, if any. */
const signedIn = (label: string | null) => async () => label;
const onDisk = async (fs: MemoryPrivateFilesystem) => (await fs.listFiles(directory)).toSorted();

async function saved(fs: MemoryPrivateFilesystem) {
  const storage = fileCheckpointStorage(fs, directory, signedIn("login-1"));
  for (const scope of ["shell", "thread:a", "thread:b"])
    expect(await storage.write(key(scope), record(scope), guard)).toBe(true);
  return storage;
}

test("keeps one file per scope and an interrupted write leaves the previous value", async () => {
  const fs = new MemoryPrivateFilesystem();
  const storage = await saved(fs);
  await storage.write(key("thread:a"), record("a2"), guard);
  expect(await storage.read(key("thread:a"))).toBe(record("a2"));
  vi.spyOn(fs, "writeFileAtomic").mockRejectedValue(new Error("The phone ran out of space."));
  await expect(storage.write(key("thread:a"), record("a3"), guard)).rejects.toThrow();
  vi.restoreAllMocks();
  const reopened = fileCheckpointStorage(fs, directory, signedIn("login-1"));
  expect(await reopened.read(key("thread:a"))).toBe(record("a2"));
  expect(await reopened.list()).toHaveLength(3);
});

let stuck: string | undefined;
const failures = {
  "the fence write": (path: string, kind: "write" | "remove") =>
    kind === "write" && path.endsWith("fences.json"),
  // One file refuses to go however often it is asked.
  "one deletion": (path: string, kind: "write" | "remove") =>
    kind === "remove" && (stuck ??= path) === path,
  "the fence write and every deletion": (_path: string, _kind: "write" | "remove") => true,
};

test.each(Object.keys(failures) as (keyof typeof failures)[])(
  "a sign-out where %s fails reports it, and nothing private survives a restart",
  async (failing) => {
    const fs = new MemoryPrivateFilesystem();
    await saved(fs);
    const write = fs.writeFileAtomic.bind(fs);
    const remove = fs.removeFile.bind(fs);
    stuck = undefined;
    vi.spyOn(fs, "writeFileAtomic").mockImplementation(async (path, content) => {
      if (failures[failing](path, "write")) throw new Error("No space left.");
      return write(path, content);
    });
    vi.spyOn(fs, "removeFile").mockImplementation(async (path) => {
      if (failures[failing](path, "remove")) throw new Error("Busy.");
      return remove(path);
    });
    // The session store has already let the session go, as sign-out does before clearing.
    const signedOut = fileCheckpointStorage(fs, directory, signedIn(null));
    await expect(signedOut.clear(() => true, viewer)).rejects.toThrow();
    for (const scope of ["shell", "thread:a"]) expect(await signedOut.read(key(scope))).toBeNull();
    vi.restoreAllMocks();

    const restarted = fileCheckpointStorage(fs, directory, signedIn(null));
    expect(await restarted.list()).toEqual([]);
    for (const scope of ["shell", "thread:a", "thread:b"])
      expect(await restarted.read(key(scope))).toBeNull();
    expect((await onDisk(fs)).filter((name) => name !== "fences.json")).toEqual([]);
  },
);

test.each([0, 1, 2])(
  "a sign-out killed after step %i leaves nothing once the app starts signed out",
  async (failAt) => {
    const fs = new MemoryPrivateFilesystem();
    await saved(fs);
    let step = 0;
    const write = fs.writeFileAtomic.bind(fs);
    const remove = fs.removeFile.bind(fs);
    const die = <T>(run: () => Promise<T>) => {
      if (step++ === failAt + 1) throw new Error("The app was closed.");
      return run();
    };
    vi.spyOn(fs, "writeFileAtomic").mockImplementation((path, content) =>
      die(() => write(path, content)),
    );
    vi.spyOn(fs, "removeFile").mockImplementation((path) => die(() => remove(path)));
    await fileCheckpointStorage(fs, directory, signedIn("login-1"))
      .clear(() => true, viewer)
      .catch(() => undefined);
    vi.restoreAllMocks();
    const restarted = fileCheckpointStorage(fs, directory, signedIn(null));
    expect(await restarted.list()).toEqual([]);
    expect((await onDisk(fs)).filter((name) => name !== "fences.json")).toEqual([]);
  },
);

test("signed in again as someone else, the first sign-in's files are neither read nor kept", async () => {
  const fs = new MemoryPrivateFilesystem();
  const storage = await saved(fs);
  // The first person's sign-out never got to clear anything.
  const next = fileCheckpointStorage(fs, directory, signedIn("login-2"));
  expect(await next.read(key("shell"))).toBeNull();
  expect(await next.list()).toEqual([]);
  expect((await onDisk(fs)).filter((name) => name !== "fences.json")).toEqual([]);
  // Nor can the first sign-in's still-open storage read its own files once the session moved on.
  expect(await storage.read(key("shell"))).toBeNull();
  expect(await next.write(key("shell"), record("theirs"), guard)).toBe(true);
  expect(await next.read(key("shell"))).toBe(record("theirs"));
});

test("a load refuses a file whose session ended before any sweep ran", async () => {
  const fs = new MemoryPrivateFilesystem();
  let label: string | null = "login-1";
  const storage = fileCheckpointStorage(fs, directory, async () => label);
  await storage.write(key("shell"), record("shell"), guard);
  label = null;
  expect(await storage.read(key("shell"))).toBeNull();
  expect(await storage.write(key("thread:a"), record("late"), guard)).toBe(false);
});

test("files nothing lists, journals and records under an older fence are deleted on start", async () => {
  const fs = new MemoryPrivateFilesystem();
  await saved(fs);
  const [first] = (await onDisk(fs)).filter((name) => name !== "fences.json");
  fs.put(`${directory}/${first}.new`, "half");
  fs.put(`${directory}/stray.json`, "private");
  fs.put(`${directory}/fences.json`, JSON.stringify({ all: 1, deployments: {}, viewers: {} }));
  const restarted = fileCheckpointStorage(fs, directory, signedIn("login-1"));
  expect(await restarted.list()).toEqual([]);
  expect(await onDisk(fs)).toEqual(["fences.json"]);
});

test("earlier formats' saved state is removed on start, whatever its files", async () => {
  const fs = new MemoryPrivateFilesystem();
  fs.put("/private/personal-stream-v64/checkpoints.json", "[]");
  fs.put("/private/personal-stream-v65/index.json", "{}");
  fs.put("/private/personal-stream-v65/0123456789abcdef.json", "thread:a\nold");
  fs.put("/private/personal-stream-v65/0123456789abcdef.json.new", "thread:a\nhalf");
  await dropEarlierCheckpointFormats(fs, "/private", 66);
  expect(await fs.listFiles("/private/personal-stream-v64")).toEqual([]);
  expect(await fs.listFiles("/private/personal-stream-v65")).toEqual([]);
});
