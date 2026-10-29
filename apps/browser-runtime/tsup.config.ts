import { defineConfig } from "tsup";
import { nodeApp } from "../../scripts/tsup-node-app.js";

export default defineConfig(
  nodeApp({
    entry: ["src/egress-main.ts", "src/main.ts"],
    external: [
      // Ships a driver and resolves its own package files relative to itself.
      "playwright-core",
      // CJS with dynamic requires of Node builtins; bundling breaks at load.
      "ws",
      // One schema registry per process: bundled copies fail instanceof checks.
      "zod",
    ],
  }),
);
