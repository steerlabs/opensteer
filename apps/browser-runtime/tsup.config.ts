import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";
import { nodeApp } from "../../scripts/tsup-node-app.js";

export default defineConfig((cliOptions) => {
  const outDir = cliOptions.outDir ?? fileURLToPath(new URL("dist", import.meta.url));
  // Clean once before both parallel entries build so stale chunks are removed without racing.
  rmSync(outDir, { recursive: true, force: true });
  return [
    nodeApp({
      entry: ["src/main.ts"],
      outDir,
      clean: false,
      external: [
        // Loads platform-specific native file-lock prebuilds relative to its package.
        "fs-native-extensions",
        // Ships a driver and resolves its own package files relative to itself.
        "playwright-core",
        // CJS with dynamic requires of Node builtins; bundling breaks at load.
        "ws",
        // One schema registry per process: bundled copies fail instanceof checks.
        "zod",
      ],
    }),
    // Pool host enrolment downloads dist/egress-main.js as a single standalone file with no
    // sibling chunks and no node_modules directory.
    nodeApp({
      entry: ["src/egress-main.ts"],
      outDir,
      clean: false,
      splitting: false,
      external: [],
    }),
  ];
});
