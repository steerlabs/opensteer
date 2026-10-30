import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { parseDocument } from "yaml";
import { preflight, discover } from "./release-plan.mjs";
const text = readFileSync(new URL("../workflows/release.yml", import.meta.url), "utf8");
const doc = parseDocument(text, { uniqueKeys: true });
const workflow = doc.toJS();
test("only daily schedule and explicit dispatch can release; no tag or PR trigger", () => {
  assert.deepEqual(doc.errors, []);
  assert.deepEqual(doc.warnings, []);
  assert.deepEqual(Object.keys(workflow.on).sort(), ["schedule", "workflow_dispatch"]);
  assert.equal(workflow.on.schedule.length, 1);
  assert.notEqual(workflow.on.schedule[0].cron.split(" ")[0], "0");
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.channel.options, ["insider", "stable"]);
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false);
  assert.ok(workflow.on.workflow_dispatch.inputs.insider_tag);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.concurrency.queue, "max");
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
    jobs: [{ name: "Check", status: "completed", conclusion: "success" }],
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
    if (url.includes("/actions/workflows/ci.yml/runs?"))
      return JSON.stringify([{ workflow_runs: state.runs }]);
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
test("schedule and manual insider resolve main and derive its numeric version", () => {
  const f = fixture();
  try {
    assert.deepEqual(preflight({ root: f.root, event: "schedule" }, f.run), f.source);
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
      assert.throws(() => preflight({ root: f.root, event: "schedule" }, f.run));
    }
    f.state.runs = [valid, { ...valid, id: 43, run_number: 8, conclusion: "failure" }];
    assert.throws(() => preflight({ root: f.root, event: "schedule" }, f.run));
    f.state.runs = [];
    assert.throws(() => preflight({ root: f.root, event: "schedule" }, f.run));
    f.state.runs = [valid];
    for (const mutation of [
      { name: "another" },
      { status: "in_progress" },
      { conclusion: "failure" },
    ]) {
      f.state.jobs = [{ ...job, ...mutation }];
      assert.throws(() => preflight({ root: f.root, event: "schedule" }, f.run));
    }
    f.state.jobs = [];
    assert.throws(() => preflight({ root: f.root, event: "schedule" }, f.run));
    f.state.apiFailure = true;
    assert.throws(() => preflight({ root: f.root, event: "schedule" }, f.run));
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
test("insiders auto-publish on schedule, manual practice stops at draft, stable alone requests approval", () => {
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
  assert.equal(enabled("publish-insider", { event: "schedule" }), true);
  assert.equal(enabled("publish-insider"), false);
  assert.equal(enabled("publish-insider", { publish: true, reuse: true }), true);
  assert.equal(enabled("publish-insider", { event: "schedule", skip: true }), false);
  assert.equal(enabled("publish-insider", { channel: "stable", publish: true }), false);
  assert.equal(enabled("publish-stable", { channel: "stable" }), true);
  assert.equal(enabled("publish-stable"), false);
  assert.equal(workflow.jobs["publish-insider"].environment, undefined);
  assert.equal(workflow.jobs["publish-stable"].environment, "publish");
});
