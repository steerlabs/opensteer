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

it("sees a kill for memory in the Runner's own cgroup since it last looked, once", () => {
  const disk: Record<string, string> = {
    "/proc/self/cgroup": "0::/\n",
    "/sys/fs/cgroup/memory.events": events(2),
  };
  const kills = cgroupMemoryKills(files(disk));
  expect(kills?.killedSinceLastLook()).toBe(false);
  disk["/sys/fs/cgroup/memory.events"] = events(3);
  expect(kills?.killedSinceLastLook()).toBe(true);
  expect(kills?.killedSinceLastLook()).toBe(false);
});

it("reads the cgroup the process is in when it is not a container's own namespace", () => {
  const disk = {
    "/proc/self/cgroup": "0::/system.slice/opensteer-runner.service\n",
    "/sys/fs/cgroup/system.slice/opensteer-runner.service/memory.events": events(0),
  };
  expect(cgroupMemoryKills(files(disk))?.killedSinceLastLook()).toBe(false);
});

it("invents no reason where there is no cgroup v2 memory count: a Mac, cgroup v1, no controller", () => {
  expect(cgroupMemoryKills(files({}))).toBeUndefined();
  expect(
    cgroupMemoryKills(files({ "/proc/self/cgroup": "12:memory:/docker/abc\n1:cpu:/\n" })),
  ).toBeUndefined();
  expect(cgroupMemoryKills(files({ "/proc/self/cgroup": "0::/\n" }))).toBeUndefined();
  expect(cgroupMemoryKills(files({ "/proc/self/cgroup": "0::/../etc\n" }))).toBeUndefined();
});
