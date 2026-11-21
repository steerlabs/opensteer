import { resolve } from "node:path";

export function quote(value) {
  return "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
}

export function redact(value) {
  return String(value)
    .replace(/(#token=)[\w.-]+/gu, "$1[redacted]")
    .replace(/(\/v1\/browser\/connect\/)[\w-]+/gu, "$1[redacted]");
}

export const requiredFreeKiB = 50 * 1024 * 1024;

const otherPlatform = { "linux/arm64": "linux/amd64", "linux/amd64": "linux/arm64" };

/**
 * Where the verifier finds Docker and a root shell, chosen by OPENSTEER_HOME_VERIFIER_TARGET.
 * `colima` (the default) drives this Mac's Colima VM. `local` runs on the Linux machine it
 * verifies: the local Docker socket, `sudo -n bash -s` for root, and its own Docker root.
 */
export function verifierTarget({ env, home, os, arch, builder }) {
  const name = env.OPENSTEER_HOME_VERIFIER_TARGET ?? "colima";
  if (name === "colima") {
    return {
      name,
      dockerHost: "unix:///Users/timjang/.colima/default/docker.sock",
      rootShell: ["colima", ["ssh", "--", "sudo", "-n", "bash", "-s"]],
      shellLabel: "Colima",
      checkoutLabel: "macOS",
      builderDirectory: resolve(home, ".colima", builder),
      checkoutSpacePath: resolve(home, ".colima"),
      // The VM reaches fixtures served by this process on the Mac under this name.
      fixtureHost: "host.lima.internal",
      proofPlatform: "linux/arm64",
      requireBuilderPlatform: false,
    };
  }
  if (name !== "local")
    throw new Error(`OPENSTEER_HOME_VERIFIER_TARGET must be colima or local, not ${name}.`);
  if (os !== "linux")
    throw new Error("OPENSTEER_HOME_VERIFIER_TARGET=local runs on the Linux machine it verifies.");
  const proofPlatform = { x64: "linux/amd64", arm64: "linux/arm64" }[arch];
  if (!proofPlatform) throw new Error(`The local Home proof has no image platform for ${arch}.`);
  const builderDirectory = resolve(home, ".cache", builder);
  return {
    name,
    dockerHost: "unix:///var/run/docker.sock",
    rootShell: ["sudo", ["-n", "bash", "-s"]],
    shellLabel: "Local root shell",
    checkoutLabel: "Linux",
    builderDirectory,
    checkoutSpacePath: builderDirectory,
    fixtureHost: "localhost",
    proofPlatform,
    // A native builder without emulation cannot build the other platform: that check is blocked.
    requireBuilderPlatform: true,
  };
}

/** The platforms a `docker buildx inspect` report says the builder can build. */
export function builderPlatforms(inspectOutput) {
  const line = inspectOutput.split("\n").find((entry) => /^\s*Platforms:/u.test(entry));
  if (!line) return [];
  return line
    .replace(/^\s*Platforms:/u, "")
    .split(",")
    .map((platform) => platform.trim().replace(/\*$/u, ""))
    .filter(Boolean);
}

// The deployment proof runs on loaded images of its platform (ARM64 on Colima). The other
// platform is only built, into the BuildKit cache, after that proof, so it cannot block it.
export function homeImageBuilds(builder, proofPlatform = "linux/arm64") {
  const bake = ["buildx", "bake", "--builder", builder, "-f", "deploy/container/docker-bake.hcl"];
  const buildOnlyPlatform = otherPlatform[proofPlatform];
  return {
    proof: {
      platform: proofPlatform,
      args: [...bake, "--set", `home-*.platform=${proofPlatform}`, "--load", "home"],
    },
    buildOnly: {
      platform: buildOnlyPlatform,
      args: [
        ...bake,
        "--set",
        `home-*.platform=${buildOnlyPlatform}`,
        "--set",
        "home-*.output=type=cacheonly",
        "home",
      ],
    },
  };
}

/** One line that separates the deployment proof from the other platform's build-only check. */
export function platformSummary({
  proofPassed,
  buildOnly,
  proofPlatform = "linux/arm64",
  buildOnlyPlatform = "linux/amd64",
}) {
  const proof = proofPassed
    ? `The ${proofPlatform} deployment proof passed`
    : `The ${proofPlatform} deployment proof did not pass`;
  const build =
    buildOnly === true
      ? `the ${buildOnlyPlatform} Home image build passed.`
      : buildOnly === false
        ? `the ${buildOnlyPlatform} Home image build failed.`
        : `the ${buildOnlyPlatform} Home image build did not run.`;
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
