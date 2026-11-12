#!/usr/bin/env bash
set -euo pipefail
TEAM_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$TEAM_DIR/../.." && pwd)
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
set -a
# shellcheck source=/dev/null
source "$TEAM_DIR/config.env"
set +a
if [[ -z ${OPENSTEER_TEAM_VERSION:-} && -f "$TEAM_DIR/state/running-version" ]]; then
  OPENSTEER_TEAM_VERSION=$(cat "$TEAM_DIR/state/running-version")
fi
export OPENSTEER_TEAM_VERSION
compose() { docker compose --project-directory "$TEAM_DIR" --env-file "$TEAM_DIR/config.env" "$@"; }

# One setup or update changes the stack at a time.
acquire_lock() {
  local lock="$TEAM_DIR/state/update.lock" pid
  mkdir -p "$TEAM_DIR/state"
  if ! mkdir "$lock" 2>/dev/null; then
    pid=$(cat "$lock/pid" 2>/dev/null || true)
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then return 1; fi
    rm -f "$lock/pid"
    rmdir "$lock" 2>/dev/null || return 1
    mkdir "$lock" 2>/dev/null || return 1
  fi
  printf '%s\n' "$$" > "$lock/pid"
  trap 'rm -f "$TEAM_DIR/state/update.lock/pid"; rmdir "$TEAM_DIR/state/update.lock"' EXIT
}

# A channel's published release tags are its feed; each names the image version it runs.
select_release() {
  local pattern
  case "${OPENSTEER_UPDATE_CHANNEL:-stable}" in
    stable) pattern='^desktop-v[0-9]+\.[0-9]+\.[0-9]+$' ;;
    beta) pattern='^v[0-9]+\.[0-9]+\.[0-9]+-insider$' ;;
    *) echo 'Channel must be stable or beta' >&2; return 1 ;;
  esac
  git -C "$REPO_DIR" fetch --quiet "${OPENSTEER_UPDATE_REMOTE:-origin}" --tags
  RELEASE_TAG=$(git -C "$REPO_DIR" tag --sort=-version:refname | { grep -E "$pattern" || true; } | sed -n '1p')
  [[ -n "$RELEASE_TAG" ]] || { echo 'No release tag found' >&2; return 1; }
  RELEASE_VERSION=$(printf '%s\n' "$RELEASE_TAG" | sed -E 's/^(desktop-)?v//; s/-insider$//')
}

# True when version $1 is older than version $2.
version_older() {
  [[ "$1" != "$2" && $(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | sed -n '1p') == "$1" ]]
}

# Runs the selected release with the deploy files from its own tag.
deploy_release() {
  [[ -z $(git -C "$REPO_DIR" status --porcelain --untracked-files=no) ]] || { echo 'Refusing to deploy from a modified checkout' >&2; return 1; }
  git -C "$REPO_DIR" checkout --quiet --detach "$RELEASE_TAG"
  OPENSTEER_TEAM_VERSION=$RELEASE_VERSION
  compose pull --quiet
  compose up -d --wait
  printf '%s\n' "$RELEASE_VERSION" > "$TEAM_DIR/state/running-version.next"
  mv "$TEAM_DIR/state/running-version.next" "$TEAM_DIR/state/running-version"
}
