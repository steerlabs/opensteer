# Run a team

Use a dedicated clone on a Linux server or family Mac with Docker Compose v2,
Git, Bash and OpenSSL. On Mac, Docker Desktop or Colima must be running; the
scheduled updater needs access to that same Docker context. This stack runs
PostgreSQL, the team Host and Caddy. Agents run on each person's own Opensteer.

Run `bash deploy/team/setup.sh`, edit the generated `deploy/team/config.env`,
then run setup again. Use an HTTPS public hostname pointing to the machine
with inbound ports 80 and 443 available. Setup builds before starting, installs
hourly updates, then prints the private, one-time first-owner setup link.
Open it, adopt the server through Opensteer Account, sign in and become owner.
Later members join through invites. Do not send the setup link to other people.

The first-owner route is an integration contract pending lane T: `/setup#<token>`
uses `OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN_FILE` and must exchange the token
for an `auth_admissions` purpose `setup` admission before Account adoption.
Do not deploy this recipe until that route is connected.

For Tailscale, bind the gateway only to loopback by setting
`OPENSTEER_HTTP_BIND=127.0.0.1` and `OPENSTEER_HTTPS_BIND=127.0.0.1` in config.env.
Use the machine's HTTPS tailnet name as `OPENSTEER_CANONICAL_ORIGIN`, set
`OPENSTEER_GATEWAY_SITE_ADDRESS=:80` in config.env, and run
`tailscale serve --bg http://127.0.0.1:80`. Tailscale terminates HTTPS. There are
no Connect routes for team servers in v1.

Updates fetch tags from the cloned remote (`OPENSTEER_UPDATE_REMOTE`, default
`origin`). `OPENSTEER_UPDATE_CHANNEL=stable` selects `desktop-vMAJOR.MINOR.PATCH`;
`beta` selects `vMAJOR.MINOR.PATCH-insider`, matching release.yml's release tool.
A failed build leaves the existing containers running. Results go to
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
