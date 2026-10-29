import { defineConfig } from "vitest/config";
import integration from "./vitest.integration.config.js";

export default defineConfig({
  ...integration,
  test: {
    ...integration.test,
    globalSetup: ["./tests/migration-compat-global-setup.test-support.ts"],
    include: ["tests/migration-compat-journey.test-support.ts"],
    maxWorkers: 1,
  },
});
