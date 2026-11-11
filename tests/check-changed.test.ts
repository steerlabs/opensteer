import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { realBrowserTests } from "../.github/scripts/ci-test-files.mjs";
import { localPlan } from "../.github/scripts/local-check.mjs";
import { changedPlan, checkablePaths } from "../scripts/check-changed.js";
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
it("selects the test that validates a changed data file", () => {
  const plan = localPlan(
    ["tests/quarantine.json"],
    [],
    ["tests/quarantine.json", "tests/quarantine.test.ts"],
  );
  expect(plan.tests).toEqual(["tests/quarantine.test.ts"]);
});
it("fails instead of planning nothing when the base cannot be read", () => {
  // There is no full local fallback, so an empty plan here would pass silently.
  expect(() => changedPlan("refs/heads/check-changed-missing-base")).toThrow(/merge-base/);
});
it("leaves symbolic links and missing paths out of the checked files", () => {
  const directory = mkdtempSync(join(tmpdir(), "check-changed-"));
  try {
    mkdirSync(join(directory, "skills"));
    writeFileSync(join(directory, "skills", "SKILL.md"), "# Skill\n");
    symlinkSync("skills", join(directory, "linked-skills"));
    expect(checkablePaths(directory, ["skills/SKILL.md", "linked-skills", "deleted.ts"])).toEqual([
      "skills/SKILL.md",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps listed browser tests out of ordinary changed-file execution", () => {
  const selected = realBrowserTests.flatMap((file) => [file.replace(/\.test\.tsx?$/, ".ts"), file]);
  const plan = localPlan(realBrowserTests, [], selected);
  expect(plan.commands.filter((command: string[]) => command[0] === "test:browser")).toEqual([
    ["test:browser", ...realBrowserTests],
  ]);
  expect(plan.commands.some((command: string[]) => command.includes("vitest"))).toBe(false);
  expect(plan.lanes["browser-journeys"]).toBe(true);
});
