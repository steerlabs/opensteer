const { appendFileSync, lstatSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const releaseVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const releaseVersionMaxLength = 79;
const sourceRevisionPattern = /^[0-9a-f]{40}$/u;

/**
 * Resolve one releasable Opensteer identity. The semantic version comes only
 * from the root manifest; the revision must identify the clean checkout.
 */
function requireCanonicalReleaseIdentity(repositoryRoot, environment = process.env, options = {}) {
  const root = resolve(repositoryRoot);
  const manifestPath = resolve(root, "package.json");
  const metadata = lstatSync(manifestPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("The Opensteer root package manifest must be a real regular file.");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const version = manifest?.version;
  if (
    typeof version !== "string" ||
    version.length > releaseVersionMaxLength ||
    !releaseVersionPattern.test(version) ||
    version === "0.0.0"
  ) {
    throw new Error("The Opensteer root package must declare a real stable release version.");
  }
  const suppliedVersion = environment.OPENSTEER_RELEASE_VERSION;
  if (suppliedVersion !== undefined && suppliedVersion !== version) {
    throw new Error(
      `OPENSTEER_RELEASE_VERSION ${suppliedVersion} does not match canonical release ${version}.`,
    );
  }
  const sourceRevision = environment.OPENSTEER_SOURCE_REVISION;
  if (
    !sourceRevision ||
    !sourceRevisionPattern.test(sourceRevision) ||
    sourceRevision === "0".repeat(40)
  ) {
    throw new Error("OPENSTEER_SOURCE_REVISION must be one exact lowercase 40-hex Git commit.");
  }

  if (options.verifyRepository !== false) {
    const head = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (head !== sourceRevision) {
      throw new Error(
        `OPENSTEER_SOURCE_REVISION ${sourceRevision} does not match checkout HEAD ${head}.`,
      );
    }
    if (git(root, ["status", "--porcelain=v1", "--untracked-files=all"])) {
      throw new Error("An Opensteer release must be built from a clean source checkout.");
    }
  }
  return Object.freeze({ sourceRevision, version });
}

function git(root, arguments_) {
  const result = spawnSync("git", ["-C", root, ...arguments_], {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || "").trim();
    throw new Error(
      `Could not verify the Opensteer release checkout${detail ? `: ${detail}` : ""}`,
    );
  }
  return String(result.stdout).trim();
}

module.exports = { requireCanonicalReleaseIdentity };

if (require.main === module) {
  try {
    const repositoryRoot = resolve(__dirname, "..");
    const identity = requireCanonicalReleaseIdentity(repositoryRoot);
    if (process.argv.includes("--github-output")) {
      const output = process.env.GITHUB_OUTPUT?.trim();
      if (!output) throw new Error("GITHUB_OUTPUT is required with --github-output.");
      appendFileSync(
        output,
        `version=${identity.version}\nsource_revision=${identity.sourceRevision}\n`,
        "utf8",
      );
    } else {
      process.stdout.write(`${JSON.stringify(identity)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
