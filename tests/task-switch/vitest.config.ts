import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/task-switch/benchmark.ts"],
    globalSetup: ["./packages/database/src/test-database-global-setup.test-support.ts"],
    setupFiles: ["./packages/database/src/test-database-setup.test-support.ts"],
    maxWorkers: 1,
    testTimeout: 150_000,
    hookTimeout: 30_000,
  },
});
