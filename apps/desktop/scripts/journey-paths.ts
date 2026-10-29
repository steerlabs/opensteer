import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export interface PathMetadata {
  kind: "directory" | "file" | "symlink";
  dev: string;
  ino: string;
}
export interface PathIO {
  lstat(file: string): PathMetadata | undefined;
  realpath(file: string): string;
}
export const realPathIO: PathIO = {
  lstat(file) {
    try {
      const stat = lstatSync(file, { bigint: true });
      return {
        kind: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file",
        dev: String(stat.dev),
        ino: String(stat.ino),
      };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    }
  },
  realpath: (file) => realpathSync(file),
};
const AnchorSchema = z.object({
  path: z.string(),
  realPath: z.string(),
  dev: z.string(),
  ino: z.string(),
});
export const PathBindingSchema = z.object({
  path: z.string(),
  realPath: z.string(),
  ancestors: z.array(AnchorSchema).min(1),
});
export type PathBinding = z.infer<typeof PathBindingSchema>;

/** Only macOS's system /tmp alias is permitted; user-controlled symlinks never grant ownership. */
export function bindPath(file: string, io: PathIO = realPathIO): PathBinding {
  if (!path.isAbsolute(file) || path.resolve(file) !== file)
    throw Error(`Noncanonical path: ${file}`);
  const ancestors: PathBinding["ancestors"] = [];
  let realPath = "/";
  const parts = file.split("/").filter(Boolean);
  const prefixes = ["/", ...parts.map((_, i) => "/" + parts.slice(0, i + 1).join("/"))];
  for (const prefix of prefixes) {
    const stat = io.lstat(prefix);
    if (stat) {
      if (stat.kind === "symlink" && !(prefix === "/tmp" && io.realpath(prefix) === "/private/tmp"))
        throw Error(`Unexpected symlink: ${prefix}`);
      if (prefix !== file && stat.kind === "file") throw Error(`Non-directory ancestor: ${prefix}`);
      realPath = io.realpath(prefix);
      if (stat.kind === "symlink") ancestors.push(...bindPath("/private/tmp", io).ancestors);
      ancestors.push({ path: prefix, realPath, dev: stat.dev, ino: stat.ino });
    } else {
      realPath = path.join(realPath, path.basename(prefix));
    }
  }
  return { path: file, realPath, ancestors };
}
export function validatePathBinding(binding: PathBinding, io: PathIO = realPathIO): void {
  const current = bindPath(binding.path, io);
  if (current.realPath !== binding.realPath) throw Error(`Path location changed: ${binding.path}`);
  for (const anchor of binding.ancestors) {
    const now = current.ancestors.find((a) => a.path === anchor.path);
    if (
      !now ||
      now.realPath !== anchor.realPath ||
      now.dev !== anchor.dev ||
      now.ino !== anchor.ino
    )
      throw Error(`Path ancestor changed: ${anchor.path}`);
  }
}
