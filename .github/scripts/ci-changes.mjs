import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import {
  darwinOnlyTests,
  defaultTestInclude,
  defaultTestExclude,
  integrationTestInclude,
  optInIntegrationBenchmarks,
  realBrowserTests,
  windowsTestInclude,
} from "./ci-test-files.mjs";
import { importClosure, importEdges, importers, reverseEdges } from "./ci-imports.mjs";
import { unknownDuration } from "./ci-sharding.mjs";
import { matchesGlob, basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
export const lanes = [
  "lint",
  "build-types",
  "build",
  "tests",
  "integration",
  "native-mac",
  "native-windows",
  "android",
  "browser-journeys",
];
const git = (root, args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
export function parseDiff(text) {
  if (!text) return [];
  if (!text.endsWith("\0")) throw new Error("Diff is not NUL terminated");
  return text.slice(0, -1).split("\0");
}
export function readGraph(root, ref) {
  const paths = parseDiff(
    git(root, ref ? ["ls-tree", "-rz", "--name-only", ref] : ["ls-files", "-z"]),
  );
  const workspace = ref
    ? git(root, ["show", `${ref}:pnpm-workspace.yaml`])
    : readFileSync(resolve(root, "pnpm-workspace.yaml"), "utf8");
  // Deliberately support only this repository's explicit one-level workspace globs.
  const groups = [...workspace.matchAll(/^\s*-\s+['"]?([\w-]+)\/\*['"]?\s*$/gm)].map((m) => m[1]);
  if (!groups.length) throw new Error("Unsupported workspace definition");
  const manifests = paths.filter(
    (p) =>
      groups.some((g) => p.startsWith(g + "/")) &&
      p.split("/").length === 3 &&
      p.endsWith("/package.json") &&
      (ref || existsSync(resolve(root, p))),
  );
  const graph = manifests.map((file) => {
    const m = JSON.parse(
      ref ? git(root, ["show", `${ref}:${file}`]) : readFileSync(resolve(root, file), "utf8"),
    );
    if (typeof m.name !== "string") throw new Error(`Missing name: ${file}`);
    const deps = Object.entries({
      ...m.dependencies,
      ...m.devDependencies,
      ...m.optionalDependencies,
      ...m.peerDependencies,
    })
      .filter(([, v]) => String(v).startsWith("workspace:"))
      .map(([k]) => k);
    const dir = file.slice(0, -13);
    const owned = paths.filter((p) => p.startsWith(dir + "/"));
    const matches = (file, globs) => globs.some((glob) => matchesGlob(file, glob));
    const coverage = [];
    if (owned.some((p) => realBrowserTests.includes(p))) coverage.push("browser-journeys");
    if (owned.some((p) => matches(p, integrationTestInclude))) coverage.push("integration");
    if (
      owned.some(
        (p) =>
          matches(p, defaultTestInclude) &&
          !matches(p, defaultTestExclude) &&
          !realBrowserTests.includes(p),
      )
    )
      coverage.push("tests");
    // Swift packages are built/tested on macOS; include their manifest dependency
    // closure below because the native lane also exercises their TS wire consumers.
    if (owned.some((p) => p.endsWith(".swift"))) coverage.push("native-mac");
    // The Android lane builds the standalone Gradle project (handled by path
    // below), phone setup workspaces and the generated agent-phone wire vectors.
    if (m.name.includes("agent-phone") || owned.some((p) => basename(p).startsWith("agent-phone-")))
      coverage.push("android");
    // Browser journeys are declared in package scripts and use Playwright.
    // Include every such owner rather than matching a directory-name substring.
    const scripts = Object.values(m.scripts ?? {});
    const browser = Object.hasOwn({ ...m.dependencies, ...m.devDependencies }, "playwright-core");
    if (
      browser &&
      (m.scripts?.["test:integration"] || scripts.some((v) => /-journey\.[cm]?[jt]s/.test(v)))
    )
      coverage.push("browser-journeys");
    return { name: m.name, dir, deps, coverage };
  });
  const names = new Set(graph.map((p) => p.name));
  if (
    !graph.length ||
    names.size !== graph.length ||
    graph.some((p) => p.deps.some((d) => !names.has(d)))
  )
    throw new Error("Incomplete workspace graph");
  return graph;
}
const docs = (p) =>
  !/fixture|test-support|(?:^|\/)SKILL\.md$/i.test(p) &&
  (p.startsWith("docs/") ||
    /^[^/]+\.md$/.test(p) ||
    /^(LICENSE|NOTICE|THIRD_PARTY_NOTICES)(\.[^/]*)?$/.test(p));
// Contributor guidance: agent instructions and skills for working on this repo.
// Nothing builds, ships or tests them, so they select no lane beyond lint.
const guidance = (p) => /^\.(agents|claude)\//.test(p);
// Lint runs actionlint and the CI scripts' own tests; the scheduled full run backs them up.
const ciDefinition = (p) => p.startsWith(".github/") || /^scripts\/ci-[^/]+$/.test(p);
// Every workspace compiles or installs with these: typecheck everything, run every unit test.
const rootConfig = (p) =>
  /^(package\.json|tsconfig[^/]*\.json|\.npmrc|pnpm-workspace\.yaml|\.pnpmfile\.cjs)$/.test(p) ||
  p.startsWith("patches/");
// Outside any workspace: the files that import or name them decide their lanes.
const loose = (p) =>
  /^(scripts|tests|deploy|tooling)\//.test(p) ||
  /^(vitest(\.[\w-]+)?\.config\.ts|\.oxlintrc\.json|\.prettierrc\.json|\.prettierignore|\.gitignore|\.dockerignore|\.env\.example)$/.test(
    p,
  );
const code = (p) => /\.[cm]?[jt]sx?$/.test(p);
const isTest = (p) => /\.test\.[cm]?[jt]sx?$/.test(p);
// A lane's runner: a change to these, or to what they import, reruns the lane's whole suite.
const harness = {
  tests: ["vitest.config.ts"],
  integration: ["vitest.integration.config.ts", "scripts/test-integration.ts", "deploy/compose"],
  "browser-journeys": ["vitest.browser.config.ts"],
};
// This standalone Gradle project intentionally has no Node workspace manifest; the
// Kotlin modules beside it and the shared fixtures its tests read select it too.
const androidSource = (p) =>
  p.startsWith("apps/agent-phone/") ||
  /^apps\/mobile\/modules\/(notification-preview|phone-connection|phone-browser|remote-text-input)\/android\//.test(
    p,
  ) ||
  p === "packages/core/src/fixtures/notification-preview-v1.json" ||
  p === "packages/runner-auth/fixtures/device-proofs.v1.json" ||
  p.startsWith("packages/browser-core/test-vectors/") ||
  p === "apps/mobile/modules/phone-browser/index.ts" ||
  p === "apps/mobile/modules/phone-browser/types.ts";
const nativeMac = JSON.parse(
  readFileSync(new URL("./ci-native-mac.json", import.meta.url), "utf8"),
);
const nativeInputs = JSON.parse(
  readFileSync(new URL("./ci-native-inputs.json", import.meta.url), "utf8"),
);
const shardLimits = JSON.parse(readFileSync(new URL("./ci-shards.json", import.meta.url), "utf8"));
const durations = JSON.parse(readFileSync(new URL("./ci-durations.json", import.meta.url), "utf8"));
const under = (file, prefix) => file === prefix || file.startsWith(`${prefix}/`);
/**
 * What can change a native-mac task's result: its Swift packages, the CI definition,
 * files its Swift tests read, and for a task that runs node (scripts or Vitest
 * files) what that code imports (ci-native-inputs.json) and the installed packages.
 * The iphone task's Vitest runs also prove it reads and launches nothing else
 * (ci-native-access.mjs). Main pushes select with these.
 */
export function nativeMacInputs(name) {
  const task = nativeMac.tasks.find((entry) => entry.task === name);
  if (!task) throw new Error(`Unknown native-mac task: ${name}`);
  return [
    ...nativeMac.ciInputs,
    ...task.swift,
    ...(task.extra ?? []),
    ...(task.scripts?.length || task.vitest?.length
      ? [...nativeMac.nodeInputs, ...(nativeInputs[task.task] ?? [])]
      : []),
  ];
}
/**
 * A PR selects a native-mac task only for its own sources, test files, and scripts with the
 * desktop build tooling they import; shared packages and installs wait for main.
 */
export function nativeMacOwnInputs(name) {
  const task = nativeMac.tasks.find((entry) => entry.task === name);
  if (!task) throw new Error(`Unknown native-mac task: ${name}`);
  return [
    ...task.swift,
    ...(task.extra ?? []),
    ...(task.scripts ?? []),
    ...(task.vitest ?? []),
    ...(task.lane ? darwinOnlyTests : []),
    ...(nativeInputs[task.task] ?? []).filter((input) => input.startsWith("apps/desktop/scripts/")),
  ];
}
/**
 * The tasks whose inputs `files` touch. Scheduled and manual runs, and detector errors,
 * select every task.
 */
export function nativeMacTasks(files, { full = false, narrow = false } = {}) {
  return nativeMac.tasks
    .filter(({ task }) => {
      if (full) return true;
      const inputs = narrow ? nativeMacOwnInputs(task) : nativeMacInputs(task);
      return files.some((file) => inputs.some((input) => under(file, input)));
    })
    .map(({ task }) => task);
}
export function nativeMacMatrix(tasks) {
  return nativeMac.tasks
    .filter(({ task }) => tasks.includes(task))
    .map(({ task, timeout, swift, lane, xcode, runner }) => ({
      task,
      timeout,
      runner: runner ?? "macos-15",
      swift: swift.join(" "),
      darwin: lane === true,
      xcode: xcode ?? "/Applications/Xcode.app/Contents/Developer",
    }));
}
export const allNativeMacTasks = nativeMac.tasks.map(({ task }) => task);
const nativeWindows = JSON.parse(
  readFileSync(new URL("./ci-native-windows.json", import.meta.url), "utf8"),
);
/**
 * What can change the native-windows result: the CI definition, its Go modules,
 * the installed packages, what its build scripts and Windows-real Vitest files
 * import (ci-native-inputs.json), and any Windows-real test file, new ones included.
 * Main pushes select with these; a PR uses only the lane's own files.
 */
export function nativeWindowsInputs({ narrow = false } = {}) {
  const shared = new Set([
    ...nativeMac.ciInputs,
    ".github/scripts/ci-test-files.mjs",
    "scripts/ci-inventory-reporter.ts",
  ]);
  if (narrow)
    return [
      ...nativeWindows.ciInputs.filter((input) => !shared.has(input)),
      ...nativeWindows.go,
      ...nativeWindows.scripts,
      ...nativeWindows.vitest,
    ];
  return [
    ...nativeWindows.ciInputs,
    ...nativeWindows.go,
    ...nativeMac.nodeInputs,
    ...(nativeInputs["native-windows"] ?? []),
  ];
}
/** Scheduled and manual runs, and detector errors, always run it. */
export function nativeWindowsSelected(files, { full = false, narrow = false } = {}) {
  if (full) return true;
  const inputs = nativeWindowsInputs({ narrow });
  return files.some(
    (file) =>
      inputs.some((input) => under(file, input)) ||
      windowsTestInclude.some((glob) => matchesGlob(file, glob)),
  );
}
/** The task that runs the Darwin-only files and uploads their inventory. */
export const darwinTask = nativeMac.tasks.find((task) => task.lane).task;
/** Every file the Linux unit and integration lanes discover, as their Vitest configs do. */
export function laneUniverse(tracked) {
  const matches = (file, globs) => globs.some((glob) => matchesGlob(file, glob));
  return {
    tests: tracked.filter(
      (file) =>
        matches(file, defaultTestInclude) &&
        !matches(file, defaultTestExclude) &&
        !realBrowserTests.includes(file) &&
        !darwinOnlyTests.includes(file) &&
        !file.split("/").includes("node_modules"),
    ),
    integration: tracked.filter(
      (file) =>
        matches(file, integrationTestInclude) &&
        !optInIntegrationBenchmarks.includes(file) &&
        !file.split("/").includes("node_modules"),
    ),
  };
}
/** Importer directories whose lockfile entries differ, and whether anything else differs. */
export function lockfileChanges(base, head) {
  const split = (text) => {
    const importers = new Map();
    let rest = "";
    let section;
    let key;
    for (const line of text.split("\n")) {
      if (/^\S/.test(line)) {
        section = line;
        key = undefined;
      }
      const entry = section === "importers:" && /^ {2}(\S.*):\s*$/.exec(line);
      if (entry) key = entry[1].replace(/^['"]|['"]$/g, "");
      if (section === "importers:" && key !== undefined)
        importers.set(key, (importers.get(key) ?? "") + line + "\n");
      else rest += line + "\n";
    }
    return { importers, rest };
  };
  const before = split(base);
  const after = split(head);
  const keys = new Set([...before.importers.keys(), ...after.importers.keys()]);
  return {
    importers: [...keys].filter((k) => before.importers.get(k) !== after.importers.get(k)).sort(),
    other: before.rest !== after.rest,
  };
}
// Vitest treats each path argument as a substring filter; name everything it will match.
function expandFilters(selected, universe) {
  const lower = new Map(universe.map((file) => [file, file.toLowerCase()]));
  const chosen = new Set(selected);
  for (let grew = true; grew;) {
    grew = false;
    const filters = [...chosen].map((file) => file.toLowerCase());
    for (const file of universe)
      if (!chosen.has(file) && filters.some((filter) => lower.get(file).includes(filter))) {
        chosen.add(file);
        grew = true;
      }
  }
  return universe.filter((file) => chosen.has(file));
}
/** Shards in proportion to the selected files' recorded duration, up to the full count. */
export function shardCount(lane, selected, universe) {
  if (!selected.length) return 0;
  const weight = (files) =>
    files.reduce((sum, file) => sum + (durations[lane][file] ?? unknownDuration[lane]), 0);
  const limit = shardLimits[lane];
  return Math.max(1, Math.min(limit, Math.ceil((limit * weight(selected)) / weight(universe))));
}
const emptyRepo = { tracked: [], read: () => undefined, readBase: () => undefined };
/**
 * `event` is "pull_request", "push" (main, against the previous head) or "full"
 * (scheduled and manual runs). Pull requests and main pushes run only the unit and
 * integration files the change can reach; a PR runs native and Android work only for
 * their own sources, a main push for everything they import.
 */
export function decide(
  files,
  graph,
  baseGraph = graph,
  { event = "pull_request", repo = emptyRepo } = {},
) {
  const full = event === "full";
  const narrow = event === "pull_request";
  const reasons = [];
  const combined = new Map();
  for (const p of [...baseGraph, ...graph]) {
    const old = combined.get(p.name);
    combined.set(p.name, {
      ...p,
      deps: [...new Set([...(old?.deps ?? []), ...p.deps])],
      coverage: [...new Set([...(old?.coverage ?? []), ...(p.coverage ?? [])])],
    });
  }
  const packages = [...combined.values()];
  const ownerOf = (file) => packages.filter((p) => file.startsWith(p.dir + "/"));
  const affected = new Set();
  // Packages whose own files changed, including test-only edits that select no dependents.
  const touched = new Set();
  const direct = new Set();
  const whole = { tests: full, integration: full, "browser-journeys": full };
  let everything = full;
  let typecheckAll = full;
  let typecheckTests = false;
  let android = false;
  if (full) reasons.push("full run");
  let scan;
  const index = () => {
    if (scan) return scan;
    const edges = importEdges(repo.tracked, repo.read);
    const reverse = reverseEdges(edges.files);
    const universe = laneUniverse(repo.tracked);
    const tests = new Set([...universe.tests, ...universe.integration, ...realBrowserTests]);
    const texts = new Map();
    const text = (file) => {
      if (!texts.has(file)) texts.set(file, repo.read(file) ?? "");
      return texts.get(file);
    };
    const runners = Object.fromEntries(
      Object.entries(harness).map(([lane, roots]) => [
        lane,
        { roots, files: importClosure(roots, edges.files) },
      ]),
    );
    scan = { edges, reverse, universe, tests, text, runners };
    return scan;
  };
  const mentions = (body, file) =>
    new RegExp(`(?<![\\w./-])${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/-])`).test(body);
  for (const file of files) {
    if (docs(file) || guidance(file)) continue;
    if (ciDefinition(file)) {
      reasons.push(`CI definition: ${file}`);
      continue;
    }
    if (file === "pnpm-lock.yaml") {
      const base = repo.readBase(file);
      const head = repo.read(file);
      const lock =
        base === undefined || head === undefined ? undefined : lockfileChanges(base, head);
      const dirs = lock?.importers ?? [];
      for (const dir of dirs) {
        const owner = packages.find((p) => p.dir === dir);
        if (owner) {
          affected.add(owner.name);
          touched.add(owner.name);
        }
      }
      if (!lock || dirs.includes(".") || dirs.some((d) => !packages.some((p) => p.dir === d))) {
        typecheckAll = whole.tests = true;
        reasons.push("lockfile: root or unreadable importer changed");
      } else if (!dirs.length && lock.other) {
        typecheckAll = whole.tests = true;
        reasons.push("lockfile: shared dependencies changed");
      }
      continue;
    }
    if (rootConfig(file)) {
      typecheckAll = whole.tests = true;
      reasons.push(`root config: ${file}`);
      continue;
    }
    if (androidSource(file)) {
      android = true;
      if (file.startsWith("apps/agent-phone/") || file.includes("/android/")) continue;
    }
    const owners = ownerOf(file);
    if (!owners.length && !loose(file)) {
      everything = true;
      reasons.push(`unknown path: ${file}`);
      continue;
    }
    if (
      owners.some((p) => p.name.includes("agent-phone")) ||
      basename(file).startsWith("agent-phone-")
    )
      android = true;
    const { reverse, tests, text, runners } = index();
    for (const p of owners) {
      touched.add(p.name);
      // A changed test file runs itself and its importers, not its package's dependents.
      if (!isTest(file)) affected.add(p.name);
    }
    if (!owners.length && code(file)) typecheckTests = true;
    if (tests.has(file)) direct.add(file);
    for (const importer of importers(file, reverse)) {
      if (tests.has(importer)) direct.add(importer);
      for (const p of ownerOf(importer)) affected.add(p.name);
    }
    for (const test of tests) if (mentions(text(test), file)) direct.add(test);
    for (const [lane, runner] of Object.entries(runners)) {
      if (runner.roots.some((root) => under(file, root)) || runner.files.has(file)) {
        whole[lane] = true;
        reasons.push(`${lane} runner: ${file}`);
      }
    }
  }
  if (everything) {
    for (const p of packages) affected.add(p.name);
    whole.tests = whole.integration = whole["browser-journeys"] = typecheckAll = true;
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const p of packages)
      if (!affected.has(p.name) && p.deps.some((d) => affected.has(d))) {
        affected.add(p.name);
        grew = true;
      }
  }
  const reaches = (lane) => packages.some((p) => p.coverage.includes(lane) && affected.has(p.name));
  const selection = { tests: [], integration: [] };
  let rootBrowser = false;
  if (repo.tracked.length && (affected.size || direct.size || whole.tests || whole.integration)) {
    const { edges, universe } = index();
    const names = new Set(packages.map((p) => p.name));
    // Root tests import across workspaces without a manifest. A changed file in their import
    // closure already selected them; otherwise they run when a workspace package that closure
    // imports by name is affected. One that reaches no workspace at all is a repository guard.
    const reach = (file) => {
      const reached = { owned: false, names: new Set() };
      for (const found of importClosure([file], edges.files)) {
        if (ownerOf(found).length) reached.owned = true;
        for (const name of edges.packages.get(found) ?? [])
          if (names.has(name)) reached.names.add(name);
      }
      return reached;
    };
    const rootSelected = (file) => [...reach(file).names].some((name) => affected.has(name));
    const isGuard = (file) => {
      const reached = reach(file);
      return !reached.owned && !reached.names.size;
    };
    const guards = [];
    for (const lane of ["tests", "integration"]) {
      for (const file of universe[lane]) {
        const owners = ownerOf(file);
        if (whole[lane] || direct.has(file)) selection[lane].push(file);
        else if (owners.length) {
          if (owners.some((p) => affected.has(p.name))) selection[lane].push(file);
        } else if (lane === "tests" && isGuard(file)) guards.push(file);
        else if (rootSelected(file)) selection[lane].push(file);
      }
    }
    // Root guards that import no workspace scan the repository's files; they run whenever
    // the unit lane does.
    if (selection.tests.length) selection.tests.push(...guards);
    for (const lane of ["tests", "integration"])
      selection[lane] = expandFilters(selection[lane], universe[lane]).sort();
    rootBrowser = realBrowserTests.some(
      (file) => direct.has(file) || (!ownerOf(file).length && rootSelected(file)),
    );
  }
  const universe = repo.tracked.length ? index().universe : { tests: [], integration: [] };
  const macTasks = nativeMacTasks(files, { full, narrow });
  const unit = selection.tests.length > 0;
  const integration = selection.integration.length > 0;
  const build = full
    ? "all"
    : event === "push"
      ? typecheckAll
        ? "all"
        : [...affected].sort()
      : [];
  const typecheck = typecheckAll
    ? "all"
    : [...new Set([...affected, ...touched])].sort().filter((name) => combined.has(name));
  return {
    version: 2,
    full: everything,
    reasons,
    affected: [...affected].sort(),
    nativeMac: macTasks,
    files: selection,
    whole: { tests: whole.tests && unit, integration: whole.integration && integration },
    shards: {
      tests: shardCount("tests", selection.tests, universe.tests),
      integration: shardCount("integration", selection.integration, universe.integration),
    },
    typecheck,
    // Nothing downstream consumes these builds; main proves them for what it changed.
    build,
    lanes: {
      lint: true,
      "build-types": typecheckAll || typecheckTests || typecheck.length > 0 || unit || integration,
      build: build.length > 0,
      tests: unit,
      integration,
      "native-mac": macTasks.length > 0,
      "native-windows": nativeWindowsSelected(files, { full, narrow }),
      android: full || android || (!narrow && reaches("android")),
      "browser-journeys": whole["browser-journeys"] || reaches("browser-journeys") || rootBrowser,
    },
  };
}
const idle = () => ({
  files: { tests: [], integration: [] },
  whole: { tests: false, integration: false },
  shards: { tests: 0, integration: 0 },
  typecheck: [],
  build: [],
});
/** A scheduled run with nothing new on main since the last full run. */
export function unchangedPlan(sha) {
  return {
    version: 2,
    full: false,
    unchangedSince: sha,
    reasons: [`main has not changed since the full run of ${sha}`],
    affected: [],
    nativeMac: [],
    ...idle(),
    // Time-based quarantine expiry and published Stable compatibility still gate an idle main.
    lanes: Object.fromEntries(lanes.map((lane) => [lane, lane === "lint"])),
  };
}
export function detect({
  root = process.cwd(),
  event = process.env.EVENT_NAME,
  base = "HEAD^1",
  before = process.env.BEFORE_SHA,
  unchangedSince,
} = {}) {
  try {
    const graph = readGraph(root);
    const repo = {
      tracked: parseDiff(git(root, ["ls-files", "-z"])),
      read: (file) => {
        try {
          return readFileSync(resolve(root, file), "utf8");
        } catch {
          return undefined;
        }
      },
      readBase: (file) => {
        try {
          return git(root, ["show", `${base}:${file}`]);
        } catch {
          return undefined;
        }
      },
    };
    const changed = () =>
      parseDiff(git(root, ["diff", "--name-only", "-z", "--no-renames", base, "HEAD"]));
    if (event === "pull_request")
      return decide(changed(), graph, readGraph(root, base), { event, repo });
    if (event === "push") {
      // A push of one commit, as a merge is, checks what that commit changed; anything
      // else (several commits, a new branch, a force push) runs everything.
      const single = before === git(root, ["rev-parse", "HEAD^1"]).trim();
      if (!single) return decide([], graph, graph, { event: "full", repo });
      return decide(changed(), graph, readGraph(root, base), { event, repo });
    }
    if (event === "schedule" && unchangedSince) return unchangedPlan(unchangedSince);
    return decide([], graph, graph, { event: "full", repo });
  } catch (error) {
    return {
      version: 2,
      full: true,
      detectionError: true,
      affected: [],
      reasons: [`detector fail-open: ${error.message}`],
      nativeMac: allNativeMacTasks,
      ...idle(),
      whole: { tests: true, integration: true },
      shards: { ...shardLimits },
      typecheck: "all",
      build: "all",
      lanes: Object.fromEntries(lanes.map((k) => [k, true])),
    };
  }
}
/**
 * The commit of the newest earlier scheduled or manual main run that passed. A
 * failed, cancelled or unfinished run qualified nothing, so the next scheduled run
 * takes everything again; a later run cannot vouch for a re-run of an earlier one.
 */
export async function lastFullRunSha({
  repository = process.env.GITHUB_REPOSITORY,
  runNumber = process.env.GITHUB_RUN_NUMBER,
  token = process.env.GITHUB_TOKEN,
  request = fetch,
} = {}) {
  const runs = [];
  for (const event of ["schedule", "workflow_dispatch"]) {
    const response = await request(
      `https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs?branch=main&event=${event}&status=success&per_page=20`,
      { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}` } },
    );
    if (!response.ok) throw new Error(`Listing ${event} runs failed: HTTP ${response.status}`);
    runs.push(...(await response.json()).workflow_runs);
  }
  return runs
    .filter(
      (run) =>
        run.head_branch === "main" &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        run.run_number < Number(runNumber),
    )
    .sort((left, right) => right.run_number - left.run_number)[0]?.head_sha;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let unchangedSince;
  if (process.env.EVENT_NAME === "schedule") {
    // A failed lookup runs the full plan rather than skip it.
    const last = await lastFullRunSha().catch((error) => {
      console.warn(`Running the full plan: ${error.message}`);
      return undefined;
    });
    if (last && last === git(process.cwd(), ["rev-parse", "HEAD"]).trim()) unchangedSince = last;
  }
  const plan = detect({ unchangedSince });
  writeFileSync(process.env.CI_PLAN_PATH ?? "ci-plan.json", JSON.stringify(plan, null, 2) + "\n");
  const filters = (scope, suffix = "") =>
    scope === "all" ? "all" : scope.map((name) => `--filter=${name}${suffix}`).join(" ");
  const outputs = {
    "tests-shards": JSON.stringify(Array.from({ length: plan.shards.tests }, (_, i) => i + 1)),
    "integration-shards": JSON.stringify(
      Array.from({ length: plan.shards.integration }, (_, i) => i + 1),
    ),
    "native-mac-tasks": JSON.stringify(nativeMacMatrix(plan.nativeMac)),
    "typecheck-filters": filters(plan.typecheck),
    // An app's build may read its workspace dependencies' builds.
    "build-filters": filters(plan.build, "..."),
    ...plan.lanes,
  };
  for (const [key, value] of Object.entries(outputs)) {
    const line = `${key}=${value}\n`;
    process.stdout.write(line);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  }
}
