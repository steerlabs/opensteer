#!/usr/bin/env bash
set -euo pipefail
if [[ ! -f "$HOME/.opensteer-test-guest" && "$PWD" != */opensteer-job/src/apps/desktop ]]; then
  echo 'Run through pnpm test:vm -- bash ../web/scripts/run-display-editing-desktop-smoke.sh' >&2
  exit 1
fi
taskBundleDir=$(mktemp -d "${TMPDIR:-/tmp/}"opensteer-display-smoke.XXXXXX)
trap 'rm -rf "$taskBundleDir"' EXIT
cd ../..
pnpm exec esbuild apps/web/scripts/fixtures/display-editing-viewer.tsx --bundle --format=esm --jsx=automatic --target=es2024 --define:process.env.NODE_ENV='"production"' --outfile="$taskBundleDir/viewer.js"
pnpm exec esbuild apps/web/scripts/display-editing-desktop-smoke.cjs --bundle --platform=node --format=cjs --external:electron --outfile="$taskBundleDir/main.cjs"
cd apps/desktop
OPENSTEER_DISPLAY_SMOKE_BUNDLE="$taskBundleDir/viewer.js" pnpm exec electron "$taskBundleDir/main.cjs"
