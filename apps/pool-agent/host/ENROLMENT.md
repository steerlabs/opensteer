# Pool host enrolment (`enroll-host.sh`)

`enroll-host.sh` provisions and enrols a browser pool host from the root-only boot specification
and single-use bootstrap token written by `apps/home-provisioner/src/pool-boot.ts`. It is
idempotent: re-running after a crash or reboot repeats only unfinished work and never reformats an
existing profile disk.

## Inputs

```sh
bash enroll-host.sh \
  --boot-spec /root/opensteer-pool-boot.json \
  --bootstrap-token-file /root/opensteer-pool-bootstrap-token
```

Both files must be regular files (never symlinks) owned by `root:root` with mode `0600`. Any
malformed boot spec field or exposed file fails enrolment immediately before modifying the host.
The bootstrap token and the host's private keys are never written to stdout, stderr, or argv.

## Steps

1. **Validate the boot specification** (`hostId`, `generation`, bare `https://` `accountOrigin`,
   Ed25519 SPKI `provisionerKey`, IPv4 `homeCidr`/`provisionerCidr`, `/dev/...`
   `profileDiskDevice`, boolean `everEnrolled`, and distinct `agentPort`/`adminPort`/`relayPort`).
2. **Prepare and mount the durable profile disk** at `/var/lib/opensteer-pool/profiles`
   (`driver.profilesRoot`) using the decision rule below.
3. **Resolve release artifacts** (`agent`, `relay`, `rootfs`, `kernel`, `egress` URLs and SHA-256
   digests) from `POST {accountOrigin}/v1/browser-pool/hosts/{hostId}/boot` (cached root-only at
   `/etc/opensteer-pool/release-artifacts.json` for idempotent retry after a partial run, or read
   from inline `artifacts` in the boot spec for offline tests).
4. **Run `setup-host.sh install`** with the persisted CIDRs, ports, and `OSP_PROFILE_DISK`. This
   installs packages (`e2fsprogs`, `nftables`, `mdadm`, `cryptsetup-bin`, `xfsprogs`, …), pinned
   Firecracker/jailer and Node.js binaries, the `opensteer-pool-relay` user, root-only Ed25519
   `host-key.pem` and `relay-key.pem` (generated once; never overwritten), systemd units, and
   `/etc/opensteer-pool/host.env` (`0600`) so every setting survives reboots.
5. **Fetch and SHA-256-verify each release artifact**, skipping any file already present with the
   expected hash:
   - `/opt/opensteer-pool/agent/main.js` (`0644`)
   - `/opt/opensteer-pool/agent/relay.mjs` (`0644`)
   - `/var/lib/opensteer-pool/images/rootfs.ext4` (`0444`)
   - `/var/lib/opensteer-pool/images/vmlinux` (`0444`)
   - `/var/lib/opensteer-pool/images/egress/dist/egress-main.js` (`0644`)
   - `/var/lib/opensteer-pool/images/manifest.json` (`0444`)
     Then runs `setup-host.sh boot` to stage `vmlinux`, `rootfs.ext4`, and `manifest.json` onto the
     encrypted Local SSD array (`/srv/opensteer-pool/images`), apply persisted `nftables` rules, and
     re-verify the profile disk mount.
6. **Prepare `driver.credentialsRoot` (`/etc/opensteer-pool/credentials`, `0700` on the instance's
   own disk)** and render `/etc/opensteer-pool/agent.json` (`0600`, `driver.requireEgressUpstream:
true`, `driver.egress.accountOrigin`, `driver.guestMode: "runtime"`, `relayUid` of
   `opensteer-pool-relay`). Setting `driver.requireEgressUpstream: true` (making this a pulling
   host) is also what allows a slot deletion to settle: on a pulling host the agent answers
   `credentialsErased: true` whenever the slot's derived credential paths are seen gone (including
   for an unknown slot or repeated delete), whereas a non-pulling host leaves `credentialsErased`
   out for an unknown slot and would hang deletion.
7. **Enrol public keys with Account** via `POST {accountOrigin}/v1/browser-pool/hosts/{hostId}/boot-complete`
   carrying `{ generation, bootstrapToken, hostKey, relayKey }`. Only after HTTP `200` with
   `{"completed":true}`:
   - removes `--bootstrap-token-file`;
   - runs `setup-host.sh verify-profiles-mount`;
   - enables and starts `opensteer-pool-agent.service` and `opensteer-pool-relay.service`.

## Durable profile disk decision rule (X1 / T6)

The durable profile disk self-identifies with ext4 label `osp-profiles` (12 bytes, within ext4's
16-byte volume label limit). Account supplies only `everEnrolled` (from
`browser_pool_hosts.ever_enrolled`) so an automatically replaced never-enrolled host can recover
whether its first boot failed before or after formatting, while a disk that could hold a person's
profile is never formatted.

| `everEnrolled`    | `blkid -o export -p` & `wipefs -n --noheadings`                         | Mountable? | Decision                                                                             |
| ----------------- | ----------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| `false`           | Blank (`blkid` exit `2` empty AND `wipefs -n` exit `0` empty)           | n/a        | **`format-and-mount`** (`mkfs.ext4 -q -m 1 -L osp-profiles`, no `-f`/`-F`)           |
| `false`           | `TYPE=ext4`, `LABEL=osp-profiles`, no `PTTYPE`, single `ext4` signature | `true`     | **`mount-only`** (never format)                                                      |
| `true`            | `TYPE=ext4`, `LABEL=osp-profiles`, no `PTTYPE`, single `ext4` signature | `true`     | **`mount-only`** (never format)                                                      |
| `false` or `true` | `TYPE=ext4`, `LABEL=osp-profiles`                                       | `false`    | **`refuse:unmountable-profile-disk`** (fail loudly; no `mkfs`; agent does not start) |
| `true`            | Blank (`blkid` exit `2` empty AND `wipefs -n` exit `0` empty)           | n/a        | **`refuse:enrolled-host-blank-disk`** (fail loudly; no `mkfs`; agent does not start) |
| `false` or `true` | Any other filesystem, label, partition table, or multi-signature disk   | n/a        | **`refuse:foreign-disk-signature`** (fail loudly; nothing modified)                  |
| `false` or `true` | `blkid` exit not in `{0, 2}` or `wipefs` exit non-zero                  | n/a        | **`refuse:probe-error`** (fail loudly; nothing modified)                             |

## Reboot and anti-fallback protection

- `/etc/opensteer-pool/host.env` (`0600`) persists `OSP_HOME_CIDR`, `OSP_PROVISIONER_CIDR`,
  `OSP_AGENT_PORT`, `OSP_ADMIN_PORT`, `OSP_RELAY_PORT`, `OSP_PROFILE_DISK`, and
  `OSP_PROFILES_ROOT`. `opensteer-pool-host.service` runs `setup-host.sh boot` on every boot, which
  loads `host.env`, re-applies `nftables` with the persisted CIDRs and ports, verifies the disk
  label is `ext4`/`osp-profiles`, and mounts it without ever formatting.
- `opensteer-pool-agent.service` requires `opensteer-pool-host.service` and runs
  `ExecStartPre=/opt/opensteer-pool/setup-host.sh verify-profiles-mount` before every start,
  confirming with `findmnt` that `/var/lib/opensteer-pool/profiles` is mounted read-write from the
  configured durable block device. The agent never starts against an unmounted directory on the
  boot disk.

## Operator recovery

- **`refuse:enrolled-host-blank-disk`:** A host that previously enrolled booted with a blank profile
  disk. Inspect the VM's attached disk in Google Compute Engine before taking action; do not format.
- **`refuse:foreign-disk-signature`:** The attached device holds a different filesystem, label, or
  partition table. Inspect with `blkid -p` and `wipefs -n`; verify the right disk is attached.
- **`refuse:unmountable-profile-disk` or boot mount failure:** The `osp-profiles` filesystem
  failed to mount. Inspect with `lsblk`, `blkid`, and `fsck.ext4` (read-only `-n` first) before
  deciding whether to repair or replace the host.
