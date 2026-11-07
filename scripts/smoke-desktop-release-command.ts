import { execFile } from "node:child_process";

type Trace = (event: Record<string, unknown>) => void;

export async function bounded<T>(
  name: string,
  milliseconds: number,
  work: (signal: AbortSignal) => Promise<T>,
  failure: AbortController,
  trace: Trace = () => {},
): Promise<T> {
  const started = performance.now();
  const timeout = AbortSignal.timeout(milliseconds);
  trace({ event: "bound.start", name, milliseconds });
  const signal = AbortSignal.any([timeout, failure.signal]);
  signal.throwIfAborted();
  let stop: (() => void) | undefined;
  try {
    return await Promise.race([
      work(signal),
      new Promise<never>((_, reject) => {
        stop = () => {
          const reason = timeout.aborted
            ? `outer bound expired after ${milliseconds}ms`
            : "application failure";
          trace({ event: "bound.abort", name, reason, elapsedMs: performance.now() - started });
          reject(Error(`${name}: ${reason}: ${String(signal.reason)}`));
        };
        signal.addEventListener("abort", stop, { once: true });
      }),
    ]);
  } finally {
    if (stop) signal.removeEventListener("abort", stop);
    trace({ event: "bound.end", name, elapsedMs: performance.now() - started });
  }
}

export function command(
  program: string,
  args: string[],
  timeout: number,
  roots: Set<number>,
  trace: Trace = () => {},
): Promise<string> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  trace({ event: "command.start", program, args, startedAt, timeout });
  return new Promise((resolve, reject) => {
    let spawnedAt: string | null = null;
    const child = execFile(
      program,
      args,
      { timeout, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (child.pid) roots.delete(child.pid);
        const status = {
          program,
          pid: child.pid,
          startedAt,
          spawnedAt,
          timeout,
          elapsedMs: performance.now() - started,
          code: error?.code ?? child.exitCode,
          signal: error?.signal ?? child.signalCode,
          killed: error?.killed ?? child.killed,
        };
        trace({ event: "command.end", ...status });
        if (error)
          reject(
            Error(
              `${program}: ${JSON.stringify(status)}\n${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
            ),
          );
        else resolve(stdout);
      },
    );
    if (child.pid) roots.add(child.pid);
    child.once("spawn", () => {
      spawnedAt = new Date().toISOString();
      trace({
        event: "command.spawn",
        program,
        pid: child.pid,
        spawnedAt,
        elapsedMs: performance.now() - started,
      });
    });
    child.stdout?.on("data", (chunk: Buffer) =>
      trace({ event: "command.stdout", pid: child.pid, text: chunk.toString() }),
    );
    child.stderr?.on("data", (chunk: Buffer) =>
      trace({ event: "command.stderr", pid: child.pid, text: chunk.toString() }),
    );
  });
}
