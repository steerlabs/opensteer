#!/bin/bash
set -euo pipefail
[[ "$HOME" == /Users/admin && -d "$HOME/opensteer-job" ]] || { echo 'Use pnpm test:vm'; exit 2; }
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
out="$HOME/opensteer-job/artifacts"
set +e
OPENSTEER_MAC_OWNER_EPOCH_JOURNEY=1 OPENSTEER_WINDOW_GROUP_CASES=members bash scripts/test-computer-use-window-groups.sh
native_epoch_status=$?
set -e
mv "$out/window-groups" "$out/mac-owner-epoch"
set +e
swift test --package-path native/computer-use --filter OwnerInputStateTests > "$out/owner-state-tests.log" 2>&1
native_state_status=$?
OPENSTEER_MAC_OWNER_ENGINES=appkit bash native/computer-use/Tests/Fixtures/MacOwnerInputJourney/run-vm.sh
native_capture_status=$?
set -e
node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({epochExitCode:Number(process.argv[2]),stateExitCode:Number(process.argv[3]),captureExitCode:Number(process.argv[4])},null,2))' "$out/owner-reproductions.json" "$native_epoch_status" "$native_state_status" "$native_capture_status"
[[ "$native_epoch_status" == 0 && "$native_state_status" == 0 && "$native_capture_status" == 0 ]]
