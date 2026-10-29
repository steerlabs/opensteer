import { expect, it } from "vitest";
import { harnessRuntimeVersionMismatches } from "./verify-harness-runtimes.js";

it("executes every shipped engine and checks its exact --version without accounts", async () => {
  await expect(harnessRuntimeVersionMismatches(process.execPath)).resolves.toEqual([]);
});
