import type { BrowserMemoryPressure, BrowserRendererUsage } from "@opensteer/browser-runtime-core";
import { readdir, readFile } from "node:fs/promises";

export type LinuxProcReadResult =
  | { readonly status: "ok"; readonly text: string }
  | { readonly status: "missing" }
  | { readonly status: "error" };

export interface LinuxProcFs {
  listPids(): Promise<readonly number[]> | readonly number[];
  readText(path: string): Promise<string | null> | string | null;
  readTextStatus?(path: string): Promise<LinuxProcReadResult> | LinuxProcReadResult;
}

const procReadConcurrency = 24;

async function readProcStatus(proc: LinuxProcFs, filePath: string): Promise<LinuxProcReadResult> {
  if (proc.readTextStatus) {
    try {
      return await proc.readTextStatus(filePath);
    } catch {
      return { status: "error" };
    }
  }
  try {
    const text = await proc.readText(filePath);
    return text === null ? { status: "missing" } : { status: "ok", text };
  } catch {
    return { status: "error" };
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = Array.from<R>({ length: items.length });
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
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
    const result = await this.readTextStatus!(filePath);
    return result.status === "ok" ? result.text : null;
  },
  async readTextStatus(filePath: string): Promise<LinuxProcReadResult> {
    try {
      return { status: "ok", text: await readFile(filePath, "utf8") };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "ENOENT" || code === "ESRCH") {
        return { status: "missing" };
      }
      return { status: "error" };
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

  let scanIncomplete = false;
  const statEntries = await mapWithConcurrency(allPids, procReadConcurrency, async (pid) => {
    const stat = await readProcStatus(proc, `/proc/${pid}/stat`);
    if (stat.status === "error") {
      scanIncomplete = true;
      return null;
    }
    if (stat.status === "missing") return null;
    return { pid, ppid: parseProcStatPpid(stat.text) };
  });

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

  const measurements = await mapWithConcurrency(
    descendants,
    procReadConcurrency,
    async (pid): Promise<number | null | "skip"> => {
      const cmdline = await readProcStatus(proc, `/proc/${pid}/cmdline`);
      if (cmdline.status === "error") {
        scanIncomplete = true;
        return "skip";
      }
      if (cmdline.status === "missing" || !isChromiumRendererCmdline(cmdline.text)) return "skip";
      const rollup = await readProcStatus(proc, `/proc/${pid}/smaps_rollup`);
      if (rollup.status === "ok") {
        const pssBytes = parseProcSmapsRollupPssBytes(rollup.text);
        if (pssBytes !== null) return pssBytes;
      }
      const status = await readProcStatus(proc, `/proc/${pid}/status`);
      if (status.status === "missing" && rollup.status === "missing") {
        // Renderer exited between cmdline and memory reads.
        return "skip";
      }
      if (status.status === "ok") {
        return parseProcStatusRssAnonBytes(status.text);
      }
      return null;
    },
  );

  let processes = 0;
  let totalBytes = 0;
  let allMeasured = !scanIncomplete;

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
    bytes: scanIncomplete ? null : processes === 0 ? 0 : allMeasured ? totalBytes : null,
  };
}

function parsePositiveIntegerBytes(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseNonNegativeIntegerBytes(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseCgroupStatFieldBytes(statContent: string, field: string): number | null {
  const match = new RegExp(`^${field}\\s+(\\d+)\\b`, "mu").exec(statContent);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function parseProcMeminfoBytes(
  meminfoContent: string,
): { readonly totalBytes: number; readonly availableBytes: number } | null {
  const totalMatch = /^MemTotal:\s+(\d+)\s*(?:kB)?\b/mu.exec(meminfoContent);
  const availMatch = /^MemAvailable:\s+(\d+)\s*(?:kB)?\b/mu.exec(meminfoContent);
  if (!totalMatch?.[1] || !availMatch?.[1]) return null;
  const totalKb = Number(totalMatch[1]);
  const availKb = Number(availMatch[1]);
  if (!Number.isSafeInteger(totalKb) || totalKb <= 0) return null;
  if (!Number.isSafeInteger(availKb) || availKb < 0) return null;
  return { totalBytes: totalKb * 1024, availableBytes: availKb * 1024 };
}

/**
 * Reads real Linux memory pressure asynchronously:
 * - Inside a memory-limited cgroup (v2 or v1): working set (`memory.current - inactive_file`)
 *   against the cgroup's memory limit.
 * - On bare Linux without a cgroup limit: `MemTotal - MemAvailable` from `/proc/meminfo`
 *   against `MemTotal`.
 * Returns `null` if the memory state cannot be read so callers fall back safely.
 */
export async function collectLinuxMemoryPressure(
  proc: LinuxProcFs = defaultLinuxProcFs,
): Promise<BrowserMemoryPressure | null> {
  // 1. Cgroup v2
  const maxRes = await readProcStatus(proc, "/sys/fs/cgroup/memory.max");
  if (maxRes.status === "error") return null;
  if (maxRes.status === "ok" && maxRes.text.trim() !== "max") {
    const limitBytes = parsePositiveIntegerBytes(maxRes.text);
    if (limitBytes === null) return null;
    const [currentRes, statRes] = await Promise.all([
      readProcStatus(proc, "/sys/fs/cgroup/memory.current"),
      readProcStatus(proc, "/sys/fs/cgroup/memory.stat"),
    ]);
    if (currentRes.status !== "ok" || statRes.status !== "ok") return null;
    const currentBytes = parseNonNegativeIntegerBytes(currentRes.text);
    if (currentBytes === null) return null;
    const inactiveFileBytes = parseCgroupStatFieldBytes(statRes.text, "inactive_file") ?? 0;
    return {
      usedBytes: Math.max(0, currentBytes - inactiveFileBytes),
      limitBytes,
    };
  }

  // 2. Cgroup v1 fallback when cgroup v2 files are absent
  if (maxRes.status === "missing") {
    const v1LimitRes = await readProcStatus(proc, "/sys/fs/cgroup/memory/memory.limit_in_bytes");
    if (v1LimitRes.status === "ok") {
      const limitBytes = parsePositiveIntegerBytes(v1LimitRes.text);
      // Cgroup v1 uses huge near-PAGE_SIZE-aligned sentinels (>= 1 PiB) for "unlimited".
      if (limitBytes !== null && limitBytes < 1024 ** 5) {
        const [usageRes, statRes] = await Promise.all([
          readProcStatus(proc, "/sys/fs/cgroup/memory/memory.usage_in_bytes"),
          readProcStatus(proc, "/sys/fs/cgroup/memory/memory.stat"),
        ]);
        if (usageRes.status !== "ok" || statRes.status !== "ok") return null;
        const usageBytes = parseNonNegativeIntegerBytes(usageRes.text);
        if (usageBytes === null) return null;
        const inactiveFileBytes =
          parseCgroupStatFieldBytes(statRes.text, "total_inactive_file") ??
          parseCgroupStatFieldBytes(statRes.text, "inactive_file") ??
          0;
        return {
          usedBytes: Math.max(0, usageBytes - inactiveFileBytes),
          limitBytes,
        };
      }
    }
  }

  // 3. Bare Linux host (no finite cgroup limit): /proc/meminfo
  const meminfoRes = await readProcStatus(proc, "/proc/meminfo");
  if (meminfoRes.status !== "ok") return null;
  const meminfo = parseProcMeminfoBytes(meminfoRes.text);
  if (!meminfo) return null;
  return {
    usedBytes: Math.max(0, meminfo.totalBytes - meminfo.availableBytes),
    limitBytes: meminfo.totalBytes,
  };
}
