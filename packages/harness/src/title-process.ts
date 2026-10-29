import { OpensteerError } from "@opensteer/core";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { collectStreamText, spawnSupervised } from "./process-supervisor.js";
import type { HarnessProcessLaunch, HarnessSessionContext } from "./types.js";

/** Keep scratch files inside the Thread paths exposed by the Runner's sandbox. */
export async function withTitleDirectory<T>(
  context: Pick<HarnessSessionContext, "threadStateDirectory">,
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  await mkdir(context.threadStateDirectory, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(context.threadStateDirectory, "title-"));
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * A private, bounded reply; stderr never becomes a diagnostic containing the
 * request. `failure` matches what an engine writes to stderr when it can no
 * longer answer but would go on retrying, such as a provider refusing the
 * request: the process ends there, rather than at the budget.
 */
export async function runTitleProcess(
  context: Pick<HarnessSessionContext, "wrapProcessLaunch">,
  launch: HarnessProcessLaunch,
  signal: AbortSignal,
  stdin?: string,
  failure?: RegExp,
): Promise<string> {
  signal.throwIfAborted();
  const child = spawnSupervised({
    ...context.wrapProcessLaunch(launch),
    maxOutputBytes: 64 * 1024,
  });
  const abort = () => void child.terminate(0).catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  let refused = false;
  const stdout = collectStreamText(child.stdout);
  const stderr = (async () => {
    let text = "";
    for await (const chunk of child.stderr) {
      text = (text + chunk.toString("utf8")).slice(-16 * 1024);
      if (failure?.test(text) && !refused) {
        refused = true;
        abort();
      }
    }
    return text;
  })();
  // Both drains are observed even when spawn or shutdown fails.
  const drains = Promise.all([stdout, stderr]);
  void drains.catch(() => undefined);
  child.child.stdin.on("error", () => undefined);
  child.child.stdin.end(stdin);
  try {
    if (signal.aborted) abort();
    const exit = await child.exited;
    const [reply] = await drains;
    signal.throwIfAborted();
    if (refused)
      throw new OpensteerError({
        code: "harness_error",
        message: "Thread title engine could not answer",
      });
    if (exit.code !== 0)
      throw new OpensteerError({
        code: "harness_error",
        message: "Thread title process failed",
        details: { exitCode: exit.code },
      });
    return reply;
  } finally {
    signal.removeEventListener("abort", abort);
    await child.terminate(0);
    await child.exited;
    await drains;
  }
}
