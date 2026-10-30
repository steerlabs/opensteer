import { spawnSync } from "node:child_process";
import { writeFileSync, existsSync, statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const [app, version, out] = process.argv.slice(2) as [string, string, string];
if (!existsSync("/Volumes/My Shared Files/inputs")) throw new Error("Guest only");
const processes = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout.split(
  "\n",
);
const children = processes.flatMap((line) => {
  const m = /^\s*(\d+)\s+(.*)$/u.exec(line);
  return m && m[2]!.includes(`${app}/Contents/Resources/`)
    ? [{ pid: Number(m[1]), command: m[2] }]
    : [];
});
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const started = Date.now();
let result: Record<string, unknown> = { passed: false, children, reason: "No swap observed" };
while (Date.now() - started < 180_000) {
  const plist = spawnSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleShortVersionString", `${app}/Contents/Info.plist`],
    { encoding: "utf8" },
  );
  if (plist.stdout.trim() === version) {
    const live = children.filter((x) => alive(x.pid));
    result = {
      passed: children.length > 0 && live.length === 0,
      children,
      live,
      swapObservedAt: Date.now(),
      swapInode: statSync(app).ino,
      seconds: (Date.now() - started) / 1000,
    };
    break;
  }
  await delay(25);
}
writeFileSync(out, JSON.stringify(result, null, 2));
