import { describe, expect, it, vi } from "vitest";
import { maximumLocalServerFolderFiles, readPluginSnapshot } from "@opensteer/agent-plugins";
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
  it("copies a folder of the most files a package leaves room for, in a folder of its own", async () => {
    const key = (...parts: string[]) => Buffer.from(parts.join("\0")).toString("base64url");
    const entry = (name: string, kind: "directory" | "file", ...parent: string[]) => ({
      key: key(...parent, name),
      name,
      kind,
      executable: false,
      hidden: false,
      mode: 0o600,
      modifiedAt: null,
      sizeBytes: 0,
    });
    const names = Array.from({ length: maximumLocalServerFolderFiles }, (_, index) => `f${index}`);
    const list = vi.fn(async ({ parentKey, cursor }: { parentKey: string; cursor?: string }) => {
      const page = Number(cursor ?? 0);
      const entries =
        parentKey === key("package")
          ? [entry("bin", "directory", "package")]
          : names.slice(page * 500, page * 500 + 500).map((name) => entry(name, "file"));
      const more = parentKey !== key("package") && (page + 1) * 500 < names.length;
      return { cursor: more ? String(page + 1) : null, parentKey, revision: "r", entries };
    });
    const copied = await withFolderPluginPackage({
      directory: "package",
      files: { list, download: vi.fn(async () => new Response("")) },
      install: async (directory) => (await readPluginSnapshot(directory)).length,
    });
    expect(copied).toBe(maximumLocalServerFolderFiles);
  }, 60_000); // Copies and reads 10,000 real files.
});
