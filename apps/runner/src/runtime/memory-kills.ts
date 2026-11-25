import { readFileSync } from "node:fs";

/**
 * The kernel's count of processes it killed for lack of memory in the Runner's
 * own memory cgroup (cgroup v2 `memory.events`, `oom_kill`). The Runner reads
 * it only when a failed Run's own engine was ended by a SIGKILL, never on a
 * timer and never for a Run that ended otherwise.
 */
export interface MemoryKills {
  /**
   * Claims one of the kills counted since the Runner started that no Run has
   * claimed yet: true once per kill, so two Runs whose engines were both killed
   * each get one, and a third gets none.
   */
  claimKill(): boolean;
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
  let claimed = count();
  if (claimed === undefined) return undefined;
  return {
    claimKill() {
      const now = count();
      if (now === undefined || claimed === undefined || now <= claimed) return false;
      claimed += 1;
      return true;
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
