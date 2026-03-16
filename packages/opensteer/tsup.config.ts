import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts", "src/cli/bin.ts"],
  format: ["esm", "cjs"],
  sourcemap: true,
  target: "node24",
  treeshake: true,
});
