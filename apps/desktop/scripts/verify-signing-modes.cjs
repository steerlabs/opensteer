// Headless real bundling and raw-consumer checks; never runs Electron or uses a key.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const desktop = resolve(__dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "opensteer-signing-modes-"));
const environment = { ...process.env };
for (const key of [
  "OPENSTEER_DESKTOP_SIGNING_FILE",
  "OPENSTEER_DEV_TRUST",
  "OPENSTEER_DESKTOP_DEVELOPMENT_TRUST",
  "OPENSTEER_DESKTOP_RELEASE",
])
  delete environment[key];
const results = [];
try {
  rmSync(join(desktop, "build/generated"), { recursive: true, force: true });
  const moduleUrl = pathToFileURL(join(desktop, "src/signed-helpers/signing-build.ts")).href;
  function raw(label, env, expected, success = true) {
    const expression = `import(${JSON.stringify(moduleUrl)}).then(m => { require('node:assert/strict').deepEqual({team:m.signingTeamId,dev:m.developmentTrust},${JSON.stringify(expected)}); })`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "-e", expression], {
      cwd: desktop,
      env: { ...environment, ...env },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(child.status === 0, success, label + ": " + child.stderr);
    results.push({ label, exit: child.status });
  }
  raw("raw clean consumer defaults to development", {}, { team: null, dev: true });
  raw(
    "raw release consumer refuses missing input",
    { OPENSTEER_DESKTOP_RELEASE: "1" },
    null,
    false,
  );
  const file = join(temporary, "signing.json");
  writeFileSync(
    file,
    JSON.stringify({
      teamId: "BBBBB22222",
      identity: "Developer ID Application: Fixture (BBBBB22222)",
    }),
  );
  raw(
    "raw non-release uses supplied identity",
    { OPENSTEER_DESKTOP_SIGNING_FILE: file },
    { team: "BBBBB22222", dev: false },
  );
  // Use the actual onStart/onLoad plugin, including rebuilds in one cached context.
  process.chdir(desktop);
  const { context } = require("esbuild");
  const { signingBuildPlugin } = require("./signing-build-plugin.ts");
  const output = join(temporary, "probe.mjs");
  const entry = `export { signingTeamId, developmentTrust } from ${JSON.stringify(join(desktop, "src/signed-helpers/signing-build.ts"))};`;
  async function bundles() {
    const builder = await context({
      stdin: { contents: entry, resolveDir: desktop, loader: "ts" },
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: output,
      plugins: [signingBuildPlugin()],
    });
    try {
      for (const [team, release] of [
        [null, false],
        ["AAAAA11111", true],
        ["BBBBB22222", true],
      ]) {
        for (const key of [
          "OPENSTEER_DESKTOP_SIGNING_FILE",
          "OPENSTEER_DESKTOP_DEVELOPMENT_TRUST",
          "OPENSTEER_DESKTOP_RELEASE",
        ])
          delete process.env[key];
        if (release) {
          writeFileSync(
            file,
            JSON.stringify({
              teamId: team,
              identity: `Developer ID Application: Fixture (${team})`,
            }),
          );
          process.env.OPENSTEER_DESKTOP_SIGNING_FILE = file;
          process.env.OPENSTEER_DESKTOP_RELEASE = "1";
          process.env.OPENSTEER_DESKTOP_DEVELOPMENT_TRUST = "1";
        }
        await builder.rebuild();
        const check = `import(${JSON.stringify(pathToFileURL(output).href)}).then(m=>require('node:assert/strict').deepEqual({team:m.signingTeamId,dev:m.developmentTrust},${JSON.stringify({ team, dev: !release })}));`;
        const checked = spawnSync(process.execPath, ["-e", check], {
          env: { ...environment, OPENSTEER_DEV_TRUST: "1" },
          encoding: "utf8",
          timeout: 10_000,
        });
        assert.equal(checked.status, 0, checked.stderr);
        results.push({
          label: release ? `immutable release ${team}` : "clean development bundle",
          passed: true,
        });
      }
      delete process.env.OPENSTEER_DESKTOP_SIGNING_FILE;
      await assert.rejects(builder.rebuild());
      results.push({ label: "cached release rebuild refuses missing input", passed: true });
    } finally {
      await builder.dispose();
    }
    process.stdout.write(JSON.stringify({ passed: true, results }, null, 2) + "\n");
  }
  bundles()
    .catch((error) => {
      process.stderr.write(String(error.stack) + "\n");
      process.exitCode = 1;
    })
    .finally(() => rmSync(temporary, { recursive: true, force: true }));
} catch (error) {
  rmSync(temporary, { recursive: true, force: true });
  throw error;
}
