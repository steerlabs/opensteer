import { defineConfig } from "tsup";
import { nodeApp } from "../../scripts/tsup-node-app.js";
import { runnerExternals } from "../../scripts/runner-build-options.js";

export default defineConfig(
  nodeApp({
    entry: ["src/main.ts", "src/verify-harness-runtimes-main.ts"],
    external: runnerExternals,
  }),
);
