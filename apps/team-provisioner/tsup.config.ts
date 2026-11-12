import { defineConfig } from "tsup";
import { nodeApp } from "../../scripts/tsup-node-app.js";

export default defineConfig(
  nodeApp({
    entry: ["src/main.ts"],
    external: [
      // One schema registry per process: bundled copies fail instanceof checks.
      "zod",
    ],
  }),
);
