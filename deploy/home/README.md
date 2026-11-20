# Opensteer Home on Linux

A Home has one public HTTPS hostname. Point its DNS record at the VM and make TCP 80
and 443 reachable. Ubuntu 24.04 LTS with systemd is the managed installation base.
Bring-your-own Linux hosts need Docker Engine, Compose v2, Bash, coreutils, curl,
ca-certificates, jq, OpenSSL, util-linux and iptables with IPv4 and IPv6 support.

From a release checkout, run:

```bash
sudo bash deploy/home/install.sh --manifest /root/opensteer-home-release.json home.example.com
```

The manifest has a release `version` and an `images` map with the six Home image
references. Use repository digests for immutable releases. A version-only
manifest selects that version's `ghcr.io/steerlabs/opensteer-home-*` tags.
Set `OPENSTEER_HOME_RELEASE_MANIFEST_URL` at install time or in
`/etc/opensteer-home/config.env` to supply a release feed for the hourly updater.
The updater pulls before replacing services and retains prior image IDs for rollback.
A release that migrates the database must remain compatible with the previous Host
for image rollback to work.

Use the setup link printed by the installer to create the first owner. The link
expires after 24 hours. `sudo opensteer-home setup-link` replaces it while the
Home is unclaimed. `status` reports the release, service health and claim state.
Use `logs <service>` for service logs and `update [MANIFEST.json]` for an on-demand
update. `uninstall` stops the Home and disables its timers. `uninstall --purge` also
deletes its configuration and Docker volumes.

## Network and storage

The Host owns the Docker namespace and publishes the Caddy ports. Caddy, Runner,
Browser Runtime, egress proxy and Channel Runtime share its namespace. The Host
API and the internal listeners bind to loopback. PostgreSQL has its own network
namespace without a network attachment or TCP listener. Only PostgreSQL and the
Host mount the database socket. The operator installs IPv4 and IPv6 egress rules
in the pod namespace before starting the other services, including on systemd boot.

The Host owns its state volume, Runner owns its identity, engine home and Agent
home, the Browser Runtime owns its profiles, Channel Runtime owns its identity
and Caddy owns its TLS storage. The [Compose recipe](compose.yaml) lists the
service environments and mounts. Change the Runner's four CPU and 8 GiB limits
with `OPENSTEER_HOME_RUNNER_CPUS` and `OPENSTEER_HOME_RUNNER_MEMORY`. The Browser
Runtime's defaults are two CPUs and 4 GiB. Set
`OPENSTEER_HOME_BROWSER_CPUS` and `OPENSTEER_HOME_BROWSER_MEMORY` to change them.

For a static ISP upstream, pass `OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL`,
`OPENSTEER_BROWSER_EGRESS_UPSTREAM_USERNAME` and
`OPENSTEER_BROWSER_EGRESS_UPSTREAM_PASSWORD_FILE` during install. The egress
proxy alone receives those credentials through file mounts. Without an
upstream, the proxy makes direct public-network connections. Chromium keeps its
implicit loopback bypass for local app servers. The pod firewall also blocks private and
link-local destinations outside loopback.

Task shells run in bubblewrap. The Runner identity and its enrollment and
browser bridge secret mounts are under the masked Runner data directory. The
sandbox re-exposes Agent home, the active engine profile, and Run-specific files
and keeps the loopback network for browser and MCP access. Linux must support
unprivileged user namespaces. On AppArmor hosts, install `apparmor` so the
operator can load the Runner user-namespace profile. The Runner container runs
with zero capabilities and the image's seccomp policy. The Runner requires a
private PID namespace and a fresh `/proc` for each sandbox. In Compose,
`systempaths=unconfined` allows bubblewrap to mount that procfs.

## Backup and recovery

The daily backup runs when the following files exist in
`/etc/opensteer-home/secrets/`. Keep that directory root-only and use mode 0600
for the repository settings.

| File                     | Contents                                                                  |
| ------------------------ | ------------------------------------------------------------------------- |
| `backup_repository`      | Restic S3 repository, for example `s3:https://s3.example.com/bucket/home` |
| `backup_password`        | Restic encryption password                                                |
| `backup_accessKeyId`     | S3 access key ID                                                          |
| `backup_secretAccessKey` | S3 secret key                                                             |

For manual runs, `RESTIC_REPOSITORY_FILE`, `RESTIC_PASSWORD_FILE`,
`AWS_ACCESS_KEY_ID_FILE` and `AWS_SECRET_ACCESS_KEY_FILE` accept alternate file
paths. `sudo opensteer-home backup` briefly stops application services for a
consistent PostgreSQL dump and encrypted file snapshot. Keep the repository
password and access credentials available independently of the original VM.

Stop the source Home before restoring its identity. Prepare the destination with
the original hostname and the same release, configure its repository settings,
then run `sudo opensteer-home restore [SNAPSHOT_ID]`. The operator prints the
data it will overwrite and refuses to overwrite a claimed destination unless
`--replace` is supplied. Move DNS to the restored VM once the Home is ready.

## Managed release and verification

Generate the standalone cloud-init artifact with
`bash deploy/home/package-installer.sh /path/to/opensteer-home-installer.sh`.
Publish it with its SHA-256 and the six multi-architecture images from
`deploy/container/docker-bake.hcl`'s `home` group. Publish the release manifest
with the image digests. The Home Provisioner downloads and verifies one installer
file, then passes the root-only boot spec and the separate root-only token file
with `--boot-spec … --bootstrap-token-file …`. The installer exchanges the token
using the contract in [managed-boot.sh](managed-boot.sh). Managed install can
provision missing prerequisites from Ubuntu's package repositories. On other
Linux distributions, prepare the prerequisites in the VM image.

`--local` enables Caddy's internal CA. The Colima proof runs
`pnpm exec tsx scripts/verify-home-deployment.mjs` from the worktree. It uses
`--prepare` for the installer's generated configuration and drives it directly,
independent of the VM's production systemd units.
