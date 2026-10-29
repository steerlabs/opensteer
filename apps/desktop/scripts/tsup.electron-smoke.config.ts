import { signingBuildPlugin } from "./signing-build-plugin.js";
import { build, defineConfig } from "tsup";
import path from "node:path";

const smokeOutDir = process.env.OPENSTEER_ELECTRON_SMOKE_OUTDIR ?? ".electron-smoke";

export const smokeConfig = {
  esbuildPlugins: [signingBuildPlugin()],
  // Empties the smoke directory, so fixtures that live in it (the passwords
  // policy broker) are built after this step.
  clean: true,
  entry: [
    "scripts/electron-downloads-smoke.ts",
    "scripts/editing-engine-journey.ts",
    "scripts/electron-attachment-smoke.ts",
    "scripts/electron-host-transport-smoke.ts",
    "scripts/electron-browser-cookie-smoke.ts",
    "scripts/electron-profile-restore-smoke.ts",
    "scripts/electron-browser-focus-smoke.ts",
    "scripts/electron-browser-passkey-smoke.ts",
    "scripts/electron-browser-smoke.ts",
    "scripts/electron-cdp-boundary-smoke.ts",
    "scripts/electron-computer-use-smoke.ts",
    "scripts/electron-display-smoke.ts",
    "scripts/electron-passwords-smoke.ts",
    "scripts/electron-quit-smoke.ts",
    "scripts/quit-runner-worker.ts",
    "scripts/harness-owner-smoke.ts",
    "scripts/electron-usb-smoke.ts",
  ],
  external: ["electron"],
  banner: {
    js: "import { createRequire as __smokeCreateRequire } from 'node:module'; const require = __smokeCreateRequire(import.meta.url);",
  },
  format: ["esm"],
  noExternal: [/^@opensteer\//],
  // Browser pages load the page policy preload in a sandboxed renderer, which
  // runs CommonJS only; built after the clean so it sits beside the smokes.
  onSuccess: async () => {
    await build({
      clean: false,
      config: false,
      esbuildPlugins: [signingBuildPlugin()],
      entry: {
        "display-renderer-smoke": "scripts/electron-display-renderer-smoke.ts",
        "idle-renderer-smoke": "../web/src/desktop/idle-visibility.electron-smoke.tsx",
        "host-transport-renderer-smoke": "scripts/electron-host-transport-renderer-smoke.ts",
        "usb-renderer-smoke": "scripts/electron-usb-renderer-smoke.ts",
      },
      define: { "import.meta.env": JSON.stringify({ MODE: "test", DEV: false, PROD: false }) },
      format: ["iife"],
      platform: "browser",
      esbuildOptions: (options) => {
        options.jsx = "automatic";
        options.nodePaths = [path.resolve(import.meta.dirname, "../../web/node_modules")];
      },
      noExternal: [/.*/],
      outDir: smokeOutDir,
      target: "chrome152",
      silent: true,
    });
    await build({
      clean: false,
      config: false,
      esbuildPlugins: [signingBuildPlugin()],
      entry: {
        "browser-page-preload": "src/browser/browser-page-preload.ts",
        // The desktop's own panel preload, for the passwords smoke's toolbars.
        "desktop-preload": "src/preload.ts",
      },
      external: ["electron"],
      format: ["cjs"],
      noExternal: [/^@opensteer\//, "zod"],
      outDir: smokeOutDir,
      outExtension: () => ({ js: ".cjs" }),
      silent: true,
      target: "node24",
    });
  },
  outDir: smokeOutDir,
  platform: "node",
  sourcemap: true,
  target: "node24",
} satisfies import("tsup").Options;

export default defineConfig(smokeConfig);
