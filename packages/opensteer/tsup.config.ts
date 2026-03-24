import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts", "src/cli/bin.ts"],
  format: ["esm", "cjs"],
  noExternal: ["@opensteer/browser-core", "@opensteer/cloud-contracts", "@opensteer/protocol"],
  sourcemap: true,
  target: "node22",
  treeshake: true,
});
