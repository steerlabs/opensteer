import { defineConfig } from "tsup";
import { nodeApp } from "../../scripts/tsup-node-app.js";

export default defineConfig(
  nodeApp({
    entry: ["src/main.ts"],
    external: ["zod"], // Schema users share one Zod instance.
  }),
);
