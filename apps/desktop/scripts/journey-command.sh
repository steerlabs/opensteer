#!/bin/bash
set -euo pipefail
out="${OPENSTEER_JOURNEY_OUT:-}"
journey() {
  case "$1" in
    mac-owner) bash native/computer-use/Tests/Fixtures/MacOwnerInputJourney/run-vm.sh ;;
    saved-password) OPENSTEER_PASSWORDS_ANYWHERE_EVIDENCE_DIR="$out" pnpm test:electron-computer-use:run ;;
    chrome-background)
      # The journey's sweep selection runs when the fixture provides it; R0 otherwise.
      true
      selection=R0
      if grep -q '"sweep"' native/computer-use/Tests/Fixtures/ChromeBackgroundJourney/Journey.swift; then selection=sweep; fi
      OPENSTEER_RUN_CHROME_BACKGROUND_JOURNEYS=1 OPENSTEER_CHROME_JOURNEY="$selection" bash native/computer-use/Tests/Fixtures/ChromeBackgroundJourney/run-vm.sh ;;
    windows)
      true
      OPENSTEER_WINDOW_GROUP_CASES=current,settle,cancellation,video,receipt-switch bash scripts/test-computer-use-window-groups.sh ;;
    launch) pnpm -w test:gui ;;
    remote-input) bash scripts/test-viewer-clipboard.sh && pnpm test:electron-display:run && bash ../web/scripts/run-display-editing-viewer-checks.sh ;;
    # Its bundle is rebuilt here: the smoke bundle step above clears .electron-smoke.
    native-browser) pnpm build:native-browser-journey && pnpm test:native-browser-journey ;;
    electron)
      export OPENSTEER_CDP_BOUNDARY_E2E_ARTIFACT_DIR="$out/cdp-boundary"
      export OPENSTEER_PASSWORDS_E2E_ARTIFACT_DIR="$out/passwords"
      export OPENSTEER_ATTACHMENTS_E2E_ARTIFACT_DIR="$out/attachments"
      export OPENSTEER_DOWNLOADS_E2E_ARTIFACT_DIR="$out/downloads"
      export OPENSTEER_PROFILE_RESTORE_ARTIFACT_DIR="$out/profile-restore"
      export OPENSTEER_HOST_TRANSPORT_E2E_ARTIFACT_DIR="$out/host-transport"
      export OPENSTEER_SHARED_BROWSER_E2E_ARTIFACT_DIR="$out/browser"
      export OPENSTEER_BROWSER_FOLLOW_E2E_ARTIFACT_DIR="$out/browser"
      export OPENSTEER_BROWSER_E2E_ARTIFACT_DIR="$out/idle"
      export OPENSTEER_QUIT_E2E_ARTIFACT_DIR="$out/quit"
      export OPENSTEER_STATE_IMPORT_E2E_ARTIFACT_DIR="$out/cookies"
      export OPENSTEER_PASSKEY_POLICY_E2E_ARTIFACT_DIR="$out/passkeys"
      export OPENSTEER_USB_E2E_ARTIFACT_DIR="$out/usb"
      for smoke in cdp-boundary passwords attachments downloads profile-restore focus host-transport browser idle quit cookies passkeys usb; do
        mkdir -p "$out/$smoke"
        smoke_start=$SECONDS
        smoke_code=0
        if [[ "$smoke" == quit ]]; then
          pnpm test:electron-quit:run --tab-restore > "$out/$smoke.log" 2>&1 || smoke_code=$?
        else
          pnpm "test:electron-$smoke:run" > "$out/$smoke.log" 2>&1 || smoke_code=$?
        fi
        node scripts/test-support/validate-electron-journey.mjs "$out" "$smoke" "$smoke_code" "$((SECONDS-smoke_start))"
      done
      node -e 'const fs=require("fs");const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);if(rows.some(r=>r.exitCode!==0))process.exit(1)' "$out/results.jsonl"
      ;;
    # BackgroundInputLiveTests is opt-in tooling; the signing check needs a running team-signed app the guest never has.
    live-swift) swift test --package-path native/computer-use --filter ComputerUseLiveTests --skip 'BackgroundInputLiveTests|testRunningTeamSignedAppsMatchTheirOwnBundleIdentity' ;;
  esac
}
journey "$1"
