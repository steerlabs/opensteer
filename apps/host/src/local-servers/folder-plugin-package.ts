import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { refused } from "@opensteer/core";
import type { AgentHomeFiles } from "../threads/agent-home-files.js";
import { readBoundedResponse } from "@opensteer/shared/boundedJson";
import { maximumLocalServerFolderFiles } from "@opensteer/agent-plugins";

/** Read through the owning Runner's no-follow file operations, never a Host path. */
export async function withFolderPluginPackage<T>(input: {
  directory: string;
  files: Pick<AgentHomeFiles, "list" | "download">;
  install: (directory: string) => Promise<T>;
}): Promise<T> {
  const segments = input.directory.replace(/^\.\//u, "").split("/");
  if (
    isAbsolute(input.directory) ||
    segments.some((s) => !s || s === "." || s === ".." || s.includes("\\") || s.includes("\0"))
  )
    throw refused("bad_request", "Plugin directory must be a relative folder inside Agent home");
  const temporary = await mkdtemp(join(tmpdir(), "opensteer-plugin-"));
  // The same bound the package snapshot holds the folder to, which leaves room for its
  // generated registration file.
  let files = 0;
  let directories = 0;
  let bytes = 0;
  let rootScope: string | undefined;
  const visit = async (parts: string[], target: string): Promise<void> => {
    const parentKey = Buffer.from(parts.join("\0")).toString("base64url");
    let cursor: string | undefined;
    do {
      const page = await input.files.list({
        parentKey,
        limit: 500,
        ...(rootScope ? { expectedRootScope: rootScope } : {}),
        ...(cursor ? { cursor } : {}),
      });
      rootScope ??= page.rootScope;
      for (const entry of page.entries) {
        if ((entry.kind === "directory" ? ++directories : ++files) > maximumLocalServerFolderFiles)
          throw refused(
            "bad_request",
            `Plugin contains more than ${maximumLocalServerFolderFiles} files or folders`,
          );
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
          if (!entry.revision)
            throw refused("conflict", "Update the hosting Device to install plugins from folders.");
          const response = await input.files.download(
            entry.key,
            undefined,
            undefined,
            entry.revision,
          );
          if (!response.ok) throw refused("conflict", "Could not read plugin file");
          const content = Buffer.from(
            await readBoundedResponse(response, {
              maximumBytes: entry.sizeBytes,
              sizeError: () => refused("conflict", "Plugin changed during installation"),
            }),
          );
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
