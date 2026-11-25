import { readFileSync } from "node:fs";

/**
 * The kernel's count of processes it killed for lack of memory in the Runner's
 * own memory cgroup (cgroup v2 `memory.events`, `oom_kill`). The Runner reads
 * it only when a Run has failed, never on a timer and never for a Run that
 * ended otherwise: a count that moved since it last looked means a process of
 * the Runner was killed for memory in that time.
 */
export interface MemoryKills {
  /** Whether a process was killed for memory since the last call (or since start). */
  killedSinceLastLook(): boolean;
}

/**
 * The Runner's memory cgroup's kill count, or undefined where there is none to
 * read (a Mac, cgroup v1, or no memory controller): no reason is invented there.
 */
export function cgroupMemoryKills(
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): MemoryKills | undefined {
  const file = memoryEventsFile(read);
  if (!file) return undefined;
  const count = () => oomKills(read, file);
  let seen = count();
  if (seen === undefined) return undefined;
  return {
    killedSinceLastLook() {
      const now = count();
      if (now === undefined) return false;
      const moved = now > (seen ?? now);
      seen = now;
      return moved;
    },
  };
}

/** `/sys/fs/cgroup<own path>/memory.events`, from the process's cgroup v2 entry. */
function memoryEventsFile(read: (path: string) => string): string | undefined {
  let entries: string;
  try {
    entries = read("/proc/self/cgroup");
  } catch {
    return undefined;
  }
  // cgroup v2 is the single "0::<path>" entry; a container's own namespace shows "/".
  const path = /^0::(\/\S*)$/mu.exec(entries)?.[1];
  if (!path || path.includes("..")) return undefined;
  return `/sys/fs/cgroup${path === "/" ? "" : path}/memory.events`;
}

function oomKills(read: (path: string) => string, file: string): number | undefined {
  try {
    const value = /^oom_kill (\d+)$/mu.exec(read(file))?.[1];
    return value === undefined ? undefined : Number(value);
  } catch {
    return undefined;
  }
}
