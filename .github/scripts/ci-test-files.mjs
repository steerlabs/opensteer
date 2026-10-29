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
// Storage retention and the phone cache take Darwin kernel locks (holdStorageLock in
// scripts/test-vm/retention.ts) and refuse to run elsewhere; the native-mac lane runs them.
export const darwinOnlyTests = [
  "tests/storage-retention.test.ts",
  "tests/release-phone-cache.test.ts",
];
export const defaultTestExclude = [
  "**/*.integration.test.*",
  "**/*.gui.test.*",
  "**/*.engine.test.ts",
  "**/*.device.test.ts",
  "**/*.soak.test.ts",
];
// The native-mac lane runs `node .github/scripts/ci-test-files.mjs darwin-only`.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] !== "darwin-only") throw new Error("Usage: ci-test-files.mjs darwin-only");
  console.log(darwinOnlyTests.join("\n"));
}
