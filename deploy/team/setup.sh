#!/usr/bin/env bash
set -euo pipefail
umask 077
RENEW_SETUP=false
case "${1:-}" in
  "") ;;
  --renew-setup) RENEW_SETUP=true ;;
  *) echo 'Usage: setup.sh [--renew-setup]' >&2; exit 1 ;;
esac
[[ $# -le 1 ]] || { echo 'Usage: setup.sh [--renew-setup]' >&2; exit 1; }
TEAM_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ ! -f "$TEAM_DIR/config.env" ]]; then
  cp "$TEAM_DIR/config.env.example" "$TEAM_DIR/config.env"
  echo "Set OPENSTEER_CANONICAL_ORIGIN in $TEAM_DIR/config.env, then run setup.sh again."
  exit 0
fi
# shellcheck disable=SC1091
source "$TEAM_DIR/common.sh"
[[ "$OPENSTEER_CANONICAL_ORIGIN" == https://* && "$OPENSTEER_CANONICAL_ORIGIN" != https://team.example.com ]] || { echo 'Configure an HTTPS origin first'; exit 1; }
mkdir -p "$TEAM_DIR/state"
chmod 700 "$TEAM_DIR/state"
identity
if [[ "$RENEW_SETUP" == true ]]; then
  pnpm --dir "$REPO_DIR" exec tsx scripts/init-team.ts --renew-setup --secrets-dir "$TEAM_DIR/secrets"
  compose up -d --wait --no-deps --force-recreate host
else
  pnpm --dir "$REPO_DIR" exec tsx scripts/init-team.ts --secrets-dir "$TEAM_DIR/secrets"
  compose build
  compose up -d --wait
fi
printf '%s\n' "$OPENSTEER_SOURCE_REVISION" > "$TEAM_DIR/state/running-revision"
if [[ "$RENEW_SETUP" == false ]]; then bash "$TEAM_DIR/install-scheduler.sh"; fi
printf 'First-owner setup link (one time; keep private):\n%s/setup#%s\n' "${OPENSTEER_CANONICAL_ORIGIN%/}" "$(cat "$TEAM_DIR/secrets/initial_owner_enrollment_token")"
