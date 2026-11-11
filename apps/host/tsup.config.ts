import { defineConfig } from "tsup";
import { nodeApp } from "../../scripts/tsup-node-app.js";
import { hostProcessEntries } from "./src/process-entries.js";

export default defineConfig(
  nodeApp({
    define: {
      "process.env.OPENSTEER_RUNNER_SOURCE_REVISION": JSON.stringify(
        process.env.OPENSTEER_RUNNER_SOURCE_REVISION ?? process.env.OPENSTEER_SOURCE_REVISION ?? "",
      ),
      "process.env.OPENSTEER_SOURCE_REVISION": JSON.stringify(
        process.env.OPENSTEER_SOURCE_REVISION ?? "",
      ),
      "process.env.OPENSTEER_IMAGE_REGISTRY": JSON.stringify(
        process.env.OPENSTEER_IMAGE_REGISTRY ?? "",
      ),
    },
    entry: {
      main: hostProcessEntries.main,
      ...hostProcessEntries.workers,
      "stage-managed-secrets-main": "src/stage-managed-secrets-main.ts",
    },
    external: [
      // Native image decoder selects platform binaries at runtime.
      "sharp",
      // Loads its WASM parser from a path relative to its own module.
      "libpg-query",
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
