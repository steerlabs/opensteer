import { OpensteerError } from "@opensteer/core";

/** What the shared sign-out needs from a driver's spawned CLI process. */
export interface HarnessLogoutProcess {
  readonly exited: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  readonly stdout: AsyncIterable<Buffer>;
  readonly stderr: AsyncIterable<Buffer>;
  terminate(graceMs?: number): Promise<void>;
}

/**
 * Drives a provider CLI's own sign-out to an outcome.
 *
 * Output is read and discarded rather than left unread: a sign-out prints
 * credential material often enough that retaining it would be a leak, and a
 * pipe nobody drains stalls the CLI before it can exit. A process that has not
 * finished when the deadline passes is terminated instead of being left
 * holding the profile's credential store.
 */
export async function runHarnessCliLogout(options: {
  /** The engine's own name, as the person sees it in the failure. */
  readonly engineLabel: string;
  readonly process: HarnessLogoutProcess;
  readonly timeoutMs: number;
}): Promise<void> {
  const output = drainProcessOutput(options.process);
  void output.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new OpensteerError({
            code: "timeout",
            message: `${options.engineLabel} sign out timed out`,
          }),
        ),
      options.timeoutMs,
    );
    timer.unref?.();
  });
  let exit: Awaited<HarnessLogoutProcess["exited"]> | undefined;
  try {
    exit = await Promise.race([options.process.exited, timeout]);
    await output;
  } finally {
    if (timer) clearTimeout(timer);
    if (!exit) await options.process.terminate().catch(() => undefined);
  }
  if (exit.code !== 0) {
    throw new OpensteerError({
      code: "harness_error",
      message: `${options.engineLabel} sign out failed (exit ${exit.code ?? "unknown"})`,
    });
  }
}

async function drainProcessOutput(process: HarnessLogoutProcess): Promise<void> {
  await Promise.all([drainAsyncOutput(process.stdout), drainAsyncOutput(process.stderr)]);
}

async function drainAsyncOutput(output: AsyncIterable<Buffer>): Promise<void> {
  for await (const _chunk of output) {
    // Provider output is deliberately discarded: sign-out output may contain secrets.
  }
}
