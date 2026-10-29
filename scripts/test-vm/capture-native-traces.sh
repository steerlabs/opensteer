#!/bin/bash
set -euo pipefail
[[ "$PWD" == */opensteer-job/src/apps/desktop ]] || { echo 'Run only through pnpm test:vm' >&2; exit 1; }
out="${OPENSTEER_NATIVE_TRACE_EVIDENCE_DIR:-$HOME/opensteer-job/artifacts/viewer-native-traces}"
mkdir -p "$out"
export OPENSTEER_NATIVE_TRACE_EVIDENCE_DIR="$out"
export OPENSTEER_NATIVE_TRACE_SHA="$(git rev-parse HEAD)"
export OPENSTEER_PROXY_TRACE_BUNDLE="$out/proxy.js"
engines=",${OPENSTEER_NATIVE_TRACE_ENGINES:-electron,chrome,safari,firefox},"
mountpoint=''
cleanup() {
  if [[ -n "$mountpoint" ]]; then hdiutil detach "$mountpoint" || true; fi
}
trap cleanup EXIT INT TERM HUP
install_browser() {
  local name="$1" url="$2" appname="$3"
  [[ ! -d "/Applications/$appname.app" ]] || return 0
  curl --fail --location --retry 2 "$url" -o "$out/$name.dmg"
  mountpoint="$out/$name-mount"
  mkdir -p "$mountpoint"
  hdiutil attach -nobrowse -readonly -mountpoint "$mountpoint" "$out/$name.dmg"
  ditto "$mountpoint/$appname.app" "/Applications/$appname.app"
  hdiutil detach "$mountpoint"
  mountpoint=''
}
if [[ "$engines" == *,chrome,* ]]; then
  install_browser chrome 'https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg' 'Google Chrome'
fi
if [[ "$engines" == *,firefox,* ]]; then
  install_browser firefox 'https://download.mozilla.org/?product=firefox-latest-ssl&os=osx&lang=en-US' Firefox
fi
# All preferences are in this disposable guest, including its private text replacement.
defaults write -g ApplePressAndHoldEnabled -bool true
defaults write -g NSAutomaticTextReplacementEnabled -bool true
defaults write -g NSUserDictionaryReplacementItems -array '{on = 1; replace = omw; with = "On my way!";}'
{
  sw_vers
  defaults read -g ApplePressAndHoldEnabled
  defaults read -g NSUserDictionaryReplacementItems
  ls /Applications
} > "$out/environment.txt"
cd ../..
pnpm exec esbuild apps/web/src/components/remote-editing/native-trace-entry.tsx --bundle --format=iife --minify --outfile="$OPENSTEER_PROXY_TRACE_BUNDLE"
cd apps/desktop
pnpm exec electron ../web/src/components/remote-editing/native-trace.cjs
