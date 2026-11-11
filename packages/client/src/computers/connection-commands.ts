import {
  harnessCatalog,
  harnessExecutableEnvironmentVariable,
  shipsHarnessRuntimeBytes,
  type DeploymentShape,
} from "@opensteer/core";

export interface ComputerConnectionCommandPair {
  /**
   * Null when this build has no published Runner distribution to install from.
   * A bare host has no Opensteer on it, so with no artifact to download there
   * is no honest command to give — only one that ends in "command not found".
   */
  readonly bareHost: string | null;
  readonly container: string;
}

interface ComputerConnectionInput {
  readonly deploymentShape: DeploymentShape;
  /** Names the storage this addition gets, so two computers never share one. */
  readonly enrollmentId: string;
  readonly hostOrigin: string;
  readonly name: string;
  /**
   * Where this exact release's Runner archives are published, or null when
   * none are. See {@link runnerDistributionPrefix}.
   */
  readonly runnerDistribution: string | null;
  readonly token: string;
  readonly runnerImage?: string;
}

function enrollmentStorageSlug(enrollmentId: string): string {
  const compact = enrollmentId.replace(/^ren_/u, "").replaceAll("-", "").toLowerCase();
  if (
    !/^ren_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      enrollmentId,
    )
  ) {
    throw new Error("A connection command needs the id of the issued enrollment.");
  }
  return compact;
}

export function runnerImageReference(revision: string | undefined, registry = "opensteer"): string {
  if (revision && !/^[a-f0-9]{40}$/u.test(revision)) {
    throw new Error("The runner image requires a canonical source revision.");
  }
  const tag = revision ? `${"sha-"}${revision}` : "local";
  return `${registry}/runner:${tag}`;
}

/**
 * The directory holding this exact release's per-platform Runner archives.
 *
 * Both halves are required and neither is inferable: the base URL says where a
 * release was published, and the revision says which release this Web build
 * belongs to. A build missing either has no distribution to offer, and says so
 * rather than naming one that is not there.
 */
export function runnerDistributionPrefix(
  baseUrl: string | undefined,
  revision: string | undefined,
): string | null {
  if (!baseUrl || !revision) return null;
  if (!/^[a-f0-9]{40}$/u.test(revision)) {
    throw new Error("The runner distribution requires a canonical source revision.");
  }
  if (!/^https:\/\/[^\s"'$`\\]+$/u.test(baseUrl)) {
    throw new Error("The runner distribution base URL must be a plain https URL.");
  }
  const tag = `${"sha-"}${revision}`;
  return `${baseUrl.replace(/\/+$/u, "")}/${tag}`;
}

/** The revision a distribution directory was published for, from its tag. */
function distributionRevision(distribution: string): string {
  const prefix = "sha-";
  const tag = distribution.slice(distribution.lastIndexOf("/") + 1);
  const revision = tag.startsWith(prefix) ? tag.slice(prefix.length) : "";
  if (!/^[a-f0-9]{40}$/u.test(revision)) {
    throw new Error("The runner distribution must be published under a canonical source revision.");
  }
  return revision;
}

export function computerConnectionCommands(
  input: ComputerConnectionInput,
): ComputerConnectionCommandPair {
  const slug = enrollmentStorageSlug(input.enrollmentId);
  const bareHostDataDirectory = `$HOME/.opensteer/computers/${slug}`;
  const common = {
    OPENSTEER_DEPLOYMENT_KIND: input.deploymentShape.kind,
    OPENSTEER_HOST_URL: input.hostOrigin,
    OPENSTEER_MODE: "production",
    OPENSTEER_RUNNER_ENROLLMENT_TOKEN: input.token,
    OPENSTEER_RUNNER_KIND: "local",
    OPENSTEER_RUNNER_NAME: input.name,
  } as const;
  const localBare = {
    ...common,
    OPENSTEER_RUNNER_DATA_DIR: bareHostDataDirectory,
  } as const;
  const localContainer = {
    ...common,
    OPENSTEER_RUNNER_DATA_DIR: "/var/lib/opensteer",
  } as const;
  const volume = `opensteer-computer-${slug}`;
  const install = installScript(input.runnerDistribution, bareHostDataDirectory);
  return {
    bareHost: bareHostCommand(localBare, install),
    container: containerCommand(
      localContainer,
      volume,
      input.runnerImage ?? runnerImageReference(undefined),
    ),
  };
}

/**
 * Installs the pinned Runner distribution under this addition's own directory
 * and then becomes it. Each release lives in its own immutable directory,
 * named by the revision it was published for: a completed installation of
 * this release is reused, another release's directory is never touched, so
 * re-copying the command cannot remove files from an already-running process
 * and a failed download leaves whatever was installed intact.
 */
function installScript(distribution: string | null, dataDirectory: string): string | null {
  if (!distribution) return null;
  return [
    "set -eu",
    `dir="${dataDirectory}/runtime/${distributionRevision(distribution)}"`,
    'os="$(uname -s | tr "[:upper:]" "[:lower:]")"',
    'case "$(uname -m)" in x86_64) arch=amd64;; aarch64|arm64) arch=arm64;;',
    '*) echo "Opensteer has no Runner for this processor." >&2; exit 1;; esac',
    'mkdir -p "${dir%/*}"',
    'mkdir "$dir.installing" || { echo "Another Runner installation is in progress." >&2; exit 1; }',
    "trap 'rm -rf \"$dir.installing\"' EXIT",
    'if [ ! -d "$dir" ]; then',
    `curl -fsSL "${distribution}/opensteer-runner-$os-$arch.tar.gz" -o "$dir.installing/archive.tar.gz"`,
    'mkdir "$dir.installing/runtime"',
    'tar -xzf "$dir.installing/archive.tar.gz" -C "$dir.installing/runtime"',
    'mv "$dir.installing/runtime" "$dir"',
    "fi",
    'rm -rf "$dir.installing"',
    "trap - EXIT",
    'export OPENSTEER_NATIVE_FS_HELPER="$dir/bin/opensteer-native-fs"',
    'export OPENSTEER_AGENT_SKILLS_DIRECTORY="$dir/agent-skills"',
    'export OPENSTEER_NODE_EXECUTABLE="$dir/node/bin/node"',
    'export OPENSTEER_BROWSER_HARNESS="$dir/bin/browser-harness"',
    // Only bytes carried by the distribution get an executable path. Installed
    // engines come from the computer; downloaded engines prepare themselves in
    // the Runner's writable cache.
    ...harnessCatalog.flatMap((entry) =>
      shipsHarnessRuntimeBytes(entry)
        ? [
            `export ${harnessExecutableEnvironmentVariable(entry.kind)}="$dir/${entry.runtime.path}"`,
          ]
        : [],
    ),
    'exec "$dir/bin/opensteer-runner"',
  ].join("\n");
}

function bareHostCommand(
  environment: Readonly<Record<string, string>>,
  install: string | null,
): string | null {
  if (!install) return null;
  return `${Object.entries(environment)
    .map(([name, value]) => `${name}=${shellValue(value, name === "OPENSTEER_RUNNER_DATA_DIR")}`)
    .join(" ")} sh -c ${shellValue(install)}`;
}

function containerCommand(
  environment: Readonly<Record<string, string>>,
  volume: string,
  image: string,
): string {
  return [
    "docker run --detach --restart unless-stopped",
    `--volume ${volume}:/var/lib/opensteer`,
    ...Object.entries(environment).map(([name, value]) => `--env ${name}=${shellValue(value)}`),
    image,
  ].join(" ");
}

function shellValue(value: string, expandHome = false): string {
  // The only interpolation a generated command asks the shell for is the home
  // directory these per-computer paths are rooted at.
  if (expandHome && value.startsWith("$HOME/")) return `"${value}"`;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
