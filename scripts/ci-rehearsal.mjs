#!/usr/bin/env node
// Explicitly invoked paid rehearsal only. Never runs as part of CI or check.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    snapshot: { type: "string", default: "HEAD" },
    evidence: { type: "string" },
    case: { type: "string" },
    setup: { type: "boolean" },
    collect: { type: "boolean" },
    repair: { type: "boolean" },
    variant: { type: "string" },
    "main-prs": { type: "string" },
    "allow-paid-actions": { type: "boolean" },
  },
});
if (
  !values.repo ||
  !/^[-\w]+\/[-\w]+$/.test(values.repo) ||
  !values.evidence ||
  !values["allow-paid-actions"]
)
  throw new Error(
    "Required: --repo OWNER/TEMP-NAME --evidence ABSOLUTE-DIR --allow-paid-actions; --setup or --case 1..9",
  );
const evidence = resolve(values.evidence);
mkdirSync(evidence, { recursive: true });
const run = (bin, args, cwd) =>
  execFileSync(bin, args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
const api = (route, method = "GET", body) => {
  const args = ["api", route, "--method", method, "-H", "X-GitHub-Api-Version: 2026-03-10"];
  if (body) {
    const file = join(evidence, "request.json");
    writeFileSync(file, JSON.stringify(body));
    args.push("--input", file);
  }
  const result = run("gh", args);
  return result ? JSON.parse(result) : null;
};
const repo = values.repo;
if (values.setup) {
  const work = mkdtempSync(join(tmpdir(), "opensteer-ci-rehearsal-"));
  const tar = join(work, "snapshot.tar");
  run("git", ["archive", "--format=tar", `--output=${tar}`, values.snapshot]);
  const source = join(work, "source");
  mkdirSync(source);
  run("tar", ["-xf", tar, "-C", source]);
  run("gh", ["repo", "create", repo, "--private"]);
  api(`repos/${repo}/actions/permissions`, "PUT", { enabled: false });
  run("git", ["init", "-b", "main"], source);
  run("git", ["add", "-A"], source);
  run(
    "git",
    [
      "-c",
      "user.name=CI rehearsal",
      "-c",
      "user.email=ci@example.invalid",
      "commit",
      "-m",
      "Rehearsal snapshot",
    ],
    source,
  );
  run("git", ["remote", "add", "origin", `https://github.com/${repo}.git`], source);
  run("git", ["push", "origin", "main"], source);
  api(`repos/${repo}`, "PATCH", {
    allow_forking: true,
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    delete_branch_on_merge: true,
  });
  api(`repos/${repo}/actions/permissions/workflow`, "PUT", {
    default_workflow_permissions: "read",
    can_approve_pull_request_reviews: false,
  });
  api(`repos/${repo}/actions/permissions/fork-pr-contributor-approval`, "PUT", {
    approval_policy: "all_external_contributors",
  });
  api(`repos/${repo}/actions/permissions/fork-pr-workflows-private-repos`, "PUT", {
    run_workflows_from_fork_pull_requests: true,
    send_write_tokens_to_workflows: false,
    send_secrets_and_variables: false,
    require_approval_for_fork_pr_workflows: true,
  });
  api(`repos/${repo}/actions/permissions`, "PUT", { enabled: true, allowed_actions: "selected" });
  api(`repos/${repo}/actions/permissions/selected-actions`, "PUT", {
    github_owned_allowed: false,
    verified_allowed: false,
    patterns_allowed: [
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      "actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e",
      "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
      "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
      "actions/setup-java@dd06d9cba3e5552c54d9f8ea23572deb30010f7c",
      "android-actions/setup-android@9fc6c4e9069bf8d3d10b2204b1fb8f6ef7065407",
    ],
  });
  const rules = api(`repos/${repo}/rulesets`, "POST", {
    name: "main",
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "required_linear_history" },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
          allowed_merge_methods: ["squash"],
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: false,
          do_not_enforce_on_create: false,
          required_status_checks: [{ context: "Check" }],
        },
      },
    ],
  });
  writeFileSync(
    join(evidence, "setup.json"),
    JSON.stringify(
      {
        repo,
        source,
        ruleset: rules.id,
        snapshot: run("git", ["rev-parse", "HEAD"], source).trim(),
      },
      null,
      2,
    ),
  );
  // Availability differs for private plans: failures are blockers, never silently ignored.
  api(`repos/${repo}`, "PATCH", {
    security_and_analysis: {
      secret_scanning: { status: "enabled" },
      secret_scanning_push_protection: { status: "enabled" },
    },
  });
  api(`repos/${repo}/vulnerability-alerts`, "PUT");
  run("gh", ["workflow", "run", "ci.yml", "--repo", repo, "--ref", "main"]);
  console.log(`Prepared ${source}; settings/evidence: ${evidence}. Continue with rehearsal.md.`);
} else {
  const id = Number(values.case);
  if (!Number.isInteger(id) || id < 1 || id > 9) throw new Error("--case must be 1..9");
  const setup = JSON.parse(readFileSync(join(evidence, "setup.json"), "utf8"));
  const source = setup.source;
  const mutate = (file, change) => {
    const path = join(source, file);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, change(readFileSync(path, "utf8")));
  };
  const write = (file, text) => {
    const path = join(source, file);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, text);
  };
  const variant = values.variant ?? "default";
  if (!/^[a-z-]+$/.test(variant)) throw new Error("Invalid variant");
  if (values.repair) {
    if (id !== 3) throw new Error("--repair applies to case 3");
    const launch = JSON.parse(
      readFileSync(join(evidence, `case-3-${variant}-launch.json`), "utf8"),
    );
    run("git", ["switch", launch.branch], source);
    if (variant === "forced-skip")
      mutate(".github/workflows/ci.yml", (text) =>
        text.replace("false && needs.changes.outputs.tests", "needs.changes.outputs.tests"),
      );
    else run("git", ["rm", "tests/ci-rehearsal.test.ts"], source);
    run("git", ["add", "-A"], source);
    run(
      "git",
      [
        "-c",
        "user.name=CI rehearsal",
        "-c",
        "user.email=ci@example.invalid",
        "commit",
        "-m",
        "test: restore rehearsal failure",
      ],
      source,
    );
    run("git", ["push"], source);
    process.exit(0);
  }
  if (!values.collect) {
    if (id === 8)
      throw new Error(
        "Case 8 requires a second account's real fork; follow rehearsal.md, then --collect",
      );
    if (id === 9)
      throw new Error(
        "Case 9 measures completed warm/cold runs; follow rehearsal.md, then --collect",
      );
    if (id === 4 && values["main-prs"]) {
      for (const number of values["main-prs"].split(",")) {
        if (!/^\d+$/.test(number)) throw new Error("Invalid PR number");
        run("gh", ["pr", "merge", number, "--repo", repo, "--squash", "--delete-branch"]);
      }
      console.log("Two main merges requested; collect both uncancelled push runs.");
      process.exit(0);
    }
    const branch = `rehearsal/case-${id}-${variant}-${Date.now()}`;
    run("git", ["fetch", "origin"], source);
    run("git", ["switch", "-c", branch, "origin/main"], source);
    if (id === 1 || id === 4) {
      if (variant === "skill")
        write("apps/runner/agent-skills/skills/rehearsal.md", "# Rehearsal skill fixture\n");
      else write(`docs/rehearsal-${Date.now()}.md`, "# Rehearsal documentation\n");
    }
    if (id === 2) mutate("apps/host/src/main.ts", (text) => text + "\n// Rehearsal host change.\n");
    if (id === 3) {
      if (variant === "forced-skip")
        mutate(".github/workflows/ci.yml", (text) =>
          text.replace(
            "needs.changes.outputs.tests != 'false'",
            "false && needs.changes.outputs.tests != 'false'",
          ),
        );
      else
        write(
          "tests/ci-rehearsal.test.ts",
          'import { it, expect } from "vitest";\nit("rehearsal deliberate failure", () => expect(true).toBe(false));\n',
        );
    }
    if (id === 5) {
      if (variant === "malformed") mutate("apps/host/package.json", () => "{");
      else if (variant === "missing-base")
        mutate(".github/scripts/ci-changes.mjs", (text) =>
          text.replace('base = "HEAD^1"', 'base = "missing-rehearsal-base"'),
        );
      else if (variant === "exception")
        mutate(".github/actions/ci-changes/action.yml", (text) =>
          text.replace("run: node .github/scripts/ci-changes.mjs", "run: exit 1"),
        );
      else if (variant === "rename")
        run("git", ["mv", "apps/host/src/main.ts", "apps/runner/src/rehearsal-renamed.ts"], source);
      else if (variant === "deleted-owner")
        run("git", ["rm", "-r", "packages/browser-profile"], source);
      else write("unknown-rehearsal-input.txt", "unknown input\n");
    }
    if (id === 6) {
      if (variant === "missing-inventory")
        mutate("scripts/ci-inventory-reporter.ts", (text) =>
          text.replace(
            "const path = process.env.CI_INVENTORY_PATH;",
            'const path = process.env.CI_INVENTORY_PATH + ".missing";',
          ),
        );
      else if (variant === "corrupt-inventory")
        mutate("scripts/ci-inventory-reporter.ts", (text) =>
          text.replace("version: 1,", "version: 999,"),
        );
      else if (variant === "missing")
        mutate("packages/database/src/lock-order-global-setup.test-support.ts", (text) =>
          text.replace(
            'writeFileSync(trace + ".graph.json",',
            'writeFileSync(trace + ".missing-graph.json",',
          ),
        );
      else if (variant === "corrupt")
        mutate("packages/database/src/lock-order-global-setup.test-support.ts", (text) =>
          text.replace("JSON.stringify(summary, null, 2)", "JSON.stringify({corrupt:true})"),
        );
      else
        mutate("packages/database/src/lock-order-global-setup.test-support.ts", (text) =>
          text.replace(
            "const cycles = findConflictingApplicationLockCycles",
            `if (process.env.CI_SHARD === "1" || process.env.CI_SHARD === "2") {
      const from = process.env.CI_SHARD === "1" ? "ci-a" : "ci-b";
      edges.set("rehearsal", {type:"edge",database:"rehearsal",from,to:from==="ci-a"?"ci-b":"ci-a",heldMode:"UPDATE",requestedMode:"UPDATE",heldKey:"1",requestedKey:"2",statement:"rehearsal",previous:"rehearsal",stack:"rehearsal",previousStack:"rehearsal"});
    }
    const cycles = findConflictingApplicationLockCycles`,
          ),
        );
    }
    if (id === 7) {
      if (variant === "android")
        mutate("apps/agent-phone/app/src/main/AndroidManifest.xml", (text) =>
          text.replace("</manifest>", "<!-- Rehearsal Android source. -->\n</manifest>"),
        );
      else if (variant === "shared")
        mutate(
          "packages/protocol/src/index.ts",
          (text) => text + "\n// Rehearsal shared protocol change.\n",
        );
      else
        mutate(
          "apps/desktop/native/computer-use/Package.swift",
          (text) => text + "\n// Rehearsal native source.\n",
        );
    }
    run("git", ["add", "-A"], source);
    run(
      "git",
      [
        "-c",
        "user.name=CI rehearsal",
        "-c",
        "user.email=ci@example.invalid",
        "commit",
        "-m",
        `test: rehearsal case ${id} ${variant}`,
      ],
      source,
    );
    run("git", ["push", "-u", "origin", branch], source);
    const body = join(evidence, "pr-body.md");
    writeFileSync(
      body,
      `Paid isolated CI rehearsal case ${id}, variant ${variant}. Expected result: see rehearsal.md. Never merge deliberately broken variants.\n`,
    );
    const url = run(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        repo,
        "--base",
        "main",
        "--head",
        branch,
        "--title",
        `test: rehearsal ${id} ${variant}`,
        "--body-file",
        body,
      ],
      source,
    ).trim();
    writeFileSync(
      join(evidence, `case-${id}-${variant}-launch.json`),
      JSON.stringify(
        { branch, url, sha: run("git", ["rev-parse", "HEAD"], source).trim() },
        null,
        2,
      ),
    );
    console.log(url);
    process.exit(0);
  }
  const records = api(`repos/${repo}/actions/workflows/ci.yml/runs?per_page=100`);
  const path = join(evidence, `case-${id}`);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "runs.json"), JSON.stringify(records, null, 2));
  for (const r of records.workflow_runs) {
    const dir = join(path, String(r.id));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "jobs.json"),
      JSON.stringify(api(`repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`), null, 2),
    );
    if (r.status === "completed")
      run("gh", ["run", "download", String(r.id), "--repo", repo, "--dir", join(dir, "artifacts")]);
  }
  const timings = records.workflow_runs.map((r) => {
    const jobs = JSON.parse(readFileSync(join(path, String(r.id), "jobs.json"), "utf8")).jobs;
    const seconds = (a, b) => (a && b ? (Date.parse(b) - Date.parse(a)) / 1000 : null);
    return {
      url: r.html_url,
      sha: r.head_sha,
      event: r.event,
      status: r.status,
      conclusion: r.conclusion,
      queueSeconds: seconds(r.created_at, r.run_started_at),
      wallSeconds: seconds(r.run_started_at, r.updated_at),
      jobMinutes: jobs.reduce(
        (sum, j) => sum + (seconds(j.started_at, j.completed_at) ?? 0) / 60,
        0,
      ),
      expandedJobs: jobs.length,
      jobs: jobs.map((j) => ({
        name: j.name,
        conclusion: j.conclusion,
        seconds: seconds(j.started_at, j.completed_at),
        queueSeconds: seconds(j.created_at, j.started_at),
      })),
    };
  });
  writeFileSync(join(path, "timings.json"), JSON.stringify(timings, null, 2));
  writeFileSync(
    join(path, "record-template.json"),
    JSON.stringify(
      {
        case: id,
        repo,
        source: setup.source,
        runUrls: records.workflow_runs.map((r) => r.html_url),
        expected: "Fill from rehearsal.md; never infer a pass from an exit alone",
        actual: null,
        verdict: "PENDING",
        queueSeconds: null,
        wallSeconds: null,
        jobMinutes: null,
        notes: [],
      },
      null,
      2,
    ),
  );
  console.log(
    `Case ${id} evidence collected at ${path}; execute and verify its steps in rehearsal.md.`,
  );
}
