import { execFile } from "node:child_process";
import { appendFileSync, writeSync } from "node:fs";

type Trace = (event: Record<string, unknown>) => void;
export type Log = (file: string, text: string) => void;

/**
 * Diagnostics run in child callbacks and during cleanup, outside the launch's
 * try/finally, so they never throw. A failed write falls back to a bounded,
 * synchronous stderr write that emits no stream events.
 */
export function bestEffortLog(
  options: {
    readonly write?: (file: string, text: string) => void;
    readonly fallback?: (bytes: Uint8Array) => void;
    readonly fallbackBytes?: number;
  } = {},
): Log {
  const write = options.write ?? appendFileSync;
  const fallback = options.fallback ?? ((bytes: Uint8Array) => writeSync(2, bytes));
  let budget = options.fallbackBytes ?? 64 * 1024;
  return (file, text) => {
    try {
      write(file, text);
    } catch (error) {
      const note = Buffer.from(`${file} write failed: ${String(error)}\n${text}`);
      let end = Math.min(note.length, budget);
      // Cut at a character boundary, never inside a UTF-8 sequence.
      while (end > 0 && end < note.length && (note[end]! & 0xc0) === 0x80) end--;
      budget -= end;
      try {
        if (end > 0) fallback(note.subarray(0, end));
      } catch {
        // Nothing is left to report to.
      }
    }
  };
}

export function fileTrace(file: string, log: Log): Trace {
  return (event) => {
    let line: string;
    try {
      line = JSON.stringify({ at: new Date().toISOString(), ...event });
    } catch {
      line = JSON.stringify({ at: new Date().toISOString(), event: "trace.unserializable" });
    }
    log(file, `${line}\n`);
  };
}

/** SIGKILLs every captured PID; a failure to log one never stops the rest. */
export function stopCaptured(
  pids: readonly number[],
  note: (text: string) => void,
  kill: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => process.kill(pid, signal),
) {
  for (const pid of pids) {
    try {
      kill(pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
        note(`Could not stop captured PID ${pid}: ${String(error)}\n`);
    }
  }
}

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
