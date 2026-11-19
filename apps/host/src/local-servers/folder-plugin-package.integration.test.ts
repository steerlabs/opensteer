import { expect, it, vi } from "vitest";
import { maximumLocalServerFolderFiles, readPluginSnapshot } from "@opensteer/agent-plugins";
import { withFolderPluginPackage } from "./folder-plugin-package.js";

// Copies and reads 10,000 real files, which takes the integration lane's time.
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
});
