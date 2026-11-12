import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, it, vi } from "vitest";
import type { DesktopPrivateFilesystem } from "./desktop-private-files.js";
import { resetFileWrites } from "./reset-file-writes.js";

it("drains active catalog writes and rejects stale catalog/auth mutations without blocking unrelated files", async () => {
  let release!: () => void;
  const writing = withTimeout(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
    1_000,
    { timeoutError: () => new Error("The active fixture write never finished.") },
  );
  const writeFileAtomic = vi.fn(async () => writing);
  const removeFile = vi.fn(async () => true);
  const native = {
    root: "/fixture",
    writeFileAtomic,
    removeFile,
    readFile: vi.fn(),
    fileExists: vi.fn(),
    ensureDirectory: vi.fn(),
    ensureDirectorySync: vi.fn(),
    directoryEmpty: vi.fn(),
    writeFileExclusive: vi.fn(),
  } as unknown as DesktopPrivateFilesystem;
  const gate = resetFileWrites(native, ["/fixture/catalog", "/fixture/auth"]);
  const pending = gate.files.writeFileAtomic("/fixture/catalog", "old");
  let quiet = false;
  const stopped = gate.quiesce().then(() => {
    quiet = true;
  });
  await expect(gate.files.writeFileAtomic("/fixture/catalog", "stale")).rejects.toThrow(
    "reset is in progress",
  );
  await expect(gate.files.removeFile("/fixture/auth")).rejects.toThrow("reset is in progress");
  expect(quiet).toBe(false);
  release();
  await Promise.all([pending, stopped]);
  expect(quiet).toBe(true);
  await gate.files.removeFile("/fixture/unrelated");
  expect(removeFile).toHaveBeenCalledExactlyOnceWith("/fixture/unrelated", undefined);
  expect(writeFileAtomic).toHaveBeenCalledOnce();
});
