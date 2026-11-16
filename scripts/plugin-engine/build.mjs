import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const entries = Object.fromEntries(
  Object.entries(manifest.exports)
    .filter(([, file]) => typeof file === "string" && /\.[jt]sx?$/.test(file))
    .map(([name, file]) => [name === "." ? "index" : name.slice(2), resolve(file)]),
);
await build({
  entryPoints: entries,
  outdir: "dist",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node24",
  splitting: true,
  sourcemap: true,
});
