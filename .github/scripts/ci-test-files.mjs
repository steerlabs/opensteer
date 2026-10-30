import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
// Shared by Vitest discovery and the dependency-free CI/local lane selector.
export const integrationTestInclude = [
  "apps/**/*.integration.test.ts",
  "apps/**/*.integration.test.tsx",
  "packages/**/*.integration.test.ts",
  "tests/**/*.integration.test.ts",
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
];
export const defaultTestExclude = [
  "**/*.integration.test.*",
  "**/*.gui.test.*",
  "**/*.engine.test.ts",
  "**/*.device.test.ts",
  "**/*.soak.test.ts",
  // VM journeys select their own config inside pnpm test:vm.
  "**/*.vm.test.*",
];
// The native-mac lane runs `node .github/scripts/ci-test-files.mjs darwin-only`.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] !== "darwin-only") throw new Error("Usage: ci-test-files.mjs darwin-only");
  console.log(darwinOnlyTests.join("\n"));
}
