#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
module="$root/apps/mobile/modules/remote-text-input"
evidence="${OPENSTEER_REMOTE_INPUT_EVIDENCE_DIR:-$HOME/opensteer-job/artifacts/native/remote-text-input}"
mkdir -p "$evidence"
simulator=""
phase="simulator"
cleanup() {
  status="$?"
  if [[ ! -f "$evidence/native-report.json" ]]; then
    python3 - "$evidence" "$status" "$phase" <<'PYREPORT'
import json,pathlib,sys
pathlib.Path(sys.argv[1],"native-report.json").write_text(json.dumps({"status":"failed", "exitCode":int(sys.argv[2]), "phase":sys.argv[3], "nativeKeyboardTraces":"not captured"},indent=2)+"\n")
PYREPORT
  fi
  if [[ -n "$simulator" ]]; then
    xcrun simctl terminate "$simulator" com.opensteer.remoteinput.fixture >/dev/null 2>&1 || true
    xcrun simctl shutdown "$simulator" >/dev/null 2>&1 || true
    xcrun simctl delete "$simulator" >/dev/null 2>&1 || true
  fi
  osascript -e 'tell application "Simulator" to quit' >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
xcrun simctl list runtimes --json > "$evidence/runtimes.json"
xcrun simctl list devicetypes --json > "$evidence/device-types.json"
runtime="$(python3 - "$evidence/runtimes.json" <<'PY'
import json,sys
print(next(r['identifier'] for r in json.load(open(sys.argv[1]))['runtimes'] if r.get('isAvailable') and r['version']=='27.1' and 'iOS' in r['name']))
PY
)"
device_type="$(python3 - "$evidence/device-types.json" <<'PY'
import json,sys
print(next(d['identifier'] for d in json.load(open(sys.argv[1]))['devicetypes'] if d['name']=='iPhone Duo'))
PY
)"
simulator="$(xcrun simctl create RemoteInputFixture "$device_type" "$runtime")"
xcrun simctl boot "$simulator"
xcrun simctl bootstatus "$simulator" -b
cd "$module/ios"
phase="native-api"
set +e
xcodebuild -scheme RemoteTextInputCore -destination "platform=iOS Simulator,id=$simulator" -derivedDataPath "$evidence/DerivedData" -resultBundlePath "$evidence/native-api.xcresult" test > "$evidence/native-api.log" 2>&1
api_status="$?"
set -e
phase="fixture-build"
app="$evidence/RemoteInputFixture.app"
mkdir -p "$app"
sdk="$(xcrun --sdk iphonesimulator --show-sdk-path)"
xcrun --sdk iphonesimulator swiftc -sdk "$sdk" -target arm64-apple-ios27.1-simulator -swift-version 5 Core/*.swift "$module/tests/native/Fixture.swift" -o "$app/RemoteInputFixture" > "$evidence/fixture-build.log" 2>&1
cat > "$app/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.opensteer.remoteinput.fixture</string><key>CFBundleExecutable</key><string>RemoteInputFixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleName</key><string>RemoteInputFixture</string><key>MinimumOSVersion</key><string>27.1</string><key>UILaunchScreen</key><dict/></dict></plist>
PLIST
codesign -s - "$app" > "$evidence/fixture-sign.log" 2>&1
xcrun simctl install "$simulator" "$app"
defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool true
phase="fixture-launch"
simulator_app="$(xcode-select -p)/Applications/Simulator.app"
open -a "$simulator_app" --args -CurrentDeviceUDID "$simulator"
xcrun simctl launch "$simulator" com.opensteer.remoteinput.fixture > "$evidence/fixture-launch.log"
# AppleScript drives the guest Simulator's hardware input, never the host screen.
phase="hardware-capture"
osascript <<'APPLESCRIPT'
tell application "Simulator" to activate
delay 3
tell application "System Events"
  keystroke "hello native"
  delay 1
  key code 123 using option down
  key code 124 using {shift down, option down}
  key code 6 using command down
  delay 1
end tell
APPLESCRIPT
container="$(xcrun simctl get_app_container "$simulator" com.opensteer.remoteinput.fixture data)"
cp "$container/Documents/events.jsonl" "$evidence/ios-us-hardware.jsonl"
xcrun simctl io "$simulator" screenshot "$evidence/ios-us-hardware.png"
python3 - "$evidence" "$api_status" <<'PY'
import json,pathlib,sys
out=pathlib.Path(sys.argv[1]); packets=[json.loads(x) for x in (out/'ios-us-hardware.jsonl').read_text().splitlines()]
events=[p['event'] for p in packets]
typing=any('hello native' in e.get('proxy',{}).get('value','') for e in events)
hardware=any(e['type']=='keydown' for e in events)
report={'nativeAPI': 'passed' if sys.argv[2]=='0' else 'failed','iosUSHardware': 'captured' if typing and hardware else 'failed','eventCount':len(events),'nativeSoftKeyboardCases':'not captured: this driver supplies hardware input only','android':'not run by iOS harness'}
(out/'native-report.json').write_text(json.dumps(report,indent=2)+'\n')
if sys.argv[2]!='0' or not typing or not hardware: sys.exit(1)
PY
printf 'Native input evidence: %s\n' "$evidence"
