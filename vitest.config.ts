import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@opensteer/browser-core": path.resolve(__dirname, "packages/browser-core/src/index.ts"),
      "@opensteer/conformance": path.resolve(__dirname, "packages/conformance/src/index.ts"),
      "@opensteer/engine-abp": path.resolve(__dirname, "packages/engine-abp/src/index.ts"),
      "@opensteer/engine-playwright": path.resolve(
        __dirname,
        "packages/engine-playwright/src/index.ts",
      ),
      "@opensteer/protocol": path.resolve(__dirname, "packages/protocol/src/index.ts"),
      "@opensteer/runtime-core": path.resolve(__dirname, "packages/runtime-core/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: [
      "tests/browser-core/capabilities-and-errors.test.ts",
      "tests/browser-core/fake-engine.conformance.test.ts",
      "tests/browser-core/fake-engine.test.ts",
      "tests/browser-core/identity-and-geometry.test.ts",
      "tests/engine-abp/abp-engine.test.ts",
      "tests/engine-abp/abp-unit.test.ts",
      "tests/opensteer/browser-manager.test.ts",
      "tests/opensteer/cli-v2.test.ts",
      "tests/opensteer/cloud-browser-profile.test.ts",
      "tests/opensteer/conformance-local.test.ts",
      "tests/opensteer/evaluate-null.test.ts",
      "tests/opensteer/extraction-descriptor.test.ts",
      "tests/opensteer/live-session.test.ts",
      "tests/opensteer/local-browser-stealth.test.ts",
      "tests/opensteer/request-plan-replay.test.ts",
      "tests/opensteer/runtime-recipes.test.ts",
      "tests/opensteer/sdk-surface.test.ts",
      "tests/opensteer/skills-installer.test.ts",
      "tests/opensteer/workspace-root.test.ts",
      "tests/protocol/public-contract.test.ts",
    ],
    passWithNoTests: true,
  },
});
