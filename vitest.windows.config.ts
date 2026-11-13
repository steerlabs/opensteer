import { windowsTestInclude } from "./.github/scripts/ci-test-files.mjs";
import { configDefaults, defineConfig } from "vitest/config";

// These prove real Windows behaviour; elsewhere they would prove nothing.
if (process.platform !== "win32")
  throw new Error("vitest.windows.config.ts runs only on Windows (the native-windows CI lane)");

export default defineConfig({
  test: {
    env: { TZ: "UTC" },
    environment: "node",
    include: windowsTestInclude,
    exclude: configDefaults.exclude,
    // An empty run would vouch for nothing; ci-check.ts also holds the inventory to the tracked files.
    passWithNoTests: false,
    pool: "forks",
    restoreMocks: true,
    setupFiles: ["./tests/process-supervisor-setup.test-support.ts"],
    testTimeout: 30_000,
  },
});
