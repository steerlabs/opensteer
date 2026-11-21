import { execFile, spawn } from "node:child_process";
import { currentStepSignal } from "../step-signal.js";

export interface RunOptions {
  readonly timeoutMs?: number;
  readonly input?: string;
  /** Exit codes that are not failures (such as "already exists"). */
  readonly allow?: readonly number[];
  /** Ends the tool when it aborts; by default the signal of the step this runs for. */
  readonly signal?: AbortSignal;
}

/**
 * Runs a host tool without a shell; arguments are never interpreted. Round E, E2: it takes the
 * signal of the step it runs for, so a step that was given up on starts no further tool and its
 * running one is ended. Round F: it settles only once the tool has exited, so a step that is
 * drained has no tool still acting; one that ignores SIGTERM is killed 10 s later.
 */
export function run(
  file: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<string> {
  const signal = options.signal ?? currentStepSignal();
  if (signal?.aborted)
    return Promise.reject(new Error(`${file} was not started: its step was given up on.`));
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    let outcome: (() => void) | undefined;
    let exited = false;
    const finish = () => {
      if (outcome && exited) outcome();
    };
    const child = execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: { PATH: hostPath },
        ...(signal ? { signal } : {}),
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : 0;
        outcome =
          error && !(options.allow ?? []).includes(code)
            ? () =>
                reject(
                  new Error(`${file} ${args.join(" ")} failed: ${stderr.trim() || error.message}`),
                )
            : () => resolve(stdout);
        // A tool that never started has nothing to wait for.
        if (child.pid === undefined) exited = true;
        finish();
      },
    );
    const kill = () => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      timer.unref?.();
      child.once("close", () => clearTimeout(timer));
    };
    signal?.addEventListener("abort", kill, { once: true });
    const late = setTimeout(kill, timeoutMs);
    late.unref?.();
    child.once("close", () => {
      clearTimeout(late);
      signal?.removeEventListener("abort", kill);
      exited = true;
      finish();
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

/**
 * Starts a child and resolves once it exited cleanly or `ready` holds, whichever is first; a
 * failed exit rejects with the start of its error output (the jailer's, never a guest's).
 */
export function runUntil(
  file: string,
  args: readonly string[],
  ready: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: { PATH: hostPath },
    });
    let errors = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      child.stderr?.destroy();
      if (error) reject(error);
      else resolve();
    };
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errors.length < 4096) errors += chunk.toString("utf8");
    });
    const timer = setTimeout(
      () => finish(new Error(`${file} did not start within ${timeoutMs} ms.`)),
      timeoutMs,
    );
    const poll = setInterval(() => {
      void ready().then(
        (done) => done && finish(),
        () => undefined,
      );
    }, 5);
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      if (code === 0) finish();
      else finish(new Error(`${file} exited with ${code}: ${errors.trim().slice(0, 1000)}`));
    });
  });
}

const hostPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
