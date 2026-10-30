#!/bin/bash
set -euo pipefail
[[ "$HOME" == /Users/admin && -d "$HOME/opensteer-job" ]] || { echo 'Use pnpm test:vm'; exit 2; }
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export OPENSTEER_MAC_OWNER_INPUT_JOURNEY=1
export OPENSTEER_WINDOW_GROUP_CASES=members
base_out="$HOME/opensteer-job/artifacts/mac-owner"
mkdir -p "$base_out" "$HOME/Applications"
work=$(mktemp -d "${OPENSTEER_LEGACY_TEMP_ROOT:-$HOME/Applications}/opensteer-owner-input.XXXXXX")
cleanup() {
  status=$?
  pkill -TERM -f "$work/" 2>/dev/null || true
  for attempt in 1 2 3 4 5; do pgrep -f "$work/" >/dev/null || break; sleep 0.2; done
  pkill -KILL -f "$work/" 2>/dev/null || true
  pgrep -fl "$work/" > "$base_out/remaining-processes.txt" || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT INT TERM
result=0
IFS=',' read -r -a engines <<< "${OPENSTEER_MAC_OWNER_ENGINES:-appkit,electron}"
for engine in "${engines[@]}"; do
  unset OPENSTEER_MAC_OWNER_ELECTRON_APP
  case "$engine" in
    appkit) ;;
    electron)
      electron_seed=$(node -e 'process.stdout.write(require("node:path").resolve(require("electron"), "../../.."))')
      electron_app="$work/OwnerElectron.app"
      ditto --norsrc --noextattr --noqtn "$electron_seed" "$electron_app"
      /usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier com.opensteer.owner-electron-fixture' "$electron_app/Contents/Info.plist"
      app_source="$electron_app/Contents/Resources/app"
      mkdir -p "$app_source"
      cp native/computer-use/Tests/Fixtures/MacOwnerInputJourney/electron.cjs "$app_source/electron.cjs"
      node -e 'const fs=require("node:fs"),path=require("node:path");const dir=process.argv[1];fs.writeFileSync(path.join(dir,"package.json"),JSON.stringify({name:"owner-electron-fixture",main:"electron.cjs"}));fs.writeFileSync(path.join(dir,"config.json"),JSON.stringify({output:process.argv[2]}));' "$app_source" "$HOME/opensteer-job/artifacts/window-groups/members"
      codesign --force --preserve-metadata=entitlements --sign - "$electron_app"
      export OPENSTEER_MAC_OWNER_ELECTRON_APP="$electron_app"
      ;;
    *) echo "Unknown owner engine: $engine"; exit 2 ;;
  esac
  export OPENSTEER_VIDEO_DIAGNOSTICS="$HOME/opensteer-job/artifacts/window-groups/members/owner-video.jsonl"
  set +e
  bash scripts/test-computer-use-window-groups.sh
  status=$?
  set -e
  mv "$HOME/opensteer-job/artifacts/window-groups" "$base_out/$engine"
  printf '%s\n' "$status" > "$base_out/$engine/exit-code.txt"
  if [[ "$status" != 0 ]]; then result=1; fi
  pkill -TERM -f "$work/" 2>/dev/null || true
  for attempt in 1 2 3 4 5; do pgrep -f "$work/" >/dev/null || break; sleep 0.2; done
  pkill -KILL -f "$work/" 2>/dev/null || true
done
exit "$result"
