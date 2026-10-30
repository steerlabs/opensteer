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
  const sha = "a".repeat(40);
  assert.doesNotThrow(() => validateResults(unchanged, needs, "schedule", sha));
  // The commit it vouches for must be the one this run is on.
  assert.throws(
    () => validateResults(unchanged, needs, "schedule", "b".repeat(40)),
    /Only a scheduled run/,
  );
  for (const event of ["push", "workflow_dispatch", "pull_request"])
    assert.throws(() => validateResults(unchanged, needs, event, sha), /Only a scheduled run/);
  assert.throws(() => validateResults(plan, results, undefined), /Unknown CI event/);
  const partly = structuredClone(needs);
  partly.changes.outputs.lint = "true";
  partly.lint = { result: "success" };
  assert.throws(
    () =>
      validateResults({ ...unchanged, lanes: { ...none, lint: true } }, partly, "schedule", sha),
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

async function ciConfig() {
  const { readFileSync } = await import("node:fs");
  const { parse } = await import("yaml");
  return {
    workflow: parse(readFileSync(".github/workflows/ci.yml", "utf8")),
    setup: parse(readFileSync(".github/actions/ci-setup/action.yml", "utf8")),
    runner: JSON.parse(readFileSync("apps/runner/package.json", "utf8")),
  };
}

test("Go caches restore explicitly and only successful compiling shards publish", async () => {
  const { workflow, setup } = await ciConfig();
  const go = setup.runs.steps.find((s) => s.uses?.startsWith("actions/setup-go@"));
  assert.equal(go.with.cache, false);
  assert.equal(setup.inputs.go.default, "true");
  assert.equal(go.if, "inputs.go == 'true'");
  assert.equal(setup.runs.steps.find((s) => s.id === "go-paths").if, go.if);
  assert.equal(setup.runs.steps.find((s) => s.id === "go-cache").if, go.if);
  for (const name of ["lint", "Check"])
    assert.equal(
      workflow.jobs[name].steps.find((s) => s.uses === "./.github/actions/ci-setup").with.go,
      "false",
    );
  for (const name of ["tests", "integration"])
    assert.notEqual(
      workflow.jobs[name].steps.find((s) => s.uses === "./.github/actions/ci-setup").with?.go,
      "false",
    );

  const restore = setup.runs.steps.find((s) => s.uses?.startsWith("actions/cache/restore@"));
  assert.ok(restore);
  assert.match(restore.with.key, /go-compiler-v2/);
  assert.match(restore.with.key, /runner.os/);
  assert.match(restore.with.key, /runner.arch/);
  assert.match(restore.with.key, /version/);
  assert.match(restore.with.key, /go\.mod.*go\.sum/);
  assert.match(restore.with.key, /github.sha/);
  assert.ok(restore.with["restore-keys"]);
  const writers = [];
  for (const [name, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps) {
      if (!step.uses?.startsWith("actions/cache/save@")) continue;
      writers.push(name);
      assert.match(step.if, /success\(\)/);
      assert.match(step.if, /matrix.shard == 1/);
      assert.match(step.if, /cache-hit != 'true'/);
      assert.equal(step.with.key, "${{ steps.setup.outputs.go-cache-key }}");
      assert.equal(step.with.path, "${{ steps.setup.outputs.go-cache-paths }}");
      const earlier = job.steps.slice(0, job.steps.indexOf(step));
      assert.ok(earlier.some((s) => /pnpm exec vitest run|pnpm test:integration/.test(s.run)));
      assert.ok(earlier.some((s) => /ziphash/.test(s.run) && /-d'/.test(s.run)));
      if (name === "integration") assert.match(step.if, /needs.changes.outputs.tests == 'false'/);
    }
  }
  assert.deepEqual(writers.sort(), ["integration", "tests"]);
});

test("public Go proxy fallback is a quoted environment value and tests bypass result caching", async () => {
  const { setup, runner } = await ciConfig();
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(".github/actions/ci-setup/action.yml", "utf8");
  assert.match(source, /GOPROXY: ["']https:\/\/proxy.golang.org\|direct["']/);
  assert.ok(
    setup.runs.steps.some(
      (s) =>
        s.run?.includes("GOPROXY=$GOPROXY") && s.env.GOPROXY === "https://proxy.golang.org|direct",
    ),
  );
  assert.doesNotMatch(source, /GOSUMDB|GOPRIVATE|GONOSUMDB|GONOPROXY/);
  assert.match(runner.scripts["test:native-fs"], /test -count=1 -timeout=2m \.\/\.\.\.$/);
});

test("native-fs executes once on shard one, fails the lane and Check, and uploads its log", async () => {
  const { workflow } = await ciConfig();
  const job = workflow.jobs.tests;
  const steps = job.steps.filter((s) => s.run?.includes("test:native-fs"));
  assert.equal(steps.length, 1);
  const step = steps[0];
  assert.equal(step.if, "matrix.shard == 1");
  assert.equal(step["continue-on-error"], undefined);
  assert.equal(job["continue-on-error"], undefined);
  assert.match(step.run, /set -o pipefail/);
  assert.match(step.run, /test:native-fs 2>&1 \| tee "\$RUNNER_TEMP\/evidence\/native-fs.log"/);
  assert.doesNotMatch(step.run, /\|\| true/);
  assert.ok(workflow.jobs.Check.needs.includes("tests"));
  assert.ok(job.steps.some((s) => s.if === "always()" && s.with?.path.includes("evidence")));
  const builds = job.steps.find((s) => s.run?.includes("build:native-fs"));
  assert.equal(builds.if, undefined);
  for (const command of ["build:native-fs", "build:native-fs:test", "build:process-supervisor"])
    assert.ok(builds.run.includes(command));
  assert.ok(job.steps.every((s) => !/pnpm pretest/.test(s.run)));
  // validateResults' failing matrix-lane regression above proves the Check side.
});

test("main push concurrency coalesces by branch without changing other event groups", async () => {
  const { workflow } = await ciConfig();
  const { runInNewContext } = await import("node:vm");
  const expand = (value, github) =>
    value.replace(/\$\{\{(.*?)\}\}/g, (_, expression) =>
      String(runInNewContext(expression, { github })),
    );
  const group = (event_name, sha, ref = "refs/heads/main", number) =>
    expand(workflow.concurrency.group, {
      event_name,
      sha,
      ref,
      event: { pull_request: { number } },
    });
  assert.equal(group("push", "a"), group("push", "b"));
  assert.notEqual(group("push", "a"), group("push", "a", "refs/heads/other"));
  assert.equal(group("pull_request", "a", "refs/pull/12/merge", 12), "ci-12-pull_request");
  for (const event of ["schedule", "workflow_dispatch"])
    assert.equal(group(event, "a"), `ci-a-${event}`);
  assert.equal(expand(workflow.concurrency["cancel-in-progress"], { event_name: "push" }), "false");
  assert.equal(
    expand(workflow.concurrency["cancel-in-progress"], { event_name: "pull_request" }),
    "true",
  );
});

test("release native proof and release builds share a toolchain; release caches exclude signing inputs", async () => {
  const { readFileSync } = await import("node:fs");
  const { parse } = await import("yaml");
  const { workflow } = await ciConfig();
  const release = parse(readFileSync(".github/workflows/release.yml", "utf8"));
  const [native] = nativeMacMatrix(["release-native"]);
  assert.equal(release.jobs.build["runs-on"], native.runner);
  assert.equal(release.jobs.build.env.DEVELOPER_DIR, native.xcode);
  assert.equal(workflow.jobs["native-mac"]["runs-on"], "${{ matrix.runner }}");
  // Releases wait for main's full CI; the account-wide macOS limit already caps it.
  assert.equal(workflow.jobs["native-mac"].strategy["max-parallel"], undefined);
  const caches = release.jobs.build.steps.filter((step) => step.uses?.startsWith("actions/cache@"));
  assert.equal(caches.length, 3);
  for (const cache of caches) {
    assert.match(cache.with.key, /^release-only-/u);
    assert.match(cache.with.key, /toolchain|java/u);
    assert.match(cache.with.key, /hashFiles|outputs.swift/u);
    assert.equal(cache.with["restore-keys"], undefined);
  }
  assert.deepEqual(
    caches.map((cache) => cache.with.path.trim().split("\n")),
    [
      ["${{ runner.temp }}/macos-build/postgres"],
      [
        "apps/desktop/native/computer-use/.build",
        "apps/desktop/native/passwords/.build",
        "apps/desktop/native/dictation/.build",
      ],
      ["~/.gradle/caches/modules-2", "~/.gradle/wrapper/dists"],
    ],
  );
});
