import { defineConfig } from "tsup";
import { nodeApp } from "../../scripts/tsup-node-app.js";
import { hostProcessEntries } from "./src/process-entries.js";

export default defineConfig(
  nodeApp({
    entry: {
      main: hostProcessEntries.main,
      ...hostProcessEntries.workers,
      "stage-managed-secrets-main": "src/stage-managed-secrets-main.ts",
    },
    external: [
      // Native image decoder selects platform binaries at runtime.
      "sharp",
      // CJS with dynamic requires of Node builtins; bundling breaks at load.
      "ws",
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
