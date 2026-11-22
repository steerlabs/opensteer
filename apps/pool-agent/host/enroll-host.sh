#!/usr/bin/env bash
# Provisions and enrols an Opensteer browser pool host from the boot spec rendered by
# apps/home-provisioner/src/pool-boot.ts. Idempotent: safe to re-run after a crash or reboot.
#
# Usage:
#   enroll-host.sh --boot-spec /root/opensteer-pool-boot.json \
#                  --bootstrap-token-file /root/opensteer-pool-bootstrap-token \
#                  [--setup-script /path/to/setup-host.sh]
#
# Pure subcommands (also used by local unit tests):
#   enroll-host.sh decide-profile-disk --ever-enrolled <true|false> \
#                  --blkid-rc <int> --blkid-out <str> \
#                  --wipefs-rc <int> --wipefs-out <str> [--mount-ok <true|false>]
#   enroll-host.sh render-agent-config --boot-spec <path> --relay-uid <uid> \
#                  [--out <path>] [--profiles-root <path>] [--credentials-root <path>]
#
# See apps/pool-agent/host/ENROLMENT.md for the step-by-step contract and operator recovery.
set -euo pipefail
umask 077

readonly OPT=/opt/opensteer-pool
readonly STATE=/var/lib/opensteer-pool
readonly PROFILES_ROOT_DEFAULT="$STATE/profiles"
readonly CREDENTIALS_ROOT_DEFAULT=/etc/opensteer-pool/credentials
readonly AGENT_CONFIG_PATH=/etc/opensteer-pool/agent.json
readonly ARTIFACTS_CACHE_PATH=/etc/opensteer-pool/release-artifacts.json
readonly PROFILE_DISK_LABEL=opensteer-profiles

log() { printf 'enroll-host: %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# Pure X1/T6 format-or-not decision.
# The disk self-identifies by its ext4 label (`opensteer-profiles`); Account says only whether
# this host has ever enrolled (`everEnrolled`).
#
# Prints one decision line to stdout:
#   mount-only        (exit 0)  disk carries our ext4 label `opensteer-profiles` (any generation)
#   format-and-mount  (exit 0)  disk is completely blank (blkid + wipefs) AND everEnrolled=false
#   refuse:<reason>   (exit 1)  in every other case (never format, change nothing)
decide_profile_disk() {
    local ever_enrolled="" blkid_rc="" blkid_out="" wipefs_rc="" wipefs_out="" mount_ok="true"
    while (( $# > 0 )); do
        case "$1" in
            --ever-enrolled) ever_enrolled=${2:-}; shift 2 ;;
            --blkid-rc)      blkid_rc=${2:-}; shift 2 ;;
            --blkid-out)     blkid_out=${2:-}; shift 2 ;;
            --wipefs-rc)     wipefs_rc=${2:-}; shift 2 ;;
            --wipefs-out)    wipefs_out=${2:-}; shift 2 ;;
            --mount-ok)      mount_ok=${2:-}; shift 2 ;;
            *) die "decide-profile-disk: unknown argument: $1" ;;
        esac
    done

    if [[ $ever_enrolled != true && $ever_enrolled != false ]]; then
        printf 'refuse:invalid-ever-enrolled\n'
        return 1
    fi
    if [[ ! $blkid_rc =~ ^[0-9]+$ || ! $wipefs_rc =~ ^[0-9]+$ ]]; then
        printf 'refuse:probe-error\n'
        return 1
    fi
    if [[ $mount_ok != true && $mount_ok != false ]]; then
        printf 'refuse:invalid-mount-status\n'
        return 1
    fi

    # blkid -o export -p exits 0 when a signature is found, 2 when blank; anything else is an error.
    # wipefs -n --noheadings exits 0 with empty stdout when blank, or lists signatures; non-zero is an error.
    if [[ $blkid_rc != 0 && $blkid_rc != 2 ]] || [[ $wipefs_rc != 0 ]]; then
        printf 'refuse:probe-error\n'
        return 1
    fi

    local trimmed_blkid trimmed_wipefs
    trimmed_blkid=$(printf '%s' "$blkid_out" | tr -d '[:space:]')
    trimmed_wipefs=$(printf '%s' "$wipefs_out" | tr -d '[:space:]')

    if [[ $blkid_rc == 2 && -z $trimmed_blkid && -z $trimmed_wipefs ]]; then
        if [[ $ever_enrolled == false ]]; then
            printf 'format-and-mount\n'
            return 0
        fi
        printf 'refuse:enrolled-host-blank-disk\n'
        return 1
    fi

    # Non-blank disk: check whether it carries our dedicated ext4 filesystem label and nothing else.
    if [[ $blkid_rc == 0 && -n $trimmed_blkid && -n $trimmed_wipefs ]]; then
        local fs_type="" fs_label="" pt_type="" line
        while IFS= read -r line || [[ -n $line ]]; do
            case "$line" in
                TYPE=*)   fs_type=${line#TYPE=} ;;
                LABEL=*)  fs_label=${line#LABEL=} ;;
                PTTYPE=*) pt_type=${line#PTTYPE=} ;;
            esac
        done <<< "$blkid_out"

        # Every non-empty wipefs signature line must be ext4 (no partition table, RAID, or LUKS).
        local wipefs_only_ext4=true wipefs_count=0
        while IFS= read -r line || [[ -n $line ]]; do
            [[ -z $(printf '%s' "$line" | tr -d '[:space:]') ]] && continue
            wipefs_count=$(( wipefs_count + 1 ))
            if ! printf '%s\n' "$line" | awk '{exit !($2 == "ext4")}'; then
                wipefs_only_ext4=false
                break
            fi
        done <<< "$wipefs_out"

        if [[ $fs_type == ext4 && $fs_label == "$PROFILE_DISK_LABEL" && -z $pt_type && $wipefs_only_ext4 == true && $wipefs_count -eq 1 ]]; then
            if [[ $mount_ok != true ]]; then
                printf 'refuse:unmountable-profile-disk\n'
                return 1
            fi
            printf 'mount-only\n'
            return 0
        fi
    fi

    printf 'refuse:foreign-disk-signature\n'
    return 1
}

python_boot_spec_helper() {
    python3 - "$@" <<'PY'
import base64
import ipaddress
import json
import os
import re
import sys
from urllib.parse import urlparse

HOST_ID_RE = re.compile(r"^ph_[0-9a-f-]{36}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SPKI_RE = re.compile(r"^[A-Za-z0-9+/]{40,200}={0,2}$")
DEV_RE = re.compile(r"^/dev/[A-Za-z0-9._/-]{1,128}$")
PATH_RE = re.compile(r"^/[A-Za-z0-9._/-]{1,255}$")
IPV4_CIDR_RE = re.compile(r"^(?:\d{1,3}\.){3}\d{1,3}/(?:[0-9]|[12][0-9]|3[0-2])$")


def fail(msg: str) -> None:
    sys.stderr.write(f"enroll-host: ERROR: {msg}\n")
    sys.exit(1)


def check_https_origin(value: object, field: str) -> str:
    if not isinstance(value, str) or len(value) > 255:
        fail(f"{field} must be an https origin string")
    parsed = urlparse(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path not in ("", "/")
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        fail(f"{field} must be a bare https origin without credentials, path, query, or fragment")
    return value.rstrip("/")


def check_https_url(value: object, field: str) -> str:
    if not isinstance(value, str) or len(value) > 2048:
        fail(f"{field} must be an https URL")
    parsed = urlparse(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or "?" in value
        or "#" in value
    ):
        fail(f"{field} must be an https URL without credentials, query, or fragment")
    return value


def check_port(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > 65535:
        fail(f"{field} must be an integer TCP port between 1 and 65535")
    return value


def check_cidr(value: object, field: str) -> str:
    if not isinstance(value, str) or not IPV4_CIDR_RE.match(value):
        fail(f"{field} must be an IPv4 CIDR")
    try:
        ipaddress.IPv4Network(value, strict=False)
    except ValueError:
        fail(f"{field} is not a valid IPv4 CIDR")
    return value


def check_spki(value: object, field: str) -> str:
    if not isinstance(value, str) or not SPKI_RE.match(value):
        fail(f"{field} must be base64-encoded Ed25519 SPKI DER")
    try:
        raw = base64.b64decode(value, validate=True)
    except Exception:
        fail(f"{field} is not valid base64")
    # Ed25519 SubjectPublicKeyInfo DER is 44 bytes with fixed 12-byte header.
    if len(raw) != 44 or raw[:12] != bytes.fromhex("302a300506032b6570032100"):
        fail(f"{field} is not an Ed25519 SPKI DER public key")
    return value


def validate_artifacts(artifacts: object) -> dict:
    if not isinstance(artifacts, dict):
        fail("release artifacts must be a JSON object")
    out = {}
    for name in ("agent", "relay", "rootfs", "kernel", "egress"):
        url_key = f"{name}Url"
        sha_key = f"{name}Sha256"
        out[url_key] = check_https_url(artifacts.get(url_key), url_key)
        sha = artifacts.get(sha_key)
        if not isinstance(sha, str) or not SHA256_RE.match(sha):
            fail(f"{sha_key} must be 64 lowercase hex characters")
        out[sha_key] = sha
    return out


def load_boot_spec(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = fh.read(1024 * 1024 + 1)
    except OSError as exc:
        fail(f"could not read boot spec at {path}: {exc.strerror}")
    if len(raw) > 1024 * 1024:
        fail(f"boot spec at {path} exceeds 1 MiB")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"boot spec at {path} is not valid JSON: {exc.msg}")
    if not isinstance(data, dict):
        fail("boot spec must be a JSON object")

    host_id = data.get("hostId")
    if not isinstance(host_id, str) or not HOST_ID_RE.match(host_id):
        fail("boot spec hostId is missing or malformed")

    generation = data.get("generation")
    if isinstance(generation, bool) or not isinstance(generation, int) or generation < 1:
        fail("boot spec generation must be a positive integer")

    account_origin = check_https_origin(data.get("accountOrigin"), "accountOrigin")
    installer_url = check_https_url(data.get("installerUrl"), "installerUrl")
    installer_sha = data.get("installerSha256")
    if not isinstance(installer_sha, str) or not SHA256_RE.match(installer_sha):
        fail("boot spec installerSha256 must be 64 lowercase hex characters")

    provisioner_key = check_spki(data.get("provisionerKey"), "provisionerKey")
    home_cidr = check_cidr(data.get("homeCidr"), "homeCidr")
    provisioner_cidr = check_cidr(data.get("provisionerCidr"), "provisionerCidr")

    profile_disk = data.get("profileDiskDevice")
    if not isinstance(profile_disk, str) or not DEV_RE.match(profile_disk) or ".." in profile_disk:
        fail("boot spec profileDiskDevice must be a /dev/... device path without '..'")

    ever_enrolled = data.get("everEnrolled")
    if not isinstance(ever_enrolled, bool):
        fail("boot spec everEnrolled must be a boolean")

    agent_port = check_port(data.get("agentPort", 7310), "agentPort")
    admin_port = check_port(data.get("adminPort", 7311), "adminPort")
    relay_port = check_port(data.get("relayPort", 7312), "relayPort")
    if len({agent_port, admin_port, relay_port}) != 3:
        fail("boot spec agentPort, adminPort, and relayPort must be distinct")

    spec = {
        "hostId": host_id,
        "generation": generation,
        "accountOrigin": account_origin,
        "installerUrl": installer_url,
        "installerSha256": installer_sha,
        "provisionerKey": provisioner_key,
        "homeCidr": home_cidr,
        "provisionerCidr": provisioner_cidr,
        "profileDiskDevice": profile_disk,
        "everEnrolled": ever_enrolled,
        "agentPort": agent_port,
        "adminPort": admin_port,
        "relayPort": relay_port,
    }

    if "artifacts" in data and data["artifacts"] is not None:
        spec["artifacts"] = validate_artifacts(data["artifacts"])
        ver = data.get("releaseVersion", "0.0.0-spec")
        if not isinstance(ver, str) or not ver or len(ver) > 128:
            fail("boot spec releaseVersion is invalid")
        spec["releaseVersion"] = ver
    return spec


def render_agent_config(spec: dict, relay_uid: int, profiles_root: str, credentials_root: str) -> dict:
    if not PATH_RE.match(profiles_root) or ".." in profiles_root:
        fail("profilesRoot must be an absolute path without '..'")
    if not PATH_RE.match(credentials_root) or ".." in credentials_root:
        fail("credentialsRoot must be an absolute path without '..'")
    return {
        "journal": "/var/lib/opensteer-pool/journal",
        "listen": {"host": "0.0.0.0", "port": spec["agentPort"]},
        "admin": {
            "listen": {"host": "0.0.0.0", "port": spec["adminPort"]},
            "provisionerKey": spec["provisionerKey"],
            "hostId": spec["hostId"],
            "hostKeyFile": "/etc/opensteer-pool/host-key.pem",
        },
        "retentionHours": 24,
        "saveAfterSeconds": 600,
        "maxConcurrentSaves": 2,
        "driver": {
            "firecracker": "/opt/opensteer-pool/bin/firecracker",
            "jailer": "/opt/opensteer-pool/bin/jailer",
            "images": "/srv/opensteer-pool/images",
            "jailRoot": "/srv/opensteer-pool/jail",
            "savedRoot": "/srv/opensteer-pool/saved",
            "stateDirectory": "/var/lib/opensteer-pool/driver",
            "arrayIdFile": "/srv/opensteer-pool/array-id",
            "profilesRoot": profiles_root,
            "credentialsRoot": credentials_root,
            "slotUidBase": 200000,
            "egressUidBase": 300000,
            "egress": {
                "node": "/opt/opensteer-pool/node/bin/node",
                "main": "/var/lib/opensteer-pool/images/egress/dist/egress-main.js",
                "accountOrigin": spec["accountOrigin"],
            },
            "requireEgressUpstream": True,
            "network": {
                "resolvers": ["8.8.8.8", "1.1.1.1"],
                "privateResolvers": ["169.254.169.254"],
                "hostUpstreams": [],
                "relayUid": relay_uid,
            },
            "guestMode": "runtime",
        },
    }


mode = sys.argv[1]
if mode == "parse-spec":
    print(json.dumps(load_boot_spec(sys.argv[2])))
elif mode == "render-agent-config":
    spec = load_boot_spec(sys.argv[2])
    try:
        relay_uid = int(sys.argv[3])
    except ValueError:
        fail("relay-uid must be a non-negative integer")
    if relay_uid < 0:
        fail("relay-uid must be a non-negative integer")
    config = render_agent_config(spec, relay_uid, sys.argv[4], sys.argv[5])
    print(json.dumps(config, indent=2))
elif mode == "build-boot-request":
    generation = int(sys.argv[2])
    token_path = sys.argv[3]
    out_path = sys.argv[4]
    with open(token_path, "r", encoding="utf-8") as fh:
        token = fh.read().strip()
    if not re.match(r"^[A-Za-z0-9_.-]{1,2048}$", token):
        fail("bootstrap token is empty or malformed")
    payload = {"generation": generation, "bootstrapToken": token}
    fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)
elif mode == "parse-boot-response":
    expected_host = sys.argv[2]
    expected_gen = int(sys.argv[3])
    resp_path = sys.argv[4]
    try:
        with open(resp_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as exc:
        fail(f"Account /boot response is not valid JSON: {exc}")
    if not isinstance(data, dict):
        fail("Account /boot response must be a JSON object")
    if data.get("hostId") != expected_host or data.get("generation") != expected_gen:
        fail("Account /boot response hostId or generation does not match boot spec")
    release = data.get("release")
    if not isinstance(release, dict):
        fail("Account /boot response is missing release metadata")
    version = release.get("version")
    if not isinstance(version, str) or not version or len(version) > 128:
        fail("Account /boot response release.version is invalid")
    artifacts = validate_artifacts(release.get("artifacts"))
    print(json.dumps({"hostId": expected_host, "generation": expected_gen, "releaseVersion": version, "artifacts": artifacts}))
elif mode == "read-cached-artifacts":
    expected_host = sys.argv[2]
    expected_gen = int(sys.argv[3])
    cache_path = sys.argv[4]
    try:
        with open(cache_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if data.get("hostId") != expected_host or data.get("generation") != expected_gen:
            sys.exit(1)
        version = data.get("releaseVersion")
        if not isinstance(version, str) or not version or len(version) > 128:
            sys.exit(1)
        artifacts = validate_artifacts(data.get("artifacts"))
        print(json.dumps({"hostId": expected_host, "generation": expected_gen, "releaseVersion": version, "artifacts": artifacts}))
    except Exception:
        sys.exit(1)
elif mode == "build-boot-complete-request":
    generation = int(sys.argv[2])
    token_path = sys.argv[3]
    host_key = check_spki(sys.argv[4], "hostKey")
    relay_key = check_spki(sys.argv[5], "relayKey")
    if host_key == relay_key:
        fail("hostKey and relayKey must be distinct keypairs")
    out_path = sys.argv[6]
    with open(token_path, "r", encoding="utf-8") as fh:
        token = fh.read().strip()
    if not re.match(r"^[A-Za-z0-9_.-]{1,2048}$", token):
        fail("bootstrap token is empty or malformed")
    payload = {
        "generation": generation,
        "bootstrapToken": token,
        "hostKey": host_key,
        "relayKey": relay_key,
    }
    fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)
elif mode == "check-boot-complete-response":
    resp_path = sys.argv[2]
    try:
        with open(resp_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as exc:
        fail(f"Account /boot-complete response is not valid JSON: {exc}")
    if data != {"completed": True}:
        fail("Account /boot-complete did not confirm completion")
elif mode == "write-manifest":
    out_path = sys.argv[2]
    manifest = {
        "kernelSha256": sys.argv[3],
        "rootfsSha256": sys.argv[4],
        "egressSha256": sys.argv[5],
        "releaseVersion": sys.argv[6],
    }
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh)
        fh.write("\n")
else:
    fail(f"unknown helper mode: {mode}")
PY
}

render_agent_config_cmd() {
    local boot_spec="" relay_uid="" out_path="" profiles_root="$PROFILES_ROOT_DEFAULT" credentials_root="$CREDENTIALS_ROOT_DEFAULT"
    while (( $# > 0 )); do
        case "$1" in
            --boot-spec)        boot_spec=${2:-}; shift 2 ;;
            --relay-uid)        relay_uid=${2:-}; shift 2 ;;
            --out)              out_path=${2:-}; shift 2 ;;
            --profiles-root)    profiles_root=${2:-}; shift 2 ;;
            --credentials-root) credentials_root=${2:-}; shift 2 ;;
            *) die "render-agent-config: unknown argument: $1" ;;
        esac
    done
    [[ -n $boot_spec ]] || die "render-agent-config requires --boot-spec"
    [[ -n $relay_uid ]] || die "render-agent-config requires --relay-uid"
    local rendered
    rendered=$(python_boot_spec_helper render-agent-config "$boot_spec" "$relay_uid" "$profiles_root" "$credentials_root")
    if [[ -n $out_path ]]; then
        local dir tmp
        dir=$(dirname "$out_path")
        install -d -m 0700 "$dir"
        tmp=$(mktemp "$dir/.agent.json.XXXXXX")
        chmod 0600 "$tmp"
        printf '%s\n' "$rendered" > "$tmp"
        mv "$tmp" "$out_path"
    else
        printf '%s\n' "$rendered"
    fi
}

require_private_root_file() {
    local file=$1 label=$2
    [[ -e $file ]] || die "$label not found at $file"
    [[ -f $file && ! -L $file ]] || die "$label at $file must be a regular file (not a symlink)"
    local owner mode
    owner=$(stat -c '%u' "$file")
    mode=$(stat -c '%a' "$file")
    [[ $owner == 0 ]] || die "$label at $file must be owned by root (uid 0, found $owner)"
    (( (8#$mode & 077) == 0 )) || die "$label at $file must be root-only (mode 0600, found $mode)"
}

fetch_artifact() {
    local label=$1 url=$2 dest=$3 expected_sha=$4 mode=$5
    local dir
    dir=$(dirname "$dest")
    install -d -m 0755 "$dir"
    if [[ -f $dest ]] && printf '%s  %s\n' "$expected_sha" "$dest" | sha256sum -c --quiet 2>/dev/null; then
        chmod "$mode" "$dest"
        log "artifact $label already verified at $dest"
        return 0
    fi
    local tmp
    tmp=$(mktemp "$dir/.download.XXXXXX")
    if ! curl -q --fail --silent --show-error --proto '=https' --tlsv1.2 --retry 3 --max-time 600 -o "$tmp" -- "$url"; then
        rm -f "$tmp"
        die "failed to download $label artifact from $url"
    fi
    if ! printf '%s  %s\n' "$expected_sha" "$tmp" | sha256sum -c --quiet 2>/dev/null; then
        rm -f "$tmp"
        die "SHA-256 mismatch for $label artifact from $url (expected $expected_sha)"
    fi
    chown root:root "$tmp"
    chmod "$mode" "$tmp"
    mv "$tmp" "$dest"
    log "artifact $label verified and installed at $dest"
}

prepare_profile_disk() {
    local dev=$1 ever_enrolled=$2 profiles_root=$3 generation=$4
    local waited=0
    while [[ ! -b $dev && $waited -lt 30 ]]; do
        udevadm settle --timeout=2 2>/dev/null || true
        [[ -b $dev ]] && break
        sleep 1
        waited=$(( waited + 1 ))
    done
    [[ -b $dev ]] || die "durable profile disk $dev did not appear as a block device after ${waited}s; check Compute disk attachment before retrying"

    local resolved_dev
    resolved_dev=$(readlink -f "$dev")
    install -d -m 0711 "$profiles_root"

    if mountpoint -q "$profiles_root"; then
        local mounted_src actual_dev opts
        mounted_src=$(findmnt -n -o SOURCE --target "$profiles_root" || true)
        [[ -n $mounted_src ]] || die "$profiles_root is a mount point but its source device could not be determined"
        actual_dev=$(readlink -f "$mounted_src")
        [[ $actual_dev == "$resolved_dev" ]] ||
            die "$profiles_root is already mounted from $actual_dev, not expected durable disk $resolved_dev; refusing to proceed"
        opts=$(findmnt -n -o OPTIONS --target "$profiles_root" || true)
        [[ ,$opts, == *,rw,* ]] || die "$profiles_root is mounted without read-write access ($opts)"
        chmod 0711 "$profiles_root"
        log "durable profile disk $dev ($resolved_dev) already mounted at $profiles_root"
        return 0
    fi

    local blkid_out="" blkid_rc=0 wipefs_out="" wipefs_rc=0
    blkid_out=$(blkid -o export -p "$resolved_dev" 2>/dev/null) || blkid_rc=$?
    wipefs_out=$(wipefs -n --noheadings "$resolved_dev" 2>/dev/null) || wipefs_rc=$?

    local decision="" decision_rc=0
    decision=$(decide_profile_disk \
        --ever-enrolled "$ever_enrolled" \
        --blkid-rc "$blkid_rc" \
        --blkid-out "$blkid_out" \
        --wipefs-rc "$wipefs_rc" \
        --wipefs-out "$wipefs_out") || decision_rc=$?

    case "$decision" in
        format-and-mount)
            log "durable profile disk $dev ($resolved_dev) is blank and host has never enrolled; formatting ext4 with label $PROFILE_DISK_LABEL once"
            # Never pass -f or -F: only answer the whole-device confirmation once blkid and wipefs
            # have both proven zero filesystem/partition signatures on the device.
            printf 'y\n' | mkfs.ext4 -q -m 1 -L "$PROFILE_DISK_LABEL" "$resolved_dev" ||
                die "mkfs.ext4 failed on blank durable profile disk $dev ($resolved_dev); refusing to start agent"
            mount -o noatime,nosuid,nodev "$resolved_dev" "$profiles_root" ||
                die "newly formatted profile disk $dev ($resolved_dev) failed to mount at $profiles_root"
            ;;
        mount-only)
            log "durable profile disk $dev ($resolved_dev) carries label $PROFILE_DISK_LABEL; mounting at $profiles_root (generation $generation, no format)"
            if ! mount -o noatime,nosuid,nodev "$resolved_dev" "$profiles_root"; then
                die "durable profile disk $dev ($resolved_dev) carries label $PROFILE_DISK_LABEL but could not be mounted on generation $generation; refusing to format or start agent. Inspect with lsblk, blkid, and fsck.ext4."
            fi
            ;;
        refuse:enrolled-host-blank-disk)
            die "REFUSED: host has enrolled before (everEnrolled=true), but durable profile disk $dev ($resolved_dev) is blank (no filesystem signature). Refusing to format; verify the right durable disk is attached before retrying."
            ;;
        refuse:foreign-disk-signature)
            die "REFUSED: durable profile disk $dev ($resolved_dev) carries an unrecognized filesystem, label, or partition table (expected blank on a never-enrolled host, or ext4 labeled '$PROFILE_DISK_LABEL'). Nothing was modified; inspect with blkid and wipefs -n."
            ;;
        refuse:probe-error)
            die "REFUSED: failed to probe durable profile disk $dev ($resolved_dev) cleanly (blkid rc=$blkid_rc, wipefs rc=$wipefs_rc). Nothing was modified; inspect disk health before retrying."
            ;;
        *)
            die "REFUSED: profile disk safety check returned '$decision' (rc=$decision_rc) for $dev ($resolved_dev). Nothing was modified."
            ;;
    esac

    chmod 0711 "$profiles_root"
    local mounted_src actual_dev opts
    mounted_src=$(findmnt -n -o SOURCE --target "$profiles_root" || true)
    [[ -n $mounted_src ]] || die "could not verify mounted source at $profiles_root after mount"
    actual_dev=$(readlink -f "$mounted_src")
    [[ $actual_dev == "$resolved_dev" ]] ||
        die "mount verification failed: $profiles_root is backed by $actual_dev, expected $resolved_dev"
    opts=$(findmnt -n -o OPTIONS --target "$profiles_root" || true)
    [[ ,$opts, == *,rw,* ]] || die "mount verification failed: $profiles_root is not mounted read-write ($opts)"
    log "durable profile disk $dev ($resolved_dev) mounted and verified at $profiles_root"
}

run_enrolment() {
    local boot_spec="" token_file="" setup_script="" profiles_root="$PROFILES_ROOT_DEFAULT" credentials_root="$CREDENTIALS_ROOT_DEFAULT"
    while (( $# > 0 )); do
        case "$1" in
            --boot-spec)            boot_spec=${2:-}; shift 2 ;;
            --bootstrap-token-file) token_file=${2:-}; shift 2 ;;
            --setup-script)         setup_script=${2:-}; shift 2 ;;
            --profiles-root)        profiles_root=${2:-}; shift 2 ;;
            --credentials-root)     credentials_root=${2:-}; shift 2 ;;
            *) die "unknown argument: $1" ;;
        esac
    done

    [[ $(id -u) == 0 ]] || die "run as root"
    [[ -n $boot_spec ]] || die "--boot-spec is required"
    [[ -n $token_file ]] || die "--bootstrap-token-file is required"
    command -v python3 >/dev/null 2>&1 || die "python3 is required"

    require_private_root_file "$boot_spec" "boot spec"
    require_private_root_file "$token_file" "bootstrap token file"

    if [[ -z $setup_script ]]; then
        local self_dir
        self_dir=$(cd -- "$(dirname -- "$0")" && pwd)
        if [[ -x $self_dir/setup-host.sh ]]; then
            setup_script="$self_dir/setup-host.sh"
        elif [[ -x $OPT/setup-host.sh ]]; then
            setup_script="$OPT/setup-host.sh"
        else
            die "setup-host.sh not found beside enroll-host.sh or at $OPT/setup-host.sh (pass --setup-script)"
        fi
    fi
    [[ -f $setup_script ]] || die "setup script not found at $setup_script"

    # 1. Validate boot spec strictly.
    local spec_json
    spec_json=$(python_boot_spec_helper parse-spec "$boot_spec")

    local host_id generation account_origin home_cidr provisioner_cidr profile_disk ever_enrolled
    local agent_port admin_port relay_port has_inline_artifacts
    IFS=$'\n' read -r -d '' host_id generation account_origin home_cidr provisioner_cidr profile_disk ever_enrolled agent_port admin_port relay_port has_inline_artifacts < <(
        python3 - "$spec_json" <<'PY'
import json, sys
s = json.loads(sys.argv[1])
for key in (
    "hostId",
    "generation",
    "accountOrigin",
    "homeCidr",
    "provisionerCidr",
    "profileDiskDevice",
):
    print(s[key])
print("true" if s["everEnrolled"] else "false")
print(s["agentPort"])
print(s["adminPort"])
print(s["relayPort"])
print("true" if "artifacts" in s else "false")
PY
        printf '\0'
    )

    log "enrolling pool host $host_id (generation $generation, everEnrolled=$ever_enrolled)"

    # Workspace for root-only temporary HTTP request/response files (never logged, always removed).
    local tmpdir
    tmpdir=$(mktemp -d /root/.opensteer-pool-enrol.XXXXXX)
    chmod 0700 "$tmpdir"
    trap 'rm -rf --one-file-system "${tmpdir:-}"' EXIT

    # 2. Durable profile disk (X1/T6) — checked BEFORE modifying host services or formatting anything.
    prepare_profile_disk "$profile_disk" "$ever_enrolled" "$profiles_root" "$generation"

    # 3. Resolve release artifact URLs and SHA-256s (inline in spec, cached from earlier retry, or Account /boot).
    local artifacts_json=""
    if [[ $has_inline_artifacts == true ]]; then
        artifacts_json=$(python3 - "$spec_json" <<'PY'
import json, sys
s = json.loads(sys.argv[1])
print(json.dumps({"hostId": s["hostId"], "generation": s["generation"], "releaseVersion": s["releaseVersion"], "artifacts": s["artifacts"]}))
PY
        )
    elif [[ -f $ARTIFACTS_CACHE_PATH && ! -L $ARTIFACTS_CACHE_PATH ]]; then
        artifacts_json=$(python_boot_spec_helper read-cached-artifacts "$host_id" "$generation" "$ARTIFACTS_CACHE_PATH" 2>/dev/null || true)
    fi

    if [[ -z $artifacts_json ]]; then
        local boot_req="$tmpdir/boot-req.json" boot_resp="$tmpdir/boot-resp.json"
        python_boot_spec_helper build-boot-request "$generation" "$token_file" "$boot_req"
        local boot_url="${account_origin}/v1/browser-pool/hosts/${host_id}/boot"
        local http_code
        http_code=$(curl -q --silent --show-error --proto '=https' --tlsv1.2 --max-time 30 \
            -H 'content-type: application/json' \
            -o "$boot_resp" -w '%{http_code}' \
            --data-binary "@$boot_req" \
            -- "$boot_url") || die "could not reach Account boot route at $boot_url"
        rm -f "$boot_req"
        [[ $http_code == 200 ]] || die "Account boot route refused enrolment (HTTP $http_code); verify bootstrap token is unexpired and matches host $host_id generation $generation"
        artifacts_json=$(python_boot_spec_helper parse-boot-response "$host_id" "$generation" "$boot_resp")
        rm -f "$boot_resp"
        install -d -m 0700 /etc/opensteer-pool
        local cache_tmp
        cache_tmp=$(mktemp /etc/opensteer-pool/.release-artifacts.XXXXXX)
        chmod 0600 "$cache_tmp"
        printf '%s\n' "$artifacts_json" > "$cache_tmp"
        mv "$cache_tmp" "$ARTIFACTS_CACHE_PATH"
    fi

    local release_version agent_url agent_sha relay_url relay_sha rootfs_url rootfs_sha kernel_url kernel_sha egress_url egress_sha
    IFS=$'\n' read -r -d '' release_version agent_url agent_sha relay_url relay_sha rootfs_url rootfs_sha kernel_url kernel_sha egress_url egress_sha < <(
        python3 - "$artifacts_json" <<'PY'
import json, sys
d = json.loads(sys.argv[1])
a = d["artifacts"]
print(d["releaseVersion"])
for name in ("agent", "relay", "rootfs", "kernel", "egress"):
    print(a[f"{name}Url"])
    print(a[f"{name}Sha256"])
PY
        printf '\0'
    )

    # 4. Install/verify host baseline, persist settings in /etc/opensteer-pool/host.env, and generate keys.
    OSP_HOME_CIDR="$home_cidr" \
    OSP_PROVISIONER_CIDR="$provisioner_cidr" \
    OSP_AGENT_PORT="$agent_port" \
    OSP_ADMIN_PORT="$admin_port" \
    OSP_RELAY_PORT="$relay_port" \
    OSP_PROFILE_DISK="$profile_disk" \
    OSP_PROFILES_ROOT="$profiles_root" \
    OSP_SKIP_DEFAULT_KERNEL=1 \
        bash "$setup_script" install

    # 5. Fetch & SHA-256-verify each release artifact (skipping any already present with matching hash).
    fetch_artifact "agent"  "$agent_url"  "$OPT/agent/main.js"                        "$agent_sha"  0644
    fetch_artifact "relay"  "$relay_url"  "$OPT/agent/relay.mjs"                      "$relay_sha"  0644
    fetch_artifact "rootfs" "$rootfs_url" "$STATE/images/rootfs.ext4"                 "$rootfs_sha" 0444
    fetch_artifact "kernel" "$kernel_url" "$STATE/images/vmlinux"                     "$kernel_sha" 0444
    fetch_artifact "egress" "$egress_url" "$STATE/images/egress/dist/egress-main.js"  "$egress_sha" 0644

    local manifest_tmp="$STATE/images/.manifest.json.new"
    python_boot_spec_helper write-manifest "$manifest_tmp" "$kernel_sha" "$rootfs_sha" "$egress_sha" "$release_version"
    chown root:root "$manifest_tmp"
    chmod 0444 "$manifest_tmp"
    mv "$manifest_tmp" "$STATE/images/manifest.json"

    # Stage images onto the encrypted saved-state array and re-verify profile mount & persisted firewall.
    bash "$OPT/setup-host.sh" boot

    # 6. Prepare root-only credentialsRoot on the instance's own disk and write agent.json (0600).
    install -d -m 0700 -o root -g root "$credentials_root"
    local relay_uid
    relay_uid=$(id -u opensteer-pool-relay)
    render_agent_config_cmd \
        --boot-spec "$boot_spec" \
        --relay-uid "$relay_uid" \
        --profiles-root "$profiles_root" \
        --credentials-root "$credentials_root" \
        --out "$AGENT_CONFIG_PATH"
    chown root:root "$AGENT_CONFIG_PATH"
    chmod 0600 "$AGENT_CONFIG_PATH"

    # 7. Enrol public halves of host and relay keys with Account; remove token and start services only on success.
    local host_key_b64 relay_key_b64
    host_key_b64=$(openssl pkey -pubin -in /etc/opensteer-pool/host-key.pub -outform DER | base64 -w0)
    relay_key_b64=$(openssl pkey -pubin -in /etc/opensteer-pool-relay/relay-key.pub -outform DER | base64 -w0)

    local complete_req="$tmpdir/boot-complete-req.json" complete_resp="$tmpdir/boot-complete-resp.json"
    python_boot_spec_helper build-boot-complete-request "$generation" "$token_file" "$host_key_b64" "$relay_key_b64" "$complete_req"

    local complete_url="${account_origin}/v1/browser-pool/hosts/${host_id}/boot-complete"
    local complete_code
    complete_code=$(curl -q --silent --show-error --proto '=https' --tlsv1.2 --max-time 30 \
        -H 'content-type: application/json' \
        -o "$complete_resp" -w '%{http_code}' \
        --data-binary "@$complete_req" \
        -- "$complete_url") || die "could not reach Account boot-complete route at $complete_url"
    rm -f "$complete_req"
    [[ $complete_code == 200 ]] || die "Account boot-complete refused enrolment (HTTP $complete_code); token kept for retry and services were NOT started"
    python_boot_spec_helper check-boot-complete-response "$complete_resp"
    rm -f "$complete_resp"

    # Enrolment succeeded: remove single-use bootstrap token, re-verify durable profile mount, start services.
    rm -f "$token_file"
    bash "$OPT/setup-host.sh" verify-profiles-mount
    systemctl enable --now opensteer-pool-agent.service opensteer-pool-relay.service >/dev/null
    log "enrolment complete for $host_id (generation $generation); agent and relay enabled and started"
}

case "${1:-}" in
    decide-profile-disk)
        shift
        decide_profile_disk "$@"
        ;;
    render-agent-config)
        shift
        render_agent_config_cmd "$@"
        ;;
    *)
        run_enrolment "$@"
        ;;
esac
