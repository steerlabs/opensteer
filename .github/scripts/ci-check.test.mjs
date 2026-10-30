import { test } from "node:test";
import assert from "node:assert/strict";
import { validateResults } from "./ci-check.mjs";
import { allNativeMacTasks, lanes, nativeMacMatrix } from "./ci-changes.mjs";
const plan = {
  version: 1,
  nativeMac: [],
  lanes: Object.fromEntries(lanes.map((k) => [k, k === "lint"])),
};
const results = {
  changes: {
    result: "success",
    outputs: {
      ...Object.fromEntries(lanes.map((k) => [k, String(plan.lanes[k])])),
      "native-mac-tasks": "[]",
    },
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
  const selected = {
    version: 1,
    nativeMac: allNativeMacTasks,
    lanes: Object.fromEntries(lanes.map((k) => [k, true])),
  };
  const needs = {
    changes: {
      result: "success",
      outputs: {
        ...Object.fromEntries(lanes.map((k) => [k, "true"])),
        "native-mac-tasks": JSON.stringify(nativeMacMatrix(allNativeMacTasks)),
      },
    },
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

test("Check holds the native-mac task list to the plan, and main to every task", () => {
  const iphone = {
    ...plan,
    nativeMac: ["iphone"],
    lanes: { ...plan.lanes, "native-mac": true },
  };
  const needs = structuredClone(results);
  needs.changes.outputs["native-mac"] = "true";
  needs.changes.outputs["native-mac-tasks"] = JSON.stringify(nativeMacMatrix(["iphone"]));
  needs["native-mac"] = { result: "success" };
  assert.doesNotThrow(() => validateResults(iphone, needs, "pull_request"));
  const widened = structuredClone(needs);
  widened.changes.outputs["native-mac-tasks"] = JSON.stringify(
    nativeMacMatrix(["iphone", "passwords-tests"]),
  );
  assert.throws(() => validateResults(iphone, widened, "pull_request"), /native-mac-tasks/);
  const missing = structuredClone(needs);
  delete missing.changes.outputs["native-mac-tasks"];
  assert.throws(() => validateResults(iphone, missing, "pull_request"), /native-mac-tasks/);
  assert.throws(
    () => validateResults({ ...iphone, nativeMac: [] }, needs, "pull_request"),
    /native-mac-tasks/,
  );
  // The lane flag must agree with the task list, even when the output matches it.
  const quiet = { ...iphone, lanes: { ...iphone.lanes, "native-mac": false } };
  const quietNeeds = structuredClone(needs);
  quietNeeds.changes.outputs["native-mac"] = "false";
  assert.throws(() => validateResults(quiet, quietNeeds, "pull_request"), /native-mac-tasks/);
  const all = Object.fromEntries(lanes.map((k) => [k, true]));
  const main = structuredClone(needs);
  for (const lane of lanes) {
    main.changes.outputs[lane] = "true";
    main[lane] = { result: "success" };
  }
  // Main picks its macOS tasks per push; the scheduled and manual runs take them all.
  assert.doesNotThrow(() => validateResults({ ...iphone, lanes: all }, main, "push"));
  for (const event of ["schedule", "workflow_dispatch"])
    assert.throws(
      () => validateResults({ ...iphone, lanes: all }, main, event),
      /forbid skipping native-mac tasks/,
    );
  const noMac = structuredClone(main);
  noMac.changes.outputs["native-mac"] = "false";
  noMac.changes.outputs["native-mac-tasks"] = "[]";
  noMac["native-mac"] = { result: "skipped" };
  const linuxOnly = { ...iphone, nativeMac: [], lanes: { ...all, "native-mac": false } };
  assert.doesNotThrow(() => validateResults(linuxOnly, noMac, "push"));
  assert.throws(() => validateResults(linuxOnly, noMac, "schedule"), /forbid/);
  // Every other lane still runs on main.
  const noTests = structuredClone(noMac);
  noTests.changes.outputs.tests = "false";
  noTests.tests = { result: "skipped" };
  assert.throws(
    () =>
      validateResults(
        { ...linuxOnly, lanes: { ...linuxOnly.lanes, tests: false } },
        noTests,
        "push",
      ),
    /forbids skips/,
  );
});

test("only a scheduled run with nothing new on main may skip everything", () => {
  const none = Object.fromEntries(lanes.map((k) => [k, false]));
  const unchanged = { version: 1, unchangedSince: "a".repeat(40), nativeMac: [], lanes: none };
  const needs = {
    changes: {
      result: "success",
      outputs: { ...Object.fromEntries(lanes.map((k) => [k, "false"])), "native-mac-tasks": "[]" },
    },
    ...Object.fromEntries(lanes.map((k) => [k, { result: "skipped" }])),
  };
  assert.doesNotThrow(() => validateResults(unchanged, needs, "schedule"));
  for (const event of ["push", "workflow_dispatch", "pull_request"])
    assert.throws(() => validateResults(unchanged, needs, event), /Only a scheduled run/);
  const partly = structuredClone(needs);
  partly.changes.outputs.lint = "true";
  partly.lint = { result: "success" };
  assert.throws(
    () => validateResults({ ...unchanged, lanes: { ...none, lint: true } }, partly, "schedule"),
    /Only a scheduled run/,
  );
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
          SWIFT_INPUTS: "packages/apple-data",
        },
        encoding: "utf8",
      });
    writeFileSync(git, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    assert.notEqual(run().status, 0);
    writeFileSync(git, "#!/bin/sh\necho tracked-input\n", { mode: 0o755 });
    assert.equal(run().status, 0);
    assert.match(readFileSync(output, "utf8"), /^inputs=[a-f0-9]{64}$/m);
    const empty = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: directory,
        GITHUB_OUTPUT: output,
        SWIFT_INPUTS: "",
      },
      encoding: "utf8",
    });
    assert.notEqual(empty.status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("every native-mac task names inputs that exist", async () => {
  const { existsSync, readFileSync } = await import("node:fs");
  const config = JSON.parse(readFileSync(".github/scripts/ci-native-mac.json", "utf8"));
  assert.ok(config.tasks.length > 0);
  assert.equal(config.tasks.filter((task) => task.lane).length, 1);
  for (const { task, timeout, swift, scripts = [], extra = [] } of config.tasks) {
    assert.ok(Number.isInteger(timeout) && timeout >= 3, `${task} timeout`);
    assert.ok(swift.length > 0, `${task} names no Swift inputs`);
    for (const path of [...swift, ...scripts, ...extra, ...config.ciInputs])
      assert.ok(existsSync(path), `${task}: ${path} does not exist`);
  }
});
