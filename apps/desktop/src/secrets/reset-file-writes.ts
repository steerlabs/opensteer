import path from "node:path";
import type { DesktopPrivateFilesystem } from "./desktop-private-files.js";

/** Fences stale catalog/auth writes until the process exits after a Personal reset. */
export function resetFileWrites(
  files: DesktopPrivateFilesystem,
  paths: readonly string[],
): {
  readonly files: DesktopPrivateFilesystem;
  readonly quiesce: () => Promise<void>;
} {
  const fenced = new Set(paths.map((value) => path.resolve(value)));
  const active = new Set<Promise<unknown>>();
  let stopped = false;
  function mutation<Result>(target: string, operation: () => Promise<Result>): Promise<Result> {
    if (!fenced.has(path.resolve(target))) return operation();
    if (stopped)
      return Promise.reject(
        new Error("Personal data reset is in progress. Reopen Opensteer to continue."),
      );
    const pending = operation();
    active.add(pending);
    void pending.finally(() => active.delete(pending)).catch(() => undefined);
    return pending;
  }
  return {
    quiesce: async () => {
      stopped = true;
      await Promise.allSettled(active);
    },
    files: {
      root: files.root,
      rootIdentity: files.rootIdentity,
      directoryEmpty: files.directoryEmpty.bind(files),
      ensureDirectory: files.ensureDirectory.bind(files),
      ensureDirectorySync: files.ensureDirectorySync.bind(files),
      fileExists: files.fileExists.bind(files),
      readFile: files.readFile.bind(files),
      removeFile: (target, signal) => mutation(target, () => files.removeFile(target, signal)),
      writeFileAtomic: (target, content, signal) =>
        mutation(target, () => files.writeFileAtomic(target, content, signal)),
      writeFileExclusive: (target, content, signal) =>
        mutation(target, () => files.writeFileExclusive(target, content, signal)),
    },
  };
}
