import { describe, expect, it, vi } from "vitest";
import { withFolderPluginPackage } from "./folder-plugin-package.js";

describe("Folder plugin package", () => {
  it.each(["../outside", "/etc", "folder/../../other", "folder/../other", "a\\b"])(
    "refuses path %s before reading",
    async (directory) => {
      const list = vi.fn();
      const install = vi.fn();
      await expect(
        withFolderPluginPackage({
          directory,
          files: { list, download: vi.fn() },
          install,
        }),
      ).rejects.toThrow("inside Agent home");
      expect(list).not.toHaveBeenCalled();
      expect(install).not.toHaveBeenCalled();
    },
  );
  it("refuses a symlink before installing", async () => {
    const install = vi.fn();
    await expect(
      withFolderPluginPackage({
        directory: "package",
        files: {
          list: vi.fn(async () => ({
            cursor: null,
            parentKey: "",
            revision: "revision",
            entries: [
              {
                key: "",
                name: "escape",
                kind: "symlink" as const,
                executable: false,
                hidden: false,
                mode: 0,
                modifiedAt: null,
                sizeBytes: 0,
              },
            ],
          })),
          download: vi.fn(),
        },
        install,
      }),
    ).rejects.toThrow("symlinks");
    expect(install).not.toHaveBeenCalled();
  });
});
