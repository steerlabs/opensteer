import { defineConfig } from "tsup";
import { nodeApp } from "../../scripts/tsup-node-app.js";
import { pluginEngineBuildPlugin } from "../../scripts/plugin-engine/node-build.js";
import { readBrowserGuestModules } from "./src/browser-use/browser-guest-source.js";
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
      // Codemode needs the JavaScript compiler API, not the workspace's native checker.
      "typescript-5",

      // CJS with dynamic requires of Node builtins; bundling breaks at load.
      "ws",
      // One schema registry per process: bundled copies fail instanceof checks.
      "zod",
    ],
    define: { __OPENSTEER_BROWSER_GUEST_MODULES__: JSON.stringify(readBrowserGuestModules()) },
    esbuildPlugins: [pluginEngineBuildPlugin],
    optional: [
      // The runtime uses NodeServices here; its Bun peer is never loaded.
      "@effect/platform-bun",
      // Optional proxy support in the runtime's browser downloader falls back to Node.
      "proxy-agent",
      // esbuild optionally resolves Yarn Plug'n'Play, absent in pnpm deployments.
      "pnpapi",
      // pg falls back to the JavaScript client when the native binding is absent.
      "pg-native",
      // Optional peer of @better-auth/core; unset means no tracing.
      "@opentelemetry/api",
    ],
  }),
);
