import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("rejects early success without result evidence and records smoke failures", () => {
  const out = mkdtempSync(path.join(tmpdir(), "electron-journey-"));
  try {
    mkdirSync(path.join(out, "downloads"), { recursive: true });
    writeFileSync(path.join(out, "downloads.log"), "");
    writeFileSync(path.join(out, "quit.log"), "");
    for (const [code, report, expected, log] of [
      [0, undefined, 1, ""],
      [0, { passed: false }, 1, ""],
      [1, { passed: true }, 1, ""],
      [0, { passed: true }, 0, ""],
      [0, { passed: true }, 1, "Test skipped"],
    ] as const) {
      writeFileSync(path.join(out, "downloads.log"), log);
      if (report) writeFileSync(path.join(out, "downloads/parent.json"), JSON.stringify(report));
      const result = spawnSync(
        process.execPath,
        [
          "apps/desktop/scripts/test-support/validate-electron-journey.mjs",
          out,
          "downloads",
          String(code),
          "2",
        ],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      const rows = readFileSync(path.join(out, "results.jsonl"), "utf8").trim().split("\n");
      expect(JSON.parse(rows.at(-1)!).exitCode).toBe(expected);
    }
    const quit = path.join(out, "quit/quit-owned");
    mkdirSync(quit, { recursive: true });
    writeFileSync(
      path.join(quit, "tab-restore.json"),
      JSON.stringify({
        results: ["restore-before", "restore-normal", "restore-crash", "restore-after-crash"].map(
          (trial) => ({ trial }),
        ),
      }),
    );
    expect(
      spawnSync(process.execPath, [
        "apps/desktop/scripts/test-support/validate-electron-journey.mjs",
        out,
        "quit",
        "0",
        "3",
      ]).status,
    ).toBe(0);
    const quitRows = readFileSync(path.join(out, "results.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(quitRows.at(-1)!).exitCode).toBe(0);

    // extensions validation requires 6/6 passing boundary sections AND pins main's known fault on
    // `chrome.windows.create and remove` (it.fails style: accepts only that exact refusal, rejects
    // any other lifecycle failure, rejects an unexpected pass so the pin cannot rot, and rejects
    // any failing or missing boundary section).
    const extDir = path.join(out, "extensions");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(path.join(out, "extensions.log"), "");
    const boundarySections = [
      "connected-agent-isolation",
      "connected-agent-breakpoints",
      "connected-agent-compromise",
      "connected-agent-probes",
      "connected-agent-dialog",
      "extension-web-accessible",
    ];
    const knownMainFault = {
      step: "chrome.windows.create and remove",
      refusal:
        "Creating separate browser windows is not supported; use chrome.tabs.create() to open a tab.",
      phases: ["install", "reopen"],
    };
    const writeExtArtifacts = (overrides: {
      report?: Record<string, unknown>;
      lifecycle?: Record<string, unknown>;
      failingBoundary?: string;
      omitBoundary?: string;
    }) => {
      rmSync(extDir, { recursive: true, force: true });
      mkdirSync(extDir, { recursive: true });
      writeFileSync(
        path.join(extDir, "extensions.json"),
        JSON.stringify({
          passed: true,
          boundaryPassed: true,
          lifecycleStatus: "known-main-fault",
          lifecyclePassed: false,
          knownMainFault,
          ...overrides.report,
        }),
      );
      for (const section of boundarySections) {
        if (section === overrides.omitBoundary) continue;
        writeFileSync(
          path.join(extDir, `section-${section}.json`),
          JSON.stringify({ section, passed: section !== overrides.failingBoundary, checks: [] }),
        );
      }
      writeFileSync(
        path.join(extDir, "section-extension-lifecycle.json"),
        JSON.stringify({
          section: "extension-lifecycle",
          status: "known-main-fault",
          passed: false,
          knownMainFault,
          checks: [],
          ...overrides.lifecycle,
        }),
      );
    };
    for (const [label, code, overrides, expected, stdoutPattern, stderrPattern] of [
      [
        "known main fault accepted loudly",
        0,
        {},
        0,
        /knownMainFault.*chrome\.windows\.create and remove/,
        undefined,
      ],
      [
        "different lifecycle refusal rejected",
        0,
        { lifecycle: { knownMainFault: { ...knownMainFault, refusal: "Some other refusal." } } },
        1,
        undefined,
        undefined,
      ],
      [
        "ordinary lifecycle failure rejected",
        0,
        {
          report: { lifecycleStatus: "failed" },
          lifecycle: { status: "failed", knownMainFault: undefined, error: "install failed" },
        },
        1,
        undefined,
        undefined,
      ],
      [
        "unexpected lifecycle pass rejected so pin cannot rot",
        0,
        {
          report: { lifecycleStatus: "passed", lifecyclePassed: true, knownMainFault: undefined },
          lifecycle: { status: "passed", passed: true, knownMainFault: undefined },
        },
        1,
        undefined,
        /remove the knownMainFault entry/i,
      ],
      [
        "failing boundary section rejected",
        0,
        { failingBoundary: "connected-agent-dialog" },
        1,
        undefined,
        undefined,
      ],
      [
        "missing boundary section rejected",
        0,
        { omitBoundary: "connected-agent-compromise" },
        1,
        undefined,
        undefined,
      ],
      [
        "missing web-accessible section rejected",
        0,
        { omitBoundary: "extension-web-accessible" },
        1,
        undefined,
        undefined,
      ],
      [
        "failing web-accessible section rejected",
        0,
        { failingBoundary: "extension-web-accessible" },
        1,
        undefined,
        undefined,
      ],
      [
        "contradictory lifecycle error alongside pin rejected",
        0,
        { lifecycle: { error: "unrelated local lifecycle assertion failed" } },
        1,
        undefined,
        undefined,
      ],
      [
        "contradictory aggregate report error alongside pin rejected",
        0,
        { report: { error: "unrelated aggregate error" } },
        1,
        undefined,
        undefined,
      ],
      [
        "mismatched aggregate report knownMainFault rejected",
        0,
        { report: { knownMainFault: { ...knownMainFault, phases: ["install"] } } },
        1,
        undefined,
        undefined,
      ],
      [
        "missing lifecycle passed:false rejected",
        0,
        { lifecycle: { passed: undefined } },
        1,
        undefined,
        undefined,
      ],
      ["non-zero smoke exit rejected", 1, {}, 1, undefined, undefined],
    ] as const) {
      writeExtArtifacts(overrides);
      const run = spawnSync(
        process.execPath,
        [
          "apps/desktop/scripts/test-support/validate-electron-journey.mjs",
          out,
          "extensions",
          String(code),
          "4",
        ],
        { encoding: "utf8" },
      );
      expect(run.status, label).toBe(0);
      const extRows = readFileSync(path.join(out, "results.jsonl"), "utf8").trim().split("\n");
      expect(JSON.parse(extRows.at(-1)!).exitCode, label).toBe(expected);
      if (stdoutPattern) expect(run.stdout, label).toMatch(stdoutPattern);
      if (stderrPattern) expect(run.stderr, label).toMatch(stderrPattern);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

it("installs one smoke guard per process and emits the starting line first on quit and menu-bar drivers", async () => {
  const { installProcessSmokeGuard } =
    await import("../apps/desktop/scripts/test-support/process-smoke-guard.js");
  const dispose = installProcessSmokeGuard("unit-guard", 60_000);
  try {
    expect(() => installProcessSmokeGuard("duplicate", 60_000)).toThrow(/already installed/i);
  } finally {
    dispose();
  }
  // Helper smoke modules imported by electron-browser-smoke must not install their own guards.
  for (const helper of [
    "apps/desktop/scripts/electron-idle-cpu-smoke.ts",
    "apps/desktop/scripts/electron-idle-lifecycle-smoke.ts",
  ]) {
    expect(readFileSync(helper, "utf8"), helper).not.toContain("installSmokeGuard");
  }
  // Quit and menu-bar drivers install their process guard before codesign so the starting line is first,
  // route timeout through owned-child cleanup, and do not cap below the sum of per-trial waits.
  for (const driver of [
    "apps/desktop/scripts/test-electron-quit.ts",
    "apps/desktop/scripts/test-electron-menu-bar.ts",
  ]) {
    const source = readFileSync(driver, "utf8");
    const guardIndex = source.indexOf("installProcessSmokeGuard(");
    const codesignIndex = source.indexOf('"codesign"');
    expect(guardIndex, driver).toBeGreaterThan(-1);
    expect(codesignIndex, driver).toBeGreaterThan(guardIndex);
    expect(source, driver).toMatch(/installProcessSmokeGuard\([^)]+cleanupOwnedChildren/u);
    expect(source, driver).not.toMatch(/installProcessSmokeGuard\("quit",\s*360_000\)/u);
    expect(source, driver).not.toMatch(/installProcessSmokeGuard\("menu-bar",\s*300_000\)/u);
  }
  const browserSource = readFileSync("apps/desktop/scripts/electron-browser-smoke.ts", "utf8");
  expect(browserSource.match(/installSmokeGuard\(/gu)?.length).toBe(1);

  // S-g: electron-extensions-smoke attributes the chrome.windows.create stage and checks no tab was produced.
  const extSmokeSource = readFileSync("apps/desktop/scripts/electron-extensions-smoke.ts", "utf8");
  expect(extSmokeSource).toContain('stage === "create"');
  expect(extSmokeSource).toContain("browser.context.pages().length");

  // S-e: process-smoke-guard runs its cleanup callback before exiting on timeout so owned children die.
  const out = mkdtempSync(path.join(tmpdir(), "smoke-guard-cleanup-"));
  const pidFile = path.join(out, "child.pid");
  try {
    const guardRun = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        `
        import { spawn } from "node:child_process";
        import { writeFileSync } from "node:fs";
        import { installProcessSmokeGuard } from "./apps/desktop/scripts/test-support/process-smoke-guard.ts";
        let childPid = 0;
        installProcessSmokeGuard("watchdog-test", 150, () => {
          if (childPid) {
            try { process.kill(childPid, "SIGKILL"); } catch {}
          }
        });
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], { stdio: "ignore" });
        childPid = child.pid;
        writeFileSync(${JSON.stringify(pidFile)}, String(childPid));
        setInterval(() => {}, 10000);
        `,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(guardRun.status).toBe(1);
    expect(guardRun.stderr).toContain("[smoke] watchdog-test: timeout");
    const spawnedPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(spawnedPid).toBeGreaterThan(0);
    let aliveAfter = true;
    for (let i = 0; i < 20; i += 1) {
      try {
        process.kill(spawnedPid, 0);
      } catch {
        aliveAfter = false;
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    if (aliveAfter) {
      try {
        process.kill(spawnedPid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    expect(aliveAfter).toBe(false);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

it("requires every folded smoke in order under the explicit journey output", () => {
  const out = mkdtempSync(path.join(tmpdir(), "journey-evidence-"));
  // What the dispatcher runs, in its order: the aggregate must expect exactly that.
  const smokes = /for smoke in \$\{OPENSTEER_ELECTRON_SMOKES:-([\w -]+)\}; do/
    .exec(readFileSync("apps/desktop/scripts/journey-command.sh", "utf8"))![1]!
    .split(" ");
  expect(smokes).toContain("menu-bar");
  const passed = smokes.map((name) => ({ name, exitCode: 0, seconds: 1 }));
  try {
    mkdirSync(path.join(out, "electron"));
    writeFileSync(path.join(out, "electron.log"), "");
    for (const [rows, expected] of [
      [passed, 0],
      [passed.slice(1), 1],
      [[...passed].reverse(), 1],
      [[...passed, passed[0]], 1],
      [passed.map((row) => (row.name === "passkeys" ? { ...row, exitCode: 1 } : row)), 1],
    ] as const) {
      writeFileSync(
        path.join(out, "electron/results.jsonl"),
        rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      );
      expect(
        spawnSync(process.execPath, [
          "apps/desktop/scripts/journey-evidence.mjs",
          out,
          "electron",
          "0",
          "1",
        ]).status,
      ).toBe(0);
      const results = readFileSync(path.join(out, "results.jsonl"), "utf8").trim().split("\n");
      expect(JSON.parse(results.at(-1)!).exitCode).toBe(expected);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

it("stops only recorded process trees when the quit driver's watchdog fires", () => {
  const source = readFileSync("apps/desktop/scripts/test-electron-quit.ts", "utf8");
  const start = source.indexOf("const cleanupOwnedChildren = () => {");
  expect(start).toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf("\n};\n", start));
  expect(body).toContain("activeChildPids");
  expect(body).not.toContain("pgrep");
  expect(body).not.toContain("processInventory");
  expect(body).not.toContain("command.startsWith");
  expect(source).toMatch(
    /installProcessSmokeGuard\("quit", aggregateTimeoutMs, cleanupOwnedChildren\)/u,
  );
});
