import { configDefaults, defineConfig } from "vitest/config";
import { windowsTestInclude } from "./.github/scripts/ci-test-files.mjs";

// Real Windows behaviour (cmd.exe, NTFS, Job Objects, the CRT handle block),
// run only on the Windows CI job.
export default defineConfig({
  test: {
    env: { TZ: "UTC" },
    environment: "node",
    exclude: configDefaults.exclude,
    include: windowsTestInclude,
    pool: "forks",
    restoreMocks: true,
    setupFiles: ["./tests/process-supervisor-setup.test-support.ts"],
  },
});
