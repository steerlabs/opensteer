# Self-host with Docker

Agent Phone isn’t included in self-built images yet.

Use Git and Docker Engine 29.2.1 or newer with Compose 5.1.3 and Buildx 0.36.1. Docker Desktop may supply these plugins.
No host Node, pnpm, Java or Android SDK is needed. The daemon needs Internet
access to public image registries and package repositories. This walkthrough
uses a local-directory workspace on a cohosted Linux Runner; it needs neither
PortableFS nor an external Runner.

```sh
git clone https://github.com/steerlabs/opensteer.git opensteer
cd opensteer
cp deploy/self-host/config.env.example deploy/self-host/config.env
```

Initialize build identity and secrets using Docker's Node image. Run from the
repository root. Existing secrets are preserved. Keep `config.env`, `secrets/`
and Docker data volumes across upgrades; back them up together. The secret
files must be readable by container uid 10001, inside an operator-only directory.

```sh
(
  set -eu
  initializer=$(docker create -w /source \
    -e OPENSTEER_SOURCE_REVISION="$(git rev-parse HEAD)" \
    node:24.13.0-bookworm-slim node deploy/self-host/initialize.mjs)
  trap 'docker rm -f "$initializer" >/dev/null' EXIT
  docker cp package.json "$initializer:/source/package.json"
  docker cp deploy "$initializer:/source/deploy"
  docker start -a "$initializer"
  docker cp "$initializer:/source/deploy/self-host/config.env" deploy/self-host/config.env
  docker cp "$initializer:/source/deploy/self-host/secrets" deploy/self-host/
)
```

Edit `deploy/self-host/config.env`: the initializer fills the required release
version, source revision and stable local workspace environment ID. Set the
required `OPENSTEER_CANONICAL_ORIGIN` to the exact URL you will open, including
scheme and port. Keep `OPENSTEER_MODE=production`: images carry a verified web distribution.
For local use, use `https://localhost`; Caddy issues a local certificate,
so accept its certificate warning in your browser before signing in. For an
Internet deployment use your DNS hostname with `https://`; ports 80 and 443
must reach this machine so Caddy can obtain a publicly trusted certificate. Keep the other uncommented defaults,
including `OPENSTEER_RUNTIME_ORIGIN=https://gateway:8443`,
`OPENSTEER_ACCEPTS_EXTERNAL_RUNNERS=false` and `local-directory` storage.
The remaining secret values are generated above, never entered in config.env.

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

Repeat this extraction when upgrading the images. Compose runs uid 10001 with
a read-only root, the compiled seccomp policy and the two capabilities required
by the Runner's own sandbox preflight.

The base file provides PostgreSQL, Host, web gateway, browser and messaging.
The Linux Runner overlay provides workspace storage and agent execution. The
initial-owner overlay mounts a one-time enrollment code; add it only for setup.

```sh
docker compose --env-file deploy/self-host/config.env \
  -f deploy/self-host/compose.yaml \
  -f deploy/self-host/compose.runner-linux.yaml \
  -f deploy/self-host/compose.initial-owner.yaml up -d --build --wait \
  postgres host gateway control-ca-export browser-egress browser-runtime channel-runtime
cat deploy/self-host/secrets/initial_owner_enrollment_token
```

Open the configured canonical origin. Enter that enrollment code in initial
setup, then create the owner's email and password. Setup codes
expire; complete setup within one hour of the first Host start.

Enroll the cohosted Runner as the owner. The block prompts for the account you
just created; the password is not echoed or saved in shell history. It signs in
through the public API, uses administrator-only
`runner.enrollment.createManaged`, writes the one-use token to the existing
enrollment secret (mode 0644, like the other secrets, so the Runner's uid 10001
can read it), and starts the Runner with that secret. The token expires after
ten minutes; run this block together.

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

Keep the stable `OPENSTEER_LOCAL_WORKSPACE_ENVIRONMENT_ID` and `runner-data`
volume: later restarts use the persisted Runner identity, without enrollment.
The one-time token overlay can now be dropped. In Computers, the Runner should
show as online.

After enrollment, create a workspace in the web UI and connect a model account
to run an agent. Workspace files live in the Runner's Docker volumes.

To stop without deleting data:

```sh
docker compose --env-file deploy/self-host/config.env \
  -f deploy/self-host/compose.yaml \
  -f deploy/self-host/compose.runner-linux.yaml down
```

To upgrade, back up the configuration, secrets and data volumes,
stop the stack, fetch and check out the intended release, rerun the initializer
to refresh build identity, then run `up -d --build --wait` with the base and Linux
Runner files (without the initial-owner overlay). Never use `down -v` for an
upgrade: it deletes workspace and database volumes.
