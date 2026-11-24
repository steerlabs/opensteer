# Opensteer Home on Linux

A Home has one public HTTPS hostname. Point its DNS record at the VM and make TCP 80
and 443 reachable from the internet: that is how the Home gets a certificate that
phones and connected agents trust. Without both, the Home has no working HTTPS. Ubuntu 24.04 LTS with systemd is the managed installation base.
Bring-your-own Linux hosts need Docker Engine, Compose v2, Bash, coreutils, curl,
ca-certificates, jq, OpenSSL, util-linux and iptables with IPv4 and IPv6 support.
On Ubuntu 24.04:

```bash
sudo apt-get update && sudo apt-get install docker.io docker-compose-v2 docker-buildx jq git curl ca-certificates openssl util-linux iptables apparmor
```

Install from a release checkout (`git clone` of the release tag), with the Home's
six images taken one of two ways.

**Published images.** Run:

```bash
sudo bash deploy/home/install.sh --manifest /root/opensteer-home-release.json home.example.com
```

The manifest has a release `version` and an `images` map with the six Home image
references. Use repository digests for immutable releases. A version-only
manifest selects that version's `ghcr.io/steerlabs/opensteer-home-*` tags. Only
the Opensteer release owner publishes them; when the registry refuses the pull,
that version is not published there, so build the images instead.

**Images built on this server.** From the checkout, run:

```bash
sudo bash deploy/home/build-images.sh /root/opensteer-home-release.json
sudo bash deploy/home/install.sh --local-images --manifest /root/opensteer-home-release.json home.example.com
```

`build-images.sh` builds the six images from the checkout for this server's
architecture and writes a manifest that names them by digest where Docker can
address a local image that way, and otherwise by the release version's tag.
`--local-images` installs the images already on the server without pulling them,
checks that each carries the manifest's release version, and pulls only
PostgreSQL. To update such a Home, build the new release's checkout the same way
and run `sudo opensteer-home update /root/opensteer-home-release.json`.

Set `OPENSTEER_HOME_RELEASE_MANIFEST_URL` at install time or in
`/etc/opensteer-home/config.env` to supply a release feed for the hourly updater.
Managed installations enable the update timer only with an Opensteer-account-supplied
HTTPS feed that resolves only to public addresses, and always require image digests.
The updater pulls before replacing services and retains prior image IDs for rollback.
A release that migrates the database must remain compatible with the previous Host
for image rollback to work.

Running the installer again on a server where a Home is installed first decides
whether it may change that Home, and changes nothing if it may not: a Home that
was claimed (change its release with `sudo opensteer-home update MANIFEST.json`,
or remove it with `sudo opensteer-home uninstall --purge`), a Home its Opensteer
account manages, another hostname, a different `--local` choice, or
`--local-images` without `--manifest`. If it cannot tell whether a stopped Home
was claimed, it asks you to start it with `sudo opensteer-home start`. On a Home
that was never claimed it obtains the release's images (pulled, or found on the
server and checked) before it stops anything, then replaces the Home's release
and recipe and starts it. If that release does not start, the previous one is put
back and started again. A first install writes the Home's recipe and the
`opensteer-home` command before its configuration and images, so an install that
failed there is removed with `sudo opensteer-home uninstall --purge`.

Use the setup link printed by the installer to create the first owner. The link
expires after 24 hours. `sudo opensteer-home setup-link` replaces it while the
Home is unclaimed. `status` reports the release, service health and claim state.
Use `logs <service>` for service logs and `update` for an on-demand update.
Only bring-your-own Homes accept `update MANIFEST.json`. `uninstall` stops the
Home and disables its timers. `uninstall --purge` also deletes its configuration,
Docker volumes and the files its operations left in its directory, and nothing
else. The `opensteer-home` command on the path belongs to the Home in
`/etc/opensteer-home`; a Home in another directory is operated with its own copy,
`DIRECTORY/opensteer-home`, which never removes the default Home's command.

## Trying it on a private network

```bash
sudo bash deploy/home/install.sh --local --manifest /root/opensteer-home-release.json home.example.com
```

`--local` makes the Home use Caddy's own certificate authority instead of a
public certificate, for trying a Home on a network the internet cannot reach.
Other devices do not trust that certificate: the phone app and connected agents
will not connect, and browsers warn. The hostname still has to resolve to the
server on each device that uses it, for example through `/etc/hosts`. An installed Home
has no switch from `--local` to a public certificate.

## Network and storage

The Host, Runner and Channel Runtime trust Node's certificate authorities and
the ones in their container's system store (`/etc/ssl/certs`), so a network
that inspects TLS lets the Home reach the Opensteer account once its root is
there. That store is the image's, not the server's: a root added only to the
server's own store does not reach them. A Compose layer that names the root
with `NODE_EXTRA_CA_CERTS`, or points `SSL_CERT_FILE` at a mounted bundle,
does. The Opensteer app starts its Home the same way and reads the computer's
own store: on a Mac its keychains, where a new root counts only with a trust
setting made with the person's or an administrator's password, and on Windows
its certificate stores. `OPENSTEER_SYSTEM_CERTIFICATES=off`, in the Home's
environment or the app's, leaves Node's own list only.

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

Compute Engine defaults to `e2-standard-4` (4 vCPUs, 16 GiB) because the
Runner's default `cpus: 4` cap requires at least four vCPUs. The current
Compose memory caps total 17.5 GiB. They are upper bounds, so the VM can run
out of memory if several services approach their caps together. A 4 GB shape
becomes the default once Chromium moves to the browser pool and Home sizes
its CPU and memory limits from the machine type.

The listed on-demand Linux compute price in `us-central1` was USD $0.134 per
hour (about $97.84 for 730 hours) on November 20, 2026. Disk and networking
are billed separately. [Google machine specifications](https://cloud.google.com/compute/docs/general-purpose-machines) · [Regional list-price mirror](https://gcloud-compute.com/us-central1/e2-standard-4.html)

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

Engines run as the Runner container's own user, under each engine's own sandbox
and safety modes, exactly as on a Mac; their sign-ins and settings stay in that
user's home, the `engine-home` volume. Codex's sandbox needs unprivileged user
namespaces: on AppArmor hosts, install `apparmor` so the operator can load the
Runner user-namespace profile. The Runner container runs with zero capabilities
and the image's seccomp policy.

### Shared loopback

| Listener                                               | What an agent shell can access                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Caddy, TCP 80 and 443                                  | Public HTTPS surface with the Home hostname. Anonymous discovery, health, and authentication entry points are available. Protected routes use the Host credentials below. Caddy administration is disabled. Restart the gateway to reload it.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Caddy, TCP 8080                                        | Anonymous `/ready`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Host, TCP 4310                                         | Anonymous health, discovery, and sign-in entry points. First setup needs the enrollment code. A managed claim requires an Opensteer account assertion bound to this Home and the matching link credential. On replacement, the claim still carries a code field, but the restored Opensteer account link must match instead of the code. Protected RPC and `/mcp` require the appropriate owner session or scoped grant. Runner and messaging have separate enrollment and identity credentials. Browser watch or CDP requires an owner session or scoped grant. `/v1/browser/connect/:ticket` accepts a single-use WebSocket ticket, which the gateway redacts from request logs. |
| Browser Runtime, TCP 4312                              | Anonymous `/health`. Profile maintenance and attach-key registration use the bridge token, which task sandboxes cannot read. Attaching requires a Host-signed ticket. Chromium's internal DevTools connection is a pipe.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Browser egress, TCP 4313                               | Anonymous `/health` and public-destination forwarding when egress is available. The proxy authenticates itself to the upstream over TLS when configured. Upstream credentials are mounted into this container alone.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Channel Runtime, TCP 4320                              | Anonymous `/healthz` and `/readyz`. The runtime connects outbound to the Host using its own Runner identity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Runner browser and tool relay, ephemeral loopback port | A per-Run random URL path admits the Run's browser and agent-tool calls. The relay supplies a Run-scoped bearer to the Host.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Runner credential proxy, ephemeral loopback port       | A separate bearer and an active Run scope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Agent-started app or MCP server, its chosen local port | Authentication is up to the application. A loopback bind alone makes it reachable by tasks and Chromium in the same Home.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

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
paths. Before it stops anything, `sudo opensteer-home backup` checks that the
repository can be reached and written, within 30 seconds in all. It creates the
repository when restic finds none there. If the check fails, the backup stops
with restic's own message (a wrong password is reported as a wrong password), or
says the repository did not answer within 30 seconds, and the Home keeps
running. Otherwise it stops application services through the PostgreSQL dump,
file reads, and encrypted restic upload, printing each step and the upload's
progress. If it fails, is interrupted or is sent TERM after stopping them, it
removes its unfinished files, starts them again and says so. Downtime depends on
the data and repository. A scheduled attempt can fail, and an uploaded snapshot
can exist even if the report to the Opensteer account fails. Keep the repository password and
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
the stored HTTPS feed from the Opensteer account and refuse a local manifest. Each fetch checks DNS
again and connects only to the checked public addresses. PostgreSQL has its own
fixed digest; inherited Compose variables cannot override images or volume selection.
Set `OPENSTEER_HOME_RELEASE_MANIFEST_URL` in `config.env` for scheduled updates
on a bring-your-own Home, or supply a manifest to `update` directly. The Opensteer
account can set `releaseManifestUrl` in the managed boot response to schedule updates.

## Problems and reports

The maintenance timer hands the Host what only the machine knows, as fixed values: each service's
health, the last scheduled backup's result and the last update's result
(`machine-status.sh`, written as `machine-status.json` in the Host's data volume). The Host shows
these with its own problems under Settings → General → Problems. It sends nothing unless the
person turns on "Send problem reports to Opensteer". Then the same report goes every 15 minutes to
the Opensteer account, or to your own address: set `OPENSTEER_HOME_PROBLEM_REPORTS_URL` in
`config.env` to an `https://` origin that accepts `POST /v1/problem-reports`. A managed Home (an
Opensteer Cloud Computer) always sends its health report to the Opensteer account that runs it; see
[architecture](../../docs/architecture.md#problems-and-reports).

## Managed release and verification

Generate the standalone cloud-init artifact with
`bash deploy/home/package-installer.sh /path/to/opensteer-home-installer.sh`.
The installer bundles shell scripts and Compose files for both AMD64 and ARM64.
The `home` Bake group in `deploy/container/docker-bake.hcl` defines six images
for `linux/amd64` and `linux/arm64`. Inspect the resolved targets locally with
`docker buildx bake -f deploy/container/docker-bake.hcl home --print`. The local
verifier loads ARM64 and runs the Colima deployment test on it first. After that
test it builds AMD64 into the BuildKit cache only; nothing runs the AMD64 images.
Its last line says separately whether the ARM64 proof passed and whether the
AMD64 build passed. Building AMD64 locally requires a builder that can execute
AMD64 instructions, either natively or through emulation.

The release owner must complete these steps.

1. Build and push the six Home images for both platforms with the `home` Bake group.
2. Check that each registry manifest lists both platforms and pin the manifest-list digests in the Home release manifest.
3. Publish the installer at the manifest's HTTPS URL with its SHA-256.
4. Run one AMD64 Home end to end.

The Home Provisioner renders cloud-init user data. On the
VM, cloud-init writes `/root/opensteer-home-boot.json` and
`/root/opensteer-home-bootstrap-token` and enables a systemd download unit. The
unit downloads the installer, verifies its SHA-256, and passes the files to it
with `--boot-spec … --bootstrap-token-file …`. The installer exchanges the token
using the contract in [managed-boot.sh](managed-boot.sh). The systemd installer
keeps the first accepted boot configuration across reboots. It sends the running
Home's identity only after all seven services are healthy and retries an ambiguous
completion with the same identity. The Opensteer account revokes the single-use token on
completion; a matching replay only acknowledges the same identity. The installer
removes its local token and boot-result files before enabling normal operation,
or on terminal refusal, when it also stops the pod. On Google Compute Engine,
the provisioner removes the instance's user data once the Opensteer account records the claim
receipt. Cloud-init's cached copy can still contain the spent token. Cleanup
resumes on the next installer run if power is lost after the terminal outcome.
For a managed replacement, `restoreSnapshot` stages and verifies the snapshot
before starting the restored identity. The Opensteer account claims the new generation for
the same linked owner; enrolled services keep their restored credentials. The Opensteer
account assigns a pre-registered S3 principal and a non-overlapping backup prefix; the
operator must scope the principal's actual permissions to that prefix.

The root maintenance timer checks `GET /v1/cloud-computers/:id/egress` over
HTTPS while a managed Home is waiting for an upstream, 15 seconds after the
previous maintenance run ends. It authenticates with
HTTP Basic using that generation's Opensteer account OIDC credentials. When the Opensteer account
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

The verifier installs with `--local`. The Colima proof runs
`pnpm exec tsx scripts/verify-home-deployment.mjs` from the worktree. The BYO
path uses `--prepare`. The managed path uses the standalone installer, the
Opensteer account's real HTTP route handlers, and Colima's systemd. Its stand-in
for the Opensteer account boots the Home with `managedHome`, claims each
generation with a signed assertion checked against its JWKS, and signs the owner
in through its OIDC provider, on a public-looking address that exists only on that
machine. The Home trusts the stand-in's certificate through one Compose layer:
the verifier installs the shipped standalone installer with that one line added
to its `common.sh`, and checks that nothing else differs. The verifier checks for
50 GiB free on the Mac and on Colima's Docker filesystems before building. It
builds each image once, removes its test projects and image tags, and caps its
own BuildKit cache at 12 GB and removes the build daemon container. The
separately named builder holds only verifier cache so cleanup leaves other
builders alone.

To run the same checks on a Linux server instead, run
`OPENSTEER_HOME_VERIFIER_TARGET=local pnpm exec tsx scripts/verify-home-deployment.mjs`
on that server after `pnpm install`. It needs Node 24, Docker Engine with
Compose v2 and buildx (`docker.io docker-compose-v2 docker-buildx` on Ubuntu
24.04), membership in the `docker` group and passwordless `sudo`. It uses the
local Docker socket, `sudo -n bash -s` as its root shell, `localhost` for the
browser egress check's Opensteer account stand-in and a public-looking address on
the loopback interface for the managed check's, and checks free space on the
checkout and on the local Docker root. It proves the server's own architecture. The other architecture's build
reports blocked when the builder has no emulation for it.
