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
      assert.equal(value.phases.length, 10);
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
