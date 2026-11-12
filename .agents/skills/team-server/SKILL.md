---
name: team-server
description: Run the self-hosted team server in Docker for local testing, renew its first-owner setup link, or stop a test stack without touching personal Opensteer.
---

# Team server

Read [Teams](../../../docs/teams.md) for authority and version boundaries and the
[deployment recipe](../../../deploy/team/README.md) for production scheduling.
Use a dedicated disposable checkout and fresh volumes. Never use the live install or
`~/Opensteer`. No screen driving, real accounts or credentials in test fixtures.

## Local Docker test

Use Docker Compose v2. Run `bash deploy/team/setup.sh` once to create config.env,
then edit it for the test HTTPS origin. First-owner Account adoption needs a public
HTTPS origin (a public hostname or Tailscale Funnel); a private-only tailnet origin
cannot pass Account's public proof fetch. No Connect for teams in v1.

`setup.sh` provisions secrets and runs the newest published release of the configured
channel; disable its updater as described in the recipe. To test unreleased source instead,
do not run setup.sh again: create the secrets and run locally built images under a local version:

```sh
bash deploy/team/secrets.sh init deploy/team/secrets
for target in host team-gateway; do
  docker build -f deploy/container/Containerfile --target "$target" \
    --build-arg OPENSTEER_AGENT_PHONE_MODE=none \
    --build-arg OPENSTEER_RELEASE_VERSION="$(node -p 'require("./package.json").version')" \
    --build-arg OPENSTEER_SOURCE_REVISION="$(git rev-parse HEAD)" \
    -t "ghcr.io/steerlabs/opensteer-team-${target#team-}:local" .
done
export OPENSTEER_TEAM_VERSION=local
source deploy/team/common.sh
compose up -d --wait --pull never
team_container_ids=$(compose ps -aq)
```

Capture container IDs even after a partial start, and stop only those containers.
Keep volumes until evidence is collected. Never stop another test's stack by name.

## Renew first-owner setup

The first-owner token expires 24 hours after initialization; restarting with the same
token preserves that deadline. On an unclaimed disposable team only, replace the token
and recreate the Host, because Compose secrets mount the old file. In the same shell:

```sh
bash deploy/team/secrets.sh renew deploy/team/secrets
compose up -d --force-recreate --wait host
team_container_ids=$(compose ps -aq)
```

Open the new `/setup#<token>` link privately on the configured team origin; never
put it in logs or evidence. Setup cannot claim a server that already has an owner.
Re-running setup without rotating the token does not renew an expired admission.

## Stop

After success or failure, refresh the IDs for this owned Compose project, then stop
and remove each captured container by ID. Do not remove volumes unless disposing
of this test's data was requested.

```sh
team_container_ids=$(compose ps -aq)
for team_container_id in $team_container_ids; do
  docker stop "$team_container_id"
  docker rm "$team_container_id"
done
```

Use Bash for these snippets. Report setup, link renewal and shutdown separately;
starting containers proves no end-to-end team journey.
