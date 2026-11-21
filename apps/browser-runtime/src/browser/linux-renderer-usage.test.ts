import { describe, expect, it } from "vitest";
import {
  collectLinuxRendererUsage,
  isChromiumRendererCmdline,
  parseProcStatPpid,
  parseProcStatusVmRssBytes,
  type LinuxProcFs,
} from "./linux-renderer-usage.js";

function fakeProc(files: Record<string, string>, pids?: readonly number[]): LinuxProcFs {
  const discovered = pids ?? [
    ...new Set(
      Object.keys(files)
        .map((filePath) => /^\/proc\/(\d+)\//u.exec(filePath)?.[1])
        .filter((value): value is string => value !== undefined)
        .map(Number),
    ),
  ];
  return {
    listPids: () => discovered,
    readText: (filePath) => files[filePath] ?? null,
  };
}

describe("linux-renderer-usage", () => {
  it("parses ppid from /proc/<pid>/stat including comm names with spaces and parentheses", () => {
    expect(parseProcStatPpid("101 (chrome) S 100 100 100 0 -1 4194304")).toBe(100);
    expect(parseProcStatPpid("202 (chrome (renderer) v1) S 150 100 100 0")).toBe(150);
    expect(parseProcStatPpid("malformed")).toBeNull();
    expect(parseProcStatPpid("303 (chrome) S")).toBeNull();
  });

  it("matches Chromium renderer processes from NUL-delimited cmdline only", () => {
    expect(isChromiumRendererCmdline("/opt/chrome\0--type=renderer\0--lang=en-US\0")).toBe(true);
    expect(isChromiumRendererCmdline("/opt/chrome\0--type=gpu-process\0")).toBe(false);
    expect(isChromiumRendererCmdline("/opt/chrome\0--type=renderer-other\0")).toBe(false);
    expect(isChromiumRendererCmdline("")).toBe(false);
  });

  it("parses VmRSS bytes from /proc/<pid>/status", () => {
    expect(
      parseProcStatusVmRssBytes("Name:\tchrome\nVmSize:\t900000 kB\nVmRSS:\t131072 kB\n"),
    ).toBe(131072 * 1024);
    expect(parseProcStatusVmRssBytes("Name:\tchrome\nVmRSS:\t0 kB\n")).toBeNull();
    expect(parseProcStatusVmRssBytes("Name:\tchrome\n")).toBeNull();
  });

  it("counts and sums only renderer descendants of owned browser roots", () => {
    const proc = fakeProc({
      // Owned browser root (1000) -> zygote (1001) -> two renderers (1002, 1003) + gpu (1004)
      "/proc/1000/stat": "1000 (chrome) S 1 1000 1000",
      "/proc/1000/cmdline": "/opt/chrome\0--user-data-dir=/tmp/a\0",
      "/proc/1001/stat": "1001 (chrome) S 1000 1000 1000",
      "/proc/1001/cmdline": "/opt/chrome\0--type=zygote\0",
      "/proc/1002/stat": "1002 (chrome) S 1001 1000 1000",
      "/proc/1002/cmdline": "/opt/chrome\0--type=renderer\0--field-trial-handle=1\0",
      "/proc/1002/status": "Name:\tchrome\nVmRSS:\t50000 kB\n",
      "/proc/1003/stat": "1003 (chrome) S 1001 1000 1000",
      "/proc/1003/cmdline": "/opt/chrome\0--type=renderer\0",
      "/proc/1003/status": "Name:\tchrome\nVmRSS:\t75000 kB\n",
      "/proc/1004/stat": "1004 (chrome) S 1000 1000 1000",
      "/proc/1004/cmdline": "/opt/chrome\0--type=gpu-process\0",
      "/proc/1004/status": "Name:\tchrome\nVmRSS:\t99999 kB\n",
      // Unrelated browser (2000) -> renderer (2001) must be excluded
      "/proc/2000/stat": "2000 (chrome) S 1 2000 2000",
      "/proc/2001/stat": "2001 (chrome) S 2000 2000 2000",
      "/proc/2001/cmdline": "/opt/chrome\0--type=renderer\0",
      "/proc/2001/status": "Name:\tchrome\nVmRSS:\t88888 kB\n",
    });

    expect(collectLinuxRendererUsage([1000], proc)).toEqual({
      processes: 2,
      bytes: (50000 + 75000) * 1024,
    });
  });

  it("ignores renderers that exit mid-census and returns null bytes when VmRSS is missing", () => {
    const proc = fakeProc({
      "/proc/1000/stat": "1000 (chrome) S 1 1000 1000",
      // 1001 has cmdline but status disappeared (process exited mid-census)
      "/proc/1001/stat": "1001 (chrome) S 1000 1000 1000",
      "/proc/1001/cmdline": "/opt/chrome\0--type=renderer\0",
      // 1002 has status without VmRSS
      "/proc/1002/stat": "1002 (chrome) S 1000 1000 1000",
      "/proc/1002/cmdline": "/opt/chrome\0--type=renderer\0",
      "/proc/1002/status": "Name:\tchrome\nState:\tZ (zombie)\n",
    });

    expect(collectLinuxRendererUsage([1000], proc)).toEqual({
      processes: 1,
      bytes: null,
    });
  });

  it("returns zero usage when no browser roots are owned and null bytes when /proc is unreadable", () => {
    expect(collectLinuxRendererUsage([], fakeProc({}))).toEqual({ processes: 0, bytes: 0 });
    expect(collectLinuxRendererUsage([1000], fakeProc({}, []))).toEqual({
      processes: 0,
      bytes: null,
    });
  });
});
