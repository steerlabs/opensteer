import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, existsSync, statSync, renameSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { shutdownEvidence } from "./evidence.js";
const [app, , out] = process.argv.slice(2) as [string, string, string];
if (!existsSync("/Volumes/My Shared Files/inputs")) throw new Error("Guest only");
const rows = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
  .stdout.split("\n")
  .flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    return m ? [{ pid: Number(m[1]), parent: Number(m[2]), command: m[3]! }] : [];
  });
const supervisors = rows.filter((p) =>
  p.command.startsWith(`${app}/Contents/Resources/process-supervisor/`),
);
for (const role of [
  "postgres/bin/postgres",
  "bin/opensteer-host",
  "bin/opensteer-runner",
  "bin/opensteer-channel-runtime",
])
  assert(
    supervisors.some((p) => p.command.includes(`/personal-runtime/${role}`)),
    `Missing supervised ${role}`,
  );
const pids = new Set(supervisors.map((p) => p.pid));
for (let previous = -1; previous !== pids.size;) {
  previous = pids.size;
  for (const p of rows) if (pids.has(p.parent)) pids.add(p.pid);
}
const inventory = rows.filter((p) => pids.has(p.pid));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const original = statSync(app).ino;
const unchanged = () => {
  try {
    return statSync(app).ino === original;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};
const exits: { pid: number; exitedAt: number; oldBundleObservedAt: number }[] = [];
const started = Date.now();
writeFileSync(`${out}.ready.tmp`, JSON.stringify({ ready: true, inventory, original, started }));
renameSync(`${out}.ready.tmp`, `${out}.ready.json`);
let result: Record<string, unknown> = {
  passed: false,
  inventory,
  exits,
  reason: "No swap observed",
};
while (Date.now() - started < 180_000) {
  if (!unchanged()) {
    const evidence = { inventory, exits, swapObservedAt: Date.now() };
    const parsed = shutdownEvidence.safeParse(evidence);
    result = {
      ...evidence,
      passed: parsed.success,
      error: parsed.success ? undefined : parsed.error.message,
    };
    break;
  }
  for (const p of inventory) {
    if (exits.some((e) => e.pid === p.pid) || alive(p.pid)) continue;
    const exitedAt = Date.now();
    // The original inode still present AFTER an observed exit bounds that exit before swap.
    if (unchanged()) exits.push({ pid: p.pid, exitedAt, oldBundleObservedAt: Date.now() });
  }
  await delay(10);
}
writeFileSync(out, JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
