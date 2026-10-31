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
const fullSuite = ["format:check", "lint", "typecheck", "build", "test", "test:integration"];
const runsFullSuite = (p) => p.commands.some((c) => c.length === 1 && fullSuite.includes(c[0]));
test("unknown keeps CI's full flag and reason without full local commands", () => {
  const p = localPlan(["mystery"], [], []);
  assert.ok(p.full);
  assert.ok(p.reasons.length);
  assert.ok(!runsFullSuite(p));
});
test("a global input runs the changed-file checks and every workspace typecheck, not CI's full suite", () => {
  const file = "tests/mobile-network/runner.test-support.ts";
  const p = localPlan([file], [{ name: "a", dir: "packages/a", deps: [], coverage: [] }], [file]);
  assert.ok(p.full);
  assert.ok(p.reasons.includes(`global input: ${file}`));
  assert.ok(!runsFullSuite(p));
  assert.ok(p.commands.some((c) => c.includes("prettier") && c.includes(file)));
  assert.ok(
    p.commands.some((c) => c.includes("--filter") && c.includes("a") && c.at(-1) === "typecheck"),
  );
  assert.ok(p.commands.some((c) => c.length === 1 && c[0] === "typecheck:tests"));
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
test("a root test edit alone still runs the test typecheck", () => {
  const p = localPlan(["tests/foo.test.ts"], [], ["tests/foo.test.ts"]);
  assert.equal(p.full, false);
  assert.ok(p.commands.some((c) => c.length === 1 && c[0] === "typecheck:tests"));
});
test("runs the Android wrapper from the workspace root without requiring an Android package manifest", () => {
  const p = localPlan(["apps/agent-phone/app/src/main/AndroidManifest.xml"], [], []);
  const android = p.commands.find((command) => command.some((arg) => arg.endsWith("gradlew")));
  assert.deepEqual(android?.slice(0, 5), [
    "exec",
    "./apps/agent-phone/gradlew",
    "-p",
    "apps/agent-phone",
    ":app:lint",
  ]);
});
