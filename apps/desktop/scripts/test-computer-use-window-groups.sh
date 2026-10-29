#!/bin/bash
set -euo pipefail
[[ -f "$HOME/.opensteer-test-guest" || ( "$HOME" == /Users/admin && -d "$HOME/opensteer-job" ) ]] || { echo 'Use pnpm test:vm'; exit 2; }
out="${OPENSTEER_JOURNEY_OUT:-$HOME/opensteer-job/artifacts/window-groups}"
mkdir -p "$out"
exec > >(tee "$out/runner.log") 2>&1
if [[ -n "${OPENSTEER_JOURNEY_APPS:-}" ]]; then
  work="$OPENSTEER_JOURNEY_APPS"
else
  mkdir -p "$HOME/Applications"
  work=$(mktemp -d "$HOME/Applications/opensteer-window-groups.XXXXXX")
fi
journey_pid=''
cleanup() {
  status=$?
  if [[ -n "$journey_pid" ]]; then kill "$journey_pid" 2>/dev/null || true; wait "$journey_pid" 2>/dev/null || true; fi
  if [[ -z "${OPENSTEER_JOURNEY_APPS:-}" ]]; then rm -rf "$work"; fi
  exit "$status"
}
trap cleanup EXIT INT TERM
fixture="$work/WindowGroupFixture.app"
if [[ ! -x "$work/Journey" ]]; then
mkdir -p "$fixture/Contents/MacOS"
xcrun swiftc native/computer-use/Tests/Fixtures/WindowGroupJourney/Receiver.swift -o "$fixture/Contents/MacOS/Receiver"
cat > "$fixture/Contents/Info.plist" <<'PLIST'
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Receiver</string><key>CFBundleIdentifier</key><string>com.opensteer.window-group-fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleName</key><string>Window Group Fixture</string></dict></plist>
PLIST
/usr/libexec/PlistBuddy -c "Add :FixtureOutput string $out" "$fixture/Contents/Info.plist"
codesign --force --sign - "$fixture"
other_fixture=''
if [[ "${OPENSTEER_MAC_OWNER_INPUT_JOURNEY:-}" == 1 ]]; then
  other_fixture="$work/OtherOwnerFixture.app"
  ditto --norsrc --noextattr --noqtn "$fixture" "$other_fixture"
  /usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier com.opensteer.owner-other-fixture' "$other_fixture/Contents/Info.plist"
  export OPENSTEER_MAC_OWNER_OTHER_APP="$other_fixture"
fi
pnpm build:computer-use-helper --requirement-only
bash scripts/test-support/build-apple-data-module.sh "$work"
sources=()
while IFS= read -r file; do sources+=("$file"); done < <(find native/computer-use/Sources/ComputerUseCore -name '*.swift' | sort)
xcrun swiftc -whole-module-optimization -parse-as-library -module-name ComputerUseCore -swift-version 5 -I "$work" -L "$work" -lOpensteerAppleData -lMacOSSigning -o "$work/Journey" "${sources[@]}" native/computer-use/Tests/Fixtures/WindowGroupJourney/Journey.swift native/computer-use/Tests/Fixtures/WindowGroupJourney/Contracts.swift native/computer-use/Tests/Fixtures/WindowGroupJourney/Video.swift native/computer-use/Tests/Fixtures/WindowGroupJourney/Wire.swift native/computer-use/Tests/Fixtures/WindowGroupJourney/Person.swift native/computer-use/Tests/Fixtures/WindowGroupJourney/OwnerLatency.swift native/computer-use/Tests/Fixtures/WindowGroupJourney/BatchCancellation.swift native/computer-use/Tests/Fixtures/WindowGroupJourney/Lifetime.swift native/computer-use/Tests/Fixtures/WindowGroupJourney/ReceiptSwitch.swift native/computer-use/Tests/Fixtures/WindowGroupJourney/Focus.swift native/computer-use/Tests/Fixtures/WindowGroupJourney/Sharing.swift
fi
other_fixture=''
if [[ "${OPENSTEER_MAC_OWNER_INPUT_JOURNEY:-}" == 1 ]]; then
  other_fixture="$work/OtherOwnerFixture.app"
  export OPENSTEER_MAC_OWNER_OTHER_APP="$other_fixture"
fi
suite_result=0
base_out="$out"
IFS=',' read -r -a cases <<< "${OPENSTEER_WINDOW_GROUP_CASES:-current,settle,cancellation,video,members,focus,receipt-switch}"
for selected in "${cases[@]}"; do
  unset OPENSTEER_WINDOW_GROUP_VIDEO_FIRST OPENSTEER_WINDOW_GROUP_VIDEO_ONLY OPENSTEER_WINDOW_GROUP_OVERLAY OPENSTEER_WINDOW_GROUP_CURRENT_ONLY
  case "$selected" in
    cancellation|settle|focus|receipt-switch) ;;
    members) ;;
    video) export OPENSTEER_WINDOW_GROUP_VIDEO_FIRST=1 OPENSTEER_WINDOW_GROUP_VIDEO_ONLY=1 ;;
    current) export OPENSTEER_WINDOW_GROUP_OVERLAY=1 OPENSTEER_WINDOW_GROUP_CURRENT_ONLY=1 ;;
    *) echo "Unknown native selection: $selected"; exit 2 ;;
  esac
  export OPENSTEER_WINDOW_GROUP_SELECTION="$selected"
  out="$base_out/$selected"
  mkdir -p "$out"
  /usr/libexec/PlistBuddy -c "Set :FixtureOutput $out" "$fixture/Contents/Info.plist"
  codesign --force --sign - "$fixture"
  if [[ -n "$other_fixture" ]]; then
    mkdir -p "$out/other-app"
    /usr/libexec/PlistBuddy -c "Set :FixtureOutput $out/other-app" "$other_fixture/Contents/Info.plist"
    codesign --force --sign - "$other_fixture"
  fi
  selection_start=$SECONDS
  "$work/Journey" "$out" "$fixture" &
  journey_pid=$!
  set +e
  wait "$journey_pid"
  status=$?
  journey_pid=''
  set -e
  printf '%s\n' "$((SECONDS-selection_start))" > "$out/seconds.txt"
  printf '%s\n' "$status" > "$out/exit-code.txt"
  if [[ "$status" != 0 ]]; then suite_result=1; fi

done
out="$base_out"
exit "$suite_result"
