import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { nativeInputs, nativeInputsPath } from "../scripts/ci-native-inputs.js";

// The `changes` job selects native Mac tasks from this committed list, so a script
// that gains an import must also widen what selects its task.
it("lists exactly what each native Mac task's node scripts import", async () => {
  expect(
    JSON.parse(readFileSync(nativeInputsPath, "utf8")),
    "regenerate with: pnpm exec tsx scripts/ci-native-inputs.ts",
  ).toEqual(await nativeInputs());
});
