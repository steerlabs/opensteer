import { readFileSync } from "node:fs";

/**
 * The kernel's count of processes it killed for lack of memory in the Runner's
 * own memory cgroup (cgroup v2 `memory.events`, `oom_kill`). A Run notes the
 * count once as it starts, and reads it again only when it failed and its own
 * engine was ended by a SIGKILL nobody stopping it sent.
 */
export interface MemoryKills {
  /**
   * The count now, which a starting Run keeps: one synchronous read of a small
   * kernel file in memory (no disk and no database statement), or undefined
   * where it cannot be read.
   */
  mark(): number | undefined;
  /**
   * Claims one kill counted after `since` (a Run's mark) that no Run has
   * claimed yet: true once per kill, so two Runs whose engines were both killed
   * each get one, a third gets none, and a kill counted before a Run started
   * (a tool's, say, whose engine lived on) is never that Run's.
   */
  claimKill(since: number | undefined): boolean;
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
  if (count() === undefined) return undefined;
  // The kills (by their place in the count) a Run has claimed: one entry per kill for memory.
  const claimed = new Set<number>();
  return {
    claimKill(since) {
      const now = count();
      if (since === undefined || now === undefined) return false;
      for (let kill = since + 1; kill <= now; kill += 1) {
        if (claimed.has(kill)) continue;
        claimed.add(kill);
        return true;
      }
      return false;
    },
    mark: count,
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
