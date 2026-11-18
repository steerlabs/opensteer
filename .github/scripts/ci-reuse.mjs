// A squash merge usually lands exactly the tree its pull request's last CI run tested: GitHub
// runs pull requests on a merge of the branch into main's current head. When that run was
// green and tested this commit's tree on this commit's parent, it already ran every lane whose
// result follows from the tree and its diff, so the main push does not run them again.
// Dependency-free: `changes` runs this before any install.

/**
 * Lanes a pull request selects exactly as a main push of the same diff does. Main still runs
 * lint (time-based quarantine expiry, published Stable API floor), its builds, and the native,
 * Windows and Android work it selects more widely than a pull request.
 */
export const reusableLanes = ["build-types", "tests", "integration", "browser-journeys"];
const exactSha = /^[0-9a-f]{40}$/u;
const planArtifact = /^plan-([0-9a-f]{40})$/u;

function client({ repository, token, request = fetch }) {
  return async (path) => {
    const response = await request(`https://api.github.com/repos/${repository}/${path}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
    return response.json();
  };
}

/**
 * Why run `run` cannot vouch for commit `sha`, or undefined when it can: it is this
 * repository's CI, its latest attempt passed for a pull request from this repository, and the
 * merge it tested (named by its plan artifact) has this commit's tree and first parent.
 */
async function problem({ run, merge }, { sha, repository, get }) {
  if (!Number.isSafeInteger(run) || !exactSha.test(merge ?? "")) return "malformed reuse record";
  const [commit, tested, details, { artifacts }] = await Promise.all([
    get(`git/commits/${sha}`),
    get(`git/commits/${merge}`),
    get(`actions/runs/${run}`),
    get(`actions/runs/${run}/artifacts?per_page=100`),
  ]);
  if (
    details.path !== ".github/workflows/ci.yml" ||
    details.event !== "pull_request" ||
    details.head_repository?.full_name !== repository ||
    details.status !== "completed" ||
    details.conclusion !== "success"
  )
    return `run ${run} is not a green pull request CI run from ${repository}`;
  const plans = artifacts.flatMap((artifact) => planArtifact.exec(artifact.name)?.[1] ?? []);
  if (plans.length !== 1 || plans[0] !== merge) return `run ${run} did not test ${merge}`;
  if (tested.tree?.sha !== commit.tree?.sha) return `${merge} has another tree than ${sha}`;
  if (!tested.parents?.[0]?.sha || tested.parents[0].sha !== commit.parents?.[0]?.sha)
    return `${merge} has another first parent than ${sha}`;
  return undefined;
}

/** Throws unless the recorded run still vouches for this commit (its latest attempt). */
export async function verifyReuse(reused, { sha, repository, token, request = fetch }) {
  const found = await problem(reused, {
    sha,
    repository,
    get: client({ repository, token, request }),
  });
  if (found) throw new Error(`Reused pull request result does not hold: ${found}`);
}

/** The newest green run of the pull request merged as `sha` that tested exactly its tree. */
export async function findReuse({ sha, repository, token, request = fetch }) {
  const get = client({ repository, token, request });
  const pulls = (await get(`commits/${sha}/pulls`)).filter(
    (pull) =>
      pull.merge_commit_sha === sha &&
      pull.merged_at &&
      pull.base?.ref === "main" &&
      pull.head?.repo?.full_name === repository &&
      exactSha.test(pull.head?.sha ?? ""),
  );
  for (const pull of pulls) {
    const { workflow_runs: runs } = await get(
      `actions/workflows/ci.yml/runs?event=pull_request&head_sha=${pull.head.sha}&status=success&per_page=20`,
    );
    for (const run of runs.toSorted((a, b) => b.run_number - a.run_number)) {
      const { artifacts } = await get(`actions/runs/${run.id}/artifacts?per_page=100`);
      const merge = artifacts.flatMap((artifact) => planArtifact.exec(artifact.name)?.[1] ?? []);
      if (merge.length !== 1) continue;
      const reused = { run: run.id, pullRequest: pull.number, merge: merge[0] };
      if (!(await problem(reused, { sha, repository, get }))) return reused;
    }
  }
  return undefined;
}

/** The plan with the reusable lanes it selected recorded as reused instead of run. */
export function applyReuse(plan, reused) {
  const lanes = reusableLanes.filter((lane) => plan.lanes[lane]);
  if (!lanes.length) return plan;
  return {
    ...plan,
    reasons: [
      ...plan.reasons,
      `pull request #${reused.pullRequest} run ${reused.run} passed ${lanes.join(", ")} on this tree`,
    ],
    // What the reused run covered, for the record; Check re-verifies the run itself.
    reused: { ...reused, lanes, files: plan.files, typecheck: plan.typecheck },
    files: { tests: [], integration: [] },
    whole: { tests: false, integration: false },
    shards: { tests: 0, integration: 0 },
    typecheck: [],
    lanes: { ...plan.lanes, ...Object.fromEntries(lanes.map((lane) => [lane, false])) },
  };
}
