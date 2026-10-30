import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIntegrationTests } from "./test-integration.js";
import { linkProfiles } from "../tests/mobile-network/proxy.test-support.js";

const { values } = parseArgs({
  options: {
    profile: { type: "string", default: "all" },
    seed: { type: "string", default: "all" },
    scenario: { type: "string", default: "all" },
    runs: { type: "string", default: "3" },
    out: {
      type: "string",
      default:
        process.env.OPENSTEER_MOBILE_BENCH_REPORT ??
        join(tmpdir(), `opensteer-mobile-network-${Date.now()}.json`),
    },
    "stall-every": { type: "string" },
    "stall-ms": { type: "string", default: "500" },
  },
});
const scenarios = [
  "cold-attach",
  "open-task",
  "reconnect",
  "foreground-after-30s",
  "network-change",
];
if (!(values.profile === "all" || Object.hasOwn(linkProfiles, values.profile!)))
  throw new Error("Unknown --profile");
if (!["all", "heavy", "light"].includes(values.seed!)) throw new Error("Unknown --seed");
if (!(values.scenario === "all" || scenarios.includes(values.scenario!)))
  throw new Error("Unknown --scenario");
for (const [name, value] of [
  ["runs", values.runs],
  ["stall-every", values["stall-every"]],
  ["stall-ms", values["stall-ms"]],
]) {
  if (value !== undefined && (!Number.isInteger(Number(value)) || Number(value) < 1))
    throw new Error(`--${name} must be a positive integer`);
}
const environment = { ...process.env, OPENSTEER_MOBILE_BENCH_OPTIONS: JSON.stringify(values) };
// The shared launcher provisions both templates, even though this benchmark only clones Host.
if (
  environment.OPENSTEER_TEST_DATABASE_URL &&
  !environment.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL
)
  environment.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL = environment.OPENSTEER_TEST_DATABASE_URL;
if (!environment.OPENSTEER_TEST_DATABASE_URL) {
  try {
    await promisify(execFile)("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 10_000,
    });
  } catch {
    console.error(
      "SKIPPED mobile-network benchmark: no PostgreSQL URL or running Docker daemon. Set OPENSTEER_TEST_DATABASE_URL (CREATE DATABASE permission required), or start Docker.",
    );
    process.exitCode = 2;
  }
}
if (!process.exitCode) {
  try {
    await runIntegrationTests({ config: "scripts/mobile-network.vitest.config.ts", environment });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode ||= 1;
  }
}
