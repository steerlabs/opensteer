import { defineConfig } from "vitest/config";
import integration from "../../../../../vitest.integration.config.js";

// Select this native journey explicitly inside pnpm test:vm. The ordinary
// integration suite must never start a Swift test process on the host.
export default defineConfig({
  ...integration,
  test: {
    ...integration.test,
    include: ["apps/mobile/modules/iphone-apps/journey/native.vm.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
