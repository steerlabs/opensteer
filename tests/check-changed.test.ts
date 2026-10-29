import { expect, it } from "vitest";
import { localPlan } from "../.github/scripts/local-check.mjs";
it("selects sibling tests and reverse workspace consumers", () => {
  const plan = localPlan(
    ["packages/a/value.ts"],
    [
      { name: "a", dir: "packages/a", deps: [], coverage: [] },
      { name: "b", dir: "packages/b", deps: ["a"], coverage: [] },
    ],
    ["packages/a/value.ts", "packages/a/value.test.ts"],
  );
  expect(plan.tests).toEqual(["packages/a/value.test.ts"]);
  expect(plan.affected).toEqual(["a", "b"]);
});
