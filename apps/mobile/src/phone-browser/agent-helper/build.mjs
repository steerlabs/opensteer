import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: [fileURLToPath(new URL("./entry.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("./dist/agent-helper.js", import.meta.url)),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "safari17",
  minify: true,
  legalComments: "none",
});
