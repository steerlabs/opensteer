import { expect, it, vi } from "vitest";
import { ExecutionContainment } from "./execution-containment.js";

it("reaps a stopped boot's preparation and Runs without signalling its replacement", async () => {
  const directory = "/fixture/two-boots";
  const old = new ExecutionContainment({ bootId: "old", dataDirectory: directory });
  const replacement = new ExecutionContainment({ bootId: "replacement", dataDirectory: directory });
  const foreign = new ExecutionContainment({ bootId: "old", dataDirectory: "/another/fixture" });
  let processes = [
    { identity: "old-preparation", pid: 2_147_483_640, ppid: 1, scope: old.scope("preparation") },
    { identity: "old-run", pid: 2_147_483_641, ppid: 1, scope: old.scope("execution") },
    {
      identity: "replacement",
      pid: 2_147_483_642,
      ppid: 1,
      scope: replacement.scope("preparation"),
    },
    { identity: "foreign", pid: 2_147_483_643, ppid: 1, scope: foreign.scope("preparation") },
  ];
  const signalled: number[] = [];
  const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
    signalled.push(pid);
    processes = processes.filter((entry) => entry.pid !== pid);
    return true;
  });
  try {
    const reaper = new ExecutionContainment({
      bootId: "old",
      dataDirectory: directory,
      listProcesses: async () => processes,
    });
    await expect(reaper.reapBoot()).resolves.toBe("proven");
    expect(signalled.toSorted((a, b) => a - b)).toEqual([2_147_483_640, 2_147_483_641]);
    expect(processes.map(({ identity }) => identity)).toEqual(["replacement", "foreign"]);
  } finally {
    kill.mockRestore();
  }
});
