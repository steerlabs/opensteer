import { expect, it } from "vitest";
import { localPlan } from "../.github/scripts/local-check.mjs";
import { changedPlan } from "../scripts/check-changed.js";
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
it("fails instead of planning nothing when the base cannot be read", () => {
  // There is no full local fallback, so an empty plan here would pass silently.
  expect(() => changedPlan("refs/heads/check-changed-missing-base")).toThrow(/merge-base/);
});
