import { createServer } from "node:http";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { readPersonalRuntimeRelease } from "../src/releases/personal-runtime-release.js";
import { readPersonalProcessSupervisorRelease } from "../src/supervisor/personal-process-port.js";
import { processSupervisorExecutableVariable } from "@opensteer/shared/processControl";
import { desktopShutdownTimeoutMs } from "../src/app/desktop-shutdown.js";

const restoreOnly = process.argv.includes("--tab-restore");
const fixtureStarted = performance.now();
const progress = (phase: string) =>
  process.stdout.write(
    `${JSON.stringify({
      event: "electron-quit.fixture",
      phase,
      seconds: (performance.now() - fixtureStarted) / 1000,
    })}\n`,
  );
const directory = path.resolve(
  process.env.OPENSTEER_QUIT_E2E_ARTIFACT_DIR ?? "/tmp/opensteer-quit-smoke",
);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const root = realpathSync(mkdtempSync(path.join(directory, "quit-")));
const sourceResources = z.string().min(1).parse(process.env.OPENSTEER_PERSONAL_E2E_RESOURCES);
const resources = path.join(root, "resources");
mkdirSync(resources, { mode: 0o700 });
for (const name of ["personal-runtime", "process-supervisor"]) {
  execFileSync("cp", ["-cR", path.join(sourceResources, name), resources]);
}
const require = createRequire(import.meta.url);
const electron = z.string().parse(require("electron"));
const bundle = path.join(root, "Opensteer Quit Smoke.app");
execFileSync("cp", ["-cR", path.resolve(electron, "../../.."), bundle]);
const plist = path.join(bundle, "Contents", "Info.plist");
const id = `dev.opensteer.quit-smoke.${process.pid}`;
for (const command of [
  `Set :CFBundleIdentifier ${id}`,
  "Set :CFBundleName OpensteerQuitSmoke",
  "Add :LSUIElement bool true",
]) {
  execFileSync("/usr/libexec/PlistBuddy", ["-c", command, plist]);
}
const appDirectory = path.join(bundle, "Contents", "Resources", "app");
mkdirSync(appDirectory, { recursive: true });
writeFileSync(
  path.join(appDirectory, "package.json"),
  JSON.stringify({ name: "opensteer-quit-smoke", version: "1.0.0", main: "bootstrap.cjs" }),
);
writeFileSync(
  path.join(appDirectory, "bootstrap.cjs"),
  `const {app,dialog}=require('electron'); dialog.showErrorBox=(...args)=>process.stderr.write('UNEXPECTED MODAL '+JSON.stringify(args)+'\\n'); import(${JSON.stringify(path.resolve(import.meta.dirname, "../.electron-smoke/electron-quit-smoke.js"))}).catch(e=>{process.stderr.write(String(e.stack)+'\\n'); app.exit(2)});`,
);
execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundle]);
const executable = path.join(bundle, "Contents", "MacOS", path.basename(electron));
progress("app-signed");
const data = path.join(root, "data");
mkdirSync(data, { mode: 0o700 });
const connectorResources = path.join(root, "connector-resources");
const connectorDirectory = path.join(connectorResources, "cloudflared");
const connectorBinary = path.join(connectorDirectory, "cloudflared");
// Restore trials return before connector setup; only shutdown containment uses it.
if (!restoreOnly) {
  mkdirSync(connectorDirectory, { recursive: true });
  execFileSync("cp", ["-cR", path.join(resources, "process-supervisor"), connectorResources]);
  execFileSync("go", [
    "build",
    "-o",
    connectorBinary,
    path.join(import.meta.dirname, "fixtures/quit-connector.go"),
  ]);
  writeFileSync(
    path.join(connectorDirectory, "release.json"),
    JSON.stringify({
      schemaVersion: 1,
      operatingSystem: process.platform,
      architecture: process.arch === "arm64" ? "arm64" : "amd64",
      version: "2026.10.0",
      binarySha256: createHash("sha256").update(readFileSync(connectorBinary)).digest("hex"),
    }),
  );
}
progress("fixture-ready");
const results: object[] = [];
const Rows = z.array(z.object({ event: z.string() }).catchall(z.unknown()));
const rows = (trial: string) => {
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
const processInventory = () =>
  execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }] : [];
    });
const processTree = (pid: number) => {
  const all = processInventory();
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
  return all.filter((entry) => owned.has(entry.pid));
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const appleQuit = () => {
  // A unique bundle ID and absolute bundle target cannot address installed Beta.
  try {
    const output = execFileSync(
      "osascript",
      ["-e", `tell application ${JSON.stringify(bundle)} to quit`],
      { encoding: "utf8", timeout: 5_000 },
    );
    return { code: 0, output };
  } catch (error) {
    const failure = z
      .object({
        status: z.number().nullable(),
        stderr: z.union([z.string(), z.instanceof(Buffer)]),
      })
      .parse(error);
    return { code: failure.status, output: String(failure.stderr) };
  }
};

async function verifyEngineOwner(): Promise<void> {
  const release = await readPersonalRuntimeRelease(path.join(resources, "personal-runtime"));
  const privateRoot = path.join(root, "engine-owner");
  mkdirSync(privateRoot, { mode: 0o700 });
  const parent = spawn(
    release.entrypoints.node,
    [path.resolve(import.meta.dirname, "../.electron-smoke/harness-owner-smoke.js")],
    {
      env: {
        HOME: privateRoot,
        PATH: "/usr/bin:/bin",
        [processSupervisorExecutableVariable]: readPersonalProcessSupervisorRelease(resources),
        OPENSTEER_OWNER_E2E_ROOT: privateRoot,
        OPENSTEER_OWNER_E2E_EXECUTABLE: release.harnesses.opencode,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert(parent.pid);
  let output = "";
  const ready = new Promise<void>((resolve, reject) => {
    parent.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("test.engine.ready")) resolve();
    });
    parent.once("error", reject);
    parent.once("exit", () => reject(new Error(`Engine owner exited before ready: ${output}`)));
  });
  parent.stderr.on("data", (chunk: Buffer) =>
    appendFileSync(path.join(root, "engine-owner.output.log"), chunk),
  );
  await Promise.race([
    ready,
    delay(45_000, undefined, { ref: false }).then(() => {
      throw new Error("Engine owner never became ready");
    }),
  ]);
  const before = processTree(parent.pid);
  assert(before.some(({ command }) => command.startsWith(release.harnesses.opencode)));
  writeFileSync(path.join(root, "engine-owner.before.json"), JSON.stringify(before, null, 2));
  const exited = new Promise<void>((resolve) => parent.once("exit", () => resolve()));
  parent.kill("SIGKILL");
  await exited;
  const deadline = Date.now() + 3_000;
  while (before.some(({ pid }) => alive(pid)) && Date.now() < deadline) await delay(25);
  const survivors = before.filter(({ pid }) => alive(pid));
  const escaped = processInventory().filter(({ command }) => command.startsWith(`${resources}/`));
  writeFileSync(
    path.join(root, "engine-owner.after.json"),
    JSON.stringify({ survivors, escaped }, null, 2),
  );
  assert.deepEqual(survivors, []);
  assert.deepEqual(escaped, []);
  results.push({ trial: "engine-owner-death", processesBefore: before.length, survivors, escaped });
}

let fixturePhase = "setup";
const seeded = new Set<string>();
const fixture = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://fixture.test").pathname;
  appendFileSync(
    path.join(root, "tab-restore-requests.jsonl"),
    `${JSON.stringify({ phase: fixturePhase, pathname, at: Date.now() })}\n`,
  );
  if (pathname === "/hang") return;
  if (pathname === "/icon.svg") {
    if (fixturePhase !== "restore-before") {
      response.writeHead(503).end();
      return;
    }
    const color = new URL(request.url ?? "/", "http://fixture.test").searchParams.get("color");
    assert(["blue", "green", "red"].includes(color ?? ""));
    response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
    response.end(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>.mark{fill:${color}}</style><rect class="mark" width="32" height="32"/></svg>`,
    );
    return;
  }
  const seed = !seeded.has(pathname) && ["/p1", "/f1"].includes(pathname);
  if (seed) seeded.add(pathname);
  response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
  response.end(
    `<title>Restore ${pathname}</title><link rel="icon" href="/icon.svg?color=${pathname === "/p1" ? "blue" : pathname === "/pop" ? "green" : "red"}"><button id="popup" onclick="window.open('/pop#/document/42')">Popup</button>${seed ? "<script>document.cookie='restore-proof=saved;path=/;max-age=86400';localStorage.setItem('restore-proof','saved')</script>" : ""}`,
  );
});
if (restoreOnly) await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const fixtureAddress = fixture.address();
const fixtureUrl =
  fixtureAddress && typeof fixtureAddress !== "string"
    ? `http://127.0.0.1:${fixtureAddress.port}`
    : "";

try {
  if (!restoreOnly) await verifyEngineOwner();
  for (const trial of restoreOnly
    ? ["restore-before", "restore-normal", "restore-crash", "restore-after-crash"]
    : (process.env.OPENSTEER_QUIT_E2E_TRIALS?.split(",") ?? [
        "appleevent",
        "sigterm",
        "logout",
        "partial",
        "restart",
      ])) {
    fixturePhase = trial;
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      OPENSTEER_TAB_RESTORE_FIXTURE: fixtureUrl,
      OPENSTEER_QUIT_E2E_DATA: data,
      OPENSTEER_PERSONAL_E2E_RESOURCES: resources,
      OPENSTEER_QUIT_E2E_TRIAL: trial,
      OPENSTEER_QUIT_E2E_CONNECTOR_RESOURCES: connectorResources,
    };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, [], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    const output = path.join(root, `${trial}.output.log`);
    child.stdout.on("data", (chunk: Buffer) => appendFileSync(output, chunk));
    child.stderr.on("data", (chunk: Buffer) => appendFileSync(output, chunk));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    assert(child.pid);
    const startupDeadline = Date.now() + 120_000;
    while (!rows(trial).some(({ event }) => event === "test.ready")) {
      assert(alive(child.pid), `${trial} exited before ready; see ${output}`);
      assert(
        !rows(trial).some(({ event }) => event === "test.failed"),
        JSON.stringify(rows(trial)),
      );
      assert(Date.now() < startupDeadline, `${trial} did not become ready`);
      await delay(50);
    }
    progress(`${trial}:ready`);
    const before = processTree(child.pid);
    if (restoreOnly) {
      const fixtureRequests = readFileSync(path.join(root, "tab-restore-requests.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) =>
          z.object({ phase: z.string(), pathname: z.string() }).parse(JSON.parse(line)),
        )
        .filter((row) => row.phase === trial);
      if (trial === "restore-normal")
        assert.equal(fixtureRequests.filter((row) => row.pathname === "/pop").length, 1);
      if (trial === "restore-crash")
        assert(
          !fixtureRequests.some((row) => row.pathname === "/hang") ||
            fixtureRequests.at(-1)?.pathname === "/hang",
        );
      if (trial === "restore-crash") {
        const hangDeadline = Date.now() + 5000;
        while (
          !readFileSync(path.join(root, "tab-restore-requests.jsonl"), "utf8").includes(
            '"pathname":"/hang"',
          )
        ) {
          assert(Date.now() < hangDeadline);
          await delay(25);
        }
        for (const { pid } of [...before].reverse()) if (alive(pid)) process.kill(pid, "SIGKILL");
      } else appleQuit();
      const result = await withTimeout(exited, desktopShutdownTimeoutMs + 1_000, {
        timeoutError: () => new Error(`${trial} exceeded quit bound`),
      });
      if (trial !== "restore-crash") assert.equal(result.code, 0);
      const cleanupDeadline = Date.now() + 3000;
      while (before.some(({ pid }) => alive(pid)) && Date.now() < cleanupDeadline) await delay(25);
      const survivors = before.filter(({ pid }) => alive(pid));
      writeFileSync(
        path.join(root, `${trial}.cleanup.json`),
        JSON.stringify({ before, survivors }, null, 2),
      );
      assert.deepEqual(survivors, []);
      const coverage = z
        .object({
          phase: z.literal(trial),
          assertionsPassed: z.literal(true),
          tabGroups: z.array(z.object({ phase: z.string(), status: z.literal("passed") })).min(1),
        })
        .parse(JSON.parse(readFileSync(path.join(data, `${trial}.coverage.json`), "utf8")));
      const expectedGroupPhases: Record<string, string[]> = {
        "restore-before": ["groups-create-and-collapse", "drag-and-drop"],
        "restore-normal": [
          "order-survives-quit",
          "groups-survive-quit",
          "groups-expand-without-opening-pages",
          "groups-reopen-guest-only",
        ],
        "restore-crash": ["groups-survive-second-launch", "groups-join-replacement-before-crash"],
        "restore-after-crash": [
          "groups-survive-crash",
          "groups-reopen-profile-only",
          "groups-ungroup-keeps-tabs",
          "groups-close-exact-members",
        ],
      };
      assert.deepEqual(
        coverage.tabGroups.map((phase) => phase.phase),
        expectedGroupPhases[trial],
      );
      progress(`${trial}:complete`);
      results.push({ trial, ...result, survivors, tabGroups: coverage.tabGroups });
      writeFileSync(
        path.join(root, "tab-restore.json"),
        JSON.stringify(
          {
            root,
            sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
            command: "pnpm test:electron-quit --tab-restore",
            results,
            notCovered: [
              "real agent Run provenance and stale agent CDP",
              "trigger/watch bridge",
              "profile deletion",
            ],
          },
          null,
          2,
        ),
      );
      continue;
    }
    assert.equal(
      before.filter(({ command }) => command.includes(connectorBinary)).length,
      3,
      "Containment wrapper, connector and its descendant are live",
    );
    writeFileSync(path.join(root, `${trial}.before.json`), JSON.stringify(before, null, 2));
    const started = performance.now();
    const replies: object[] = [];
    if (trial === "sigterm") child.kill("SIGTERM");
    else if (trial === "logout") child.kill("SIGUSR2");
    else replies.push(appleQuit());
    const result = await withTimeout(exited, desktopShutdownTimeoutMs + 1_000, {
      timeoutError: () => new Error(`${trial} exceeded quit bound`),
    });
    const elapsedMs = performance.now() - started;
    assert(elapsedMs < desktopShutdownTimeoutMs + 1_000);
    assert.equal(result.signal, null);
    assert.equal(result.code, 0);
    assert(
      !rows(trial).some(({ event }) =>
        ["test.modal", "test.failed", "test.watchdog", "test.unexpected-remote-access"].includes(
          event,
        ),
      ),
    );
    const finished = rows(trial).find(({ event }) => event === "desktop.shutdown.finished");
    assert(finished);
    assert(z.number().parse(finished.elapsedMs) < desktopShutdownTimeoutMs);
    for (const component of [
      "remote-access",
      "local-runners",
      "messaging",
      "browser",
      "runner",
      "host",
      "postgresql",
    ]) {
      assert(
        rows(trial).some(
          (row) => row.event === "desktop.shutdown.step.finished" && row.component === component,
        ),
        `${trial} missing ${component}`,
      );
    }
    if (["appleevent", "sigterm", "partial", "restart"].includes(trial)) {
      assert(
        !rows(trial).some((row) => row.event === "desktop.shutdown.step.failed"),
        JSON.stringify(rows(trial)),
      );
      for (const component of ["remote-access", "local-runners", "browser"])
        assert(
          rows(trial).some(
            (row) =>
              row.event === "desktop.shutdown.step.finished" &&
              row.component === component &&
              Number(row.elapsedMs) < 2_500,
          ),
          `${component} did not stop promptly`,
        );
    }
    assert(rows(trial).some((row) => row.event === "test.automatic-checkpoint"));
    if (trial === "partial")
      assert(rows(trial).some((row) => row.event === "test.partial-checkpoint-reported"));
    assert(rows(trial).some((row) => row.event === "test.local-runner-running"));
    assert(rows(trial).some((row) => row.event === "test.remote-access-enabled"));
    {
      assert(
        rows(trial).some(
          (row) => row.event === "test.local-worker" && row.type === "runner.worker.stopped",
        ),
      );
      assert(rows(trial).some((row) => row.event === "test.local-worker-exited"));
    }
    if (trial !== "appleevent")
      assert(rows(trial).some(({ event }) => event === "test.data-intact"));
    for (const reply of replies)
      assert(
        !JSON.stringify(reply).includes("User canceled") && !JSON.stringify(reply).includes("-128"),
      );
    // Native containment may need one poll after the Electron parent exits.
    const orphanDeadline = Date.now() + 3_000;
    while (before.some(({ pid }) => alive(pid)) && Date.now() < orphanDeadline) await delay(25);
    const survivors = before.filter(({ pid }) => alive(pid));
    const escaped = processInventory().filter(({ command }) => command.startsWith(`${resources}/`));
    writeFileSync(path.join(root, `${trial}.escaped.json`), JSON.stringify(escaped, null, 2));
    assert.deepEqual(escaped, [], `Detached runtime processes after ${trial}`);
    writeFileSync(path.join(root, `${trial}.after.json`), JSON.stringify(survivors, null, 2));
    assert.deepEqual(survivors, [], `Orphans after ${trial}`);
    results.push({
      trial,
      ...result,
      elapsedMs,
      replies,
      processesBefore: before.length,
      survivors,
      dataIntact: trial !== "appleevent",
      steps: rows(trial).filter((row) => row.event === "desktop.shutdown.step.finished"),
    });
    writeFileSync(
      path.join(root, "quit-smoke.json"),
      JSON.stringify({ root, resources, results }, null, 2),
    );
  }
  process.stdout.write(`${root}/${restoreOnly ? "tab-restore" : "quit-smoke"}.json\n`);
} finally {
  fixture.closeAllConnections();
  fixture.close();
  // Never address a process outside the isolated app's tree.
  let remaining = "";
  try {
    remaining = execFileSync("pgrep", ["-f", executable], { encoding: "utf8" }).trim();
  } catch {
    /* No owned processes remain. */
  }
  for (const pid of remaining.split(/\s+/u).filter(Boolean).map(Number))
    if (alive(pid)) process.kill(pid, "SIGKILL");
  for (const { pid } of processInventory().filter(({ command }) =>
    command.startsWith(`${resources}/`),
  )) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* The owned process exited meanwhile. */
    }
  }
}
