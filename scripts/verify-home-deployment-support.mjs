export function quote(value) {
  return "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
}

export function redact(value) {
  return String(value)
    .replace(/(#token=)[\w.-]+/gu, "$1[redacted]")
    .replace(/(\/v1\/browser\/connect\/)[\w-]+/gu, "$1[redacted]");
}

export const requiredFreeKiB = 50 * 1024 * 1024;

// The Colima deployment proof runs on loaded ARM64 images. AMD64 is only built, into the
// BuildKit cache, after that proof, so a builder without AMD64 support cannot block it.
export function homeImageBuilds(builder) {
  const bake = ["buildx", "bake", "--builder", builder, "-f", "deploy/container/docker-bake.hcl"];
  return {
    proof: {
      platform: "linux/arm64",
      args: [...bake, "--set", "home-*.platform=linux/arm64", "--load", "home"],
    },
    buildOnly: {
      platform: "linux/amd64",
      args: [
        ...bake,
        "--set",
        "home-*.platform=linux/amd64",
        "--set",
        "home-*.output=type=cacheonly",
        "home",
      ],
    },
  };
}

/** One line that separates the ARM64 deployment proof from the AMD64 build-only check. */
export function platformSummary({ proofPassed, buildOnly }) {
  const proof = proofPassed
    ? "The linux/arm64 deployment proof passed"
    : "The linux/arm64 deployment proof did not pass";
  const build =
    buildOnly === true
      ? "the linux/amd64 Home image build passed."
      : buildOnly === false
        ? "the linux/amd64 Home image build failed."
        : "the linux/amd64 Home image build did not run.";
  return `${proof}; ${build}`;
}

export function assertBuildSpace(location, dfOutput) {
  const rows = dfOutput.trim().split("\n").slice(1);
  if (!rows.length) throw new Error(`No filesystem usage returned for ${location}.`);
  for (const row of rows) {
    const match = row.trim().match(/^\S+\s+\d+\s+\d+\s+(\d+)\s+\d+%\s+(.+)$/u);
    if (!match) throw new Error(`Cannot parse filesystem usage for ${location}.`);
    const available = Number(match[1]);
    if (available < requiredFreeKiB) {
      const gib = (available / (1024 * 1024)).toFixed(1);
      throw new Error(
        `${location} (${match[2]}) has ${gib} GiB free. The Home build requires 50 GiB free before it starts.`,
      );
    }
  }
}
