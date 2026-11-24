import { fork } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { vi } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { isNodeError } from "@opensteer/shared/nodeError";

export interface RunnerCrashOptions {
  /**
   * On Linux, `opensteer-process-supervisor` enables `PR_SET_CHILD_SUBREAPER`
   * and kills even detached descendants as soon as the Runner's control pipe
   * closes. Setting `killSupervisors` models a crash where the supervisor is
   * SIGKILLed alongside the Runner (before it can drain its tree): freeze the
   * Runner with SIGSTOP so it cannot classify supervisor death as a failure or
   * close its control pipe early, SIGKILL its process-supervisor children until
   * dead/zombie, then SIGKILL the Runner. On macOS this is a no-op because
   * detached `setsid` descendants already survive a Runner-only SIGKILL.
   */
  readonly killSupervisors?: boolean;
}

function readLinuxProcStatFields(
  pid: number,
): { readonly state: string; readonly ppid: number } | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = raw
      .slice(close + 2)
      .trim()
      .split(/\s+/u);
    const state = fields[0];
    const ppid = Number(fields[1]);
    if (!state || !Number.isInteger(ppid)) return undefined;
    return { state, ppid };
  } catch {
    return undefined;
  }
}

function findLinuxChildSupervisors(runnerPid: number): number[] {
  const supervisors: number[] = [];
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const stat = readLinuxProcStatFields(pid);
    if (!stat || stat.ppid !== runnerPid) continue;
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const argv0 = cmdline.split("\0", 1)[0] ?? "";
      if (
        argv0 === "opensteer-process-supervisor" ||
        argv0.endsWith("/opensteer-process-supervisor")
      ) {
        supervisors.push(pid);
      }
    } catch {
      // Process exited between stat and cmdline read.
    }
  }
  return supervisors;
}

async function crashRunnerAndLinuxSupervisors(
  runnerPid: number,
  exited: Promise<void>,
): Promise<void> {
  let killError: unknown;
  try {
    process.kill(runnerPid, "SIGSTOP");
    await vi.waitUntil(
      () => {
        const state = readLinuxProcStatFields(runnerPid)?.state;
        return state === "T" || state === "t";
      },
      { interval: 10, timeout: 5_000 },
    );
    const supervisors = findLinuxChildSupervisors(runnerPid);
    if (supervisors.length === 0) {
      throw new Error(`Expected an opensteer-process-supervisor child under Runner ${runnerPid}`);
    }
    for (const pid of supervisors) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ESRCH") throw error;
      }
    }
    await vi.waitUntil(
      () =>
        supervisors.every((pid) => {
          const state = readLinuxProcStatFields(pid)?.state;
          return state === undefined || state === "Z" || state === "X";
        }),
      { interval: 10, timeout: 5_000 },
    );
  } finally {
    try {
      process.kill(runnerPid, "SIGKILL");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ESRCH") killError = error;
    }
  }
  if (killError !== undefined) throw killError;
  await exited;
}

// The fixture also bounds signallable groups that survive KILL. The shared
// processGroup helper currently bounds only groups it cannot signal.
async function stopRunnerProcessGroup(group: number, graceMs: number): Promise<void> {
  const deadline = performance.now() + graceMs;
  const signal = (value: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-group, value);
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ESRCH") return false;
      if (isNodeError(error) && error.code === "EPERM") return true;
      throw error;
    }
  };
  let present = signal("SIGTERM");
  while (present) {
    if (performance.now() > deadline + 5_000)
      throw new Error(`Runner process group ${group} did not disappear`);
    await delay(25);
    present = signal(performance.now() < deadline ? 0 : "SIGKILL");
  }
}

/** Ownership starts at fork, independently of the Runner readiness handshake. */
export function forkRunnerChild(
  entrypoint: string,
  options: {
    readonly args?: readonly string[];
    readonly execArgv?: readonly string[];
    readonly gracefulCloseMs?: number;
    readonly termGraceMs?: number;
    readonly environment?: NodeJS.ProcessEnv;
    readonly afterStop?: () => Promise<void>;
    readonly beforeClose?: () => Promise<void>;
    readonly closeMessage?: string;
  },
  own: (close: () => Promise<void>) => void,
) {
  const child = fork(entrypoint, [...(options.args ?? [])], {
    execArgv: [...(options.execArgv ?? [])],
    detached: true,
    env: { ...process.env, ...options.environment },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const failures: unknown[] = [];
      try {
        await options.beforeClose?.();
      } catch (error) {
        failures.push(error);
      }
      try {
        if (child.connected) child.send(options.closeMessage ?? "close", () => undefined);
        await withTimeout(exited, options.gracefulCloseMs ?? 1_000, {
          timeoutError: () => new Error("Runner ignored graceful close"),
        }).catch(() => undefined);
        // Always inspect the group: the leader may have exited while descendants live.
        if (child.pid !== undefined)
          await stopRunnerProcessGroup(child.pid, options.termGraceMs ?? 1_000);
        await withTimeout(exited, 5_000, {
          timeoutError: () => new Error("Runner child exit was not observed"),
        });
      } catch (error) {
        failures.push(error);
      }
      // Engine preparation may own another process group. Its execution marker
      // remains discoverable after the Runner and its group have disappeared.
      try {
        await options.afterStop?.();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, "Runner child cleanup failed");
    })());
  own(close);
  return {
    child,
    exited,
    close,
    // A crash journey deliberately kills only the leader (or the leader plus
    // its Linux subreaper supervisors when modeling a crash that leaves
    // surviving marked descendants); final cleanup still owns its whole group,
    // and production recovery must reap the old executions.
    crash: async (crashOptions?: RunnerCrashOptions) => {
      if (
        crashOptions?.killSupervisors &&
        process.platform === "linux" &&
        child.pid !== undefined
      ) {
        await crashRunnerAndLinuxSupervisors(child.pid, exited);
        return;
      }
      child.kill("SIGKILL");
      await exited;
    },
  };
}
