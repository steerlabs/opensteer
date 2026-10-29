import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { TZ: "UTC" },
    environment: "node",
    exclude: configDefaults.exclude,
    include: [
      "apps/**/*.gui.test.ts",
      "apps/**/*.gui.test.tsx",
      "packages/**/*.gui.test.ts",
      "packages/**/*.gui.test.tsx",
      "tests/**/*.gui.test.ts",
      "tests/**/*.gui.test.tsx",
    ],
    fileParallelism: false,
    pool: "forks",
    restoreMocks: true,
  },
});
