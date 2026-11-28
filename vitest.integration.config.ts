import CiSequencer from "./scripts/ci-sequencer.js";
import {
  integrationTestInclude,
  optInIntegrationBenchmarks,
} from "./.github/scripts/ci-test-files.mjs";
import { homedir } from "node:os";
import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";
import { DefaultReporter } from "vitest/reporters";
import IntegrationFailureReporter from "./packages/database/src/integration-failure-reporter.test-support.js";
import { RunRecordReporter } from "./packages/database/src/run-record.test-support.js";

const benchmarkSwitches: Record<string, string> = {
  "packages/database/src/personal-state-performance.integration.test.ts":
    "OPENSTEER_PERSONAL_STATE_PERF",
  "packages/database/src/personal-write-performance.integration.test.ts":
    "OPENSTEER_PERSONAL_WRITE_PERF",
};
// The pool's real-host proof is switched by a path to the run's endpoints, not by "1".
const realHostProof = "tests/browser-pool-guest.real-host.integration.test.ts";
const optedIn = (file: string) =>
  file === realHostProof
    ? Boolean(process.env.OPENSTEER_POOL_REAL_HOST)
    : process.env[benchmarkSwitches[file] ?? "OPENSTEER_TEAM_PERF"] === "1";

export default defineConfig({
  // Shared across worktrees, like the unit suite's: last-failed and slowest files run first.
  cacheDir: path.join(homedir(), ".cache/opensteer/vitest/integration"),
  test: {
    environment: "node",
    globalSetup: ["./packages/database/src/integration-global-setup.test-support.ts"],
    setupFiles: [
      "./packages/database/src/test-database-setup.test-support.ts",
      "./packages/database/src/integration-setup.test-support.ts",
      "./packages/database/src/lock-order-setup.test-support.ts",
      "./tests/process-supervisor-setup.test-support.ts",
    ],
    maxWorkers: 4,
    maxConcurrency: 1,
    sequence: { concurrent: false, setupFiles: "list", sequencer: CiSequencer },
    include: integrationTestInclude,
    exclude: [
      ...configDefaults.exclude,
      ...optInIntegrationBenchmarks.filter((file) => !optedIn(file)),
    ],
    pool: "forks",
    isolate: true,
    retry: 0,
    // The default reporter keeps the final summary; the other prints each failure as it happens.
    // Both run inside the run record's reporter, which accounts for every one of their hooks.
    reporters: [new RunRecordReporter([new DefaultReporter(), new IntegrationFailureReporter()])],
    runner: "./scripts/integration-quarantine-runner.ts",
    // Integration hooks clone databases and start production services; give them the
    // same budget as the tests they set up.
    hookTimeout: 30_000,
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
