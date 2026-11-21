import testExtraInputs from "./ci-test-extra-inputs.json" with { type: "json" };
export { testExtraInputs };
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
// Shared by Vitest discovery and the dependency-free CI/local lane selector.
export const integrationTestInclude = [
  "apps/**/*.integration.test.ts",
  "apps/**/*.integration.test.tsx",
  "packages/**/*.integration.test.ts",
  "tests/**/*.integration.test.ts",
];
export const realBrowserTests = [
  "apps/browser-runtime/src/browser/agent-cursor.test.ts",
  "apps/browser-runtime/src/browser/browser-test-lifecycle.test.ts",
  "apps/browser-runtime/src/browser/chromium-clipboard.test.ts",
  "apps/browser-runtime/src/browser/chromium-follow-view.test.ts",
  "apps/browser-runtime/src/browser/chromium-popup-follow.test.ts",
  "apps/browser-runtime/src/browser/chromium-renderer-leak.test.ts",
  "apps/browser-runtime/src/browser/chromium-runtime.test.ts",
  "apps/browser-runtime/src/browser/chromium-session-restore.test.ts",
  "apps/browser-runtime/src/browser/chromium-tab-identity.test.ts",
  "apps/browser-runtime/src/browser/chromium-tab-sleep.test.ts",
  "apps/browser-runtime/src/browser/chromium-teardown.test.ts",
  "apps/browser-runtime/src/browser/chromium-viewport-capture.test.ts",
  "apps/browser-runtime/src/browser/drag-cancel.test.ts",
  "apps/browser-runtime/src/browser/editing.test.ts",
  "apps/browser-runtime/src/browser/favicon.test.ts",
  "apps/browser-runtime/src/browser/harness-actions-deadlines.test.ts",
  "apps/browser-runtime/src/browser/harness-actions-input-lifecycle.test.ts",
  "apps/browser-runtime/src/browser/harness-actions.test.ts",
  "apps/browser-runtime/src/browser/navigation.test.ts",
  "apps/browser-runtime/src/browser/passkey-provider.test.ts",
  "apps/browser-runtime/src/browser/person-save.test.ts",
  "apps/browser-runtime/src/browser/playwright-cdp.test.ts",
  "apps/browser-runtime/src/browser/session-files.test.ts",
  "apps/web/src/components/apps/app-isolation.test.ts",
  "apps/web/src/components/workspace/workspace-tabs-chromium.interaction.test.tsx",
  "tests/browser-repl.test.ts",
  "tests/passkey-relay-provider.test.ts",
  "tests/passkey-routing.test.ts",
];
export const defaultTestInclude = [
  "apps/**/*.test.ts",
  "apps/**/*.test.tsx",
  "packages/**/*.test.ts",
  "evals/**/*.test.ts",
  "tests/**/*.test.ts",
];
// These need Darwin: kernel locks (holdStorageLock in scripts/test-vm/retention.ts,
// kernelLock.ts), BSD group inheritance, the Mac helpers, or the Swift wire core. Elsewhere
// they skip every case, so Linux shards leave them out and the native-mac lane runs them.
export const darwinOnlyTests = [
  "tests/storage-retention.test.ts",
  "tests/release-phone-cache.test.ts",
  "tests/desktop-public-release.test.ts",
  "tests/kernel-lock.test.ts",
  "tests/vm-slot-queue.test.ts",
  "tests/mac-app-delivery.test.ts",
  "tests/iphone-apps-wire.test.ts",
  "apps/desktop/src/computer-use/computer-use-service.test.ts",
  "apps/desktop/src/passwords/broker-client.test.ts",
  "apps/desktop/scripts/codesign-requirement.test.ts",
];
// Opt-in measurements that skip every case unless their benchmark command supplies options, so
// integration discovery leaves them out: `pnpm bench:mobile-network`, OPENSTEER_TEAM_PERF=1,
// OPENSTEER_PERSONAL_STATE_PERF=1 and OPENSTEER_PERSONAL_WRITE_PERF=1.
export const optInIntegrationBenchmarks = [
  "packages/database/src/personal-state-performance.integration.test.ts",
  "packages/database/src/personal-write-performance.integration.test.ts",
  "tests/team-mobile-network.integration.test.ts",
  "tests/team-performance.integration.test.ts",
];
// These write and verify a package of the most files one may hold, over 10,000 real files
// each. They need the integration lane's time, not its database.
export const fileBoundIntegrationTests = [
  "apps/host/src/local-servers/folder-plugin-package.integration.test.ts",
  "apps/runner/src/skills/plugin-cache.integration.test.ts",
  "packages/agent-plugins/src/loader.integration.test.ts",
];
// Real Windows behaviour (the supervisor's Job, cmd, junctions, a non-administrator token).
// Only the native-windows lane runs them, through vitest.windows.config.ts.
export const windowsTestInclude = [
  "apps/**/*.windows.test.ts",
  "packages/**/*.windows.test.ts",
  "tests/**/*.windows.test.ts",
];
export const defaultTestExclude = [
  "**/*.integration.test.*",
  "**/*.gui.test.*",
  "**/*.engine.test.ts",
  "**/*.device.test.ts",
  "**/*.soak.test.ts",
  // Windows-real tests run on the Windows job through vitest.windows.config.ts.
  "**/*.windows.test.ts",
  // VM journeys select their own config inside pnpm test:vm.
  "**/*.vm.test.*",
];
// The native-mac lane runs `node .github/scripts/ci-test-files.mjs darwin-only`.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] !== "darwin-only") throw new Error("Usage: ci-test-files.mjs darwin-only");
  console.log(darwinOnlyTests.join("\n"));
}
