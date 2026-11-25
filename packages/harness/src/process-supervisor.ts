import {
  hostCommandPlatform,
  planLaunch,
  resolveCommand,
  type CommandPlatform,
  type LaunchPlan,
  type ResolvedCommand,
} from "@opensteer/shared/command";
import {
  processSupervisorExecutableVariable,
  supervisedExitCode,
  windowsSupervisorDrained,
  writeProcessControl,
} from "@opensteer/shared/processControl";
import { delay } from "@opensteer/shared/delay";
import { constants } from "node:os";
import { isAbsolute } from "node:path";
import type { Duplex, Writable } from "node:stream";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type SupervisedProcessOptions = {
  readonly executable: string;
  readonly supervisorExecutable?: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /**
   * A complete cmd.exe command line for shell source the caller planned with
   * `planShellLaunch`; `executable` is that cmd.exe and `args` is empty.
   */
  readonly windowsCommandLine?: string;
  /** `closed` ends the child's stdin at once, for a child that must see EOF rather than wait. */
  readonly stdin?: "pipe" | "closed";
} & (
  | {
      /** Caps what each stream yields over the process's whole life (1 MiB by default). */
      readonly output?: "bounded";
      readonly maxOutputBytes?: number;
    }
  | {
      /** Every byte, for a long-lived protocol or log stream whose consumer bounds itself. */
      readonly output: "raw";
      readonly maxOutputBytes?: never;
    }
);

export interface SupervisedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: AsyncIterable<Buffer>;
  readonly stderr: AsyncIterable<Buffer>;
  readonly exited: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  terminate(graceMs?: number): Promise<void>;
}

/** A supervised process whose tree is not proven gone: while it runs, its whole tree is its own. */
export interface RunningSupervisedProcess {
  readonly environment: Readonly<Record<string, string>>;
  /** The supervisor's pid, with when it started: a reused pid is another process. */
  readonly identity: string;
  readonly pid: number;
  /** Tells the supervisor to stop its tree; it exits once nothing of the tree is left. */
  control(mode: "force" | "graceful"): void;
}

const running = new Set<RunningSupervisedProcess>();

/**
 * A supervised process whose target a SIGKILL ended that the supervisor did not send: the
 * kernel's kill for memory looks so. Its own force does not, nor a target's own exit(137).
 */
export interface KilledSupervisedProcess {
  readonly environment: Readonly<Record<string, string>>;
}
const killed: KilledSupervisedProcess[] = [];
const killedKept = 64;

/** The latest supervised processes a SIGKILL nobody stopping them sent ended, oldest first (at most 64). */
export function killedSupervisedProcesses(): readonly KilledSupervisedProcess[] {
  return killed;
}

/**
 * Every supervised process this process started whose tree is not proven gone:
 * those still running, and those that exited without proving it.
 */
export function runningSupervisedProcesses(): readonly RunningSupervisedProcess[] {
  return [...running];
}

/**
 * Starts `executable` under the native process supervisor, which contains the
 * whole tree it starts (a Job Object on Windows, a process group elsewhere)
 * and ends it when told to over the control pipe or when this process dies.
 */
export function spawnSupervised(options: SupervisedProcessOptions): SupervisedProcess {
  options.signal?.throwIfAborted();
  if (!options.executable) throw new TypeError("executable is required");
  const supervisor =
    options.supervisorExecutable ?? process.env[processSupervisorExecutableVariable];
  if (!supervisor)
    throw new Error(
      `${processSupervisorExecutableVariable} must name the process supervisor; every engine and program runs under it.`,
    );
  if (!isAbsolute(supervisor)) throw new TypeError("The process supervisor must be absolute.");
  const platform = hostCommandPlatform();
  const resolved = resolveCommand(options.executable, {
    cwd: options.cwd,
    environment: options.environment,
    platform,
  });
  if (!resolved)
    throw Object.assign(
      new Error(`${options.executable} was not found on the PATH it would run with.`),
      { code: "ENOENT" },
    );
  const plan = options.windowsCommandLine
    ? plannedCommandLine(resolved, options.args, options.windowsCommandLine, platform)
    : planLaunch(resolved, options.args, { environment: options.environment, platform });
  // A process group of its own lets the supervisor contain the tree on POSIX;
  // on Windows `detached` would only give it a console of its own.
  const child = spawn(
    supervisor,
    [
      ...(plan.windowsCommandLine ? ["--windows-command-line", plan.windowsCommandLine] : []),
      "--",
      plan.executable,
      ...plan.args,
    ],
    {
      cwd: options.cwd,
      detached: platform !== "win32",
      env: { ...options.environment, [processSupervisorExecutableVariable]: supervisor },
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  ) as ChildProcessWithoutNullStreams;
  const control = child.stdio[3];
  if (!control || typeof control === "number" || !("write" in control)) {
    child.kill();
    throw new Error("The native process control pipe was not created.");
  }
  let controlError: Error | undefined;
  control.on("error", (error: Error) => {
    controlError = error;
  });
  // Windows has no signals to report; elsewhere the supervisor's one line back comes before its exit.
  const targetSignal =
    platform === "win32" ? Promise.resolve(undefined) : reportedTargetSignal(control as Duplex);
  const entry: RunningSupervisedProcess = {
    control: (mode) => {
      if (!controlError) void writeProcessControl(control as Writable, mode).catch(() => undefined);
    },
    environment: options.environment,
    identity: `${String(child.pid)}@${String(Date.now())}`,
    pid: child.pid ?? 0,
  };
  if (child.pid !== undefined) running.add(entry);
  if (options.stdin === "closed") child.stdin.end();
  const maxOutputBytes =
    options.output === "raw" ? Number.POSITIVE_INFINITY : (options.maxOutputBytes ?? 1_048_576);
  const stdout = boundedReadable(child.stdout, maxOutputBytes);
  const stderr = boundedReadable(child.stderr, maxOutputBytes);
  const exited = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", (error) => {
      running.delete(entry);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      // Only Windows lists trees from here; elsewhere the process group does.
      if (platform !== "win32" || windowsSupervisorDrained(code)) running.delete(entry);
      const exitCode = supervisedExitCode(code, platform);
      // The record is in place before anyone hears of the exit (whose kill it was, a Runner asks
      // later). An exited supervisor's channel ends at once; one that does not end is no report.
      void within(targetSignal, controlEndGraceMs).then((reported) => {
        if (reported === constants.signals.SIGKILL) {
          killed.push({ environment: options.environment });
          if (killed.length > killedKept) killed.shift();
        }
        resolve({ code: exitCode, signal });
      });
    });
  });

  let childClosed = false;
  child.once("close", () => {
    childClosed = true;
  });
  let termination: Promise<void> | undefined;
  const terminate = (graceMs = 5_000): Promise<void> => {
    if (termination) return termination;
    if (childClosed || child.exitCode !== null || child.signalCode !== null)
      return Promise.resolve();
    termination = stopSupervised(control as Writable, exited, graceMs);
    return termination;
  };
  if (options.signal) {
    if (options.signal.aborted) void terminate(0);
    else
      options.signal.addEventListener(
        "abort",
        () => {
          void terminate().catch((error: unknown) =>
            console.error("Harness process shutdown failed", error),
          );
        },
        { once: true },
      );
  }
  return { child, exited, stderr, stdout, terminate };
}

/** How long an exit waits for the control channel to end; an exited supervisor ends it at once. */
const controlEndGraceMs = 1_000;

/**
 * The signal a supervisor reported, on its control channel just before it exited, as having
 * ended its target without its sending it (`target-signalled <N>`), once the channel ends. A
 * missing or malformed line is simply no report.
 */
function reportedTargetSignal(control: Duplex): Promise<number | undefined> {
  return new Promise((resolve) => {
    let received = "";
    control.setEncoding("utf8");
    control.on("data", (chunk: string) => {
      // One short line is all the supervisor ever sends; anything past it is dropped.
      if (received.length < 64) received += chunk.slice(0, 64 - received.length);
    });
    control.once("close", () => {
      const signal = /^target-signalled (\d{1,2})$/mu.exec(received)?.[1];
      resolve(signal === undefined ? undefined : Number(signal));
    });
  });
}

/** What `promise` settles to within `ms`, else undefined; the bound keeps no process alive. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let bound: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>((resolve) => {
    bound = setTimeout(() => resolve(undefined), ms);
    bound.unref();
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(bound));
}

function plannedCommandLine(
  resolved: ResolvedCommand,
  args: readonly string[],
  windowsCommandLine: string,
  platform: CommandPlatform,
): LaunchPlan {
  if (platform !== "win32" || resolved.kind !== "native" || args.length > 0)
    throw new TypeError(
      "A Windows command line runs one native program with no further arguments.",
    );
  return { args: [], executable: resolved.path, windowsCommandLine };
}

async function stopSupervised(
  control: Pick<Writable, "write">,
  exited: Promise<unknown>,
  graceMs: number,
): Promise<void> {
  const ended = exited.then(
    () => true,
    () => true,
  );
  // A supervisor that closed its control pipe is already ending its tree; its exit is the answer.
  const send = (mode: "force" | "graceful") =>
    writeProcessControl(control, mode).then(
      () => true,
      () => false,
    );
  if (!(await send("graceful"))) {
    await Promise.race([ended, delay(Math.max(graceMs, 0) + 2_000)]);
    return;
  }
  const graceful = await Promise.race([ended, delay(Math.max(graceMs, 0)).then(() => false)]);
  if (graceful) return;
  await send("force");
  await Promise.race([ended, delay(2_000)]);
}

/**
 * Bounds what a consumer may retain without ever stopping consumption. A
 * chatty provider must not be able to make the supervisor abandon the pipe:
 * once the budget is spent the excess is read and discarded, so the child keeps
 * running instead of stalling forever on stdout backpressure.
 */
async function* boundedReadable(
  stream: NodeJS.ReadableStream | null,
  maxBytes: number,
): AsyncIterable<Buffer> {
  if (!stream) return;
  let yielded = 0;
  for await (const rawChunk of stream) {
    if (yielded >= maxBytes) continue;
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    const remaining = maxBytes - yielded;
    if (chunk.byteLength <= remaining) {
      yielded += chunk.byteLength;
      yield chunk;
      continue;
    }
    yielded = maxBytes;
    yield chunk.subarray(0, remaining);
  }
}

/**
 * Everything one of a supervised process's streams produced, as text. The
 * chunks are concatenated as bytes before they are decoded, because a
 * multi-byte character can straddle a chunk boundary and decoding each chunk
 * on its own would replace it with a pair of replacement characters.
 */
export async function collectStreamText(stream: AsyncIterable<Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export interface SupervisedCommandResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

/**
 * Runs a short command to completion under the supervisor, with stdin closed,
 * and ends its whole tree if it outlives `timeoutMs`.
 */
export async function runSupervisedCommand(options: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
}): Promise<SupervisedCommandResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const child = spawnSupervised({
    args: options.args,
    cwd: options.cwd,
    environment: options.environment,
    executable: options.executable,
    maxOutputBytes: options.maxOutputBytes ?? 1_048_576,
    signal: timeout,
    stdin: "closed",
  });
  const [stdout, stderr, exit] = await Promise.all([
    collectStreamText(child.stdout),
    collectStreamText(child.stderr),
    child.exited,
  ]);
  if (timeout.aborted)
    throw new Error(`${options.executable} did not finish within ${options.timeoutMs} ms`);
  return { ...exit, stderr, stdout };
}
