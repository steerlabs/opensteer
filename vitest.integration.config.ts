import CiSequencer from "./scripts/ci-sequencer.js";
import { integrationTestInclude } from "./.github/scripts/ci-test-files.mjs";
import { homedir } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";
import { DefaultReporter } from "vitest/reporters";
import IntegrationFailureReporter from "./packages/database/src/integration-failure-reporter.test-support.js";
import { RunRecordReporter } from "./packages/database/src/run-record.test-support.js";

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
    ],
    maxWorkers: 4,
    maxConcurrency: 1,
    sequence: { concurrent: false, setupFiles: "list", sequencer: CiSequencer },
    include: integrationTestInclude,
    pool: "forks",
    isolate: true,
    retry: 0,
    // The default reporter keeps the final summary; the other prints each failure as it happens.
    // Both run inside the run record's reporter, which accounts for every one of their hooks.
    reporters: [new RunRecordReporter([new DefaultReporter(), new IntegrationFailureReporter()])],
    runner: "./packages/database/src/lock-order-runner.test-support.ts",
    // Integration hooks clone databases and start production services; give them the
    // same budget as the tests they set up.
    hookTimeout: 30_000,
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
