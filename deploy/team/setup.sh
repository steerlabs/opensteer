#!/usr/bin/env bash
set -euo pipefail
umask 077
TEAM_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ ! -f "$TEAM_DIR/config.env" ]]; then
  cp "$TEAM_DIR/config.env.example" "$TEAM_DIR/config.env"
  echo "Set OPENSTEER_CANONICAL_ORIGIN in $TEAM_DIR/config.env, then run setup.sh again."
  exit 0
fi
# shellcheck disable=SC1091
source "$TEAM_DIR/common.sh"
[[ "$OPENSTEER_CANONICAL_ORIGIN" == https://* && "$OPENSTEER_CANONICAL_ORIGIN" != https://team.example.com ]] || { echo 'Configure an HTTPS origin first'; exit 1; }
mkdir -p "$TEAM_DIR/secrets" "$TEAM_DIR/state"
chmod 700 "$TEAM_DIR/secrets" "$TEAM_DIR/state"
for name in postgres_password auth_secret credential_key initial_owner_enrollment_token; do
  if [[ ! -f "$TEAM_DIR/secrets/$name" ]]; then openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > "$TEAM_DIR/secrets/$name"; fi
done
if [[ ! -f "$TEAM_DIR/secrets/database_url" ]]; then
  printf 'postgresql://opensteer:%s@postgres:5432/opensteer\n' "$(cat "$TEAM_DIR/secrets/postgres_password")" > "$TEAM_DIR/secrets/database_url"
fi
# Compose file secrets must be readable by the unprivileged Host container user.
chmod 644 "$TEAM_DIR"/secrets/*
identity
compose build
compose up -d --wait
printf '%s\n' "$OPENSTEER_SOURCE_REVISION" > "$TEAM_DIR/state/running-revision"
bash "$TEAM_DIR/install-scheduler.sh"
printf 'First-owner setup link (one time; keep private):\n%s/setup#%s\n' "${OPENSTEER_CANONICAL_ORIGIN%/}" "$(cat "$TEAM_DIR/secrets/initial_owner_enrollment_token")"
