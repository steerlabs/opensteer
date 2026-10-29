import type { PrivateFilesystem } from "@opensteer/client/connections";
import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import { describe, expect, it } from "vitest";
import { createSignedOutFile } from "./signed-out-file.js";

describe("createSignedOutFile", () => {
  it("treats a missing, malformed, or unreadable file as empty", async () => {
    const privateFiles = new MemoryPrivateFilesystem();
    const filePath = "/private/signed-out.json";
    const file = createSignedOutFile({ filePath, privateFiles });
    await expect(file.read()).resolves.toEqual([]);

    await privateFiles.writeFileAtomic(filePath, "not-json");
    await expect(file.read()).resolves.toEqual([]);

    const unreadable: PrivateFilesystem = {
      root: privateFiles.root,
      directoryEmpty: (path) => privateFiles.directoryEmpty(path),
      ensureDirectory: (path) => privateFiles.ensureDirectory(path),
      fileExists: (path) => privateFiles.fileExists(path),
      readFile: async () => {
        throw new Error("unreadable");
      },
      removeFile: (path) => privateFiles.removeFile(path),
      writeFileAtomic: (path, content) => privateFiles.writeFileAtomic(path, content),
      writeFileExclusive: (path, content) => privateFiles.writeFileExclusive(path, content),
    };
    await expect(
      createSignedOutFile({ filePath, privateFiles: unreadable }).read(),
    ).resolves.toEqual([]);
  });
});
