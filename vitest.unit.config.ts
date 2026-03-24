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
    include: [
      "tests/browser-core/capabilities-and-errors.test.ts",
      "tests/browser-core/fake-engine.conformance.test.ts",
      "tests/browser-core/fake-engine.test.ts",
      "tests/browser-core/identity-and-geometry.test.ts",
      "tests/engine-abp/abp-unit.test.ts",
      "tests/opensteer/cli-schema.test.ts",
      "tests/opensteer/cloud-browser-profile.test.ts",
      "tests/opensteer/cookie-sync.test.ts",
      "tests/opensteer/engine-selection.test.ts",
      "tests/opensteer/filesystem-root.test.ts",
      "tests/opensteer/match-policy.test.ts",
      "tests/opensteer/policy.test.ts",
      "tests/opensteer/sdk-surface.test.ts",
      "tests/opensteer/skills-installer.test.ts",
      "tests/protocol/public-contract.test.ts",
    ],
    passWithNoTests: true,
  },
});
