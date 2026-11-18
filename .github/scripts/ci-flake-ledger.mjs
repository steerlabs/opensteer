/**
 * The flake ledger: every test that failed on main's CI without a code cause.
 *   node .github/scripts/ci-flake-ledger.mjs [--runs 100] [--days 14] [--json]
 *
 * Read-only: it lists main's CI runs and their jobs in every attempt, reads the log of each
 * failed job (the same Vitest, Go and Swift reporter output for every lane) and each run's
 * plan artifact, and asks ci-changes.mjs which tests a diff can reach. It needs `gh` with
 * actions:read and main's first-parent history.
 *
 * A failure is a flake when the same test passed on code it cannot tell apart:
 * - rerun: a later attempt of the same job, on the same commit, passed;
 * - same commit: another main run of that commit ran the test and passed it;
 * - unreachable diff: the nearest main run before or after that ran and passed the test is on
 *   a commit whose diff from the failing one cannot reach it, as CI selects tests.
 * Anything else is listed as unproven: it may be a regression, or a flake without evidence.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";
import { inflateRawSync } from "node:zlib";
import { decide, parseDiff, readGraph } from "./ci-changes.mjs";
import { assignShards, integrationContention, unknownDuration } from "./ci-sharding.mjs";

const repo = "steerlabs/opensteer";
const run = promisify(execFile);

/** Job name to its lane; native-mac keeps its task, which is a separate job and selection. */
export function laneOf(job) {
  const [, lane, inner] = /^(.*?)(?: \((.*)\))?$/u.exec(job);
  return lane === "native-mac" ? { lane: job, base: lane, task: inner } : { lane, base: lane };
}

/** The failing tests a job's log names, with each test's file and title path. */
export function parseFailures(log) {
  const failures = new Map();
  const add = (kind, file, name) =>
    failures.set(JSON.stringify([file, name]), { kind, file, name });
  let go = [];
  for (const raw of log.split(/\r?\n/u)) {
    // GitHub prefixes every line with a timestamp; reporters color theirs.
    const line = stripVTControlCharacters(raw).replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /u, "");
    const vitest =
      /^\s*FAIL\s+(?:\|[^|]+\|\s+)?(\S+?\.[cm]?[jt]sx?)(?:\s+\[[^\]]*\])?(?:\s+>\s+(.+?))?\s*$/u.exec(
        line,
      );
    if (vitest) {
      add("vitest", vitest[1], vitest[2] ? vitest[2].split(" > ") : []);
      continue;
    }
    const goTest = /^\s*--- FAIL: ([^\s/]+) \(/u.exec(line);
    if (goTest) go.push(goTest[1]);
    const goPackage = /^FAIL\s+(\S+)\s+[\d.]+s$/u.exec(line);
    if (goPackage) {
      for (const name of go) add("go", goPackage[1], [name]);
      go = [];
    }
    const xctest = /Test Case '-\[(\S+) (\S+)\]' failed/u.exec(line);
    if (xctest) add("swift", xctest[1], [xctest[2]]);
    const swiftTesting = /✘ Test (.+?) (?:failed|recorded an issue)/u.exec(line);
    if (swiftTesting) add("swift", "swift", [swiftTesting[1].replace(/^"(.*)"$/u, "$1")]);
  }
  return [...failures.values()];
}

/** One file from a zip archive, as GitHub returns an artifact. */
export function unzipEntry(zip, name) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw Error("Not a zip archive");
  let offset = zip.readUInt32LE(end + 16);
  for (let index = zip.readUInt16LE(end + 10); index > 0; index--) {
    const length = zip.readUInt16LE(offset + 28);
    if (zip.toString("utf8", offset + 46, offset + 46 + length) === name) {
      const local = zip.readUInt32LE(offset + 42);
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + zip.readUInt32LE(offset + 20));
      return zip.readUInt16LE(offset + 10) === 0 ? data : inflateRawSync(data);
    }
    offset += 46 + length + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  return undefined;
}

/** Unit and integration lanes run the test files their plan selects; other lanes run all. */
const byFile = (test) =>
  ["tests", "integration"].includes(laneOf(test.job).base) && test.kind === "vitest";
/** Whether a plan (ci-changes.mjs) runs a test. */
export function selects(plan, test) {
  const { base, task } = laneOf(test.job);
  if (byFile(test))
    return plan.whole?.[base] === true || (plan.files?.[base] ?? []).includes(test.file);
  if (base === "native-mac") return (plan.nativeMac ?? []).includes(task);
  return plan.lanes?.[base] === true;
}

/**
 * Classifies every failed test. `runs` carry their plan and their jobs from every attempt,
 * each failed job with the tests its log names; `position` orders commits on first-parent
 * main, newest first; `reaches(from, to, test)` says whether that diff can reach the test;
 * `shardOf(run, test)` names the job that ran a test file, when it can be known.
 */
export function classify(runs, position, reaches, shardOf = () => undefined) {
  const latest = (item) => {
    const jobs = new Map();
    for (const job of item.jobs)
      if (!(jobs.get(job.name)?.attempt > job.attempt)) jobs.set(job.name, job);
    return [...jobs.values()];
  };
  // The job that ran the test passed, or every job of its lane when its shard is unknown.
  const passingJobs = (item, test) => {
    const { lane } = laneOf(test.job);
    const shard = shardOf(item, test);
    const jobs = latest(item).filter((job) =>
      shard ? job.name === shard : laneOf(job.name).lane === lane,
    );
    return jobs.length > 0 &&
      jobs.every((job) => job.conclusion === "success") &&
      // Without its plan, only a scheduled or manual run is known to run every file.
      (!byFile(test) || (item.plan ? selects(item.plan, test) : item.event !== "push"))
      ? jobs
      : undefined;
  };
  const passed = (item, test) => passingJobs(item, test) !== undefined;
  // What a maintainer needs to check the claim: the passing job and the commits compared.
  const proof = (kind, sha, jobs, compared) => ({
    kind,
    passing: { sha, url: jobs[0].url },
    ...(compared ? { compared } : {}),
  });
  const evidenceFor = (item, job, test) => {
    const rerun = item.jobs.find(
      (other) =>
        other.name === job.name && other.attempt > job.attempt && other.conclusion === "success",
    );
    if (rerun) return proof("rerun", item.sha, [rerun]);
    const twin = runs.find(
      (other) => other !== item && other.sha === item.sha && passed(other, test),
    );
    if (twin) return proof("same commit", twin.sha, passingJobs(twin, test));
    const at = position.get(item.sha);
    if (at === undefined) return undefined;
    const nearest = (older) =>
      runs
        .filter((other) => {
          const there = position.get(other.sha);
          return there !== undefined && (older ? there > at : there < at);
        })
        .sort(
          (a, b) =>
            Math.abs(position.get(a.sha) - at) - Math.abs(position.get(b.sha) - at) ||
            b.createdAt.localeCompare(a.createdAt),
        )
        .find((other) => passed(other, test));
    const before = nearest(true);
    const after = nearest(false);
    if (before && !reaches(before.sha, item.sha, test))
      return proof("unreachable diff", before.sha, passingJobs(before, test), {
        from: before.sha,
        to: item.sha,
      });
    if (after && !reaches(item.sha, after.sha, test))
      return proof("unreachable diff", after.sha, passingJobs(after, test), {
        from: item.sha,
        to: after.sha,
      });
    return undefined;
  };
  const entries = new Map();
  for (const item of runs) {
    for (const job of item.jobs) {
      if (job.conclusion !== "failure" || job.name === "Check") continue;
      // A failed job whose log names no test is listed by its failed step.
      const tests = job.failures?.length
        ? job.failures
        : [{ kind: "job", file: null, name: [job.step ?? "(job)"] }];
      for (const failure of tests) {
        const test = { ...failure, job: job.name };
        const evidence = evidenceFor(item, job, test);
        const { lane } = laneOf(job.name);
        const key = JSON.stringify([lane, test.file, test.name]);
        const entry = entries.get(key) ?? {
          lane,
          kind: test.kind,
          file: test.file,
          name: test.name,
          firstSeen: item.createdAt,
          failures: 0,
          flakes: 0,
          evidence: [],
          occurrences: [],
        };
        entry.failures++;
        if (evidence) entry.flakes++;
        if (item.createdAt < entry.firstSeen) entry.firstSeen = item.createdAt;
        if (evidence && !entry.evidence.includes(evidence.kind)) entry.evidence.push(evidence.kind);
        entry.occurrences.push({
          sha: item.sha,
          createdAt: item.createdAt,
          url: job.url,
          evidence: evidence?.kind,
          ...(evidence ? { proof: evidence } : {}),
        });
        entries.set(key, entry);
      }
    }
  }
  const sorted = [...entries.values()].map((entry) => {
    entry.occurrences.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { ...entry, lastFailure: entry.occurrences[0].url };
  });
  sorted.sort(
    (a, b) =>
      a.lane.localeCompare(b.lane) ||
      b.flakes - a.flakes ||
      b.failures - a.failures ||
      a.firstSeen.localeCompare(b.firstSeen),
  );
  return {
    flakes: sorted.filter((entry) => entry.flakes > 0),
    unproven: sorted.filter((entry) => entry.flakes === 0),
  };
}

/** Which tests a diff between two commits can reach, as CI selects them (ci-changes.mjs). */
export function reachability(root, git) {
  const graph = readGraph(root);
  const tracked = parseDiff(git("ls-files", "-z"));
  // Each side of a diff reads its own commit, so a lockfile or manifest edit is compared, not
  // matched against itself. A file a commit lacks reads as undefined, as decide() expects.
  const at = (ref) => {
    const seen = new Map();
    return (file) => {
      if (!seen.has(file))
        try {
          seen.set(file, git("show", `${ref}:${file}`));
        } catch {
          seen.set(file, undefined);
        }
      return seen.get(file);
    };
  };
  const plans = new Map();
  return (from, to, test) => {
    // Today's import graph stands in for theirs; a test it no longer has is assumed reachable.
    if (test.kind === "vitest" && !existsSync(resolve(root, test.file))) return true;
    const key = `${from}..${to}`;
    if (!plans.has(key)) {
      const changed = parseDiff(git("diff", "--name-only", "-z", "--no-renames", from, to));
      // A quarantine edit makes a skipped test look green.
      plans.set(
        key,
        changed.includes("tests/quarantine.json")
          ? undefined
          : decide(changed, graph, graph, {
              event: "push",
              repo: { tracked, read: at(to), readBase: at(from) },
            }),
      );
    }
    const plan = plans.get(key);
    return plan === undefined || selects(plan, test);
  };
}

/**
 * The shard job that ran a unit or integration test file, recomputed as ci-sequencer.ts
 * assigns it, for runs whose commit shards with today's code; otherwise unknown.
 */
export function sharding(git) {
  const code = (ref) =>
    ["scripts/ci-sequencer.ts", ".github/scripts/ci-sharding.mjs"]
      .map((file) => git("rev-parse", `${ref}:${file}`).trim())
      .join();
  const current = code("HEAD");
  const assigned = new Map();
  return (item, test) => {
    const { base } = laneOf(test.job);
    if (!byFile(test) || !item.plan?.files?.[base] || !item.plan.shards?.[base]) return undefined;
    const key = `${item.id} ${base}`;
    if (!assigned.has(key)) {
      let shards;
      try {
        if (code(item.sha) === current)
          shards = assignShards(
            item.plan.files[base],
            JSON.parse(git("show", `${item.sha}:.github/scripts/ci-durations.json`))[base],
            item.plan.shards[base],
            unknownDuration[base],
            base === "integration" ? integrationContention : undefined,
          );
      } catch {
        shards = undefined;
      }
      assigned.set(key, shards);
    }
    const index = assigned.get(key)?.findIndex((files) => files.includes(test.file)) ?? -1;
    return index < 0 ? undefined : `${base} (${index + 1})`;
  };
}

async function pool(items, limit, work) {
  const results = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]);
      }
    }),
  );
  return results;
}

async function api(path, { binary = false, paginate = false } = {}) {
  const args = ["api", ...(paginate ? ["--paginate", "--slurp"] : []), `repos/${repo}/${path}`];
  for (let attempt = 1; ; attempt++) {
    try {
      const { stdout } = await run("gh", args, {
        encoding: binary ? "buffer" : "utf8",
        maxBuffer: 256 * 1024 * 1024,
      });
      return binary ? stdout : JSON.parse(stdout);
    } catch (error) {
      // GitHub's API answers bursts with 5xx; anything else is a real failure.
      if (attempt >= 3 || !/HTTP 5\d\d|stream error/u.test(String(error.stderr ?? error)))
        throw error;
      await new Promise((done) => setTimeout(done, attempt * 2_000));
    }
  }
}

export async function load({ runs: limit, days }) {
  const since = days ? Date.now() - days * 24 * 60 * 60 * 1_000 : 0;
  const runs = [];
  for (let page = 1; runs.length < limit; page++) {
    const { workflow_runs: listed } = await api(
      `actions/workflows/ci.yml/runs?branch=main&status=completed&per_page=100&page=${page}`,
    );
    const kept = listed.filter(
      (item) =>
        item.head_branch === "main" &&
        ["push", "schedule", "workflow_dispatch"].includes(item.event) &&
        Date.parse(item.created_at) >= since,
    );
    runs.push(...kept);
    if (listed.length < 100 || kept.length < listed.length) break;
  }
  return await pool(runs.slice(0, limit), 8, async (item) => {
    const jobs = (
      await api(`actions/runs/${item.id}/jobs?filter=all&per_page=100`, { paginate: true })
    )
      .flatMap((page) => page.jobs)
      .map((job) => ({
        name: job.name,
        attempt: job.run_attempt,
        conclusion: job.conclusion,
        url: job.html_url,
        step: job.steps?.find((step) => step.conclusion === "failure")?.name,
        id: job.id,
      }));
    for (const job of jobs)
      if (job.conclusion === "failure" && job.name !== "Check")
        job.failures = parseFailures(
          (await api(`actions/jobs/${job.id}/logs`, { binary: true })).toString("utf8"),
        );
    const { artifacts } = await api(
      `actions/runs/${item.id}/artifacts?name=plan-${item.head_sha}&per_page=1`,
    );
    let plan;
    if (artifacts[0] && !artifacts[0].expired) {
      const zip = await api(`actions/artifacts/${artifacts[0].id}/zip`, { binary: true });
      plan = JSON.parse(unzipEntry(zip, "ci-plan.json")?.toString("utf8") ?? "null") ?? undefined;
    }
    return {
      id: item.id,
      sha: item.head_sha,
      event: item.event,
      createdAt: item.created_at,
      plan,
      jobs,
    };
  });
}

function format({ flakes, unproven }, runs) {
  const lines = [`Flake ledger: ${runs} CI runs on main`];
  const table = (title, entries) => {
    lines.push("", `## ${title} (${entries.length})`);
    let lane;
    for (const entry of entries) {
      if (entry.lane !== lane) lines.push("", `### ${(lane = entry.lane)}`);
      const name = entry.name.length ? ` > ${entry.name.join(" > ")}` : "";
      const proven = entry.flakes ? `${entry.flakes} flaky (${entry.evidence.join(", ")}) of ` : "";
      lines.push(
        `- ${entry.file ?? "(job)"}${name}`,
        `  ${proven}${entry.failures} failed; first seen ${entry.firstSeen}; last ${entry.lastFailure}`,
      );
      // The newest proof, with what a quarantine entry has to cite.
      const proof = entry.occurrences.find((occurrence) => occurrence.proof)?.proof;
      if (proof) {
        const compared = proof.compared
          ? `; compared ${proof.compared.from}..${proof.compared.to}`
          : "";
        lines.push(
          `  proof (${proof.kind}): passed at ${proof.passing.sha} ${proof.passing.url}${compared}`,
        );
      }
    }
  };
  table("Flakes", flakes);
  table("Failures without flake evidence", unproven);
  return lines.join("\n");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const option = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index < 0 ? fallback : Number(process.argv[index + 1]);
  };
  const root = process.cwd();
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const runs = await load({ runs: option("runs", 100), days: option("days", 0) });
  const position = new Map(
    git("rev-list", "--first-parent", process.env.LEDGER_REF ?? "origin/main")
      .trim()
      .split("\n")
      .map((sha, index) => [sha, index]),
  );
  const ledger = classify(runs, position, reachability(root, git), sharding(git));
  console.log(
    process.argv.includes("--json") ? JSON.stringify(ledger, null, 2) : format(ledger, runs.length),
  );
}
