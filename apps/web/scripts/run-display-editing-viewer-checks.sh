#!/usr/bin/env bash
set -euo pipefail
if [[ ! -f "$HOME/.opensteer-test-guest" && "$PWD" != */opensteer-job/src/apps/desktop ]]; then
  echo 'Run through pnpm test:vm -- bash ../web/scripts/run-display-editing-viewer-checks.sh' >&2
  exit 1
fi
taskStatus=0
bash ../web/scripts/run-display-editing-desktop-smoke.sh || taskStatus=1
cd ../web
if pnpm exec playwright-core install chromium; then
  pnpm -w exec tsx scripts/display-editing-browser-journey.ts || taskStatus=1
else
  taskStatus=1
fi
exit "$taskStatus"
