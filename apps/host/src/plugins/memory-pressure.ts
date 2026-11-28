import { readFileSync, writeFileSync } from "node:fs";

/**
 * Makes `pid` the process the Linux OOM killer takes first, ahead of the Host that started it: the
 * plugin engine runs in the Host's container and memory limit, and a script that grows there
 * should end the engine (and the workerd it starts, which inherits this), not the Host. Raising a
 * process's own score needs no privilege. Elsewhere it does nothing. Returns whether it was set.
 */
export function firstToGoUnderMemoryPressure(
  pid: number | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "linux" || pid === undefined) return false;
  try {
    writeFileSync(`/proc/${pid}/oom_score_adj`, "1000");
    return true;
  } catch {
    return false;
  }
}

/**
 * How many processes the kernel has killed for memory in this process's own cgroup (cgroup v2's
 * memory.events oom_kill), or undefined where that cannot be read. A count that grew while the
 * plugin engine ended by SIGKILL is the evidence that memory ended it.
 */
export function memoryKills(
  events = "/sys/fs/cgroup/memory.events",
  platform: NodeJS.Platform = process.platform,
): number | undefined {
  if (platform !== "linux") return undefined;
  try {
    const line = /^oom_kill (\d+)$/mu.exec(readFileSync(events, "utf8"));
    return line ? Number(line[1]) : undefined;
  } catch {
    return undefined;
  }
}
