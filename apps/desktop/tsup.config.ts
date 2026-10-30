import { defineConfig } from "tsup";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { nodeApp } from "../../scripts/tsup-node-app.js";
import { runnerExternals } from "../../scripts/runner-build-options.js";

import { stagePasskeysAddon } from "./scripts/build-passkeys-addon.js";
import { signingBuildPlugin } from "./scripts/signing-build-plugin.js";

export default defineConfig([
  nodeApp({
    entry: ["src/main.ts", "src/runner-worker.ts"],
    esbuildPlugins: [signingBuildPlugin()],
    metafile: true,
    external: runnerExternals,
    optional: [
      // Electron supplies this module itself; it is never installed with the app.
      "electron",
    ],
    onSuccess: async () => {
      await stagePasskeysAddon();
      await mkdir("dist", { recursive: true });
      const releaseTarget = path.join("dist", "desktop-release.json");
      // Release builds copy the manifest prepare-release-resources staged and
      // validated. This config loads without the workspace's TypeScript sources,
      // so it never imports them; development builds simply drop the feed and
      // never update themselves.
      if (process.env.OPENSTEER_DESKTOP_RELEASE === "1") {
        await copyFile(path.join("generated-resources", "desktop", "release.json"), releaseTarget);
      } else {
        const release = JSON.parse(
          await readFile(path.join("src", "releases", "desktop-release.source.json"), "utf8"),
        ) as Record<string, unknown>;
        delete release.updates;
        await writeFile(releaseTarget, JSON.stringify(release, null, 2) + "\n");
      }
      await copyFile("resources/trayTemplate.png", path.join("dist", "trayTemplate.png"));
      await copyFile("resources/trayTemplate@2x.png", path.join("dist", "trayTemplate@2x.png"));
    },
  }),
  {
    clean: false,
    esbuildPlugins: [signingBuildPlugin()],
    entry: {
      "glass-preload": "src/browser/glass-preload.ts",
      "browser-page-preload": "src/browser/browser-page-preload.ts",
      preload: "src/preload.ts",
    },
    // A sandboxed preload cannot resolve ordinary Node packages. Keep this
    // bridge self-contained and leave only Electron's provided API external.
    external: ["electron"],
    format: ["cjs"],
    noExternal: [/^@opensteer\//, "zod"],
    outExtension: () => ({ js: ".cjs" }),
    sourcemap: true,
    target: "node24",
  },
]);
