import { test } from "node:test";
import { matchesGlob } from "node:path";
import assert from "node:assert/strict";
import {
  allNativeMacTasks,
  nativeMacMatrix,
  decide,
  detect,
  lastFullRunSha,
  parseDiff,
  readGraph,
} from "./ci-changes.mjs";
const graph = [
  { name: "leaf", dir: "packages/leaf", deps: [], coverage: [] },
  { name: "host", dir: "apps/host", deps: ["leaf"], coverage: ["integration"] },
  { name: "web", dir: "apps/web", deps: ["host"], coverage: [] },
];
test("reverse transitive dependencies include development and optional edges", () => {
  assert.deepEqual(decide(["packages/leaf/a.ts"], graph).affected, ["host", "leaf", "web"]);
  assert.equal(decide(["packages/leaf/a.ts"], graph).lanes.integration, true);
});
test("ordinary docs skip heavy lanes but shipped skill markdown does not", () => {
  assert.equal(decide(["docs/a.md", "README.md"], graph).lanes.tests, false);
  assert.equal(decide(["apps/runner/agent-skills/skills/a.md"], graph).lanes.tests, true);
});
test("contributor skills and agent settings select only lint", () => {
  const plan = decide([".agents/skills/a/SKILL.md", ".claude/skills", "docs/a.md"], graph);
  assert.equal(plan.full, false);
  assert.deepEqual(
    Object.entries(plan.lanes)
      .filter(([, selected]) => selected)
      .map(([lane]) => lane),
    ["lint"],
  );
});
test("unknown/root/config/lock/toolchain and malformed diff fail open", () => {
  for (const file of [
    "unknown",
    "package.json",
    "pnpm-lock.yaml",
    ".github/scripts/a.mjs",
    "packages/leaf/tsconfig.json",
    "go.work",
  ])
    // Every lane but native-mac, whose tasks run for their own inputs.
    assert.ok(
      Object.entries(decide([file], graph).lanes).every(
        ([lane, on]) => on || lane === "native-mac",
      ),
      file,
    );
  assert.throws(() => parseDiff("a.ts"));
  assert.deepEqual(parseDiff("a b.ts\0old.ts\0"), ["a b.ts", "old.ts"]);
});
test("deleted package uses base graph", () =>
  assert.deepEqual(decide(["packages/leaf/a.ts"], graph.slice(1), graph).affected, [
    "host",
    "leaf",
    "web",
  ]));
test("main and detector errors select all lanes", () => {
  assert.ok(Object.values(decide([], graph, graph, true).lanes).every(Boolean));
  assert.ok(
    Object.values(detect({ root: "/missing", event: "pull_request" }).lanes).every(Boolean),
  );
});
test("real graph includes every workspace dependency kind", () => {
  const g = readGraph(process.cwd());
  assert.ok(g.length > 40);
  assert.ok(g.find((p) => p.name === "@opensteer/host").deps.length);
});
test("Android source gates Android; native Mac source gates Mac", () => {
  const mac = [{ name: "desktop", dir: "apps/desktop", deps: [], coverage: ["native-mac"] }];
  const a = decide(["apps/agent-phone/app/src/main/Phone.kt"], mac);
  assert.equal(a.lanes.android, true);
  assert.equal(a.lanes["native-mac"], false);
  assert.equal(a.lanes.tests, false);
  const n = decide(["apps/desktop/native/computer-use/Sources/Foo.swift"], mac);
  assert.equal(n.lanes["native-mac"], true);
  assert.equal(n.lanes.android, false);
});
test("the iphone task runs for what its tests import, read or launch, not for any edit", () => {
  const web = [{ name: "web", dir: "apps/web", deps: [], coverage: ["tests"] }];
  assert.equal(decide(["apps/web/src/page.ts"], web).lanes["native-mac"], false);
  for (const file of [
    "tests/vm-slot-queue.test.ts",
    "apps/desktop/src/computer-use/computer-use-service.ts",
    "packages/protocol/src/browser.ts",
    "scripts/mac-app-tree.py",
    "apps/desktop/native/passwords/Tests/Fixtures/passwords-wire.json",
    "vitest.config.ts",
  ])
    assert.ok(decide([file], web).nativeMac.includes("iphone"), file);
});
test("git fixture: a main push picks macOS tasks from its one commit", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
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
    write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    write("packages/a/package.json", JSON.stringify({ name: "a" }));
    const first = commit();
    write("apps/desktop/native/passwords/Sources/Broker.swift", "// changed");
    const second = commit();
    const push = detect({ root, event: "push", before: first });
    assert.ok(Object.entries(push.lanes).every(([lane, on]) => on || lane === "native-mac"));
    assert.deepEqual(push.nativeMac, ["passwords-helper", "passwords-tests", "release-native"]);
    // Several commits in one push, or a new branch, run every task.
    write("docs/a.md", "x");
    commit();
    assert.deepEqual(detect({ root, event: "push", before: first }).nativeMac, allNativeMacTasks);
    assert.deepEqual(
      detect({ root, event: "push", before: "0".repeat(40) }).nativeMac,
      allNativeMacTasks,
    );
    // A docs-only merge runs every Linux lane on main and no macOS task.
    const docs = detect({ root, event: "push", before: git("rev-parse", "HEAD^1") });
    assert.deepEqual(docs.nativeMac, []);
    assert.equal(docs.lanes.tests, true);
    assert.equal(second.length, 40);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("scheduled and manual runs take every task unless main has not changed", () => {
  for (const event of ["schedule", "workflow_dispatch"]) {
    const plan = detect({ event });
    assert.deepEqual(plan.nativeMac, allNativeMacTasks);
    assert.ok(Object.values(plan.lanes).every(Boolean));
  }
  const unchanged = detect({ event: "schedule", unchangedSince: "a".repeat(40) });
  assert.deepEqual(unchanged.nativeMac, []);
  assert.ok(Object.values(unchanged.lanes).every((on) => on === false));
  // Only a scheduled run consults the last full run.
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
test("source-bearing markdown and fixtures never count as documentation", () => {
  for (const p of ["SKILL.md", "docs/fixtures/prompt.md"])
    assert.equal(decide([p], []).lanes.tests, true);
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
    commit();
    assert.ok(detect({ root, event: "pull_request", base }).affected.includes("a"));
    write("packages/d/package.json", "{");
    assert.ok(detect({ root, event: "pull_request", base }).detectionError);
    assert.ok(detect({ root, event: "pull_request", base: "missing-ref" }).full);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real control-plane database changes select integration coverage", () => {
  const real = readGraph(process.cwd());
  const plan = decide(["apps/control-plane/src/database/store.ts"], real);
  assert.ok(plan.affected.includes("@opensteer/control-plane"));
  assert.equal(plan.lanes.integration, true);
});

// Enumerate independently from the detector: these are the integration config's
// current include globs, not a hand-maintained workspace owner list.
const realFiles = parseDiff(
  (await import("node:child_process")).execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
  }),
);
const integrationFiles = realFiles.filter((p) =>
  /^(?:apps\/.*\.integration\.test\.tsx?|packages\/.*\.integration\.test\.ts|tests\/.*\.integration\.test\.ts)$/.test(
    p,
  ),
);
const realGraph = readGraph(process.cwd());
for (const owner of realGraph.filter((p) =>
  integrationFiles.some((f) => f.startsWith(p.dir + "/")),
)) {
  test(`real integration owner and dependencies: ${owner.name}`, () => {
    // An ordinary source edit must select integration, even though this edit
    // neither changes a test nor happens to contain a lane-name substring.
    const file = realFiles.find(
      (f) =>
        f.startsWith(owner.dir + "/src/") && /\.tsx?$/.test(f) && !/\.test\.|test-support/.test(f),
    );
    assert.ok(file, `missing source fixture for ${owner.name}`);
    assert.equal(decide([file], realGraph).lanes.integration, true, file);
    const pending = [...owner.deps];
    const visited = new Set();
    while (pending.length) {
      const name = pending.pop();
      const dependency = realGraph.find((p) => p.name === name);
      assert.ok(dependency);
      if (visited.has(dependency.name)) continue;
      visited.add(dependency.name);
      pending.push(...dependency.deps);
      assert.equal(
        decide([`${dependency.dir}/src/ordinary-change.ts`], realGraph).lanes.integration,
        true,
        dependency.name,
      );
    }
  });
}

// Native Mac task selection. Each control names the task inputs it exercises; main's
// full push run remains the backstop for anything a selection here misses.
const nativeInputs = JSON.parse(
  (await import("node:fs")).readFileSync(".github/scripts/ci-native-inputs.json", "utf8"),
);
const swiftOnly = (plan) => plan.nativeMac.filter((task) => task !== "iphone");
test("a file a Swift task's node script imports selects that task, and only tasks importing it", () => {
  const file = "packages/integration-catalog/src/definitions/computer-apps.ts";
  assert.ok(nativeInputs["computer-tests"].includes("packages/integration-catalog"));
  assert.ok(!nativeInputs["passwords-helper"].includes("packages/integration-catalog"));
  const plan = decide([file], realGraph);
  assert.deepEqual(swiftOnly(plan), ["computer-helper", "computer-tests", "release-native"]);
  const signing = "apps/desktop/src/signed-helpers/metadata.ts";
  assert.ok(nativeInputs["passwords-helper"].includes(signing));
  assert.ok(swiftOnly(decide([signing], realGraph)).includes("passwords-helper"));
});
test("an unrelated edit, even a global one, runs no macOS task", () => {
  const web = decide(["apps/web/src/app-model.ts"], realGraph);
  assert.deepEqual(web.nativeMac, []);
  assert.equal(web.lanes["native-mac"], false);
  const launcher = decide(["scripts/test-integration.ts"], realGraph);
  assert.equal(launcher.full, true);
  assert.deepEqual(launcher.nativeMac, []);
  assert.deepEqual(decide(["docs/testing.md"], realGraph).nativeMac, []);
});
test("Swift sources, node manifests and the CI definition select their tasks", () => {
  assert.deepEqual(swiftOnly(decide(["apps/desktop/native/passwords/Package.swift"], realGraph)), [
    "passwords-helper",
    "passwords-tests",
    "release-native",
  ]);
  // Swift-only tests do not depend on installed Node packages.
  assert.deepEqual(swiftOnly(decide(["pnpm-lock.yaml"], realGraph)), [
    "computer-helper",
    "passwords-helper",
    "computer-tests",
    "dictation-helper",
    "release-native",
  ]);
  assert.deepEqual(decide([".github/workflows/ci.yml"], realGraph).nativeMac, allNativeMacTasks);
  assert.deepEqual(decide([], realGraph, realGraph, true).nativeMac, allNativeMacTasks);
  assert.deepEqual(
    detect({ root: "/missing", event: "pull_request" }).nativeMac,
    allNativeMacTasks,
  );
});
test("the native input list names only tracked files and packages", () => {
  for (const [task, inputs] of Object.entries(nativeInputs))
    for (const input of inputs)
      assert.ok(
        realFiles.some((file) => file === input || file.startsWith(`${input}/`)),
        `${task}: ${input}`,
      );
});
test("required-but-dynamic and directory-boundary inputs select exactly", () => {
  // The build scripts load these through createRequire; the generated list follows them.
  for (const file of [
    "apps/desktop/scripts/signing-input.cjs",
    "apps/desktop/scripts/macos-release-identity.cjs",
  ])
    assert.deepEqual(swiftOnly(decide([file], realGraph)), [
      "computer-helper",
      "passwords-helper",
      "dictation-helper",
      "release-native",
    ]);
  // A script beside them that no build loads runs neither helper.
  assert.deepEqual(swiftOnly(decide(["apps/desktop/scripts/after-pack.cjs"], realGraph)), []);
  // tsx compiles a task's node scripts with the tsconfig files above them and what
  // those extend, so each selects the tasks whose scripts it compiles.
  assert.deepEqual(swiftOnly(decide(["apps/desktop/tsconfig.json"], realGraph)), [
    "computer-helper",
    "passwords-helper",
    "dictation-helper",
    "release-native",
  ]);
  assert.deepEqual(swiftOnly(decide(["tsconfig.base.json"], realGraph)), [
    "computer-helper",
    "passwords-helper",
    "computer-tests",
    "dictation-helper",
    "release-native",
  ]);
  assert.deepEqual(
    swiftOnly(decide(["apps/desktop/native/computer-use-x/a.swift"], realGraph)),
    [],
  );
  // A workspace package counts whole, manifest included.
  assert.ok(
    swiftOnly(decide(["packages/protocol/package.json"], realGraph)).includes("passwords-helper"),
  );
  // Swift tests read these TypeScript and fixture files across the language boundary.
  assert.deepEqual(swiftOnly(decide(["packages/client/src/host/passwords.ts"], realGraph)), [
    "passwords-tests",
  ]);
  assert.ok(
    swiftOnly(decide(["packages/protocol/fixtures/login-envelope-v1.json"], realGraph)).includes(
      "computer-tests",
    ),
  );
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
test("a root test edit selects its own lane, the test guards and typecheck, not everything", () => {
  const lanesOf = (file) =>
    Object.entries(decide([file], realGraph).lanes)
      .filter(([, on]) => on)
      .map(([lane]) => lane);
  assert.deepEqual(lanesOf("tests/agent-context-budget-gate.test.ts"), [
    "lint",
    "build-types",
    "tests",
  ]);
  // tests/test-tiers.test.ts and the other repo-wide guards run in `tests`.
  assert.deepEqual(lanesOf("tests/browser-profiles.integration.test.ts"), [
    "lint",
    "build-types",
    "tests",
    "integration",
  ]);
  assert.deepEqual(lanesOf("tests/browser-harness-actions.engine.test.ts"), [
    "lint",
    "build-types",
    "tests",
  ]);
  const darwin = decide(["tests/kernel-lock.test.ts"], realGraph);
  assert.deepEqual(darwin.nativeMac, ["iphone"]);
  assert.equal(darwin.lanes.integration, false);
  // Support modules and fixtures under tests/ can feed any suite.
  assert.ok(
    Object.entries(decide(["tests/browser-deployment.test-support.ts"], realGraph).lanes).every(
      ([lane, on]) => on || lane === "native-mac",
    ),
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

test("only audited script READMEs skip heavy lanes; mixed, consumed and prettier inputs retain coverage", async () => {
  for (const file of ["scripts/README.md", "scripts/test-vm/README.md"]) {
    const lone = decide([file], graph);
    assert.equal(lone.full, false, file);
    assert.deepEqual(
      Object.entries(lone.lanes)
        .filter(([, on]) => on)
        .map(([lane]) => lane),
      ["lint"],
    );
    for (const other of ["scripts/build.ts", "tests/fixtures/README.md", "unknown"]) {
      const mixed = decide([file, other], graph);
      assert.equal(mixed.full, true);
      assert.ok(mixed.reasons.some((reason) => reason.endsWith(other)));
    }
  }

  for (const file of [
    "scripts/fixtures/README.md",
    "scripts/test-support/README.md",
    "scripts/SKILL.md",
    "scripts/other/README.md",
    "apps/runner/agent-skills/skills/SKILL.md",
  ])
    assert.equal(decide([file], graph).full, true, file);

  const { readFileSync } = await import("node:fs");
  const { defaultTestInclude, defaultTestExclude } = await import("./ci-test-files.mjs");
  const guard = "tests/generated-build-ignores.test.ts";
  const plan = decide([".prettierignore"], graph);
  assert.equal(plan.lanes.tests, true);
  assert.ok(defaultTestInclude.some((glob) => matchesGlob(guard, glob)));
  assert.ok(!defaultTestExclude.some((glob) => matchesGlob(guard, glob)));
  assert.match(readFileSync(guard, "utf8"), /\.prettierignore/);
});

test("release native proof uses release inputs and the hosted release toolchain", () => {
  for (const file of [
    ".github/workflows/release.yml",
    "apps/desktop/native/passkeys/toolchain.json",
    "apps/desktop/native/passkeys/addon.mm",
    "apps/desktop/native/dictation/Sources/DictationHelper/main.swift",
    "apps/desktop/scripts/build-swift-products.ts",
    "packages/apple-data/Sources/OpensteerAppleData/DataContracts.swift",
  ])
    assert.ok(decide([file], realGraph).nativeMac.includes("release-native"), file);
  for (const file of [
    "apps/web/src/app-model.ts",
    "docs/releases.md",
    "scripts/public-download/build.ts",
  ])
    assert.ok(!decide([file], realGraph).nativeMac.includes("release-native"), file);
  const [task] = nativeMacMatrix(["release-native"]);
  assert.equal(task.runner, "macos-26");
  assert.equal(task.xcode, "/Applications/Xcode_26.6.app/Contents/Developer");
});
test("notification preview native suites select their existing lanes", () => {
  const graph = readGraph(process.cwd());
  assert.ok(
    decide(
      ["apps/mobile/modules/notification-preview/ios/Sources/NotificationPreview/Preview.swift"],
      graph,
    ).nativeMac.includes("iphone"),
  );
  assert.equal(
    decide(
      [
        "apps/mobile/modules/notification-preview/android/src/main/java/com/opensteer/notificationpreview/PreviewCrypto.kt",
      ],
      graph,
    ).lanes.android,
    true,
  );
  const fixture = decide(["packages/core/src/fixtures/notification-preview-v1.json"], graph);
  assert.equal(fixture.lanes.android, true);
  assert.equal(fixture.lanes.tests, true);
});
