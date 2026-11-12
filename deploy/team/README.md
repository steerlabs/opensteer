# Run a team

Use a dedicated clone on a Linux server or family Mac with Docker Compose v2,
Git and Bash. On Mac, Docker Desktop or Colima must be running; the
scheduled updater needs access to that same Docker context. This stack runs
PostgreSQL, the team Host and Caddy from the published
`ghcr.io/steerlabs/opensteer-team-host` and `opensteer-team-gateway` images
(linux/amd64 and linux/arm64). Agents run on each person's own Opensteer.

Run `bash deploy/team/setup.sh`, edit the generated `deploy/team/config.env`,
then run setup again. Use an HTTPS public hostname pointing to the machine
with inbound ports 80 and 443 available. Setup creates the secrets, checks out
the newest release of the configured channel, pulls its images, starts them,
installs hourly updates, then prints the private, one-time first-owner setup link.
Open it, adopt the server through Opensteer Account, sign in and become owner.
Later members join through invites. Do not send the setup link to other people.

First-owner setup must be reachable at a **public HTTPS address**, using a public
hostname or Tailscale Funnel. Account verifies adoption by fetching that origin;
it cannot reach a private tailnet address. After setup, members can use
private-only tailnet access at that same canonical origin. Keep the origin and
Host identity fixed; changing the canonical origin is not a route switch.

The setup link expires 24 hours after the Host first reads its token. To renew
an unfinished setup, run:

```sh
bash deploy/team/setup.sh --renew-setup
```

This atomically replaces only the setup token, recreates the Host container so
it reads the new token, and prints a new private setup link. Restarting with the
same token does not extend its deadline. An existing owner is never replaced.
The database password, auth secret and signing identity stay in place.

For Tailscale, bind the gateway to loopback with `OPENSTEER_HTTP_BIND=127.0.0.1`
and `OPENSTEER_HTTPS_BIND=127.0.0.1` in config.env. Set
`OPENSTEER_GATEWAY_SITE_ADDRESS=:80` and use an HTTPS origin publicly reachable
through Funnel during setup. After adoption, disable Funnel and use
`tailscale serve --bg http://127.0.0.1:80` with the same canonical origin for
private member access. There are no Connect routes for team servers in v1.

Updates fetch tags from the cloned remote (`OPENSTEER_UPDATE_REMOTE`, default
`origin`). `OPENSTEER_UPDATE_CHANNEL=stable` selects the newest
`desktop-vMAJOR.MINOR.PATCH`; `beta` selects the newest
`vMAJOR.MINOR.PATCH-insider`. The updater checks out that tag, so the Compose
files match its images, and runs image version `MAJOR.MINOR.PATCH`. It never
moves to an older version, so switching from Beta to Stable waits until Stable
catches up. A failed pull leaves the existing containers running. Results go to
`deploy/team/update.log`; rotate that file as part of server maintenance.
A failed start is reported there; the next scheduled run retries the selected
release. Keep the checkout clean. Back up the named database and Host volumes.
Keep the secrets directory private: its files are readable within containers,
and the parent is mode 0700 on the host.

On Linux setup installs a user systemd timer. Enable lingering for the operator
(`loginctl enable-linger "$USER"`) to update while logged out; ensure Docker is
available to that user without interactive sudo. To uninstall updates:

```sh
systemctl --user disable --now opensteer-team-update.timer
rm ~/.config/systemd/user/opensteer-team-update.{service,timer}
systemctl --user daemon-reload
```

On Mac updates run while the operator is logged in. To uninstall:

```sh
launchctl bootout "gui/$(id -u)/com.opensteer.team-update"
rm ~/Library/LaunchAgents/com.opensteer.team-update.plist
```

Stop the stack with `docker compose --env-file deploy/team/config.env -f
 deploy/team/compose.yaml down` (on one line). This keeps volumes. Stop
Tailscale serving with `tailscale serve reset` if configured.

PostgreSQL has no published port and is reachable only on the private database
network. Its container is capped at 2 GiB and 2 CPUs. A hostile knowledge query
can exhaust that cap and restart PostgreSQL, briefly interrupting chat. This
is a container bound, not a per-query memory guarantee. External managed/TLS
PostgreSQL and native unbounded PostgreSQL are outside this v1 recipe.
