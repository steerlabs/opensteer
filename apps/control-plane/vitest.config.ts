import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // PostgreSQL integration files migrate and truncate the same explicitly
    // dedicated test database. Run files serially so those global DDL locks do
    // not race while unit tests still run in their normal workers.
    fileParallelism: false,
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
  },
});
