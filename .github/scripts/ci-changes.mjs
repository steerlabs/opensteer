import { execFileSync } from "node:child_process";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import {
  defaultTestInclude,
  defaultTestExclude,
  integrationTestInclude,
} from "./ci-test-files.mjs";
import { matchesGlob, basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
export const lanes = [
  "lint",
  "build-types",
  "tests",
  "integration",
  "native-mac",
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
      p.endsWith("/package.json"),
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
    if (owned.some((p) => matches(p, integrationTestInclude))) coverage.push("integration");
    if (owned.some((p) => matches(p, defaultTestInclude) && !matches(p, defaultTestExclude)))
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
const global = (p) =>
  /(^|\/)(package\.json|tsconfig[^/]*|vitest[^/]*|.*config\.[^/]+)$/.test(p) ||
  /^(\.github\/|scripts\/|tests\/|patches\/|pnpm-|\.npmrc|\.pnpmfile|go\.(work|mod|sum)|Cargo\.)/.test(
    p,
  ) ||
  /(^|\/)(go\.(mod|sum)|gradle[^/]*|.*\.gradle(\.kts)?|.*lock[^/]*)$/.test(p);
const nativeMac = JSON.parse(
  readFileSync(new URL("./ci-native-mac.json", import.meta.url), "utf8"),
);
const nativeInputs = JSON.parse(
  readFileSync(new URL("./ci-native-inputs.json", import.meta.url), "utf8"),
);
const under = (file, prefix) => file === prefix || file.startsWith(`${prefix}/`);
/**
 * What can change a native-mac task's result: its Swift packages, the CI definition,
 * files its Swift tests read, and for a task that runs node (scripts or Vitest
 * files) what that code imports (ci-native-inputs.json) and the installed packages.
 * The iphone task's Vitest runs also prove it reads and launches nothing else
 * (ci-native-access.mjs).
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
 * The tasks whose inputs `files` touch, so a global edit elsewhere runs none of
 * them. Scheduled and manual runs, and detector errors, select every task.
 */
export function nativeMacTasks(files, { full = false } = {}) {
  return nativeMac.tasks
    .filter(({ task }) => {
      if (full) return true;
      const inputs = nativeMacInputs(task);
      return files.some((file) => inputs.some((input) => under(file, input)));
    })
    .map(({ task }) => task);
}
export function nativeMacMatrix(tasks) {
  return nativeMac.tasks
    .filter(({ task }) => tasks.includes(task))
    .map(({ task, timeout, swift, lane, xcode }) => ({
      task,
      timeout,
      swift: swift.join(" "),
      darwin: lane === true,
      xcode: xcode ?? "/Applications/Xcode.app/Contents/Developer",
    }));
}
export const allNativeMacTasks = nativeMac.tasks.map(({ task }) => task);
/** The task that runs the Darwin-only files and uploads their inventory. */
export const darwinTask = nativeMac.tasks.find((task) => task.lane).task;
// A root test edit needs its own lane, the repo-wide test guards in `tests` and the
// test typecheck in build-types, not every lane. Other files under tests/ (support
// modules, fixtures, quarantine) stay global.
const rootTest = (p) => /^tests\/.*\.test\.tsx?$/.test(p);
/**
 * `full` runs every lane, as main does; `fullMac` also runs every native-mac task,
 * as scheduled and manual runs do. A main push picks its macOS tasks from `files`.
 */
export function decide(files, graph, baseGraph = graph, full = false, { fullMac = full } = {}) {
  const reasons = [];
  const affected = new Set();
  const combined = new Map();
  for (const p of [...baseGraph, ...graph]) {
    const old = combined.get(p.name);
    combined.set(p.name, {
      ...p,
      deps: [...new Set([...(old?.deps ?? []), ...p.deps])],
      coverage: [...new Set([...(old?.coverage ?? []), ...(p.coverage ?? [])])],
    });
  }
  let all = full;
  const rootTests = { any: false, integration: false };
  let androidSource = false;
  if (full) reasons.push("main/manual full run");
  for (const file of files) {
    if (docs(file)) continue;
    if (rootTest(file)) {
      rootTests.any = true;
      if (/\.integration\.test\./.test(file)) rootTests.integration = true;
      continue;
    }
    if (global(file)) {
      all = true;
      reasons.push(`global input: ${file}`);
      continue;
    }
    // This standalone Gradle project intentionally has no Node workspace
    // manifest. It is the sole APK producer named by the Android lane.
    if (file.startsWith("apps/agent-phone/")) {
      androidSource = true;
      continue;
    }
    const owners = [...baseGraph, ...graph].filter((p) => file.startsWith(p.dir + "/"));
    if (!owners.length) {
      all = true;
      reasons.push(`unknown owner: ${file}`);
    } else owners.forEach((p) => affected.add(p.name));
    // Non-manifest consumers: generators, embedded native sources, shipped skills and build inputs.
    if (/\/(scripts|agent-skills)\/|\.(go|sh|proto)$/.test(file)) {
      all = true;
      reasons.push(`non-manifest build/runtime consumers: ${file}`);
    }
  }
  if (affected.size && [...baseGraph, ...graph].some((p) => !Array.isArray(p.coverage))) {
    all = true;
    reasons.push("missing lane discovery metadata");
  }
  if (all) for (const p of combined.values()) affected.add(p.name);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of combined.values())
      if (!affected.has(p.name) && p.deps.some((d) => affected.has(d))) {
        affected.add(p.name);
        grew = true;
      }
  }
  const dirs = [...combined.values()].filter((p) => affected.has(p.name)).map((p) => p.dir);
  // A suite owner and all its transitive workspace dependencies can affect
  // that suite. Union base/head ownership so deletions cannot erase coverage.
  const reaches = (lane) => {
    const pending = [...combined.values()]
      .filter((p) => p.coverage.includes(lane))
      .map((p) => p.name);
    const seen = new Set();
    while (pending.length) {
      const name = pending.pop();
      if (seen.has(name)) continue;
      seen.add(name);
      if (affected.has(name)) return true;
      pending.push(...combined.get(name).deps);
    }
    return false;
  };
  const macTasks = nativeMacTasks(files, { full: fullMac });
  return {
    version: 1,
    full: all,
    reasons,
    affected: [...affected].sort(),
    nativeMac: macTasks,
    lanes: {
      lint: true,
      "build-types": all || dirs.some((d) => d !== "apps/agent-phone") || rootTests.any,
      // Root tests have no workspace manifest and can read any workspace;
      // keep their default-test coverage conservative for every workspace edit.
      tests: all || reaches("tests") || affected.size > 0 || rootTests.any,
      integration: all || reaches("integration") || rootTests.integration,
      "native-mac": macTasks.length > 0,
      android: all || androidSource || reaches("android"),
      "browser-journeys": all || reaches("browser-journeys"),
    },
  };
}
/** A scheduled run with nothing new on main since the last full run. */
export function unchangedPlan(sha) {
  return {
    version: 1,
    full: false,
    unchangedSince: sha,
    reasons: [`main has not changed since the full run of ${sha}`],
    affected: [],
    nativeMac: [],
    lanes: Object.fromEntries(lanes.map((lane) => [lane, false])),
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
    const changed = () =>
      parseDiff(git(root, ["diff", "--name-only", "-z", "--no-renames", base, "HEAD"]));
    if (event === "pull_request") return decide(changed(), graph, readGraph(root, base));
    if (event === "push") {
      // A push of one commit, as a merge is, picks macOS tasks from that commit;
      // anything else (several commits, a new branch) runs them all.
      const single = before === git(root, ["rev-parse", "HEAD^1"]).trim();
      if (!single) return decide([], graph, graph, true);
      return decide(changed(), graph, readGraph(root, base), true, { fullMac: false });
    }
    if (event === "schedule" && unchangedSince) return unchangedPlan(unchangedSince);
    return decide([], graph, graph, true);
  } catch (error) {
    return {
      version: 1,
      full: true,
      detectionError: true,
      affected: [],
      reasons: [`detector fail-open: ${error.message}`],
      nativeMac: allNativeMacTasks,
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
  const shards = JSON.parse(readFileSync(new URL("./ci-shards.json", import.meta.url), "utf8"));
  for (const [lane, count] of Object.entries(shards)) {
    if (!Number.isInteger(count) || count < 1) throw new Error(`Invalid shard count: ${lane}`);
    const line = `${lane}-shards=${JSON.stringify(Array.from({ length: count }, (_, i) => i + 1))}\n`;
    process.stdout.write(line);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  }
  const matrix = `native-mac-tasks=${JSON.stringify(nativeMacMatrix(plan.nativeMac))}\n`;
  process.stdout.write(matrix);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, matrix);
  for (const [key, value] of Object.entries(plan.lanes)) {
    const line = `${key}=${value}\n`;
    process.stdout.write(line);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  }
}
