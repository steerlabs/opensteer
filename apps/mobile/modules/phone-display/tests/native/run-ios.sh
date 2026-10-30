#!/usr/bin/env bash
# Builds the generated Expo iOS project in Release with journey.tsx as its
# bundle entry, then checks real pixels on owned iPhone, iPad and iPhone Duo
# simulators. Runs only inside a granted mobile VM job (pnpm test:vm -- --mobile).
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
mobile="$root/apps/mobile"
tests="$mobile/modules/phone-display/tests/native"
evidence="${OPENSTEER_PHONE_DISPLAY_EVIDENCE_DIR:-$HOME/opensteer-job/artifacts/native/phone-display}"
derived="$HOME/opensteer-job/phone-display-derived"
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer OPENSTEER_PHONE_DISPLAY_EVIDENCE_DIR="$evidence"
mkdir -p "$evidence"
simulator=""
coordinator=""
phase="cocoapods"
cleanup() {
  status="$?"
  if [[ -n "$coordinator" ]]; then kill "$coordinator" >/dev/null 2>&1 || true; wait "$coordinator" 2>/dev/null || true; fi
  if [[ -n "$simulator" ]]; then
    xcrun simctl shutdown "$simulator" >/dev/null 2>&1 || true
    xcrun simctl delete "$simulator" >/dev/null 2>&1 || true
  fi
  printf '{"exitCode": %s, "phase": "%s"}\n' "$status" "$phase" > "$evidence/harness-exit.json"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

command -v pod >/dev/null || brew install cocoapods > "$evidence/cocoapods.log" 2>&1
cd "$mobile"
phase="prebuild"
pnpm exec expo prebuild --platform ios --no-install > "$evidence/prebuild.log" 2>&1
phase="pods"
(cd ios && pod install) > "$evidence/pods.log" 2>&1
phase="build"
started=$(date +%s)
ENTRY_FILE="$tests/journey.tsx" xcodebuild -workspace ios/Opensteer.xcworkspace -scheme Opensteer \
  -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$derived" ARCHS=arm64 ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO build > "$evidence/build.log" 2>&1
app="$derived/Build/Products/Release-iphonesimulator/Opensteer.app"
{
  printf 'buildSeconds=%s\n' "$(( $(date +%s) - started ))"
  printf 'source=%s\n' "$(git rev-parse HEAD)"
  xcodebuild -version
  /usr/libexec/PlistBuddy -c 'Print :NSAppTransportSecurity' "$app/Info.plist" || true
  shasum -a 256 "$app/Opensteer" "$app/main.jsbundle"
} > "$evidence/build-facts.txt" 2>&1
# The embedded bundle must be the journey, built without development mode.
grep -q 'fixture-session' "$app/main.jsbundle"

xcrun simctl list runtimes --json > "$evidence/runtimes.json"
xcrun simctl list devicetypes --json > "$evidence/device-types.json"
devices="$(python3 - "$evidence/runtimes.json" "$evidence/device-types.json" "$evidence/coverage.json" <<'PY'
import json,sys
runtime=next(r for r in json.load(open(sys.argv[1]))['runtimes'] if r.get('isAvailable') and r['version']=='27.1' and 'iOS' in r['name'])
supported={d['identifier'] for d in runtime['supportedDeviceTypes']}
types=[d for d in json.load(open(sys.argv[2]))['devicetypes'] if d['identifier'] in supported]
# Every wanted form the pinned runtime supports; iPhone Duo is required.
wanted={'iPhone Duo':lambda n:n=='iPhone Duo','iPhone':lambda n:n.startswith('iPhone 17'),'iPad':lambda n:n.startswith('iPad')}
coverage={}
for form,test in wanted.items():
  d=next((d for d in types if test(d['name'])),None)
  coverage[form]=d['name'] if d else 'not supported by the pinned runtime'
  if d: print(runtime['identifier'], d['identifier'], d['name'].replace(' ','-'))
json.dump({'runtime':runtime['buildversion'],'coverage':coverage},open(sys.argv[3],'w'),indent=2)
if coverage['iPhone Duo'].startswith('not'): sys.exit('iPhone Duo is not supported by the pinned runtime')
PY
)"
failed=0
while read -r runtime type name; do
  phase="simulator:$name"
  simulator="$(xcrun simctl create "PhoneDisplay-$name" "$type" "$runtime")"
  xcrun simctl boot "$simulator"
  xcrun simctl bootstatus "$simulator" -b > "$evidence/boot-$name.log" 2>&1
  xcrun simctl install "$simulator" "$app"
  phase="journey:$name"
  OPENSTEER_PHONE_DISPLAY_UDID="$simulator" OPENSTEER_PHONE_DISPLAY_DEVICE="$name" \
    "$root/node_modules/.bin/tsx" "$tests/serve.ts" > "$evidence/coordinator-$name.log" 2>&1 &
  coordinator="$!"
  xcrun simctl launch "$simulator" com.opensteer.mobile > "$evidence/launch-$name.log" 2>&1
  if ! wait "$coordinator"; then failed=1; fi
  coordinator=""
  xcrun simctl spawn "$simulator" log show --last 5m --predicate 'process == "Opensteer"' --style compact > "$evidence/$name/device.log" 2>&1 || true
  xcrun simctl shutdown "$simulator" >/dev/null 2>&1 || true
  xcrun simctl delete "$simulator"
  simulator=""
done <<< "$devices"
phase="report"
python3 - "$evidence" <<'PY'
import json,pathlib,sys
out=pathlib.Path(sys.argv[1])
reports={p.parent.name:json.loads(p.read_text()) for p in out.glob('*/report.json')}
(out/'summary.json').write_text(json.dumps(reports,indent=2)+'\n')
print(json.dumps({k:{'passed':v['passed'],'checks':v['checks'],'failures':v['failures']} for k,v in reports.items()},indent=2))
PY
exit "$failed"
