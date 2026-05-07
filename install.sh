#!/bin/sh
set -eu

usage() {
  echo "usage: install.sh [--from PACKAGE_OR_PATH_OR_URL]" >&2
  exit 2
}

OPENSTEER_SOURCE="${OPENSTEER_INSTALL_SOURCE:-opensteer}"
if [ "${1:-}" = "--from" ]; then
  [ $# -eq 2 ] || usage
  OPENSTEER_SOURCE="$2"
elif [ $# -ne 0 ]; then
  usage
fi

if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

uv tool install --force --no-cache "$OPENSTEER_SOURCE"

OPENSTEER_BIN="${UV_TOOL_BIN_DIR:-$HOME/.local/bin}/opensteer"
if [ ! -x "$OPENSTEER_BIN" ] && command -v opensteer >/dev/null 2>&1; then
  OPENSTEER_BIN="$(command -v opensteer)"
fi
if [ ! -x "$OPENSTEER_BIN" ]; then
  echo "opensteer installed, but executable was not found at $OPENSTEER_BIN" >&2
  exit 1
fi

"$OPENSTEER_BIN" skills install
"$OPENSTEER_BIN" --doctor || true
