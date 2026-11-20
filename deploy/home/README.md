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
Managed installations enable the update timer only with an Account-supplied
HTTPS feed that resolves only to public addresses, and always require image digests.
The updater pulls before replacing services and retains prior image IDs for rollback.
A release that migrates the database must remain compatible with the previous Host
for image rollback to work.

Use the setup link printed by the installer to create the first owner. The link
expires after 24 hours. `sudo opensteer-home setup-link` replaces it while the
Home is unclaimed. `status` reports the release, service health and claim state.
Use `logs <service>` for service logs and `update` for an on-demand update.
Only bring-your-own Homes accept `update MANIFEST.json`. `uninstall` stops the
Home and disables its timers. `uninstall --purge` also
deletes its configuration and Docker volumes.

## Network and storage

The Host owns the Docker namespace and publishes the Caddy ports. Caddy, Runner,
Browser Runtime, egress proxy and Channel Runtime share its namespace. The Host
API and the internal listeners bind to loopback. PostgreSQL has its own network
namespace without a network attachment or TCP listener. Only PostgreSQL and the
Host mount the database socket. The operator installs egress rules in the Host namespace before starting the
five containers that share it. IPv4 is the default. Set
`OPENSTEER_HOME_IPV6_ENABLED=true` on a bring-your-own install to publish IPv6
as well. A managed install takes that decision from `ipv6Enabled` in the boot
response. The operator blocks private and link-local destinations and outbound
SMTP, and rejects new IPv6 egress by default. Docker's embedded DNS forwards
external queries. The firewall does not provide DNS containment.
Compose leaves automatic container restarts to the systemd service and its
maintenance timer so the operator reinstalls firewall rules after a namespace
change.

The Host owns its state volume, Runner owns its identity, engine home and Agent
home, the Browser Runtime owns its profiles, Channel Runtime owns its identity
and Caddy owns its TLS storage. The [Compose recipe](compose.yaml) lists the
service environments and mounts. Change the Runner's four CPU and 8 GiB limits
with `OPENSTEER_HOME_RUNNER_CPUS` and `OPENSTEER_HOME_RUNNER_MEMORY`. The Browser
Runtime's defaults are two CPUs and 4 GiB. Set
`OPENSTEER_HOME_BROWSER_CPUS` and `OPENSTEER_HOME_BROWSER_MEMORY` to change them.
Host and PostgreSQL are each capped at two CPUs and 2 GiB. Caddy, the browser
egress proxy, and Channel Runtime are each capped at one CPU and 512 MiB.

For a static ISP upstream, pass `OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL`,
`OPENSTEER_BROWSER_EGRESS_UPSTREAM_USERNAME` and
`OPENSTEER_BROWSER_EGRESS_UPSTREAM_PASSWORD_FILE` during install. The egress
proxy alone receives those credentials through file mounts. A bring-your-own
Home without an upstream makes direct public-network connections. On a managed
Home, public page loads use the assigned upstream, not the VM's direct connection.
The proxy provider supplies the stable external IP; the installer does not verify it.
These loads fail closed while the upstream is missing or broken. Chromium disables
QUIC and non-proxied WebRTC UDP and keeps loopback access for local app servers.
The proxy refuses SMTP ports for HTTP and CONNECT. These are browser settings,
not a boundary against an agent that controls Chromium. Task shells intentionally
use the VM's public IP. The pod firewall blocks private and link-local destinations
outside loopback, including instance metadata.

Task shells run in bubblewrap. The Runner identity and its enrollment and
browser bridge secret mounts are under the masked Runner data directory. The
sandbox re-exposes Agent home, the active engine profile, and Run-specific files
and keeps the loopback network for browser and MCP access. Linux must support
unprivileged user namespaces. On AppArmor hosts, install `apparmor` so the
operator can load the Runner user-namespace profile. The Runner container runs
with zero capabilities and the image's seccomp policy. The Runner requires a
private PID namespace and a fresh `/proc` for each sandbox. In Compose,
`systempaths=unconfined` allows bubblewrap to mount that procfs.

### Shared loopback

| Listener                                               | What an agent shell can access                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Caddy, TCP 80 and 443                                  | Public HTTPS surface with the Home hostname. Anonymous discovery, health, and authentication entry points are available. Protected routes use the Host credentials below. Caddy administration is disabled. Restart the gateway to reload it.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Caddy, TCP 8080                                        | Anonymous `/ready`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Host, TCP 4310                                         | Anonymous health, discovery, and sign-in entry points. First setup needs the enrollment code. A managed claim requires an Account assertion bound to this Home and the matching link credential. On replacement, the claim still carries a code field, but the restored Account link must match instead of the code. Protected RPC and `/mcp` require the appropriate owner session or scoped grant. Runner and messaging have separate enrollment and identity credentials. Browser watch or CDP requires an owner session or scoped grant. `/v1/browser/connect/:ticket` accepts a single-use WebSocket ticket, which the gateway redacts from request logs. |
| Browser Runtime, TCP 4312                              | Anonymous `/health`. Profile maintenance and attach-key registration use the bridge token, which task sandboxes cannot read. Attaching requires a Host-signed ticket. Chromium's internal DevTools connection is a pipe.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Browser egress, TCP 4313                               | Anonymous `/health` and public-destination forwarding when egress is available. The proxy authenticates itself to the upstream over TLS when configured. Upstream credentials are mounted into this container alone.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Channel Runtime, TCP 4320                              | Anonymous `/healthz` and `/readyz`. The runtime connects outbound to the Host using its own Runner identity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Runner browser and tool relay, ephemeral loopback port | A per-Run random URL path admits the Run's browser and agent-tool calls. The relay supplies a Run-scoped bearer to the Host.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Runner credential proxy, ephemeral loopback port       | A separate bearer and an active Run scope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Agent-started app or MCP server, its chosen local port | Authentication is up to the application. A loopback bind alone makes it reachable by tasks and Chromium in the same Home.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

PostgreSQL has no TCP listener. The Host and PostgreSQL alone mount its socket.
The Runner's shell relay uses a local Unix socket, and Chromium has no shared
TCP DevTools listener.

## Backup and recovery

The daily timer attempts a backup when the following files exist in
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
paths. `sudo opensteer-home backup` stops application services through the
PostgreSQL dump, file reads, and encrypted restic upload. Downtime depends on
the data and repository. A scheduled attempt can fail, and an uploaded snapshot
can exist even if the Account report fails. Keep the repository password and
access credentials available independently of the original VM.
Use `sudo opensteer-home snapshots` to list available snapshots.

Stop the source Home before restoring its identity. Prepare the destination with
the original hostname and the same release, configure its repository settings,
then run `sudo opensteer-home restore --source-stopped [SNAPSHOT_ID]`. The flag
acknowledges that the source has been permanently stopped. The operator prints
what it will overwrite, verifies the encrypted snapshot, and restores into
separate volumes. Restore checks claim state after stopping the public gateway
but before stopping the Host; a claim already in flight can still finish.
Prevent claims during the cutover and pass `--replace` if the destination is
already claimed. The old volume set survives until the replacement is healthy.
If recovery finds inconsistent journal or selector evidence, it stops for an
operator instead of deleting a volume set. Move DNS once the restored Home is ready.

Before switching to a new release, the updater pulls its images, records both
image sets, and saves `update-database.dump` in the root-only configuration
directory. An interrupted or unhealthy candidate rolls back to the previous
images only. Migrations are expand-only and must keep the preceding Host compatible.
The dump is a consistent, last-resort copy for manual recovery. It does not include
writes made after the dump. Managed updates take only digest-pinned images from
the stored Account HTTPS feed and refuse a local manifest. Each fetch checks DNS
again and connects only to the checked public addresses. PostgreSQL has its own
fixed digest; inherited Compose variables cannot override images or volume selection.
Set `OPENSTEER_HOME_RELEASE_MANIFEST_URL` in `config.env` for scheduled updates
on a bring-your-own Home, or supply a manifest to `update` directly. The Account
can set `releaseManifestUrl` in the managed boot response to schedule updates.

## Managed release and verification

Generate the standalone cloud-init artifact with
`bash deploy/home/package-installer.sh /path/to/opensteer-home-installer.sh`.
Publish it with its SHA-256 and the six multi-architecture images from
`deploy/container/docker-bake.hcl`'s `home` group. Publish the release manifest
with the image digests. The Home Provisioner renders cloud-init user data. On the
VM, cloud-init writes `/root/opensteer-home-boot.json` and
`/root/opensteer-home-bootstrap-token` and enables a systemd download unit. The
unit downloads the installer, verifies its SHA-256, and passes the files to it
with `--boot-spec … --bootstrap-token-file …`. The installer exchanges the token
using the contract in [managed-boot.sh](managed-boot.sh). The systemd installer
keeps the first accepted boot configuration across reboots. It sends the running
Home's identity only after all seven services are healthy and retries an ambiguous
completion with the same identity. The Account revokes the single-use token on
completion; a matching replay only acknowledges the same identity. The installer
removes its local token and boot-result files before enabling normal operation,
or on terminal refusal, when it also stops the pod. Provider instance user data and
cloud-init's cached copy can still contain the spent token; neither provides new
boot authority after completion. Cleanup resumes on the next installer run if
power is lost after the terminal outcome.
For a managed replacement, `restoreSnapshot` stages and verifies the snapshot
before starting the restored identity. The Account claims the new generation for
the same linked owner; enrolled services keep their restored credentials. Account
assigns a pre-registered S3 principal and a non-overlapping backup prefix; the
operator must scope the principal's actual permissions to that prefix. A work Home's optional organization and
assignment marker is passed to the Host as `OPENSTEER_MANAGED_HOME_WORK_JSON`.

The root maintenance timer checks `GET /v1/cloud-computers/:id/egress` over
HTTPS while a managed Home is waiting for an upstream, 15 seconds after the
previous maintenance run ends. It authenticates with
HTTP Basic using that generation's Account OIDC credentials. When the Account
assigns an upstream, maintenance writes the three secret files under the
root-only configuration directory, with mode `0444` for the proxy mounts, and
recreates the egress proxy. An
interrupted change resumes at the next maintenance tick.

## Known limits

`--source-stopped` is an operator acknowledgement, not a fencing mechanism for
manual restores on two machines. The managed provisioner separately verifies the
predecessor is off. Some secret mounts are readable by the receiving service user;
some service processes and backup helpers load credentials into their own environment.
The task sandbox, separate mounts and PID isolation keep that state out of task shells.
The pod checks both firewall families before admitting sibling services and repairs
rule drift at maintenance time, not continuously. A manual root-level rule change
can therefore briefly leave an existing pod unprotected.

Use Ubuntu 24.04 LTS with Bash, systemd, cloud-init, CA certificates, curl, and
standard archive and checksum utilities for the managed bootstrap. The
installer can provision Docker Engine, Compose v2, jq, OpenSSL, util-linux,
iptables, and AppArmor from the distribution packages. Other Linux images
must preinstall the prerequisites. Publish the regular numeric Opensteer
release version stamped into the immutable images.

`--local` enables Caddy's internal CA. The Colima proof runs
`pnpm exec tsx scripts/verify-home-deployment.mjs` from the worktree. The BYO
path uses `--prepare`. The managed path uses the standalone installer, real
Account HTTP route handlers, and Colima's systemd. The verifier checks for
50 GiB free on the Mac and on Colima's Docker filesystems before building. It
builds each image once, removes its test projects and image tags, and caps its
own BuildKit cache at 12 GB and removes the build daemon container. The
separately named builder holds only verifier cache so cleanup leaves other
builders alone.
