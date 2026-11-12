#!/usr/bin/env bash
set -Eeuo pipefail
# shellcheck disable=SC1091
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
acquire_lock || exit 0
exec >> "$TEAM_DIR/update.log" 2>&1
trap 'printf "%s update failed\n" "$(date -u +%FT%TZ)" >&2' ERR
select_release
[[ "$RELEASE_VERSION" != "${OPENSTEER_TEAM_VERSION:-}" ]] || exit 0
if [[ -n "${OPENSTEER_TEAM_VERSION:-}" ]] && version_older "$RELEASE_VERSION" "$OPENSTEER_TEAM_VERSION"; then
  printf '%s keeping %s; %s is older\n' "$(date -u +%FT%TZ)" "$OPENSTEER_TEAM_VERSION" "$RELEASE_TAG"
  exit 0
fi
deploy_release
printf '%s updated to %s\n' "$(date -u +%FT%TZ)" "$RELEASE_TAG"
