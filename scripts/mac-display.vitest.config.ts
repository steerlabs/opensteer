import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/mac-display.bench.ts"],
    testTimeout: 900_000,
    hookTimeout: 30_000,
    maxWorkers: 1,
    pool: "forks",
    restoreMocks: true,
  },
});
