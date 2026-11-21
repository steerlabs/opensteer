/**
 * Drives `electron-menu-bar-smoke.ts` through its trials, each in a fresh,
 * ad-hoc signed copy of Electron with its own bundle id and data directory,
 * and writes `menu-bar.json`. Run only in a disposable VM: it opens windows,
 * a status item and a sheet, and changes the Dock.
 *
 *   pnpm test:electron-menu-bar:run [trial ...]
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { desktopShutdownTimeoutMs } from "../src/app/desktop-shutdown.js";
import { menuBarSmokeTrialPlan, type MenuBarTrialOutcome } from "./menu-bar-smoke-plan.js";

const directory = path.resolve(
  process.env.OPENSTEER_MENU_BAR_E2E_ARTIFACT_DIR ?? "/tmp/opensteer-menu-bar-smoke",
);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const root = realpathSync(mkdtempSync(path.join(directory, "menu-bar-")));
const requested = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
const plan = menuBarSmokeTrialPlan(requested);

const sourceResources = process.env.OPENSTEER_PERSONAL_E2E_RESOURCES;
const resources = path.join(root, "resources");
if (plan.some((trial) => trial.needsHome)) {
  assert(sourceResources, "home-stop needs OPENSTEER_PERSONAL_E2E_RESOURCES");
  mkdirSync(resources, { mode: 0o700 });
  for (const name of ["personal-runtime", "process-supervisor"])
    execFileSync("cp", ["-cR", path.join(sourceResources, name), resources]);
  execFileSync("cp", [
    "-R",
    path.resolve(import.meta.dirname, "../../../packages/harness-codex/src/test-fixtures"),
    path.join(resources, "codex-fixture"),
  ]);
}

const require = createRequire(import.meta.url);
const electron = z.string().parse(require("electron"));
const bundle = path.join(root, "Opensteer Menu Bar Smoke.app");
execFileSync("cp", ["-cR", path.resolve(electron, "../../.."), bundle]);
const plist = path.join(bundle, "Contents", "Info.plist");
// A unique bundle id and absolute bundle can never address an installed Opensteer.
for (const command of [
  `Set :CFBundleIdentifier dev.opensteer.menu-bar-smoke.${process.pid}`,
  "Set :CFBundleName OpensteerMenuBarSmoke",
  "Add :LSUIElement bool true",
])
  execFileSync("/usr/libexec/PlistBuddy", ["-c", command, plist]);
const appDirectory = path.join(bundle, "Contents", "Resources", "app");
mkdirSync(appDirectory, { recursive: true });
writeFileSync(
  path.join(appDirectory, "package.json"),
  JSON.stringify({ name: "opensteer-menu-bar-smoke", version: "1.0.0", main: "bootstrap.cjs" }),
);
writeFileSync(
  path.join(appDirectory, "bootstrap.cjs"),
  `const {app}=require('electron'); import(${JSON.stringify(path.resolve(import.meta.dirname, "../.electron-smoke/electron-menu-bar-smoke.js"))}).catch(e=>{process.stderr.write(String(e.stack)+'\\n'); app.exit(2)});`,
);
execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundle]);
const executable = path.join(bundle, "Contents", "MacOS", path.basename(electron));

const Rows = z.array(z.object({ event: z.string() }).catchall(z.unknown()));
const rows = (data: string, trial: string) => {
  const file = path.join(data, `${trial}.jsonl`);
  if (!existsSync(file)) return [];
  return Rows.parse(
    readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  );
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const descendants = (pid: number) => {
  const all = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)/u.exec(line);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]) }] : [];
    });
  const owned = new Set([pid]);
  for (let pass = 0; pass < all.length; pass += 1) {
    let changed = false;
    for (const entry of all)
      if (owned.has(entry.ppid) && !owned.has(entry.pid)) {
        owned.add(entry.pid);
        changed = true;
      }
    if (!changed) break;
  }
  return [...owned];
};
const capture = (file: string) => {
  try {
    execFileSync("screencapture", ["-x", file], { timeout: 10_000 });
  } catch {
    // Evidence only: a capture the guest refuses changes no outcome.
  }
};

const results: {
  trial: string;
  outcome: MenuBarTrialOutcome;
  claims: string[];
  seconds: number;
  exitCode: number | null;
  error?: string;
}[] = [];

for (const { trial, needsHome, drive } of plan) {
  const started = performance.now();
  const data = path.join(root, trial);
  mkdirSync(data, { mode: 0o700 });
  const output = path.join(data, "output.log");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    OPENSTEER_MENU_BAR_E2E_DATA: data,
    OPENSTEER_MENU_BAR_E2E_TRIAL: trial,
    ...(needsHome ? { OPENSTEER_PERSONAL_E2E_RESOURCES: resources } : {}),
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk: Buffer) => appendFileSync(output, chunk));
  child.stderr.on("data", (chunk: Buffer) => appendFileSync(output, chunk));
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  assert(child.pid);
  const pid = child.pid;
  const events = () => rows(data, trial);
  const waitForEvent = async (event: string, timeoutMs = 120_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!events().some((row) => row.event === event)) {
      const failed = events().find((row) => row.event === "test.failed");
      assert(!failed, JSON.stringify(failed));
      assert(alive(pid), `${trial} exited before ${event}; see ${output}`);
      assert(Date.now() < deadline, `${trial} never reached ${event}`);
      await delay(50);
    }
  };
  let exitCode: number | null = null;
  let error: string | undefined;
  let tree: number[] = [];
  try {
    switch (drive) {
      case "self":
        break;
      case "quit-during-startup":
        await waitForEvent("test.starting");
        child.kill("SIGUSR1");
        break;
      case "quit-question": {
        await waitForEvent("test.ready");
        tree = descendants(pid);
        child.kill("SIGUSR1");
        await waitForEvent("test.question-shown", 30_000);
        await delay(500);
        capture(path.join(data, "question.png"));
        child.kill(trial === "quit-logout" ? "SIGUSR2" : "SIGTERM");
        break;
      }
    }
    exitCode = await withTimeout(
      exited,
      drive === "self" ? 300_000 : desktopShutdownTimeoutMs + 5_000,
      {
        timeoutError: () => new Error(`${trial} did not end in time`),
      },
    );
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
    for (const owned of descendants(pid).reverse())
      if (alive(owned)) process.kill(owned, "SIGKILL");
    exitCode = await exited;
  }
  const seen = events();
  const claims = seen.flatMap((row) => (row.event === "test.held" ? [String(row.claim)] : []));
  const survivors = tree.filter((owned) => owned !== pid && alive(owned));
  const failed = seen.find((row) => row.event === "test.failed" || row.event === "test.modal");
  let outcome: MenuBarTrialOutcome =
    error || failed || exitCode !== 0 || survivors.length > 0 ? "fail" : "pass";
  if (drive === "self" || drive === "quit-during-startup") {
    if (seen.some((row) => row.event === "test.unverified")) outcome = "unverified";
    else if (!seen.some((row) => row.event === "test.passed")) outcome = "fail";
  }
  if (drive === "quit-question") {
    if (!seen.some((row) => row.event === "desktop.shutdown.started")) outcome = "fail";
    if (seen.some((row) => row.event === "test.quit-confirmed")) outcome = "fail";
  }
  results.push({
    trial,
    outcome,
    claims,
    seconds: (performance.now() - started) / 1000,
    exitCode,
    ...(error || failed || survivors.length
      ? { error: error ?? JSON.stringify(failed ?? { survivors }) }
      : {}),
  });
  writeFileSync(
    path.join(directory, "menu-bar.json"),
    JSON.stringify(
      {
        root,
        sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        command: "pnpm test:electron-menu-bar:run",
        results,
      },
      null,
      2,
    ),
  );
  process.stdout.write(`${JSON.stringify({ event: "menu-bar.trial", trial, outcome })}\n`);
}
process.exitCode = results.some((row) => row.outcome === "fail") ? 1 : 0;
