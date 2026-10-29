import { test } from "node:test";
import assert from "node:assert/strict";
import { validateResults } from "./ci-check.mjs";
import { lanes } from "./ci-changes.mjs";
const plan = { version: 1, lanes: Object.fromEntries(lanes.map((k) => [k, k === "lint"])) };
const results = {
  changes: {
    result: "success",
    outputs: Object.fromEntries(lanes.map((k) => [k, String(plan.lanes[k])])),
  },
  ...Object.fromEntries(lanes.map((k) => [k, { result: k === "lint" ? "success" : "skipped" }])),
};
test("docs-only explicit skips green", () =>
  assert.doesNotThrow(() => validateResults(plan, results, "pull_request")));
test("forced selected skip red", () =>
  assert.throws(() =>
    validateResults({ ...plan, lanes: { ...plan.lanes, tests: true } }, results, "pull_request"),
  ));
test("missing output red", () => {
  const r = structuredClone(results);
  delete r.changes.outputs.tests;
  assert.throws(() => validateResults(plan, r, "pull_request"));
});
test("main forbids skips and detector failure is red", () => {
  assert.throws(() => validateResults(plan, results, "push"));
  assert.throws(() =>
    validateResults(plan, { ...results, changes: { result: "failure" } }, "pull_request"),
  );
});

test("a failing or missing matrix lane cannot pass Check", () => {
  const selected = { version: 1, lanes: Object.fromEntries(lanes.map((k) => [k, true])) };
  const needs = {
    changes: { result: "success", outputs: Object.fromEntries(lanes.map((k) => [k, "true"])) },
    ...Object.fromEntries(lanes.map((k) => [k, { result: "success" }])),
  };
  assert.doesNotThrow(() => validateResults(selected, needs, "push"));
  for (const lane of ["native-mac", "tests", "integration"]) {
    for (const result of ["failure", "cancelled", "skipped"]) {
      assert.throws(() => validateResults(selected, { ...needs, [lane]: { result } }, "push"));
    }
    const missing = { ...needs };
    delete missing[lane];
    assert.throws(() => validateResults(selected, missing, "push"));
  }
});

test("Swift cache key generation fails when source enumeration fails", async () => {
  const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { parse } = await import("yaml");
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const script = workflow.jobs["native-mac"].steps.find((step) => step.id === "swift").run;
  const directory = mkdtempSync(join(tmpdir(), "swift-cache-key-"));
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    for (const command of ["swift", "xcodebuild", "xcrun"])
      writeFileSync(join(bin, command), "#!/bin/sh\necho toolchain\n", { mode: 0o755 });
    const git = join(bin, "git");
    const output = join(directory, "output");
    const run = () =>
      spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          RUNNER_TEMP: directory,
          GITHUB_OUTPUT: output,
        },
        encoding: "utf8",
      });
    writeFileSync(git, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    assert.notEqual(run().status, 0);
    writeFileSync(git, "#!/bin/sh\necho tracked-input\n", { mode: 0o755 });
    assert.equal(run().status, 0);
    assert.match(readFileSync(output, "utf8"), /^inputs=[a-f0-9]{64}$/m);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
