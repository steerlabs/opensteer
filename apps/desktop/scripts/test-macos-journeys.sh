#!/bin/bash
set -euo pipefail
[[ -f "$HOME/.opensteer-test-guest" || ( "$HOME" == /Users/admin && -d "$HOME/opensteer-job" ) ]] || { echo 'Use pnpm test:vm -- --mobile bash scripts/test-macos-journeys.sh'; exit 2; }
# Before any journey: the image's screen capture approval, renewed as of this guest's clock (see
# that script). Past its 30 days macOS asks again at a journey's first capture and takes the
# active app from whatever journey runs.
bash "$(cd "$(dirname "$0")/../../.." && pwd)/scripts/test-vm/screen-capture-approval.sh"
exec pnpm exec tsx scripts/run-macos-journeys.ts "$@"
