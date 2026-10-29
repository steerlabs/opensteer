import { signingBuildPlugin } from "./signing-build-plugin.js";
import { defineConfig } from "tsup";

const outDir = process.env.OPENSTEER_ELECTRON_SMOKE_OUTDIR ?? ".electron-smoke";

// Focused VM runs build only their journey and its production page preload.
export default defineConfig([
  {
    clean: false,
    entry: ["scripts/electron-passwords-smoke.ts"],
    esbuildPlugins: [signingBuildPlugin()],
    external: ["electron"],
    banner: {
      js: "import { createRequire as __smokeCreateRequire } from 'node:module'; const require = __smokeCreateRequire(import.meta.url);",
    },
    format: ["esm"],
    noExternal: [/^@opensteer\//],
    outDir,
    platform: "node",
    sourcemap: true,
    target: "node24",
  },
  {
    clean: false,
    esbuildPlugins: [signingBuildPlugin()],
    entry: { "browser-page-preload": "src/browser/browser-page-preload.ts" },
    external: ["electron"],
    format: ["cjs"],
    noExternal: [/^@opensteer\//, "zod"],
    outDir,
    outExtension: () => ({ js: ".cjs" }),
    platform: "node",
    target: "node24",
  },
]);
