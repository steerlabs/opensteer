// Host-safe CLI journey. No signing authority, keychain operations, windows or servers.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { writePlatformSigningConstants } = require("./signing-input.cjs");
const desktop = resolve(__dirname, "..");
const fixtureDirectory = mkdtempSync(join(tmpdir(), "opensteer-signing-journey-"));
const environment = { ...process.env };
for (const key of [
  "OPENSTEER_DESKTOP_SIGNING_FILE",
  "OPENSTEER_DESKTOP_DEVELOPMENT_TRUST",
  "OPENSTEER_DESKTOP_RELEASE",
])
  delete environment[key];
const results = [];
function child(label, args, extra, success) {
  const result = spawnSync(process.execPath, args, {
    cwd: desktop,
    env: { ...environment, ...extra },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status === 0, success, `${label}: ${result.stderr}`);
  results.push({ label, exit: result.status, stdout: result.stdout, stderr: result.stderr });
}
try {
  child(
    "non-mac hook imports without Apple authority",
    ["-e", 'require("./scripts/after-sign.cjs")'],
    { OPENSTEER_DESKTOP_RELEASE: "1" },
    true,
  );
  child(
    "Linux hook returns without Apple authority",
    ["-e", 'require("./scripts/after-sign.cjs")({electronPlatformName:"linux"})'],
    {},
    true,
  );
  const command = ["--import", "tsx", "scripts/build-computer-use-helper.ts", "--requirement-only"];
  child("ordinary helper defaults to development", command, {}, true);
  child(
    "ordinary helper needs no development flag",
    command,
    { OPENSTEER_DESKTOP_DEVELOPMENT_TRUST: "1" },
    true,
  );
  child(
    "distributable refuses development trust",
    command,
    { OPENSTEER_DESKTOP_RELEASE: "1", OPENSTEER_DESKTOP_DEVELOPMENT_TRUST: "1" },
    false,
  );
  child("distributable refuses missing input", command, { OPENSTEER_DESKTOP_RELEASE: "1" }, false);
  const file = join(fixtureDirectory, "signing.json");
  writeFileSync(
    file,
    JSON.stringify({
      teamId: "ABCDE12345",
      identity: "Developer ID Application: Example (ABCDE12345)",
    }),
  );
  child(
    "non-release helper uses a supplied identity",
    command,
    { OPENSTEER_DESKTOP_SIGNING_FILE: file, OPENSTEER_DESKTOP_DEVELOPMENT_TRUST: "1" },
    true,
  );
  child(
    "configured production metadata retains strict peer policy",
    command,
    { OPENSTEER_DESKTOP_SIGNING_FILE: file, OPENSTEER_DESKTOP_RELEASE: "1" },
    true,
  );
  const core = join(
    desktop,
    "native/computer-use/Sources/ComputerUseCore/Support/PeerRequirementMode.swift",
  );
  assert.match(readFileSync(core, "utf8"), /#if OPENSTEER_DEV_TRUST/);
  assert.match(readFileSync(core, "utf8"), /MacCodeIdentity.ownTeamId/);
  for (const platform of ["linux", "win32"]) {
    const output = writePlatformSigningConstants(join(fixtureDirectory, platform), {}, platform);
    assert.match(output.typescript, /developmentTrust = false/);
    assert.match(output.typescript, /signingTeamId: string \| null = null/);
    assert.deepEqual(output.build, { mode: "unavailable" });
    results.push({ label: `${platform} has no Apple identity or development trust`, passed: true });
  }
  process.stdout.write(JSON.stringify({ passed: true, results }, null, 2) + "\n");
} finally {
  rmSync(fixtureDirectory, { recursive: true, force: true });
}
