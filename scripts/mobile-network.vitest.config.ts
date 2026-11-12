import { configDefaults, defineConfig } from "vitest/config";
import integration from "../vitest.integration.config.js";

export default defineConfig({
  ...integration,
  test: {
    ...integration.test,
    include: JSON.parse(process.env.OPENSTEER_MOBILE_BENCH_OPTIONS ?? "{}").seed?.startsWith("team")
      ? ["tests/team-mobile-network.integration.test.ts"]
      : [
          "tests/mobile-network-bench.integration.test.ts",
          "tests/team-mobile-network.integration.test.ts",
        ],
    exclude: configDefaults.exclude,
    maxWorkers: 1,
    testTimeout: 3_600_000,
    hookTimeout: 60_000,
  },
});
