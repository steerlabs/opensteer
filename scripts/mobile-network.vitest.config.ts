import { defineConfig } from "vitest/config";
import integration from "../vitest.integration.config.js";

export default defineConfig({
  ...integration,
  test: {
    ...integration.test,
    include: ["tests/mobile-network-bench.integration.test.ts"],
    maxWorkers: 1,
    testTimeout: 3_600_000,
    hookTimeout: 60_000,
  },
});
