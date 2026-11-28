import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { OpensteerError } from "@opensteer/core";
import type { AgentHomeFiles } from "../threads/agent-home-files.js";
import type { PluginInput } from "./engine-protocol.js";

export async function pluginSourceFiles(
  directory: string,
): Promise<PluginInput<"install"> & { kind: "files" }> {
  const files: Extract<PluginInput<"install">, { kind: "files" }>["files"] = [];
  const visit = async (path: string, prefix: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(path, entry.name), name + "/");
      else {
        const bytes = await readFile(join(path, entry.name));
        const content = bytes.toString("utf8");
        files.push(
          Buffer.from(content).equals(bytes)
            ? { path: name, content }
            : { path: name, content: bytes.toString("base64"), encoding: "base64" },
        );
      }
    }
  };
  await visit(directory, "");
  return { kind: "files", files };
}

/** Exports a plugin draft into Agent home through the hosting Runner's no-follow helper. */
export async function exportPluginSource(
  homeFiles: Pick<AgentHomeFiles, "writeDirectory">,
  directory: string,
  files: Extract<PluginInput<"install">, { kind: "files" }>["files"],
  authorize: () => Promise<void>,
  callerSignal?: AbortSignal,
) {
  const parts = (path: string) => {
    const segments = path.split("/");
    if (segments.some((s) => !s || s === "." || s === ".." || s.includes("\\") || s.includes("\0")))
      throw new OpensteerError({
        code: "bad_request",
        message: "Use a relative folder inside Agent home.",
      });
    return segments;
  };
  parts(directory);
  const entries = files.map((file) => {
    parts(file.path);
    if (!("content" in file))
      throw new OpensteerError({
        code: "bad_request",
        message: "Plugin source has an unavailable file object.",
      });
    const bytes =
      "encoding" in file ? Buffer.from(file.content, "base64") : Buffer.from(file.content);
    if ("encoding" in file && bytes.toString("base64") !== file.content)
      throw new OpensteerError({
        code: "bad_request",
        message: "Plugin source has invalid binary content.",
      });
    return { path: file.path, bytes };
  });
  if (
    files.length > 10000 ||
    entries.reduce((size, entry) => size + entry.bytes.length, 0) > 24 * 1024 * 1024
  )
    throw new OpensteerError({
      code: "bad_request",
      message: "Plugin source exceeds the 24 MiB export limit.",
    });
  const timeout = AbortSignal.timeout(60000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  await authorize();
  signal.throwIfAborted();
  try {
    await homeFiles.writeDirectory(
      { directory, files: entries, maxBytes: 24 * 1024 * 1024 },
      signal,
    );
  } catch (error) {
    if (
      error instanceof OpensteerError &&
      error.code === "conflict" &&
      error.reason !== "unsupported-runner"
    )
      throw new OpensteerError({
        code: "conflict",
        message:
          "Plugin export refused an existing folder or file, a symlink, or a changed Agent home.",
        next: "Choose a new relative directory inside Agent home. An incomplete export may remain; inspect it before removing anything.",
      });
    throw error;
  }
}
