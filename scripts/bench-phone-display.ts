import { runIntegrationTests } from "./test-integration.js";

// The caller owns a dedicated emulator. Never select an incidental connected phone.
if (!/^emulator-\d+$/u.test(process.env.ANDROID_SERIAL ?? ""))
  throw new Error("Set ANDROID_SERIAL to a dedicated, booted Agent Phone emulator.");
await runIntegrationTests({
  config: "scripts/phone-display.vitest.config.ts",
  environment: process.env,
});
