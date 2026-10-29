import {
  processSupervisorExecutableVariable,
  writeProcessControl,
} from "@opensteer/shared/processControl";
import { delay } from "@opensteer/shared/delay";
import { accessSync, constants, statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import type { Writable } from "node:stream";
import { z } from "zod";
import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { once } from "node:events";
import { platform } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface SupervisedProcessOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly maxOutputBytes?: number;
  readonly startupTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

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

export function spawnSupervised(options: SupervisedProcessOptions): SupervisedProcess {
  options.signal?.throwIfAborted();
  if (!options.executable) throw new TypeError("executable is required");
  const supervisor = z
    .string()
    .min(1)
    .optional()
    .parse(process.env[processSupervisorExecutableVariable]);
  if (supervisor && !isAbsolute(supervisor))
    throw new TypeError("The process supervisor must be absolute.");
  const spawnOptions: SpawnOptionsWithoutStdio = {
    cwd: options.cwd,
    detached: platform() !== "win32",
    env: {
      ...options.environment,
      ...(supervisor ? { [processSupervisorExecutableVariable]: supervisor } : {}),
    },
    shell: false,
    stdio: supervisor ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
  // A child of the root was started while the root lived: between these two
  // moments. That tells a Windows process reusing an id apart from a descendant.
  const lifespan: { readonly startedAt: number; exitedAt?: number } = { startedAt: Date.now() };
  // Each engine gets a control pipe owned by this Runner. An engine's new
  // process group cannot escape its native owner when the Runner itself dies.
  const child = spawn(
    supervisor ?? options.executable,
    supervisor ? ["--", absoluteTarget(options), ...options.args] : [...options.args],
    spawnOptions,
  ) as ChildProcessWithoutNullStreams;
  const control = supervisor ? child.stdio[3] : undefined;
  if (supervisor && (!control || typeof control === "number" || !("write" in control))) {
    child.kill();
    throw new Error("The native process control pipe was not created.");
  }
  let controlError: Error | undefined;
  control?.on("error", (error: Error) => {
    controlError = error;
  });
  const maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
  const stdout = boundedReadable(child.stdout, maxOutputBytes);
  const stderr = boundedReadable(child.stderr, maxOutputBytes);
  const exited = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      lifespan.exitedAt = Date.now();
      resolve({ code, signal });
    });
  });

  let termination: Promise<void> | undefined;
  const terminate = (graceMs = 5_000): Promise<void> => {
    if (termination) return termination;
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    if (controlError) return Promise.reject(controlError);
    termination ??= terminateProcessTree(
      child,
      exited,
      graceMs,
      lifespan,
      control && "write" in control ? (control as Writable) : undefined,
    );
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

/**
 * The supervisor runs only absolute targets, so a command is found here where
 * an unsupervised spawn would find it: against the child's working directory
 * when it names a path, else on the child's own PATH, whose relative entries
 * also start from that directory. On Windows a name without an extension
 * takes each of the child's PATHEXT extensions in turn.
 */
function absoluteTarget(options: SupervisedProcessOptions): string {
  const { cwd, environment, executable } = options;
  if (isAbsolute(executable)) return executable;
  if (executable.includes("/") || executable.includes("\\")) return resolve(cwd, executable);
  const windows = platform() === "win32";
  const extensions =
    windows && !extname(executable)
      ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  const path = environment.PATH ?? environment.Path;
  // No PATH at all names no directory, the working one included.
  if (path === undefined) throw new Error(`${executable} is not on the PATH it would run with.`);
  for (const directory of path.split(windows ? ";" : ":")) {
    for (const extension of extensions) {
      const candidate = resolve(cwd, directory, executable + extension);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (!windows) accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Absent or not executable: the spawn would keep looking.
      }
    }
  }
  throw new Error(`${executable} is not on the PATH it would run with.`);
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

async function terminateProcessTree(
  child: ChildProcess,
  exited: Promise<unknown>,
  graceMs: number,
  lifespan: RootLifespan,
  control?: Pick<Writable, "write">,
): Promise<void> {
  if (control) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await writeProcessControl(control, "graceful");
    const graceful = await Promise.race([
      exited.then(() => true),
      delay(Math.max(graceMs, 0)).then(() => false),
    ]);
    if (graceful) return;
    await writeProcessControl(control, "force");
    await Promise.race([exited, delay(2_000)]);
    return;
  }
  if (platform() === "win32") {
    await terminateWindowsTree(child, exited, graceMs, lifespan);
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalTree(child, "SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    delay(Math.max(graceMs, 0)).then(() => false),
  ]);
  if (graceful) return;
  signalTree(child, "SIGKILL");
  await Promise.race([exited, delay(2_000)]);
}

/**
 * Windows hands an orphan to no one: it keeps its parent's id, so a tree is
 * found from its root even once the root has exited, which `taskkill /t` alone
 * cannot do. The root is asked to close first; what remains of the tree is
 * then ended by force.
 */
async function terminateWindowsTree(
  child: ChildProcess,
  exited: Promise<unknown>,
  graceMs: number,
  lifespan: RootLifespan,
): Promise<void> {
  const root = child.pid;
  if (!root) return;
  const running = () => child.exitCode === null && child.signalCode === null;
  if (running()) {
    signalTree(child, "SIGTERM");
    await Promise.race([exited, delay(Math.max(graceMs, 0))]);
  }
  const descendants = await windowsDescendants(root, lifespan).catch(() => []);
  if (running()) signalTree(child, "SIGKILL");
  await Promise.allSettled(
    descendants.map((pid) =>
      execFileAsync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { windowsHide: true }),
    ),
  );
  await Promise.race([exited, delay(2_000)]);
}

interface RootLifespan {
  readonly exitedAt?: number;
  readonly startedAt: number;
}

/**
 * Every process below `root`. A child is created while its parent lives, so
 * one created before its parent, or after the root exited and another process
 * took the root's id, is no part of the tree.
 */
async function windowsDescendants(root: number, lifespan: RootLifespan): Promise<number[]> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().ToString('o') }",
    ],
    { maxBuffer: 16 * 1_024 * 1_024, timeout: 15_000, windowsHide: true },
  );
  const children = new Map<number, { readonly createdAt: number; readonly pid: number }[]>();
  for (const line of stdout.split(/\r?\n/u)) {
    const [pid, ppid, created] = line.trim().split(" ");
    const entry = { createdAt: Date.parse(created ?? ""), pid: Number(pid) };
    if (!Number.isSafeInteger(entry.pid) || !Number.isFinite(entry.createdAt)) continue;
    const siblings = children.get(Number(ppid));
    if (siblings) siblings.push(entry);
    else children.set(Number(ppid), [entry]);
  }
  const found: number[] = [];
  const pending = [{ createdAt: lifespan.startedAt, pid: root }];
  for (let parent = pending.pop(); parent; parent = pending.pop()) {
    for (const child of children.get(parent.pid) ?? []) {
      if (child.createdAt < parent.createdAt || found.includes(child.pid)) continue;
      if (parent.pid === root && child.createdAt > (lifespan.exitedAt ?? Infinity)) continue;
      found.push(child.pid);
      pending.push(child);
    }
  }
  return found;
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (platform() === "win32") {
      const arguments_ = ["/pid", String(child.pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])];
      const killer = spawn("taskkill.exe", arguments_, {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      void once(killer, "exit");
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    // macOS answers EPERM rather than ESRCH for a group that exited but is not
    // yet reaped; either way there is nothing left to signal.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
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
