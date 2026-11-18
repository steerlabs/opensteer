import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { lanes, nativeMacMatrix } from "./ci-changes.mjs";
import { validateResults } from "./ci-check.mjs";
import { applyReuse, findReuse, reusableLanes, verifyReuse } from "./ci-reuse.mjs";

const repository = "steerlabs/opensteer";
const sha = "1".repeat(40);
const parent = "2".repeat(40);
const head = "3".repeat(40);
const merge = "4".repeat(40);
const tree = "5".repeat(40);
/** GitHub as ci-reuse asks it, for one squash-merged pull request and its CI runs. */
function github() {
  const state = {
    pulls: [
      {
        number: 683,
        merge_commit_sha: sha,
        merged_at: "2026-11-18T18:18:15Z",
        base: { ref: "main" },
        head: { sha: head, repo: { full_name: repository } },
      },
    ],
    runs: {
      7: {
        id: 7,
        run_number: 70,
        path: ".github/workflows/ci.yml",
        event: "pull_request",
        status: "completed",
        conclusion: "success",
        head_sha: head,
        head_repository: { full_name: repository },
        artifacts: [`lint-${merge}`, `plan-${merge}`, `tests-1-${merge}`],
      },
    },
    commits: {
      [sha]: { tree: { sha: tree }, parents: [{ sha: parent }] },
      [merge]: { tree: { sha: tree }, parents: [{ sha: parent }, { sha: head }] },
    },
    requests: [],
    fail: undefined,
  };
  const request = async (url, { headers }) => {
    assert.equal(headers.authorization, "Bearer token");
    const path = url.replace(`https://api.github.com/repos/${repository}/`, "");
    state.requests.push(path);
    if (state.fail && path.startsWith(state.fail)) return { ok: false, status: 502 };
    const reply = (body) => ({ ok: true, json: async () => structuredClone(body) });
    if (path === `commits/${sha}/pulls`) return reply(state.pulls);
    const runs = /^actions\/workflows\/ci\.yml\/runs\?(.*)$/u.exec(path);
    if (runs) {
      const query = new URLSearchParams(runs[1]);
      assert.equal(query.get("event"), "pull_request");
      assert.equal(query.get("status"), "success");
      return reply({
        workflow_runs: Object.values(state.runs).filter(
          (run) => run.head_sha === query.get("head_sha") && run.conclusion === "success",
        ),
      });
    }
    const artifacts = /^actions\/runs\/(\d+)\/artifacts\?per_page=100$/u.exec(path);
    if (artifacts)
      return reply({
        artifacts: state.runs[artifacts[1]].artifacts.map((name) => ({ name, expired: true })),
      });
    const run = /^actions\/runs\/(\d+)$/u.exec(path);
    if (run) return reply(state.runs[run[1]]);
    const commit = /^git\/commits\/([0-9a-f]{40})$/u.exec(path);
    if (commit && state.commits[commit[1]]) return reply(state.commits[commit[1]]);
    return { ok: false, status: 404 };
  };
  return { state, options: { sha, repository, token: "token", request } };
}

test("a main push finds the green pull request run that tested its exact tree and parent", async () => {
  const { state, options } = github();
  const found = { run: 7, pullRequest: 683, merge };
  assert.deepEqual(await findReuse(options), found);
  await verifyReuse(found, options);
  // A newer run of the same head that tested an older main is passed over for the matching one.
  state.runs[9] = {
    ...state.runs[7],
    id: 9,
    run_number: 90,
    artifacts: [`plan-${"6".repeat(40)}`],
  };
  state.commits["6".repeat(40)] = {
    tree: { sha: "7".repeat(40) },
    parents: [{ sha: "8".repeat(40) }],
  };
  assert.deepEqual(await findReuse(options), found);
  // Main moved on after the pull request's last run, so the merged tree was never tested.
  state.commits[merge] = { tree: { sha: "9".repeat(40) }, parents: [{ sha: "8".repeat(40) }] };
  assert.equal(await findReuse(options), undefined);
});

test("only a merged same-repository pull request into main, with one tested merge, is considered", async () => {
  for (const mutation of [
    { merge_commit_sha: parent },
    { merged_at: null },
    { base: { ref: "release" } },
    { head: { sha: head, repo: { full_name: "someone/fork" } } },
    { head: { sha: "x", repo: { full_name: repository } } },
  ]) {
    const { state, options } = github();
    state.pulls = [{ ...state.pulls[0], ...mutation }];
    assert.equal(await findReuse(options), undefined, JSON.stringify(mutation));
  }
  for (const artifacts of [[], [`plan-${merge}`, `plan-${"6".repeat(40)}`], [`lint-${merge}`]]) {
    const { state, options } = github();
    state.runs[7].artifacts = artifacts;
    assert.equal(await findReuse(options), undefined, JSON.stringify(artifacts));
  }
  const { state, options } = github();
  state.fail = "commits/";
  await assert.rejects(findReuse(options), /HTTP 502/);
});

test("Check refuses a reused run that is no longer green or did not test this tree", async () => {
  const found = { run: 7, pullRequest: 683, merge };
  for (const [mutate, message] of [
    // A later attempt of the pull request run failed: its latest attempt decides.
    [(state) => Object.assign(state.runs[7], { conclusion: "failure", run_attempt: 2 }), /green/],
    [(state) => Object.assign(state.runs[7], { status: "in_progress" }), /green/],
    [(state) => Object.assign(state.runs[7], { event: "push" }), /green/],
    [(state) => Object.assign(state.runs[7], { path: ".github/workflows/other.yml" }), /green/],
    [
      (state) => Object.assign(state.runs[7], { head_repository: { full_name: "someone/fork" } }),
      /green/,
    ],
    [(state) => (state.runs[7].artifacts = [`plan-${"6".repeat(40)}`]), /did not test/],
    [(state) => (state.commits[merge].tree.sha = "9".repeat(40)), /another tree/],
    [(state) => (state.commits[merge].parents[0].sha = "9".repeat(40)), /another first parent/],
    [(state) => (state.fail = "actions/runs/7"), /HTTP 502/],
  ]) {
    const { state, options } = github();
    mutate(state);
    await assert.rejects(verifyReuse(found, options), message);
  }
  const { options } = github();
  await assert.rejects(verifyReuse({ ...found, merge: "short" }, options), /malformed/);
  await assert.rejects(verifyReuse({ ...found, run: "7" }, options), /malformed/);
});

/** A main push plan that selected every lane, and the `needs` of a run that executed it. */
function mainPlan() {
  const selected = Object.fromEntries(lanes.map((lane) => [lane, true]));
  return {
    version: 2,
    full: false,
    reasons: ["changed"],
    nativeMac: ["iphone"],
    files: { tests: ["a.test.ts"], integration: ["b.integration.test.ts"] },
    whole: { tests: false, integration: false },
    shards: { tests: 1, integration: 1 },
    typecheck: ["@opensteer/host"],
    build: ["@opensteer/host"],
    lanes: selected,
  };
}
function needsFor(plan) {
  const range = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => i + 1));
  return {
    changes: {
      result: "success",
      outputs: {
        ...Object.fromEntries(lanes.map((lane) => [lane, String(plan.lanes[lane])])),
        "native-mac-tasks": JSON.stringify(nativeMacMatrix(plan.nativeMac)),
        "tests-shards": range(plan.shards.tests),
        "integration-shards": range(plan.shards.integration),
      },
    },
    ...Object.fromEntries(
      lanes.map((lane) => [lane, { result: plan.lanes[lane] ? "success" : "skipped" }]),
    ),
  };
}

test("reuse skips only the lanes a pull request selects exactly as main, and records them", () => {
  const plan = mainPlan();
  const reused = applyReuse(plan, { run: 7, pullRequest: 683, merge });
  assert.deepEqual(reusableLanes, ["build-types", "tests", "integration", "browser-journeys"]);
  assert.deepEqual(reused.reused, {
    run: 7,
    pullRequest: 683,
    merge,
    lanes: reusableLanes,
    files: plan.files,
    typecheck: plan.typecheck,
  });
  for (const lane of lanes) assert.equal(reused.lanes[lane], !reusableLanes.includes(lane), lane);
  assert.deepEqual(reused.files, { tests: [], integration: [] });
  assert.deepEqual(reused.shards, { tests: 0, integration: 0 });
  assert.deepEqual(reused.nativeMac, plan.nativeMac);
  assert.deepEqual(reused.build, plan.build);
  // A plan selecting none of them is left alone.
  const lint = {
    ...plan,
    lanes: Object.fromEntries(lanes.map((lane) => [lane, lane === "lint"])),
  };
  assert.equal(applyReuse(lint, { run: 7, pullRequest: 683, merge }), lint);
  // Check accepts the reused lanes as skipped on a main push only.
  assert.doesNotThrow(() => validateResults(reused, needsFor(reused), "push"));
  assert.throws(
    () => validateResults(reused, needsFor(reused), "pull_request"),
    /Only a main push may reuse/,
  );
  for (const event of ["schedule", "workflow_dispatch"])
    assert.throws(() => validateResults(reused, needsFor(reused), event));
  for (const forged of [
    { ...reused, reused: { ...reused.reused, lanes: ["lint"] } },
    { ...reused, reused: { ...reused.reused, lanes: ["native-mac"] } },
    { ...reused, reused: { ...reused.reused, lanes: [] } },
    { ...reused, reused: { ...reused.reused, lanes: undefined } },
    { ...reused, full: true },
    { ...reused, lanes: { ...reused.lanes, "browser-journeys": true } },
  ])
    assert.throws(
      () => validateResults(forged, needsFor(forged), "push"),
      /Only a main push may reuse/,
      JSON.stringify(forged.reused.lanes),
    );
});

test("changes can read the pull request a main push merged, and Check verifies with the run token", () => {
  const workflow = parse(readFileSync(new URL("../workflows/ci.yml", import.meta.url), "utf8"));
  assert.deepEqual(workflow.jobs.changes.permissions, {
    contents: "read",
    actions: "read",
    "pull-requests": "read",
  });
  assert.equal(workflow.jobs.Check.permissions.actions, "read");
  const step = workflow.jobs.Check.steps.find((entry) => entry.run?.includes("ci-check.ts"));
  assert.equal(step.env.GITHUB_TOKEN, "${{ github.token }}");
  assert.match(
    readFileSync(new URL("../../scripts/ci-check.ts", import.meta.url), "utf8"),
    /verifyReuse\(plan\.reused/,
  );
});
