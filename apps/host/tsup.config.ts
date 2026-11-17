import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";
import { nodeApp } from "../../scripts/tsup-node-app.js";
import { hostProcessEntries } from "./src/process-entries.js";

export default defineConfig(
  nodeApp({
    entry: {
      main: hostProcessEntries.main,
      ...hostProcessEntries.workers,
      ...hostProcessEntries.processes,
      "stage-managed-secrets-main": "src/stage-managed-secrets-main.ts",
    },
    external: [
      // Native image decoder selects platform binaries at runtime.
      "sharp",
      // Selects its platform binary from a package at runtime.
      "workerd",
      // Runtime workers and protocol assets are located relative to this package.
      "@alchemy.run/cloudflare-runtime",
      // Codemode needs the JavaScript compiler API, not the workspace's native checker.
      "typescript-5",

      // CJS with dynamic requires of Node builtins; bundling breaks at load.
      "ws",
      // One schema registry per process: bundled copies fail instanceof checks.
      "zod",
    ],
    esbuildPlugins: [
      {
        name: "plugin-runtime-imports",
        setup(build) {
          // Codemode's compiler loads on first use; see codemode-transpile.ts.
          build.onResolve({ filter: /^#transpile$/ }, (args) =>
            args.importer.includes("@opencode-ai/codemode")
              ? {
                  path: fileURLToPath(
                    new URL("./src/plugins/codemode-transpile.ts", import.meta.url),
                  ),
                }
              : undefined,
          );
          build.onResolve({ filter: /^typescript$/ }, () => ({
            path: "typescript-5",
            external: true,
          }));
          build.onResolve({ filter: /^jsonc-parser$/ }, (args) =>
            build.resolve("jsonc-parser/lib/esm/main.js", {
              kind: args.kind,
              resolveDir: args.resolveDir,
            }),
          );
        },
      },
    ],
    optional: [
      // esbuild optionally resolves Yarn Plug'n'Play, absent in pnpm deployments.
      "pnpapi",
      // pg falls back to the JavaScript client when the native binding is absent.
      "pg-native",
      // Optional peer of @better-auth/core; unset means no tracing.
      "@opentelemetry/api",
    ],
  }),
);
