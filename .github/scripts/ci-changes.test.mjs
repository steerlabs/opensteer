import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  allNativeMacTasks,
  decide,
  detect,
  laneUniverse,
  lanes,
  lastFullRunSha,
  lockfileChanges,
  nativeMacMatrix,
  parseDiff,
  readGraph,
} from "./ci-changes.mjs";
import { darwinOnlyTests, realBrowserTests } from "./ci-test-files.mjs";

// A small repository: core <- protocol <- host, web; leaf stands alone.
const fixtureGraph = [
  { name: "core", dir: "packages/core", deps: [], coverage: [] },
  { name: "protocol", dir: "packages/protocol", deps: ["core"], coverage: [] },
  { name: "host", dir: "apps/host", deps: ["protocol"], coverage: ["integration"] },
  { name: "web", dir: "apps/web", deps: ["protocol"], coverage: ["browser-journeys"] },
  { name: "leaf", dir: "packages/leaf", deps: [], coverage: [] },
];
const lock = (web) =>
  [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    devDependencies:",
    "      vitest: 4.1.10",
    "",
    "  apps/web:",
    "    dependencies:",
    `      react: ${web}`,
    "",
    "packages:",
    "",
    `  react@${web}: {}`,
    "",
  ].join("\n");
const fixtureFiles = {
  "packages/core/src/index.ts": "export const core = 1;",
  "packages/core/src/index.test.ts": 'import { core } from "./index.js";',
  "packages/protocol/src/index.ts": 'import { core } from "@opensteer/core";',
  "packages/protocol/src/index.test.ts": 'import "./index.js";',
  "apps/host/src/main.ts":
    'import "protocol";\nimport { helper } from "../../../scripts/helper.js";',
  "apps/host/src/main.test.ts": 'import "./main.js";',
  "apps/host/src/store.integration.test.ts": 'import "./main.js";',
  "apps/web/src/app.ts": "export {};",
  "apps/web/src/app.test.ts": 'import "./app.js";',
  "packages/leaf/src/leaf.ts": "export {};",
  "packages/leaf/src/leaf.test.ts": 'import "./leaf.js";',
  "scripts/helper.ts": "export const helper = 1;",
  "scripts/tool.ts": "export {};",
  "scripts/test-integration.ts": 'import { run } from "./run.js";',
  "scripts/run.ts": "export const run = 1;",
  // A root guard imports no workspace: it runs whenever the unit lane does.
  "tests/guard.test.ts": 'import { readFileSync } from "node:fs";',
  "tests/host-flow.test.ts": 'import "../apps/host/src/main.js";',
  "tests/tool.test.ts": 'import "../scripts/tool.js";\nimport "../packages/leaf/src/leaf.js";',
  "tests/prettier.test.ts": 'readFileSync(".prettierignore", "utf8");\nimport "web";',
  "tests/team.test-support.ts": 'import "host";',
  "tests/team.integration.test.ts": 'import "./team.test-support.js";',
  "vitest.config.ts": 'import "./scripts/sequencer.js";',
  "scripts/sequencer.ts": "export {};",
  "vitest.integration.config.ts": 'setupFiles: ["./scripts/run.ts"]',
  ".prettierignore": "dist",
  "pnpm-lock.yaml": lock("19.0.0"),
  "docs/a.md": "",
};
const repoWith = (overrides = {}, base = {}) => {
  const files = { ...fixtureFiles, ...overrides };
  return {
    tracked: Object.keys(files).filter((file) => files[file] !== undefined),
    read: (file) => files[file],
    readBase: (file) => ({ ...fixtureFiles, ...base })[file],
  };
};
const on = (plan) =>
  Object.entries(plan.lanes)
    .filter(([, selected]) => selected)
    .map(([lane]) => lane);
const unitAll = Object.keys(fixtureFiles)
  .filter((f) => f.endsWith(".test.ts") && !f.includes(".integration."))
  .sort();
const guard = "tests/guard.test.ts";

test("selection table: lanes, test files and typecheck scope per change", () => {
  const cases = [
    {
      name: "docs only",
      files: ["docs/a.md", "README.md", ".agents/skills/a/SKILL.md"],
      lanes: ["lint"],
    },
    { name: "workflow only", files: [".github/workflows/ci.yml"], lanes: ["lint"] },
    { name: "release workflow", files: [".github/workflows/release.yml"], lanes: ["lint"] },
    {
      name: "CI script",
      files: [".github/scripts/ci-sharding.mjs", "scripts/ci-sequencer.ts"],
      lanes: ["lint"],
    },
    {
      name: "leaf package",
      files: ["packages/leaf/src/leaf.ts"],
      lanes: ["lint", "build-types", "tests"],
      // tests/tool.test.ts imports the leaf relatively.
      tests: ["packages/leaf/src/leaf.test.ts", "tests/tool.test.ts", guard],
      typecheck: ["leaf"],
    },
    {
      name: "shared core package",
      files: ["packages/core/src/index.ts"],
      lanes: ["lint", "build-types", "tests", "integration", "browser-journeys"],
      tests: [
        "apps/host/src/main.test.ts",
        "apps/web/src/app.test.ts",
        "packages/core/src/index.test.ts",
        "packages/protocol/src/index.test.ts",
        "tests/host-flow.test.ts",
        "tests/prettier.test.ts",
        guard,
      ],
      integration: ["apps/host/src/store.integration.test.ts", "tests/team.integration.test.ts"],
      typecheck: ["core", "host", "protocol", "web"],
    },
    {
      name: "a test-only edit runs itself, not its package's dependents",
      files: ["packages/core/src/index.test.ts"],
      lanes: ["lint", "build-types", "tests"],
      tests: ["packages/core/src/index.test.ts", guard],
      typecheck: ["core"],
    },
    {
      name: "root config",
      files: ["tsconfig.base.json"],
      lanes: ["lint", "build-types", "tests"],
      tests: unitAll,
      typecheck: "all",
    },
    {
      name: "unit runner",
      files: ["scripts/sequencer.ts"],
      lanes: ["lint", "build-types", "tests"],
      tests: unitAll,
      typecheck: [],
    },
    {
      name: "integration runner",
      files: ["scripts/run.ts"],
      lanes: ["lint", "build-types", "integration"],
      integration: ["apps/host/src/store.integration.test.ts", "tests/team.integration.test.ts"],
      typecheck: [],
    },
    {
      name: "a loose script runs what imports it",
      files: ["scripts/helper.ts"],
      lanes: ["lint", "build-types", "tests", "integration"],
      tests: ["apps/host/src/main.test.ts", "tests/host-flow.test.ts", guard],
      integration: ["apps/host/src/store.integration.test.ts", "tests/team.integration.test.ts"],
      typecheck: ["host"],
    },
    {
      name: "test support selects its importers",
      files: ["tests/team.test-support.ts"],
      lanes: ["lint", "build-types", "integration"],
      integration: ["tests/team.integration.test.ts"],
      typecheck: [],
    },
    {
      name: "a lint input runs the tests that name it",
      files: [".prettierignore"],
      lanes: ["lint", "build-types", "tests"],
      tests: ["tests/prettier.test.ts", guard],
      typecheck: [],
    },
    {
      name: "unknown path fails open",
      files: ["mystery.txt"],
      lanes: ["lint", "build-types", "tests", "integration", "browser-journeys"],
      tests: unitAll,
      integration: ["apps/host/src/store.integration.test.ts", "tests/team.integration.test.ts"],
      typecheck: "all",
    },
  ];
  for (const c of cases) {
    const plan = decide(c.files, fixtureGraph, fixtureGraph, { repo: repoWith() });
    assert.deepEqual(on(plan), c.lanes, c.name);
    assert.deepEqual(plan.files.tests, (c.tests ?? []).toSorted(), c.name);
    assert.deepEqual(plan.files.integration, (c.integration ?? []).toSorted(), c.name);
    if (c.typecheck) assert.deepEqual(plan.typecheck, c.typecheck, c.name);
    assert.equal(plan.shards.tests > 0, plan.files.tests.length > 0, c.name);
    assert.deepEqual(plan.build, [], `${c.name}: PRs build nothing`);
  }
});
test("a root test reaching a package by relative import runs when that package is affected", () => {
  // host-flow imports host's source by path, never by name; a host manifest change still reaches it.
  const host = decide(["apps/host/package.json"], fixtureGraph, fixtureGraph, {
    repo: repoWith({}),
  });
  assert.ok(host.files.tests.includes("tests/host-flow.test.ts"));
});
test("a lockfile change selects the importers whose entries changed", () => {
  const web = decide(["pnpm-lock.yaml"], fixtureGraph, fixtureGraph, {
    repo: repoWith({ "pnpm-lock.yaml": lock("19.1.0") }),
  });
  assert.deepEqual(web.affected, ["web"]);
  assert.deepEqual(on(web), ["lint", "build-types", "tests", "browser-journeys"]);
  assert.deepEqual(web.files.tests, ["apps/web/src/app.test.ts", guard, "tests/prettier.test.ts"]);
  // A shared package entry changed: only the importers that install it.
  const shared = lock("19.0.0").replace("react@19.0.0: {}", "react@19.0.0: {resolution: x}");
  const other = decide(["pnpm-lock.yaml"], fixtureGraph, fixtureGraph, {
    repo: repoWith({ "pnpm-lock.yaml": shared }),
  });
  assert.deepEqual(other.affected, ["web"]);
  assert.deepEqual(lockfileChanges(lock("1"), lock("2")).importers, ["apps/web"]);
  // A transitive update reaches its consumers even when their own entries are unchanged.
  const graph = (protocol, page) =>
    [
      "importers:",
      "",
      "  apps/marketing:",
      "    dependencies:",
      "      next:",
      "        specifier: 1.0.0",
      `        version: ${page}`,
      "  packages/database:",
      "    dependencies:",
      "      pg:",
      "        specifier: 8.0.0",
      "        version: 8.0.0",
      "",
      "snapshots:",
      "",
      `  next@${page}: {}`,
      "",
      "  pg@8.0.0:",
      "    dependencies:",
      `      pg-protocol: ${protocol}`,
      "",
      `  pg-protocol@${protocol}: {}`,
      "",
    ].join("\n");
  assert.deepEqual(lockfileChanges(graph("1.0.0", "1.0.0"), graph("1.0.1", "1.0.1")), {
    importers: ["apps/marketing", "packages/database"],
    other: false,
  });
  // Settings, catalogs, overrides and patches reach everything.
  assert.equal(lockfileChanges(lock("1"), `settings:\n  x: 1\n${lock("1")}`).other, true);
  // An unreadable base lockfile cannot narrow anything.
  const missing = decide(["pnpm-lock.yaml"], fixtureGraph, fixtureGraph, {
    repo: repoWith({}, { "pnpm-lock.yaml": undefined }),
  });
  assert.equal(missing.typecheck, "all");
});
test("a deleted package still selects its dependents through the base graph", () => {
  const head = fixtureGraph.filter((p) => p.name !== "leaf");
  const base = fixtureGraph.map((p) =>
    p.name === "host" ? { ...p, deps: ["protocol", "leaf"] } : p,
  );
  const plan = decide(["packages/leaf/src/leaf.ts"], head, base, {
    repo: repoWith({
      "packages/leaf/src/leaf.ts": undefined,
      "packages/leaf/src/leaf.test.ts": undefined,
    }),
  });
  assert.deepEqual(plan.affected, ["host", "leaf"]);
  assert.ok(plan.files.integration.includes("apps/host/src/store.integration.test.ts"));
});
test("main pushes build what they changed; full runs run and build everything", () => {
  const push = decide(["packages/leaf/src/leaf.ts"], fixtureGraph, fixtureGraph, {
    event: "push",
    repo: repoWith(),
  });
  assert.deepEqual(push.build, ["leaf"]);
  assert.deepEqual(push.files.tests, [
    "packages/leaf/src/leaf.test.ts",
    guard,
    "tests/tool.test.ts",
  ]);
  const full = decide([], fixtureGraph, fixtureGraph, { event: "full", repo: repoWith() });
  assert.ok(Object.values(full.lanes).every(Boolean));
  assert.deepEqual(full.whole, { tests: true, integration: true });
  assert.deepEqual(full.files.tests, unitAll);
  assert.equal(full.build, "all");
  assert.deepEqual(full.nativeMac, allNativeMacTasks);
});
test("Vitest path filters match by substring, so the plan names every file they reach", () => {
  const plan = decide(["tests/a.test.ts"], fixtureGraph, fixtureGraph, {
    repo: repoWith({ "tests/a.test.ts": "", "packages/leaf/tests/a.test.ts": "" }),
  });
  assert.ok(plan.files.tests.includes("packages/leaf/tests/a.test.ts"));
});
test("detector errors select every lane and every native task", () => {
  const plan = detect({ root: "/missing", event: "pull_request" });
  assert.ok(plan.detectionError);
  assert.ok(Object.values(plan.lanes).every(Boolean));
  assert.deepEqual(plan.nativeMac, allNativeMacTasks);
  assert.throws(() => parseDiff("a.ts"));
  assert.deepEqual(parseDiff("a b.ts\0old.ts\0"), ["a b.ts", "old.ts"]);
});

const realFiles = parseDiff(execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }));
const realGraph = readGraph(process.cwd());
const nativeInputs = JSON.parse(readFileSync(".github/scripts/ci-native-inputs.json", "utf8"));
const realRepo = {
  tracked: realFiles,
  read: (file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  },
  readBase: () => undefined,
};
const real = (files, event = "pull_request") =>
  decide(files, realGraph, realGraph, { event, repo: realRepo });
test("real graph includes every workspace dependency kind", () => {
  assert.ok(realGraph.length > 40);
  assert.ok(realGraph.find((p) => p.name === "@opensteer/host").deps.length);
});
test("the Linux unit universe leaves out other lanes' files", () => {
  const { tests, integration } = laneUniverse(realFiles);
  for (const file of [...realBrowserTests, ...darwinOnlyTests])
    assert.ok(!tests.includes(file), file);
  assert.ok(
    !tests.some((file) => /\.(integration|windows|gui|engine|device|soak)\.test\./.test(file)),
  );
  assert.ok(integration.every((file) => file.includes(".integration.test.")));
});
test("real native selection: PRs for their own sources, main for everything they import", () => {
  const cases = [
    // [file, PR tasks, main push tasks]
    [".github/workflows/release.yml", [], []],
    [".github/workflows/ci.yml", [], allNativeMacTasks],
    ["apps/web/src/app-model.ts", [], []],
    [
      "apps/desktop/native/passwords/Sources/Broker.swift",
      ["passwords-helper", "passwords-tests", "release-native"],
      ["passwords-helper", "passwords-tests", "release-native"],
    ],
    // The helper build scripts import this release cache module.
    [
      "apps/desktop/scripts/native-build-cache.ts",
      ["computer-helper", "passwords-helper", "dictation-helper", "release-native"],
      ["computer-helper", "passwords-helper", "dictation-helper", "release-native"],
    ],
    ["tests/kernel-lock.test.ts", ["iphone"], ["iphone"]],
    [
      "packages/protocol/src/browser.ts",
      [],
      [
        "computer-helper",
        "computer-tests",
        "dictation-helper",
        "iphone",
        "passwords-helper",
        "release-native",
      ],
    ],
  ];
  for (const [file, pr, push] of cases) {
    assert.deepEqual(real([file]).nativeMac, pr, `${file} on a PR`);
    assert.deepEqual(real([file], "push").nativeMac.toSorted(), push.toSorted(), `${file} on main`);
  }
});
test("real Windows and Android selection follow their own sources on PRs", () => {
  const windows = (file, event) => real([file], event).lanes["native-windows"];
  for (const file of [
    "apps/desktop/process-supervisor/main.go",
    "apps/runner/native-fs-helper/go.mod",
    "packages/harness/src/new-case.windows.test.ts",
    ".github/scripts/run-as-standard-user.ps1",
    "vitest.windows.config.ts",
  ])
    assert.equal(windows(file, "pull_request"), true, file);
  for (const file of ["packages/shared/src/processControl.ts", "pnpm-lock.yaml"]) {
    assert.equal(windows(file, "pull_request"), false, file);
    assert.equal(windows(file, "push"), true, file);
  }
  assert.equal(windows("docs/testing.md", "push"), false);
  const android = (file, event) => real([file], event).lanes.android;
  for (const file of [
    "apps/agent-phone/app/src/main/Phone.kt",
    "apps/mobile/modules/phone-browser/android/src/main/java/A.kt",
    "packages/core/src/fixtures/notification-preview-v1.json",
    "packages/runner-auth/src/agent-phone-wire.ts",
  ])
    assert.equal(android(file, "pull_request"), true, file);
  assert.equal(android("packages/core/src/index.ts", "pull_request"), false);
  assert.equal(android("packages/core/src/index.ts", "push"), true);
  // Shared fixtures keep their package's unit tests too.
  assert.ok(real(["packages/core/src/fixtures/notification-preview-v1.json"]).lanes.tests);
});
test("real browser journeys run for their owners, their dependencies and their runner", () => {
  for (const file of [
    ...realBrowserTests,
    "vitest.browser.config.ts",
    "packages/client/src/index.ts",
  ])
    assert.equal(real([file]).lanes["browser-journeys"], true, file);
  // The control plane reaches no browser-journey owner.
  assert.equal(real(["apps/control-plane/src/main.ts"]).lanes["browser-journeys"], false);
  // Identity does: root journeys import Host source by path, and the Host depends on identity.
  assert.equal(real(["packages/identity/src/index.ts"]).lanes["browser-journeys"], true);
});
test("git fixture: a main push checks its one commit; anything else runs everything", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "ci-push-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (p, s) => {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), s);
  };
  const commit = () => {
    git("add", "-A");
    git(
      "-c",
      "user.name=F",
      "-c",
      "user.email=f@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "f",
    );
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-q");
    write("pnpm-workspace.yaml", "packages:\n  - apps/*\n  - packages/*\n");
    write("packages/a/package.json", JSON.stringify({ name: "a" }));
    write("packages/a/src/a.test.ts", "");
    write("apps/desktop/package.json", JSON.stringify({ name: "desktop" }));
    const first = commit();
    write("apps/desktop/native/passwords/Sources/Broker.swift", "// changed");
    commit();
    const push = detect({ root, event: "push", before: first });
    assert.deepEqual(push.nativeMac, ["passwords-helper", "passwords-tests", "release-native"]);
    assert.equal(push.lanes.tests, false);
    write("docs/a.md", "x");
    commit();
    // A docs-only merge runs lint alone on main.
    const docs = detect({ root, event: "push", before: git("rev-parse", "HEAD^1") });
    assert.deepEqual(on(docs), ["lint"]);
    // Several commits in one push, or a new branch, run every lane and task.
    for (const before of [first, "0".repeat(40)]) {
      const all = detect({ root, event: "push", before });
      assert.deepEqual(all.nativeMac, allNativeMacTasks);
      assert.deepEqual(all.files.tests, ["packages/a/src/a.test.ts"]);
      // This fixture has no integration files, so only that lane stays off.
      assert.deepEqual(
        on(all).filter((lane) => lane !== "integration"),
        lanes.filter((lane) => lane !== "integration"),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("scheduled and manual runs take everything unless main has not changed", () => {
  for (const event of ["schedule", "workflow_dispatch"]) {
    const plan = detect({ event });
    assert.deepEqual(plan.nativeMac, allNativeMacTasks);
    assert.ok(Object.values(plan.lanes).every(Boolean));
    assert.deepEqual(plan.whole, { tests: true, integration: true });
  }
  const unchanged = detect({ event: "schedule", unchangedSince: "a".repeat(40) });
  assert.deepEqual(unchanged.nativeMac, []);
  assert.deepEqual(on(unchanged), ["lint"]);
  assert.deepEqual(
    detect({ event: "workflow_dispatch", unchangedSince: "a".repeat(40) }).nativeMac,
    allNativeMacTasks,
  );
});

test("the last full run is the newest earlier scheduled or manual main run that passed", async () => {
  const run = (run_number, head_sha, conclusion = "success", head_branch = "main") => ({
    run_number,
    head_sha,
    head_branch,
    status: conclusion ? "completed" : "in_progress",
    conclusion,
  });
  const pages = {
    schedule: [
      run(12, "later"),
      run(9, "unfinished", null),
      run(8, "cancelled", "cancelled"),
      run(7, "failed", "failure"),
      run(4, "older"),
    ],
    workflow_dispatch: [run(6, "branch", "success", "feature"), run(5, "manual")],
  };
  const urls = [];
  const request = async (url) => {
    urls.push(url);
    const event = new URL(url).searchParams.get("event");
    return { ok: true, json: async () => ({ workflow_runs: pages[event] }) };
  };
  // Run 10 sees neither the later run nor a failed, cancelled or unfinished one.
  assert.equal(
    await lastFullRunSha({ repository: "o/r", runNumber: "10", token: "t", request }),
    "manual",
  );
  // A re-run of a failed run keeps its number, so a later skip cannot vouch for it.
  assert.equal(
    await lastFullRunSha({ repository: "o/r", runNumber: "7", token: "t", request }),
    "manual",
  );
  assert.ok(
    urls.every((url) => url.includes("/repos/o/r/actions/workflows/ci.yml/runs?branch=main")),
  );
  await assert.rejects(
    lastFullRunSha({
      repository: "o/r",
      runNumber: "10",
      token: "t",
      request: async () => ({ ok: false, status: 403 }),
    }),
    /HTTP 403/u,
  );
});
test("git fixture: dev/optional edges, deletion, rename, malformed manifest and missing base", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "ci-graph-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const write = (p, s) => {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), s);
  };
  const commit = () => {
    git("add", "-A");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    );
  };
  try {
    git("init", "-q");
    write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    write("packages/a/package.json", JSON.stringify({ name: "a" }));
    write("packages/a/code.ts", "export {};");
    write(
      "packages/b/package.json",
      JSON.stringify({ name: "b", devDependencies: { a: "workspace:*" } }),
    );
    write(
      "packages/c/package.json",
      JSON.stringify({ name: "c", optionalDependencies: { b: "workspace:*" } }),
    );
    commit();
    const base = git("rev-parse", "HEAD").trim();
    assert.deepEqual(readGraph(root).find((p) => p.name === "c").deps, ["b"]);
    write("packages/a/code.ts", "export const changed=1;");
    commit();
    assert.deepEqual(detect({ root, event: "pull_request", base }).affected, ["a", "b", "c"]);
    renameSync(join(root, "packages/a/code.ts"), join(root, "packages/b/renamed.ts"));
    commit();
    assert.deepEqual(detect({ root, event: "pull_request", base }).affected, ["a", "b", "c"]);
    rmSync(join(root, "packages/a"), { recursive: true });
    // Removing workspace dependents too leaves the deleted owner resolvable only in base.
    rmSync(join(root, "packages/b"), { recursive: true });
    rmSync(join(root, "packages/c"), { recursive: true });
    write("packages/d/package.json", JSON.stringify({ name: "d" }));
    git("add", "packages/d/package.json");
    assert.deepEqual(
      readGraph(root).map((entry) => entry.name),
      ["d"],
    );
    commit();
    assert.ok(detect({ root, event: "pull_request", base }).affected.includes("a"));
    write("packages/d/package.json", "{");
    assert.ok(detect({ root, event: "pull_request", base }).detectionError);
    assert.ok(detect({ root, event: "pull_request", base: "missing-ref" }).full);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow steps name exactly the configured native-mac tasks and their Swift tests", async () => {
  const { readFileSync } = await import("node:fs");
  const { parse } = await import("yaml");
  const config = JSON.parse(readFileSync(".github/scripts/ci-native-mac.json", "utf8"));
  const steps = parse(readFileSync(".github/workflows/ci.yml", "utf8")).jobs["native-mac"].steps;
  const named = new Set();
  const swiftTests = new Map(config.tasks.map(({ task }) => [task, new Set()]));
  const vitestRuns = new Map(config.tasks.map(({ task }) => [task, []]));
  for (const step of steps) {
    const tasks = [...String(step.if ?? "").matchAll(/matrix\.task == '([^']+)'/gu)].map(
      (m) => m[1],
    );
    if (String(step.if ?? "") === "matrix.darwin")
      tasks.push(config.tasks.find((task) => task.lane).task);
    for (const task of tasks) {
      assert.ok(swiftTests.has(task), `step names unknown task ${task}`);
      named.add(task);
      for (const [, path] of String(step.run ?? "").matchAll(/swift test --package-path (\S+)/gu))
        swiftTests.get(task).add(path);
      // Explicit Vitest paths; the Darwin-only list comes from ci-test-files.mjs.
      for (const [, paths] of String(step.run ?? "").matchAll(
        /^\s*pnpm exec vitest run ([^$\n]+)$/gmu,
      ))
        vitestRuns.get(task).push(...paths.trim().split(/\s+/u));
    }
  }
  assert.deepEqual([...named].sort(), allNativeMacTasks.toSorted());
  for (const { task, tests = [], vitest = [] } of config.tasks) {
    assert.deepEqual([...swiftTests.get(task)].sort(), tests.toSorted(), task);
    assert.deepEqual(vitestRuns.get(task).toSorted(), vitest.toSorted(), task);
  }
});
test("the native input list names only tracked files and packages", () => {
  for (const [task, inputs] of Object.entries(nativeInputs))
    for (const input of inputs)
      assert.ok(
        realFiles.some((file) => file === input || file.startsWith(`${input}/`)),
        `${task}: ${input}`,
      );
});
test("dictation selects its Swift lane and pins its SDK independently", () => {
  const plan = decide(
    ["packages/apple-dictation/Sources/OpensteerDictation/DictationService.swift"],
    readGraph(process.cwd()),
  );
  assert.ok(plan.nativeMac.includes("dictation"));
  const [task] = nativeMacMatrix(["dictation"]);
  assert.equal(task.xcode, "/Applications/Xcode_26.3.app/Contents/Developer");
  assert.equal(task.swift, "packages/apple-dictation");
  assert.equal(nativeMacMatrix(["iphone"])[0].xcode, "/Applications/Xcode.app/Contents/Developer");
});

test("Check needs every lane, and the changes job and action publish the plan", async () => {
  const { readFileSync } = await import("node:fs");
  const { parse } = await import("yaml");
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const action = parse(readFileSync(".github/actions/ci-changes/action.yml", "utf8"));
  for (const lane of lanes) {
    assert.ok(workflow.jobs.Check.needs.includes(lane), lane);
    assert.ok(workflow.jobs.changes.outputs[lane], lane);
    assert.ok(action.outputs[lane], lane);
  }
  for (const output of [
    "typecheck-filters",
    "build-filters",
    "tests-shards",
    "integration-shards",
  ]) {
    assert.ok(workflow.jobs.changes.outputs[output], output);
    assert.ok(action.outputs[output], output);
  }
  assert.equal(workflow.jobs["native-windows"]["runs-on"], "windows-2025");
});
