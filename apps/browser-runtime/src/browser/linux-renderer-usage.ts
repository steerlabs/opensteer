import type { BrowserRendererUsage } from "@opensteer/browser-runtime-core";
import { readdir, readFile } from "node:fs/promises";

export interface LinuxProcFs {
  listPids(): Promise<readonly number[]> | readonly number[];
  readText(path: string): Promise<string | null> | string | null;
}

const defaultLinuxProcFs: LinuxProcFs = {
  async listPids(): Promise<readonly number[]> {
    try {
      const entries = await readdir("/proc");
      const pids: number[] = [];
      for (const entry of entries) {
        if (/^\d+$/u.test(entry)) {
          const pid = Number(entry);
          if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
        }
      }
      return pids;
    } catch {
      return [];
    }
  },
  async readText(filePath: string): Promise<string | null> {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      // Processes may exit or deny smaps_rollup between directory listing and file read.
      return null;
    }
  },
};

/** Parses parent PID from Linux `/proc/<pid>/stat`, tolerating spaces and `)` inside comm. */
export function parseProcStatPpid(statContent: string): number | null {
  const commEnd = statContent.lastIndexOf(")");
  if (commEnd < 0) return null;
  const fields = statContent
    .slice(commEnd + 1)
    .trim()
    .split(/\s+/u);
  // Field 0 is process state (e.g. "S"), field 1 is ppid.
  const raw = fields[1];
  if (!raw || !/^\d+$/u.test(raw)) return null;
  const ppid = Number(raw);
  return Number.isSafeInteger(ppid) && ppid >= 0 ? ppid : null;
}

function hasCmdlineFlag(cmdlineContent: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`, "u");
  return cmdlineContent.split("\0").some((part) => part === flag || pattern.test(part));
}

/**
 * Identifies Chromium page renderer processes from Linux `/proc/<pid>/cmdline`.
 * Direct launches delimit argv with NUL bytes, whereas Linux zygote-forked
 * sandboxed renderers rewrite argv[0] with spaces via SetProcessTitleFromCommandLine.
 * Excludes `--extension-process` renderers so the lifecycle helper is not counted as page RAM.
 */
export function isChromiumRendererCmdline(cmdlineContent: string): boolean {
  if (!cmdlineContent) return false;
  if (!hasCmdlineFlag(cmdlineContent, "--type=renderer")) return false;
  if (hasCmdlineFlag(cmdlineContent, "--extension-process")) return false;
  return true;
}

/** Parses proportional set size (`Pss`) in bytes from Linux `/proc/<pid>/smaps_rollup`. */
export function parseProcSmapsRollupPssBytes(smapsRollupContent: string): number | null {
  const match = /^Pss:\s+(\d+)\s*(?:kB)?\b/mu.exec(smapsRollupContent);
  if (!match?.[1]) return null;
  const kilobytes = Number(match[1]);
  if (!Number.isSafeInteger(kilobytes) || kilobytes <= 0) return null;
  return kilobytes * 1024;
}

/** Parses anonymous resident memory (`RssAnon`) in bytes from Linux `/proc/<pid>/status`. */
export function parseProcStatusRssAnonBytes(statusContent: string): number | null {
  const match = /^RssAnon:\s+(\d+)\s*(?:kB)?\b/mu.exec(statusContent);
  if (!match?.[1]) return null;
  const kilobytes = Number(match[1]);
  if (!Number.isSafeInteger(kilobytes) || kilobytes <= 0) return null;
  return kilobytes * 1024;
}

/**
 * Asynchronously counts and sums proportional memory (`Pss` from `smaps_rollup`,
 * falling back to `RssAnon` from `status`, never `VmRSS`) of Chromium page
 * renderer descendants of the given browser root PIDs using Linux `/proc`.
 * Returns `bytes: null` when a live renderer's memory could not be parsed so
 * callers fall back safely.
 */
export async function collectLinuxRendererUsage(
  rootPids: Iterable<number>,
  proc: LinuxProcFs = defaultLinuxProcFs,
): Promise<BrowserRendererUsage> {
  const roots = new Set<number>();
  for (const pid of rootPids) {
    if (Number.isSafeInteger(pid) && pid > 0) roots.add(pid);
  }
  if (roots.size === 0) return { processes: 0, bytes: 0 };

  const allPids = await proc.listPids();
  if (allPids.length === 0) return { processes: 0, bytes: null };

  const statEntries = await Promise.all(
    allPids.map(async (pid) => {
      const stat = await proc.readText(`/proc/${pid}/stat`);
      return stat === null ? null : { pid, ppid: parseProcStatPpid(stat) };
    }),
  );

  const childrenByPpid = new Map<number, number[]>();
  for (const entry of statEntries) {
    if (!entry || entry.ppid === null) continue;
    let children = childrenByPpid.get(entry.ppid);
    if (!children) {
      children = [];
      childrenByPpid.set(entry.ppid, children);
    }
    children.push(entry.pid);
  }

  const visited = new Set<number>(roots);
  const queue = [...roots];
  const descendants: number[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of childrenByPpid.get(current) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      descendants.push(child);
      queue.push(child);
    }
  }

  const measurements = await Promise.all(
    descendants.map(async (pid): Promise<number | null | "skip"> => {
      const cmdline = await proc.readText(`/proc/${pid}/cmdline`);
      if (cmdline === null || !isChromiumRendererCmdline(cmdline)) return "skip";
      const rollup = await proc.readText(`/proc/${pid}/smaps_rollup`);
      if (rollup !== null) {
        const pssBytes = parseProcSmapsRollupPssBytes(rollup);
        if (pssBytes !== null) return pssBytes;
      }
      const status = await proc.readText(`/proc/${pid}/status`);
      if (status === null && rollup === null) {
        // Renderer exited between cmdline and memory reads.
        return "skip";
      }
      return status === null ? null : parseProcStatusRssAnonBytes(status);
    }),
  );

  let processes = 0;
  let totalBytes = 0;
  let allMeasured = true;

  for (const measurement of measurements) {
    if (measurement === "skip") continue;
    processes++;
    if (measurement === null) {
      allMeasured = false;
    } else {
      totalBytes += measurement;
    }
  }

  return {
    processes,
    bytes: processes === 0 ? 0 : allMeasured ? totalBytes : null,
  };
}
