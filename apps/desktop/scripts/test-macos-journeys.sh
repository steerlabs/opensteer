#!/bin/bash
set -euo pipefail
[[ -f "$HOME/.opensteer-test-guest" || ( "$HOME" == /Users/admin && -d "$HOME/opensteer-job" ) ]] || { echo 'Use pnpm test:vm -- --mobile bash scripts/test-macos-journeys.sh'; exit 2; }
exec pnpm exec tsx scripts/run-macos-journeys.ts "$@"
