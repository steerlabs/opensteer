import { defineConfig } from "tsup";

export function createPackageConfig() {
  return defineConfig({
    clean: true,
    dts: true,
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    sourcemap: true,
    target: "node22",
    treeshake: true,
  });
}
