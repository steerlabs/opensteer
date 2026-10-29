import { defineConfig } from "tsup";
import { nodeApp } from "../../scripts/tsup-node-app.js";

export default defineConfig(
  nodeApp({
    entry: ["src/main.ts", "src/migrate-main.ts"],
    external: [
      // One schema registry per process: bundled copies fail instanceof checks.
      "zod",
    ],
    optional: [
      // pg falls back to the JavaScript client when the native binding is absent.
      "pg-native",
      // Optional peer of @better-auth/core; unset means no tracing.
      "@opentelemetry/api",
    ],
  }),
);
