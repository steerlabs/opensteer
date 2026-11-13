/**
 * The native-windows lane, run as run-as-standard-user.ps1's disposable user inside
 * a Task Scheduler task, which has no console: output goes to the log the step
 * streams, and the result to the file it reads.
 *   node .github/scripts/ci-native-windows.mjs <spec.json>
 */
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const environment = { ...process.env };
// Windows names variables case-insensitively; one spelling must survive.
const assign = (name, value) => {
  for (const key of Object.keys(environment))
    if (key.toLowerCase() === name.toLowerCase()) delete environment[key];
  environment[name] = value;
};
for (const [name, value] of Object.entries(spec.environment)) assign(name, value);
// This user cannot write the administrator's Go caches; module downloads go to its own profile.
assign("GOCACHE", join(tmpdir(), "opensteer-go-build"));

const evidence = dirname(environment.CI_INVENTORY_PATH);
const steps = [
  ["go", "-C", "apps/desktop/process-supervisor", "test", "-count=1", "./..."],
  ["go", "-C", "apps/desktop/personal-runtime-launcher", "test", "-count=1", "./..."],
  ["go", "-C", "apps/runner/native-fs-helper", "test", "-count=1", "-timeout=2m", "./..."],
  [
    process.execPath,
    "node_modules/vitest/vitest.mjs",
    "run",
    "--config",
    "vitest.windows.config.ts",
    "--reporter=default",
    "--reporter=junit",
    "--reporter=json",
    "--reporter=./scripts/ci-inventory-reporter.ts",
    `--outputFile.junit=${join(evidence, "windows-1.xml")}`,
    `--outputFile.json=${join(evidence, "windows-1.results.json")}`,
  ],
];
const log = openSync(spec.log, "a");
let code = 0;
for (const [command, ...arguments_] of steps) {
  writeFileSync(log, `\n$ ${[command, ...arguments_].join(" ")}\n`);
  const result = spawnSync(command, arguments_, {
    cwd: spec.cwd,
    env: environment,
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  if (result.error) writeFileSync(log, `${result.error.message}\n`);
  code = result.status ?? 1;
  if (code !== 0) break;
}
closeSync(log);
writeFileSync(spec.result, JSON.stringify({ code }));
process.exitCode = code;
