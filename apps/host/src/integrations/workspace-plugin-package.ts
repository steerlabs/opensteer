import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { refused } from "@opensteer/core";
import type { WorkspaceFilesAdmission } from "@opensteer/database";
import type { WorkspaceFilesService } from "../workspace/files/workspace-files-service.js";

/** Read through the owning Runner's no-follow file operations, never a Host path. */
export async function withWorkspacePluginPackage<T>(input: {
  directory: string;
  admission: WorkspaceFilesAdmission;
  files: Pick<WorkspaceFilesService, "list" | "download">;
  install: (directory: string) => Promise<T>;
}): Promise<T> {
  const segments = input.directory.replace(/^\.\//u, "").split("/");
  if (
    isAbsolute(input.directory) ||
    segments.some((s) => !s || s === "." || s === ".." || s.includes("\\") || s.includes("\0"))
  )
    throw refused(
      "bad_request",
      "Plugin directory must be a relative folder inside this Workspace",
    );
  const temporary = await mkdtemp(join(tmpdir(), "opensteer-plugin-"));
  let count = 0;
  let bytes = 0;
  const visit = async (parts: string[], target: string): Promise<void> => {
    const parentKey = Buffer.from(parts.join("\0")).toString("base64url");
    let cursor: string | undefined;
    do {
      const page = await input.files.list(input.admission, {
        parentKey,
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      for (const entry of page.entries) {
        if (++count > 10000) throw refused("bad_request", "Plugin contains too many files");
        if (entry.kind === "symlink" || entry.kind === "opaque")
          throw refused("bad_request", "Plugin packages cannot contain symlinks or special files");
        const rawName = Buffer.from(entry.key, "base64url").toString("utf8").split("\0").at(-1)!;
        if (
          !rawName ||
          rawName === "." ||
          rawName === ".." ||
          rawName.includes("/") ||
          rawName.includes("\\")
        )
          throw refused("bad_request", "Invalid plugin file name");
        const destination = join(target, rawName);
        if (entry.kind === "directory") {
          await mkdir(destination);
          await visit([...parts, rawName], destination);
        } else {
          bytes += entry.sizeBytes;
          if (bytes > 24 * 1024 * 1024)
            throw refused("bad_request", "Plugin package exceeds installation limit");
          const response = await input.files.download(input.admission, entry.key);
          if (!response.ok) throw refused("conflict", "Could not read plugin file");
          const content = Buffer.from(await response.arrayBuffer());
          if (content.length !== entry.sizeBytes)
            throw refused("conflict", "Plugin changed during installation");
          await writeFile(destination, content, { mode: entry.mode & 0o777, flag: "wx" });
        }
      }
      cursor = page.cursor ?? undefined;
    } while (cursor);
  };
  try {
    await visit(segments, temporary);
    return await input.install(temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
