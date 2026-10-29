import { configDefaults, defineConfig } from "vitest/config";

// The device suites drive a real Android phone or emulator through the real
// Host, so they run one file at a time and only through `pnpm test:agent-phone`.
// A release journey with ten unattended reboots runs for most of an hour, and
// the real-agent file waits on a real engine; it runs only when
// OPENSTEER_AGENT_PHONE_AGENT_ENGINE names one.
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./packages/database/src/test-database-setup.test-support.ts"],
    globalSetup: ["./packages/database/src/test-database-global-setup.test-support.ts"],
    exclude: [...configDefaults.exclude, "**/*.soak.test.ts"],
    fileParallelism: false,
    include: ["apps/**/*.device.test.ts"],
    pool: "forks",
    hookTimeout: 900_000,
    restoreMocks: true,
    testTimeout: 7_200_000,
  },
});
