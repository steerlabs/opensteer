import fs from "node:fs";
import path from "node:path";
const [out, name, exitCode, seconds] = process.argv.slice(2);
let code = Number(exitCode);
let skipped = false;
try {
  const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const root = path.join(out, name);
  const log = fs.readFileSync(path.join(out, name + ".log"), "utf8");
  if (
    /Test Case .* skipped|Test skipped|\b[1-9]\d* (?:tests? )?skipped\b|\(\d+ tests? \| [1-9]\d* skipped\)/i.test(
      log,
    )
  ) {
    skipped = true;
    throw Error("Journey skipped tests");
  }
  if (name === "windows")
    for (const selection of ["current", "settle", "cancellation", "video", "receipt-switch"]) {
      if (read(path.join(root, selection, "result.json")).passed !== true)
        throw Error("Window case failed: " + selection);
    }
  if (name === "chrome-background") {
    const dir = root;
    const files = fs.readdirSync(dir).filter((file) => /^results.*\.json$/.test(file));
    if (!files.length) throw Error("Chrome results missing");
    const rows = files.flatMap((file) => {
      const value = read(path.join(dir, file));
      return Array.isArray(value) ? value : (value.rows ?? value.cases ?? []);
    });
    if (
      !rows.length ||
      rows.some((row) => !["pass", "accepted-limitation"].includes(row.status ?? row.verdict))
    )
      throw Error("Chrome invalid or regression row");
    const groups = Map.groupBy(rows, (row) =>
      [row.journey, row.variant, row.app, row.control, row.step, row.route, row.typingRoute].join(
        ":",
      ),
    );
    for (const group of groups.values())
      if (group.length > 1 && !group.some((row) => (row.status ?? row.verdict) === "pass"))
        throw Error("Loop has no pass");
  }
  if (name === "native-browser" && read(path.join(root, "result.json")).status !== "PASS")
    throw Error("Native browser journey did not pass");
  if (name === "electron") {
    const expected = [
      "cdp-boundary",
      "passwords",
      "attachments",
      "downloads",
      "profile-restore",
      "focus",
      "host-transport",
      "browser",
      "idle",
      "quit",
      "cookies",
      "passkeys",
      "usb",
    ];
    const rows = fs
      .readFileSync(path.join(root, "results.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    if (
      rows.length !== expected.length ||
      rows.some((row, index) => row.name !== expected[index] || row.exitCode !== 0)
    )
      throw Error("Electron journey has missing, reordered or failed smokes");
  }
  if (name === "live-swift") {
    const log = fs.readFileSync(path.join(out, name + ".log"), "utf8");
    if (
      /Test Case .* skipped|Test skipped|\b[1-9]\d* (?:tests? )?skipped\b/i.test(log) ||
      !/Executed [1-9]\d* tests?/.test(log)
    ) {
      skipped = true;
      throw Error("Swift skipped tests or executed no tests");
    }
  }
} catch (error) {
  console.error(error);
  code = code || 1;
}
fs.appendFileSync(
  path.join(out, "results.jsonl"),
  JSON.stringify({
    name,
    exitCode: code,
    seconds: Number(seconds),
    outcome: skipped ? "skipped" : code === 0 ? "passed" : "failed",
    ...(name === "live-swift"
      ? {
          excluded: [
            "BackgroundInputLiveTests (opt-in dev tooling)",
            "testRunningTeamSignedAppsMatchTheirOwnBundleIdentity (needs a running team-signed app)",
          ],
        }
      : {}),
  }) + "\n",
);
