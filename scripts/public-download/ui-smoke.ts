import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const out = process.argv[2]!;
assert(existsSync("/Volumes/My Shared Files/inputs"), "Guest only");
const driver = path.join(out, "ax-driver");
const run = (exe: string, args: string[]) => {
  const r = spawnSync(exe, args, { encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
};
if (!existsSync(driver))
  run("swiftc", [path.join(import.meta.dirname, "ax-driver.swift"), "-o", driver]);
const ax = (...args: string[]) => run(driver, args);
const dump = () => {
  const state = ax("dump");
  writeFileSync(path.join(out, "ui-current.json"), state);
  return state;
};
const wait = async (name: string, predicate: () => boolean, seconds = 120) => {
  const start = Date.now();
  while (Date.now() - start < seconds * 1000) {
    if (predicate()) return;
    await delay(1000);
  }
  throw new Error(`UI timeout: ${name}`);
};
const capture = (name: string) => {
  const window = JSON.parse(ax("window"));
  run("/usr/sbin/screencapture", ["-x", "-l", String(window.id), path.join(out, `${name}.png`)]);
};
const click = (label: string) => ax("click", label);
await wait("first window", () => {
  try {
    return dump().includes("AXWindow");
  } catch {
    return false;
  }
});
await wait("startup choice or workspace", () => {
  const state = dump();
  return state.includes("Set up this ") || state.includes("Places and menu");
});
const state = dump();
writeFileSync(path.join(out, "ui-before.json"), state);
if (state.includes("Set up this ")) {
  click("Set up this ");
  // Setup ends on Start once an AI is ready; a fresh machine without one
  // leaves through "Set up later". Either way the workspace opens next.
  await wait("setup finished", () => {
    const setup = dump();
    if (setup.includes("Set up later")) return true;
    return (
      setup.includes("Start") &&
      !setup.includes("Setting up") &&
      !setup.includes("Opening Opensteer")
    );
  });
  click(dump().includes("Set up later") ? "Set up later" : "Start");
}
await wait("local workspace", () => /Connected\. Places and menu/u.test(dump()));
capture("personal-ready");
writeFileSync(
  path.join(out, "ui-smoke.json"),
  JSON.stringify({ passed: true, input: "macOS Accessibility" }, null, 2),
);
