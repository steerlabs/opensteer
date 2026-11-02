#!/usr/bin/env bash
# Builds the generated Expo Android project in Release with journey.tsx as its
# bundle entry, then checks real pixels on one owned headless emulator. It
# creates, boots and deletes its own AVD, and selects it only by serial through
# the already-running shared ADB server, which it never starts or stops.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
mobile="$root/apps/mobile"
tests="$mobile/modules/phone-display/tests/native"
evidence="${OPENSTEER_PHONE_DISPLAY_EVIDENCE_DIR:-$HOME/opensteer-job/artifacts/native/phone-display-android}"
sdk="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
api="${OPENSTEER_PHONE_DISPLAY_API:-36}"
export ANDROID_HOME="$sdk" PATH="$sdk/platform-tools:$sdk/emulator:$PATH" OPENSTEER_PHONE_DISPLAY_EVIDENCE_DIR="$evidence"
avdmanager="$sdk/cmdline-tools/latest/bin/avdmanager"
mkdir -p "$evidence"
avd="phone-display-$$"
name="android-$api"
emulator_pid=""
coordinator=""
phase="prerequisites"
cleanup() {
  status="$?"
  if [[ -n "$coordinator" ]]; then kill "$coordinator" >/dev/null 2>&1 || true; wait "$coordinator" 2>/dev/null || true; fi
  if [[ -n "$emulator_pid" ]]; then
    kill "$emulator_pid" >/dev/null 2>&1 || true
    wait "$emulator_pid" 2>/dev/null || true
  fi
  "$avdmanager" delete avd -n "$avd" >/dev/null 2>&1 || true
  printf '{"exitCode": %s, "phase": "%s"}\n' "$status" "$phase" > "$evidence/harness-exit.json"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

image="system-images;android-$api;google_apis;arm64-v8a"
[[ -x "$avdmanager" && -d "$sdk/system-images/android-$api/google_apis/arm64-v8a" ]] || {
  echo "Missing avdmanager or $image" >&2
  exit 2
}
# The journey's coordinator port, and an emulator port pair no one else holds.
if lsof -nP -iTCP:18766 -sTCP:LISTEN >/dev/null; then echo "Port 18766 is in use" >&2; exit 2; fi
port=""
for candidate in $(seq 5584 -2 5554); do
  if ! lsof -nP -iTCP:"$candidate" -iTCP:"$((candidate + 1))" -sTCP:LISTEN >/dev/null; then port="$candidate"; break; fi
done
[[ -n "$port" ]] || { echo "No free emulator port" >&2; exit 2; }
serial="emulator-$port"
if ! lsof -nP -iTCP:"${ANDROID_ADB_SERVER_PORT:-5037}" -sTCP:LISTEN >/dev/null; then
  echo "Start the shared ADB server first (adb start-server); this harness never owns it" >&2
  exit 2
fi

cd "$mobile"
phase="prebuild"
CI=1 pnpm exec expo prebuild --platform android --no-install > "$evidence/prebuild.log" 2>&1
phase="build"
started=$(date +%s)
# ENTRY_FILE is resolved against the app root.
(cd android && ENTRY_FILE="${tests#"$mobile/"}/journey.tsx" ./gradlew --no-daemon --max-workers=2 \
  -PreactNativeArchitectures=arm64-v8a -I "$tests/android-journey.gradle" :app:assembleRelease) \
  > "$evidence/build.log" 2>&1
apk="$mobile/android/app/build/outputs/apk/release/app-release.apk"
bundle="$mobile/android/app/build/generated/assets/react/release/index.android.bundle"
{
  printf 'buildSeconds=%s\n' "$(( $(date +%s) - started ))"
  printf 'source=%s\n' "$(git rev-parse HEAD)"
  java -version 2>&1 | head -1
  "$(ls -d "$sdk"/build-tools/* | tail -1)/aapt2" dump badging "$apk" | grep -E "^(package|minSdkVersion|targetSdkVersion|application-debuggable|native-code)" || true
  "$(ls -d "$sdk"/build-tools/* | tail -1)/aapt2" dump xmltree --file AndroidManifest.xml "$apk" | grep -E "debuggable|usesCleartextTraffic" || true
  shasum -a 256 "$apk" "$bundle"
} > "$evidence/build-facts.txt" 2>&1
# The embedded bundle must be the journey, compiled to Hermes bytecode rather than served by Metro.
grep -aq 'fixture-session' "$bundle"
head -c 4 "$bundle" | xxd -p | grep -q '^c61fbc03$'

phase="emulator"
printf 'no\n' | "$avdmanager" create avd -n "$avd" -k "$image" -d pixel_7 --force > "$evidence/avd.log" 2>&1
emulator -avd "$avd" -port "$port" -no-window -no-audio -no-snapshot -no-boot-anim -wipe-data \
  -gpu swiftshader_indirect > "$evidence/emulator.log" 2>&1 &
emulator_pid="$!"
printf 'avd=%s\nserial=%s\nemulatorPid=%s\n' "$avd" "$serial" "$emulator_pid" > "$evidence/emulator.txt"
# Screen-enabled precedes package installation readiness. Wait for the user-unlocked
# boot broadcast, including the log buffer if it arrived before ADB attached.
# The deadline also covers device discovery.
python3 - "$serial" "$avd" <<'PYBOOT'
import subprocess, sys
serial, avd = sys.argv[1:]
try:
    event = subprocess.run(
        ["adb", "-s", serial, "wait-for-device", "shell", "logcat", "-b", "events",
         "-e", "'\\[0,android.intent.action.BOOT_COMPLETED\\]'", "-m", "1"],
        check=True, capture_output=True, text=True, timeout=180,
    ).stdout
except subprocess.TimeoutExpired:
    sys.exit(f"{serial} did not finish BOOT_COMPLETED for u0 within 180 s")
if "[0,android.intent.action.BOOT_COMPLETED]" not in event:
    sys.exit(f"{serial} ended its boot event stream before BOOT_COMPLETED finished")
actual = subprocess.run(
    ["adb", "-s", serial, "emu", "avd", "name"],
    check=True, capture_output=True, text=True, timeout=5,
).stdout.splitlines()
if not actual or actual[0] != avd:
    sys.exit(f"{serial} is not the AVD this harness created")
PYBOOT
adb -s "$serial" shell getprop ro.build.fingerprint >> "$evidence/emulator.txt"
adb -s "$serial" shell wm size >> "$evidence/emulator.txt"
adb -s "$serial" shell wm density >> "$evidence/emulator.txt"
adb -s "$serial" install -r "$apk" > "$evidence/install.log" 2>&1

phase="journey"
adb -s "$serial" logcat -c
OPENSTEER_PHONE_DISPLAY_SERIAL="$serial" OPENSTEER_PHONE_DISPLAY_DEVICE="$name" \
  "$root/node_modules/.bin/tsx" "$tests/serve.ts" > "$evidence/coordinator-$name.log" 2>&1 &
coordinator="$!"
adb -s "$serial" shell am start -W -n com.opensteer.mobile/.MainActivity > "$evidence/launch-$name.log" 2>&1
failed=0
if ! wait "$coordinator"; then failed=1; fi
coordinator=""
adb -s "$serial" logcat -d > "$evidence/$name/device.log" 2>&1 || true
phase="report"
python3 - "$evidence/$name/report.json" <<'PY'
import json,sys
report=json.load(open(sys.argv[1]))
print(json.dumps({k:report[k] for k in ('device','passed','checks','failures')},indent=2))
PY
exit "$failed"
