#!/bin/bash
set -euo pipefail
[[ "$HOME" == /Users/admin && -d "$HOME/opensteer-job" ]] || { echo 'Use pnpm test:vm'; exit 2; }
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export OPENSTEER_MAC_OWNER_INPUT_JOURNEY=1
export OPENSTEER_WINDOW_GROUP_CASES=members
base_out="$HOME/opensteer-job/artifacts/mac-owner"
mkdir -p "$base_out" "$HOME/Applications"
work=$(mktemp -d "${OPENSTEER_LEGACY_TEMP_ROOT:-$HOME/Applications}/opensteer-owner-input.XXXXXX")
# The helper finds an app only where a person's apps live: the Electron fixture
# goes in this guest's ~/Applications, removed with the rest.
apps=$(mktemp -d "$HOME/Applications/opensteer-owner-input-apps.XXXXXX")
# The journey stops the apps it launched by their own handles and records
# them in owned-apps.json; anything a crashed journey leaves dies with the
# disposable VM.
electron_domain=com.opensteer.owner-electron-fixture
cleanup() {
  status=$?
  rm -rf "$work" "$apps"
  # The Electron fixture's own defaults domain. Deleting it through cfprefsd
  # keeps a cached copy from writing the file again; absent is not an error.
  defaults delete "$electron_domain" >/dev/null 2>&1 || true
  rm -f "$HOME/Library/Preferences/$electron_domain.plist"
  rm -rf "$HOME/Library/Saved Application State/$electron_domain.savedState"
  exit "$status"
}
trap cleanup EXIT INT TERM
# Both engine passes run the same compiled journey; each builds its own fixtures.
export OPENSTEER_WINDOW_GROUP_BUILD="$work/window-groups-build"
mkdir -p "$OPENSTEER_WINDOW_GROUP_BUILD"
result=0
IFS=',' read -r -a engines <<< "${OPENSTEER_MAC_OWNER_ENGINES:-appkit,electron}"
for engine in "${engines[@]}"; do
  unset OPENSTEER_MAC_OWNER_ELECTRON_APP
  case "$engine" in
    appkit) ;;
    electron)
      electron_seed=$(node -e 'process.stdout.write(require("node:path").resolve(require("electron"), "../../.."))')
      electron_app="$apps/OwnerElectron.app"
      ditto --norsrc --noextattr --noqtn "$electron_seed" "$electron_app"
      /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $electron_domain" "$electron_app/Contents/Info.plist"
      app_source="$electron_app/Contents/Resources/app"
      mkdir -p "$app_source"
      cp native/computer-use/Tests/Fixtures/MacOwnerInputJourney/electron.cjs "$app_source/electron.cjs"
      node -e 'const fs=require("node:fs"),path=require("node:path");const dir=process.argv[1];fs.writeFileSync(path.join(dir,"package.json"),JSON.stringify({name:"owner-electron-fixture",main:"electron.cjs"}));fs.writeFileSync(path.join(dir,"config.json"),JSON.stringify({output:process.argv[2],userData:process.argv[3]}));' "$app_source" "$HOME/opensteer-job/artifacts/window-groups/members" "$work/electron-user-data"
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
done
exit "$result"
