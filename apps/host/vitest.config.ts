import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Device tests drive a real Android phone or emulator: `pnpm test:agent-phone`.
    exclude: [...configDefaults.exclude, "**/*.device.test.ts", "**/*.soak.test.ts"],
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
  },
});
