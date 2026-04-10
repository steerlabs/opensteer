import { defineConfig } from "vitest/config";
import { opensteerVitestAliases, opensteerVitestInclude } from "./vitest.shared.js";

export default defineConfig({
  resolve: {
    alias: opensteerVitestAliases,
  },
  test: {
    environment: "node",
    fileParallelism: false,
    include: opensteerVitestInclude,
    passWithNoTests: true,
  },
});
