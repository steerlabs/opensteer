#!/usr/bin/env bash
set -euo pipefail
# shellcheck disable=SC1091
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
mkdir -p "$TEAM_DIR/state"
if ! mkdir "$TEAM_DIR/state/update.lock" 2>/dev/null; then
  if [[ -f "$TEAM_DIR/state/update.lock/pid" ]]; then
    previous_pid=$(cat "$TEAM_DIR/state/update.lock/pid")
    if [[ "$previous_pid" =~ ^[0-9]+$ ]] && kill -0 "$previous_pid" 2>/dev/null; then exit 0; fi
  fi
  rm -f "$TEAM_DIR/state/update.lock/pid"
  rmdir "$TEAM_DIR/state/update.lock" 2>/dev/null || exit 0
  mkdir "$TEAM_DIR/state/update.lock" 2>/dev/null || exit 0
fi
printf '%s\n' "$$" > "$TEAM_DIR/state/update.lock/pid"
trap 'rm -f "$TEAM_DIR/state/update.lock/pid"; rmdir "$TEAM_DIR/state/update.lock"' EXIT
exec >> "$TEAM_DIR/update.log" 2>&1
trap 'printf "%s update failed\n" "$(date -u +%FT%TZ)" >&2' ERR
cd "$REPO_DIR"
[[ -z $(git status --porcelain --untracked-files=no) ]] || { echo 'Refusing to update a modified checkout'; exit 1; }
git fetch "${OPENSTEER_UPDATE_REMOTE:-origin}" --tags
case "${OPENSTEER_UPDATE_CHANNEL:-stable}" in
  stable) pattern='^desktop-v[0-9]+\.[0-9]+\.[0-9]+$' ;;
  beta) pattern='^v[0-9]+\.[0-9]+\.[0-9]+-insider$' ;;
  *) echo 'Channel must be stable or beta'; exit 1 ;;
esac
tag=$(git tag --sort=-version:refname | { grep -E "$pattern" || true; } | sed -n '1p')
[[ -n "$tag" ]] || { echo 'No release tag found'; exit 1; }
revision=$(git rev-parse "$tag^{commit}")
if [[ -f "$TEAM_DIR/state/running-revision" ]] && [[ $(cat "$TEAM_DIR/state/running-revision") == "$revision" ]]; then exit 0; fi
git checkout --detach "$tag"
identity
compose build
compose up -d --wait
printf '%s\n' "$revision" > "$TEAM_DIR/state/running-revision.next"
mv "$TEAM_DIR/state/running-revision.next" "$TEAM_DIR/state/running-revision"
printf '%s updated to %s (%s)\n' "$(date -u +%FT%TZ)" "$tag" "$revision"
