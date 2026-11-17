import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
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

/** Writes a new draft through the same contained, no-follow helper used to read Agent home. */
export async function exportPluginSource(
  root: string,
  directory: string,
  files: Extract<PluginInput<"install">, { kind: "files" }>["files"],
  helperPath: string,
) {
  const { NativeFsHelper, NativeFsHelperError } =
    await import("@opensteer/shared/files/native-fs-helper");
  const { OpensteerError } = await import("@opensteer/core");
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
    const segments = parts(file.path);
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
    return { segments, bytes };
  });
  if (
    files.length > 10000 ||
    entries.reduce((size, entry) => size + entry.bytes.length, 0) > 24 * 1024 * 1024
  )
    throw new OpensteerError({
      code: "bad_request",
      message: "Plugin source exceeds the 24 MiB export limit.",
    });
  const helper = new NativeFsHelper({ binary: helperPath, rootPolicy: "managed-local" });
  const signal = AbortSignal.timeout(60000);
  const expectedRootIdentity = await helper.directoryIdentity({ root, path: "." }, signal);
  try {
    await helper.createDirectory({ root, path: directory, expectedRootIdentity }, signal);
    const made = new Set([directory]);
    for (const { segments, bytes } of entries) {
      let parent = directory;
      for (const segment of segments.slice(0, -1)) {
        parent += "/" + segment;
        if (!made.has(parent)) {
          await helper.createDirectory({ root, path: parent, expectedRootIdentity }, signal);
          made.add(parent);
        }
      }
      await helper.writeBinary(
        {
          root,
          path: parent + "/" + segments.at(-1)!,
          contentBase64: bytes.toString("base64"),
          expectedRootIdentity,
        },
        signal,
      );
    }
  } catch (error) {
    if (error instanceof NativeFsHelperError)
      throw new OpensteerError({
        code: "conflict",
        message:
          "Plugin export refused an existing folder or file, a symlink, or a changed Agent home.",
        next: "Choose a new relative directory inside Agent home. An incomplete export may remain; inspect it before removing anything.",
      });
    throw error;
  }
}
