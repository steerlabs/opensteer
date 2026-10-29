import { test } from "node:test";
import assert from "node:assert/strict";
import { allNativeMacTasks, decide, parseDiff, readGraph, detect } from "./ci-changes.mjs";
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
test("unknown/root/config/lock/toolchain and malformed diff fail open", () => {
  for (const file of [
    "unknown",
    "package.json",
    "pnpm-lock.yaml",
    ".github/scripts/a.mjs",
    "packages/leaf/tsconfig.json",
    "go.work",
  ])
    assert.ok(Object.values(decide([file], graph).lanes).every(Boolean), file);
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
  const n = decide(["apps/desktop/native/Foo.swift"], mac);
  assert.equal(n.lanes["native-mac"], true);
  assert.equal(n.lanes.android, false);
});
test("any workspace edit runs the root darwin-only tests in the Mac lane", () => {
  const web = [{ name: "web", dir: "apps/web", deps: [], coverage: ["tests"] }];
  assert.equal(decide(["apps/web/src/page.ts"], web).lanes["native-mac"], true);
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
  assert.ok(nativeInputs["computer-tests"].includes(file));
  assert.ok(!nativeInputs["passwords-helper"].includes(file));
  const plan = decide([file], realGraph);
  assert.deepEqual(swiftOnly(plan), ["computer-helper", "computer-tests"]);
  const signing = "apps/desktop/src/signed-helpers/metadata.ts";
  assert.ok(nativeInputs["passwords-helper"].includes(signing));
  assert.ok(swiftOnly(decide([signing], realGraph)).includes("passwords-helper"));
});
test("an unrelated edit, even a global one, runs no Swift task", () => {
  const web = decide(["apps/web/src/app-model.ts"], realGraph);
  assert.deepEqual(web.nativeMac, ["iphone"]);
  assert.equal(web.lanes["native-mac"], true);
  const launcher = decide(["scripts/test-integration.ts"], realGraph);
  assert.equal(launcher.full, true);
  assert.deepEqual(launcher.nativeMac, ["iphone"]);
  assert.deepEqual(decide(["docs/testing.md"], realGraph).nativeMac, []);
});
test("Swift sources, node manifests and the CI definition select their tasks", () => {
  assert.deepEqual(swiftOnly(decide(["apps/desktop/native/passwords/Package.swift"], realGraph)), [
    "passwords-helper",
    "passwords-tests",
  ]);
  // passwords-tests runs only `swift test`: installed packages cannot change it.
  assert.deepEqual(swiftOnly(decide(["pnpm-lock.yaml"], realGraph)), [
    "computer-helper",
    "passwords-helper",
    "computer-tests",
  ]);
  assert.deepEqual(decide([".github/workflows/ci.yml"], realGraph).nativeMac, allNativeMacTasks);
  assert.deepEqual(decide([], realGraph, realGraph, true).nativeMac, allNativeMacTasks);
  assert.deepEqual(
    detect({ root: "/missing", event: "pull_request" }).nativeMac,
    allNativeMacTasks,
  );
});
test("the native input list names only tracked files", () => {
  for (const [task, files] of Object.entries(nativeInputs))
    for (const file of files) assert.ok(realFiles.includes(file), `${task}: ${file}`);
});
test("a root test edit selects its own lane and the test typecheck, not everything", () => {
  const lanesOf = (file) =>
    Object.entries(decide([file], realGraph).lanes)
      .filter(([, on]) => on)
      .map(([lane]) => lane);
  assert.deepEqual(lanesOf("tests/agent-context-budget-gate.test.ts"), [
    "lint",
    "build-types",
    "tests",
  ]);
  assert.deepEqual(lanesOf("tests/browser-profiles.integration.test.ts"), [
    "lint",
    "build-types",
    "integration",
  ]);
  assert.deepEqual(lanesOf("tests/browser-harness-actions.engine.test.ts"), [
    "lint",
    "build-types",
  ]);
  const darwin = decide(["tests/kernel-lock.test.ts"], realGraph);
  assert.deepEqual(darwin.nativeMac, ["iphone"]);
  assert.equal(darwin.lanes.tests, false);
  // Support modules and fixtures under tests/ can feed any suite.
  assert.ok(
    Object.values(decide(["tests/browser-deployment.test-support.ts"], realGraph).lanes).every(
      Boolean,
    ),
  );
});
