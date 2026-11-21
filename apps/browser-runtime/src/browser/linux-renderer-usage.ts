import type { BrowserRendererUsage } from "@opensteer/browser-runtime-core";
import { readdirSync, readFileSync } from "node:fs";

export interface LinuxProcFs {
  listPids(): readonly number[];
  readText(path: string): string | null;
}

const defaultLinuxProcFs: LinuxProcFs = {
  listPids(): readonly number[] {
    try {
      const pids: number[] = [];
      for (const entry of readdirSync("/proc")) {
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
  readText(filePath: string): string | null {
    try {
      return readFileSync(filePath, "utf8");
    } catch {
      // Processes may exit between directory listing and file read.
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

/** Identifies Chromium renderer processes from NUL-delimited Linux `/proc/<pid>/cmdline`. */
export function isChromiumRendererCmdline(cmdlineContent: string): boolean {
  if (!cmdlineContent) return false;
  return cmdlineContent.split("\0").includes("--type=renderer");
}

/** Parses resident memory (`VmRSS`) in bytes from Linux `/proc/<pid>/status`. */
export function parseProcStatusVmRssBytes(statusContent: string): number | null {
  const match = /^VmRSS:\s+(\d+)\s*(?:kB)?\b/mu.exec(statusContent);
  if (!match?.[1]) return null;
  const kilobytes = Number(match[1]);
  if (!Number.isSafeInteger(kilobytes) || kilobytes <= 0) return null;
  return kilobytes * 1024;
}

/**
 * Counts and sums resident memory (`VmRSS`) of Chromium renderer descendants of
 * the given browser root PIDs using Linux `/proc`. Returns `bytes: null` when a
 * live renderer's status could not be parsed so callers fall back safely.
 */
export function collectLinuxRendererUsage(
  rootPids: Iterable<number>,
  proc: LinuxProcFs = defaultLinuxProcFs,
): BrowserRendererUsage {
  const roots = new Set<number>();
  for (const pid of rootPids) {
    if (Number.isSafeInteger(pid) && pid > 0) roots.add(pid);
  }
  if (roots.size === 0) return { processes: 0, bytes: 0 };

  const allPids = proc.listPids();
  if (allPids.length === 0) return { processes: 0, bytes: null };

  const childrenByPpid = new Map<number, number[]>();
  for (const pid of allPids) {
    const stat = proc.readText(`/proc/${pid}/stat`);
    if (stat === null) continue;
    const ppid = parseProcStatPpid(stat);
    if (ppid === null) continue;
    let children = childrenByPpid.get(ppid);
    if (!children) {
      children = [];
      childrenByPpid.set(ppid, children);
    }
    children.push(pid);
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

  let processes = 0;
  let totalBytes = 0;
  let allMeasured = true;

  for (const pid of descendants) {
    const cmdline = proc.readText(`/proc/${pid}/cmdline`);
    if (cmdline === null || !isChromiumRendererCmdline(cmdline)) continue;
    const status = proc.readText(`/proc/${pid}/status`);
    if (status === null) {
      // Renderer exited between cmdline and status reads.
      continue;
    }
    processes++;
    const rssBytes = parseProcStatusVmRssBytes(status);
    if (rssBytes === null) {
      allMeasured = false;
    } else {
      totalBytes += rssBytes;
    }
  }

  return {
    processes,
    bytes: processes === 0 ? 0 : allMeasured ? totalBytes : null,
  };
}
