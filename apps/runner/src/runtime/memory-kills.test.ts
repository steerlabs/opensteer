import { expect, it } from "vitest";
import { cgroupMemoryKills } from "./memory-kills.js";

/** A file system holding these files only. */
const files =
  (contents: Record<string, string>) =>
  (path: string): string => {
    const content = contents[path];
    if (content === undefined) throw Object.assign(new Error(path), { code: "ENOENT" });
    return content;
  };

const events = (kills: number) =>
  `low 0\nhigh 0\nmax 12\noom 3\noom_kill ${kills}\noom_group_kill 0\n`;

it("lets a Run claim each kill counted since it started once, and none counted before", () => {
  const disk: Record<string, string> = {
    "/proc/self/cgroup": "0::/\n",
    "/sys/fs/cgroup/memory.events": events(2),
  };
  const kills = cgroupMemoryKills(files(disk));
  const first = kills?.mark();
  // A tool's kill before the second Run started is no engine of that Run's.
  disk["/sys/fs/cgroup/memory.events"] = events(3);
  const second = kills?.mark();
  expect(kills?.claimKill(second)).toBe(false);
  // Two engines killed after both Runs started: each Run gets one, and no third.
  disk["/sys/fs/cgroup/memory.events"] = events(5);
  expect(kills?.claimKill(second)).toBe(true);
  expect(kills?.claimKill(second)).toBe(true);
  expect(kills?.claimKill(second)).toBe(false);
  // The first Run still claims the kill counted before the second began.
  expect(kills?.claimKill(first)).toBe(true);
  expect(kills?.claimKill(first)).toBe(false);
  // A Run that could not read the count at its start claims nothing.
  expect(kills?.claimKill(undefined)).toBe(false);
});

it("never lets a Run claim a kill counted before it started, though none was claimed", () => {
  const disk: Record<string, string> = {
    "/proc/self/cgroup": "0::/\n",
    "/sys/fs/cgroup/memory.events": events(0),
  };
  const kills = cgroupMemoryKills(files(disk));
  disk["/sys/fs/cgroup/memory.events"] = events(1);
  const since = kills?.mark();
  expect(kills?.claimKill(since)).toBe(false);
});

it("reads the cgroup the process is in when it is not a container's own namespace", () => {
  const disk = {
    "/proc/self/cgroup": "0::/system.slice/opensteer-runner.service\n",
    "/sys/fs/cgroup/system.slice/opensteer-runner.service/memory.events": events(0),
  };
  const kills = cgroupMemoryKills(files(disk));
  expect(kills?.claimKill(kills.mark())).toBe(false);
});

it("invents no reason where there is no cgroup v2 memory count: a Mac, cgroup v1, no controller", () => {
  expect(cgroupMemoryKills(files({}))).toBeUndefined();
  expect(
    cgroupMemoryKills(files({ "/proc/self/cgroup": "12:memory:/docker/abc\n1:cpu:/\n" })),
  ).toBeUndefined();
  expect(cgroupMemoryKills(files({ "/proc/self/cgroup": "0::/\n" }))).toBeUndefined();
  expect(cgroupMemoryKills(files({ "/proc/self/cgroup": "0::/../etc\n" }))).toBeUndefined();
});
