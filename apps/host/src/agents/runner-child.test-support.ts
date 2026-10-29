import { fork } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { isNodeError } from "@opensteer/shared/nodeError";

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
        if (child.connected) child.send("close", () => undefined);
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
    // A crash journey deliberately kills only the leader; final cleanup still
    // owns its whole group, and production recovery must reap the old executions.
    crash: async () => {
      child.kill("SIGKILL");
      await exited;
    },
  };
}
