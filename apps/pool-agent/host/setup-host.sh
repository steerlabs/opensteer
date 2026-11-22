#!/usr/bin/env bash
# Prepares a pool host and keeps it prepared. Idempotent: run it again at any time.
#
#   setup-host.sh install               packages, pinned binaries, users, units, then `boot`
#   setup-host.sh boot                  every boot (opensteer-pool-host.service): profile disk
#                                       mount check, encrypted saved-state array, kernel settings,
#                                       persisted firewall rules, guest images on the array
#   setup-host.sh verify-profiles-mount verify that OSP_PROFILES_ROOT is mounted from OSP_PROFILE_DISK
#   setup-host.sh saved-state-array     build and mount the encrypted Local SSD saved-state array
#   setup-host.sh check                 prints every setting this host must have and fails on a wrong one
#
# Every setting and its reason: apps/pool-agent/host/HOST-SETUP.md and ENROLMENT.md.
# Ubuntu 24.04, x86_64. Downloads go through the environment's http(s)_proxy when one is set.
set -euo pipefail
umask 022

readonly FC_VERSION=v1.18.0
readonly FC_TARBALL_SHA256=1ac8eec866dd5eea14efecf6323e22b23eea24054545338a5b34bc5bca6623cd
readonly FC_SHA256=b33f46cd6d88834cf6a4f8d184f08f219809c636236bffd286d233a60602a2ba
readonly JAILER_SHA256=ddadbaa15b5c942271a83b7040ca7259c8ccf92a9e08d44cce0b86fa407ba460
readonly NODE_VERSION=v24.15.0
readonly NODE_SHA256=472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6
readonly KERNEL_URL=https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/20261118-6d7cfa9c6b53-0/x86_64/vmlinux-6.1.188
readonly KERNEL_SHA256=c7f899cbd24b856bca2a6db1736a48f90b4fe1f75cd3f53e775f36d8e8b00a40

readonly OPT=${OSP_OPT_DIR:-/opt/opensteer-pool}
readonly STATE=${OSP_STATE_DIR:-/var/lib/opensteer-pool}          # durable: journal, driver state, profiles, images
readonly ARRAY=${OSP_ARRAY_DIR:-/srv/opensteer-pool}              # encrypted Local SSD array: jails, saved state
readonly RUN=${OSP_RUN_DIR:-/run/opensteer-pool}
readonly ETC=${OSP_ETC_DIR:-/etc/opensteer-pool}
readonly RELAY_ETC=${OSP_RELAY_ETC_DIR:-/etc/opensteer-pool-relay}
readonly SYSTEMD_DIR=${OSP_SYSTEMD_DIR:-/etc/systemd/system}
readonly KVM_DEV=${OSP_KVM_DEV:-/dev/kvm}
readonly CGROUP_CONTROLLERS=${OSP_CGROUP_CONTROLLERS:-/sys/fs/cgroup/cgroup.controllers}
readonly SMT_ACTIVE=${OSP_SMT_ACTIVE:-/sys/devices/system/cpu/smt/active}
readonly CPU_VULNS_DIR=${OSP_CPU_VULNS_DIR:-/sys/devices/system/cpu/vulnerabilities}
readonly MAPPER=osp-saved
readonly HOST_ENV="$ETC/host.env"
readonly AGENT_CONFIG="$ETC/agent.json"
readonly FIXED_PROFILE_DISK_DEVICE=/dev/disk/by-id/google-opensteer-profiles

log() { printf 'setup-host: %s\n' "$*" >&2; }
die() { log "$*"; exit 1; }

is_block_device() {
    local target=$1
    [[ -b $target ]] && return 0
    [[ $(stat -L -c '%F' "$target" 2>/dev/null || true) == "block special file" ]]
}

# Z7: Single shared bounded wait for the durable profile disk, used by both enrolment and boot.
wait_for_profile_disk() {
    local dev=$1
    local max_wait=${OSP_PROFILE_DISK_WAIT_SECONDS:-30}
    [[ $max_wait =~ ^[0-9]+$ ]] || max_wait=30
    local waited=0
    while ! is_block_device "$dev" && (( waited < max_wait )); do
        udevadm settle --timeout=2 2>/dev/null || true
        is_block_device "$dev" && break
        sleep 1
        waited=$(( waited + 1 ))
    done
    is_block_device "$dev" || die "durable profile disk $dev did not appear as a block device after ${waited}s; inspect attached disks and do NOT format"
}

load_host_env() {
    local require_file=${1:-0}
    if [[ ! -e $HOST_ENV ]]; then
        if [[ $require_file == 1 ]]; then
            die "required host configuration $HOST_ENV is missing; refusing to proceed without durable profile disk configuration"
        fi
        return 0
    fi
    [[ -f $HOST_ENV && ! -L $HOST_ENV ]] || die "$HOST_ENV must be a regular file (not a symlink)"
    local owner mode
    owner=$(stat -c '%u' "$HOST_ENV")
    mode=$(stat -c '%a' "$HOST_ENV")
    [[ $owner == 0 ]] || die "$HOST_ENV must be owned by root (uid 0, found $owner)"
    (( (8#$mode & 022) == 0 )) || die "$HOST_ENV must not be group- or world-writable (mode $mode)"
    local line key val
    while IFS= read -r line || [[ -n $line ]]; do
        [[ -z $line || $line == \#* ]] && continue
        [[ $line == *=* ]] || die "malformed line in $HOST_ENV"
        key=${line%%=*}
        val=${line#*=}
        case "$key" in
            OSP_LOCAL_SSDS|OSP_HOME_CIDR|OSP_PROVISIONER_CIDR|OSP_AGENT_PORT|OSP_ADMIN_PORT|OSP_RELAY_PORT|OSP_PROFILE_DISK|OSP_PROFILE_DISK_LABEL|OSP_PROFILES_ROOT|OSP_EGRESS_SLICE_MIB|OSP_ONE_THREAD_PER_CORE|OSP_SKIP_DEFAULT_KERNEL|OSP_REQUIRE_PROFILE_DISK)
                if [[ -z ${!key+x} ]]; then
                    printf -v "$key" '%s' "$val"
                fi
                ;;
            *)
                die "unexpected key '$key' in $HOST_ENV"
                ;;
        esac
    done < "$HOST_ENV"
}

CMD=${1:-}
case "$CMD" in
    boot|verify-profiles-mount) load_host_env 1 ;;
    *)                          load_host_env 0 ;;
esac

: "${OSP_LOCAL_SSDS:=/dev/disk/by-id/google-local-nvme-ssd-*}"
: "${OSP_HOME_CIDR:=10.0.0.0/8}"              # who may reach the agent's Home interface
: "${OSP_PROVISIONER_CIDR:=127.0.0.1/32}"     # who may reach its administration interface
: "${OSP_AGENT_PORT:=7310}"
: "${OSP_ADMIN_PORT:=7311}"
: "${OSP_RELAY_PORT:=7312}"
: "${OSP_PROFILE_DISK:=}"                     # fixed durable profile disk block device (enrolment)
: "${OSP_PROFILE_DISK_LABEL:=}"               # per-host ext4 label osp-<12hex> (enrolment)
: "${OSP_REQUIRE_PROFILE_DISK:=0}"            # set to 1 on provisioned hosts
: "${OSP_PROFILES_ROOT:=$STATE/profiles}"
: "${OSP_EGRESS_SLICE_MIB:=1536}"
: "${OSP_SKIP_DEFAULT_KERNEL:=0}"

is_bench_agent_config() {
    [[ -f $AGENT_CONFIG ]] && grep -q '"guestMode"[[:space:]]*:[[:space:]]*"bench"' "$AGENT_CONFIG"
}

# Y1 + Y3 + Y7: On a provisioned host (anything except an explicit bench config or unconfigured
# manual install), OSP_PROFILE_DISK must be the fixed by-id path and OSP_PROFILE_DISK_LABEL must
# carry this host's 16-byte label osp-<12hex>. Returns 0 when profile mount is required, 1 to skip
# (bench/manual install only), or dies on missing/invalid config.
require_profile_disk_configured() {
    local allow_unconfigured=${1:-0}
    if [[ -z $OSP_PROFILE_DISK ]]; then
        if [[ $OSP_REQUIRE_PROFILE_DISK == 1 ]]; then
            die "OSP_PROFILE_DISK is empty on a provisioned host; refusing to fall back to the boot disk"
        fi
        if is_bench_agent_config; then
            return 1
        fi
        if [[ $allow_unconfigured == 1 && ! -e $AGENT_CONFIG ]]; then
            return 1
        fi
        die "OSP_PROFILE_DISK is empty in $HOST_ENV; refusing to fall back to the boot disk"
    fi
    [[ $OSP_PROFILE_DISK == "$FIXED_PROFILE_DISK_DEVICE" ]] ||
        die "OSP_PROFILE_DISK must be $FIXED_PROFILE_DISK_DEVICE (found $OSP_PROFILE_DISK)"
    [[ $OSP_PROFILE_DISK_LABEL =~ ^osp-[0-9a-f]{12}$ ]] ||
        die "OSP_PROFILE_DISK_LABEL must match osp-<12hex> (found '${OSP_PROFILE_DISK_LABEL:-empty}')"
    return 0
}

save_host_env() {
    install -d -m 0700 "$ETC"
    local tmp
    tmp=$(mktemp "$ETC/.host.env.XXXXXX")
    chmod 0600 "$tmp"
    {
        printf '# Persisted Opensteer pool host settings (read by setup-host.sh on every boot)\n'
        printf 'OSP_LOCAL_SSDS=%s\n' "$OSP_LOCAL_SSDS"
        printf 'OSP_HOME_CIDR=%s\n' "$OSP_HOME_CIDR"
        printf 'OSP_PROVISIONER_CIDR=%s\n' "$OSP_PROVISIONER_CIDR"
        printf 'OSP_AGENT_PORT=%s\n' "$OSP_AGENT_PORT"
        printf 'OSP_ADMIN_PORT=%s\n' "$OSP_ADMIN_PORT"
        printf 'OSP_RELAY_PORT=%s\n' "$OSP_RELAY_PORT"
        printf 'OSP_PROFILES_ROOT=%s\n' "$OSP_PROFILES_ROOT"
        printf 'OSP_EGRESS_SLICE_MIB=%s\n' "$OSP_EGRESS_SLICE_MIB"
        printf 'OSP_SKIP_DEFAULT_KERNEL=%s\n' "$OSP_SKIP_DEFAULT_KERNEL"
        printf 'OSP_REQUIRE_PROFILE_DISK=%s\n' "$OSP_REQUIRE_PROFILE_DISK"
        if [[ -n $OSP_PROFILE_DISK ]]; then
            printf 'OSP_PROFILE_DISK=%s\n' "$OSP_PROFILE_DISK"
        fi
        if [[ -n $OSP_PROFILE_DISK_LABEL ]]; then
            printf 'OSP_PROFILE_DISK_LABEL=%s\n' "$OSP_PROFILE_DISK_LABEL"
        fi
        if [[ -n ${OSP_ONE_THREAD_PER_CORE:-} ]]; then
            printf 'OSP_ONE_THREAD_PER_CORE=%s\n' "$OSP_ONE_THREAD_PER_CORE"
        fi
    } > "$tmp"
    mv "$tmp" "$HOST_ENV"
}

require_host() {
    [[ $(id -u) == 0 ]] || die "run as root"
    [[ $(uname -m) == x86_64 ]] || die "x86_64 only"
    [[ -c $KVM_DEV || ( $KVM_DEV != /dev/kvm && -e $KVM_DEV ) ]] || die "/dev/kvm is missing: enable nested virtualization or use bare metal"
    [[ -f $CGROUP_CONTROLLERS ]] || die "the unified cgroup v2 hierarchy is required"
    # One thread per core: no SMT sibling is shared between two people's guests. A host whose
    # thread status cannot be read fails unless it is declared one-thread-per-core.
    if [[ -r $SMT_ACTIVE ]]; then
        [[ $(cat "$SMT_ACTIVE") == 0 ]] || die "SMT is active: create the host with one thread per core"
    elif [[ ${OSP_ONE_THREAD_PER_CORE:-} != declared ]]; then
        die "SMT status is unreadable: set OSP_ONE_THREAD_PER_CORE=declared on a one-thread-per-core host"
    fi
    vulnerable_cpu && die "a CPU vulnerability Firecracker's production guide names is not mitigated (see check)"
    return 0
}

# The side channels Firecracker's production host guide names (Spectre, Meltdown, MDS and
# iTLB multihit): any one reported "Vulnerable" by the kernel fails the host.
readonly NAMED_VULNERABILITIES="spectre_v1 spectre_v2 spec_store_bypass meltdown l1tf mds itlb_multihit"
vulnerable_cpu() {
    local name state
    for name in $NAMED_VULNERABILITIES; do
        state=$(cat "$CPU_VULNS_DIR/$name" 2>/dev/null || echo "Unknown")
        [[ $state == Vulnerable* ]] && return 0
    done
    return 1
}

fetch() { # url output sha256
    local url=$1 out=$2 sum=$3
    if [[ -f $out ]] && echo "$sum  $out" | sha256sum -c --quiet 2>/dev/null; then return; fi
    curl -fsSL --retry 3 -o "$out.part" "$url"
    echo "$sum  $out.part" | sha256sum -c --quiet || die "checksum mismatch for $url"
    mv "$out.part" "$out"
}

install_packages() {
    export DEBIAN_FRONTEND=noninteractive
    apt-get -o Acquire::Retries=3 update -q
    apt-get install -y -q --no-install-recommends \
        nftables iproute2 mdadm cryptsetup-bin xfsprogs e2fsprogs util-linux curl ca-certificates xz-utils uuid-runtime openssl
}

install_binaries() {
    install -d -m 0755 "$OPT/bin" "$OPT/download"
    fetch "https://github.com/firecracker-microvm/firecracker/releases/download/$FC_VERSION/firecracker-$FC_VERSION-x86_64.tgz" \
        "$OPT/download/firecracker.tgz" "$FC_TARBALL_SHA256"
    local unpack; unpack=$(mktemp -d)
    tar -xzf "$OPT/download/firecracker.tgz" -C "$unpack"
    local release="$unpack/release-$FC_VERSION-x86_64"
    echo "$FC_SHA256  $release/firecracker-$FC_VERSION-x86_64" | sha256sum -c --quiet || die "firecracker checksum"
    echo "$JAILER_SHA256  $release/jailer-$FC_VERSION-x86_64" | sha256sum -c --quiet || die "jailer checksum"
    # Root-owned and not writable by anyone else: the jailer trusts its exec file.
    install -o root -g root -m 0755 "$release/firecracker-$FC_VERSION-x86_64" "$OPT/bin/firecracker"
    install -o root -g root -m 0755 "$release/jailer-$FC_VERSION-x86_64" "$OPT/bin/jailer"
    rm -rf "$unpack"
    fetch "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" \
        "$OPT/download/node.tar.xz" "$NODE_SHA256"
    if [[ ! -x $OPT/node/bin/node ]] || [[ $("$OPT/node/bin/node" --version) != "$NODE_VERSION" ]]; then
        rm -rf "$OPT/node.new"
        install -d -m 0755 "$OPT/node.new"
        tar -xJf "$OPT/download/node.tar.xz" -C "$OPT/node.new" --strip-components=1 --no-same-owner
        rm -rf "$OPT/node"
        mv "$OPT/node.new" "$OPT/node"
    fi
    install -d -m 0755 "$STATE/images"
    if [[ $OSP_SKIP_DEFAULT_KERNEL != 1 ]]; then
        fetch "$KERNEL_URL" "$STATE/images/vmlinux.download" "$KERNEL_SHA256"
    fi
}

host_key() {
    # The host's own key: administration replies are signed with it, and the provisioner pins its
    # public half when it enrolls the host (review G2). Made once, root only.
    install -d -m 0700 "$ETC"
    if [[ ! -f $ETC/host-key.pem ]]; then
        (umask 077 && openssl genpkey -algorithm ed25519 -out "$ETC/host-key.pem")
    fi
    openssl pkey -in "$ETC/host-key.pem" -pubout -out "$ETC/host-key.pub"
    chmod 0644 "$ETC/host-key.pub"
    # The relay's own TLS key (round 4, item 5): not the host key, so a compromised relay cannot
    # sign an answer. A Home pins both. The relay's user gets it only as a systemd credential and
    # presents a certificate for it; a Home checks the key, not an issuer (there is none).
    if [[ ! -f $ETC/relay-key.pem ]]; then
        (umask 077 && openssl genpkey -algorithm ed25519 -out "$ETC/relay-key.pem")
    fi
    # The relay's user cannot enter /etc/opensteer-pool: its public files live beside it.
    install -d -m 0755 "$RELAY_ETC"
    if [[ ! -f $RELAY_ETC/relay-cert.pem ]]; then
        openssl req -x509 -new -key "$ETC/relay-key.pem" -subj /CN=opensteer-pool-relay \
            -days 3650 -out "$RELAY_ETC/relay-cert.pem"
    fi
    openssl pkey -in "$ETC/relay-key.pem" -pubout -out "$RELAY_ETC/relay-key.pub"
    chmod 0644 "$RELAY_ETC/relay-cert.pem" "$RELAY_ETC/relay-key.pub"
}

install_users() {
    # The one local peer allowed to reach a guest's bridge port (the transport relay).
    getent passwd opensteer-pool-relay >/dev/null ||
        useradd --system --no-create-home --shell /usr/sbin/nologin opensteer-pool-relay
}

verify_profile_mount() {
    require_profile_disk_configured 0 || return 0
    is_block_device "$OSP_PROFILE_DISK" || die "durable profile disk $OSP_PROFILE_DISK is not present as a block device; refusing to start agent"
    local expected actual mounted_src opts blkid_out fs_type fs_label
    expected=$(readlink -f "$OSP_PROFILE_DISK")
    mountpoint -q "$OSP_PROFILES_ROOT" || die "durable profile directory $OSP_PROFILES_ROOT is not a mount point; refusing to fall back to the boot disk"
    mounted_src=$(findmnt -n -o SOURCE --target "$OSP_PROFILES_ROOT" || true)
    [[ -n $mounted_src ]] || die "could not determine mounted source for $OSP_PROFILES_ROOT; refusing to start agent"
    actual=$(readlink -f "$mounted_src")
    [[ $actual == "$expected" ]] || die "durable profile directory $OSP_PROFILES_ROOT is mounted from $actual, expected $expected; refusing to start agent"
    opts=$(findmnt -n -o OPTIONS --target "$OSP_PROFILES_ROOT" || true)
    [[ ,$opts, == *,rw,* ]] || die "durable profile directory $OSP_PROFILES_ROOT is not mounted read-write ($opts)"
    blkid_out=$(blkid -o export -p "$actual" 2>/dev/null) ||
        die "could not verify filesystem label on mounted profile disk $actual; refusing to start agent"
    fs_type=$(printf '%s\n' "$blkid_out" | awk -F= '$1=="TYPE"{print $2}')
    fs_label=$(printf '%s\n' "$blkid_out" | awk -F= '$1=="LABEL"{print $2}')
    [[ $fs_type == ext4 && $fs_label == "$OSP_PROFILE_DISK_LABEL" ]] ||
        die "mounted profile disk $actual has TYPE=${fs_type:-none} LABEL=${fs_label:-none}, expected ext4/$OSP_PROFILE_DISK_LABEL; refusing to start agent"
}

mount_profile_disk() {
    local allow_unconfigured=${1:-0}
    # Boot-time mount ONLY (X1/Y1/Y7/Z7): NEVER formats. Waits a bounded time for the durable
    # profile disk via the shared helper, verifies this host's per-host ext4 label (`osp-<12hex>`)
    # before mounting so a foreign, wrong-host, or wiped disk fails loudly and
    # opensteer-pool-agent.service never starts against the boot disk.
    require_profile_disk_configured "$allow_unconfigured" || return 0
    wait_for_profile_disk "$OSP_PROFILE_DISK"
    local resolved
    resolved=$(readlink -f "$OSP_PROFILE_DISK")
    install -d -m 0711 "$OSP_PROFILES_ROOT"
    if ! mountpoint -q "$OSP_PROFILES_ROOT"; then
        local blkid_out fs_type fs_label
        blkid_out=$(blkid -o export -p "$resolved" 2>/dev/null) ||
            die "durable profile disk $OSP_PROFILE_DISK ($resolved) has no readable filesystem at boot; refusing to format or start agent"
        fs_type=$(printf '%s\n' "$blkid_out" | awk -F= '$1=="TYPE"{print $2}')
        fs_label=$(printf '%s\n' "$blkid_out" | awk -F= '$1=="LABEL"{print $2}')
        [[ $fs_type == ext4 && $fs_label == "$OSP_PROFILE_DISK_LABEL" ]] ||
            die "durable profile disk $OSP_PROFILE_DISK ($resolved) has TYPE=${fs_type:-none} LABEL=${fs_label:-none}, expected ext4/$OSP_PROFILE_DISK_LABEL; refusing to mount or start agent"
        mount -o noatime,nosuid,nodev "$resolved" "$OSP_PROFILES_ROOT" ||
            die "failed to mount durable profile disk $OSP_PROFILE_DISK ($resolved) at $OSP_PROFILES_ROOT; refusing to start agent (inspect with lsblk, blkid, and fsck.ext4; never reformat)"
    fi
    chmod 0711 "$OSP_PROFILES_ROOT"
    verify_profile_mount
    log "durable profile disk $OSP_PROFILE_DISK ($resolved) verified mounted at $OSP_PROFILES_ROOT"
}

install_units() {
    # The state root is traversable (the egress users read the egress tree in images/); the
    # journal and driver state inside it are root-only.
    install -d -m 0700 "$ETC" "$STATE/journal" "$STATE/driver"
    install -d -m 0711 "$STATE"
    install -d -m 0711 "$OSP_PROFILES_ROOT"
    install -m 0755 "$0" "$OPT/setup-host.sh"
    install -d -m 0755 "$SYSTEMD_DIR"
    cat > "$SYSTEMD_DIR/opensteer-pool-host.service" <<EOF
[Unit]
Description=Opensteer pool host: durable profiles mount, encrypted saved-state array and kernel settings
DefaultDependencies=no
After=local-fs.target systemd-udev-settle.service nftables.service
Before=opensteer-pool-agent.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$OPT/setup-host.sh boot

[Install]
WantedBy=multi-user.target
EOF
    cat > "$SYSTEMD_DIR"/opensteer-pool-agent.service <<EOF
[Unit]
Description=Opensteer pool agent
Requires=opensteer-pool-host.service
After=opensteer-pool-host.service network-online.target nftables.service
Wants=network-online.target
# The agent never stays down for good (re-check finding 7): no start limit; the delay grows.
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStartPre=$OPT/setup-host.sh verify-profiles-mount
ExecStart=$OPT/node/bin/node $OPT/agent/main.js $AGENT_CONFIG
Restart=always
RestartSec=1
RestartSteps=6
RestartMaxDelaySec=60
# Guests are in the agent's delegated subtree and outlive an agent restart: the next agent
# reconciles with them. Only the agent's own process is ended on stop.
Delegate=yes
# systemd starts the agent in its own leaf: the subtree root has controllers enabled for the
# guests, and a cgroup with enabled controllers cannot hold a process (status 219/CGROUP).
DelegateSubgroup=agent
KillMode=process
LimitCORE=0
LimitNOFILE=65536
# Under host memory pressure a guest's VMM goes before the agent that could clean it up.
OOMScoreAdjust=-900
NoNewPrivileges=yes
SystemCallArchitectures=native
# What the jailer and the namespace, mount and filter work need, and nothing more. No mount
# namespace options: the agent makes network namespaces and bind mounts the host must see.
CapabilityBoundingSet=CAP_SYS_ADMIN CAP_NET_ADMIN CAP_SETUID CAP_SETGID CAP_CHOWN CAP_FOWNER CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH CAP_MKNOD CAP_SYS_CHROOT CAP_KILL CAP_SYS_RESOURCE
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
    # Round D, D1: every slot proxy runs in this slice. Its ceiling is counted inside the host's
    # budget for guests (the agent's driver.egressSliceMib, 1536 by default), and each proxy has
    # its own (128 MiB, one core) on top. Round E, E4: the slice as a whole gets a quarter of the
    # host's cores, at least one (1 of the 4 on a run host): however many proxies are busy at
    # once, the guests, the agent and the relay keep the other three quarters.
    local cores; cores=$(nproc 2>/dev/null || echo 4)
    local egress_cpu=$(( cores * 25 ))
    (( egress_cpu < 100 )) && egress_cpu=100
    cat > "$SYSTEMD_DIR/opensteer-pool-egress.slice" <<EOF
[Unit]
Description=Opensteer pool slot proxies

[Slice]
MemoryAccounting=yes
MemoryMax=${OSP_EGRESS_SLICE_MIB}M
CPUAccounting=yes
CPUQuota=${egress_cpu}%
TasksMax=4096
EOF
    # The relay (pool-runtime-in-guest.md, decisions 4 and 5): its own user, the only one the
    # host's rules let reach a guest's bridge port. Its own key reaches it as a credential.
    install -d -m 0755 "$RELAY_ETC"
    cat > "$RELAY_ETC/relay.json" <<EOF
{ "listen": { "host": "0.0.0.0", "port": $OSP_RELAY_PORT },
  "certificate": "$RELAY_ETC/relay-cert.pem",
  "authSocket": "/run/opensteer-pool-relay/relay.sock" }
EOF
    chmod 0644 "$RELAY_ETC/relay.json"
    cat > "$SYSTEMD_DIR/opensteer-pool-relay.service" <<EOF
[Unit]
Description=Opensteer pool relay
After=opensteer-pool-agent.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=opensteer-pool-relay
Group=opensteer-pool-relay
LoadCredential=relay-key:$ETC/relay-key.pem
ExecStart=$OPT/node/bin/node $OPT/agent/relay.mjs $RELAY_ETC/relay.json
Restart=always
RestartSec=1
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_UNIX
RestrictNamespaces=yes
LockPersonality=yes
MemoryDenyWriteExecute=no
SystemCallArchitectures=native
LimitNOFILE=8192

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable opensteer-pool-host.service >/dev/null
}

kernel_settings() {
    # Transparent huge pages only where asked for (Firecracker's guest memory): the measured
    # restore path. KSM off: no page is ever merged between two guests.
    echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
    echo madvise > /sys/kernel/mm/transparent_hugepage/defrag
    if [[ -w /sys/kernel/mm/ksm/run ]]; then echo 2 > /sys/kernel/mm/ksm/run; echo 0 > /sys/kernel/mm/ksm/run; fi
    # Guest memory is never written anywhere but the encrypted array: no swap, no core dumps.
    swapoff -a
    # And no swap after a reboot either.
    sed -i -E 's/^([^#].*[[:space:]]swap[[:space:]].*)$/# disabled by opensteer-pool: \1/' /etc/fstab
    # Ubuntu enables apport.service by default, which overwrites kernel.core_pattern on boot.
    systemctl disable --now apport.service 2>/dev/null || true
    systemctl mask apport.service 2>/dev/null || true
    cat > /etc/sysctl.d/90-opensteer-pool.conf <<'EOF'
kernel.core_pattern=|/bin/false
fs.suid_dumpable=0
kernel.kptr_restrict=2
kernel.dmesg_restrict=1
net.ipv4.ip_forward=1
net.ipv4.conf.all.rp_filter=1
vm.swappiness=0
EOF
    sysctl -q --system
    install -d -m 0755 /etc/systemd/coredump.conf.d /etc/systemd/system.conf.d
    printf '[Coredump]\nStorage=none\nProcessSizeMax=0\n' > /etc/systemd/coredump.conf.d/opensteer-pool.conf
    printf '[Manager]\nDefaultLimitCORE=0\n' > /etc/systemd/system.conf.d/opensteer-pool.conf
    systemctl daemon-reexec
    # Linux 6.1+ cgroup v2 attach latency (Firecracker production host setup).
    mount -o remount,favordynmods /sys/fs/cgroup || die "could not remount cgroup2 with favordynmods"
}

host_firewall() {
    # The agent's own interfaces: the Home interface from the Homes' range, the administration
    # interface from the provisioner's range only, neither from any slot. The slots are
    # filtered in their own namespaces and by the agent's table (inet opensteer_pool).
    install -d -m 0755 "$ETC/nft"
    cat > "$ETC/nft/host.nft" <<EOF
table inet opensteer_pool_host
delete table inet opensteer_pool_host
table inet opensteer_pool_host {
  chain input {
    type filter hook input priority -20; policy accept;
    iifname "ospv*" tcp dport { $OSP_AGENT_PORT, $OSP_ADMIN_PORT, $OSP_RELAY_PORT } drop
    tcp dport { $OSP_AGENT_PORT, $OSP_ADMIN_PORT, $OSP_RELAY_PORT } meta nfproto ipv6 drop
    tcp dport { $OSP_AGENT_PORT, $OSP_RELAY_PORT } ip saddr != { 127.0.0.0/8, $OSP_HOME_CIDR } drop
    tcp dport $OSP_ADMIN_PORT ip saddr != { 127.0.0.0/8, $OSP_PROVISIONER_CIDR } drop
  }
}
EOF
    # Installed through the system's own nftables configuration, so a reload (which starts
    # with "flush ruleset") loads these tables again: this one and the agent's (agent.nft).
    local include="include \"$ETC/nft/*.nft\""
    if ! grep -qxF "$include" /etc/nftables.conf 2>/dev/null; then
        printf '\n%s\n' "$include" >> /etc/nftables.conf
    fi
    systemctl enable nftables.service >/dev/null 2>&1 || true
    nft -f "$ETC/nft/host.nft"
}

parent_whole_disk() {
    local dev=$1 pkname=""
    pkname=$(lsblk -ndo PKNAME "$dev" 2>/dev/null | head -n1 || true)
    if [[ -n $pkname ]]; then
        readlink -f "/dev/$pkname" 2>/dev/null || printf '/dev/%s\n' "$pkname"
        return 0
    fi
    # Fallback strip of Linux partition suffixes (/dev/nvme0n1p1 -> /dev/nvme0n1, /dev/sda1 -> /dev/sda).
    if [[ $dev =~ ^(/dev/nvme[0-9]+n[0-9]+)p[0-9]+$ ]]; then
        printf '%s\n' "${BASH_REMATCH[1]}"
    elif [[ $dev =~ ^(/dev/[a-z]+)[0-9]+$ ]]; then
        printf '%s\n' "${BASH_REMATCH[1]}"
    fi
}

# Y3: Refuse to wipe or build the scratch array if any candidate member resolves to the durable
# profile disk or the boot/root disk (or its parent whole disk).
guard_scratch_members() {
    local -a candidates=("$@")
    local -a protected_devs=()
    local -a protected_labels=()

    add_protected() {
        local path=$1 label=$2 real parent
        [[ -n $path ]] || return 0
        real=$(readlink -f "$path" 2>/dev/null || printf '%s' "$path")
        [[ -n $real ]] || return 0
        protected_devs+=("$real")
        protected_labels+=("$label")
        parent=$(parent_whole_disk "$real" || true)
        if [[ -n $parent && $parent != "$real" ]]; then
            protected_devs+=("$parent")
            protected_labels+=("$label")
        fi
    }

    local boot_src
    boot_src=$(findmnt -n -o SOURCE --target / 2>/dev/null || true)
    [[ -n $boot_src ]] || die "could not determine root/boot disk via findmnt; refusing to wipe scratch SSDs"
    add_protected "$boot_src" "boot disk"

    # Z10: Fail closed when a profile disk is configured or required and its path is not a block device
    # (closes the standalone `saved-state-array` gap where a missing by-id symlink would otherwise
    # resolve to its own path and fail to protect an unmounted durable profile disk).
    if [[ -n $OSP_PROFILE_DISK || ${OSP_REQUIRE_PROFILE_DISK:-0} == 1 ]]; then
        if [[ -z $OSP_PROFILE_DISK ]] || ! is_block_device "$OSP_PROFILE_DISK"; then
            die "REFUSED: configured durable profile disk '${OSP_PROFILE_DISK:-unset}' is not present as a block device; refusing to wipe or build saved-state array"
        fi
        add_protected "$OSP_PROFILE_DISK" "durable profile disk"
    fi
    if is_block_device "$FIXED_PROFILE_DISK_DEVICE"; then
        add_protected "$FIXED_PROFILE_DISK_DEVICE" "durable profile disk"
    fi
    local mounted_profile_src
    mounted_profile_src=$(findmnt -n -o SOURCE --target "$OSP_PROFILES_ROOT" 2>/dev/null || true)
    if [[ -n $mounted_profile_src ]]; then
        add_protected "$mounted_profile_src" "durable profile disk"
    fi

    local disk member_real member_parent i
    for disk in "${candidates[@]}"; do
        is_block_device "$disk" || die "scratch SSD candidate $disk is not a block device"
        member_real=$(readlink -f "$disk")
        member_parent=$(parent_whole_disk "$member_real" || true)
        for (( i = 0; i < ${#protected_devs[@]}; i++ )); do
            if [[ $member_real == "${protected_devs[$i]}" ]] || [[ -n $member_parent && $member_parent == "${protected_devs[$i]}" ]]; then
                die "REFUSED: scratch SSD member $disk ($member_real) matches the ${protected_labels[$i]} (${protected_devs[$i]}); refusing to wipe or build saved-state array"
            fi
        done
    done
}

saved_state_array() {
    install -d -m 0700 "$RUN"
    if mountpoint -q "$ARRAY"; then
        install -d -m 0700 -o root -g root "$ARRAY/jail" "$ARRAY/saved"
        return
    fi
    # shellcheck disable=SC2206
    local disks=($OSP_LOCAL_SSDS)
    (( ${#disks[@]} > 0 )) || die "no Local SSD found at $OSP_LOCAL_SSDS"
    is_block_device "${disks[0]}" || die "no Local SSD found at $OSP_LOCAL_SSDS"
    guard_scratch_members "${disks[@]}"
    local device
    if (( ${#disks[@]} > 1 )); then
        # Striped: saves and wakes are bounded by the array's bandwidth.
        mdadm --stop /dev/md/osp-saved 2>/dev/null || true
        for disk in "${disks[@]}"; do wipefs -a -q "$disk"; done
        mdadm --create /dev/md/osp-saved --run --force --level=0 --chunk=256 \
            --raid-devices=${#disks[@]} --homehost=any --name=osp-saved "${disks[@]}"
        device=/dev/md/osp-saved
    else
        device=${disks[0]}
    fi
    # A fresh random key held only by the kernel: a reboot or a lost disk makes every saved
    # state unreadable, by design. The key never touches a file.
    cryptsetup close "$MAPPER" 2>/dev/null || true
    cryptsetup open --type plain --cipher aes-xts-plain64 --key-size 512 --hash plain \
        --key-file /dev/urandom --keyfile-size 64 "$device" "$MAPPER"
    # XFS with reflinks: each guest gets its own copy of the root image without the bytes.
    mkfs.xfs -q -f -m reflink=1 "/dev/mapper/$MAPPER"
    install -d -m 0700 "$ARRAY"
    mount -o noatime,nosuid "/dev/mapper/$MAPPER" "$ARRAY"
    chmod 0700 "$ARRAY"
    # On the array itself: the agent checks its roots share this file's encrypted filesystem.
    install -d -m 0700 -o root -g root "$ARRAY/jail" "$ARRAY/saved"
    uuidgen > "$ARRAY/array-id"
    chmod 0600 "$ARRAY/array-id"
    log "saved-state array ready on $device"
}

stage_images() {
    install -d -m 0755 "$ARRAY/images"
    if [[ -f $STATE/images/rootfs.ext4 ]]; then
        for name in vmlinux rootfs.ext4 manifest.json; do
            if ! cmp -s "$STATE/images/$name" "$ARRAY/images/$name" 2>/dev/null; then
                cp --sparse=always "$STATE/images/$name" "$ARRAY/images/$name.new"
                chmod 0444 "$ARRAY/images/$name.new"
                mv "$ARRAY/images/$name.new" "$ARRAY/images/$name"
            fi
        done
    else
        log "no guest image in $STATE/images yet (build it with guest/build-image.sh)"
    fi
}

check() {
    local failed=0
    expect() { # name actual wanted
        if [[ $2 == "$3" ]]; then printf '  ok   %-28s %s\n' "$1" "$2"
        else printf '  FAIL %-28s %s (want %s)\n' "$1" "$2" "$3"; failed=1; fi
    }
    expect "thp" "$(grep -o '\[[a-z]*\]' /sys/kernel/mm/transparent_hugepage/enabled)" "[madvise]"
    expect "thp defrag" "$(grep -o '\[[a-z+]*\]' /sys/kernel/mm/transparent_hugepage/defrag)" "[madvise]"
    expect "favordynmods" "$(grep -c ' /sys/fs/cgroup cgroup2 .*favordynmods' /proc/mounts)" "1"
    expect "swap in fstab" "$(grep -cE '^[^#].*[[:space:]]swap[[:space:]]' /etc/fstab)" "0"
    local name
    for name in $NAMED_VULNERABILITIES; do
        expect "cpu $name" "$(cut -c1-10 "/sys/devices/system/cpu/vulnerabilities/$name" 2>/dev/null | grep -c '^Vulnerable')" "0"
    done
    expect "ksm" "$(cat /sys/kernel/mm/ksm/run 2>/dev/null || echo 0)" "0"
    # Re-check finding 6: what the kernel answered when the agent moved each VMM's kvm-pit
    # thread into the VMM's cgroup (written by the agent once a guest has started).
    local kvm_pit="/run/opensteer-pool/kvm-pit.json"
    [[ -n ${OSP_RUN_DIR:-} ]] && kvm_pit="$OSP_RUN_DIR/kvm-pit.json"
    if [[ -f "$kvm_pit" ]]; then
        expect "kvm-pit refused" "$(sed -E 's/.*"refused":([0-9]+).*/\1/' "$kvm_pit")" "0"
    else
        printf '  ---- %-28s %s\n' "kvm-pit" "no guest started since boot"
    fi
    local smt
    smt=$(cat /sys/devices/system/cpu/smt/active 2>/dev/null ||
        { [[ ${OSP_ONE_THREAD_PER_CORE:-} == declared ]] && echo 0 || echo unreadable; })
    expect "smt active" "$smt" "0"
    expect "threads per core" "$(lscpu | awk -F: '/Thread\(s\) per core/ {gsub(/ /,"",$2); print $2}')" "1"
    expect "swap" "$(awk 'NR>1' /proc/swaps | wc -l)" "0"
    expect "core_pattern" "$(cat /proc/sys/kernel/core_pattern)" "|/bin/false"
    expect "ip_forward" "$(cat /proc/sys/net/ipv4/ip_forward)" "1"
    expect "array mounted" "$(mountpoint -q "$ARRAY" && echo yes || echo no)" "yes"
    expect "array encrypted" "$(cryptsetup status "$MAPPER" 2>/dev/null | awk '/type:/ {print $2}')" "PLAIN"
    expect "array cipher" "$(cryptsetup status "$MAPPER" 2>/dev/null | awk '/cipher:/ {print $2}')" "aes-xts-plain64"
    if [[ -n $OSP_PROFILE_DISK ]]; then
        local expected_profile actual_profile mounted_profile
        expected_profile=$(readlink -f "$OSP_PROFILE_DISK" 2>/dev/null || echo missing)
        mounted_profile=$(findmnt -n -o SOURCE --target "$OSP_PROFILES_ROOT" 2>/dev/null || true)
        actual_profile=$(if [[ -n $mounted_profile ]]; then readlink -f "$mounted_profile" 2>/dev/null || echo "$mounted_profile"; else echo unmounted; fi)
        expect "profiles mounted" "$(mountpoint -q "$OSP_PROFILES_ROOT" && echo yes || echo no)" "yes"
        expect "profiles device" "$actual_profile" "$expected_profile"
    fi
    expect "firecracker" "$(sha256sum "$OPT/bin/firecracker" | cut -d' ' -f1)" "$FC_SHA256"
    expect "jailer" "$(sha256sum "$OPT/bin/jailer" | cut -d' ' -f1)" "$JAILER_SHA256"
    expect "node" "$("$OPT/node/bin/node" --version)" "$NODE_VERSION"
    expect "kvm" "$([[ -c /dev/kvm ]] && echo present)" "present"
    expect "cgroup v2" "$(stat -fc %T /sys/fs/cgroup)" "cgroup2fs"
    return $failed
}

case "$CMD" in
    install)
        require_host
        install_packages
        install_binaries
        install_users
        host_key
        save_host_env
        install_units
        mount_profile_disk 1
        kernel_settings
        host_firewall
        saved_state_array
        stage_images
        check
        ;;
    boot)
        require_host
        mount_profile_disk 0
        kernel_settings
        host_firewall
        saved_state_array
        stage_images
        ;;
    verify-profiles-mount)
        verify_profile_mount
        ;;
    wait-profile-disk)
        wait_for_profile_disk "${2:-$FIXED_PROFILE_DISK_DEVICE}"
        ;;
    parent-whole-disk)
        [[ -n ${2:-} ]] || die "usage: $0 parent-whole-disk <device>"
        parent_whole_disk "$2"
        ;;
    saved-state-array)
        saved_state_array
        ;;
    check)
        check
        ;;
    *)
        echo "usage: $0 install|boot|verify-profiles-mount|wait-profile-disk|parent-whole-disk|saved-state-array|check" >&2
        exit 2
        ;;
esac
