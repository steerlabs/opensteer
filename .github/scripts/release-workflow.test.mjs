import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { parseDocument } from "yaml";
import { preflight, qualifiedPreflight, discover } from "./release-plan.mjs";
const text = readFileSync(new URL("../workflows/release.yml", import.meta.url), "utf8");
const doc = parseDocument(text, { uniqueKeys: true });
const workflow = doc.toJS();
test("only main pushes and explicit dispatch can release; default coalescing never cancels running builds", () => {
  assert.deepEqual(doc.errors, []);
  assert.deepEqual(doc.warnings, []);
  assert.deepEqual(Object.keys(workflow.on).sort(), ["push", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.equal(workflow.on.push.tags, undefined);
  assert.equal(workflow.on.schedule, undefined);
  assert.ok(workflow.on.push["paths-ignore"].length > 0);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.channel.options, ["insider", "stable"]);
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false);
  assert.ok(workflow.on.workflow_dispatch.inputs.insider_tag);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(Object.keys(workflow.concurrency).sort(), ["cancel-in-progress", "group"]);
  assert.match(workflow.concurrency.group, /^release-desktop-/);
});
test("read-only preflight, secret-free discovery and only stable publication approval", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.doesNotMatch(text, /pull_request_target|OPENSTEER_DESKTOP_UPDATE_/);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.ok(["ubuntu-latest", "macos-15"].includes(job["runs-on"]));
    assert.deepEqual(job.permissions ?? workflow.permissions, {
      contents: ["discover", "draft", "publish-insider", "publish-stable"].includes(name)
        ? "write"
        : "read",
      ...(name === "preflight" ? { actions: "read" } : {}),
    });
    assert.equal(
      job.environment,
      name === "build" ? "release" : name === "publish-stable" ? "publish" : undefined,
    );
    for (const step of job.steps) {
      if (step.uses) assert.match(step.uses, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
      if (step.uses?.startsWith("actions/checkout@"))
        assert.equal(step.with["persist-credentials"], false);
      if (JSON.stringify(step).includes("secrets.")) assert.equal(name, "build");
      assert.doesNotMatch(step.run ?? "", /\$\{\{\s*(inputs\.|github\.ref)/);
    }
  }
  assert.equal(workflow.jobs.discover.needs, "preflight");
  assert.ok(workflow.jobs.build.needs.includes("discover"));
  assert.match(
    workflow.jobs.build.steps.find((step) => step.run?.includes("stampReleaseVersion")).run,
    /release-version.cjs/,
  );
  const checkout = workflow.jobs.build.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(checkout.with["fetch-depth"], 0);
  const names = [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(names)].sort(),
    [
      "APPLE_API_ISSUER",
      "APPLE_API_KEY_ID",
      "APPLE_API_KEY_P8",
      "CSC_KEY_PASSWORD",
      "CSC_LINK",
      "MACOS_PASSWORDS_PROVISIONING_PROFILE_BASE64",
      "OPENSTEER_AGENT_PHONE_KEYSTORE_BASE64",
      "OPENSTEER_AGENT_PHONE_KEYSTORE_PASSWORD",
    ].sort(),
  );
  const signing = workflow.jobs.build.steps.find(
    (step) => step.name === "Sign, notarize and staple desktop",
  );
  assert.match(signing.run, /::add-mask::/);
  assert.match(signing.run, /umask 077/);
  assert.match(
    workflow.jobs.build.steps.find((step) => step.name === "Delete signing material").if,
    /always/,
  );
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "release-plan-"));
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Release Test");
  git("config", "user.email", "release@opensteer.invalid");
  git("config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  git("add", ".");
  git("commit", "-m", "base");
  writeFileSync(path.join(root, "change"), "first");
  git("add", ".");
  git("commit", "-m", "first");
  const sha = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", sha);
  git("tag", "--no-sign", "v1.2.4-insider");
  const source = { sha, version: "1.2.4", channel: "beta", tag: "v1.2.4-insider" };
  const state = {
    releases: [],
    manifest: { sourceSha: sha, version: source.version, channel: "beta", tag: source.tag },
    runs: [
      {
        id: 42,
        run_number: 7,
        head_sha: sha,
        head_branch: "main",
        event: "push",
        status: "completed",
        conclusion: "success",
      },
    ],
    fullRuns: [
      {
        id: 43,
        run_number: 8,
        head_sha: sha,
        head_branch: "main",
        event: "schedule",
        status: "completed",
        conclusion: "success",
      },
    ],
    jobs: [{ name: "Check", status: "completed", conclusion: "success" }],
    fullJobs: [{ name: "Check", status: "completed", conclusion: "success" }],
    fullQueries: 0,
  };
  const run = (exe, args) => {
    if (exe === "git") return args[0] === "fetch" ? "" : git(...args);
    assert.equal(exe, "gh");
    if (state.apiFailure) throw Error("API unavailable");
    if (args[0] === "release") {
      writeFileSync(
        path.join(args[args.indexOf("--dir") + 1], "release.json"),
        JSON.stringify(state.manifest),
      );
      return "";
    }
    const url = args.at(-1);
    if (url.includes("/actions/workflows/ci.yml/runs?")) {
      if (url.includes("event=push")) return JSON.stringify([{ workflow_runs: state.runs }]);
      state.fullQueries++;
      assert.ok(url.includes("branch=main") && url.includes("status=completed"));
      return JSON.stringify([{ workflow_runs: state.fullRuns }]);
    }
    if (url.includes("/actions/runs/43/jobs?")) return JSON.stringify([{ jobs: state.fullJobs }]);
    if (url.includes("/actions/runs/42/jobs?")) return JSON.stringify([{ jobs: state.jobs }]);
    assert.ok(url.endsWith("/releases"));
    return JSON.stringify([
      state.releases.filter(
        (item) => !item.draft || workflow.jobs.discover.permissions.contents === "write",
      ),
    ]);
  };
  return {
    root,
    git,
    source,
    state,
    run,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
function published(source) {
  return {
    tag_name: source.tag,
    target_commitish: source.sha,
    draft: false,
    prerelease: true,
    published_at: "2026-10-30T00:00:00Z",
  };
}
test("push and manual insider resolve main and derive its numeric version", () => {
  const f = fixture();
  try {
    assert.deepEqual(preflight({ root: f.root, event: "push" }, f.run), f.source);
    assert.deepEqual(
      preflight({ root: f.root, event: "workflow_dispatch", channel: "insider" }, f.run),
      f.source,
    );
  } finally {
    f.close();
  }
});
test("stable rebuilds the exact published insider source and version, even after main advances", () => {
  const f = fixture();
  try {
    f.state.releases = [published(f.source)];
    writeFileSync(path.join(f.root, "change"), "second");
    f.git("commit", "-am", "second");
    f.git("update-ref", "refs/remotes/origin/main", f.git("rev-parse", "HEAD"));
    assert.deepEqual(
      preflight(
        { root: f.root, event: "workflow_dispatch", channel: "stable", insiderTag: f.source.tag },
        f.run,
      ),
      { ...f.source, channel: "stable", tag: "desktop-v1.2.4" },
    );
    for (const mutation of [
      { draft: true },
      { prerelease: false },
      { target_commitish: "b".repeat(40) },
    ]) {
      f.state.releases = [{ ...published(f.source), ...mutation }];
      assert.throws(() =>
        preflight({ root: f.root, channel: "stable", insiderTag: f.source.tag }, f.run),
      );
    }
    f.state.releases = [published(f.source)];
    for (const mutation of [
      { sourceSha: "b".repeat(40) },
      { version: "1.2.5" },
      { channel: "stable" },
      { tag: "v1.2.5-insider" },
    ]) {
      f.state.manifest = { sourceSha: f.source.sha, ...f.source, ...mutation };
      assert.throws(() =>
        preflight({ root: f.root, channel: "stable", insiderTag: f.source.tag }, f.run),
      );
    }
    assert.throws(() => preflight({ root: f.root, channel: "stable", insiderTag: "" }, f.run));
  } finally {
    f.close();
  }
});
test("stable also needs the latest completed green full CI including its source on first-parent main", () => {
  const f = fixture();
  try {
    f.state.releases = [published(f.source)];
    const options = { root: f.root, channel: "stable", insiderTag: f.source.tag };
    const full = f.state.fullRuns[0];
    const message = new RegExp(`stable needs a green full CI run that includes ${f.source.sha}`);
    for (const mutation of [
      { conclusion: "failure" },
      { head_sha: f.git("rev-parse", "HEAD^") },
      { head_sha: "b".repeat(40) },
      { head_branch: "other" },
      { event: "push" },
      { event: "pull_request" },
      { status: "in_progress" },
      { id: "43" },
    ]) {
      f.state.fullRuns = [{ ...full, ...mutation }];
      assert.throws(() => preflight(options, f.run), message);
    }
    f.state.fullRuns = [];
    assert.throws(() => preflight(options, f.run), {
      message: `stable needs a green full CI run that includes ${f.source.sha}; dispatch a full CI run on main (gh workflow run ci.yml --ref main) or wait for the scheduled run`,
    });
    // Do not fall back to an older green full run when the latest completed one failed.
    f.state.fullRuns = [full, { ...full, run_number: 9, conclusion: "failure" }];
    assert.throws(() => preflight(options, f.run), message);
    f.state.fullRuns = [full];
    const job = f.state.fullJobs[0];
    for (const jobs of [[], [{ ...job, conclusion: "failure" }], [{ ...job, status: "queued" }]]) {
      f.state.fullJobs = jobs;
      assert.throws(() => preflight(options, f.run), message);
    }
    f.state.fullJobs = [job];
    // Equal and later full-run sources both qualify; incomplete newer runs are ignored.
    assert.equal(preflight(options, f.run).sha, f.source.sha);
    writeFileSync(path.join(f.root, "change"), "later main");
    f.git("commit", "-am", "later main");
    const later = f.git("rev-parse", "HEAD");
    f.git("update-ref", "refs/remotes/origin/main", later);
    for (const event of ["schedule", "workflow_dispatch"]) {
      f.state.fullRuns = [
        { ...full, run_number: 10, status: "in_progress" },
        { ...full, run_number: 9, head_sha: later, event },
      ];
      assert.equal(preflight(options, f.run).sha, f.source.sha);
    }
    // A descendant off main is not a full qualification of first-parent main.
    f.git("switch", "-c", "side");
    writeFileSync(path.join(f.root, "change"), "side");
    f.git("commit", "-am", "side");
    f.state.fullRuns = [{ ...full, head_sha: f.git("rev-parse", "HEAD") }];
    assert.throws(() => preflight(options, f.run), message);
  } finally {
    f.close();
  }
});
test("insiders never query full CI, even when the newest full run failed or is absent", () => {
  const f = fixture();
  try {
    f.state.fullRuns[0].conclusion = "failure";
    assert.deepEqual(preflight({ root: f.root, event: "push" }, f.run), f.source);
    f.state.fullRuns = [];
    assert.deepEqual(preflight({ root: f.root, channel: "insider" }, f.run), f.source);
    assert.equal(f.state.fullQueries, 0);
  } finally {
    f.close();
  }
});
test("stable cannot bypass full CI after waiting for its exact-SHA push Check", async () => {
  const f = fixture();
  try {
    f.state.releases = [published(f.source)];
    f.state.runs[0].status = "in_progress";
    f.state.fullRuns = [];
    let clock = 0;
    await assert.rejects(
      qualifiedPreflight({ root: f.root, channel: "stable", insiderTag: f.source.tag }, f.run, {
        now: () => clock,
        timeoutMs: 30,
        sleep: async (milliseconds) => {
          clock += milliseconds;
          f.state.runs[0].status = "completed";
        },
      }),
      /stable needs a green full CI run/,
    );
  } finally {
    f.close();
  }
});
test("stable refreshes main for a full run completed after its initial fetch without moving the release source", async () => {
  const f = fixture();
  const upstream = mkdtempSync(path.join(tmpdir(), "release-main-upstream-"));
  try {
    f.git("clone", "--no-hardlinks", f.root, upstream);
    const upstreamGit = (...args) => f.git("-C", upstream, ...args);
    upstreamGit("config", "user.name", "Release Test");
    upstreamGit("config", "user.email", "release@opensteer.invalid");
    upstreamGit("config", "commit.gpgsign", "false");
    f.git("remote", "add", "origin", upstream);
    f.state.releases = [published(f.source)];
    f.state.runs[0].status = "in_progress";
    let clock = 0;
    let fetches = 0;
    let later;
    const run = (exe, args) => {
      if (exe === "git" && args[0] === "fetch") {
        fetches++;
        return f.git(...args);
      }
      return f.run(exe, args);
    };
    const result = await qualifiedPreflight(
      { root: f.root, channel: "stable", insiderTag: f.source.tag },
      run,
      {
        now: () => clock,
        timeoutMs: 30,
        sleep: async (milliseconds) => {
          clock += milliseconds;
          writeFileSync(path.join(upstream, "change"), "new main during push CI");
          upstreamGit("commit", "-am", "new main during push CI");
          later = upstreamGit("rev-parse", "HEAD");
          assert.throws(() => f.git("cat-file", "-e", `${later}^{commit}`));
          f.state.runs[0].status = "completed";
          f.state.fullRuns[0].head_sha = later;
          assert.equal(f.git("rev-parse", "refs/remotes/origin/main"), f.source.sha);
        },
      },
    );
    assert.deepEqual(result, { ...f.source, channel: "stable", tag: "desktop-v1.2.4" });
    assert.equal(fetches, 2);
    assert.equal(f.git("rev-parse", "refs/remotes/origin/main"), later);
    assert.notEqual(result.sha, later);
  } finally {
    rmSync(upstream, { recursive: true, force: true });
    f.close();
  }
});
test("stable fails closed when refreshing main history fails", () => {
  const f = fixture();
  try {
    f.state.releases = [published(f.source)];
    let fetches = 0;
    const run = (exe, args) => {
      if (exe === "git" && args[0] === "fetch" && ++fetches === 2)
        throw Error("Main history refresh failed");
      return f.run(exe, args);
    };
    assert.throws(
      () => preflight({ root: f.root, channel: "stable", insiderTag: f.source.tag }, run),
      /Main history refresh failed/,
    );
    assert.equal(fetches, 2);
  } finally {
    f.close();
  }
});
test("preflight refuses missing, failed, pending or non-main qualification of the exact SHA", () => {
  const f = fixture();
  try {
    const valid = f.state.runs[0];
    const job = f.state.jobs[0];
    for (const mutation of [
      { conclusion: "failure" },
      { status: "in_progress" },
      { head_sha: "b".repeat(40) },
      { head_branch: "other" },
      { event: "pull_request" },
    ]) {
      f.state.runs = [{ ...valid, ...mutation }];
      assert.throws(() => preflight({ root: f.root, event: "push" }, f.run));
    }
    f.state.runs = [valid, { ...valid, id: 43, run_number: 8, conclusion: "failure" }];
    assert.throws(() => preflight({ root: f.root, event: "push" }, f.run));
    f.state.runs = [];
    assert.throws(() => preflight({ root: f.root, event: "push" }, f.run));
    f.state.runs = [valid];
    for (const mutation of [
      { name: "another" },
      { status: "in_progress" },
      { conclusion: "failure" },
    ]) {
      f.state.jobs = [{ ...job, ...mutation }];
      assert.throws(() => preflight({ root: f.root, event: "push" }, f.run));
    }
    f.state.jobs = [];
    assert.throws(() => preflight({ root: f.root, event: "push" }, f.run));
    f.state.apiFailure = true;
    assert.throws(() => preflight({ root: f.root, event: "push" }, f.run));
  } finally {
    f.close();
  }
});
test("discovery skips unchanged published insiders and reuses only matching draft targets and metadata", () => {
  const f = fixture();
  try {
    assert.deepEqual(discover(f.source, f.run, f.root), { skip: false, reuse: false });
    f.state.releases = [published(f.source)];
    assert.deepEqual(discover(f.source, f.run, f.root), { skip: true, reuse: false });
    f.state.manifest.sourceSha = "b".repeat(40);
    assert.throws(() => discover(f.source, f.run, f.root));
    f.state.manifest.sourceSha = f.source.sha;
    f.state.releases = [
      { ...published(f.source), tag_name: "v1.2.5-insider", target_commitish: "b".repeat(40) },
    ];
    assert.throws(() => discover(f.source, f.run, f.root), /backfill/);
    f.state.releases = [{ ...published(f.source), draft: true }];
    assert.deepEqual(discover(f.source, f.run, f.root), { skip: false, reuse: true });
    for (const mutation of [
      { sourceSha: "b".repeat(40) },
      { version: "1.2.5" },
      { channel: "stable" },
      { tag: "v1.2.5-insider" },
    ]) {
      f.state.manifest = { sourceSha: f.source.sha, ...f.source, ...mutation };
      assert.throws(() => discover(f.source, f.run, f.root));
    }
    f.state.manifest = { sourceSha: f.source.sha, ...f.source };
    f.state.releases[0].target_commitish = "b".repeat(40);
    assert.throws(() => discover(f.source, f.run, f.root));
  } finally {
    f.close();
  }
});
test("insiders auto-publish on push, manual practice stops at draft, stable alone requests approval", () => {
  const enabled = (
    job,
    {
      channel = "beta",
      event = "workflow_dispatch",
      publish = false,
      reuse = false,
      skip = false,
    } = {},
  ) =>
    Boolean(
      runInNewContext(workflow.jobs[job].if.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), {
        needs: {
          preflight: { outputs: { channel } },
          discover: { result: "success", outputs: { reuse: String(reuse), skip: String(skip) } },
          draft: { result: reuse ? "skipped" : "success" },
        },
        github: { event_name: event },
        inputs: { publish },
        cancelled: () => false,
      }),
    );
  assert.equal(enabled("publish-insider", { event: "push" }), true);
  assert.equal(enabled("publish-insider"), false);
  assert.equal(enabled("publish-insider", { publish: true, reuse: true }), true);
  assert.equal(enabled("publish-insider", { event: "push", skip: true }), false);
  assert.equal(enabled("publish-insider", { channel: "stable", publish: true }), false);
  assert.equal(enabled("publish-stable", { channel: "stable" }), true);
  assert.equal(enabled("publish-stable"), false);
  assert.equal(workflow.jobs["publish-insider"].environment, undefined);
  assert.equal(workflow.jobs["publish-stable"].environment, "publish");
});

test("ignored paths exclude only documentation and CI, preserving all desktop/APK source inputs", () => {
  const ignored = workflow.on.push["paths-ignore"];
  const sourceFiles = execFileSync(
    "git",
    ["ls-files", "-z", "--", "apps", "packages", "scripts", "deploy", "patches"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const protectedFiles = [
    ...sourceFiles,
    "THIRD_PARTY_NOTICES.md",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    "tsconfig.base.json",
    ".github/workflows/release.yml",
    ".github/scripts/release-plan.mjs",
  ];
  for (const pattern of ignored) {
    assert.ok(!pattern.startsWith("!"), "paths-ignore cannot re-include a build input");
    for (const file of protectedFiles)
      assert.equal(path.matchesGlob(file, pattern), false, `${pattern} hides build input ${file}`);
  }
  for (const file of [
    "docs/releases.md",
    "README.md",
    "AGENTS.md",
    "CHANGELOG.md",
    ".github/ISSUE_TEMPLATE/bug.yml",
    ".github/workflows/ci.yml",
    ".github/scripts/ci-shards.json",
  ]) {
    assert.ok(
      ignored.some((pattern) => path.matchesGlob(file, pattern)),
      `should skip documentation/CI ${file}`,
    );
  }
  assert.ok(
    sourceFiles.some(
      (file) => file.startsWith("apps/runner/agent-skills/") && file.endsWith(".md"),
    ),
  );
  assert.equal(ignored.includes("**/*.md"), false);
});

test("a push waits for its original SHA's main CI without advancing to a newer main", async () => {
  const f = fixture();
  try {
    f.state.runs[0].status = "in_progress";
    let clock = 0;
    let fetches = 0;
    const run = (exe, args) => {
      if (exe === "git" && args[0] === "fetch") fetches++;
      return f.run(exe, args);
    };
    const result = await qualifiedPreflight({ root: f.root, event: "push" }, run, {
      now: () => clock,
      timeoutMs: 30,
      sleep: async (milliseconds) => {
        clock += milliseconds;
        writeFileSync(path.join(f.root, "change"), "new main");
        f.git("commit", "-am", "new main");
        f.git("update-ref", "refs/remotes/origin/main", f.git("rev-parse", "HEAD"));
        f.state.runs[0].status = "completed";
      },
    });
    assert.deepEqual(result, f.source);
    assert.equal(fetches, 1);
    assert.notEqual(f.git("rev-parse", "HEAD"), result.sha);
  } finally {
    f.close();
  }
});
test("CI wait is bounded and failed main runs or API errors fail closed", async () => {
  const f = fixture();
  try {
    let clock = 0;
    f.state.runs = [];
    await assert.rejects(
      qualifiedPreflight({ root: f.root, event: "push" }, f.run, {
        now: () => clock,
        timeoutMs: 30,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
      }),
      /wait budget/,
    );
    f.state.runs = [
      {
        id: 42,
        run_number: 7,
        head_sha: f.source.sha,
        head_branch: "main",
        event: "push",
        status: "completed",
        conclusion: "failure",
      },
    ];
    const neverSleep = async () => {
      assert.fail("failed CI must not be retried");
    };
    await assert.rejects(
      qualifiedPreflight({ root: f.root, event: "push" }, f.run, { sleep: neverSleep }),
      /must succeed/,
    );
    f.state.apiFailure = true;
    await assert.rejects(
      qualifiedPreflight({ root: f.root, event: "push" }, f.run, { sleep: neverSleep }),
      /API unavailable/,
    );
  } finally {
    f.close();
  }
});
