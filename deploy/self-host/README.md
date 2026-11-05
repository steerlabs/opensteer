# Self-host with Docker

This runs a server Deployment with a cohosted Linux Runner whose workspaces live in local
directories; it needs no external Runner. Self-built images don't include Agent Phone yet.

You need Git and Docker Engine 29.2.1 or newer with Compose 5.1.3 and Buildx 0.36.1 (Docker
Desktop may supply the plugins), and Internet access for the daemon to public image registries
and package repositories. No host Node, pnpm, Java or Android SDK is needed.

```sh
git clone https://github.com/steerlabs/opensteer.git opensteer
cd opensteer
cp deploy/self-host/config.env.example deploy/self-host/config.env
```

From the repository root, initialize build identity and secrets with Docker's Node image.
Existing secrets are kept. The secret files must be readable by container uid 10001 inside an
operator-only directory. Keep `config.env`, `secrets/` and the Docker volumes across upgrades,
and back them up together.

```sh
(
  set -eu
  initializer=$(docker create -w /source \
    -e OPENSTEER_SOURCE_REVISION="$(git rev-parse HEAD)" \
    node:24.22.2-bookworm-slim node deploy/self-host/initialize.mjs)
  trap 'docker rm -f "$initializer" >/dev/null' EXIT
  docker cp package.json "$initializer:/source/package.json"
  docker cp deploy "$initializer:/source/deploy"
  docker start -a "$initializer"
  docker cp "$initializer:/source/deploy/self-host/config.env" deploy/self-host/config.env
  docker cp "$initializer:/source/deploy/self-host/secrets" deploy/self-host/
)
```

The initializer fills the release version, source revision and workspace environment ID in
`deploy/self-host/config.env`. Set `OPENSTEER_CANONICAL_ORIGIN` to the exact URL you will open,
including scheme and port:

- Local use: `https://localhost`. Caddy issues a local certificate; accept its warning in your
  browser before signing in.
- Internet: `https://` with your DNS hostname. Ports 80 and 443 must reach this machine so Caddy
  can get a publicly trusted certificate.

Keep `OPENSTEER_MODE=production` (images carry a verified web distribution) and the other
uncommented defaults. Secrets are generated above, never entered in `config.env`.

## Runner sandbox

Set the required `OPENSTEER_RUNNER_APPARMOR_PROFILE` in `config.env` explicitly.
On the Linux Docker host, check:

```sh
cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns
```

If the file is absent or its value is `0`, use `unconfined`. If it is `1`, load
the repository's single Runner profile and use `opensteer-runner-smoke`:

```sh
sudo apparmor_parser --replace deploy/container/runner-smoke.apparmor
```

For Colima, run the check and load inside its VM instead (the checkout must be
in a directory shared with the VM):

```sh
colima ssh -- cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns
colima ssh -- sudo apparmor_parser --replace "$PWD/deploy/container/runner-smoke.apparmor"
```

Build the Runner and extract its exact seccomp policy before starting Compose:

```sh
docker compose --env-file deploy/self-host/config.env \
  -f deploy/self-host/compose.yaml \
  -f deploy/self-host/compose.runner-linux.yaml build runner
image_tag=$(sed -n 's/^OPENSTEER_IMAGE_TAG=//p' deploy/self-host/config.env)
docker run --rm --entrypoint cat "opensteer-runner:$image_tag" \
  /usr/local/share/opensteer/runner-oci.json > deploy/self-host/runner-seccomp.json
```

Repeat this extraction whenever you upgrade the images. Compose runs the Runner as uid 10001
with a read-only root, that seccomp policy and the two capabilities its own sandbox needs.

## Start and claim ownership

`compose.yaml` provides PostgreSQL, Host, the web gateway, browsers and messaging;
`compose.runner-linux.yaml` adds workspace storage and agent execution. The initial-owner
overlay mounts a one-time enrollment code; use it only for setup.

```sh
docker compose --env-file deploy/self-host/config.env \
  -f deploy/self-host/compose.yaml \
  -f deploy/self-host/compose.runner-linux.yaml \
  -f deploy/self-host/compose.initial-owner.yaml up -d --build --wait \
  postgres host gateway control-ca-export browser-egress browser-runtime channel-runtime
cat deploy/self-host/secrets/initial_owner_enrollment_token
```

Open the canonical origin, enter that code in initial setup, and create the owner's email and
password. The code expires 24 hours after the first Host start.

## Enroll the Runner

This block prompts for the owner account (the password is neither echoed nor kept in shell
history), signs in through the public API, mints a one-use managed Runner enrollment, writes it
to the enrollment secret (mode 0644 so uid 10001 can read it) and starts the Runner. The token
expires after ten minutes, so run the block in one go.

```sh
printf 'Owner email: '; read -r OPENSTEER_OWNER_EMAIL
printf 'Owner password: '; stty -echo; read -r OPENSTEER_OWNER_PASSWORD; stty echo; printf '\n'
export OPENSTEER_OWNER_EMAIL OPENSTEER_OWNER_PASSWORD
(umask 022; docker compose --env-file deploy/self-host/config.env \
  -f deploy/self-host/compose.yaml \
  -f deploy/self-host/compose.runner-linux.yaml \
  exec -T -e OPENSTEER_OWNER_EMAIL -e OPENSTEER_OWNER_PASSWORD host \
  node --input-type=module < deploy/self-host/enroll-runner.mjs \
  > deploy/self-host/secrets/runner_enrollment_token)
unset OPENSTEER_OWNER_EMAIL OPENSTEER_OWNER_PASSWORD
docker compose --env-file deploy/self-host/config.env \
  -f deploy/self-host/compose.yaml \
  -f deploy/self-host/compose.runner-linux.yaml \
  -f deploy/self-host/compose.runner-enrollment.yaml up -d --wait
```

The Runner should show as online in Computers. Later restarts reuse its persisted identity, so
drop the enrollment overlay, and keep `OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID` and the
`runner-data` volume. Create a workspace in the web UI and connect a model account to run an
agent; workspace files live in the Runner's Docker volumes.

## Stop and upgrade

To stop without deleting data:

```sh
docker compose --env-file deploy/self-host/config.env \
  -f deploy/self-host/compose.yaml \
  -f deploy/self-host/compose.runner-linux.yaml down
```

To upgrade, back up the configuration, secrets and volumes, stop the stack, check out the
release you want, rerun the initializer to refresh build identity, repeat the seccomp extraction,
then run `up -d --build --wait` with the base and Linux Runner files only. Never use `down -v`:
it deletes the workspace and database volumes.
