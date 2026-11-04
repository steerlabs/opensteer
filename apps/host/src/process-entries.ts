/**
 * The modules one Host process runs, relative to `apps/host`: its main module
 * and each worker thread it starts. A worker loads from beside the running
 * main module, so every build of the Host emits all of them into one
 * directory under these names.
 */
export const hostProcessEntries = {
  main: "src/main.ts",
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
