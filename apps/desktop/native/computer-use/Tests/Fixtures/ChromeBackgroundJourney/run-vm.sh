#!/bin/bash
# Run from apps/desktop, only inside pnpm test:vm. CLT has swiftc but may lack XCTest.
set -euo pipefail
[[ "${OPENSTEER_RUN_CHROME_BACKGROUND_JOURNEYS:-}" == 1 ]] || { echo 'Set OPENSTEER_RUN_CHROME_BACKGROUND_JOURNEYS=1'; exit 2; }
[[ -f "$HOME/.opensteer-test-guest" || ( "$HOME" == /Users/admin && -d "$HOME/opensteer-job" ) ]] || { echo 'Use pnpm test:vm'; exit 2; }
out="${OPENSTEER_JOURNEY_OUT:-$HOME/opensteer-job/artifacts/chrome-background}"
mkdir -p "$out"
exec > >(tee "$out/runner.log") 2>&1
work=$(mktemp -d "${TMPDIR:-/tmp/}"opensteer-chrome-journey.XXXXXX)
probe_pid=''
server_pid=''
stage=setup
cleanup() {
  cleanup_status=$?
  if [[ -n "$probe_pid" ]]; then kill "$probe_pid" 2>/dev/null || true; wait "$probe_pid" 2>/dev/null || true; fi
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  # Restrict teardown to this invocation's unique directory, including Chrome helpers.
  pkill -TERM -f "$work/" 2>/dev/null || true
  for attempt in 1 2 3 4 5; do
    pgrep -f "$work/" >/dev/null || break
    sleep 0.2
  done
  pkill -KILL -f "$work/" 2>/dev/null || true
  pgrep -fl "$work/" > "$out/remaining-processes.txt" || true
  hdiutil detach "$work/mount" -quiet 2>/dev/null || true
  rm -rf "$work"
  node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({stage:process.argv[2],exitCode:Number(process.argv[3])},null,2))' "$out/runner-result.json" "$stage" "$cleanup_status"
}
trap cleanup EXIT INT TERM
xcrun swiftc --version
stage=download-chrome
curl -fL --max-time 180 https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg -o "$work/chrome.dmg"
shasum -a 256 "$work/chrome.dmg" > "$out/chrome-dmg.sha256"
mkdir "$work/mount"
hdiutil attach "$work/chrome.dmg" -nobrowse -mountpoint "$work/mount" -quiet
stage=copy-chrome
ditto --norsrc --noextattr --noqtn "$work/mount/Google Chrome.app" "$work/Google Chrome.app"
hdiutil detach "$work/mount" -quiet
stage=verify-chrome
codesign --verify --deep --strict "$work/Google Chrome.app"
defaults read "$work/Google Chrome.app/Contents/Info" CFBundleShortVersionString > "$out/chrome-version.txt"
if [[ "${OPENSTEER_CHROME_JOURNEY:-all}" =~ ^(R4|sweep|all)$ ]]; then
  stage=local-server
  node native/computer-use/Tests/Fixtures/ChromeBackgroundJourney/r4-server.mjs "$work/origin" "$out/http.jsonl" &
  server_pid=$!
  for attempt in {1..50}; do [[ -s "$work/origin" ]] && break; sleep 0.1; done
  export R4_ORIGIN="$(cat "$work/origin")"
fi
fixture="$work/BackgroundInputFixture.app"
mkdir -p "$fixture/Contents/MacOS" "$fixture/Contents/Resources"
stage=compile-fixture
xcrun swiftc native/computer-use/Tests/Fixtures/BackgroundInputFixture/Receiver.swift -o "$fixture/Contents/MacOS/Fixture"
cat > "$fixture/Contents/Info.plist" <<'PLIST'
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleIdentifier</key><string>com.opensteer.chrome-journey-fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleName</key><string>Background Input Fixture</string></dict></plist>
PLIST
mkdir "$work/fixture-state"
node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({output:process.argv[2],mode:"journey"}))' "$fixture/Contents/Resources/journey.json" "$work/fixture-state"
codesign --force --sign - "$fixture"
cover="$work/Cover.app"
mkdir -p "$cover/Contents/MacOS"
cp "$fixture/Contents/Info.plist" "$cover/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleExecutable Probe' -c 'Set :CFBundleIdentifier com.opensteer.chrome-journey-cover' "$cover/Contents/Info.plist"
stage=generate-and-build-core
pnpm build:computer-use-helper --requirement-only
bash scripts/test-support/build-apple-data-module.sh "$work"
sources=()
while IFS= read -r file; do sources+=("$file"); done < <(find native/computer-use/Sources/ComputerUseCore -name '*.swift' | sort)
stage=compile-journeys
xcrun swiftc -whole-module-optimization -parse-as-library -module-name ComputerUseCore -swift-version 5 -I "$work" -L "$work" -lOpensteerAppleData -o "$work/Probe" "${sources[@]}" native/computer-use/Tests/Fixtures/ChromeBackgroundJourney/Journey.swift native/computer-use/Tests/Fixtures/ChromeBackgroundJourney/R4.swift
cp "$work/Probe" "$cover/Contents/MacOS/Probe"
codesign --force --sign - "$cover"
if [[ "${OPENSTEER_CHROME_JOURNEY:-all}" =~ ^(R4|sweep|all)$ ]]; then
  node --input-type=module - "$out" "$work" <<'JS'
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const [out, work] = process.argv.slice(2);
const command = (file, args) => execFileSync(file, args, {encoding:'utf8'}).trim();
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const identity = (app, executable) => existsSync(app) ? {
  version: command('defaults',['read',app+'/Contents/Info','CFBundleShortVersionString']),
  bundle: command('defaults',['read',app+'/Contents/Info','CFBundleIdentifier']),
  executableSHA256: hash(app+'/Contents/MacOS/'+executable)
} : {blocked: "Chrome unavailable"};
writeFileSync(out+'/identity.json', JSON.stringify({
  commit: command('git',['rev-parse','HEAD']), macOS: command('sw_vers',[]),
  helperSHA256: hash(work+'/Probe'),
  chrome: {...identity(work+'/Google Chrome.app','Google Chrome'), dmgSHA256: readFileSync(out+'/chrome-dmg.sha256','utf8').split(' ')[0]},
  localOrigin: process.env.R4_ORIGIN, forceRendererAccessibility: false,
  frontSampler: 'GetFrontProcess + GetProcessPID, independent 5 ms dispatch timer',
}, null, 2));
JS
fi
stage=execute-journeys
"$work/Probe" "$out" "$work/Google Chrome.app" "$fixture" "$cover" "$PWD/native/computer-use/Tests/Fixtures/ChromeBackgroundJourney/page.html" "$work" &
probe_pid=$!
set +e
wait "$probe_pid"
status=$?
probe_pid=''
set -e
# A nonzero result is the intended regression signal; JSON distinguishes invalid setup.
exit "$status"
