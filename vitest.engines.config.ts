import { defineConfig } from "vitest/config";

// The engine qualification suite drives the shipped engines for real, so it
// runs one engine at a time and only through `pnpm test:engines`.
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./packages/database/src/test-database-setup.test-support.ts"],
    globalSetup: ["./packages/database/src/test-database-global-setup.test-support.ts"],
    fileParallelism: false,
    include: [
      "apps/**/*.engine.test.ts",
      "tests/**/*.engine.test.ts",
      "packages/**/*.engine.test.ts",
    ],
    pool: "forks",
    hookTimeout: 60_000,
    restoreMocks: true,
    testTimeout: 900_000,
  },
});
