import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
import {
  poolProfileDiskDevicePath,
  renderPoolHostUserData,
} from "../apps/home-provisioner/src/pool-boot.js";
import { readAgentConfig, refuseUnsupportedMode } from "../apps/pool-agent/src/config.js";
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
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("bash", [scriptPath, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...envOverrides },
      stdio: ["ignore", "pipe", "pipe"],
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
  readonly readlinkMap?: Record<string, string>;
  readonly bootSource?: string;
  readonly pknameMap?: Record<string, string>;
  readonly tokenFile?: string;
  readonly alreadyMountedSource?: string;
  readonly setupInstallStub?: boolean;
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
    const stateJsonFile = join(root, "fake-state.json");
    const mountedFile = join(root, "mounted-source");
    if (opts.alreadyMountedSource) {
      writeFileSync(mountedFile, opts.alreadyMountedSource, "utf8");
    }
    writeFileSync(
      stateJsonFile,
      JSON.stringify({
        blkidRc: opts.blkidRc ?? 2,
        blkidOut: opts.blkidOut ?? "",
        secondBlkidRc: opts.secondBlkidRc ?? opts.blkidRc ?? 2,
        secondBlkidOut: opts.secondBlkidOut ?? opts.blkidOut ?? "",
        blkidCalls: 0,
        wipefsRc: opts.wipefsRc ?? 0,
        wipefsOut: opts.wipefsOut ?? "",
        secondWipefsRc: opts.secondWipefsRc ?? opts.wipefsRc ?? 0,
        secondWipefsOut: opts.secondWipefsOut ?? opts.wipefsOut ?? "",
        wipefsProbeCalls: 0,
        mkfsRc: opts.mkfsRc ?? 0,
        mountRc: opts.mountRc ?? 0,
        systemctlRc: opts.systemctlRc ?? 0,
        blockDevices: opts.blockDevices ?? [
          poolProfileDiskDevicePath,
          "/dev/sdb",
          "/dev/nvme0n1",
          "/dev/sda",
          "/dev/sda1",
        ],
        readlinkMap: opts.readlinkMap ?? {
          [poolProfileDiskDevicePath]: "/dev/sdb",
          "/dev/sdb": "/dev/sdb",
          "/dev/nvme0n1": "/dev/nvme0n1",
          "/dev/sda": "/dev/sda",
          "/dev/sda1": "/dev/sda1",
        },
        bootSource: opts.bootSource ?? "/dev/sda1",
        pknameMap: opts.pknameMap ?? {
          "/dev/sda1": "sda",
          "/dev/nvme0n1p1": "nvme0n1",
        },
        tokenFile: opts.tokenFile ?? "",
        profilesRoot: join(stateDir, "profiles"),
      }),
      "utf8",
    );

    const recorderPy = join(root, "fake-cmd.py");
    writeFileSync(
      recorderPy,
      `#!/usr/bin/env python3
import hashlib, json, os, subprocess, sys

cmd = sys.argv[1]
args = sys.argv[2:]
state_path = ${JSON.stringify(stateJsonFile)}
calls_path = ${JSON.stringify(callsFile)}
mounted_path = ${JSON.stringify(mountedFile)}

with open(state_path, "r", encoding="utf-8") as fh:
    state = json.load(fh)

entry = {"cmd": cmd, "args": args}
if cmd == "mkfs.ext4":
    data = sys.stdin.read()
    entry["stdin"] = data
if cmd == "systemctl" and state.get("tokenFile"):
    entry["tokenExistsAtCall"] = os.path.exists(state["tokenFile"])

with open(calls_path, "a", encoding="utf-8") as fh:
    fh.write(json.dumps(entry) + "\\n")

if cmd == "id":
    if args == ["-u"]:
        print("0")
        sys.exit(0)
    if args == ["-u", "opensteer-pool-relay"]:
        print("987")
        sys.exit(0)
    print("0")
    sys.exit(0)

if cmd == "stat":
    # Support -c %u, -c %a, -L -c %F
    follow = "-L" in args
    fmt = None
    target = args[-1]
    for i, a in enumerate(args):
        if a == "-c" and i + 1 < len(args):
            fmt = args[i + 1]
    if fmt == "%F":
        if target in state["blockDevices"]:
            print("block special file")
            sys.exit(0)
        if os.path.exists(target):
            print("regular file" if os.path.isfile(target) else "directory")
            sys.exit(0)
        sys.exit(1)
    if fmt == "%u":
        print("0")
        sys.exit(0)
    if fmt == "%a":
        st = os.stat(target) if follow else os.lstat(target)
        print(oct(st.st_mode & 0o777)[2:])
        sys.exit(0)
    sys.exit(1)

if cmd == "readlink":
    target = args[-1]
    if target in state["readlinkMap"]:
        print(state["readlinkMap"][target])
        sys.exit(0)
    print(os.path.realpath(target))
    sys.exit(0)

if cmd == "udevadm":
    sys.exit(0)

if cmd == "blkid":
    state["blkidCalls"] += 1
    with open(state_path, "w", encoding="utf-8") as fh:
        json.dump(state, fh)
    if state["blkidCalls"] == 1:
        out, rc = state["blkidOut"], state["blkidRc"]
    else:
        out, rc = state["secondBlkidOut"], state["secondBlkidRc"]
    if out:
        sys.stdout.write(out if out.endswith("\\n") else out + "\\n")
    sys.exit(rc)

if cmd == "wipefs":
    if "-n" in args:
        state["wipefsProbeCalls"] += 1
        with open(state_path, "w", encoding="utf-8") as fh:
            json.dump(state, fh)
        if state["wipefsProbeCalls"] == 1:
            out, rc = state["wipefsOut"], state["wipefsRc"]
        else:
            out, rc = state["secondWipefsOut"], state["secondWipefsRc"]
        if out:
            sys.stdout.write(out if out.endswith("\\n") else out + "\\n")
        sys.exit(rc)
    sys.exit(0)

if cmd == "mkfs.ext4":
    rc = state["mkfsRc"]
    if rc == 0:
        # Update label so post-format probes/mounts see formatted ext4 if invoked.
        label = ""
        for i, a in enumerate(args):
            if a == "-L" and i + 1 < len(args):
                label = args[i + 1]
        state["secondBlkidRc"] = 0
        state["secondBlkidOut"] = f"DEVNAME={args[-1]}\\nLABEL={label}\\nTYPE=ext4\\nUSAGE=filesystem"
        with open(state_path, "w", encoding="utf-8") as fh:
            json.dump(state, fh)
    sys.exit(rc)

if cmd == "mountpoint":
    target = args[-1]
    if target == state["profilesRoot"] and os.path.exists(mounted_path):
        sys.exit(0)
    sys.exit(1)

if cmd == "mount":
    if state["mountRc"] != 0:
        sys.exit(state["mountRc"])
    src = args[-2]
    target = args[-1]
    if target == state["profilesRoot"]:
        with open(mounted_path, "w", encoding="utf-8") as fh:
            fh.write(src)
    sys.exit(0)

if cmd == "findmnt":
    target = args[-1]
    col = ""
    for i, a in enumerate(args):
        if a == "-o" and i + 1 < len(args):
            col = args[i + 1]
    if target == "/":
        if col == "SOURCE":
            print(state["bootSource"])
            sys.exit(0)
    if target == state["profilesRoot"] and os.path.exists(mounted_path):
        src = open(mounted_path, "r", encoding="utf-8").read().strip()
        if col == "SOURCE":
            print(src)
            sys.exit(0)
        if col == "OPTIONS":
            print("rw,nosuid,nodev,noatime")
            sys.exit(0)
    sys.exit(1)

if cmd == "lsblk":
    dev = args[-1]
    pk = state["pknameMap"].get(dev, "")
    if pk:
        print(pk)
    sys.exit(0)

if cmd == "systemctl":
    sys.exit(state["systemctlRc"])

if cmd == "chown":
    sys.exit(0)

if cmd == "install":
    # Support install -d [-m mode] [-o owner] [-g group] dir... without requiring root.
    if "-d" in args:
        mode = None
        dirs = []
        i = 0
        while i < len(args):
            a = args[i]
            if a == "-d":
                i += 1
            elif a in ("-m", "-o", "-g"):
                if a == "-m" and i + 1 < len(args):
                    mode = int(args[i + 1], 8)
                i += 2
            else:
                dirs.append(a)
                i += 1
        for d in dirs:
            os.makedirs(d, exist_ok=True)
            if mode is not None:
                os.chmod(d, mode)
        sys.exit(0)
    sys.exit(0)

if cmd == "sha256sum":
    if "-c" in args:
        text = sys.stdin.read().strip()
        for line in text.splitlines():
            expected, path = line.split(None, 1)
            h = hashlib.sha256(open(path.strip(), "rb").read()).hexdigest()
            if h != expected:
                sys.exit(1)
        sys.exit(0)
    for path in args:
        h = hashlib.sha256(open(path, "rb").read()).hexdigest()
        print(f"{h}  {path}")
    sys.exit(0)

if cmd == "curl":
    # Mock Account /boot-complete and /boot responses.
    out_file = None
    url = args[-1]
    write_code = "-w" in args
    for i, a in enumerate(args):
        if a == "-o" and i + 1 < len(args):
            out_file = args[i + 1]
    if "/boot-complete" in url:
        if out_file:
            with open(out_file, "w", encoding="utf-8") as fh:
                json.dump({"completed": True}, fh)
        if write_code:
            sys.stdout.write("200")
        sys.exit(0)
    if out_file:
        with open(out_file, "wb") as fh:
            fh.write(b"fake-artifact-content")
    if write_code:
        sys.stdout.write("200")
    sys.exit(0)

if cmd == "uname":
    print("x86_64" if "-m" in args else "Linux")
    sys.exit(0)

if cmd in ("mdadm", "cryptsetup", "mkfs.xfs", "uuidgen", "nft", "sysctl", "swapoff", "modprobe"):
    if cmd == "uuidgen":
        print("11111111-2222-4333-8444-555555555555")
    sys.exit(0)

sys.exit(0)
`,
      { mode: 0o755 },
    );

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
    for (const noop of [
      "mdadm",
      "cryptsetup",
      "mkfs.xfs",
      "nft",
      "sysctl",
      "swapoff",
      "modprobe",
    ]) {
      writeExecutable(
        binDir,
        noop,
        `#!/usr/bin/env bash
CMD=${noop}; ${logCallBash}
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
  (cd "$(dirname "$target")" && printf '%s/%s\\n' "$(pwd -P)" "$(basename "$target")")
else
  printf '%s\\n' "$target"
fi
`,
    );
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
if [[ $target == "/" && $col == SOURCE ]]; then echo ${JSON.stringify(bootSrc)}; exit 0; fi
if [[ $target == ${JSON.stringify(profilesRootPath)} && -f ${JSON.stringify(mountedFile)} ]]; then
  if [[ $col == SOURCE ]]; then cat ${JSON.stringify(mountedFile)}; exit 0; fi
  if [[ $col == OPTIONS ]]; then echo "rw,nosuid,nodev,noatime"; exit 0; fi
fi
exit 1
`,
    );
    writeExecutable(
      binDir,
      "sha256sum",
      `#!/usr/bin/env bash
CMD=sha256sum; ${logCallBash}
if [[ " $* " == *" -c "* ]]; then
  while read -r expected path; do
    [[ -z $expected ]] && continue
    actual=$(/usr/bin/shasum -a 256 "$path" | awk '{print $1}')
    [[ $actual == "$expected" ]] || exit 1
  done
  exit 0
fi
/usr/bin/shasum -a 256 "$@"
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
    -o) out_file="$2"; shift 2 ;;
    -w) write_code=1; shift 2 ;;
    *) shift ;;
  esac
done
if [[ $url == *"/boot-complete"* ]]; then
  [[ -n $out_file ]] && printf '{"completed":true}' > "$out_file"
  (( write_code )) && printf '200'
  exit 0
fi
[[ -n $out_file ]] && printf 'fake-artifact-content' > "$out_file"
(( write_code )) && printf '200'
exit 0
`,
    );

    const commands = ["blkid", "wipefs", "mkfs.ext4", "mount", "systemctl"];
    for (const cmd of commands) {
      writeExecutable(
        binDir,
        cmd,
        `#!/usr/bin/env bash\nexec python3 "${recorderPy}" "${cmd}" "$@"\n`,
      );
    }

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
  verify-profiles-mount)
    exec bash "${setupScript}" verify-profiles-mount
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

      // Missing host.env must refuse on verify-profiles-mount AND boot.
      const verifyMissing = runScript(setupScript, ["verify-profiles-mount"], h.env);
      expect(verifyMissing.status).not.toBe(0);
      expect(verifyMissing.stderr).toMatch(/host\.env/iu);

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
        expect(
          h.readCalls().some((c) => c.cmd === "blkid"),
          `blkid probe must have run for ${name}`,
        ).toBe(true);

        const destructive = h
          .readCalls()
          .filter(
            (c) =>
              c.cmd === "mkfs.ext4" ||
              c.cmd === "mdadm" ||
              c.cmd === "cryptsetup" ||
              c.cmd === "mkfs.xfs" ||
              (c.cmd === "wipefs" && c.args.includes("-a")),
          );
        expect(destructive, `destructive calls made on refusal path ${name}`).toEqual([]);
      },
    );

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
      expect(
        hProfileOverlap
          .readCalls()
          .filter(
            (c) =>
              (c.cmd === "wipefs" && c.args.includes("-a")) ||
              c.cmd === "mdadm" ||
              c.cmd === "cryptsetup" ||
              c.cmd === "mkfs.xfs",
          ),
      ).toEqual([]);

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
      expect(
        hBootOverlap
          .readCalls()
          .filter(
            (c) =>
              (c.cmd === "wipefs" && c.args.includes("-a")) ||
              c.cmd === "mdadm" ||
              c.cmd === "cryptsetup" ||
              c.cmd === "mkfs.xfs",
          ),
      ).toEqual([]);
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
