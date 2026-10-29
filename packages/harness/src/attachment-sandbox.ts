import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Verified native sandbox paths for one Run's read-only attachment input. */
export function attachmentSandboxPaths(context: {
  readonly attachmentDirectory: string | undefined;
  readonly attachmentRoot: string | undefined;
  readonly privateStateRoot: string;
}): { readonly directory: string; readonly root: string } | null {
  const { attachmentDirectory, attachmentRoot } = context;
  if (!attachmentDirectory && !attachmentRoot) return null;
  if (!attachmentDirectory || !attachmentRoot) {
    throw new Error("Attachment sandbox requires both its cache root and current Thread directory");
  }
  if (![attachmentDirectory, attachmentRoot, context.privateStateRoot].every(isAbsolute)) {
    throw new Error("Attachment sandbox paths must be absolute");
  }
  const root = resolve(attachmentRoot);
  const directory = resolve(attachmentDirectory);
  if (dirname(directory) !== root) {
    throw new Error("Attachment directory must be an immediate child of its cache root");
  }
  if (lstatSync(root).isSymbolicLink() || lstatSync(directory).isSymbolicLink()) {
    throw new Error("Attachment sandbox paths must not be symlinks");
  }
  const realRoot = realpathSync(root);
  const realDirectory = realpathSync(directory);
  const privateRoot = realpathSync(context.privateStateRoot);
  if (dirname(realDirectory) !== realRoot || overlaps(realRoot, privateRoot)) {
    throw new Error("Attachment sandbox paths overlap or escape private Runner state");
  }
  return { directory, root };
}

function overlaps(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function isWithin(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}
