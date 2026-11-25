import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const [root, name, exitCode, seconds] = process.argv.slice(2);
let code = Number(exitCode);
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const local = (file) => read(path.join(root, name, file));
const reportedArtifact = () => {
  const row = fs
    .readFileSync(path.join(root, name + ".log"), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map(JSON.parse)
    .find((row) => row.artifactPath);
  assert(row?.artifactPath);
  const report = read(row.artifactPath);
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, "result.json"), JSON.stringify(report, null, 2));
  return report;
};
try {
  assert.equal(code, 0, `${name} exited ${code}`);
  const log = fs.readFileSync(path.join(root, name + ".log"), "utf8");
  assert(
    !/Test Case .* skipped|Test skipped|\b[1-9]\d* (?:tests? )?skipped\b|\(\d+ tests? \| [1-9]\d* skipped\)/i.test(
      log,
    ),
    `${name} skipped tests`,
  );
  switch (name) {
    case "cdp-boundary":
      assert.equal(local("electron.json").passed, true);
      break;
    case "extensions": {
      const KNOWN_STEP = "chrome.windows.create and remove";
      // Exactly what the extension's worker receives on real Electron: the refusal wrapped by
      // the extension API's IPC call.
      const KNOWN_REFUSAL =
        "Error invoking remote method 'opensteer-crx:call': Error: Creating separate browser windows is not supported; use chrome.tabs.create() to open a tab.";
      const report = local("extensions.json");
      assert.equal(report.passed, true);
      assert.equal(report.boundaryPassed, true);
      for (const section of [
        "connected-agent-isolation",
        "connected-agent-breakpoints",
        "connected-agent-compromise",
        "connected-agent-probes",
        "connected-agent-dialog",
        "extension-web-accessible",
      ]) {
        const entry = local(`section-${section}.json`);
        assert.equal(entry.section, section);
        assert.equal(
          entry.passed,
          true,
          `extensions section ${section} failed: ${entry.error ?? ""}`,
        );
      }
      const lifecycle = local("section-extension-lifecycle.json");
      assert.equal(lifecycle.section, "extension-lifecycle");
      if (
        lifecycle.passed === true ||
        lifecycle.status === "passed" ||
        report.lifecyclePassed === true
      ) {
        assert.fail(
          `extensions lifecycle step "${KNOWN_STEP}" unexpectedly PASSED; remove the knownMainFault entry from validate-electron-journey.mjs and electron-extensions-smoke.ts.`,
        );
      }
      assert.equal(
        lifecycle.status,
        "known-main-fault",
        `extensions section extension-lifecycle failed: ${lifecycle.error ?? JSON.stringify(lifecycle)}`,
      );
      assert.equal(lifecycle.passed, false);
      assert.equal(report.lifecyclePassed, false);
      assert.equal(
        lifecycle.error,
        undefined,
        `extensions section extension-lifecycle recorded an unexpected error alongside knownMainFault: ${lifecycle.error}`,
      );
      assert.equal(
        report.error,
        undefined,
        `extensions aggregate report recorded an unexpected error alongside knownMainFault: ${report.error}`,
      );
      assert.equal(report.lifecycleStatus, "known-main-fault");
      assert.equal(lifecycle.knownMainFault?.step, KNOWN_STEP);
      assert.equal(lifecycle.knownMainFault?.refusal, KNOWN_REFUSAL);
      assert.deepEqual(lifecycle.knownMainFault?.phases, ["install", "reopen"]);
      assert.equal(report.knownMainFault?.step, KNOWN_STEP);
      assert.equal(report.knownMainFault?.refusal, KNOWN_REFUSAL);
      assert.deepEqual(report.knownMainFault?.phases, ["install", "reopen"]);
      console.log(
        `[journey] extensions: PASS (6/6 boundary sections passed; extension-lifecycle = knownMainFault at "${KNOWN_STEP}" — ${KNOWN_REFUSAL})`,
      );
      break;
    }
    case "passwords":
      assert.equal(local("manifest.json").passed, true);
      assert.equal(local("leak-scan.json").executed, true);
      assert.equal(local("leak-scan.json").matches, 0);
      break;
    case "attachments":
      assert.equal(reportedArtifact().event, "electron-attachment-smoke.passed");
      break;
    case "downloads":
      assert.equal(local("parent.json").passed, true);
      break;
    case "profile-restore": {
      // The ten native phases, each ended as it should (the crash phase by SIGKILL) with passing evidence.
      const value = local("results.json");
      assert.equal(value.passed, true);
      // The smoke's own nativeProfileSmokePhases, in order.
      assert.deepEqual(
        value.phases.map((phase) => phase.phase),
        [
          "native-create",
          "native-quit-reopen",
          "native-update-reopen",
          "native-crash",
          "native-crash-reopen",
          "native-network",
          "native-logout",
          "native-logout-reopen",
          "native-clear",
          "native-clear-reopen",
        ],
      );
      assert.equal(
        value.phases.find((phase) => phase.phase === "native-crash").exit.signal,
        "SIGKILL",
      );
      assert(
        value.phases.every(
          (phase) =>
            phase.passed === true &&
            Object.values(phase.results).length > 0 &&
            Object.values(phase.results).every((row) => row.status === "pass"),
        ),
      );
      break;
    }
    case "host-transport":
      assert.equal(reportedArtifact().code, 0);
      break;
    case "leave-home": {
      // Home A left (proof verified, its session and Runner key gone), Home B untouched, A again.
      const { code: reported, checks } = reportedArtifact();
      assert.equal(reported, 0);
      assert.equal(checks.leftA.membership, "removed");
      assert.equal(checks.leaveProof.verified, true);
      assert.deepEqual(checks.goneForA.keyFiles, []);
      assert.equal(checks.untouchedB.membership, "active");
      assert.equal(checks.rejoinedA.membership, "active");
      break;
    }
    case "idle":
      assert.equal(local("electron-local-visibility.json").passed, true);
      assert.equal(local("electron-idle-cpu.json").phases.length, 3);
      break;
    case "menu-bar": {
      // Every trial passed; only the real helper's may be unverified, and is recorded so.
      const { results } = local("menu-bar.json");
      const trials = [
        "popover-phases",
        "home-stop",
        "quit-logout",
        "quit-sigterm",
        "early-quit",
        "dock",
      ];
      assert.deepEqual(
        results.map((row) => row.trial),
        trials,
      );
      for (const row of results)
        assert(row.outcome === "pass", `menu-bar ${row.trial}: ${row.outcome} ${row.error ?? ""}`);
      break;
    }
    case "quit": {
      const directory = path.join(root, name);
      const runs = fs.readdirSync(directory).filter((entry) => entry.startsWith("quit-"));
      assert.equal(runs.length, 1);
      const results = read(path.join(directory, runs[0], "tab-restore.json")).results;
      assert.deepEqual(
        results.map((row) => row.trial),
        ["restore-before", "restore-normal", "restore-crash", "restore-after-crash"],
      );
      break;
    }
    case "cookies":
      assert.equal(local("electron.json").engine, "electron");
      break;
    case "passkeys":
      assert.equal(local("electron.json").policy?.engine, "electron");
      break;
    case "usb":
      assert(!local("usb.json").error);
      break;
    case "system-ca": {
      // The Home's Node and the desktop's own Runner, with the switch on and off.
      const { rows } = local("system-ca.json");
      assert.equal(rows.length, 4);
      for (const row of rows) assert.equal(row.reached, row.setting === "on", JSON.stringify(row));
      break;
    }
    case "browser":
      assert(local("electron-follow-view.json"));
      break;
  }
} catch (error) {
  console.error(error);
  code ||= 1;
}
fs.appendFileSync(
  path.join(root, "results.jsonl"),
  JSON.stringify({ name, exitCode: code, seconds: Number(seconds) }) + "\n",
);
