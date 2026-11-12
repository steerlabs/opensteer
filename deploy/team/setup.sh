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
acquire_lock || { echo 'An update is running; run setup.sh again shortly.' >&2; exit 1; }
if [[ "$RENEW_SETUP" == true ]]; then
  [[ -n "${OPENSTEER_TEAM_VERSION:-}" ]] || { echo 'Run setup.sh before renewing the setup link.' >&2; exit 1; }
  bash "$TEAM_DIR/secrets.sh" renew "$TEAM_DIR/secrets"
  compose up -d --wait --no-deps --force-recreate host
else
  bash "$TEAM_DIR/secrets.sh" init "$TEAM_DIR/secrets"
  select_release
  if [[ -n "${OPENSTEER_TEAM_VERSION:-}" ]] && version_older "$RELEASE_VERSION" "$OPENSTEER_TEAM_VERSION"; then
    compose up -d --wait
  else
    deploy_release
  fi
  bash "$TEAM_DIR/install-scheduler.sh"
fi
printf 'First-owner setup link (one time; keep private):\n%s/setup#%s\n' "${OPENSTEER_CANONICAL_ORIGIN%/}" "$(cat "$TEAM_DIR/secrets/initial_owner_enrollment_token")"
