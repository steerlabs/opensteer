const { execFileSync } = require("node:child_process");
const { lstatSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

function sourceGit(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function numericVersion(value) {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(value)
  )
    throw Error("Release base must be a numeric X.Y.Z version");
  const parts = value.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) throw Error("Release version exceeds safe integer range");
  return parts;
}
function committedManifest(root, sha) {
  return JSON.parse(sourceGit(root, "show", `${sha}:package.json`));
}
/** A base reset must exceed the preceding derived version, not merely its base. */
function deriveVersion(root, sha) {
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw Error("An exact source SHA is required");
  if (sourceGit(root, "rev-parse", "--is-shallow-repository") !== "false")
    throw Error("Release history must not be shallow");
  let base;
  let derived;
  for (const line of sourceGit(
    root,
    "rev-list",
    "--first-parent",
    "--reverse",
    "--parents",
    sha,
  ).split("\n")) {
    const [commit, ...parents] = line.split(" ");
    if (parents.length > 1) throw Error("Release history must be linear");
    const current = committedManifest(root, commit).version;
    if (current !== base) {
      const next = numericVersion(current);
      if (derived) {
        const difference =
          next.map((value, index) => value - derived[index]).find((value) => value !== 0) ?? 0;
        if (difference <= 0) throw Error("Release base must exceed the previous derived version");
      }
      base = current;
      derived = next;
    } else {
      derived[2]++;
      if (!Number.isSafeInteger(derived[2]))
        throw Error("Release version exceeds safe integer range");
    }
  }
  if (!derived) throw Error("Missing release history");
  return derived.join(".");
}
function stampedManifest(root, sha) {
  const base = committedManifest(root, sha);
  return JSON.stringify({ ...base, version: deriveVersion(root, sha) }, null, 2) + "\n";
}
/** Preserve clean-source verification, with one byte-exact generated manifest exception. */
function verifyReleaseWorkspace(root, sha) {
  const head = sourceGit(root, "rev-parse", "--verify", "HEAD^{commit}");
  if (head !== sha) throw Error(`Source ${sha} does not match checkout HEAD ${head}`);
  const status = sourceGit(root, "status", "--porcelain=v1", "--untracked-files=all");
  if (!status) return;
  const manifest = path.join(root, "package.json");
  if (
    status !== "M package.json" ||
    sourceGit(root, "diff", "--summary") ||
    !lstatSync(manifest).isFile() ||
    lstatSync(manifest).isSymbolicLink() ||
    readFileSync(manifest, "utf8") !== stampedManifest(root, sha)
  )
    throw Error("A release requires a clean source checkout or exactly its derived version stamp");
}
function stampReleaseVersion(root, sha, expected) {
  verifyReleaseWorkspace(root, sha);
  const version = deriveVersion(root, sha);
  if (expected !== undefined && expected !== version)
    throw Error("Requested version differs from derived source version");
  writeFileSync(path.join(root, "package.json"), stampedManifest(root, sha));
  verifyReleaseWorkspace(root, sha);
  return version;
}
function deriveReleaseVersion({ repositoryRoot, revision }) {
  return deriveVersion(path.resolve(repositoryRoot), revision);
}
module.exports = { deriveReleaseVersion, verifyReleaseWorkspace, stampReleaseVersion };
if (require.main === module) {
  try {
    if (process.argv.length !== 3)
      throw Error("Usage: node scripts/release-version.cjs <40-hex-sha>");
    process.stdout.write(
      deriveReleaseVersion({ repositoryRoot: process.cwd(), revision: process.argv[2] }) + "\n",
    );
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  }
}
