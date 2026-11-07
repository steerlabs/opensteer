import { configDefaults, defineConfig } from "vitest/config";
import { realBrowserTests } from "./.github/scripts/ci-test-files.mjs";

export default defineConfig({
  test: {
    include: realBrowserTests,
    exclude: configDefaults.exclude,
    env: { TZ: "UTC" },
    environment: "node",
    pool: "forks",
    maxWorkers: 2,
    testTimeout: 60_000,
    hookTimeout: 30_000,
    retry: 0,
    restoreMocks: true,
  },
});
