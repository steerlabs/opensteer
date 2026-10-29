import { defineConfig } from "tsup";
import { nodeApp } from "../../scripts/tsup-node-app.js";
import { runnerExternals } from "../../scripts/runner-build-options.js";

export default defineConfig(
  nodeApp({
    entry: ["src/test-fixtures/recovery-runner.test-support.ts"],
    outDir: "dist-integration",
    metafile: true,
    external: runnerExternals,
  }),
);
