import { defineConfig } from "vitest/config";

// Opt-in only: a dedicated device, the real Host and PostgreSQL stay up for
// the entire soak. The maximum Node timer covers up to three weeks plus setup.
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./packages/database/src/test-database-setup.test-support.ts"],
    globalSetup: ["./packages/database/src/test-database-global-setup.test-support.ts"],
    fileParallelism: false,
    include: ["apps/**/*.soak.test.ts"],
    pool: "forks",
    hookTimeout: 900_000,
    restoreMocks: true,
    testTimeout: 2_147_483_647,
  },
});
