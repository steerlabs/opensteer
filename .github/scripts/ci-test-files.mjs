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
export const defaultTestExclude = [
  "**/*.integration.test.*",
  "**/*.gui.test.*",
  "**/*.engine.test.ts",
  "**/*.device.test.ts",
  "**/*.soak.test.ts",
];
