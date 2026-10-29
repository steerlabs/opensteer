#!/bin/bash
set -euo pipefail
export PATH="$HOME/opensteer-tools:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
out='/Volumes/My Shared Files/artifacts'
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' /Applications/Xcode.app/Contents/version.plist)" = '27.1'
test "$(/usr/libexec/PlistBuddy -c 'Print :ProductBuildVersion' /Applications/Xcode.app/Contents/version.plist)" = '27A9275'
xcodebuild -version
xcrun simctl list runtimes -j > "$out/mobile-runtimes.json"
xcrun simctl list devicetypes -j > "$out/mobile-device-types.json"
runtime=$(node - "$out/mobile-runtimes.json" <<'JS'
const fs = require('node:fs');
const r = JSON.parse(fs.readFileSync(process.argv[2])).runtimes.find(r => r.isAvailable && r.version === '27.1' && r.buildversion === '24A94425' && r.identifier.startsWith('com.apple.CoreSimulator.SimRuntime.iOS-'));
if (!r) throw new Error('Required final iOS 27.1 build 24A94425 runtime unavailable');
console.log(r.identifier);
JS
)
if [ "${1:-}" = '--inventory' ]; then exit 0; fi
# One private simulator proves nested simulator viability after a cold boot.
device=$(node - "$out/mobile-device-types.json" "$out/mobile-runtimes.json" "$runtime" "$out/mobile-selected-device.json" <<'JS'
const fs = require('node:fs');
const runtime = JSON.parse(fs.readFileSync(process.argv[3])).runtimes.find(r => r.identifier === process.argv[4]);
if (!Array.isArray(runtime?.supportedDeviceTypes)) throw new Error('Runtime supported device types unavailable');
const supported = new Set(runtime.supportedDeviceTypes.map(d => d.identifier));
const compatible = JSON.parse(fs.readFileSync(process.argv[2])).devicetypes.filter(d => supported.has(d.identifier));
const device = compatible.find(d => d.name.includes('iPad mini')) ?? compatible[0];
if (!device) throw new Error('No installed device type compatible with pinned runtime');
fs.writeFileSync(process.argv[5], JSON.stringify(device, null, 2));
console.log(device.identifier);
JS
)
udid=''
cleanup() {
  result=$?
  trap - EXIT
  if [ -n "$udid" ]; then
    xcrun simctl shutdown "$udid" >> "$out/mobile-simulator-cleanup.txt" 2>&1 || true
    if ! xcrun simctl delete "$udid" >> "$out/mobile-simulator-cleanup.txt" 2>&1; then result=1; fi
    if xcrun simctl list devices -j > "$out/mobile-devices-after-cleanup.json" 2>> "$out/mobile-simulator-cleanup.txt"; then
      if ! node - "$out/mobile-devices-after-cleanup.json" "$udid" >> "$out/mobile-simulator-cleanup.txt" 2>&1 <<'JS'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const inventory = JSON.parse(fs.readFileSync(process.argv[2]));
assert(inventory && typeof inventory.devices === 'object' && inventory.devices !== null && !Array.isArray(inventory.devices));
for (const devices of Object.values(inventory.devices)) {
  assert(Array.isArray(devices));
  for (const device of devices) {
    assert(device && typeof device.udid === 'string');
    assert.notEqual(device.udid, process.argv[3], 'Owned simulator remains after deletion');
  }
}
JS
      then result=1; fi
    else
      result=1
    fi
    printf 'ownedSimulator=%s exit=%s\n' "$udid" "$result" >> "$out/mobile-simulator-cleanup.txt"
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
udid=$(xcrun simctl create "Opensteer-mobile-proof-$(date +%s)" "$device" "$runtime")
printf '%s\n' "$udid" > "$out/mobile-simulator-udid.txt"
xcrun simctl boot "$udid"
node - "$udid" <<'JS'
const { spawn } = require('node:child_process');
const child = spawn('xcrun', ['simctl', 'bootstatus', process.argv[2], '-b'], { stdio: 'inherit', detached: true });
const timer = setTimeout(() => { process.kill(-child.pid, 'SIGKILL'); }, 180000);
child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 124; });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.kill(-child.pid, signal));
JS
xcrun simctl io "$udid" screenshot "$out/mobile-simulator.png"
sips -g pixelWidth -g pixelHeight "$out/mobile-simulator.png"
printf 'coldBoot=true simulatorScreenshot=true runtime=24A94425\n' > "$out/mobile-proof.txt"
