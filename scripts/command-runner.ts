import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { noFollowFlag } from "@opensteer/shared/privateFiles";
import { stopProcessGroup } from "@opensteer/shared/processGroup";

/** The kernel releases this advisory lock even if the coordinator crashes. */
export async function acquireReleaseLock(filename: string): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "python3",
      [
        "-c",
        [
          "import fcntl, os, sys",
          "fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT | int(sys.argv[2]), 0o600)",
          "try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)",
          "except BlockingIOError: sys.exit(73)",
          "os.ftruncate(fd, 0)",
          "os.write(fd, (str(os.getppid()) + '\\n').encode())",
          "print('locked', flush=True)",
          "sys.stdin.buffer.read()",
        ].join("\n"),
        filename,
        String(noFollowFlag()),
      ],
      { stdio: ["pipe", "pipe", "ignore"], shell: false },
    );
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Local release lock acquisition exceeded 5 seconds"));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        reject(new Error("Another coordinator owns the release lock (or Python locking failed)"));
    });
    child.stdout.once("data", () => {
      clearTimeout(timer);
      resolve(async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        await new Promise<void>((done) => {
          child.once("exit", () => done());
          child.stdin.end();
        });
      });
    });
  });
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  inheritOutput?: boolean;
  /** Writes stdout and stderr, in the order the command wrote them, here instead of returning them. */
  outputFile?: string;
}

export class CommandTimeoutError extends Error {
  override readonly name = "CommandTimeoutError";
}

function commandFailureDetail(output: string, environment: NodeJS.ProcessEnv): string {
  let detail = output.slice(-4_000);
  for (const [name, value] of Object.entries(environment)) {
    if (value && value.length >= 6 && /token|secret|password|credential|api.?key/iu.test(name))
      detail = detail.replaceAll(value, "[redacted]");
  }
  return detail.replace(/Bearer\s+[^\s"']+/giu, "Bearer [redacted]");
}

/**
 * Kill the process group so a timed-out pnpm cannot leave signing/build
 * children running. A command settles, with its own result, only once its
 * whole group has exited, so a caller that then releases a lock leaves nothing
 * writing.
 */
export async function runBounded(
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const output = options.outputFile ? openSync(options.outputFile, "a", 0o600) : undefined;
    let child: ChildProcess;
    try {
      child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ["ignore", output ?? "pipe", output ?? "pipe"],
        detached: process.platform !== "win32",
        shell: false,
      });
    } finally {
      // The child holds its own copy of the descriptor.
      if (output !== undefined) closeSync(output);
    }
    const stdout: Buffer[] = [];
    let stderr = "";
    let bytes = 0;
    let failure: Error | undefined;
    // Stops and joins the command's group once, when it is stopped or its direct child exits.
    let joined: Promise<void> | undefined;
    const join = () => {
      if (process.platform === "win32" || !child.pid) return Promise.resolve();
      if (!joined) {
        joined = stopProcessGroup(child.pid, { graceMs: 1_000 });
        joined.catch(() => undefined);
      }
      return joined;
    };
    const stop = (reason: Error) => {
      if (failure) return;
      failure = reason;
      if (process.platform === "win32" || !child.pid) child.kill("SIGKILL");
      else void join();
    };
    const abort = () =>
      stop(
        options.signal?.reason instanceof Error
          ? options.signal.reason
          : new Error("Command canceled"),
      );
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () =>
        stop(
          new CommandTimeoutError(
            `${executable} exceeded its deadline (${options.timeoutMs ?? 60_000} ms)`,
          ),
        ),
      options.timeoutMs ?? 60_000,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      if (options.inheritOutput) process.stdout.write(chunk);
      bytes += chunk.length;
      if (bytes <= 16 * 1024 * 1024) stdout.push(chunk);
      else stop(new Error(`${executable} exceeded its bounded output limit`));
    });
    // Keep only a bounded diagnostic tail; failure rendering masks known secret
    // environment values and bearer credentials before displaying it.
    child.stderr?.on("data", (chunk: Buffer) => {
      if (options.inheritOutput) process.stderr.write(chunk);
      stderr = (stderr + chunk.toString("utf8")).slice(-16_000);
    });
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    child.once("error", (error) => {
      cleanup();
      reject(
        "code" in error && error.code === "ENOENT"
          ? new Error(
              `Missing local prerequisite: ${executable}. Make it available before retrying.`,
            )
          : error,
      );
    });
    // A descendant holding the pipes would delay `close`, so the group stops at exit.
    child.once("exit", () => void join());
    child.once("close", (code, signal) => {
      cleanup();
      void join()
        .then(async () => {
          // Darwin may drop the process group before reaping its exiting PIDs.
          // Preserve the cancellation contract even after the shared group join.
          if ((failure || code !== 0) && process.platform !== "win32" && child.pid) {
            const deadline = Date.now() + 5_000;
            while (true) {
              const members = spawnSync("/bin/ps", ["-axo", "pid=,pgid="], {
                encoding: "utf8",
                timeout: Math.max(1, Math.min(1_000, deadline - Date.now())),
                killSignal: "SIGKILL",
                maxBuffer: 1024 * 1024,
              });
              if (members.status !== 0)
                throw new Error("Cannot inspect compiler group while joining cancellation", {
                  cause: members.error,
                });
              const hasMembers = members.stdout
                .split("\n")
                .some((line) => Number(line.trim().split(/\s+/u)[1]) === child.pid);
              if (!hasMembers) break;
              if (Date.now() >= deadline)
                throw new Error(`${executable} process group did not exit after cancellation`, {
                  cause: failure,
                });
              await delay(10);
            }
          }
          if (failure) reject(failure);
          else if (code !== 0)
            reject(
              // Preserve the real status for v3 qualification and rerun records.
              Object.assign(
                new Error(
                  `${executable} failed (${signal ?? `exit ${code}`}): ${commandFailureDetail(stderr || Buffer.concat(stdout).toString("utf8"), { ...process.env, ...options.env })}`,
                ),
                { exitCode: code, signal },
              ),
            );
          else resolve(Buffer.concat(stdout).toString("utf8").trim());
        })
        .catch(reject);
    });
  });
}

/** Persist command boundaries without stdout, environment values or credential arguments. */
export function timedCommands(
  filename: string,
  run: typeof runBounded = runBounded,
): typeof runBounded {
  return async (executable, args, options = {}) => {
    const id = randomUUID();
    const started = Date.now();
    const record = (event: string) =>
      appendFile(
        filename,
        JSON.stringify({
          id,
          event,
          executable,
          cwd: options.cwd,
          at: new Date().toISOString(),
          elapsedMs: Date.now() - started,
          // Arguments may contain an inline password/token. Record the command name;
          // its caller and timestamps identify the operation without retaining secrets.
          command: pathCommand(executable, args),
        }) + "\n",
        { mode: 0o600 },
      );
    await record("start");
    try {
      const output = await run(executable, args, {
        ...options,
        env: {
          ...options.env,
          OPENSTEER_RELEASE_TIMING_FILE: filename,
          OPENSTEER_RELEASE_COMMAND_ID: id,
        },
      });
      await record("complete");
      return output;
    } catch (error) {
      await record(options.signal?.aborted ? "canceled" : "failed");
      throw error;
    }
  };
}

function pathCommand(executable: string, args: readonly string[]): string {
  const name = path.basename(executable);
  if (name === "pnpm") {
    const recipe = args.find((arg) =>
      /^(?:scripts\/.*\.(?:ts|mjs)|check|test(?::[a-z-]+)?|build|package:mac|install|typecheck|lint|format:check)$/u.test(
        arg,
      ),
    );
    return [name, recipe].filter(Boolean).join(" ");
  }
  if (name === "xcrun" && ["notarytool", "stapler"].includes(args[0] ?? ""))
    return [
      name,
      args[0],
      ["submit", "info", "history", "staple", "validate"].includes(args[1] ?? "") ? args[1] : "",
    ]
      .join(" ")
      .trim();
  return name;
}

export class ReleasePendingError extends Error {
  override readonly name = "ReleasePendingError";
}
