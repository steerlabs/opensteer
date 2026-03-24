import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@opensteer/browser-core": path.resolve(__dirname, "packages/browser-core/src/index.ts"),
      "@opensteer/engine-abp": path.resolve(__dirname, "packages/engine-abp/src/index.ts"),
      "@opensteer/engine-playwright": path.resolve(
        __dirname,
        "packages/engine-playwright/src/index.ts",
      ),
      "@opensteer/protocol": path.resolve(__dirname, "packages/protocol/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    passWithNoTests: true,
  },
});
