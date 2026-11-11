#!/usr/bin/env bash
set -euo pipefail
TEAM_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$TEAM_DIR/../.." && pwd)
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
set -a
# shellcheck source=/dev/null
source "$TEAM_DIR/config.env"
set +a
compose() { docker compose --project-directory "$TEAM_DIR" --env-file "$TEAM_DIR/config.env" "$@"; }
identity() {
  OPENSTEER_SOURCE_REVISION=$(git -C "$REPO_DIR" rev-parse HEAD)
  OPENSTEER_RELEASE_VERSION=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$REPO_DIR/package.json" | head -1)
  export OPENSTEER_SOURCE_REVISION OPENSTEER_RELEASE_VERSION
}
