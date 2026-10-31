import { defineConfig } from "vitest/config";
import device from "../vitest.device.config.js";

export default defineConfig({
  ...device,
  test: {
    ...device.test,
    include: ["tests/phone-display.bench.ts"],
    maxWorkers: 1,
  },
});
