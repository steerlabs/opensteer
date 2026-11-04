import { defineConfig } from "tsup";
import { smokeConfig } from "./tsup.electron-smoke.config.js";

export default defineConfig({
  ...smokeConfig,
  external: [...smokeConfig.external, "playwright-core"],
  entry: [
    ...smokeConfig.entry,
    "scripts/native-browser-journey.ts",
    "scripts/electron-native-browser-child.ts",
  ],
});
