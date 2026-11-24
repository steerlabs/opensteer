import { execFile, execFileSync } from "node:child_process";
import {
  computerUseHelperAppPath,
  computerUseHelperExecutablePath,
} from "../../apps/desktop/src/computer-use/helper-paths.js";

/*
 * The Mac app starts its Computer Use helper through Launch Services, as a process of its own,
 * and by design the helper outlives the app until fifteen idle minutes pass
 * (`HelperRuntime.processIdleTimeout`). The journey quits the app after each trial, well inside
 * that, so a helper the app started is still running when the job ends, and the guest's
 * postflight rightly counts it (run 20261122T232239Z-fff1069e). The journey ends what it caused:
 * the helper processes running from the canonical bundle that were not running before it began,
 * each by its process id.
 */

/** The ids of processes in `ps -axo pid=,command=` output running exactly `executable`. */
export function helperProcessIds(psOutput: string, executable: string): number[] {
  return psOutput
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(.*)$/u.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .filter(([, , command]) => command === executable || command!.startsWith(`${executable} `))
    .map(([, pid]) => Number(pid));
}

/** The helper processes running now, from the canonical bundle under `home`. */
export function runningHelpers(home?: string): number[] {
  const executable = computerUseHelperExecutablePath(computerUseHelperAppPath(home));
  return helperProcessIds(
    execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" }),
    executable,
  );
}

/** Sends `name` to `pid`; false where there is no such process any more. */
function signal(pid: number, name: NodeJS.Signals): boolean {
  try {
    process.kill(pid, name);
    return true;
  } catch {
    return false;
  }
}

/** Waits until `pid` has exited (`caffeinate -w` returns as it does), or `ms` pass: whether it did. */
function exited(pid: number, ms: number): Promise<boolean> {
  return new Promise((resolve) =>
    execFile("/usr/bin/caffeinate", ["-w", String(pid)], { timeout: ms }, (error) =>
      resolve(error === null),
    ),
  );
}

/** Ends each helper process not in `before`: a TERM, then a KILL if it outlives a short wait. */
export async function endHelpersStartedSince(before: readonly number[], home?: string) {
  const started = runningHelpers(home).filter((pid) => !before.includes(pid));
  await Promise.all(
    started.map(async (pid) => {
      if (!signal(pid, "SIGTERM")) return;
      if (!(await exited(pid, 5_000))) signal(pid, "SIGKILL");
    }),
  );
  return started;
}
