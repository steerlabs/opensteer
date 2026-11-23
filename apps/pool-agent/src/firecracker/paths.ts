/**
 * Host paths a provisioner names (a slot's profile disk, its egress credential files) must be
 * inside the root configured for them, by their resolved real path: no `..`, no link that
 * leads out, and the kind of file expected (review G9). Checked at create and again at use.
 */
import { lstat, realpath } from "node:fs/promises";
import { sep } from "node:path";

export class PathOutsideRoot extends Error {
  override readonly name = "PathOutsideRoot";
}

export async function confine(
  path: string,
  root: string,
  kind: "profile" | "credential",
): Promise<string> {
  if (!path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "."))
    throw new PathOutsideRoot(`${path} is not a plain absolute path.`);
  const info = await lstat(path).catch(() => undefined);
  if (!info) throw new PathOutsideRoot(`${path} does not exist.`);
  if (info.isSymbolicLink()) throw new PathOutsideRoot(`${path} is a link.`);
  const allowed = kind === "profile" ? info.isFile() || info.isBlockDevice() : info.isFile();
  if (!allowed) throw new PathOutsideRoot(`${path} is not a ${kind} file.`);
  const [real, base] = await Promise.all([realpath(path), realpath(root)]);
  if (!real.startsWith(base.endsWith(sep) ? base : `${base}${sep}`))
    throw new PathOutsideRoot(`${path} is outside ${root}.`);
  return real;
}
