#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
evidence="${OPENSTEER_REMOTE_INPUT_EVIDENCE_DIR:-$HOME/opensteer-job/artifacts/native/remote-text-input-android}"
mkdir -p "$evidence"
sdk="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
if [[ ! -x "$sdk/emulator/emulator" || ! -x "$sdk/platform-tools/adb" ]]; then
  python3 - "$evidence" <<'PY'
import json,pathlib,sys
pathlib.Path(sys.argv[1],'native-report.json').write_text(json.dumps({'status':'blocked','reason':'The VM has no Android SDK/emulator. Host GUI use is forbidden.','nativeKeyboardTraces':'not captured'},indent=2)+'\n')
PY
  exit 2
fi
export ANDROID_HOME="$sdk"
export PATH="$sdk/platform-tools:$sdk/emulator:$PATH"
avdmanager="$sdk/cmdline-tools/latest/bin/avdmanager"
image="system-images;android-36;google_apis;arm64-v8a"
if [[ ! -x "$avdmanager" || ! -d "$sdk/system-images/android-36/google_apis/arm64-v8a" ]]; then
  python3 - "$evidence" <<'PY'
import json,pathlib,sys
pathlib.Path(sys.argv[1],'native-report.json').write_text(json.dumps({'status':'blocked','reason':'The VM lacks avdmanager or the API 36 arm64 image.','nativeKeyboardTraces':'not captured'},indent=2)+'\n')
PY
  exit 2
fi
avd="remote-text-input-$$"
pid=""
cleanup() {
  if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  adb kill-server >/dev/null 2>&1 || true
  "$avdmanager" delete avd -n "$avd" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'no\n' | "$avdmanager" create avd -n "$avd" -k "$image" --force > "$evidence/avd.log" 2>&1
emulator -avd "$avd" -port 5554 -no-window -no-audio -no-snapshot -wipe-data -gpu swiftshader > "$evidence/emulator.log" 2>&1 &
pid="$!"
export ANDROID_SERIAL=emulator-5554
adb wait-for-device
for _ in {1..120}; do
  if [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; then break; fi
  sleep 1
done
adb shell ime list -s > "$evidence/keyboards.txt"
cd "$root/apps/mobile"
CI=1 pnpm exec expo prebuild --platform android --no-install > "$evidence/prebuild.log" 2>&1
cd android
set +e
./gradlew :remote-text-input:connectedDebugAndroidTest > "$evidence/native-api.log" 2>&1
status="$?"
set -e
python3 - "$evidence" "$status" <<'PY'
import json,pathlib,sys
out=pathlib.Path(sys.argv[1]); out.joinpath('native-report.json').write_text(json.dumps({'nativeAPI':'passed' if sys.argv[2]=='0' else 'failed','nativeKeyboardTraces':'not captured: the instrumentation test drives InputConnection directly','gboardInstalled':'com.google.android.inputmethod.latin' in out.joinpath('keyboards.txt').read_text()},indent=2)+'\n')
PY
exit "$status"
