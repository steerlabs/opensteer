import * as files from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { replacePrivateFileAtomically, serializePrivateFileCommit } from "./atomicPrivateFile.js";
import { withTimeout } from "./withTimeout.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: vi.fn(original.open) };
});

it("checks owner authority after the temporary file write, immediately before publication", async () => {
  const root = await files.mkdtemp(path.join(tmpdir(), "private-publication-"));
  const target = path.join(root, "state.json");
  await files.writeFile(target, "committed", { mode: 0o600 });
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const originalOpen = (
    await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  ).open;
  const opening = vi.spyOn(files, "open").mockImplementation(async (name, flags, mode) => {
    const handle = await originalOpen(name, flags, mode);
    if (typeof name === "string" && name.startsWith(`${target}.tmp-`)) {
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementation(async (data, options) => {
        await write(data, options);
        entered.resolve();
        await released.promise;
      });
    }
    return handle;
  });
  let current = true;
  const publishing = replacePrivateFileAtomically(target, "abandoned", () => {
    if (!current) throw new Error("Owner retired before publication.");
  });
  const refused = expect(publishing).rejects.toThrow("Owner retired before publication.");
  try {
    await withTimeout(entered.promise, 1_000, {
      timeoutError: () => new Error("Temporary write never started."),
    });
    current = false;
    released.resolve();
    await refused;
    expect(await files.readFile(target, "utf8")).toBe("committed");
    expect(await files.readdir(root)).toEqual(["state.json"]);
  } finally {
    released.resolve();
    await publishing.catch(() => undefined);
    opening.mockRestore();
    await files.rm(root, { recursive: true, force: true });
  }
});

it("keeps a replacement publisher behind an already-issued commit until it settles", async () => {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const first = serializePrivateFileCommit("owned-profile-file", async () => {
    entered.resolve();
    await released.promise;
  });
  await withTimeout(entered.promise, 1_000, {
    timeoutError: () => new Error("First commit never started."),
  });
  const replacement = vi.fn(async () => {});
  const second = serializePrivateFileCommit("owned-profile-file", replacement);
  try {
    await Promise.resolve();
    expect(replacement).not.toHaveBeenCalled();
    released.resolve();
    await withTimeout(Promise.all([first, second]), 1_000, {
      timeoutError: () => new Error("Replacement commit never acquired publication ownership."),
    });
    expect(replacement).toHaveBeenCalledOnce();
  } finally {
    released.resolve();
    await Promise.all([first, second]);
  }
});
