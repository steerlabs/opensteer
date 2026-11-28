import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { firstToGoUnderMemoryPressure, memoryKills } from "./memory-pressure.js";

it.skipIf(process.platform !== "linux")(
  "makes a child the OOM killer's first choice, and leaves the Host's own score alone",
  async () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const own = readFileSync("/proc/self/oom_score_adj", "utf8").trim();
      expect(firstToGoUnderMemoryPressure(child.pid)).toBe(true);
      expect(readFileSync(`/proc/${child.pid}/oom_score_adj`, "utf8").trim()).toBe("1000");
      expect(readFileSync("/proc/self/oom_score_adj", "utf8").trim()).toBe(own);
    } finally {
      child.kill("SIGKILL");
    }
  },
);

it("does nothing off Linux, or without a process", () => {
  expect(firstToGoUnderMemoryPressure(123, "darwin")).toBe(false);
  expect(firstToGoUnderMemoryPressure(undefined, "linux")).toBe(false);
});

it("reads the kernel's count of memory kills in this cgroup, and nothing it cannot read", () => {
  const directory = mkdtempSync(join(tmpdir(), "opensteer-memory-events-"));
  try {
    const events = join(directory, "memory.events");
    writeFileSync(events, "low 0\nhigh 0\nmax 14765\noom 6\noom_kill 4\noom_group_kill 0\n");
    expect(memoryKills(events, "linux")).toBe(4);
    expect(memoryKills(events, "darwin")).toBe(undefined);
    expect(memoryKills(join(directory, "missing"), "linux")).toBe(undefined);
    writeFileSync(events, "max 1\n");
    expect(memoryKills(events, "linux")).toBe(undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
