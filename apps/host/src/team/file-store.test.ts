import { withTimeout } from "@opensteer/shared/withTimeout";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import type { Storage } from "@google-cloud/storage";
import { LocalTeamFileStore, GcsTeamFileStore } from "./file-store.js";

it("keeps local objects create-only and deletes only the matching generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "team-files-"));
  try {
    const staged = join(directory, "staged");
    await writeFile(staged, "abcdef");
    const store = new LocalTeamFileStore(join(directory, "objects"));
    const generation = await store.put("key", staged);
    await expect(store.put("key", staged)).rejects.toMatchObject({ code: "EEXIST" });
    await store.delete("key", "0");
    expect(await store.read("key", { start: 1, end: 3 }).toArray()).toEqual([Buffer.from("bcd")]);
    await store.delete("key", generation);
    const objects = [];
    for await (const object of store.list("key")) objects.push(object);
    expect(objects).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("uses GCS generation preconditions and destroys streaming reads on abort", async () => {
  const stream = new Readable({ read() {} });
  const remove = vi.fn(async () => {});
  const read = vi.fn(() => stream);
  const file = {
    metadata: { generation: "12345678901234567" },
    delete: remove,
    createReadStream: read,
  };
  const upload = vi.fn(async () => [file]);
  const bucket = { upload, file: vi.fn(() => file) };
  const storage = { bucket: () => bucket } as unknown as Storage;
  const store = new GcsTeamFileStore("bucket", "teams/a/", storage);
  expect(await store.put("key", "/staged")).toBe("12345678901234567");
  expect(upload).toHaveBeenCalledWith(
    "/staged",
    expect.objectContaining({
      destination: "teams/a/key",
      preconditionOpts: { ifGenerationMatch: 0 },
    }),
  );
  await store.delete("key", "12345678901234567");
  expect(remove).toHaveBeenCalledWith({ ifGenerationMatch: "12345678901234567" });
  const controller = new AbortController();
  const body = store.read("key", { start: 3, end: 7, signal: controller.signal });
  const closed = new Promise<void>((resolve) => body.once("close", resolve));
  body.on("error", () => {});
  controller.abort();
  await withTimeout(closed, 1000, {
    timeoutError: () => new Error("Aborted storage stream never closed"),
  });
  expect(body.destroyed).toBe(true);
  expect(read).toHaveBeenCalledWith({ start: 3, end: 7, decompress: false });
});
