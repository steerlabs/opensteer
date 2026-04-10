import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts", "src/cli/bin.ts", "src/local-view/serve-entry.ts"],
  external: ["webcrack"],
  format: ["esm", "cjs"],
  noExternal: ["@opensteer/browser-core", "@opensteer/protocol", "@opensteer/runtime-core"],
  sourcemap: true,
  target: "node22",
  treeshake: true,
});
