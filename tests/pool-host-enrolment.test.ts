import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  appendFileSync,
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
    const stdout = execFileSync("/bin/bash", [scriptPath, ...args], {
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

const pregeneratedHostKey = (() => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
})();
const pregeneratedRelayKey = (() => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
})();

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

// J9: Every device-writing command family is placed in binDir as a recording, failing stand-in
// (`mkfs.ext4` and `wipefs` have dedicated recording stand-ins below).
const DEVICE_WRITING_COMMANDS = [
  "dd",
  "sgdisk",
  "sfdisk",
  "parted",
  "e2fsck",
  "xfs_repair",
  "fsck",
  "fsck.ext2",
  "fsck.ext3",
  "fsck.ext4",
  "fsck.xfs",
  "fsck.btrfs",
  "fsck.vfat",
  "fsck.fat",
  "fsck.msdos",
  "fsck.minix",
  "fsck.cramfs",
  "tune2fs",
  "e2label",
  "blkdiscard",
  "fstrim",
  "mkfs",
  "mkfs.ext2",
  "mkfs.ext3",
  "mkfs.xfs",
  "mkfs.btrfs",
  "mkfs.vfat",
  "mkfs.fat",
  "mkfs.msdos",
  "mkfs.ntfs",
  "mkfs.f2fs",
  "mkfs.exfat",
  "mkfs.minix",
  "mkfs.cramfs",
  "mkfs.bfs",
  "mke2fs",
  "mkswap",
  "shred",
  "nvme",
  "blockdev",
  "wipe",
  "dmsetup",
  "pvcreate",
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

    const bashEnvFile = join(root, "bash-env.sh");
    const bashEnvBlocks: string[] = [
      // Single BASH_ENV function suite: records every command identically while avoiding ~25 fresh
      // executable spawns per test (and macOS first-exec scan latency on temp-dir scripts).
      `_osp_log_call() {
  local _cmd=$1; shift
  local _l='{"cmd":"'"$_cmd"'","args":[' _f=1 _a
  for _a in "$@"; do
    _a=\${_a//\\\\/\\\\\\\\}
    _a=\${_a//\\"/\\\\\\"}
    if [[ $_f == 1 ]]; then _f=0; else _l+=,; fi
    _l+="\\"$_a\\""
  done
  printf '%s]}\\n' "$_l" >> ${JSON.stringify(callsFile)}
}`,
      `bash() { /bin/bash "$@"; }`,
      `id() {
  _osp_log_call id "$@"
  if [[ \${1:-} == -u && \${2:-} == opensteer-pool-relay ]]; then echo 987; else echo 0; fi
}`,
      `chown() { _osp_log_call chown "$@"; return 0; }`,
      `udevadm() { _osp_log_call udevadm "$@"; return 0; }`,
      `uname() {
  _osp_log_call uname "$@"
  if [[ " $* " == *" -m "* ]]; then echo x86_64; else echo Linux; fi
}`,
      `install() {
  _osp_log_call install "$@"
  local _mode="" _is_dir=0 _d
  local -a _args=()
  while (( $# > 0 )); do
    case "$1" in
      -d) _is_dir=1; shift ;;
      -m) _mode="$2"; shift 2 ;;
      -o|-g) shift 2 ;;
      *) _args+=("$1"); shift ;;
    esac
  done
  if (( _is_dir )); then
    if (( \${#_args[@]} > 0 )); then
      for _d in "\${_args[@]}"; do
        /bin/mkdir -p "$_d"
        if [[ -n $_mode ]]; then /bin/chmod "$_mode" "$_d"; fi
      done
    fi
  elif (( \${#_args[@]} == 2 )); then
    /bin/cp "\${_args[0]}" "\${_args[1]}"
    if [[ -n $_mode ]]; then /bin/chmod "$_mode" "\${_args[1]}"; fi
  fi
  return 0
}`,
    ];
    // Z4(b): Every command that can write a device has a recording stand-in that returns non-zero.
    for (const writer of DEVICE_WRITING_COMMANDS) {
      bashEnvBlocks.push(`${writer}() { _osp_log_call ${writer} "$@"; return 1; }`);
    }
    for (const noop of ["nft", "sysctl", "swapoff", "modprobe"]) {
      bashEnvBlocks.push(`${noop}() { _osp_log_call ${noop} "$@"; return 0; }`);
    }
    if (opts.realInstallHostEnv) {
      for (const pkgCmd of ["apt-get", "getent", "useradd"]) {
        bashEnvBlocks.push(`${pkgCmd}() { _osp_log_call ${pkgCmd} "$@"; return 0; }`);
      }
      // Provide pre-staged dummy binaries and matching sha256sum so real `setup-host.sh install`
      // runs all the way through install_packages -> install_binaries -> host_key -> save_host_env
      // -> install_units -> mount_profile_disk -> saved_state_array without needing internet.
      mkdirSync(join(optDir, "bin"), { recursive: true });
      mkdirSync(join(optDir, "download"), { recursive: true });
      mkdirSync(join(optDir, "node/bin"), { recursive: true });
      writeFileSync(join(optDir, "download/firecracker.tgz"), "fake-fc");
      writeFileSync(join(optDir, "download/node.tar.xz"), "fake-node");
      writeExecutable(join(optDir, "node/bin"), "node", `#!/bin/bash\necho v24.15.0\n`);
      bashEnvBlocks.push(`tar() {
  _osp_log_call tar "$@"
  local _dest=""
  while (( $# > 0 )); do
    if [[ $1 == -C ]]; then _dest="$2"; shift 2; else shift; fi
  done
  if [[ -n $_dest ]]; then
    /bin/mkdir -p "$_dest/release-v1.18.0-x86_64" "$_dest/bin"
    printf 'fake-fc' > "$_dest/release-v1.18.0-x86_64/firecracker-v1.18.0-x86_64"
    printf 'fake-jailer' > "$_dest/release-v1.18.0-x86_64/jailer-v1.18.0-x86_64"
    printf '#!/bin/bash\\necho v24.15.0\\n' > "$_dest/bin/node"
    /bin/chmod +x "$_dest/bin/node"
  fi
  return 0
}`);
    }
    bashEnvBlocks.push(`uuidgen() {
  _osp_log_call uuidgen "$@"
  echo 11111111-2222-4333-8444-555555555555
}`);
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
      .map(([k, v]) => `    ${JSON.stringify(k)}) echo ${JSON.stringify(v)}; return 0 ;;`)
      .join("\n");
    const pknameCases = Object.entries(
      opts.pknameMap ?? {
        "/dev/sda1": "sda",
        "/dev/nvme0n1p1": "nvme0n1",
      },
    )
      .map(([k, v]) => `    ${JSON.stringify(k)}) echo ${JSON.stringify(v)}; return 0 ;;`)
      .join("\n");
    const profilesRootPath = join(stateDir, "profiles");
    const bootSrc = opts.bootSource ?? "/dev/sda1";

    bashEnvBlocks.push(`readlink() {
  _osp_log_call readlink "$@"
  local _target="\${!#}" _dir _base
  case "$_target" in
${readlinkCases}
  esac
  if [[ -e "$_target" ]]; then
    _dir="\${_target%/*}"; _base="\${_target##*/}"
    if [[ $_dir == "$_target" ]]; then _dir="."; fi
    (cd "$_dir" && printf '%s/%s\\n' "$(pwd -P)" "$_base")
  else
    printf '%s\\n' "$_target"
  fi
}`);
    const statChecksFile = join(root, "stat-checks");
    const appearsOnCheck = opts.blockDeviceAppearsOnCheck ?? 0;
    bashEnvBlocks.push(`stat() {
  _osp_log_call stat "$@"
  local _fmt="" _target="\${!#}" _n _d
  while (( $# > 0 )); do
    if [[ $1 == -c ]]; then _fmt="$2"; shift 2; else shift; fi
  done
  if [[ $_fmt == "%F" ]]; then
    if (( ${appearsOnCheck} > 0 )) && [[ $_target == ${JSON.stringify(poolProfileDiskDevicePath)} ]]; then
      _n=0
      if [[ -f ${JSON.stringify(statChecksFile)} ]]; then _n=$(< ${JSON.stringify(statChecksFile)}); fi
      _n=$(( _n + 1 ))
      printf '%s' "$_n" > ${JSON.stringify(statChecksFile)}
      if (( _n < ${appearsOnCheck} )); then return 1; fi
    fi
    for _d in ${blockDevicesSet}; do
      if [[ $_target == "$_d" ]]; then echo "block special file"; return 0; fi
    done
    if [[ -f $_target ]]; then echo "regular file"; return 0; fi
    if [[ -d $_target ]]; then echo "directory"; return 0; fi
    return 1
  fi
  if [[ $_fmt == "%u" ]]; then echo 0; return 0; fi
  if [[ $_fmt == "%a" ]]; then
    ${process.platform === "darwin" ? `/usr/bin/stat -f '%Lp' "$_target"` : `/usr/bin/stat -c '%a' "$_target"`}
    return $?
  fi
  return 1
}`);
    bashEnvBlocks.push(`lsblk() {
  _osp_log_call lsblk "$@"
  local _target="\${!#}"
  case "$_target" in
${pknameCases}
  esac
  return 0
}`);
    bashEnvBlocks.push(`mountpoint() {
  _osp_log_call mountpoint "$@"
  local _target="\${!#}"
  if [[ $_target == ${JSON.stringify(profilesRootPath)} && -f ${JSON.stringify(mountedFile)} ]]; then return 0; fi
  return 1
}`);
    bashEnvBlocks.push(`findmnt() {
  _osp_log_call findmnt "$@"
  local _col="" _target="\${!#}"
  while (( $# > 0 )); do
    if [[ $1 == -o ]]; then _col="$2"; shift 2; else shift; fi
  done
  if [[ $_target == "/" && $_col == SOURCE ]]; then
    if [[ -n ${JSON.stringify(bootSrc)} ]]; then echo ${JSON.stringify(bootSrc)}; return 0; fi
    return 1
  fi
  if [[ $_target == ${JSON.stringify(profilesRootPath)} && -f ${JSON.stringify(mountedFile)} ]]; then
    if [[ $_col == SOURCE ]]; then printf '%s\\n' "$(< ${JSON.stringify(mountedFile)})"; return 0; fi
    if [[ $_col == OPTIONS ]]; then echo "rw,nosuid,nodev,noatime"; return 0; fi
  fi
  return 1
}`);
    const bootCompleteFlag = join(root, "boot-complete-seen");
    const fakeArtifactSha = createHash("sha256")
      .update("fake-artifact-content", "utf8")
      .digest("hex");
    bashEnvBlocks.push(`sha256sum() {
  _osp_log_call sha256sum "$@"
  local _expected _path _actual _p _h _
  if [[ " $* " == *" -c "* ]]; then
    if [[ ${opts.realInstallHostEnv ? "1" : "0"} == "1" ]]; then
      return 0
    fi
    while read -r _expected _path; do
      if [[ -z $_expected ]]; then continue; fi
      ${process.platform === "darwin" ? `read -r _actual _ < <(/usr/bin/openssl dgst -sha256 -r "$_path")` : `read -r _actual _ < <(/usr/bin/sha256sum "$_path")`}
      if [[ $_actual != "$_expected" ]]; then return 1; fi
    done
    return 0
  fi
  for _p in "$@"; do
    ${process.platform === "darwin" ? `read -r _h _ < <(/usr/bin/openssl dgst -sha256 -r "$_p")` : `read -r _h _ < <(/usr/bin/sha256sum "$_p")`}
    printf '%s  %s\\n' "$_h" "$_p"
  done
}`);
    bashEnvBlocks.push(`curl() {
  _osp_log_call curl "$@"
  local _out_file="" _write_code=0 _url="\${!#}" _host_id
  while (( $# > 0 )); do
    case "$1" in
      -o|--output) _out_file="$2"; shift 2 ;;
      -w) _write_code=1; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ $_url == *"/computeMetadata/v1/instance/attributes/opensteer-bootstrap-ready"* ]]; then
    if [[ -n ${JSON.stringify(opts.metadataReadyFile ?? "")} && -f ${JSON.stringify(opts.metadataReadyFile ?? "")} ]]; then
      printf '%s' "$(< ${JSON.stringify(opts.metadataReadyFile ?? "")})"
      return 0
    fi
    return 22
  fi
  if [[ $_url == *"/pool-host-bundle.tar.gz"* && -n ${JSON.stringify(opts.curlBundleFile ?? "")} ]]; then
    /bin/cp ${JSON.stringify(opts.curlBundleFile ?? "")} "$_out_file"
    if (( _write_code )); then printf '200'; fi
    return 0
  fi
  if [[ $_url == *"/boot-complete"* ]]; then
    : > ${JSON.stringify(bootCompleteFlag)}
    if [[ -n $_out_file ]]; then printf '{"completed":true}' > "$_out_file"; fi
    if (( _write_code )); then printf '200'; fi
    return 0
  fi
  if [[ $_url == *"/boot" ]]; then
    if [[ ${opts.bootEndpointFailsAfterComplete ? "1" : "0"} == "1" && -f ${JSON.stringify(bootCompleteFlag)} ]]; then
      if [[ -n $_out_file ]]; then printf '{"error":"already enrolled"}' > "$_out_file"; fi
      if (( _write_code )); then printf '401'; fi
      return 0
    fi
    _host_id=\${_url%/boot}
    _host_id=\${_host_id##*/}
    if [[ -n $_out_file ]]; then
      cat > "$_out_file" <<JSON
{"hostId":"$_host_id","generation":1,"profileDiskName":"osp-disk-test","release":{"version":"1.0.0","installerUrl":"https://releases.example.test/pool-host-bundle.tar.gz","installerSha256":"${"a".repeat(64)}","artifacts":{"agentUrl":"https://releases.example.test/agent.mjs","agentSha256":"${fakeArtifactSha}","relayUrl":"https://releases.example.test/relay.mjs","relaySha256":"${fakeArtifactSha}","rootfsUrl":"https://releases.example.test/rootfs.ext4","rootfsSha256":"${fakeArtifactSha}","kernelUrl":"https://releases.example.test/vmlinux","kernelSha256":"${fakeArtifactSha}","egressUrl":"https://releases.example.test/egress.js","egressSha256":"${fakeArtifactSha}"}}}
JSON
    fi
    if (( _write_code )); then printf '200'; fi
    return 0
  fi
  if [[ -n $_out_file ]]; then printf 'fake-artifact-content' > "$_out_file"; fi
  if (( _write_code )); then printf '200'; fi
  return 0
}`);

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

    bashEnvBlocks.push(`blkid() {
  _osp_log_call blkid "$@"
  local _n _out_f _rc_f
  _n=$(< ${JSON.stringify(blkidCallsFile)})
  _n=$(( _n + 1 ))
  printf '%s' "$_n" > ${JSON.stringify(blkidCallsFile)}
  if (( _n == 1 )); then
    _out_f=${JSON.stringify(blkidOut1File)}; _rc_f=${JSON.stringify(blkidRc1File)}
  else
    _out_f=${JSON.stringify(blkidOut2File)}; _rc_f=${JSON.stringify(blkidRc2File)}
  fi
  if [[ -s $_out_f ]]; then
    printf '%s\\n' "$(< "$_out_f")"
  fi
  return "$(< "$_rc_f")"
}`);
    bashEnvBlocks.push(`wipefs() {
  _osp_log_call wipefs "$@"
  local _n _out_f _rc_f
  if [[ " $* " == *" -n "* ]]; then
    _n=$(< ${JSON.stringify(wipefsCallsFile)})
    _n=$(( _n + 1 ))
    printf '%s' "$_n" > ${JSON.stringify(wipefsCallsFile)}
    if (( _n == 1 )); then
      _out_f=${JSON.stringify(wipefsOut1File)}; _rc_f=${JSON.stringify(wipefsRc1File)}
    else
      _out_f=${JSON.stringify(wipefsOut2File)}; _rc_f=${JSON.stringify(wipefsRc2File)}
    fi
    if [[ -s $_out_f ]]; then
      printf '%s\\n' "$(< "$_out_f")"
    fi
    return "$(< "$_rc_f")"
  fi
  return 0
}`);
    bashEnvBlocks.push(`mount() {
  _osp_log_call mount "$@"
  if (( ${opts.mountRc ?? 0} != 0 )); then return ${opts.mountRc ?? 0}; fi
  local -a _args=("$@")
  local _src="\${_args[\${#_args[@]}-2]:-}"
  local _target="\${_args[\${#_args[@]}-1]:-}"
  if [[ $_target == ${JSON.stringify(profilesRootPath)} ]]; then
    printf '%s' "$_src" > ${JSON.stringify(mountedFile)}
  fi
  return 0
}`);
    const tokenFileCheck = opts.tokenFile ?? "";
    bashEnvBlocks.push(`systemctl() {
  local _tok_exists="false" _l='{"cmd":"systemctl","args":[' _f=1 _a
  if [[ -n ${JSON.stringify(tokenFileCheck)} && -e ${JSON.stringify(tokenFileCheck)} ]]; then _tok_exists="true"; fi
  for _a in "$@"; do
    _a=\${_a//\\\\/\\\\\\\\}; _a=\${_a//\\"/\\\\\\"}
    if [[ $_f == 1 ]]; then _f=0; else _l+=,; fi
    _l+="\\"$_a\\""
  done
  if [[ -n ${JSON.stringify(tokenFileCheck)} ]]; then
    printf '%s],"tokenExistsAtCall":%s}\\n' "$_l" "$_tok_exists" >> ${JSON.stringify(callsFile)}
  else
    printf '%s]}\\n' "$_l" >> ${JSON.stringify(callsFile)}
  fi
  return "$(< ${JSON.stringify(systemctlRcFile)})"
}`);
    bashEnvBlocks.push(`mkfs.ext4() {
  local _stdin_data="" _stdin_esc _l='{"cmd":"mkfs.ext4","args":[' _f=1 _a _rc=${opts.mkfsRc ?? 0} _label="" _prev="" _dev
  IFS= read -r -d '' _stdin_data || true
  _stdin_esc=\${_stdin_data//\\\\/\\\\\\\\}
  _stdin_esc=\${_stdin_esc//\\"/\\\\\\"}
  _stdin_esc=\${_stdin_esc//$'\\n'/\\\\n}
  _stdin_esc=\${_stdin_esc//$'\\r'/\\\\r}
  for _a in "$@"; do
    _a=\${_a//\\\\/\\\\\\\\}; _a=\${_a//\\"/\\\\\\"}
    if [[ $_f == 1 ]]; then _f=0; else _l+=,; fi
    _l+="\\"$_a\\""
  done
  printf '%s],"stdin":"%s"}\\n' "$_l" "$_stdin_esc" >> ${JSON.stringify(callsFile)}
  if (( _rc == 0 )); then
    for _a in "$@"; do
      if [[ $_prev == -L ]]; then _label="$_a"; fi
      _prev="$_a"
    done
    _dev="\${!#}"
    printf 'DEVNAME=%s\\nLABEL=%s\\nTYPE=ext4\\nUSAGE=filesystem\\n' "$_dev" "$_label" > ${JSON.stringify(blkidOut2File)}
    printf '0' > ${JSON.stringify(blkidRc2File)}
  fi
  return "$_rc"
}`);
    writeFileSync(bashEnvFile, `${bashEnvBlocks.join("\n")}\n`, "utf8");
    const override = (name: string, body: string) => {
      appendFileSync(bashEnvFile, `${name}() {\n${body}\n}\n`, "utf8");
    };

    // Copy enroll-host.sh (and optionally real or stub setup-host.sh) into bundleDir.
    const bundledEnroll = join(bundleDir, "enroll-host.sh");
    writeFileSync(bundledEnroll, readFileSync(enrollScript, "utf8"), { mode: 0o755 });
    const bundledSetup = join(bundleDir, "setup-host.sh");
    if (opts.setupInstallStub) {
      // Stub setup-host.sh that delegates verify-profiles-mount / boot to real checks, while making `install` fast & key-generating.
      const stubKeysDir = join(root, "stub-keys");
      mkdirSync(stubKeysDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(stubKeysDir, "host-key.pem"), pregeneratedHostKey.privatePem, {
        mode: 0o600,
      });
      writeFileSync(join(stubKeysDir, "host-key.pub"), pregeneratedHostKey.publicPem, {
        mode: 0o644,
      });
      writeFileSync(join(stubKeysDir, "relay-key.pem"), pregeneratedRelayKey.privatePem, {
        mode: 0o600,
      });
      writeFileSync(join(stubKeysDir, "relay-key.pub"), pregeneratedRelayKey.publicPem, {
        mode: 0o644,
      });
      writeExecutable(
        bundleDir,
        "setup-host.sh",
        `#!/bin/bash
set -euo pipefail
case "\${1:-}" in
  install)
    install -d -m 0700 "${etcDir}" "${relayEtcDir}" "${optDir}" "${stateDir}/images"
    cp "$0" "${optDir}/setup-host.sh"
    chmod 0755 "${optDir}/setup-host.sh"
    if [[ ! -f "${etcDir}/host-key.pem" ]]; then
      cp "${stubKeysDir}/host-key.pem" "${etcDir}/host-key.pem"
      cp "${stubKeysDir}/host-key.pub" "${etcDir}/host-key.pub"
      chmod 0600 "${etcDir}/host-key.pem"
    fi
    if [[ ! -f "${etcDir}/relay-key.pem" ]]; then
      cp "${stubKeysDir}/relay-key.pem" "${etcDir}/relay-key.pem"
      cp "${stubKeysDir}/relay-key.pub" "${relayEtcDir}/relay-key.pub"
      chmod 0600 "${etcDir}/relay-key.pem"
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
    exec /bin/bash "${setupScript}" verify-profiles-mount
    ;;
  verify-profiles-mount|wait-profile-disk|parent-whole-disk)
    exec /bin/bash "${setupScript}" "$@"
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
      BASH_ENV: bashEnvFile,
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
      override,
      mountedFile,
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

    it("PH4: checks systemctl is-active --quiet for both units before scrubbing the bootstrap token and cloud-init user-data", () => {
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
        systemctlRc: 0,
        tokenFile: tokenPath,
        setupInstallStub: true,
      });
      // Type=simple units can exit immediately after `systemctl enable --now` returns 0:
      // `enable --now` succeeds (rc 0), while `is-active` reports inactive/failed (rc 3) for the relay unit.
      h.override(
        "systemctl",
        `  _osp_log_call systemctl "$@"
  if [[ \${1:-} == is-active ]]; then
    for _arg in "$@"; do
      if [[ $_arg == opensteer-pool-relay.service ]]; then return 3; fi
    done
  fi
  return 0`,
      );
      const ciUserData = join(h.cloudInitDir, "user-data.txt");
      writeFileSync(ciUserData, "#cloud-config\nsecret-token", { mode: 0o600 });

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
      const calls = h.readCalls().filter((c) => c.cmd === "systemctl");
      expect(calls.some((c) => c.args.includes("is-active"))).toBe(true);
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
      // J3(c): setup-host.sh keeps /dev/kvm, cgroup, SMT, and CPU-vuln paths as plain constants;
      // rewrite those 4 constant lines in a scratch copy to run `install` on macOS.
      const macSetupCopy = join(h.root, "setup-host-z4b.sh");
      writeFileSync(
        macSetupCopy,
        readFileSync(setupScript, "utf8")
          .replace(
            /^readonly KVM_DEV=.*$/mu,
            `readonly KVM_DEV=${JSON.stringify(h.env.OSP_KVM_DEV!)}`,
          )
          .replace(
            /^readonly CGROUP_CONTROLLERS=.*$/mu,
            `readonly CGROUP_CONTROLLERS=${JSON.stringify(h.env.OSP_CGROUP_CONTROLLERS!)}`,
          )
          .replace(
            /^readonly SMT_ACTIVE=.*$/mu,
            `readonly SMT_ACTIVE=${JSON.stringify(h.env.OSP_SMT_ACTIVE!)}`,
          )
          .replace(
            /^readonly CPU_VULNS_DIR=.*$/mu,
            `readonly CPU_VULNS_DIR=${JSON.stringify(h.env.OSP_CPU_VULNS_DIR!)}`,
          )
          .replace("[[ -c $KVM_DEV ]]", "[[ -e $KVM_DEV ]]"),
        { mode: 0o755 },
      );
      h.override(
        "rm",
        `  local -a _clean=()
  local _a
  for _a in "$@"; do if [[ $_a != --one-file-system ]]; then _clean+=("$_a"); fi; done
  if (( \${#_clean[@]} > 0 )); then /bin/rm "\${_clean[@]}"; fi`,
      );
      h.override("nproc", "  echo 8");
      const res = runScript(macSetupCopy, ["install"], {
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

    it("J2 + J6: setup-host.sh boot waits bounded by elapsed time for the profile disk, mounts when it appears, and refuses with no mount when it never appears", () => {
      const hostA = "ph_11111111-1111-4111-8111-111111111111";
      const labelA = hostProfileDiskLabel(hostA);

      const prepareBootTest = (
        h: ReturnType<typeof createFakeHostEnv>,
        mutateMountToImmediate = false,
      ): string => {
        const fakeSys = join(h.root, "fake-sys");
        const fakeEtc = join(h.root, "fake-etc");
        mkdirSync(join(fakeSys, "thp"), { recursive: true });
        mkdirSync(join(fakeSys, "ksm"), { recursive: true });
        mkdirSync(join(fakeEtc, "sysctl.d"), { recursive: true });
        mkdirSync(join(fakeEtc, "systemd/coredump.conf.d"), { recursive: true });
        mkdirSync(join(fakeEtc, "systemd/system.conf.d"), { recursive: true });
        writeFileSync(join(fakeSys, "thp/enabled"), "[madvise]\n");
        writeFileSync(join(fakeSys, "thp/defrag"), "[madvise]\n");
        writeFileSync(join(fakeEtc, "fstab"), "# test fstab\n");
        writeFileSync(join(fakeEtc, "nftables.conf"), "#!/usr/sbin/nft -f\n");

        // Write root-owned 0600 host.env just like save_host_env does.
        writeFileSync(
          join(h.etcDir, "host.env"),
          [
            `OSP_LOCAL_SSDS=/dev/null/none`,
            `OSP_HOME_CIDR=10.40.0.0/20`,
            `OSP_PROVISIONER_CIDR=10.50.0.0/24`,
            `OSP_AGENT_PORT=7310`,
            `OSP_ADMIN_PORT=7311`,
            `OSP_RELAY_PORT=7312`,
            `OSP_PROFILES_ROOT=${join(h.stateDir, "profiles")}`,
            `OSP_EGRESS_SLICE_MIB=1536`,
            `OSP_SKIP_DEFAULT_KERNEL=1`,
            `OSP_REQUIRE_PROFILE_DISK=1`,
            `OSP_PROFILE_DISK=${poolProfileDiskDevicePath}`,
            `OSP_PROFILE_DISK_LABEL=${labelA}`,
            "",
          ].join("\n"),
          { mode: 0o600 },
        );

        // Make saved_state_array see $ARRAY already mounted (we test mount_profile_disk + boot path here).
        h.override(
          "mountpoint",
          `  _osp_log_call mountpoint "$@"
  local _target="\${!#}"
  if [[ $_target == ${JSON.stringify(h.arrayDir)} ]]; then return 0; fi
  if [[ $_target == ${JSON.stringify(join(h.stateDir, "profiles"))} && -f ${JSON.stringify(h.mountedFile)} ]]; then return 0; fi
  return 1`,
        );
        // Handle `sed -i` cleanly across macOS BSD sed vs GNU sed in kernel_settings.
        if (process.platform === "darwin") {
          h.override(
            "sed",
            `  if [[ \${1:-} == -i ]]; then shift; /usr/bin/sed -i '' "$@"; return $?; fi
  /usr/bin/sed "$@"`,
          );
        }

        let text = readFileSync(setupScript, "utf8")
          .replace(
            /^readonly KVM_DEV=.*$/mu,
            `readonly KVM_DEV=${JSON.stringify(join(fakeSys, "kvm"))}`,
          )
          .replace(
            /^readonly CGROUP_CONTROLLERS=.*$/mu,
            `readonly CGROUP_CONTROLLERS=${JSON.stringify(join(fakeSys, "cgroup.controllers"))}`,
          )
          .replace(
            /^readonly SMT_ACTIVE=.*$/mu,
            `readonly SMT_ACTIVE=${JSON.stringify(join(fakeSys, "smt-active"))}`,
          )
          .replace(
            /^readonly CPU_VULNS_DIR=.*$/mu,
            `readonly CPU_VULNS_DIR=${JSON.stringify(join(fakeSys, "vulns"))}`,
          )
          .replace("[[ -c $KVM_DEV ]]", "[[ -e $KVM_DEV ]]")
          .replaceAll("/sys/kernel/mm/transparent_hugepage", join(fakeSys, "thp"))
          .replaceAll("/sys/kernel/mm/ksm", join(fakeSys, "ksm"))
          .replaceAll("/etc/fstab", join(fakeEtc, "fstab"))
          .replaceAll("/etc/sysctl.d", join(fakeEtc, "sysctl.d"))
          .replaceAll("/etc/systemd/coredump.conf.d", join(fakeEtc, "systemd/coredump.conf.d"))
          .replaceAll("/etc/systemd/system.conf.d", join(fakeEtc, "systemd/system.conf.d"))
          .replaceAll("/etc/nftables.conf", join(fakeEtc, "nftables.conf"))
          .replace(
            "    boot)\n        require_host\n        mount_profile_disk 0\n        kernel_settings\n        host_firewall\n        saved_state_array\n        stage_images",
            "    boot)\n        require_host\n        mount_profile_disk 0\n        kernel_settings\n        host_firewall\n        stage_images",
          );

        if (mutateMountToImmediate) {
          text = text.replace(
            '    wait_for_profile_disk "$OSP_PROFILE_DISK"',
            '    is_block_device "$OSP_PROFILE_DISK" || die "durable profile disk $OSP_PROFILE_DISK is not present"',
          );
        }

        const copyPath = join(
          h.root,
          mutateMountToImmediate ? "setup-host-boot-mutated.sh" : "setup-host-boot.sh",
        );
        writeFileSync(copyPath, text, { mode: 0o755 });
        return copyPath;
      };

      // Case 1: device appears on the 2nd check -> `setup-host.sh boot` succeeds and mounts the disk.
      const hAppears = createFakeHostEnv({
        blockDeviceAppearsOnCheck: 2,
        blkidRc: 0,
        blkidOut: `DEVNAME=/dev/sdb\nLABEL=${labelA}\nTYPE=ext4\nUSAGE=filesystem`,
        realInstallHostEnv: true,
      });
      const bootCopy = prepareBootTest(hAppears);
      const resAppears = runScript(bootCopy, ["boot"], {
        ...hAppears.env,
        OSP_PROFILE_DISK_WAIT_SECONDS: "1",
        OSP_PROFILE_DISK_POLL_SECONDS: "0.02",
      });
      expect(resAppears.status, resAppears.stderr).toBe(0);
      const appearsCalls = hAppears.readCalls();
      expect(appearsCalls.some((c) => c.cmd === "udevadm")).toBe(true);
      expect(
        appearsCalls.some(
          (c) =>
            c.cmd === "mount" &&
            c.args.includes("/dev/sdb") &&
            c.args.includes(join(hAppears.stateDir, "profiles")),
        ),
        `expected mount call for durable profile disk in boot path, got: ${JSON.stringify(appearsCalls)}`,
      ).toBe(true);

      // J2 mutation check (on scratch copy): replacing wait_for_profile_disk with immediate is_block_device fails Case 1!
      const hMutated = createFakeHostEnv({
        blockDeviceAppearsOnCheck: 2,
        blkidRc: 0,
        blkidOut: `DEVNAME=/dev/sdb\nLABEL=${labelA}\nTYPE=ext4\nUSAGE=filesystem`,
        realInstallHostEnv: true,
      });
      const mutatedCopy = prepareBootTest(hMutated, true);
      const resMutated = runScript(mutatedCopy, ["boot"], {
        ...hMutated.env,
        OSP_PROFILE_DISK_WAIT_SECONDS: "1",
        OSP_PROFILE_DISK_POLL_SECONDS: "0.02",
      });
      expect(resMutated.status).not.toBe(0);
      expect(hMutated.readCalls().some((c) => c.cmd === "mount")).toBe(false);

      // Case 2 (J2 + J6): device NEVER appears, OSP_PROFILE_DISK_WAIT_SECONDS=0.2, POLL=0.05 with a 0.1s udevadm settle ->
      // bounded by elapsed time (does not multiply into 4+ iterations), non-zero exit, NO mount call.
      const hNever = createFakeHostEnv({
        blockDeviceAppearsOnCheck: 9999,
        blkidRc: 2,
        blkidOut: "",
        realInstallHostEnv: true,
      });
      // Replace udevadm with a 0.1s-slow stand-in to prove the wait is bounded by elapsed wall time (J6).
      hNever.override(
        "udevadm",
        `  _osp_log_call udevadm "$@"
  sleep 0.1
  return 0`,
      );
      const bootNeverCopy = prepareBootTest(hNever);
      const t0 = Date.now();
      const resNever = runScript(bootNeverCopy, ["boot"], {
        ...hNever.env,
        OSP_TEST_CALLS: join(hNever.root, "calls.jsonl"),
        OSP_PROFILE_DISK_WAIT_SECONDS: "0.2",
        OSP_PROFILE_DISK_POLL_SECONDS: "0.05",
      });
      const elapsedMs = Date.now() - t0;
      expect(resNever.status).not.toBe(0);
      expect(resNever.stderr).toMatch(
        /did not appear as a block device after \d+(?:\.\d+)?s \(limit 0\.2s\)/u,
      );
      expect(
        elapsedMs,
        `wait must be bounded by elapsed time (~0.2s), took ${elapsedMs}ms`,
      ).toBeLessThan(900);
      expect(
        hNever.readCalls().some((c) => c.cmd === "mount"),
        "must not attempt mount when durable profile disk never appears",
      ).toBe(false);
    });

    it("real-host proof: setup-host.sh boot never calls systemctl daemon-reexec (which severs D-Bus during systemctl enable --now), while install re-execs only when systemd drop-ins change", () => {
      const labelA = hostProfileDiskLabel("ph_11111111-1111-4111-8111-111111111111");
      const makeKernelSettingsHarness = () => {
        const h = createFakeHostEnv({
          blockDeviceAppearsOnCheck: 1,
          blkidRc: 0,
          blkidOut: `DEVNAME=/dev/sdb\nLABEL=${labelA}\nTYPE=ext4\nUSAGE=filesystem`,
          realInstallHostEnv: true,
        });
        const fakeSys = join(h.root, "sys");
        const fakeEtc = join(h.root, "etc");
        mkdirSync(join(fakeSys, "vulns"), { recursive: true });
        writeFileSync(join(fakeSys, "kvm"), "");
        writeFileSync(join(fakeSys, "cgroup.controllers"), "cpu memory pids\n");
        writeFileSync(join(fakeSys, "smt-active"), "0\n");
        mkdirSync(join(fakeSys, "thp"), { recursive: true });
        mkdirSync(join(fakeSys, "ksm"), { recursive: true });
        mkdirSync(join(fakeEtc, "sysctl.d"), { recursive: true });
        mkdirSync(join(fakeEtc, "systemd/coredump.conf.d"), { recursive: true });
        mkdirSync(join(fakeEtc, "systemd/system.conf.d"), { recursive: true });
        writeFileSync(join(fakeSys, "thp/enabled"), "[madvise]\n");
        writeFileSync(join(fakeSys, "thp/defrag"), "[madvise]\n");
        writeFileSync(join(fakeEtc, "fstab"), "# test fstab\n");
        writeFileSync(join(fakeEtc, "nftables.conf"), "#!/usr/sbin/nft -f\n");

        writeFileSync(
          join(h.etcDir, "host.env"),
          [
            `OSP_LOCAL_SSDS=/dev/null/none`,
            `OSP_HOME_CIDR=10.40.0.0/20`,
            `OSP_PROVISIONER_CIDR=10.50.0.0/24`,
            `OSP_AGENT_PORT=7310`,
            `OSP_ADMIN_PORT=7311`,
            `OSP_RELAY_PORT=7312`,
            `OSP_PROFILES_ROOT=${join(h.stateDir, "profiles")}`,
            `OSP_EGRESS_SLICE_MIB=1536`,
            `OSP_SKIP_DEFAULT_KERNEL=1`,
            `OSP_REQUIRE_PROFILE_DISK=1`,
            `OSP_PROFILE_DISK=${poolProfileDiskDevicePath}`,
            `OSP_PROFILE_DISK_LABEL=${labelA}`,
            "",
          ].join("\n"),
          { mode: 0o600 },
        );

        h.override(
          "mountpoint",
          `  _osp_log_call mountpoint "$@"
  local _target="\${!#}"
  if [[ $_target == ${JSON.stringify(h.arrayDir)} ]]; then return 0; fi
  if [[ $_target == ${JSON.stringify(join(h.stateDir, "profiles"))} && -f ${JSON.stringify(h.mountedFile)} ]]; then return 0; fi
  return 1`,
        );
        if (process.platform === "darwin") {
          h.override(
            "sed",
            `  if [[ \${1:-} == -i ]]; then shift; /usr/bin/sed -i '' "$@"; return $?; fi
  /usr/bin/sed "$@"`,
          );
        }

        const text = readFileSync(setupScript, "utf8")
          .replace(
            /^readonly KVM_DEV=.*$/mu,
            `readonly KVM_DEV=${JSON.stringify(join(fakeSys, "kvm"))}`,
          )
          .replace(
            /^readonly CGROUP_CONTROLLERS=.*$/mu,
            `readonly CGROUP_CONTROLLERS=${JSON.stringify(join(fakeSys, "cgroup.controllers"))}`,
          )
          .replace(
            /^readonly SMT_ACTIVE=.*$/mu,
            `readonly SMT_ACTIVE=${JSON.stringify(join(fakeSys, "smt-active"))}`,
          )
          .replace(
            /^readonly CPU_VULNS_DIR=.*$/mu,
            `readonly CPU_VULNS_DIR=${JSON.stringify(join(fakeSys, "vulns"))}`,
          )
          .replace("[[ -c $KVM_DEV ]]", "[[ -e $KVM_DEV ]]")
          .replaceAll("/sys/kernel/mm/transparent_hugepage", join(fakeSys, "thp"))
          .replaceAll("/sys/kernel/mm/ksm", join(fakeSys, "ksm"))
          .replaceAll("/etc/fstab", join(fakeEtc, "fstab"))
          .replaceAll("/etc/sysctl.d", join(fakeEtc, "sysctl.d"))
          .replaceAll("/etc/systemd/coredump.conf.d", join(fakeEtc, "systemd/coredump.conf.d"))
          .replaceAll("/etc/systemd/system.conf.d", join(fakeEtc, "systemd/system.conf.d"))
          .replaceAll("/etc/nftables.conf", join(fakeEtc, "nftables.conf"))
          .replace(
            "    check)\n        check\n        ;;",
            "    check)\n        check\n        ;;\n    test-install-kernel-settings)\n        CMD=install\n        kernel_settings\n        ;;",
          );
        const copyPath = join(h.root, "setup-host-reexec.sh");
        writeFileSync(copyPath, text, { mode: 0o755 });
        return { h, copyPath, fakeEtc };
      };

      // 1. `setup-host.sh boot` writes the systemd drop-ins but must NEVER run `systemctl daemon-reexec`.
      const bootHarness = makeKernelSettingsHarness();
      const bootRes = runScript(bootHarness.copyPath, ["boot"], bootHarness.h.env);
      expect(bootRes.status, bootRes.stderr).toBe(0);
      expect(
        readFileSync(
          join(bootHarness.fakeEtc, "systemd/system.conf.d/opensteer-pool.conf"),
          "utf8",
        ),
      ).toContain("DefaultLimitCORE=0");
      expect(
        bootHarness.h
          .readCalls()
          .some((c) => c.cmd === "systemctl" && c.args.includes("daemon-reexec")),
        "setup-host.sh boot must not call systemctl daemon-reexec",
      ).toBe(false);

      // 2. `setup-host.sh install` calls `systemctl daemon-reexec` once when drop-ins change, and
      //    does not re-exec again on an idempotent re-run when the files are unchanged.
      const installHarness = makeKernelSettingsHarness();
      const firstInstall = runScript(
        installHarness.copyPath,
        ["test-install-kernel-settings"],
        installHarness.h.env,
      );
      expect(firstInstall.status, firstInstall.stderr).toBe(0);
      const reexecCountAfterFirst = installHarness.h
        .readCalls()
        .filter((c) => c.cmd === "systemctl" && c.args.includes("daemon-reexec")).length;
      expect(reexecCountAfterFirst).toBe(1);

      const secondInstall = runScript(
        installHarness.copyPath,
        ["test-install-kernel-settings"],
        installHarness.h.env,
      );
      expect(secondInstall.status, secondInstall.stderr).toBe(0);
      const reexecCountAfterSecond = installHarness.h
        .readCalls()
        .filter((c) => c.cmd === "systemctl" && c.args.includes("daemon-reexec")).length;
      expect(reexecCountAfterSecond).toBe(1);
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
        `#!/bin/bash\necho ran > ${JSON.stringify(markerPath)}\n`,
        { mode: 0o755 },
      );
      writeFileSync(join(stageDir, "setup-host.sh"), "#!/bin/bash\nexit 0\n", {
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
      hWrongHash.override(
        "tar",
        `  echo tar >> ${JSON.stringify(tarLog)}
  /usr/bin/tar "$@"`,
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

      // J10: If `find` fails with empty stdout, the download script must refuse the bundle!
      const goodBundleSha = createHash("sha256").update(readFileSync(goodBundle)).digest("hex");
      const findFailUserData = renderPoolHostUserData(
        {
          hostId: BrowserPoolHostIdSchema.parse("ph_11111111-1111-4111-8111-111111111111"),
          generation: 1,
          accountOrigin: "https://account.example.test",
          installerUrl: "https://releases.example.test/pool-host-bundle.tar.gz",
          installerSha256: goodBundleSha,
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
      const hFindFail = createFakeHostEnv({ curlBundleFile: goodBundle });
      hFindFail.override("find", "  return 1");
      const findFailScriptPath = join(workDir, "download-find-fail.sh");
      const rawFindFailScript = extractDownloadScript(findFailUserData)
        .replaceAll("/root/opensteer-pool-bundle.", `${workDir}/find-bundle.`)
        .replaceAll("/root/opensteer-pool-bundle-dir.", `${workDir}/find-bundle-dir.`)
        .replaceAll("--one-file-system ", "");
      writeFileSync(findFailScriptPath, rawFindFailScript, { mode: 0o700 });
      const findFailRes = runScript(findFailScriptPath, [], hFindFail.env);
      expect(findFailRes.status).not.toBe(0);
      expect(existsSync(markerPath), "enroll-host.sh must NOT run when find exits non-zero").toBe(
        false,
      );
    });

    it("J3(c): real setup-host.sh ignores OSP_KVM_DEV/OSP_SMT_ACTIVE/OSP_CPU_VULNS_DIR env vars and reads real host paths", () => {
      const hostA = "ph_11111111-1111-4111-8111-111111111111";
      const labelA = hostProfileDiskLabel(hostA);
      const hEnvBypass = createFakeHostEnv({
        blkidRc: 0,
        blkidOut: `DEVNAME=/dev/sdb\nLABEL=${labelA}\nTYPE=ext4\nUSAGE=filesystem`,
        realInstallHostEnv: true,
        setupInstallStub: false,
      });
      const envBypassRes = runScript(setupScript, ["install"], {
        ...hEnvBypass.env,
        OSP_PROFILE_DISK: poolProfileDiskDevicePath,
        OSP_PROFILE_DISK_LABEL: labelA,
        OSP_REQUIRE_PROFILE_DISK: "1",
        OSP_PROFILES_ROOT: join(hEnvBypass.stateDir, "profiles"),
        OSP_SKIP_DEFAULT_KERNEL: "1",
      });
      expect(envBypassRes.status).not.toBe(0);
      expect(envBypassRes.stderr).toMatch(/\/dev\/kvm is missing/u);
      expect(
        hEnvBypass.readCalls().some((c) => c.cmd === "apt-get"),
        "real setup-host.sh must fail in require_host before install_packages when env vars try to spoof host paths",
      ).toBe(false);
    });

    it("J3(a): setup-host.sh install passes --one-file-system to all 3 rm calls in install_binaries", () => {
      const hostA = "ph_11111111-1111-4111-8111-111111111111";
      const labelA = hostProfileDiskLabel(hostA);
      const hRm = createFakeHostEnv({
        blkidRc: 0,
        blkidOut: `DEVNAME=/dev/sdb\nLABEL=${labelA}\nTYPE=ext4\nUSAGE=filesystem`,
        realInstallHostEnv: true,
        setupInstallStub: false,
      });
      const copyPath = join(hRm.root, "setup-host-rm.sh");
      writeFileSync(
        copyPath,
        readFileSync(setupScript, "utf8")
          .replace(
            /^readonly KVM_DEV=.*$/mu,
            `readonly KVM_DEV=${JSON.stringify(hRm.env.OSP_KVM_DEV!)}`,
          )
          .replace(
            /^readonly CGROUP_CONTROLLERS=.*$/mu,
            `readonly CGROUP_CONTROLLERS=${JSON.stringify(hRm.env.OSP_CGROUP_CONTROLLERS!)}`,
          )
          .replace(
            /^readonly SMT_ACTIVE=.*$/mu,
            `readonly SMT_ACTIVE=${JSON.stringify(hRm.env.OSP_SMT_ACTIVE!)}`,
          )
          .replace(
            /^readonly CPU_VULNS_DIR=.*$/mu,
            `readonly CPU_VULNS_DIR=${JSON.stringify(hRm.env.OSP_CPU_VULNS_DIR!)}`,
          )
          .replace("[[ -c $KVM_DEV ]]", "[[ -e $KVM_DEV ]]"),
        { mode: 0o755 },
      );
      // Remove pre-staged node binary so install_binaries runs the node unpack branch (hitting all 3 rm calls).
      execFileSync("/bin/rm", ["-rf", join(hRm.optDir, "node")]);
      // Install a recording rm stand-in that strips --one-file-system before invoking /bin/rm.
      hRm.override(
        "rm",
        `  _osp_log_call rm "$@"
  local -a _clean=()
  local _a
  for _a in "$@"; do if [[ $_a != --one-file-system ]]; then _clean+=("$_a"); fi; done
  if (( \${#_clean[@]} > 0 )); then /bin/rm "\${_clean[@]}"; fi`,
      );
      hRm.override("nproc", "  echo 8");
      runScript(copyPath, ["install"], {
        ...hRm.env,
        OSP_TEST_CALLS: join(hRm.root, "calls.jsonl"),
        OSP_PROFILE_DISK: poolProfileDiskDevicePath,
        OSP_PROFILE_DISK_LABEL: labelA,
        OSP_REQUIRE_PROFILE_DISK: "1",
        OSP_PROFILES_ROOT: join(hRm.stateDir, "profiles"),
        OSP_SKIP_DEFAULT_KERNEL: "1",
      });
      const rmCalls = hRm.readCalls().filter((c) => c.cmd === "rm");
      const oneFsCalls = rmCalls.filter((c) => c.args.includes("--one-file-system"));
      expect(
        oneFsCalls.length,
        `expected all 3 install_binaries rm calls to pass --one-file-system, got: ${JSON.stringify(rmCalls)}`,
      ).toBeGreaterThanOrEqual(3);
      expect(oneFsCalls.some((c) => c.args.some((a) => a.endsWith("/node.new")))).toBe(true);
      expect(oneFsCalls.some((c) => c.args.some((a) => a.endsWith("/node")))).toBe(true);
    });

    it("J3(b): setup-host.sh install refuses with a plain message when nproc is missing or fails", () => {
      const hostA = "ph_11111111-1111-4111-8111-111111111111";
      const labelA = hostProfileDiskLabel(hostA);
      const hNoNproc = createFakeHostEnv({
        blkidRc: 0,
        blkidOut: `DEVNAME=/dev/sdb\nLABEL=${labelA}\nTYPE=ext4\nUSAGE=filesystem`,
        realInstallHostEnv: true,
        setupInstallStub: false,
      });
      const copyPath = join(hNoNproc.root, "setup-host-j3b.sh");
      writeFileSync(
        copyPath,
        readFileSync(setupScript, "utf8")
          .replace(
            /^readonly KVM_DEV=.*$/mu,
            `readonly KVM_DEV=${JSON.stringify(hNoNproc.env.OSP_KVM_DEV!)}`,
          )
          .replace(
            /^readonly CGROUP_CONTROLLERS=.*$/mu,
            `readonly CGROUP_CONTROLLERS=${JSON.stringify(hNoNproc.env.OSP_CGROUP_CONTROLLERS!)}`,
          )
          .replace(
            /^readonly SMT_ACTIVE=.*$/mu,
            `readonly SMT_ACTIVE=${JSON.stringify(hNoNproc.env.OSP_SMT_ACTIVE!)}`,
          )
          .replace(
            /^readonly CPU_VULNS_DIR=.*$/mu,
            `readonly CPU_VULNS_DIR=${JSON.stringify(hNoNproc.env.OSP_CPU_VULNS_DIR!)}`,
          )
          .replace("[[ -c $KVM_DEV ]]", "[[ -e $KVM_DEV ]]"),
        { mode: 0o755 },
      );
      hNoNproc.override(
        "rm",
        `  local -a _clean=()
  local _a
  for _a in "$@"; do if [[ $_a != --one-file-system ]]; then _clean+=("$_a"); fi; done
  if (( \${#_clean[@]} > 0 )); then /bin/rm "\${_clean[@]}"; fi`,
      );
      hNoNproc.override("nproc", "  return 127");
      const noNprocRes = runScript(copyPath, ["install"], {
        ...hNoNproc.env,
        OSP_PROFILE_DISK: poolProfileDiskDevicePath,
        OSP_PROFILE_DISK_LABEL: labelA,
        OSP_REQUIRE_PROFILE_DISK: "1",
        OSP_PROFILES_ROOT: join(hNoNproc.stateDir, "profiles"),
        OSP_SKIP_DEFAULT_KERNEL: "1",
      });
      expect(noNprocRes.status).not.toBe(0);
      expect(existsSync(join(hNoNproc.env.OSP_SYSTEMD_DIR!, "opensteer-pool-egress.slice"))).toBe(
        false,
      );
      expect(noNprocRes.stderr).toMatch(/nproc failed or is missing/u);
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
      writeFileSync(outsideSetup, "#!/bin/bash\nexit 0\n", { mode: 0o755 });
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
