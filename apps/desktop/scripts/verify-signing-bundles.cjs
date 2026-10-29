// Bundling journey only: never launches Electron or accesses signing keys.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const desktop = resolve(__dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "opensteer-signing-bundles-"));
const results = [];
const environment = {
  ...process.env,
  OPENSTEER_DESKTOP_TARGET_OS: "darwin",
  OPENSTEER_DESKTOP_RELEASE: "0",
};
delete environment.OPENSTEER_DESKTOP_SIGNING_FILE;
delete environment.OPENSTEER_DESKTOP_DEVELOPMENT_TRUST;
const configs = [
  "scripts/tsup.electron-smoke.config.ts",
  "scripts/tsup.electron-passwords-smoke.config.ts",
  "scripts/tsup.electron-native-browser.config.ts",
  "tsup.config.ts",
];
const outputRoot = join(desktop, ".electron-smoke/signing-boundary");
function javascript(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const name = join(directory, entry.name);
      return entry.isDirectory()
        ? javascript(name)
        : entry.name.endsWith(".js")
          ? [readFileSync(name, "utf8")]
          : [];
    })
    .join("\n");
}
try {
  for (const [index, config] of configs.entries()) {
    const output = join(outputRoot, String(index));
    rmSync(join(desktop, "build/generated"), { recursive: true, force: true });
    for (const [team, prior] of [
      ["AAAAA11111", undefined],
      ["BBBBB22222", "AAAAA11111"],
    ]) {
      const input = join(temporary, "input.json");
      writeFileSync(
        input,
        JSON.stringify({ teamId: team, identity: `Developer ID Application: Fixture (${team})` }),
      );
      const build = spawnSync("pnpm", ["exec", "tsup", "--config", config, "--out-dir", output], {
        cwd: desktop,
        env: {
          ...environment,
          OPENSTEER_DESKTOP_SIGNING_FILE: input,
          OPENSTEER_ELECTRON_SMOKE_OUTDIR: output,
        },
        encoding: "utf8",
        timeout: 120_000,
      });
      assert.equal(build.status, 0, `${config}: ${build.stdout}\n${build.stderr}`);
      const bytes = javascript(output);
      assert(bytes.includes(team), `${config}: bundle does not contain current team ${team}`);
      if (prior) assert(!bytes.includes(prior), `${config}: stale identity remains`);
      results.push({ config, scenario: prior ? "identity-change" : "clean", team, passed: true });
    }
    const rejected = spawnSync("pnpm", ["exec", "tsup", "--config", config, "--out-dir", output], {
      cwd: desktop,
      env: {
        ...environment,
        OPENSTEER_DESKTOP_RELEASE: "1",
        OPENSTEER_ELECTRON_SMOKE_OUTDIR: output,
      },
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.notEqual(rejected.status, 0, `${config}: release accepted missing signing input`);
    results.push({ config, scenario: "release-missing-input", passed: true });
  }
  process.stdout.write(JSON.stringify({ passed: true, results }, null, 2) + "\n");
} finally {
  rmSync(temporary, { recursive: true, force: true });
  rmSync(outputRoot, { recursive: true, force: true });
}
