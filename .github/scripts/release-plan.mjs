import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { deriveReleaseVersion } = createRequire(import.meta.url)(
  "../../scripts/release-version.cjs",
);
const repo = "steerlabs/opensteer";
const insiderPattern = /^v(\d+\.\d+\.\d+)-insider$/u;
const exactSha = /^[a-f0-9]{40}$/u;
function execute(executable, args, root) {
  return execFileSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 90_000,
  }).trim();
}
function client(root, run) {
  const git = (...args) => run("git", args, root).trim();
  const api = (url) =>
    JSON.parse(run("gh", ["api", "--paginate", "--slurp", `repos/${repo}/${url}`], root));
  const pages = (url, field) => api(url).flatMap((page) => (field ? page[field] : page));
  const manifest = (tag) => {
    const dir = mkdtempSync(path.join(tmpdir(), "opensteer-release-manifest-"));
    try {
      run(
        "gh",
        ["release", "download", tag, "--repo", repo, "--pattern", "release.json", "--dir", dir],
        root,
      );
      return JSON.parse(readFileSync(path.join(dir, "release.json"), "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return { git, pages, manifest };
}
function sameManifest(manifest, source) {
  if (
    !["sourceSha", "version", "channel", "tag"].every(
      (key) => manifest[key] === source[key === "sourceSha" ? "sha" : key],
    )
  )
    throw Error("Release manifest disagrees with selected source/version/channel/tag");
}
export function preflight(
  { root = process.cwd(), channel, event, insiderTag = "" },
  run = execute,
) {
  const { git, pages, manifest } = client(root, run);
  git("fetch", "origin", "main", "--tags");
  let sha;
  let version;
  if (event === "schedule" || channel === "insider") {
    channel = "beta";
    sha = git("rev-parse", "--verify", "refs/remotes/origin/main^{commit}");
    version = deriveReleaseVersion({ repositoryRoot: root, revision: sha });
  } else if (channel === "stable" && insiderPattern.test(insiderTag)) {
    const releases = pages("releases");
    const release = releases.find((item) => item.tag_name === insiderTag);
    if (!release || release.draft !== false || release.prerelease !== true)
      throw Error("Stable requires a published insider prerelease");
    sha = git("rev-parse", "--verify", `refs/tags/${insiderTag}^{commit}`);
    version = deriveReleaseVersion({ repositoryRoot: root, revision: sha });
    if (insiderPattern.exec(insiderTag)[1] !== version || release.target_commitish !== sha)
      throw Error("Insider tag/source/version disagree");
    sameManifest(manifest(insiderTag), { sha, version, channel: "beta", tag: insiderTag });
  } else throw Error("Choose insider, or stable with a published insider_tag");
  if (!exactSha.test(sha)) throw Error("Expected an exact source SHA");
  git("merge-base", "--is-ancestor", sha, "refs/remotes/origin/main");
  // A PR run is not main qualification, and an older success cannot hide a newer failure.
  const runs = pages(
    `actions/workflows/ci.yml/runs?head_sha=${sha}&branch=main&event=push&per_page=100`,
    "workflow_runs",
  )
    .filter((item) => item.head_sha === sha && item.head_branch === "main" && item.event === "push")
    .sort((a, b) => b.run_number - a.run_number);
  const latest = runs[0];
  if (
    !latest ||
    latest.status !== "completed" ||
    latest.conclusion !== "success" ||
    !Number.isSafeInteger(latest.id)
  )
    throw Error("The newest main CI run for this source must succeed");
  if (
    !pages(`actions/runs/${latest.id}/jobs?filter=latest&per_page=100`, "jobs").some(
      (job) => job.name === "Check" && job.status === "completed" && job.conclusion === "success",
    )
  )
    throw Error("Check must succeed for the exact release source");
  const tag = channel === "beta" ? `v${version}-insider` : `desktop-v${version}`;
  if (git("tag", "--list", tag) && git("rev-parse", `${tag}^{commit}`) !== sha)
    throw Error("Existing tag points to another source");
  return { sha, version, channel, tag };
}
export function discover(source, run = execute, root = process.cwd()) {
  const { pages, manifest } = client(root, run);
  const releases = pages("releases");
  if (source.channel === "beta") {
    const latest = releases
      .filter(
        (item) =>
          item.draft === false && item.prerelease === true && insiderPattern.test(item.tag_name),
      )
      .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))[0];
    if (latest?.target_commitish === source.sha) {
      if (latest.tag_name !== source.tag)
        throw Error("Published insider version disagrees with source");
      sameManifest(manifest(latest.tag_name), source);
      return { skip: true, reuse: false };
    }
    if (latest) {
      const previous = insiderPattern.exec(latest.tag_name)[1].split(".").map(Number);
      const next = source.version.split(".").map(Number);
      const difference =
        next.map((value, index) => value - previous[index]).find((value) => value !== 0) ?? 0;
      if (difference <= 0) throw Error("Never backfill an older insider release");
    }
  }
  const existing = releases.find((item) => item.tag_name === source.tag);
  if (!existing) return { skip: false, reuse: false };
  if (existing.draft !== true || existing.target_commitish !== source.sha)
    throw Error("Existing release is published or targets another source");
  sameManifest(manifest(source.tag), source);
  return { skip: false, reuse: true };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result =
      process.argv[2] === "preflight"
        ? preflight({
            channel: process.env.CHANNEL,
            event: process.env.EVENT,
            insiderTag: process.env.INSIDER_TAG,
          })
        : process.argv[2] === "discover"
          ? discover({
              sha: process.env.SHA,
              version: process.env.VERSION,
              channel: process.env.CHANNEL,
              tag: process.env.TAG,
            })
          : (() => {
              throw Error("Expected preflight or discover");
            })();
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(result)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
