import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserPoolHostIdSchema } from "../packages/control-plane-protocol/src/browser-pool.js";
import {
  validateEgressCredential,
  validateEgressUpstreamUrl,
} from "../apps/control-plane/src/cloud-computers/egress-validation.js";
import { ComputeFake } from "../apps/home-provisioner/src/google-compute.test-support.js";
import {
  poolProfileDiskDevicePath,
  renderPoolHostUserData,
} from "../apps/home-provisioner/src/pool-boot.js";
import { readAgentConfig, refuseUnsupportedMode } from "../apps/pool-agent/src/config.js";
import {
  egressRuleset,
  hostRuleset,
  resolverFile,
} from "../apps/pool-agent/src/firecracker/network.js";
import {
  browserEgressCredentialWritable,
  parseBrowserEgressUpstreamUrl,
} from "../packages/browser-runtime-core/src/browser-egress-upstream.js";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const enrollScript = join(repoRoot, "apps/pool-agent/host/enroll-host.sh");
const setupScript = join(repoRoot, "apps/pool-agent/host/setup-host.sh");

function hostProfileDiskLabel(hostId: string): string {
  return `osp-${createHash("sha256").update(hostId, "utf8").digest("hex").slice(0, 12)}`;
}

function runScript(
  scriptPath: string,
  args: string[],
  envOverrides: Record<string, string> = {},
  input?: string,
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("bash", [scriptPath, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...envOverrides },
      ...(input !== undefined
        ? { input, stdio: ["pipe", "pipe", "pipe"] as const }
        : { stdio: ["ignore", "pipe", "pipe"] as const }),
    });
    return { status: 0, stdout: stdout.trim(), stderr: "" };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? 1,
      stdout: (err.stdout ?? "").trim(),
      stderr: (err.stderr ?? "").trim(),
    };
  }
}

function runEnroll(args: string[], envOverrides: Record<string, string> = {}) {
  return runScript(enrollScript, args, envOverrides);
}

function ed25519SpkiBase64(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  return publicKey.export({ format: "der", type: "spki" }).toString("base64");
}

interface FakeCall {
  readonly cmd: string;
  readonly args: string[];
  readonly stdin?: string;
  readonly tokenExistsAtCall?: boolean;
}

interface FakeHostHarnessOptions {
  readonly blkidRc?: number;
  readonly blkidOut?: string;
  readonly secondBlkidRc?: number;
  readonly secondBlkidOut?: string;
  readonly wipefsRc?: number;
  readonly wipefsOut?: string;
  readonly secondWipefsRc?: number;
  readonly secondWipefsOut?: string;
  readonly mkfsRc?: number;
  readonly mountRc?: number;
  readonly systemctlRc?: number;
  readonly blockDevices?: readonly string[];
  readonly blockDeviceAppearsOnCheck?: number;
  readonly readlinkMap?: Record<string, string>;
  readonly bootSource?: string;
  readonly pknameMap?: Record<string, string>;
  readonly tokenFile?: string;
  readonly alreadyMountedSource?: string;
  readonly setupInstallStub?: boolean;
  readonly realInstallHostEnv?: boolean;
  readonly curlBundleFile?: string;
  readonly metadataReadyFile?: string;
  readonly bootEndpointFailsAfterComplete?: boolean;
}

const DEVICE_WRITING_COMMANDS = [
  "dd",
  "sgdisk",
  "sfdisk",
  "parted",
  "e2fsck",
  "fsck",
  "fsck.ext4",
  "fsck.xfs",
  "tune2fs",
  "e2label",
  "blkdiscard",
  "fstrim",
  "mkfs",
  "mkfs.xfs",
  "mkfs.vfat",
  "mke2fs",
  "mkswap",
  "truncate",
  "losetup",
  "mdadm",
  "cryptsetup",
] as const;

const READ_ONLY_PROBE_COMMANDS = new Set([
  "id",
  "stat",
  "readlink",
  "udevadm",
  "findmnt",
  "lsblk",
  "install",
  "mountpoint",
  "blkid",
  "uname",
]);

function expectOnlyReadOnlyCalls(
  calls: readonly FakeCall[],
  context: string,
  extraAllowed: readonly string[] = [],
) {
  const allowed = new Set([...READ_ONLY_PROBE_COMMANDS, ...extraAllowed]);
  const disallowed = calls.filter((call) => {
    if (call.cmd === "wipefs") {
      return !call.args.includes("-n") || call.args.includes("-a");
    }
    return !allowed.has(call.cmd);
  });
  expect(disallowed, `non-read-only commands executed on ${context}`).toEqual([]);
}

function writeExecutable(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, { mode: 0o755 });
  return p;
}

describe("pool host enrolment and setup scripts (Y1-Y7, X1)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "opensteer-pool-enrol-test-"));
    tempDirs.push(dir);
    return dir;
  }

  function createFakeHostEnv(opts: FakeHostHarnessOptions = {}) {
    const root = makeTempDir();
    const binDir = join(root, "bin");
    const optDir = join(root, "opt");
    const stateDir = join(root, "state");
    const arrayDir = join(root, "array");
    const runDir = join(root, "run");
    const etcDir = join(root, "etc");
    const relayEtcDir = join(root, "relay-etc");
    const cloudInitDir = join(root, "cloud-init");
    const tmpBase = join(root, "tmp");
    const bundleDir = join(root, "bundle");
    for (const d of [
      binDir,
      optDir,
      stateDir,
      arrayDir,
      runDir,
      etcDir,
      relayEtcDir,
      cloudInitDir,
      tmpBase,
      bundleDir,
    ]) {
      mkdirSync(d, { recursive: true, mode: 0o700 });
    }

    const callsFile = join(root, "calls.jsonl");
    const mountedFile = join(root, "mounted-source");
    if (opts.alreadyMountedSource) {
      writeFileSync(mountedFile, opts.alreadyMountedSource, "utf8");
    }

    // Fast bash stubs for high-frequency commands (avoids 70x python3 startups per enrolment while still recording every call).
    const logCallBash = `printf '{"cmd":"%s","args":[' "$CMD" >> ${JSON.stringify(callsFile)}; first=1; for a in "$@"; do a=\${a//\\\\/\\\\\\\\}; a=\${a//\\"/\\\\\\"}; [[ $first == 1 ]] && first=0 || printf ',' >> ${JSON.stringify(callsFile)}; printf '"%s"' "$a" >> ${JSON.stringify(callsFile)}; done; printf ']}\\n' >> ${JSON.stringify(callsFile)}`;
    writeExecutable(
      binDir,
      "id",
      `#!/usr/bin/env bash
CMD=id; ${logCallBash}
if [[ \${1:-} == -u && \${2:-} == opensteer-pool-relay ]]; then echo 987; else echo 0; fi
`,
    );
    writeExecutable(
      binDir,
      "chown",
      `#!/usr/bin/env bash
CMD=chown; ${logCallBash}
exit 0
`,
    );
    writeExecutable(
      binDir,
      "udevadm",
      `#!/usr/bin/env bash
CMD=udevadm; ${logCallBash}
exit 0
`,
    );
    writeExecutable(
      binDir,
      "uname",
      `#!/usr/bin/env bash
CMD=uname; ${logCallBash}
if [[ " $* " == *" -m "* ]]; then echo x86_64; else echo Linux; fi
`,
    );
    writeExecutable(
      binDir,
      "install",
      `#!/usr/bin/env bash
CMD=install; ${logCallBash}
mode=""; is_dir=0; args=()
while (( $# > 0 )); do
  case "$1" in
    -d) is_dir=1; shift ;;
    -m) mode="$2"; shift 2 ;;
    -o|-g) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
if (( is_dir )); then
  for d in "\${args[@]}"; do
    mkdir -p "$d"
    [[ -n $mode ]] && chmod "$mode" "$d"
  done
elif (( \${#args[@]} == 2 )); then
  cp "\${args[0]}" "\${args[1]}"
  [[ -n $mode ]] && chmod "$mode" "\${args[1]}"
fi
exit 0
`,
    );
    // Z4(b): Every command that can write a device has a recording stand-in that exits non-zero.
    for (const writer of DEVICE_WRITING_COMMANDS) {
      writeExecutable(
        binDir,
        writer,
        `#!/usr/bin/env bash
CMD=${writer}; ${logCallBash}
exit 1
`,
      );
    }
    for (const noop of ["nft", "sysctl", "swapoff", "modprobe"]) {
      writeExecutable(
        binDir,
        noop,
        `#!/usr/bin/env bash
CMD=${noop}; ${logCallBash}
exit 0
`,
      );
    }
    if (opts.realInstallHostEnv) {
      for (const pkgCmd of ["apt-get", "getent", "useradd"]) {
        writeExecutable(
          binDir,
          pkgCmd,
          `#!/usr/bin/env bash
CMD=${pkgCmd}; ${logCallBash}
exit 0
`,
        );
      }
      // Provide pre-staged dummy binaries and matching sha256sum so real `setup-host.sh install`
      // runs all the way through install_packages -> install_binaries -> host_key -> save_host_env
      // -> install_units -> mount_profile_disk -> saved_state_array without needing internet.
      mkdirSync(join(optDir, "bin"), { recursive: true });
      mkdirSync(join(optDir, "download"), { recursive: true });
      mkdirSync(join(optDir, "node/bin"), { recursive: true });
      writeFileSync(join(optDir, "download/firecracker.tgz"), "fake-fc");
      writeFileSync(join(optDir, "download/node.tar.xz"), "fake-node");
      writeExecutable(join(optDir, "node/bin"), "node", `#!/usr/bin/env bash\necho v24.15.0\n`);
      writeExecutable(
        binDir,
        "tar",
        `#!/usr/bin/env bash
CMD=tar; ${logCallBash}
dest=""
while (( $# > 0 )); do
  if [[ $1 == -C ]]; then dest="$2"; shift 2; else shift; fi
done
if [[ -n $dest ]]; then
  mkdir -p "$dest/release-v1.15.0-x86_64"
  printf 'fc' > "$dest/release-v1.15.0-x86_64/firecracker-v1.15.0-x86_64"
  printf 'jl' > "$dest/release-v1.15.0-x86_64/jailer-v1.15.0-x86_64"
fi
exit 0
`,
      );
    }
    writeExecutable(
      binDir,
      "uuidgen",
      `#!/usr/bin/env bash
CMD=uuidgen; ${logCallBash}
echo 11111111-2222-4333-8444-555555555555
`,
    );
    const blockDevicesSet = (
      opts.blockDevices ?? [
        poolProfileDiskDevicePath,
        "/dev/sdb",
        "/dev/nvme0n1",
        "/dev/sda",
        "/dev/sda1",
      ]
    ).join(" ");
    const readlinkCases = Object.entries(
      opts.readlinkMap ?? {
        [poolProfileDiskDevicePath]: "/dev/sdb",
        "/dev/sdb": "/dev/sdb",
        "/dev/nvme0n1": "/dev/nvme0n1",
        "/dev/sda": "/dev/sda",
        "/dev/sda1": "/dev/sda1",
      },
    )
      .map(([k, v]) => `  ${JSON.stringify(k)}) echo ${JSON.stringify(v)}; exit 0 ;;`)
      .join("\n");
    const pknameCases = Object.entries(
      opts.pknameMap ?? {
        "/dev/sda1": "sda",
        "/dev/nvme0n1p1": "nvme0n1",
      },
    )
      .map(([k, v]) => `  ${JSON.stringify(k)}) echo ${JSON.stringify(v)}; exit 0 ;;`)
      .join("\n");
    const profilesRootPath = join(stateDir, "profiles");
    const bootSrc = opts.bootSource ?? "/dev/sda1";

    writeExecutable(
      binDir,
      "readlink",
      `#!/usr/bin/env bash
CMD=readlink; ${logCallBash}
target="\${!#}"
case "$target" in
${readlinkCases}
esac
if [[ -e "$target" ]]; then
  dir="\${target%/*}"; base="\${target##*/}"
  [[ $dir == "$target" ]] && dir="."
  (cd "$dir" && printf '%s/%s\\n' "$(pwd -P)" "$base")
else
  printf '%s\\n' "$target"
fi
`,
    );
    const statChecksFile = join(root, "stat-checks");
    const appearsOnCheck = opts.blockDeviceAppearsOnCheck ?? 0;
    writeExecutable(
      binDir,
      "stat",
      `#!/usr/bin/env bash
CMD=stat; ${logCallBash}
fmt=""; target="\${!#}"
while (( $# > 0 )); do
  if [[ $1 == -c ]]; then fmt="$2"; shift 2; else shift; fi
done
if [[ $fmt == "%F" ]]; then
  if (( ${appearsOnCheck} > 0 )) && [[ $target == ${JSON.stringify(poolProfileDiskDevicePath)} ]]; then
    n=$(cat ${JSON.stringify(statChecksFile)} 2>/dev/null || echo 0)
    n=$(( n + 1 ))
    echo "$n" > ${JSON.stringify(statChecksFile)}
    if (( n < ${appearsOnCheck} )); then exit 1; fi
  fi
  for d in ${blockDevicesSet}; do
    if [[ $target == "$d" ]]; then echo "block special file"; exit 0; fi
  done
  if [[ -f $target ]]; then echo "regular file"; exit 0; fi
  if [[ -d $target ]]; then echo "directory"; exit 0; fi
  exit 1
fi
if [[ $fmt == "%u" ]]; then echo 0; exit 0; fi
if [[ $fmt == "%a" ]]; then /usr/bin/stat -f '%Lp' "$target" 2>/dev/null || echo 600; exit 0; fi
exit 1
`,
    );
    writeExecutable(
      binDir,
      "lsblk",
      `#!/usr/bin/env bash
CMD=lsblk; ${logCallBash}
target="\${!#}"
case "$target" in
${pknameCases}
esac
exit 0
`,
    );
    writeExecutable(
      binDir,
      "mountpoint",
      `#!/usr/bin/env bash
CMD=mountpoint; ${logCallBash}
target="\${!#}"
if [[ $target == ${JSON.stringify(profilesRootPath)} && -f ${JSON.stringify(mountedFile)} ]]; then exit 0; fi
exit 1
`,
    );
    writeExecutable(
      binDir,
      "findmnt",
      `#!/usr/bin/env bash
CMD=findmnt; ${logCallBash}
col=""; target="\${!#}"
while (( $# > 0 )); do
  if [[ $1 == -o ]]; then col="$2"; shift 2; else shift; fi
done
if [[ $target == "/" && $col == SOURCE ]]; then
  if [[ -n ${JSON.stringify(bootSrc)} ]]; then echo ${JSON.stringify(bootSrc)}; exit 0; fi
  exit 1
fi
if [[ $target == ${JSON.stringify(profilesRootPath)} && -f ${JSON.stringify(mountedFile)} ]]; then
  if [[ $col == SOURCE ]]; then cat ${JSON.stringify(mountedFile)}; exit 0; fi
  if [[ $col == OPTIONS ]]; then echo "rw,nosuid,nodev,noatime"; exit 0; fi
fi
exit 1
`,
    );
    const bootCompleteFlag = join(root, "boot-complete-seen");
    const fakeArtifactSha = createHash("sha256")
      .update("fake-artifact-content", "utf8")
      .digest("hex");
    writeExecutable(
      binDir,
      "sha256sum",
      `#!/usr/bin/env bash
CMD=sha256sum; ${logCallBash}
if [[ " $* " == *" -c "* ]]; then
  if [[ ${opts.realInstallHostEnv ? "1" : "0"} == "1" ]]; then
    exit 0
  fi
  while read -r expected path; do
    [[ -z $expected ]] && continue
    read -r actual _ < <(openssl dgst -sha256 -r "$path")
    [[ $actual == "$expected" ]] || exit 1
  done
  exit 0
fi
for p in "$@"; do
  read -r h _ < <(openssl dgst -sha256 -r "$p")
  printf '%s  %s\\n' "$h" "$p"
done
`,
    );
    writeExecutable(
      binDir,
      "curl",
      `#!/usr/bin/env bash
CMD=curl; ${logCallBash}
out_file=""; write_code=0; url="\${!#}"
while (( $# > 0 )); do
  case "$1" in
    -o|--output) out_file="$2"; shift 2 ;;
    -w) write_code=1; shift 2 ;;
    *) shift ;;
  esac
done
if [[ $url == *"/computeMetadata/v1/instance/attributes/opensteer-bootstrap-ready"* ]]; then
  if [[ -n ${JSON.stringify(opts.metadataReadyFile ?? "")} && -f ${JSON.stringify(opts.metadataReadyFile ?? "")} ]]; then
    cat ${JSON.stringify(opts.metadataReadyFile ?? "")}
    exit 0
  fi
  exit 22
fi
if [[ $url == *"/pool-host-bundle.tar.gz"* && -n ${JSON.stringify(opts.curlBundleFile ?? "")} ]]; then
  cp ${JSON.stringify(opts.curlBundleFile ?? "")} "$out_file"
  (( write_code )) && printf '200'
  exit 0
fi
if [[ $url == *"/boot-complete"* ]]; then
  touch ${JSON.stringify(bootCompleteFlag)}
  [[ -n $out_file ]] && printf '{"completed":true}' > "$out_file"
  (( write_code )) && printf '200'
  exit 0
fi
if [[ $url == *"/boot" ]]; then
  if [[ ${opts.bootEndpointFailsAfterComplete ? "1" : "0"} == "1" && -f ${JSON.stringify(bootCompleteFlag)} ]]; then
    [[ -n $out_file ]] && printf '{"error":"already enrolled"}' > "$out_file"
    (( write_code )) && printf '401'
    exit 0
  fi
  host_id=$(printf '%s' "$url" | sed -E 's|.*/hosts/([^/]+)/boot$|\\1|')
  [[ -n $out_file ]] && cat > "$out_file" <<JSON
{"hostId":"$host_id","generation":1,"profileDiskName":"osp-disk-test","release":{"version":"1.0.0","installerUrl":"https://releases.example.test/pool-host-bundle.tar.gz","installerSha256":"${"a".repeat(64)}","artifacts":{"agentUrl":"https://releases.example.test/agent.mjs","agentSha256":"${fakeArtifactSha}","relayUrl":"https://releases.example.test/relay.mjs","relaySha256":"${fakeArtifactSha}","rootfsUrl":"https://releases.example.test/rootfs.ext4","rootfsSha256":"${fakeArtifactSha}","kernelUrl":"https://releases.example.test/vmlinux","kernelSha256":"${fakeArtifactSha}","egressUrl":"https://releases.example.test/egress.js","egressSha256":"${fakeArtifactSha}"}}}
JSON
  (( write_code )) && printf '200'
  exit 0
fi
[[ -n $out_file ]] && printf 'fake-artifact-content' > "$out_file"
(( write_code )) && printf '200'
exit 0
`,
    );

    const blkidCallsFile = join(root, "blkid-calls");
    const blkidOut1File = join(root, "blkid-out-1");
    const blkidOut2File = join(root, "blkid-out-2");
    const blkidRc1File = join(root, "blkid-rc-1");
    const blkidRc2File = join(root, "blkid-rc-2");
    const wipefsCallsFile = join(root, "wipefs-calls");
    const wipefsOut1File = join(root, "wipefs-out-1");
    const wipefsOut2File = join(root, "wipefs-out-2");
    const wipefsRc1File = join(root, "wipefs-rc-1");
    const wipefsRc2File = join(root, "wipefs-rc-2");
    const systemctlRcFile = join(root, "systemctl-rc");
    writeFileSync(blkidCallsFile, "0", "utf8");
    writeFileSync(blkidOut1File, opts.blkidOut ?? "", "utf8");
    writeFileSync(blkidOut2File, opts.secondBlkidOut ?? opts.blkidOut ?? "", "utf8");
    writeFileSync(blkidRc1File, String(opts.blkidRc ?? 2), "utf8");
    writeFileSync(blkidRc2File, String(opts.secondBlkidRc ?? opts.blkidRc ?? 2), "utf8");
    writeFileSync(wipefsCallsFile, "0", "utf8");
    writeFileSync(wipefsOut1File, opts.wipefsOut ?? "", "utf8");
    writeFileSync(wipefsOut2File, opts.secondWipefsOut ?? opts.wipefsOut ?? "", "utf8");
    writeFileSync(wipefsRc1File, String(opts.wipefsRc ?? 0), "utf8");
    writeFileSync(wipefsRc2File, String(opts.secondWipefsRc ?? opts.wipefsRc ?? 0), "utf8");
    writeFileSync(systemctlRcFile, String(opts.systemctlRc ?? 0), "utf8");

    writeExecutable(
      binDir,
      "blkid",
      `#!/usr/bin/env bash
CMD=blkid; ${logCallBash}
n=$(< ${JSON.stringify(blkidCallsFile)})
n=$(( n + 1 ))
printf '%s' "$n" > ${JSON.stringify(blkidCallsFile)}
if (( n == 1 )); then
  out_f=${JSON.stringify(blkidOut1File)}; rc_f=${JSON.stringify(blkidRc1File)}
else
  out_f=${JSON.stringify(blkidOut2File)}; rc_f=${JSON.stringify(blkidRc2File)}
fi
if [[ -s $out_f ]]; then
  printf '%s\\n' "$(< "$out_f")"
fi
exit "$(< "$rc_f")"
`,
    );
    writeExecutable(
      binDir,
      "wipefs",
      `#!/usr/bin/env bash
CMD=wipefs; ${logCallBash}
if [[ " $* " == *" -n "* ]]; then
  n=$(< ${JSON.stringify(wipefsCallsFile)})
  n=$(( n + 1 ))
  printf '%s' "$n" > ${JSON.stringify(wipefsCallsFile)}
  if (( n == 1 )); then
    out_f=${JSON.stringify(wipefsOut1File)}; rc_f=${JSON.stringify(wipefsRc1File)}
  else
    out_f=${JSON.stringify(wipefsOut2File)}; rc_f=${JSON.stringify(wipefsRc2File)}
  fi
  if [[ -s $out_f ]]; then
    printf '%s\\n' "$(< "$out_f")"
  fi
  exit "$(< "$rc_f")"
fi
exit 0
`,
    );
    writeExecutable(
      binDir,
      "mount",
      `#!/usr/bin/env bash
CMD=mount; ${logCallBash}
if (( ${opts.mountRc ?? 0} != 0 )); then exit ${opts.mountRc ?? 0}; fi
args=("$@")
src="\${args[\${#args[@]}-2]:-}"
target="\${args[\${#args[@]}-1]:-}"
if [[ $target == ${JSON.stringify(profilesRootPath)} ]]; then
  printf '%s' "$src" > ${JSON.stringify(mountedFile)}
fi
exit 0
`,
    );
    const tokenFileCheck = opts.tokenFile ?? "";
    writeExecutable(
      binDir,
      "systemctl",
      `#!/usr/bin/env bash
tok_exists="false"
if [[ -n ${JSON.stringify(tokenFileCheck)} && -e ${JSON.stringify(tokenFileCheck)} ]]; then tok_exists="true"; fi
printf '{"cmd":"systemctl","args":[' >> ${JSON.stringify(callsFile)}
first=1
for a in "$@"; do
  a=\${a//\\\\/\\\\\\\\}; a=\${a//\\"/\\\\\\"}
  [[ $first == 1 ]] && first=0 || printf ',' >> ${JSON.stringify(callsFile)}
  printf '"%s"' "$a" >> ${JSON.stringify(callsFile)}
done
if [[ -n ${JSON.stringify(tokenFileCheck)} ]]; then
  printf '],"tokenExistsAtCall":%s}\\n' "$tok_exists" >> ${JSON.stringify(callsFile)}
else
  printf ']}\\n' >> ${JSON.stringify(callsFile)}
fi
exit "$(cat ${JSON.stringify(systemctlRcFile)})"
`,
    );
    writeExecutable(
      binDir,
      "mkfs.ext4",
      `#!/usr/bin/env bash
IFS= read -r -d '' stdin_data || true
stdin_esc=\${stdin_data//\\\\/\\\\\\\\}
stdin_esc=\${stdin_esc//\\"/\\\\\\"}
stdin_esc=\${stdin_esc//$'\\n'/\\\\n}
stdin_esc=\${stdin_esc//$'\\r'/\\\\r}
printf '{"cmd":"mkfs.ext4","args":[' >> ${JSON.stringify(callsFile)}
first=1
for a in "$@"; do
  a=\${a//\\\\/\\\\\\\\}; a=\${a//\\"/\\\\\\"}
  [[ $first == 1 ]] && first=0 || printf ',' >> ${JSON.stringify(callsFile)}
  printf '"%s"' "$a" >> ${JSON.stringify(callsFile)}
done
printf '],"stdin":"%s"}\\n' "$stdin_esc" >> ${JSON.stringify(callsFile)}
rc=${opts.mkfsRc ?? 0}
if (( rc == 0 )); then
  label=""
  prev=""
  for a in "$@"; do
    if [[ $prev == -L ]]; then label="$a"; fi
    prev="$a"
  done
  dev="\${!#}"
  printf 'DEVNAME=%s\\nLABEL=%s\\nTYPE=ext4\\nUSAGE=filesystem\\n' "$dev" "$label" > ${JSON.stringify(blkidOut2File)}
  printf '0' > ${JSON.stringify(blkidRc2File)}
fi
exit "$rc"
`,
    );

    // Copy enroll-host.sh (and optionally real or stub setup-host.sh) into bundleDir.
    const bundledEnroll = join(bundleDir, "enroll-host.sh");
    writeFileSync(bundledEnroll, readFileSync(enrollScript, "utf8"), { mode: 0o755 });
    const bundledSetup = join(bundleDir, "setup-host.sh");
    if (opts.setupInstallStub) {
      // Stub setup-host.sh that delegates verify-profiles-mount / boot to real checks, while making `install` fast & key-generating.
      writeExecutable(
        bundleDir,
        "setup-host.sh",
        `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  install)
    install -d -m 0700 "${etcDir}" "${relayEtcDir}" "${optDir}" "${stateDir}/images"
    cp "$0" "${optDir}/setup-host.sh"
    chmod 0755 "${optDir}/setup-host.sh"
    if [[ ! -f "${etcDir}/host-key.pem" ]]; then
      openssl genpkey -algorithm ed25519 -out "${etcDir}/host-key.pem" 2>/dev/null
      openssl pkey -in "${etcDir}/host-key.pem" -pubout -out "${etcDir}/host-key.pub" 2>/dev/null
    fi
    if [[ ! -f "${etcDir}/relay-key.pem" ]]; then
      openssl genpkey -algorithm ed25519 -out "${etcDir}/relay-key.pem" 2>/dev/null
      openssl pkey -in "${etcDir}/relay-key.pem" -pubout -out "${relayEtcDir}/relay-key.pub" 2>/dev/null
    fi
    cat > "${etcDir}/host.env" <<EOF
OSP_HOME_CIDR=\${OSP_HOME_CIDR:-}
OSP_PROVISIONER_CIDR=\${OSP_PROVISIONER_CIDR:-}
OSP_AGENT_PORT=\${OSP_AGENT_PORT:-7310}
OSP_ADMIN_PORT=\${OSP_ADMIN_PORT:-7311}
OSP_RELAY_PORT=\${OSP_RELAY_PORT:-7312}
OSP_PROFILE_DISK=\${OSP_PROFILE_DISK:-}
OSP_PROFILE_DISK_LABEL=\${OSP_PROFILE_DISK_LABEL:-}
OSP_PROFILES_ROOT=\${OSP_PROFILES_ROOT:-${stateDir}/profiles}
OSP_REQUIRE_PROFILE_DISK=1
EOF
    chmod 0600 "${etcDir}/host.env"
    ;;
  boot)
    exec bash "${setupScript}" verify-profiles-mount
    ;;
  verify-profiles-mount|wait-profile-disk|parent-whole-disk)
    exec bash "${setupScript}" "$@"
    ;;
  *)
    exit 0
    ;;
esac
`,
      );
    } else {
      writeFileSync(bundledSetup, readFileSync(setupScript, "utf8"), { mode: 0o755 });
    }

    const extraEnv: Record<string, string> = {};
    if (opts.realInstallHostEnv) {
      const hostFakeDir = join(root, "fake-sys");
      const systemdDir = join(root, "systemd");
      const vulnsDir = join(hostFakeDir, "vulns");
      mkdirSync(hostFakeDir, { recursive: true });
      mkdirSync(systemdDir, { recursive: true });
      mkdirSync(vulnsDir, { recursive: true });
      const kvmDev = join(hostFakeDir, "kvm");
      const cgroupCtrl = join(hostFakeDir, "cgroup.controllers");
      const smtActive = join(hostFakeDir, "smt-active");
      writeFileSync(kvmDev, "");
      writeFileSync(cgroupCtrl, "cpu memory pids\n");
      writeFileSync(smtActive, "0\n");
      extraEnv.OSP_SYSTEMD_DIR = systemdDir;
      extraEnv.OSP_KVM_DEV = kvmDev;
      extraEnv.OSP_CGROUP_CONTROLLERS = cgroupCtrl;
      extraEnv.OSP_SMT_ACTIVE = smtActive;
      extraEnv.OSP_CPU_VULNS_DIR = vulnsDir;
      extraEnv.OSP_PROFILE_DISK_WAIT_SECONDS = "1";
    }

    const env: Record<string, string> = {
      PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`,
      OSP_OPT_DIR: optDir,
      OSP_STATE_DIR: stateDir,
      OSP_ARRAY_DIR: arrayDir,
      OSP_RUN_DIR: runDir,
      OSP_ETC_DIR: etcDir,
      OSP_RELAY_ETC_DIR: relayEtcDir,
      OSP_CLOUD_INIT_DIR: cloudInitDir,
      OSP_TMP_BASE: tmpBase,
      ...extraEnv,
    };

    const readCalls = (): FakeCall[] => {
      if (!existsSync(callsFile)) return [];
      return readFileSync(callsFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeCall);
    };

    return {
      root,
      binDir,
      optDir,
      stateDir,
      arrayDir,
      runDir,
      etcDir,
      relayEtcDir,
      cloudInitDir,
      bundleDir,
      bundledEnroll,
      bundledSetup,
      env,
      readCalls,
    };
  }

  function makeBootSpec(
    overrides: Record<string, unknown> = {},
    withInlineArtifacts = false,
  ): Record<string, unknown> {
    const fakeArtifactSha = createHash("sha256").update("fake-artifact-content").digest("hex");
    return {
      hostId: "ph_11111111-1111-4111-8111-111111111111",
      generation: 1,
      accountOrigin: "https://account.example.test",
      installerUrl: "https://releases.example.test/pool-host-bundle.tar.gz",
      installerSha256: "a".repeat(64),
      provisionerKey: ed25519SpkiBase64(),
      homeCidr: "10.40.0.0/20",
      provisionerCidr: "10.50.0.0/24",
      profileDiskDevice: poolProfileDiskDevicePath,
      everEnrolled: false,
      agentPort: 7310,
      adminPort: 7311,
      relayPort: 7312,
      ...(withInlineArtifacts
        ? {
            releaseVersion: "1.0.0-test",
            artifacts: {
              agentUrl: "https://releases.example.test/main.js",
              agentSha256: fakeArtifactSha,
              relayUrl: "https://releases.example.test/relay.mjs",
              relaySha256: fakeArtifactSha,
              rootfsUrl: "https://releases.example.test/rootfs.ext4",
              rootfsSha256: fakeArtifactSha,
              kernelUrl: "https://releases.example.test/vmlinux",
              kernelSha256: fakeArtifactSha,
              egressUrl: "https://releases.example.test/egress-main.js",
              egressSha256: fakeArtifactSha,
            },
          }
        : {}),
      ...overrides,
    };
  }

  describe("X1 + Y7 profile-disk format-or-not decision table (decide-profile-disk)", () => {
    const hostA = "ph_11111111-1111-4111-8111-111111111111";
    const hostB = "ph_22222222-2222-4222-8222-222222222222";
    const labelA = hostProfileDiskLabel(hostA);
    const labelB = hostProfileDiskLabel(hostB);
    const validBlkid = [
      "DEVNAME=/dev/sdb",
      `LABEL=${labelA}`,
      "UUID=11111111-2222-3333-4444-555555555555",
      "BLOCK_SIZE=4096",
      "TYPE=ext4",
      "USAGE=filesystem",
    ].join("\n");
    const validWipefs = `google-opensteer-profiles 0x438  ext4 11111111-2222-3333-4444-555555555555 ${labelA}`;

    it("derives a 16-byte per-host ext4 label osp-<12hex> and refuses another host's label (Y7)", () => {
      expect(labelA).toMatch(/^osp-[0-9a-f]{12}$/u);
      expect(labelA).toHaveLength(16);
      expect(labelB).not.toBe(labelA);

      const otherHostRes = runEnroll([
        "decide-profile-disk",
        "--host-id",
        hostA,
        "--ever-enrolled",
        "true",
        "--blkid-rc",
        "0",
        "--blkid-out",
        validBlkid.replace(`LABEL=${labelA}`, `LABEL=${labelB}`),
        "--wipefs-rc",
        "0",
        "--wipefs-out",
        validWipefs.replace(labelA, labelB),
      ]);
      expect(otherHostRes.status).toBe(1);
      expect(otherHostRes.stdout).toBe("refuse:foreign-disk-signature");
    });

    it("formats and mounts a blank disk only when everEnrolled=false", () => {
      const res = runEnroll([
        "decide-profile-disk",
        "--host-id",
        hostA,
        "--ever-enrolled",
        "false",
        "--blkid-rc",
        "2",
        "--blkid-out",
        "",
        "--wipefs-rc",
        "0",
        "--wipefs-out",
        "",
      ]);
      expect(res.status).toBe(0);
      expect(res.stdout).toBe("format-and-mount");
    });

    it("refuses a blank disk when everEnrolled=true (never formats an enrolled host's disk)", () => {
      const res = runEnroll([
        "decide-profile-disk",
        "--host-id",
        hostA,
        "--ever-enrolled",
        "true",
        "--blkid-rc",
        "2",
        "--blkid-out",
        "",
        "--wipefs-rc",
        "0",
        "--wipefs-out",
        "",
      ]);
      expect(res.status).toBe(1);
      expect(res.stdout).toBe("refuse:enrolled-host-blank-disk");
    });

    it("mounts an existing ext4 disk carrying this host's label on both everEnrolled=true and everEnrolled=false", () => {
      for (const everEnrolled of ["true", "false"]) {
        const res = runEnroll([
          "decide-profile-disk",
          "--host-id",
          hostA,
          "--ever-enrolled",
          everEnrolled,
          "--blkid-rc",
          "0",
          "--blkid-out",
          validBlkid,
          "--wipefs-rc",
          "0",
          "--wipefs-out",
          validWipefs,
        ]);
        expect(res.status).toBe(0);
        expect(res.stdout).toBe("mount-only");
      }
    });

    it("refuses an unmountable, unlabeled, wrong-label, wrong-fs, partitioned, multi-signature, or probe-error disk", () => {
      const unmountable = runEnroll([
        "decide-profile-disk",
        "--host-id",
        hostA,
        "--ever-enrolled",
        "true",
        "--blkid-rc",
        "0",
        "--blkid-out",
        validBlkid,
        "--wipefs-rc",
        "0",
        "--wipefs-out",
        validWipefs,
        "--mount-ok",
        "false",
      ]);
      expect(unmountable.status).toBe(1);
      expect(unmountable.stdout).toBe("refuse:unmountable-profile-disk");

      const xfs = runEnroll([
        "decide-profile-disk",
        "--host-id",
        hostA,
        "--ever-enrolled",
        "false",
        "--blkid-rc",
        "0",
        "--blkid-out",
        `DEVNAME=/dev/sdb\nLABEL=${labelA}\nTYPE=xfs`,
        "--wipefs-rc",
        "0",
        "--wipefs-out",
        `google-opensteer-profiles 0x0    xfs  11111111-2222-3333-4444-555555555555 ${labelA}`,
      ]);
      expect(xfs.status).toBe(1);
      expect(xfs.stdout).toBe("refuse:foreign-disk-signature");

      const gpt = runEnroll([
        "decide-profile-disk",
        "--host-id",
        hostA,
        "--ever-enrolled",
        "false",
        "--blkid-rc",
        "0",
        "--blkid-out",
        `${validBlkid}\nPTTYPE=gpt`,
        "--wipefs-rc",
        "0",
        "--wipefs-out",
        `${validWipefs}\ngoogle-opensteer-profiles 0x200  gpt`,
      ]);
      expect(gpt.status).toBe(1);
      expect(gpt.stdout).toBe("refuse:foreign-disk-signature");

      const probeErr = runEnroll([
        "decide-profile-disk",
        "--host-id",
        hostA,
        "--ever-enrolled",
        "false",
        "--blkid-rc",
        "1",
        "--blkid-out",
        "",
        "--wipefs-rc",
        "0",
        "--wipefs-out",
        "",
      ]);
      expect(probeErr.status).toBe(1);
      expect(probeErr.stdout).toBe("refuse:probe-error");
    });
  });

  describe("fake-PATH command-recording tests for Y1, Y2, Y3, Y5, and Y7", () => {
    it("Y1: refuses when host.env is missing or OSP_PROFILE_DISK is empty on a provisioned host", () => {
      const h = createFakeHostEnv();

      // Missing host.env must refuse on BOTH verify-profiles-mount AND boot (T6 / Z5).
      const verifyMissing = runScript(setupScript, ["verify-profiles-mount"], h.env);
      expect(verifyMissing.status).not.toBe(0);
      expect(verifyMissing.stderr).toMatch(/host\.env/iu);

      const bootMissing = runScript(setupScript, ["boot"], h.env);
      expect(bootMissing.status).not.toBe(0);
      expect(bootMissing.stderr).toMatch(/host\.env/iu);

      // Present host.env with empty OSP_PROFILE_DISK on a provisioned host must also refuse.
      writeFileSync(
        join(h.etcDir, "host.env"),
        `OSP_HOME_CIDR=10.40.0.0/20\nOSP_PROVISIONER_CIDR=10.50.0.0/24\nOSP_PROFILES_ROOT=${join(h.stateDir, "profiles")}\n`,
        { mode: 0o600 },
      );
      const verifyEmpty = runScript(setupScript, ["verify-profiles-mount"], h.env);
      expect(verifyEmpty.status).not.toBe(0);
      expect(verifyEmpty.stderr).toMatch(/OSP_PROFILE_DISK/iu);

      // Present host.env with a wrong filesystem label mounted at profilesRoot must also refuse.
      const labelA = hostProfileDiskLabel("ph_11111111-1111-4111-8111-111111111111");
      const labelB = hostProfileDiskLabel("ph_22222222-2222-4222-8222-222222222222");
      const hWrong = createFakeHostEnv({
        alreadyMountedSource: "/dev/sdb",
        blkidRc: 0,
        blkidOut: `DEVNAME=/dev/sdb\nLABEL=${labelB}\nTYPE=ext4\nUSAGE=filesystem`,
      });
      writeFileSync(
        join(hWrong.etcDir, "host.env"),
        `OSP_HOME_CIDR=10.40.0.0/20\nOSP_PROVISIONER_CIDR=10.50.0.0/24\nOSP_PROFILE_DISK=${poolProfileDiskDevicePath}\nOSP_PROFILE_DISK_LABEL=${labelA}\nOSP_REQUIRE_PROFILE_DISK=1\nOSP_PROFILES_ROOT=${join(hWrong.stateDir, "profiles")}\n`,
        { mode: 0o600 },
      );
      const verifyWrongLabel = runScript(setupScript, ["verify-profiles-mount"], hWrong.env);
      expect(verifyWrongLabel.status).not.toBe(0);
      expect(verifyWrongLabel.stderr).toMatch(new RegExp(labelA, "u"));
    });

    it("Y2 + Y5 + Y7: feeds 0 stdin bytes to mkfs.ext4, re-probes immediately before mkfs, starts services BEFORE removing token and cloud-init user-data, and formats with per-host label", () => {
      const hostId = "ph_11111111-1111-4111-8111-111111111111";
      const expectedLabel = hostProfileDiskLabel(hostId);
      const specDir = makeTempDir();
      const specPath = join(specDir, "boot.json");
      const tokenPath = join(specDir, "token");
      writeFileSync(specPath, JSON.stringify(makeBootSpec({ hostId, everEnrolled: false }, true)), {
        mode: 0o600,
      });
      writeFileSync(tokenPath, "t".repeat(43), { mode: 0o600 });

      const h = createFakeHostEnv({
        blkidRc: 2,
        blkidOut: "",
        wipefsRc: 0,
        wipefsOut: "",
        tokenFile: tokenPath,
        setupInstallStub: true,
      });
      const ciUserData = join(h.cloudInitDir, "user-data.txt");
      const ciUserDataI = join(h.cloudInitDir, "user-data.txt.i");
      writeFileSync(ciUserData, "#cloud-config\nsecret-token", { mode: 0o600 });
      writeFileSync(ciUserDataI, "#cloud-config\nsecret-token", { mode: 0o600 });

      // Z4(a): Run enrolment with non-empty stdin ("y\ny\n") so removing </dev/null from mkfs.ext4 fails this test.
      const res = runScript(
        h.bundledEnroll,
        [
          "--boot-spec",
          specPath,
          "--bootstrap-token-file",
          tokenPath,
          "--profiles-root",
          join(h.stateDir, "profiles"),
          "--credentials-root",
          join(h.etcDir, "credentials"),
        ],
        h.env,
        "y\ny\n",
      );
      expect(res.status, res.stderr).toBe(0);

      const calls = h.readCalls();
      const mkfsCalls = calls.filter((c) => c.cmd === "mkfs.ext4");
      expect(mkfsCalls).toHaveLength(1);
      // Y2: ZERO bytes piped to mkfs.ext4 (never 'y\n'), never -f or -F!
      expect(mkfsCalls[0]!.stdin).toBe("");
      expect(mkfsCalls[0]!.args).not.toContain("-f");
      expect(mkfsCalls[0]!.args).not.toContain("-F");
      // Y7: Per-host 16-byte ext4 label osp-<12hex>.
      expect(mkfsCalls[0]!.args).toContain(expectedLabel);

      // Y2: blkid and wipefs ran TWICE before mkfs.ext4 (initial probe + immediate pre-mkfs re-probe).
      const mkfsIdx = calls.findIndex((c) => c.cmd === "mkfs.ext4");
      const preMkfsBlkid = calls.slice(0, mkfsIdx).filter((c) => c.cmd === "blkid");
      const preMkfsWipefs = calls.slice(0, mkfsIdx).filter((c) => c.cmd === "wipefs");
      expect(preMkfsBlkid.length).toBeGreaterThanOrEqual(2);
      expect(preMkfsWipefs.length).toBeGreaterThanOrEqual(2);

      // Y5: systemctl enable --now ran WHILE token still existed, and token + cloud-init user-data were removed AFTER!
      const enableCall = calls.find(
        (c) => c.cmd === "systemctl" && c.args.includes("enable") && c.args.includes("--now"),
      );
      expect(enableCall).toBeDefined();
      expect(enableCall?.tokenExistsAtCall).toBe(true);
      expect(existsSync(tokenPath)).toBe(false);
      expect(existsSync(ciUserData)).toBe(false);
      expect(existsSync(ciUserDataI)).toBe(false);

      // Y1 + Y7: agent.json carries driver.profilesMount with the same per-host label.
      const agentJson = JSON.parse(readFileSync(join(h.etcDir, "agent.json"), "utf8")) as {
        driver: { profilesMount?: { label?: string } };
      };
      expect(agentJson.driver.profilesMount).toEqual({ label: expectedLabel });
    });

    it("Y5: keeps bootstrap token and cloud-init user-data when systemctl enable --now fails so a re-run finishes", () => {
      const specDir = makeTempDir();
      const specPath = join(specDir, "boot.json");
      const tokenPath = join(specDir, "token");
      writeFileSync(specPath, JSON.stringify(makeBootSpec({ everEnrolled: false }, true)), {
        mode: 0o600,
      });
      writeFileSync(tokenPath, "t".repeat(43), { mode: 0o600 });

      const h = createFakeHostEnv({
        blkidRc: 2,
        blkidOut: "",
        wipefsRc: 0,
        wipefsOut: "",
        systemctlRc: 1,
        tokenFile: tokenPath,
        setupInstallStub: true,
      });
      const ciUserData = join(h.cloudInitDir, "user-data.txt");
      writeFileSync(ciUserData, "#cloud-config\nsecret-token", { mode: 0o600 });

      // Z4(a): Run enrolment with non-empty stdin ("y\ny\n") so removing </dev/null from mkfs.ext4 fails this test.
      const res = runScript(
        h.bundledEnroll,
        [
          "--boot-spec",
          specPath,
          "--bootstrap-token-file",
          tokenPath,
          "--profiles-root",
          join(h.stateDir, "profiles"),
          "--credentials-root",
          join(h.etcDir, "credentials"),
        ],
        h.env,
        "y\ny\n",
      );
      expect(res.status).not.toBe(0);
      expect(
        h.readCalls().some((c) => c.cmd === "systemctl" && c.args.includes("enable")),
        "systemctl enable must have been reached before failing",
      ).toBe(true);
      expect(existsSync(tokenPath)).toBe(true);
      expect(existsSync(ciUserData)).toBe(true);
    });

    const refusalHostA = "ph_11111111-1111-4111-8111-111111111111";
    const refusalLabelB = hostProfileDiskLabel("ph_22222222-2222-4222-8222-222222222222");
    it.each<readonly [string, boolean, FakeHostHarnessOptions]>([
      [
        "enrolled host with blank disk",
        true,
        { blkidRc: 2, blkidOut: "", wipefsRc: 0, wipefsOut: "" },
      ],
      [
        "disk carrying another host's label",
        true,
        {
          blkidRc: 0,
          blkidOut: `DEVNAME=/dev/sdb\nLABEL=${refusalLabelB}\nTYPE=ext4\nUSAGE=filesystem`,
          wipefsRc: 0,
          wipefsOut: `google-opensteer-profiles 0x438 ext4 1111 ${refusalLabelB}`,
        },
      ],
      [
        "foreign xfs disk on never-enrolled host",
        false,
        {
          blkidRc: 0,
          blkidOut: "DEVNAME=/dev/sdb\nLABEL=other\nTYPE=xfs",
          wipefsRc: 0,
          wipefsOut: "google-opensteer-profiles 0x0 xfs 1111 other",
        },
      ],
      [
        "pre-mkfs re-probe sees a signature appear",
        false,
        {
          blkidRc: 2,
          blkidOut: "",
          secondBlkidRc: 0,
          secondBlkidOut: "DEVNAME=/dev/sdb\nTYPE=ext4",
          wipefsRc: 0,
          wipefsOut: "",
          secondWipefsRc: 0,
          secondWipefsOut: "google-opensteer-profiles 0x438 ext4 1111",
        },
      ],
    ])(
      "Y2 + X1: refusal path (%s) makes ZERO destructive calls (mkfs.ext4, wipefs -a, mdadm, cryptsetup, mkfs.xfs)",
      (name, everEnrolled, opts) => {
        const specDir = makeTempDir();
        const specPath = join(specDir, "boot.json");
        const tokenPath = join(specDir, "token");
        writeFileSync(
          specPath,
          JSON.stringify(makeBootSpec({ hostId: refusalHostA, everEnrolled }, true)),
          { mode: 0o600 },
        );
        writeFileSync(tokenPath, "t".repeat(43), { mode: 0o600 });

        const h = createFakeHostEnv({ ...opts, setupInstallStub: true });
        const res = runScript(
          h.bundledEnroll,
          [
            "--boot-spec",
            specPath,
            "--bootstrap-token-file",
            tokenPath,
            "--profiles-root",
            join(h.stateDir, "profiles"),
            "--credentials-root",
            join(h.etcDir, "credentials"),
          ],
          h.env,
        );
        expect(res.status, `expected refusal for ${name}`).not.toBe(0);
        const calls = h.readCalls();
        expect(
          calls.some((c) => c.cmd === "blkid"),
          `blkid probe must have run for ${name}`,
        ).toBe(true);
        // Z4(b): Assert on the COMPLETE call record — every command must be in the read-only allowlist.
        expectOnlyReadOnlyCalls(calls, `refusal path (${name})`);
      },
    );

    it("Z4(b): refusal path through the REAL setup-host.sh install makes ZERO device-writing calls on the complete call record", () => {
      const hostA = "ph_11111111-1111-4111-8111-111111111111";
      const labelA = hostProfileDiskLabel(hostA);
      const labelB = hostProfileDiskLabel("ph_22222222-2222-4222-8222-222222222222");
      // Real setup-host.sh install with a disk carrying another host's label refuses in mount_profile_disk
      // before saved_state_array ever runs.
      const h = createFakeHostEnv({
        blkidRc: 0,
        blkidOut: `DEVNAME=/dev/sdb\nLABEL=${labelB}\nTYPE=ext4\nUSAGE=filesystem`,
        wipefsRc: 0,
        wipefsOut: `google-opensteer-profiles 0x438 ext4 1111 ${labelB}`,
        realInstallHostEnv: true,
        setupInstallStub: false,
      });
      const res = runScript(setupScript, ["install"], {
        ...h.env,
        OSP_HOME_CIDR: "10.40.0.0/20",
        OSP_PROVISIONER_CIDR: "10.50.0.0/24",
        OSP_AGENT_PORT: "7310",
        OSP_ADMIN_PORT: "7311",
        OSP_RELAY_PORT: "7312",
        OSP_PROFILE_DISK: poolProfileDiskDevicePath,
        OSP_PROFILE_DISK_LABEL: labelA,
        OSP_REQUIRE_PROFILE_DISK: "1",
        OSP_PROFILES_ROOT: join(h.stateDir, "profiles"),
        OSP_SKIP_DEFAULT_KERNEL: "1",
        OSP_LOCAL_SSDS: "/dev/nvme0n1",
      });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(new RegExp(labelA, "u"));
      const calls = h.readCalls();
      expect(calls.some((c) => c.cmd === "apt-get")).toBe(true);
      expect(calls.some((c) => c.cmd === "blkid")).toBe(true);
      expectOnlyReadOnlyCalls(calls, "real setup-host.sh install refusal", [
        "apt-get",
        "getent",
        "useradd",
        "sha256sum",
        "tar",
        "systemctl",
      ]);
    });

    it("Y3: refuses any profileDiskDevice other than the fixed by-id path, and refuses scratch SSD array when any member resolves to the profile or boot disk", () => {
      // 1. enroll-host.sh rejects a local SSD named as profileDiskDevice.
      const dir = makeTempDir();
      const badSpec = join(dir, "bad-device.json");
      writeFileSync(
        badSpec,
        JSON.stringify(
          makeBootSpec({ profileDiskDevice: "/dev/disk/by-id/google-local-nvme-ssd-0" }),
        ),
        { mode: 0o600 },
      );
      const badDevRes = runEnroll([
        "render-agent-config",
        "--boot-spec",
        badSpec,
        "--relay-uid",
        "987",
      ]);
      expect(badDevRes.status).not.toBe(0);
      expect(badDevRes.stderr).toMatch(/google-opensteer-profiles/u);

      // 2. setup-host.sh saved-state-array refuses when OSP_LOCAL_SSDS resolves to the profile disk (NVMe persistent disk overlap).
      const hProfileOverlap = createFakeHostEnv({
        blockDevices: [
          poolProfileDiskDevicePath,
          "/dev/nvme0n1",
          "/dev/nvme0n2",
          "/dev/sda",
          "/dev/sda1",
        ],
        readlinkMap: {
          [poolProfileDiskDevicePath]: "/dev/nvme0n2",
          "/dev/nvme0n1": "/dev/nvme0n1",
          "/dev/nvme0n2": "/dev/nvme0n2",
          "/dev/sda": "/dev/sda",
          "/dev/sda1": "/dev/sda1",
        },
        bootSource: "/dev/sda1",
      });
      const resProfileOverlap = runScript(setupScript, ["saved-state-array"], {
        ...hProfileOverlap.env,
        OSP_PROFILE_DISK: poolProfileDiskDevicePath,
        OSP_LOCAL_SSDS: "/dev/nvme0n1 /dev/nvme0n2",
      });
      expect(resProfileOverlap.status).not.toBe(0);
      expect(resProfileOverlap.stderr).toMatch(/profile disk|boot disk/iu);
      expectOnlyReadOnlyCalls(hProfileOverlap.readCalls(), "Y3 profile disk overlap");

      // 3. setup-host.sh saved-state-array refuses when OSP_LOCAL_SSDS includes the boot disk's whole device (/dev/sda while / is /dev/sda1).
      const hBootOverlap = createFakeHostEnv({
        blockDevices: [
          poolProfileDiskDevicePath,
          "/dev/sdb",
          "/dev/sda",
          "/dev/sda1",
          "/dev/nvme0n1",
        ],
        readlinkMap: {
          [poolProfileDiskDevicePath]: "/dev/sdb",
          "/dev/sdb": "/dev/sdb",
          "/dev/sda": "/dev/sda",
          "/dev/sda1": "/dev/sda1",
          "/dev/nvme0n1": "/dev/nvme0n1",
        },
        bootSource: "/dev/sda1",
        pknameMap: { "/dev/sda1": "sda" },
      });
      const resBootOverlap = runScript(setupScript, ["saved-state-array"], {
        ...hBootOverlap.env,
        OSP_PROFILE_DISK: poolProfileDiskDevicePath,
        OSP_LOCAL_SSDS: "/dev/nvme0n1 /dev/sda",
      });
      expect(resBootOverlap.status).not.toBe(0);
      expect(resBootOverlap.stderr).toMatch(/boot disk/iu);
      expectOnlyReadOnlyCalls(hBootOverlap.readCalls(), "Y3 boot disk overlap");
    });

    it("Z10: enroll-host.sh fails closed when findmnt / fails or parent_whole_disk matches boot disk, and guard_scratch_members refuses missing configured profile disk", () => {
      const hostA = "ph_11111111-1111-4111-8111-111111111111";
      // 1. findmnt / prints nothing -> enroll-host.sh MUST refuse (never skip boot-disk check).
      const specDir1 = makeTempDir();
      const specPath1 = join(specDir1, "boot.json");
      const tokenPath1 = join(specDir1, "token");
      writeFileSync(
        specPath1,
        JSON.stringify(makeBootSpec({ hostId: hostA, everEnrolled: false }, true)),
        { mode: 0o600 },
      );
      writeFileSync(tokenPath1, "t".repeat(43), { mode: 0o600 });
      const hNoFindmnt = createFakeHostEnv({
        bootSource: "",
        blkidRc: 2,
        blkidOut: "",
        wipefsRc: 0,
        wipefsOut: "",
        setupInstallStub: true,
      });
      const resNoFindmnt = runScript(
        hNoFindmnt.bundledEnroll,
        [
          "--boot-spec",
          specPath1,
          "--bootstrap-token-file",
          tokenPath1,
          "--profiles-root",
          join(hNoFindmnt.stateDir, "profiles"),
          "--credentials-root",
          join(hNoFindmnt.etcDir, "credentials"),
        ],
        hNoFindmnt.env,
      );
      expect(resNoFindmnt.status).not.toBe(0);
      expect(resNoFindmnt.stderr).toMatch(/root\/boot disk|findmnt/iu);
      expectOnlyReadOnlyCalls(hNoFindmnt.readCalls(), "Z10 empty findmnt /");

      // 2. lsblk returns nothing while / is /dev/nvme0n1p1 and profile disk resolves to /dev/nvme0n1 -> parent_whole_disk refuses!
      const hNvmeParent = createFakeHostEnv({
        blockDevices: [poolProfileDiskDevicePath, "/dev/nvme0n1", "/dev/nvme0n1p1"],
        readlinkMap: {
          [poolProfileDiskDevicePath]: "/dev/nvme0n1",
          "/dev/nvme0n1": "/dev/nvme0n1",
          "/dev/nvme0n1p1": "/dev/nvme0n1p1",
        },
        bootSource: "/dev/nvme0n1p1",
        pknameMap: {},
        blkidRc: 2,
        blkidOut: "",
        wipefsRc: 0,
        wipefsOut: "",
        setupInstallStub: true,
      });
      const resNvmeParent = runScript(
        hNvmeParent.bundledEnroll,
        [
          "--boot-spec",
          specPath1,
          "--bootstrap-token-file",
          tokenPath1,
          "--profiles-root",
          join(hNvmeParent.stateDir, "profiles"),
          "--credentials-root",
          join(hNvmeParent.etcDir, "credentials"),
        ],
        hNvmeParent.env,
      );
      expect(resNvmeParent.status).not.toBe(0);
      expect(resNvmeParent.stderr).toMatch(/boot disk/iu);
      expectOnlyReadOnlyCalls(hNvmeParent.readCalls(), "Z10 nvme parent_whole_disk match");

      // 3. Standalone setup-host.sh saved-state-array refuses when profile disk is configured/required and not a block device.
      const hMissingProfile = createFakeHostEnv({
        blockDevices: ["/dev/nvme0n1", "/dev/sda", "/dev/sda1"],
        readlinkMap: {
          "/dev/nvme0n1": "/dev/nvme0n1",
          "/dev/sda": "/dev/sda",
          "/dev/sda1": "/dev/sda1",
        },
        bootSource: "/dev/sda1",
      });
      const resMissingProfile = runScript(setupScript, ["saved-state-array"], {
        ...hMissingProfile.env,
        OSP_PROFILE_DISK: poolProfileDiskDevicePath,
        OSP_REQUIRE_PROFILE_DISK: "1",
        OSP_LOCAL_SSDS: "/dev/nvme0n1",
      });
      expect(resMissingProfile.status).not.toBe(0);
      expect(resMissingProfile.stderr).toMatch(/profile disk.*block device/iu);
      expectOnlyReadOnlyCalls(
        hMissingProfile.readCalls(),
        "Z10 standalone saved-state-array missing profile disk",
      );
    });

    it("Z7: setup-host.sh boot waits a bounded time for the durable profile disk via the shared wait function", () => {
      const hostA = "ph_11111111-1111-4111-8111-111111111111";
      const labelA = hostProfileDiskLabel(hostA);
      const h = createFakeHostEnv({
        blockDeviceAppearsOnCheck: 2,
        blkidRc: 0,
        blkidOut: `DEVNAME=/dev/sdb\nLABEL=${labelA}\nTYPE=ext4\nUSAGE=filesystem`,
      });
      const res = runScript(setupScript, ["wait-profile-disk", poolProfileDiskDevicePath], {
        ...h.env,
        OSP_PROFILE_DISK_WAIT_SECONDS: "5",
      });
      expect(res.status, res.stderr).toBe(0);
      expect(h.readCalls().some((c) => c.cmd === "udevadm")).toBe(true);
    });

    it("Z4(c) + Z11: rendered download script rejects wrong SHA-256 before tar AND refuses any symlink inside the extracted bundle before running enroll-host.sh", () => {
      const extractDownloadScript = (userData: string): string => {
        const parsed = JSON.parse(userData.replace(/^#cloud-config\n/u, "")) as {
          write_files: Array<{ path: string; content: string }>;
        };
        const file = parsed.write_files.find((f) => f.path === "/root/opensteer-pool-download.sh");
        expect(file).toBeDefined();
        return file!.content;
      };

      // Build a real .tar.gz bundle whose enroll-host.sh writes a marker file if executed.
      const workDir = makeTempDir();
      const stageDir = join(workDir, "stage");
      const markerPath = join(workDir, "enroll-ran");
      mkdirSync(stageDir, { recursive: true });
      writeFileSync(
        join(stageDir, "enroll-host.sh"),
        `#!/usr/bin/env bash\necho ran > ${JSON.stringify(markerPath)}\n`,
        { mode: 0o755 },
      );
      writeFileSync(join(stageDir, "setup-host.sh"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });
      const goodBundle = join(workDir, "good-bundle.tar.gz");
      execFileSync("tar", ["-czf", goodBundle, "-C", stageDir, "enroll-host.sh", "setup-host.sh"]);

      // Z4(c): Wrong SHA-256 -> neither tar nor enroll-host.sh may run!
      const wrongHashUserData = renderPoolHostUserData(
        {
          hostId: BrowserPoolHostIdSchema.parse("ph_11111111-1111-4111-8111-111111111111"),
          generation: 1,
          accountOrigin: "https://account.example.test",
          installerUrl: "https://releases.example.test/pool-host-bundle.tar.gz",
          installerSha256: "b".repeat(64),
          bootstrapToken: "t".repeat(43),
          provisionerKey: ed25519SpkiBase64(),
          homeCidr: "10.40.0.0/20",
          provisionerCidr: "10.50.0.0/24",
          profileDiskDevice: poolProfileDiskDevicePath,
          everEnrolled: false,
          agentPort: 7310,
          adminPort: 7311,
          relayPort: 7312,
        },
        false,
      );
      const hWrongHash = createFakeHostEnv({ curlBundleFile: goodBundle });
      const tarLog = join(workDir, "tar-ran");
      writeExecutable(
        hWrongHash.binDir,
        "tar",
        `#!/usr/bin/env bash\necho tar >> ${JSON.stringify(tarLog)}\nexec /usr/bin/tar "$@"\n`,
      );
      const wrongScriptPath = join(workDir, "download-wrong-hash.sh");
      const rawWrongScript = extractDownloadScript(wrongHashUserData)
        .replaceAll("/root/opensteer-pool-bundle.", `${workDir}/bundle.`)
        .replaceAll("/root/opensteer-pool-bundle-dir.", `${workDir}/bundle-dir.`)
        .replaceAll("--one-file-system ", "");
      writeFileSync(wrongScriptPath, rawWrongScript, { mode: 0o700 });
      const wrongRes = runScript(wrongScriptPath, [], hWrongHash.env);
      expect(wrongRes.status).not.toBe(0);
      expect(existsSync(tarLog), "tar must NOT run when bundle SHA-256 mismatches").toBe(false);
      expect(existsSync(markerPath), "enroll-host.sh must NOT run on SHA-256 mismatch").toBe(false);

      // Z11: Bundle with matching SHA-256 that contains a symbolic link -> refused BEFORE enroll-host.sh runs!
      symlinkSync("/etc/passwd", join(stageDir, "evil-link"));
      const symlinkBundle = join(workDir, "symlink-bundle.tar.gz");
      execFileSync("tar", [
        "-czf",
        symlinkBundle,
        "-C",
        stageDir,
        "enroll-host.sh",
        "setup-host.sh",
        "evil-link",
      ]);
      const symlinkBundleSha = createHash("sha256")
        .update(readFileSync(symlinkBundle))
        .digest("hex");
      const symlinkUserData = renderPoolHostUserData(
        {
          hostId: BrowserPoolHostIdSchema.parse("ph_11111111-1111-4111-8111-111111111111"),
          generation: 1,
          accountOrigin: "https://account.example.test",
          installerUrl: "https://releases.example.test/pool-host-bundle.tar.gz",
          installerSha256: symlinkBundleSha,
          bootstrapToken: "t".repeat(43),
          provisionerKey: ed25519SpkiBase64(),
          homeCidr: "10.40.0.0/20",
          provisionerCidr: "10.50.0.0/24",
          profileDiskDevice: poolProfileDiskDevicePath,
          everEnrolled: false,
          agentPort: 7310,
          adminPort: 7311,
          relayPort: 7312,
        },
        false,
      );
      const hSymlink = createFakeHostEnv({ curlBundleFile: symlinkBundle });
      const symlinkScriptPath = join(workDir, "download-symlink.sh");
      const rawSymlinkScript = extractDownloadScript(symlinkUserData)
        .replaceAll("/root/opensteer-pool-bundle.", `${workDir}/sym-bundle.`)
        .replaceAll("/root/opensteer-pool-bundle-dir.", `${workDir}/sym-bundle-dir.`)
        .replaceAll("--one-file-system ", "");
      writeFileSync(symlinkScriptPath, rawSymlinkScript, { mode: 0o700 });
      const symlinkRes = runScript(symlinkScriptPath, [], hSymlink.env);
      expect(symlinkRes.status).not.toBe(0);
      expect(
        existsSync(markerPath),
        "enroll-host.sh must NOT run when bundle contains a symlink",
      ).toBe(false);
    });

    it("Z1 (step 1): failure between boot-complete and systemctl enable keeps bootstrap token and caches release-artifacts.json", async () => {
      const hostId = BrowserPoolHostIdSchema.parse("ph_11111111-1111-4111-8111-111111111111");
      const workDir = makeTempDir();
      const stageDir = join(workDir, "bundle-src");
      mkdirSync(stageDir, { recursive: true });
      writeFileSync(join(stageDir, "enroll-host.sh"), readFileSync(enrollScript, "utf8"), {
        mode: 0o755,
      });

      const h = createFakeHostEnv({
        blkidRc: 2,
        blkidOut: "",
        wipefsRc: 0,
        wipefsOut: "",
        systemctlRc: 1,
        setupInstallStub: true,
        bootEndpointFailsAfterComplete: true,
        metadataReadyFile: join(workDir, "ready-key"),
        curlBundleFile: join(workDir, "release.tar.gz"),
      });
      writeFileSync(join(stageDir, "setup-host.sh"), readFileSync(h.bundledSetup, "utf8"), {
        mode: 0o755,
      });
      const bundlePath = join(workDir, "release.tar.gz");
      execFileSync("tar", ["-czf", bundlePath, "-C", stageDir, "enroll-host.sh", "setup-host.sh"]);
      const bundleSha = createHash("sha256").update(readFileSync(bundlePath)).digest("hex");

      const specPath = join(workDir, "opensteer-pool-boot.json");
      const tokenPath = join(workDir, "opensteer-pool-bootstrap-token");
      const ciUserData = join(h.cloudInitDir, "user-data.txt");
      writeFileSync(ciUserData, "#cloud-config\nsecret-token", { mode: 0o600 });

      const userData = renderPoolHostUserData(
        {
          hostId,
          generation: 1,
          accountOrigin: "https://account.example.test",
          installerUrl: "https://releases.example.test/pool-host-bundle.tar.gz",
          installerSha256: bundleSha,
          bootstrapToken: "t".repeat(43),
          provisionerKey: ed25519SpkiBase64(),
          homeCidr: "10.40.0.0/20",
          provisionerCidr: "10.50.0.0/24",
          profileDiskDevice: poolProfileDiskDevicePath,
          everEnrolled: false,
          agentPort: 7310,
          adminPort: 7311,
          relayPort: 7312,
        },
        true,
      );
      const parsedCloudConfig = JSON.parse(userData.replace(/^#cloud-config\n/u, "")) as {
        write_files: Array<{ path: string; content: string }>;
      };
      const bootJson = parsedCloudConfig.write_files.find(
        (f) => f.path === "/root/opensteer-pool-boot.json",
      )!.content;
      const bootToken = parsedCloudConfig.write_files.find(
        (f) => f.path === "/root/opensteer-pool-bootstrap-token",
      )!.content;
      const downloadScriptContent = parsedCloudConfig.write_files
        .find((f) => f.path === "/root/opensteer-pool-download.sh")!
        .content.replaceAll("/root/opensteer-pool-boot.json", specPath)
        .replaceAll("/root/opensteer-pool-bootstrap-token", tokenPath)
        .replaceAll("/root/opensteer-pool-bundle.", `${workDir}/dl-bundle.`)
        .replaceAll("/root/opensteer-pool-bundle-dir.", `${workDir}/dl-dir.`)
        .replaceAll("--one-file-system ", "")
        .replace(
          `--setup-script "$bundle_dir/setup-host.sh"`,
          `--setup-script "$bundle_dir/setup-host.sh" --profiles-root ${JSON.stringify(join(h.stateDir, "profiles"))} --credentials-root ${JSON.stringify(join(h.etcDir, "credentials"))}`,
        );
      writeFileSync(specPath, bootJson, { mode: 0o600 });
      writeFileSync(tokenPath, bootToken, { mode: 0o600 });
      const downloadScriptPath = join(workDir, "download.sh");
      writeFileSync(downloadScriptPath, downloadScriptContent, { mode: 0o700 });

      const compute = new ComputeFake();
      const provider = compute.adapter();
      const signal = new AbortController().signal;
      await provider.ensurePoolProfileDisk(
        {
          hostId,
          diskName: "osp-disk-11111111-1111-4111-8111-111111111111",
          sizeGb: 500,
          diskType: "pd-ssd",
          requestId: randomUUID(),
        },
        signal,
      );
      const vm = await provider.createPoolHost(
        {
          id: hostId,
          generation: 1,
          machineType: "n2-standard-8",
          image: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64",
          bootDiskSizeGb: 40,
          profileDiskName: "osp-disk-11111111-1111-4111-8111-111111111111",
          localSsdCount: 1,
          userData,
          requestId: randomUUID(),
        },
        signal,
      );
      expect(await provider.updatePoolHostBootstrap(vm.id, false, signal)).toBe(true);
      const readyItem = [...compute.instances.values()][0]!.metadata.items.find(
        (i) => i.key === "opensteer-bootstrap-ready",
      );
      expect(readyItem?.value).toBe("1");
      writeFileSync(join(workDir, "ready-key"), readyItem!.value, "utf8");

      // Run 1: boot-complete succeeds, then systemctl enable --now fails -> token kept, artifacts cached.
      const run1 = runScript(downloadScriptPath, [], h.env);
      expect(run1.status).not.toBe(0);
      expect(existsSync(tokenPath)).toBe(true);
      expect(existsSync(ciUserData)).toBe(true);
      expect(existsSync(join(h.etcDir, "release-artifacts.json"))).toBe(true);
      expect(
        h
          .readCalls()
          .some((c) => c.cmd === "curl" && c.args.some((a) => a.includes("/boot-complete"))),
      ).toBe(true);
    });

    it("Z1 (step 2): after reconciler metadata scrub removes user-data and leaves opensteer-bootstrap-ready, rendered download script passes gate, skips /boot, starts services, and removes token + cloud-init", async () => {
      const hostId = BrowserPoolHostIdSchema.parse("ph_11111111-1111-4111-8111-111111111111");
      const workDir = makeTempDir();
      const stageDir = join(workDir, "bundle-src");
      mkdirSync(stageDir, { recursive: true });
      writeFileSync(join(stageDir, "enroll-host.sh"), readFileSync(enrollScript, "utf8"), {
        mode: 0o755,
      });

      const h = createFakeHostEnv({
        blkidRc: 0,
        blkidOut: `DEVNAME=/dev/sdb\nLABEL=${hostProfileDiskLabel(hostId)}\nTYPE=ext4\nUSAGE=filesystem`,
        wipefsRc: 0,
        wipefsOut: "0x438 ext4",
        systemctlRc: 0,
        setupInstallStub: true,
        alreadyMountedSource: "/dev/sdb",
        bootEndpointFailsAfterComplete: true,
        metadataReadyFile: join(workDir, "ready-key"),
        curlBundleFile: join(workDir, "release.tar.gz"),
      });
      writeFileSync(join(stageDir, "setup-host.sh"), readFileSync(h.bundledSetup, "utf8"), {
        mode: 0o755,
      });
      const bundlePath = join(workDir, "release.tar.gz");
      execFileSync("tar", ["-czf", bundlePath, "-C", stageDir, "enroll-host.sh", "setup-host.sh"]);
      const bundleSha = createHash("sha256").update(readFileSync(bundlePath)).digest("hex");

      // Exact state left by step 1 (boot-complete succeeded, release-artifacts.json cached, token kept):
      const fakeArtifactSha = createHash("sha256")
        .update("fake-artifact-content", "utf8")
        .digest("hex");
      writeFileSync(
        join(h.etcDir, "release-artifacts.json"),
        JSON.stringify({
          hostId,
          generation: 1,
          releaseVersion: "1.0.0",
          artifacts: {
            agentUrl: "https://releases.example.test/agent.mjs",
            agentSha256: fakeArtifactSha,
            relayUrl: "https://releases.example.test/relay.mjs",
            relaySha256: fakeArtifactSha,
            rootfsUrl: "https://releases.example.test/rootfs.ext4",
            rootfsSha256: fakeArtifactSha,
            kernelUrl: "https://releases.example.test/vmlinux",
            kernelSha256: fakeArtifactSha,
            egressUrl: "https://releases.example.test/egress.js",
            egressSha256: fakeArtifactSha,
          },
        }),
        { mode: 0o600 },
      );
      writeFileSync(join(h.root, "boot-complete-seen"), "1", "utf8");

      const specPath = join(workDir, "opensteer-pool-boot.json");
      const tokenPath = join(workDir, "opensteer-pool-bootstrap-token");
      const ciUserData = join(h.cloudInitDir, "user-data.txt");
      writeFileSync(ciUserData, "#cloud-config\nsecret-token", { mode: 0o600 });

      const userData = renderPoolHostUserData(
        {
          hostId,
          generation: 1,
          accountOrigin: "https://account.example.test",
          installerUrl: "https://releases.example.test/pool-host-bundle.tar.gz",
          installerSha256: bundleSha,
          bootstrapToken: "t".repeat(43),
          provisionerKey: ed25519SpkiBase64(),
          homeCidr: "10.40.0.0/20",
          provisionerCidr: "10.50.0.0/24",
          profileDiskDevice: poolProfileDiskDevicePath,
          everEnrolled: false,
          agentPort: 7310,
          adminPort: 7311,
          relayPort: 7312,
        },
        true,
      );
      const parsedCloudConfig = JSON.parse(userData.replace(/^#cloud-config\n/u, "")) as {
        write_files: Array<{ path: string; content: string }>;
      };
      const bootJson = parsedCloudConfig.write_files.find(
        (f) => f.path === "/root/opensteer-pool-boot.json",
      )!.content;
      const bootToken = parsedCloudConfig.write_files.find(
        (f) => f.path === "/root/opensteer-pool-bootstrap-token",
      )!.content;
      const downloadScriptContent = parsedCloudConfig.write_files
        .find((f) => f.path === "/root/opensteer-pool-download.sh")!
        .content.replaceAll("/root/opensteer-pool-boot.json", specPath)
        .replaceAll("/root/opensteer-pool-bootstrap-token", tokenPath)
        .replaceAll("/root/opensteer-pool-bundle.", `${workDir}/dl-bundle.`)
        .replaceAll("/root/opensteer-pool-bundle-dir.", `${workDir}/dl-dir.`)
        .replaceAll("--one-file-system ", "")
        .replace(
          `--setup-script "$bundle_dir/setup-host.sh"`,
          `--setup-script "$bundle_dir/setup-host.sh" --profiles-root ${JSON.stringify(join(h.stateDir, "profiles"))} --credentials-root ${JSON.stringify(join(h.etcDir, "credentials"))}`,
        );
      writeFileSync(specPath, bootJson, { mode: 0o600 });
      writeFileSync(tokenPath, bootToken, { mode: 0o600 });
      const downloadScriptPath = join(workDir, "download.sh");
      writeFileSync(downloadScriptPath, downloadScriptContent, { mode: 0o700 });

      // Wire real ComputeFake + GoogleCompute.updatePoolHostBootstrap to run the scrub and drive the metadata gate file!
      const compute = new ComputeFake();
      const provider = compute.adapter();
      const signal = new AbortController().signal;
      await provider.ensurePoolProfileDisk(
        {
          hostId,
          diskName: "osp-disk-11111111-1111-4111-8111-111111111111",
          sizeGb: 500,
          diskType: "pd-ssd",
          requestId: randomUUID(),
        },
        signal,
      );
      const vm = await provider.createPoolHost(
        {
          id: hostId,
          generation: 1,
          machineType: "n2-standard-8",
          image: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64",
          bootDiskSizeGb: 40,
          profileDiskName: "osp-disk-11111111-1111-4111-8111-111111111111",
          localSsdCount: 1,
          userData,
          requestId: randomUUID(),
        },
        signal,
      );
      expect(await provider.updatePoolHostBootstrap(vm.id, false, signal)).toBe(true);
      // Reconciler sees enrolled=true and runs real updatePoolHostBootstrap(vm.id, true) scrub!
      expect(await provider.updatePoolHostBootstrap(vm.id, true, signal)).toBe(true);
      const instanceAfterScrub = [...compute.instances.values()][0]!;
      expect(instanceAfterScrub.metadata.items.some((i) => i.key === "user-data")).toBe(false);
      const readyItem = instanceAfterScrub.metadata.items.find(
        (i) => i.key === "opensteer-bootstrap-ready",
      );
      expect(readyItem?.value).toBe("1");
      writeFileSync(join(workDir, "ready-key"), readyItem!.value, "utf8");

      // Re-run rendered download script -> MUST pass gate, reuse cached artifacts (0 /boot calls),
      // replay /boot-complete, enable+start services, and remove token + cloud-init!
      const run2 = runScript(downloadScriptPath, [], h.env);
      expect(run2.status, run2.stderr).toBe(0);
      expect(
        h.readCalls().filter((c) => c.cmd === "curl" && c.args.some((a) => a.endsWith("/boot"))),
      ).toHaveLength(0);
      expect(
        h
          .readCalls()
          .some((c) => c.cmd === "curl" && c.args.some((a) => a.includes("/boot-complete"))),
      ).toBe(true);
      expect(h.readCalls().some((c) => c.cmd === "systemctl" && c.args.includes("enable"))).toBe(
        true,
      );
      expect(existsSync(tokenPath)).toBe(false);
      expect(existsSync(ciUserData)).toBe(false);
    });

    it("Z1 (later window): crash after services start and before token removal + reconciler scrub still lets rendered download script pass gate and remove token + cloud-init", async () => {
      const hostId = BrowserPoolHostIdSchema.parse("ph_11111111-1111-4111-8111-111111111111");
      const workDir = makeTempDir();
      const stageDir = join(workDir, "bundle-src");
      mkdirSync(stageDir, { recursive: true });
      writeFileSync(join(stageDir, "enroll-host.sh"), readFileSync(enrollScript, "utf8"), {
        mode: 0o755,
      });

      const h = createFakeHostEnv({
        blkidRc: 0,
        blkidOut: `DEVNAME=/dev/sdb\nLABEL=${hostProfileDiskLabel(hostId)}\nTYPE=ext4\nUSAGE=filesystem`,
        wipefsRc: 0,
        wipefsOut: "0x438 ext4",
        systemctlRc: 0,
        setupInstallStub: true,
        alreadyMountedSource: "/dev/sdb",
        bootEndpointFailsAfterComplete: true,
        metadataReadyFile: join(workDir, "ready-key"),
        curlBundleFile: join(workDir, "release.tar.gz"),
      });
      writeFileSync(join(stageDir, "setup-host.sh"), readFileSync(h.bundledSetup, "utf8"), {
        mode: 0o755,
      });
      const bundlePath = join(workDir, "release.tar.gz");
      execFileSync("tar", ["-czf", bundlePath, "-C", stageDir, "enroll-host.sh", "setup-host.sh"]);
      const bundleSha = createHash("sha256").update(readFileSync(bundlePath)).digest("hex");

      // Simulate post-services-start state: cached artifacts + boot-complete already observed,
      // but token + cloud-init still exist on disk when the reconciler scrubs user-data.
      const fakeArtifactSha = createHash("sha256")
        .update("fake-artifact-content", "utf8")
        .digest("hex");
      writeFileSync(
        join(h.etcDir, "release-artifacts.json"),
        JSON.stringify({
          hostId,
          generation: 1,
          releaseVersion: "1.0.0",
          artifacts: {
            agentUrl: "https://releases.example.test/agent.mjs",
            agentSha256: fakeArtifactSha,
            relayUrl: "https://releases.example.test/relay.mjs",
            relaySha256: fakeArtifactSha,
            rootfsUrl: "https://releases.example.test/rootfs.ext4",
            rootfsSha256: fakeArtifactSha,
            kernelUrl: "https://releases.example.test/vmlinux",
            kernelSha256: fakeArtifactSha,
            egressUrl: "https://releases.example.test/egress.js",
            egressSha256: fakeArtifactSha,
          },
        }),
        { mode: 0o600 },
      );
      writeFileSync(join(h.root, "boot-complete-seen"), "1", "utf8");

      const specPath = join(workDir, "opensteer-pool-boot.json");
      const tokenPath = join(workDir, "opensteer-pool-bootstrap-token");
      const ciUserData = join(h.cloudInitDir, "user-data.txt");
      writeFileSync(ciUserData, "#cloud-config\nsecret-token", { mode: 0o600 });

      const userData = renderPoolHostUserData(
        {
          hostId,
          generation: 1,
          accountOrigin: "https://account.example.test",
          installerUrl: "https://releases.example.test/pool-host-bundle.tar.gz",
          installerSha256: bundleSha,
          bootstrapToken: "t".repeat(43),
          provisionerKey: ed25519SpkiBase64(),
          homeCidr: "10.40.0.0/20",
          provisionerCidr: "10.50.0.0/24",
          profileDiskDevice: poolProfileDiskDevicePath,
          everEnrolled: false,
          agentPort: 7310,
          adminPort: 7311,
          relayPort: 7312,
        },
        true,
      );
      const parsedCloudConfig = JSON.parse(userData.replace(/^#cloud-config\n/u, "")) as {
        write_files: Array<{ path: string; content: string }>;
      };
      const bootJson = parsedCloudConfig.write_files.find(
        (f) => f.path === "/root/opensteer-pool-boot.json",
      )!.content;
      const bootToken = parsedCloudConfig.write_files.find(
        (f) => f.path === "/root/opensteer-pool-bootstrap-token",
      )!.content;
      const downloadScriptContent = parsedCloudConfig.write_files
        .find((f) => f.path === "/root/opensteer-pool-download.sh")!
        .content.replaceAll("/root/opensteer-pool-boot.json", specPath)
        .replaceAll("/root/opensteer-pool-bootstrap-token", tokenPath)
        .replaceAll("/root/opensteer-pool-bundle.", `${workDir}/dl-bundle.`)
        .replaceAll("/root/opensteer-pool-bundle-dir.", `${workDir}/dl-dir.`)
        .replaceAll("--one-file-system ", "")
        .replace(
          `--setup-script "$bundle_dir/setup-host.sh"`,
          `--setup-script "$bundle_dir/setup-host.sh" --profiles-root ${JSON.stringify(join(h.stateDir, "profiles"))} --credentials-root ${JSON.stringify(join(h.etcDir, "credentials"))}`,
        );
      writeFileSync(specPath, bootJson, { mode: 0o600 });
      writeFileSync(tokenPath, bootToken, { mode: 0o600 });
      const downloadScriptPath = join(workDir, "download.sh");
      writeFileSync(downloadScriptPath, downloadScriptContent, { mode: 0o700 });

      const compute = new ComputeFake();
      const provider = compute.adapter();
      const signal = new AbortController().signal;
      await provider.ensurePoolProfileDisk(
        {
          hostId,
          diskName: "osp-disk-11111111-1111-4111-8111-111111111111",
          sizeGb: 500,
          diskType: "pd-ssd",
          requestId: randomUUID(),
        },
        signal,
      );
      const vm = await provider.createPoolHost(
        {
          id: hostId,
          generation: 1,
          machineType: "n2-standard-8",
          image: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64",
          bootDiskSizeGb: 40,
          profileDiskName: "osp-disk-11111111-1111-4111-8111-111111111111",
          localSsdCount: 1,
          userData,
          requestId: randomUUID(),
        },
        signal,
      );
      expect(await provider.updatePoolHostBootstrap(vm.id, false, signal)).toBe(true);
      expect(await provider.updatePoolHostBootstrap(vm.id, true, signal)).toBe(true);
      const instanceAfterScrub = [...compute.instances.values()][0]!;
      const readyItem = instanceAfterScrub.metadata.items.find(
        (i) => i.key === "opensteer-bootstrap-ready",
      );
      expect(readyItem?.value).toBe("1");
      writeFileSync(join(workDir, "ready-key"), readyItem!.value, "utf8");

      const rerun = runScript(downloadScriptPath, [], h.env);
      expect(rerun.status, rerun.stderr).toBe(0);
      expect(existsSync(tokenPath)).toBe(false);
      expect(existsSync(ciUserData)).toBe(false);
    });

    it("Y7: rejects control characters / newlines in boot-spec fields, refuses setup-host.sh outside the verified bundle, and pool-boot.ts extracts the hash-verified bundle", () => {
      const dir = makeTempDir();
      // Newline inside accountOrigin must be rejected (Python urlparse silently drops \n unless checked explicitly).
      const newlineSpec = join(dir, "newline-origin.json");
      writeFileSync(
        newlineSpec,
        JSON.stringify(
          makeBootSpec({ accountOrigin: "https://account.example.test\n/dev/nvme0n1" }),
        ),
        { mode: 0o600 },
      );
      const newlineRes = runEnroll([
        "render-agent-config",
        "--boot-spec",
        newlineSpec,
        "--relay-uid",
        "987",
      ]);
      expect(newlineRes.status).not.toBe(0);

      // enroll-host.sh refuses --setup-script outside its own bundle directory (never runs unverified /opt/opensteer-pool/setup-host.sh).
      const h = createFakeHostEnv();
      const specPath = join(dir, "spec.json");
      const tokenPath = join(dir, "tok");
      const outsideSetup = join(dir, "outside-setup.sh");
      writeFileSync(specPath, JSON.stringify(makeBootSpec({}, true)), { mode: 0o600 });
      writeFileSync(tokenPath, "t".repeat(43), { mode: 0o600 });
      writeFileSync(outsideSetup, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
      const outsideRes = runScript(
        h.bundledEnroll,
        [
          "--boot-spec",
          specPath,
          "--bootstrap-token-file",
          tokenPath,
          "--setup-script",
          outsideSetup,
        ],
        h.env,
      );
      expect(outsideRes.status).not.toBe(0);
      expect(outsideRes.stderr).toMatch(/bundle/iu);

      // pool-boot.ts extracts the hash-verified release bundle and runs enroll-host.sh + setup-host.sh from it.
      const userData = renderPoolHostUserData({
        hostId: BrowserPoolHostIdSchema.parse("ph_11111111-1111-4111-8111-111111111111"),
        generation: 1,
        accountOrigin: "https://account.example.test",
        installerUrl: "https://releases.example.test/pool-host-bundle.tar.gz",
        installerSha256: "a".repeat(64),
        bootstrapToken: "t".repeat(43),
        provisionerKey: ed25519SpkiBase64(),
        homeCidr: "10.40.0.0/20",
        provisionerCidr: "10.50.0.0/24",
        profileDiskDevice: poolProfileDiskDevicePath,
        everEnrolled: false,
        agentPort: 7310,
        adminPort: 7311,
        relayPort: 7312,
      });
      expect(userData).toContain("tar --no-same-owner --no-same-permissions -xzf");
      expect(userData).toContain("enroll-host.sh");
      expect(userData).toContain("setup-host.sh");
      expect(userData).toContain("--setup-script");
    });
  });

  describe("agent.json rendering and validation through the real pool-agent config loader", () => {
    it("renders an agent.json (mode 0600) that passes readAgentConfig() and refuseUnsupportedMode()", async () => {
      const dir = makeTempDir();
      const specPath = join(dir, "boot-spec.json");
      const outPath = join(dir, "agent.json");
      const spec = makeBootSpec();
      writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 });

      const res = runEnroll([
        "render-agent-config",
        "--boot-spec",
        specPath,
        "--relay-uid",
        "987",
        "--out",
        outPath,
      ]);
      expect(res.status, res.stderr).toBe(0);

      const loaded = await readAgentConfig(outPath);
      expect(() => refuseUnsupportedMode(loaded)).not.toThrow();
      expect(loaded.admin).toEqual({
        listen: { host: "0.0.0.0", port: 7311 },
        provisionerKey: spec.provisionerKey,
        hostId: spec.hostId,
        hostKeyFile: "/etc/opensteer-pool/host-key.pem",
      });
      expect(loaded.listen).toEqual({ host: "0.0.0.0", port: 7310 });
      expect(loaded.driver.requireEgressUpstream).toBe(true);
      expect(loaded.driver.egress.accountOrigin).toBe("https://account.example.test");
      expect(loaded.driver.profilesRoot).toBe("/var/lib/opensteer-pool/profiles");
      expect(loaded.driver.profilesMount).toEqual({
        label: hostProfileDiskLabel(String(spec.hostId)),
      });
      expect(loaded.driver.credentialsRoot).toBe("/etc/opensteer-pool/credentials");
      expect(loaded.driver.guestMode).toBe("runtime");
      expect(loaded.driver.network.relayUid).toBe(987);
      // Z9: No privateResolvers (never open 169.254.169.254:53 to a slot proxy); rendered nftables
      // rules must drop every port of 169.254.169.254 (via @blocked4 169.254.0.0/16).
      expect(loaded.driver.network.privateResolvers).toEqual([]);
      expect(resolverFile(loaded.driver.network)).not.toContain("169.254.169.254");
      const slotNft = egressRuleset(loaded.driver.network, ["10.40.0.21"]);
      const hostNft = hostRuleset(loaded.driver.network, ["10.40.0.21"]);
      for (const rules of [slotNft, hostNft]) {
        expect(rules).not.toContain("169.254.169.254");
        expect(rules).toContain("169.254.0.0/16");
        expect(rules.indexOf("ip daddr @blocked4 counter drop")).toBeGreaterThan(-1);
        expect(rules.indexOf("ip daddr @blocked4 counter drop")).toBeLessThan(
          rules.indexOf("meta l4proto tcp accept"),
        );
      }

      chmodSync(outPath, 0o644);
      await expect(readAgentConfig(outPath)).rejects.toThrow(/readable by other users/u);
    });

    it("rejects malformed boot specs (missing everEnrolled, non-https origin, bad key, colliding ports, non-fixed device)", () => {
      const dir = makeTempDir();
      const invalidCases: Array<{ name: string; spec: Record<string, unknown> }> = [
        { name: "missing everEnrolled", spec: makeBootSpec({ everEnrolled: undefined }) },
        {
          name: "http accountOrigin",
          spec: makeBootSpec({ accountOrigin: "http://account.example.test" }),
        },
        {
          name: "accountOrigin with path",
          spec: makeBootSpec({ accountOrigin: "https://account.example.test/v1" }),
        },
        {
          name: "non-Ed25519 provisionerKey",
          spec: makeBootSpec({ provisionerKey: Buffer.alloc(44, 1).toString("base64") }),
        },
        {
          name: "colliding ports",
          spec: makeBootSpec({ agentPort: 7310, adminPort: 7310, relayPort: 7312 }),
        },
        {
          name: "invalid CIDR",
          spec: makeBootSpec({ homeCidr: "not-a-cidr" }),
        },
        {
          name: "non-fixed profileDiskDevice",
          spec: makeBootSpec({ profileDiskDevice: "/dev/nvme0n2" }),
        },
      ];

      for (const testCase of invalidCases) {
        const specPath = join(dir, `${testCase.name.replaceAll(/[^a-z0-9]/gi, "-")}.json`);
        writeFileSync(specPath, JSON.stringify(testCase.spec), { mode: 0o600 });
        const res = runEnroll([
          "render-agent-config",
          "--boot-spec",
          specPath,
          "--relay-uid",
          "987",
        ]);
        expect(res.status, `expected failure for ${testCase.name}`).not.toBe(0);
      }
    });
  });

  describe("Y6 Account egress normalisation parity with packages/browser-runtime-core/src/browser-egress-upstream.ts", () => {
    it("normalises https://h, https://h:443, and https://h:8443/ to canonical https://host:port accepted by parseBrowserEgressUpstreamUrl, and refuses everything else", () => {
      const urlCases: Array<{ url: string; expectedNormalised?: string }> = [
        { url: "https://proxy.example.test", expectedNormalised: "https://proxy.example.test:443" },
        {
          url: "https://proxy.example.test/",
          expectedNormalised: "https://proxy.example.test:443",
        },
        {
          url: "https://proxy.example.test:443",
          expectedNormalised: "https://proxy.example.test:443",
        },
        {
          url: "https://proxy.example.test:443/",
          expectedNormalised: "https://proxy.example.test:443",
        },
        {
          url: "https://proxy.example.test:8443",
          expectedNormalised: "https://proxy.example.test:8443",
        },
        {
          url: "https://proxy.example.test:8443/",
          expectedNormalised: "https://proxy.example.test:8443",
        },
        { url: "https://203.0.113.10:3128", expectedNormalised: "https://203.0.113.10:3128" },
        { url: "https://[2001:db8::1]", expectedNormalised: "https://[2001:db8::1]:443" },
        { url: "https://[2001:db8::1]:8443/", expectedNormalised: "https://[2001:db8::1]:8443" },
        {
          url: "  https://proxy.example.test:8443  ",
          expectedNormalised: "https://proxy.example.test:8443",
        },
        { url: "" },
        { url: "   " },
        { url: "https://proxy.example.test:0" },
        { url: "https://proxy.example.test:65536" },
        { url: "https://proxy.example.test:8443//" },
        { url: "https://proxy.example.test:8443/path" },
        { url: "https://proxy.example.test:8443?foo=bar" },
        { url: "https://proxy.example.test:8443#frag" },
        { url: "https://user:pass@proxy.example.test:8443" },
        { url: "http://proxy.example.test:8443" },
        { url: "socks5://proxy.example.test:1080" },
        { url: "https://proxy.example.test:abc" },
        { url: `https://${"a".repeat(1000)}.example.test:8443` },
        { url: `https://${"a".repeat(1010)}.example.test` },
      ];

      for (const { url, expectedNormalised } of urlCases) {
        const accountRes = validateEgressUpstreamUrl(url);
        if (expectedNormalised !== undefined) {
          expect(accountRes, `expected valid normalisation for ${JSON.stringify(url)}`).toEqual({
            ok: true,
            value: expectedNormalised,
          });
          if (accountRes.ok) {
            expect(
              parseBrowserEgressUpstreamUrl(accountRes.value),
              `runtime validator must accept normalised ${accountRes.value}`,
            ).toBeDefined();
          }
        } else {
          expect(accountRes.ok, `expected rejection for ${JSON.stringify(url)}`).toBe(false);
          expect(parseBrowserEgressUpstreamUrl(url)).toBeUndefined();
        }
      }
    });

    it("matches browserEgressCredentialWritable on every valid and invalid username and password case", () => {
      const credentialCases: Array<{
        kind: "username" | "password";
        value: string;
        expectedValid: boolean;
      }> = [
        { kind: "username", value: "egress-user", expectedValid: true },
        { kind: "username", value: "u".repeat(1024), expectedValid: true },
        { kind: "password", value: "p@ss:word! #1", expectedValid: true },
        { kind: "password", value: "p".repeat(1024), expectedValid: true },
        { kind: "username", value: "", expectedValid: false },
        { kind: "username", value: "   ", expectedValid: false },
        { kind: "username", value: "user:name", expectedValid: false },
        { kind: "username", value: "u".repeat(1025), expectedValid: false },
        { kind: "username", value: "user\nname", expectedValid: false },
        { kind: "username", value: "user\tname", expectedValid: false },
        { kind: "username", value: "user\x7fname", expectedValid: false },
        { kind: "password", value: "", expectedValid: false },
        { kind: "password", value: "   ", expectedValid: false },
        { kind: "password", value: "p".repeat(1025), expectedValid: false },
        { kind: "password", value: "pass\rword", expectedValid: false },
        { kind: "password", value: "pass\nword", expectedValid: false },
        { kind: "password", value: "pass\x00word", expectedValid: false },
        { kind: "password", value: "pass\x7fword", expectedValid: false },
      ];

      for (const { kind, value, expectedValid } of credentialCases) {
        const accountRes = validateEgressCredential(value, kind);
        const runtimeRes = browserEgressCredentialWritable(value, kind);
        expect(
          accountRes.ok,
          `account ${kind} validation mismatch for ${JSON.stringify(value)}`,
        ).toBe(expectedValid);
        expect(runtimeRes, `runtime ${kind} validation mismatch for ${JSON.stringify(value)}`).toBe(
          expectedValid,
        );
      }
    });
  });
});
