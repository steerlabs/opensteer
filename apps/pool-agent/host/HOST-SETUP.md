# Pool host setup

`setup-host.sh install` prepares a fresh Ubuntu 24.04 x86_64 host; `opensteer-pool-host.service`
runs `setup-host.sh boot` on every boot; `setup-host.sh check` verifies the result. Every
setting, and why:

## Host shape

| Setting                            | Value                                                                              | Reason                                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| CPU                                | x86_64 with `/dev/kvm` (nested virtualization on Google Cloud, or bare metal)      | Firecracker needs KVM. The agent is the same on both.                                                                            |
| SMT                                | one thread per core (`--threads-per-core=1`); setup refuses a host with SMT active | Two people's guests never share a core's sibling threads (Firecracker production host setup: disable SMT for tenant separation). |
| cgroups                            | unified v2 only                                                                    | `cgroup.kill` ends a slot's whole subtree atomically; Firecracker recommends v2 for restore latency.                             |
| `favordynmods` on `/sys/fs/cgroup` | remount at boot                                                                    | Firecracker's mitigation for the Linux 6.1+ `KVM_CREATE_VM` cgroup attach regression.                                            |

## Binaries (pinned by SHA-256)

| File                                                                      | Pin             | Reason                                                                                                                                               |
| ------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `firecracker-v1.18.0-x86_64.tgz`                                          | `1ac8eec8…23cd` | The release tarball as published; its checksum file matches.                                                                                         |
| `firecracker` → `/opt/opensteer-pool/bin/firecracker`                     | `b33f46cd…a2ba` | The statically linked musl VMM the jailer requires; the measured binary.                                                                             |
| `jailer` → `/opt/opensteer-pool/bin/jailer`                               | `ddadbaa1…a208` | The same release's jailer. Both are root-owned and writable by root only: the jailer trusts its exec file and paths.                                 |
| Node.js `v24.15.0` → `/opt/opensteer-pool/node`                           | `47265558…0f6`  | Runs the agent and each slot's egress proxy.                                                                                                         |
| Guest kernel `vmlinux-6.1.188` (Firecracker CI `20261118-6d7cfa9c6b53-0`) | `c7f899cb…0a40` | The measured guest kernel. Booted with `clocksource=kvm-clock`: the measurement found this kernel on `tsc`, which `clock_realtime` does not advance. |

## Memory and disks

| Setting                                             | Value                                                                                                                                                                                 | Reason                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved-state array                                   | all Local SSDs striped (`mdadm` RAID 0, 256 KiB chunk), then `dm-crypt` plain `aes-xts-plain64`, 512-bit key from `/dev/urandom`, XFS with reflinks, mounted at `/srv/opensteer-pool` | Saved memory and VM state are the most sensitive thing we hold. The key exists only in the kernel; a reboot or a lost disk makes every saved state unreadable by design, and the agent's incarnation (boot id + array id) changes, so it discards them all. Striping gives the measured save and wake bandwidth. XFS reflinks give each jail its own copy of the root image (its own page cache) without copying bytes. |
| Jails and saved images                              | on the array only                                                                                                                                                                     | Nothing of a guest's memory is written anywhere else.                                                                                                                                                                                                                                                                                                                                                                   |
| Profiles, journal, driver state, guest images       | `/var/lib/opensteer-pool` on the persistent disk                                                                                                                                      | Losing a host must never lose a profile; the journal must survive an agent restart.                                                                                                                                                                                                                                                                                                                                     |
| Swap                                                | off (`swapoff -a`, `vm.swappiness=0`)                                                                                                                                                 | Guest memory must never be written to a swap device (Firecracker production host setup).                                                                                                                                                                                                                                                                                                                                |
| Core dumps                                          | `kernel.core_pattern=\|/bin/false`, `fs.suid_dumpable=0`, systemd-coredump `Storage=none`, `DefaultLimitCORE=0`, `LimitCORE=0` on the agent and every egress unit                     | A VMM core dump would be a copy of guest memory.                                                                                                                                                                                                                                                                                                                                                                        |
| Transparent huge pages                              | `enabled=madvise`, `defrag=madvise`                                                                                                                                                   | Firecracker asks for THP on guest memory (`huge_pages: Transparent`); the stock file-backed restore with THP was the fastest measured path. Nothing else on the host gets huge pages unasked.                                                                                                                                                                                                                           |
| KSM                                                 | `run=2` (unmerge) then `0`                                                                                                                                                            | No page is ever shared between two people's guests (a timing channel; Firecracker says to disable it).                                                                                                                                                                                                                                                                                                                  |
| `kernel.kptr_restrict=2`, `kernel.dmesg_restrict=1` |                                                                                                                                                                                       | Ordinary hardening of a multi-tenant host.                                                                                                                                                                                                                                                                                                                                                                              |

## Network

| Setting                                                  | Value                                                                                                                                                                                                                                                                                                                                        | Reason                                                                                                                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `net.ipv4.ip_forward=1`, `rp_filter=1`                   |                                                                                                                                                                                                                                                                                                                                              | A slot's egress proxy leaves through its veth and the host's NAT.                                                                                                                            |
| Agent table `inet opensteer_pool` (applied by the agent) | traffic from any `ospv*` veth: IPv6 dropped; DNS only to the configured resolvers; IPv4 to `0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/3` dropped; only TCP otherwise; nothing to the host itself except configured upstream ports; only the relay user may connect to a guest's bridge port | The egress proxy may reach the public internet and nothing else: not the cloud metadata addresses (IPv4 `169.254.169.254`, IPv6 by dropping all IPv6), not the VPC, not the host's services. |
| Per-slot namespace table `inet osp`                      | guest (`tap0`) may reach only `172.16.0.1:3128` (its egress proxy); it forwards nowhere; the gate set closes the TAP entirely while a guest is parked or waking                                                                                                                                                                              | One network namespace and one TAP per guest; no route out except the proxy, and no traffic before the clock is stepped.                                                                      |
| Host table `inet opensteer_pool_host`                    | agent ports `7310` (Home) and `7311` (provisioner) only from `OSP_HOME_CIDR` and loopback; IPv6 refused                                                                                                                                                                                                                                      | The agent answers only signed requests, and is reachable only from where they come from.                                                                                                     |

## The agent service

`opensteer-pool-agent.service` runs as root because the jailer must (it creates the chroot,
device nodes, cgroups and joins the namespace before dropping to the slot's user). It is
bounded instead by:

- `CapabilityBoundingSet=` limited to what the jailer and namespace work need
  (`CAP_SYS_ADMIN CAP_NET_ADMIN CAP_SETUID CAP_SETGID CAP_CHOWN CAP_FOWNER CAP_DAC_OVERRIDE
CAP_DAC_READ_SEARCH CAP_MKNOD CAP_SYS_CHROOT CAP_KILL CAP_SYS_RESOURCE`), `NoNewPrivileges`,
  `SystemCallArchitectures=native`.
- `Delegate=yes`, `KillMode=process`: guests live in the agent's delegated cgroup subtree and
  outlive an agent restart; the next agent reconciles with them.
- No mount-namespace options (`ProtectSystem`, `PrivateTmp`): the agent creates network
  namespaces and bind mounts the host must see. This is the one place the unit is wider than a
  typical service; the jailer confines each VMM instead.

Each guest's VMM: the slot's own uid/gid (`slotUidBase + index`), a chroot on the array, its
network namespace, a new PID namespace, cgroup limits `memory.max` = twice the guest memory + 512 MiB (page cache of the memory file is charged to the VMM: a save writes it, a restore maps it; at guest + 512 MiB a save under contention was OOM-killed),
`cpu.max` = vCPUs, `pids.max=256`, `no-file=1024`, Firecracker's default seccomp filter, no
serial console (`8250.nr_uarts=0`), output to `/dev/null`.

Each slot's egress proxy: a transient unit `opensteer-pool-egress-<index>.service` as the slot's
proxy uid (`egressUidBase + index`) in the slot's namespace, with no capabilities,
`NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`, `PrivateDevices`, `MemoryMax=256M`,
`TasksMax=64`, credentials through `LoadCredential`, output discarded (it would be the person's
browsing). It runs while the guest runs or is paused in memory, and is stopped when the guest
is saved to disk or stopped.

## Agent configuration

`/etc/opensteer-pool/agent.json` (mode 0600), for example:

```json
{
  "journal": "/var/lib/opensteer-pool/journal",
  "listen": { "host": "0.0.0.0", "port": 7310 },
  "admin": { "listen": { "host": "0.0.0.0", "port": 7311 }, "provisionerKey": "<SPKI base64>" },
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
    "arrayIdFile": "/run/opensteer-pool/array-id",
    "slotUidBase": 200000,
    "egressUidBase": 300000,
    "egress": {
      "node": "/opt/opensteer-pool/node/bin/node",
      "main": "/var/lib/opensteer-pool/images/egress/dist/egress-main.js"
    },
    "network": { "resolvers": ["8.8.8.8", "1.1.1.1"], "hostUpstreamPorts": [], "relayUid": null },
    "guestMode": "runtime"
  }
}
```

## Not done by this script

- Building the guest image: `guest/build-image.sh` (needs Docker and the runtime images).
- Cloud firewall rules and the host's placement: the provisioner's.
- Host kernel and microcode updates: the image's update policy (Firecracker: patch regularly).
- Moving each VMM's `kvm-pit` kernel thread into its cgroup (Firecracker's CPU-overhead
  recommendation): not done; to measure first.
