#!/usr/bin/env bash
# Prepares a pool host and keeps it prepared. Idempotent: run it again at any time.
#
#   setup-host.sh install   packages, pinned binaries, users, units, then `boot`
#   setup-host.sh boot      every boot (opensteer-pool-host.service): the encrypted saved-state
#                           array with a fresh key, kernel settings, the guest images on the array
#   setup-host.sh check     prints every setting this host must have and fails on a wrong one
#
# Every setting and its reason: apps/pool-agent/host/HOST-SETUP.md. Ubuntu 24.04, x86_64.
# Downloads go through the environment's http(s)_proxy when one is set.
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

readonly OPT=/opt/opensteer-pool
readonly STATE=/var/lib/opensteer-pool        # durable: journal, driver state, profiles, images
readonly ARRAY=/srv/opensteer-pool            # encrypted Local SSD array: jails, saved state
readonly RUN=/run/opensteer-pool
readonly MAPPER=osp-saved
: "${OSP_LOCAL_SSDS:=/dev/disk/by-id/google-local-nvme-ssd-*}"
: "${OSP_HOME_CIDR:=10.0.0.0/8}"              # who may reach the agent's Home interface
: "${OSP_PROVISIONER_CIDR:=127.0.0.1/32}"     # who may reach its administration interface
: "${OSP_AGENT_PORT:=7310}"
: "${OSP_ADMIN_PORT:=7311}"
: "${OSP_RELAY_PORT:=7312}"

log() { printf 'setup-host: %s\n' "$*" >&2; }
die() { log "$*"; exit 1; }

require_host() {
    [[ $(id -u) == 0 ]] || die "run as root"
    [[ $(uname -m) == x86_64 ]] || die "x86_64 only"
    [[ -c /dev/kvm ]] || die "/dev/kvm is missing: enable nested virtualization or use bare metal"
    [[ -f /sys/fs/cgroup/cgroup.controllers ]] || die "the unified cgroup v2 hierarchy is required"
    # One thread per core: no SMT sibling is shared between two people's guests. A host whose
    # thread status cannot be read fails unless it is declared one-thread-per-core.
    if [[ -r /sys/devices/system/cpu/smt/active ]]; then
        [[ $(cat /sys/devices/system/cpu/smt/active) == 0 ]] || die "SMT is active: create the host with one thread per core"
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
        state=$(cat "/sys/devices/system/cpu/vulnerabilities/$name" 2>/dev/null || echo "Unknown")
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
        nftables iproute2 mdadm cryptsetup-bin xfsprogs util-linux curl ca-certificates xz-utils uuid-runtime openssl
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
    rm -rf --one-file-system "$unpack"
    fetch "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" \
        "$OPT/download/node.tar.xz" "$NODE_SHA256"
    if [[ ! -x $OPT/node/bin/node ]] || [[ $("$OPT/node/bin/node" --version) != "$NODE_VERSION" ]]; then
        rm -rf --one-file-system "$OPT/node.new"
        install -d -m 0755 "$OPT/node.new"
        tar -xJf "$OPT/download/node.tar.xz" -C "$OPT/node.new" --strip-components=1 --no-same-owner
        rm -rf --one-file-system "$OPT/node"
        mv "$OPT/node.new" "$OPT/node"
    fi
    install -d -m 0755 "$STATE/images"
    fetch "$KERNEL_URL" "$STATE/images/vmlinux.download" "$KERNEL_SHA256"
}

host_key() {
    # The host's own key: administration replies are signed with it, and the provisioner pins its
    # public half when it enrolls the host (review G2). Made once, root only.
    install -d -m 0700 /etc/opensteer-pool
    if [[ ! -f /etc/opensteer-pool/host-key.pem ]]; then
        (umask 077 && openssl genpkey -algorithm ed25519 -out /etc/opensteer-pool/host-key.pem)
    fi
    openssl pkey -in /etc/opensteer-pool/host-key.pem -pubout -out /etc/opensteer-pool/host-key.pub
    chmod 0644 /etc/opensteer-pool/host-key.pub
    # The relay presents a certificate for the same key; a Home checks the key, not the
    # certificate's issuer (there is none): pool-runtime-in-guest.md, decision 4.
    if [[ ! -f /etc/opensteer-pool/host-cert.pem ]]; then
        openssl req -x509 -new -key /etc/opensteer-pool/host-key.pem -subj /CN=opensteer-pool-host \
            -days 3650 -out /etc/opensteer-pool/host-cert.pem
    fi
    chmod 0644 /etc/opensteer-pool/host-cert.pem
}

install_users() {
    # The one local peer allowed to reach a guest's bridge port (the transport relay).
    getent passwd opensteer-pool-relay >/dev/null ||
        useradd --system --no-create-home --shell /usr/sbin/nologin opensteer-pool-relay
}

install_units() {
    # The state root is traversable (the egress users read the egress tree in images/); the
    # journal and driver state inside it are root-only.
    install -d -m 0700 /etc/opensteer-pool "$STATE/journal" "$STATE/driver"
    install -d -m 0711 "$STATE"
    install -d -m 0711 "$STATE/profiles"
    install -m 0755 "$0" "$OPT/setup-host.sh"
    cat > /etc/systemd/system/opensteer-pool-host.service <<EOF
[Unit]
Description=Opensteer pool host: encrypted saved-state array and kernel settings
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
    cat > /etc/systemd/system/opensteer-pool-agent.service <<EOF
[Unit]
Description=Opensteer pool agent
Requires=opensteer-pool-host.service
After=opensteer-pool-host.service network-online.target nftables.service
Wants=network-online.target
# The agent never stays down for good (re-check finding 7): no start limit; the delay grows.
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=$OPT/node/bin/node $OPT/agent/main.js /etc/opensteer-pool/agent.json
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
    # The relay (pool-runtime-in-guest.md, decisions 4 and 5): its own user, the only one the
    # host's rules let reach a guest's bridge port. The host key reaches it as a credential.
    cat > /etc/opensteer-pool/relay.json <<EOF
{ "listen": { "host": "0.0.0.0", "port": $OSP_RELAY_PORT },
  "certificate": "/etc/opensteer-pool/host-cert.pem",
  "authSocket": "/run/opensteer-pool/relay.sock" }
EOF
    chmod 0644 /etc/opensteer-pool/relay.json
    cat > /etc/systemd/system/opensteer-pool-relay.service <<EOF
[Unit]
Description=Opensteer pool relay
After=opensteer-pool-agent.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=opensteer-pool-relay
Group=opensteer-pool-relay
LoadCredential=host-key:/etc/opensteer-pool/host-key.pem
ExecStart=$OPT/node/bin/node $OPT/agent/relay.mjs /etc/opensteer-pool/relay.json
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
    install -d -m 0755 /etc/opensteer-pool/nft
    cat > /etc/opensteer-pool/nft/host.nft <<EOF
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
    local include='include "/etc/opensteer-pool/nft/*.nft"'
    if ! grep -qxF "$include" /etc/nftables.conf 2>/dev/null; then
        printf '\n%s\n' "$include" >> /etc/nftables.conf
    fi
    systemctl enable nftables.service >/dev/null 2>&1 || true
    nft -f /etc/opensteer-pool/nft/host.nft
}

saved_state_array() {
    install -d -m 0700 "$RUN"
    if mountpoint -q "$ARRAY"; then
        install -d -m 0700 -o root -g root "$ARRAY/jail" "$ARRAY/saved"
        return
    fi
    # shellcheck disable=SC2206
    local disks=($OSP_LOCAL_SSDS)
    [[ -e ${disks[0]} ]] || die "no Local SSD found at $OSP_LOCAL_SSDS"
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
    if [[ -f /run/opensteer-pool/kvm-pit.json ]]; then
        expect "kvm-pit refused" "$(sed -E 's/.*"refused":([0-9]+).*/\1/' /run/opensteer-pool/kvm-pit.json)" "0"
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
    expect "firecracker" "$(sha256sum "$OPT/bin/firecracker" | cut -d' ' -f1)" "$FC_SHA256"
    expect "jailer" "$(sha256sum "$OPT/bin/jailer" | cut -d' ' -f1)" "$JAILER_SHA256"
    expect "node" "$("$OPT/node/bin/node" --version)" "$NODE_VERSION"
    expect "kvm" "$([[ -c /dev/kvm ]] && echo present)" "present"
    expect "cgroup v2" "$(stat -fc %T /sys/fs/cgroup)" "cgroup2fs"
    return $failed
}

case "${1:-}" in
    install)
        require_host
        install_packages
        install_binaries
        install_users
        host_key
        install_units
        kernel_settings
        host_firewall
        saved_state_array
        stage_images
        check
        ;;
    boot)
        require_host
        kernel_settings
        host_firewall
        saved_state_array
        stage_images
        ;;
    check)
        check
        ;;
    *)
        echo "usage: $0 install|boot|check" >&2
        exit 2
        ;;
esac
