# Pool host enrolment (`enroll-host.sh`)

`enroll-host.sh` provisions and enrols a browser pool host from the root-only boot specification
and single-use bootstrap token written by `apps/home-provisioner/src/pool-boot.ts`. It is
idempotent: re-running after a crash or reboot repeats only unfinished work and never reformats an
existing profile disk.

## Verified release bundle (Y7 / Z11)

`pool-boot.ts` downloads one SHA-256-verified `.tar.gz` release bundle (`installerUrl` +
`installerSha256`), verifies its SHA-256 digest before invoking `tar`, refuses any symbolic link
inside the extracted bundle directory (`find "$bundle_dir" -type l`), confirms `enroll-host.sh`
and `setup-host.sh` are regular files, and invokes:

```sh
bash "$bundle_dir/enroll-host.sh" \
  --boot-spec /root/opensteer-pool-boot.json \
  --bootstrap-token-file /root/opensteer-pool-bootstrap-token \
  --setup-script "$bundle_dir/setup-host.sh"
```

`enroll-host.sh` refuses to run any `setup-host.sh` outside its own verified bundle directory (it
never falls back to an unverified script in `/opt/opensteer-pool`). Both `--boot-spec` and
`--bootstrap-token-file` must be regular files (never symlinks) owned by `root:root` with mode
`0600`. The bootstrap token and the host's private keys are never written to stdout, stderr, or
argv.

## Steps

1. **Validate the boot specification** (`hostId`, `generation`, bare `https://` `accountOrigin`,
   Ed25519 SPKI `provisionerKey`, IPv4 `homeCidr`/`provisionerCidr`, the fixed durable device path
   `/dev/disk/by-id/google-opensteer-profiles`, boolean `everEnrolled`, and distinct
   `agentPort`/`adminPort`/`relayPort`). Every string field rejects control characters (including
   newlines and tabs) and values pass from Python to Bash NUL-delimited.
2. **Prepare and mount the durable profile disk** at `/var/lib/opensteer-pool/profiles`
   (`driver.profilesRoot`) using the decision rule below. The device path is fixed to
   `/dev/disk/by-id/google-opensteer-profiles`, waited for up to 30 seconds via the shared helper in
   `setup-host.sh`, resolved once, and checked fail-closed against the boot/root disk (and its
   parent whole disk). Because `mkfs.ext4` does not prompt before overwriting an existing filesystem
   when not on a terminal, the format guard is repeating both `blkid -o export -p` and
   `wipefs -n --noheadings` immediately before `mkfs.ext4` on a host with `everEnrolled=false`
   (together with `mke2fs`'s exclusive open on a busy device); `mkfs.ext4 -q -m 1 -L osp-<12hex>`
   still runs with `</dev/null` and without `-f`/`-F` so any prompt it does issue fails rather than
   blocking.
3. **Resolve release artifacts** (`agent`, `relay`, `rootfs`, `kernel`, `egress` URLs and SHA-256
   digests) from `POST {accountOrigin}/v1/browser-pool/hosts/{hostId}/boot` (cached root-only at
   `/etc/opensteer-pool/release-artifacts.json` for idempotent retry after a partial run, or read
   from inline `artifacts` in the boot spec for offline tests).
4. **Run bundled `setup-host.sh install`** with the persisted CIDRs, ports, fixed
   `OSP_PROFILE_DISK`, per-host `OSP_PROFILE_DISK_LABEL`, and `OSP_REQUIRE_PROFILE_DISK=1`. Before
   wiping or building the encrypted Local SSD scratch array (`wipefs -a`, `mdadm`, `cryptsetup`,
   `mkfs.xfs`), `setup-host.sh` resolves both the durable profile disk and the boot/root disk (plus
   parent whole disks) and refuses if any scratch SSD candidate matches either.
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
   own disk)** and render `/etc/opensteer-pool/agent.json` (`0600`, `driver.profilesMount: {
"label": "osp-<12hex>" }`, `driver.requireEgressUpstream: true`, `driver.egress.accountOrigin`,
   `driver.guestMode: "runtime"`, `relayUid` of `opensteer-pool-relay`). Setting
   `driver.requireEgressUpstream: true` (making this a pulling host) is also what allows a slot
   deletion to settle: on a pulling host the agent answers `credentialsErased: true` whenever the
   slot's derived credential paths are seen gone (including for an unknown slot or repeated
   delete), whereas a non-pulling host leaves `credentialsErased` out for an unknown slot and would
   hang deletion.
7. **Enrol public keys with Account** via `POST {accountOrigin}/v1/browser-pool/hosts/{hostId}/boot-complete`
   carrying `{ generation, bootstrapToken, hostKey, relayKey }`. Only after HTTP `200` with
   `{"completed":true}`:
   - runs `setup-host.sh verify-profiles-mount` (checking mount point, fixed device, `rw`, and the
     same per-host `osp-<12hex>` label);
   - enables and starts `opensteer-pool-agent.service` and `opensteer-pool-relay.service`;
   - **after services are up**, removes `--bootstrap-token-file` and cloud-init's user-data copies
     (`/var/lib/cloud/instance/user-data.txt`, `user-data.txt.i`, `cloud-config.txt`). If a crash
     or `systemctl` failure happens before removal, the token stays on disk; because the
     reconciler's post-enrolment metadata scrub removes `user-data` while leaving the non-secret
     `opensteer-bootstrap-ready` gate key, the next run of `opensteer-pool-download.service`
     reaches `enroll-host.sh`, reuses cached artifacts, replays `/boot-complete` idempotently with
     the same keys, finishes starting services, and removes the token (Y5 / Z1).
   - **Note on cloud-init `obj.pkl` (Z12):** `/var/lib/cloud/instance/obj.pkl` is intentionally left
     untouched so cloud-init does not lose its instance cache and treat the next reboot as a first
     boot. That copy does not expose a live secret: the bootstrap token is single-use, cleared on
     `/boot-complete`, and its only remaining replay path requires the already-enrolled host and
     relay public keys and changes nothing.

The enrolment sequence is strictly ordered: per-host label decided and written (or verified) →
mounted by that label → `agent.json` written with `driver.profilesMount: { "label": "osp-<12hex>" }`
→ `verify-profiles-mount` and services started → bootstrap token and cloud-init user-data removed.

## Durable profile disk decision rule (X1 / Y2 / Y3 / Y7)

Each host's durable profile disk carries a per-host 16-byte ext4 volume label `osp-<12hex>`, where
`<12hex>` is the first 12 lowercase hex characters of `SHA-256(hostId)`. Another host's profile
disk carries a different label and is refused as a foreign disk. Account supplies only
`everEnrolled` (from `browser_pool_hosts.ever_enrolled`) so an automatically replaced
never-enrolled host can recover whether its first boot failed before or after formatting, while a
disk that could hold a person's profile is never formatted.

| `everEnrolled`    | `blkid -o export -p` & `wipefs -n --noheadings`                           | Mountable? | Decision                                                                                                 |
| ----------------- | ------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| `false`           | Blank (`blkid` exit `2` empty AND `wipefs -n` exit `0` empty)             | n/a        | **`format-and-mount`** (re-probe `blkid` + `wipefs`, then `mkfs.ext4 -q -m 1 -L osp-<12hex> </dev/null`) |
| `false`           | `TYPE=ext4`, `LABEL=osp-<12hex>`, no `PTTYPE`, single `ext4` signature    | `true`     | **`mount-only`** (never format)                                                                          |
| `true`            | `TYPE=ext4`, `LABEL=osp-<12hex>`, no `PTTYPE`, single `ext4` signature    | `true`     | **`mount-only`** (never format)                                                                          |
| `false` or `true` | `TYPE=ext4`, `LABEL=osp-<12hex>`                                          | `false`    | **`refuse:unmountable-profile-disk`** (fail loudly; no `mkfs`; agent does not start)                     |
| `true`            | Blank (`blkid` exit `2` empty AND `wipefs -n` exit `0` empty)             | n/a        | **`refuse:enrolled-host-blank-disk`** (fail loudly; no `mkfs`; agent does not start)                     |
| `false` or `true` | Any other filesystem, another host's label, partition table, or multi-sig | n/a        | **`refuse:foreign-disk-signature`** (fail loudly; nothing modified)                                      |
| `false` or `true` | `blkid` exit not in `{0, 2}` or `wipefs` exit non-zero                    | n/a        | **`refuse:probe-error`** (fail loudly; nothing modified)                                                 |

## Reboot and anti-fallback protection (Y1)

- `/etc/opensteer-pool/host.env` (`0600`) persists `OSP_HOME_CIDR`, `OSP_PROVISIONER_CIDR`,
  `OSP_AGENT_PORT`, `OSP_ADMIN_PORT`, `OSP_RELAY_PORT`, `OSP_PROFILE_DISK`,
  `OSP_PROFILE_DISK_LABEL`, `OSP_REQUIRE_PROFILE_DISK=1`, and `OSP_PROFILES_ROOT`.
- On `boot` and `verify-profiles-mount`, a **missing `/etc/opensteer-pool/host.env` or an empty
  `OSP_PROFILE_DISK` / invalid `OSP_PROFILE_DISK_LABEL` is a hard error** (fail closed; never
  "nothing to mount").
- `opensteer-pool-agent.service` requires `opensteer-pool-host.service` and runs
  `ExecStartPre=/opt/opensteer-pool/setup-host.sh verify-profiles-mount` before every start,
  confirming with `findmnt` and `blkid -p` that `/var/lib/opensteer-pool/profiles` is mounted
  read-write from the fixed durable block device carrying this host's `osp-<12hex>` label.
- **Agent-side enforcement (`driver.profilesMount`):** `enroll-host.sh` always writes
  `driver.profilesMount: { "label": "osp-<12hex>" }` into `agent.json` with the same per-host
  label. The agent independently verifies that `driver.profilesRoot` is a mount point on a
  different device than its parent, matches `/dev/disk/by-label/<label>`, and is writable:
  - at startup, a failed check makes the agent exit with `"The profile disk is not mounted (...)"`;
  - before every `create` and `delete` (and again immediately before erasing a profile), a failed
    check returns a definite signed `profile-disk-missing` refusal and never creates or erases a
    profile (a `delete` never answers `profileErased`, and `home-provisioner` treats
    `profile-disk-missing` as "not done, host is not ready");
  - before every `start` and wake from disk, the Home receives a stored signed `applied: false`
    with reason `profile-disk-missing`.
- **Late-attaching or disappearing disk (Z7):** `opensteer-pool-host.service` waits up to 30
  seconds at boot for `/dev/disk/by-id/google-opensteer-profiles` (using the same bounded wait as
  enrolment). If the disk attaches later than that, or disappears while the agent is running, the
  host fails closed and requires an operator to verify/mount the disk and restart both units
  (`systemctl restart opensteer-pool-host opensteer-pool-agent`).

## Operator recovery

- **`refuse:enrolled-host-blank-disk`:** A host that previously enrolled booted with a blank profile
  disk. Inspect the VM's attached disk in Google Compute Engine before taking action; do not format.
- **`refuse:foreign-disk-signature`:** The attached device holds a different filesystem, another
  host's `osp-<12hex>` label, or a partition table. Inspect with `blkid -p` and `wipefs -n`; verify
  the right disk is attached.
- **`refuse:unmountable-profile-disk` or boot mount failure:** The host's `osp-<12hex>` filesystem
  failed to mount. Inspect with `lsblk`, `blkid`, and `fsck.ext4` (read-only `-n` first) before
  deciding whether to repair or replace the host.
