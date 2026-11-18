/**
 * Host entries relative to `apps/host`. Child processes and worker threads load beside
 * the main module, so every Host build emits them into one directory under these names.
 */
export const hostProcessEntries = {
  main: "src/main.ts",
  processes: { "plugin-engine": "src/plugins/plugin-engine.ts" },
  workers: {
    "computer-repl-worker": "src/computer-use/computer-repl/computer-repl-worker.ts",
  },
} as const;

export type HostWorker = keyof typeof hostProcessEntries.workers;

/**
 * A worker's module beside `from`, in the same format: source runs `.ts`
 * under tsx, and each build loads the extension it emitted.
 */
export function hostWorkerUrl(worker: HostWorker, from: string): URL {
  const extension = /\.[cm]?[jt]s$/u.exec(new URL(from).pathname)?.[0];
  if (!extension) throw new Error(`The Host cannot locate its ${worker} from ${from}`);
  return new URL(`./${worker}${extension}`, from);
}
