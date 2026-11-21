import { describe, expect, it } from "vitest";
import {
  collectLinuxRendererUsage,
  isChromiumRendererCmdline,
  parseProcSmapsRollupPssBytes,
  parseProcStatPpid,
  parseProcStatusRssAnonBytes,
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
    listPids: async () => discovered,
    readText: async (filePath) => files[filePath] ?? null,
  };
}

describe("linux-renderer-usage", () => {
  it("parses ppid from /proc/<pid>/stat including comm names with spaces and parentheses", () => {
    expect(parseProcStatPpid("101 (chrome) S 100 100 100 0 -1 4194304")).toBe(100);
    expect(parseProcStatPpid("202 (chrome (renderer) v1) S 150 100 100 0")).toBe(150);
    expect(parseProcStatPpid("malformed")).toBeNull();
    expect(parseProcStatPpid("303 (chrome) S")).toBeNull();
  });

  it("matches Chromium page renderers from NUL and zygote space-delimited cmdlines while excluding extension processes", () => {
    expect(isChromiumRendererCmdline("/opt/chrome\0--type=renderer\0--lang=en-US\0")).toBe(true);
    expect(
      isChromiumRendererCmdline(
        "/ms-playwright/chromium-1234/chrome-linux64/chrome --type=renderer --crashpad-handler-pid=20 --noerrdialogs",
      ),
    ).toBe(true);
    expect(isChromiumRendererCmdline("/opt/chrome\0--type=renderer\0--extension-process\0")).toBe(
      false,
    );
    expect(
      isChromiumRendererCmdline(
        "/ms-playwright/chromium-1234/chrome-linux64/chrome --type=renderer --extension-process --lang=en",
      ),
    ).toBe(false);
    expect(isChromiumRendererCmdline("/opt/chrome\0--type=gpu-process\0")).toBe(false);
    expect(isChromiumRendererCmdline("/opt/chrome --type=zygote --no-zygote-sandbox")).toBe(false);
    expect(isChromiumRendererCmdline("/opt/chrome\0--type=renderer-other\0")).toBe(false);
    expect(isChromiumRendererCmdline("/opt/chrome --type=renderer-other --lang=en")).toBe(false);
    expect(isChromiumRendererCmdline("")).toBe(false);
  });

  it("parses Pss from smaps_rollup and RssAnon from status (never VmRSS)", () => {
    expect(
      parseProcSmapsRollupPssBytes("Rss:            131072 kB\nPss:             42000 kB\n"),
    ).toBe(42000 * 1024);
    expect(parseProcSmapsRollupPssBytes("Pss: 0 kB\n")).toBeNull();
    expect(
      parseProcStatusRssAnonBytes("Name:\tchrome\nVmRSS:\t131072 kB\nRssAnon:\t35000 kB\n"),
    ).toBe(35000 * 1024);
    expect(parseProcStatusRssAnonBytes("Name:\tchrome\nVmRSS:\t131072 kB\n")).toBeNull();
  });

  it("counts and sums Pss (with RssAnon fallback) of owned page renderers only", async () => {
    const proc = fakeProc({
      // Owned browser root (1000) -> zygote (1001) -> two page renderers (1002, 1003) + extension renderer (1005) + gpu (1004)
      "/proc/1000/stat": "1000 (chrome) S 1 1000 1000",
      "/proc/1000/cmdline": "/opt/chrome\0--user-data-dir=/tmp/a\0",
      "/proc/1001/stat": "1001 (chrome) S 1000 1000 1000",
      "/proc/1001/cmdline": "/opt/chrome\0--type=zygote\0",
      // 1002 has smaps_rollup Pss (preferred over VmRSS and RssAnon)
      "/proc/1002/stat": "1002 (chrome) S 1001 1000 1000",
      "/proc/1002/cmdline": "/opt/chrome\0--type=renderer\0--field-trial-handle=1\0",
      "/proc/1002/smaps_rollup": "Rss: 150000 kB\nPss: 40000 kB\n",
      "/proc/1002/status": "Name:\tchrome\nVmRSS:\t150000 kB\nRssAnon:\t50000 kB\n",
      // 1003 lacks smaps_rollup -> falls back to RssAnon (never VmRSS)
      "/proc/1003/stat": "1003 (chrome) S 1001 1000 1000",
      "/proc/1003/cmdline": "/opt/chrome\0--type=renderer\0",
      "/proc/1003/status": "Name:\tchrome\nVmRSS:\t200000 kB\nRssAnon:\t60000 kB\n",
      // 1005 is an extension renderer -> excluded
      "/proc/1005/stat": "1005 (chrome) S 1001 1000 1000",
      "/proc/1005/cmdline": "/opt/chrome\0--type=renderer\0--extension-process\0",
      "/proc/1005/smaps_rollup": "Pss: 25000 kB\n",
      // 1004 is gpu -> excluded
      "/proc/1004/stat": "1004 (chrome) S 1000 1000 1000",
      "/proc/1004/cmdline": "/opt/chrome\0--type=gpu-process\0",
      "/proc/1004/smaps_rollup": "Pss: 99999 kB\n",
      // Unrelated browser (2000) -> renderer (2001) must be excluded
      "/proc/2000/stat": "2000 (chrome) S 1 2000 2000",
      "/proc/2001/stat": "2001 (chrome) S 2000 2000 2000",
      "/proc/2001/cmdline": "/opt/chrome\0--type=renderer\0",
      "/proc/2001/smaps_rollup": "Pss: 88888 kB\n",
    });

    await expect(collectLinuxRendererUsage([1000], proc)).resolves.toEqual({
      processes: 2,
      bytes: (40000 + 60000) * 1024,
    });
  });

  it("ignores renderers that exit mid-census and returns null bytes when neither Pss nor RssAnon is present", async () => {
    const proc = fakeProc({
      "/proc/1000/stat": "1000 (chrome) S 1 1000 1000",
      // 1001 has cmdline but both smaps_rollup and status disappeared (exited mid-census)
      "/proc/1001/stat": "1001 (chrome) S 1000 1000 1000",
      "/proc/1001/cmdline": "/opt/chrome\0--type=renderer\0",
      // 1002 has status with VmRSS only (no Pss, no RssAnon) -> returns bytes: null (never falls back to VmRSS)
      "/proc/1002/stat": "1002 (chrome) S 1000 1000 1000",
      "/proc/1002/cmdline": "/opt/chrome\0--type=renderer\0",
      "/proc/1002/status": "Name:\tchrome\nVmRSS:\t90000 kB\n",
    });

    await expect(collectLinuxRendererUsage([1000], proc)).resolves.toEqual({
      processes: 1,
      bytes: null,
    });
  });

  it("returns zero usage when no browser roots are owned and null bytes when /proc is unreadable", async () => {
    await expect(collectLinuxRendererUsage([], fakeProc({}))).resolves.toEqual({
      processes: 0,
      bytes: 0,
    });
    await expect(collectLinuxRendererUsage([1000], fakeProc({}, []))).resolves.toEqual({
      processes: 0,
      bytes: null,
    });
  });
});
