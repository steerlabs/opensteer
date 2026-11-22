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
- `Restart=always`, `RestartSec=1` growing to 60 s over six steps (`RestartSteps`,
  `RestartMaxDelaySec`), and no start limit (`StartLimitIntervalSec=0`): a journal write that
  fails (a full or failing disk, a failed directory sync) ends the agent with status 70, and the
  restarted agent's recovery reads the disk. If writes keep failing, the agent keeps being
  started, at most once a minute, and comes back by itself once the disk takes writes again; it
  never stays down for good. Meanwhile guests keep running (the agent's exit does not end
  them), no Home call is answered, nothing is saved to disk, and no parked state is discarded:
  an expiry that passed while the agent was down is enforced at its next start, before any call
  is served. Watch for `agent.fatal` in the agent's log.
- No mount-namespace options (`ProtectSystem`, `PrivateTmp`): the agent creates network
  namespaces and bind mounts the host must see. This is the one place the unit is wider than a
  typical service; the jailer confines each VMM instead.

Each guest's VMM: the slot's own uid/gid (`slotUidBase + index`), a chroot on the array, its
network namespace, a new PID namespace, cgroup limits `memory.high` = guest memory + 512 MiB
(reclaim and slow-down start there) and `memory.max` = twice the guest memory + 512 MiB (page
cache of the memory file is charged to the VMM: a save writes it, a restore maps it; at guest

- 512 MiB a save under contention was OOM-killed on the first real-host run), `cpu.max` = vCPUs,
  `pids.max=256`, `no-file=1024`, `fsize` = the larger of its memory and its profile disk + 64
  MiB, Firecracker's default seccomp filter, no serial console (`8250.nr_uarts=0`), output to
  `/dev/null`. Its `kvm-pit/<pid>` kernel thread is moved into its cgroup after boot and restore
  (Firecracker's production guide), best effort. Each answer is logged (`kvm-pit`, with the
  kernel's error code) and kept in `/run/opensteer-pool/kvm-pit.json`, which `setup-host.sh
check` reads. A kernel that refuses the move leaves the thread in the root cgroup: the time a
  guest makes its timer thread spend is then not charged to that guest's CPU limit. One limit over all guests
  (`guests/memory.max`) leaves the host and the agent max(2 GiB, 10 %) of memory; the agent has
  `OOMScoreAdjust=-900`.

Each slot's egress proxy: a transient socket unit `opensteer-pool-egress-<index>.socket`
listening on `172.16.0.1:3128` in the slot's namespace for the slot's whole life, and its
service `opensteer-pool-egress-<index>.service` (socket-activated) as the slot's proxy uid
(`egressUidBase + index`), with no capabilities, `NoNewPrivileges`, `ProtectSystem=strict`,
`PrivateTmp`, `PrivateDevices`, credentials through `LoadCredential`, and output discarded. A
diagnostics host (`driver.egressLog`) gets refusal counts by reason only: never a host name,
address or path. The process runs while the guest runs or is paused in memory; it is stopped
when the guest is saved to disk or stopped, so a slot parked on disk costs a socket, not a
process; the next connection starts it, and a connection that arrives first waits in the
socket's backlog.

Bounds (round D, D1):

- Every proxy runs in `opensteer-pool-egress.slice` (made by `setup-host.sh`, `MemoryMax` =
  `driver.egressSliceMib`, 1536 MiB by default). Each has `CPUQuota=100%` (one core),
  `CPUWeight=100` and `IOWeight=100` (equal between proxies), `MemoryMax` =
  `driver.egress.memoryMib` (128 MiB: one reached 80 MiB on run 5), `TasksMax=32`, and
  `driver.egress.maxConnections` (64 connections: one Chromium held at most 7, 9 while
  flooding, and Chromium opens at most 32 to one proxy).
- The slice is counted inside the host's budget for guests: `guests/memory.max` is the host's
  memory less max(2 GiB, 10 %) less the slice. On an n2-standard-8 (32 GiB): 32 - 3.2 - 1.5 =
  27.3 GiB for guests, which holds 10 guests in memory at their `memory.high` of 2.5 GiB (25
  GiB); their 10 proxies take at most 1280 MiB of the slice's 1536 MiB. A host holds 10
  guests running or paused in memory; any number may be parked on disk.
- The agent enforces that number (round E, E4), from the same arithmetic
  (`apps/pool-agent/src/capacity.ts`): a start, or a wake from disk, is let in only if the
  guest's `memory.high` fits in the guests' budget beside every guest already in memory and
  its proxy fits in the slice (12 at 128 MiB). If it does not, guests paused in memory are saved
  to disk first, oldest park first. If that is not enough (every guest in memory is running or
  busy), the call is refused before anything is written, as `unavailable` ("try again
  later"), which a Home's journal sends again later. No guest or proxy is ever let in that the
  kernel would have to kill another for.
- The slice as a whole has `CPUQuota` = a quarter of the host's cores, at least one core
  (`setup-host.sh`: 100 % on the run hosts, an n2-standard-8 with one thread per core, which has 4
  cores). However many proxies are busy, the
  guests, the agent and the relay keep three quarters of the host.
- systemd's crash protection stays on: five starts in 120 s, with a restart delay that backs
  off from 1 s to 30 s (with a 30 s window that backoff never tripped the limit, run 5). The agent's own stops reset the counter, so only the proxy's own failures
  count. A proxy that trips the limit stays down, with its socket, until the slot's next start
  or wake, which defines the socket again whenever it is not listening (a stop in between
  resets the failure and systemd unloads the transient socket); meanwhile that guest has no network, nothing else is affected, and the
  slot's status says `proxy: "down"`.

## Agent configuration

`/etc/opensteer-pool/agent.json` (mode 0600), for example:

```json
{
  "journal": "/var/lib/opensteer-pool/journal",
  "listen": { "host": "0.0.0.0", "port": 7310 },
  "admin": {
    "listen": { "host": "0.0.0.0", "port": 7311 },
    "provisionerKey": "<SPKI base64>",
    "hostId": "<this host's id, as the provisioner enrolled it>",
    "hostKeyFile": "/etc/opensteer-pool/host-key.pem"
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
    "profilesRoot": "/var/lib/opensteer-pool/profiles",
    "credentialsRoot": "/etc/opensteer-pool/credentials",
    "slotUidBase": 200000,
    "egressUidBase": 300000,
    "egress": {
      "node": "/opt/opensteer-pool/node/bin/node",
      "main": "/var/lib/opensteer-pool/images/egress/dist/egress-main.js"
    },
    "network": {
      "resolvers": ["8.8.8.8", "1.1.1.1"],
      "privateResolvers": [],
      "hostUpstreams": [],
      "relayUid": null
    },
    "guestMode": "bench"
  }
}
```

## Not done by this script

- Building the guest image: `guest/build-image.sh` (needs Docker and the runtime images).
- Cloud firewall rules and the host's placement: the provisioner's.
- Host kernel and microcode updates: the image's update policy (Firecracker: patch regularly).
- Rate limiters on the guests' block and network devices: not set yet.

## What passes between a provisioner and a Home

A Home's private keys are made on the Home and never leave it (round D, D2). Only public
material passes either way.

| From        | To          | What                                                                                                                                                                                                             |
| ----------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home        | provisioner | the public halves of its three keys for the slot: the slot key (signs its calls to the agent), the relay key (opens the relay's tunnels) and the ticket key (signs attach tickets, which the guest alone trusts) |
| provisioner | Home        | the agent's URL, the slot id and term, the slot's control key, the host key, the relay key, and the relay's host and port                                                                                        |

`replace-key` gives a slot a new Home: its three public keys replace the old set together, in
one journal write, at a higher term, and the old set is refused from that write on. The guest
does not survive it (its ticket key is fixed at boot): it is ended and its saved state
discarded, and the next start is cold; tabs come back by address.
