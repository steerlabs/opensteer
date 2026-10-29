import { test } from "node:test";
import assert from "node:assert/strict";
import { localPlan } from "./local-check.mjs";
test("changed and sibling tests, owning reverse dependents, without workspace builds", () => {
  const p = localPlan(
    ["packages/a/value.ts"],
    [
      { name: "a", dir: "packages/a", deps: [], coverage: [] },
      { name: "b", dir: "packages/b", deps: ["a"], coverage: [] },
    ],
    ["packages/a/value.test.ts"],
  );
  assert.deepEqual(p.tests, ["packages/a/value.test.ts"]);
  assert.ok(p.commands.some((c) => c.includes("b")));
  assert.ok(!p.commands.some((c) => c.includes("build")));
});
test("unknown falls back with reason", () => {
  const p = localPlan(["mystery"], [], []);
  assert.ok(p.full);
  assert.ok(p.reasons.length);
  assert.ok(p.commands.some((c) => c.includes("test")));
});
test("routes integration and GUI siblings through their owned launchers", () => {
  const p = localPlan(
    ["packages/a/value.ts"],
    [{ name: "a", dir: "packages/a", deps: [], coverage: [] }],
    ["packages/a/value.integration.test.ts", "packages/a/value.gui.test.ts"],
  );
  assert.ok(p.commands.some((c) => c[0] === "test:integration"));
  assert.ok(p.commands.some((c) => c[0] === "test:vm"));
  assert.ok(
    !p.commands.some((c) => c.includes("vitest") && c.some((a) => a.includes(".gui.test."))),
  );
});
test("Node fixture tests run through Node even for global CI inputs", () => {
  const p = localPlan([".github/scripts/a.mjs"], [], [".github/scripts/a.test.mjs"]);
  assert.ok(
    p.commands.some(
      (c) => c.includes("node") && c.includes("--test") && c.includes(".github/scripts/a.test.mjs"),
    ),
  );
});
