#!/bin/bash
set -euo pipefail
[[ -f "$HOME/.opensteer-test-guest" || ( "$HOME" == /Users/admin && -d "$HOME/opensteer-job" ) ]] || { echo 'Use pnpm test:vm -- --mobile bash scripts/test-macos-journeys.sh'; exit 2; }
# Before any journey: replayd is told the image's screen capture approval was asked past any job
# (2100-01-01; see that script), so macOS does not ask again at a journey's first capture and take
# the active app from whatever journey runs.
bash "$(cd "$(dirname "$0")/../../.." && pwd)/scripts/test-vm/screen-capture-approval.sh"
exec pnpm exec tsx scripts/run-macos-journeys.ts "$@"
