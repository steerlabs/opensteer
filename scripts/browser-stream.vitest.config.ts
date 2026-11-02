import { defineConfig } from "vitest/config";
import integration from "../vitest.integration.config.js";

export default defineConfig({
  ...integration,
  test: {
    ...integration.test,
    include: ["tests/browser-stream.bench.ts"],
    maxWorkers: 1,
    hookTimeout: 60_000,
  },
});
