import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const directory = path.dirname(fileURLToPath(import.meta.url));
const fixture = {
  teamId: "ABCDE12345",
  identity: "Developer ID Application: Example (ABCDE12345)",
};
const generated = path.join(directory, "build/generated");
mkdirSync(generated, { recursive: true });
const fixturePath = path.join(generated, "test-signing.json");
writeFileSync(fixturePath, JSON.stringify(fixture));
process.env.OPENSTEER_DESKTOP_SIGNING_FILE = fixturePath;
delete process.env.OPENSTEER_DESKTOP_DEVELOPMENT_TRUST;

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
  },
});
