#!/bin/bash
# The person's front app through an agent's work in Safari, on a real Mac (pnpm test:vm).
#   pnpm test:vm -- [--inputs DIR] bash native/computer-use/Tests/Fixtures/SafariFrontJourney/run-vm.sh
# With --inputs holding a FocusEnforcer.swift, a second journey is built with that file in
# place of the checkout's and runs first, for comparison (OPENSTEER_SAFARI_FRONT_RED_CASES).
set -euo pipefail
[[ "$HOME" == /Users/admin && -d "$HOME/opensteer-job" ]] || { echo 'Use pnpm test:vm'; exit 2; }
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
began=$SECONDS
out="$HOME/opensteer-job/artifacts/safari-front"
mkdir -p "$out" "$HOME/Applications"
# A tee pipe could keep the VM command open after the result; the log is a file.
exec > "$out/runner.log" 2>&1
work=$(mktemp -d "$HOME/Applications/opensteer-safari-front.XXXXXX")
fixtures=native/computer-use/Tests/Fixtures/SafariFrontJourney
server_pid=''
cleanup() {
  status=$?
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  rm -rf "$work"
  defaults delete com.opensteer.safari-front-stand-in >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT INT TERM
sw_vers > "$out/guest-macos.txt"
git rev-parse HEAD > "$out/checkout.txt" 2>/dev/null || echo unknown > "$out/checkout.txt"
ls "$HOME/Library/Logs/DiagnosticReports" > "$out/diagnostic-reports-before.txt" 2>/dev/null || true

# The core is compiled into each journey, as the helper app compiles it.
build="$work/build"
mkdir -p "$build"
bash scripts/test-support/build-apple-data-module.sh "$build"
compile() {
  local output=$1 replacement=${2:-}
  local sources=()
  while IFS= read -r file; do
    if [[ -n "$replacement" && "$file" == */Focus/FocusEnforcer.swift ]]; then sources+=("$replacement"); else sources+=("$file"); fi
  done < <(find native/computer-use/Sources/ComputerUseCore -name '*.swift' | sort)
  xcrun swiftc -parse-as-library -module-name ComputerUseCore -swift-version 5 -I "$build" -L "$build" \
    -lOpensteerAppleData -lMacOSSigning -o "$output" "${sources[@]}" "$fixtures/Journey.swift"
}
red_source="/Volumes/My Shared Files/inputs/FocusEnforcer.swift"
compile "$work/Green" &
green_build=$!
if [[ -f "$red_source" ]]; then
  cp "$red_source" "$work/RedFocusEnforcer.swift"
  shasum -a 256 "$work/RedFocusEnforcer.swift" > "$out/red-source.sha256"
  compile "$work/Red" "$work/RedFocusEnforcer.swift"
fi
wait "$green_build"
echo "built at $((SECONDS - began)) s"

# The fixture pages, served here; every input on them is logged.
node "$fixtures/server.cjs" "$out/fixture-log.jsonl" "$work/server-ready.json" &
server_pid=$!
for _ in $(seq 1 100); do [[ -f "$work/server-ready.json" ]] && break; sleep 0.1; done
port=$(node -e 'process.stdout.write(String(require(process.argv[1]).port))' "$work/server-ready.json")
export OPENSTEER_SAFARI_FRONT_URL="http://127.0.0.1:$port/"
export OPENSTEER_SAFARI_FRONT_LOG="$out/fixture-log.jsonl"

# The person's front app: Electron, as the Opensteer app from a development launch is.
stand_in() {
  local dir=$1
  local app="$work/stand-in-$(basename "$dir")/OpensteerStandIn.app"
  local seed
  seed=$(node -e 'process.stdout.write(require("node:path").resolve(require("electron"), "../../.."))')
  mkdir -p "$(dirname "$app")" "$dir"
  ditto --norsrc --noextattr --noqtn "$seed" "$app"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.opensteer.safari-front-stand-in" "$app/Contents/Info.plist"
  mkdir -p "$app/Contents/Resources/app"
  cp "$fixtures/front.cjs" "$app/Contents/Resources/app/front.cjs"
  node -e 'const fs=require("node:fs"),path=require("node:path");const [dir,output,user]=process.argv.slice(1);fs.writeFileSync(path.join(dir,"package.json"),JSON.stringify({name:"safari-front-stand-in",main:"front.cjs"}));fs.writeFileSync(path.join(dir,"config.json"),JSON.stringify({output,userData:user}));' \
    "$app/Contents/Resources/app" "$dir" "$work/stand-in-user-$(basename "$dir")"
  codesign --force --preserve-metadata=entitlements --sign - "$app" >/dev/null
  printf '%s' "$app"
}
run_journey() {
  local name=$1 binary=$2 cases=$3
  local dir="$out/$name"
  mkdir -p "$dir"
  OPENSTEER_SAFARI_FRONT_APP=$(stand_in "$dir/front") \
  OPENSTEER_SAFARI_FRONT_APP_OUT="$dir/front" \
  OPENSTEER_SAFARI_FRONT_BUILD="$name" \
  OPENSTEER_SAFARI_FRONT_CASES="$cases" \
  OPENSTEER_SAFARI_FRONT_DEADLINE="$deadline" \
    "$binary" "$dir" && status=0 || status=$?
  echo "$status" > "$dir/exit-code.txt"
  echo "$name finished with $status at $((SECONDS - began)) s"
}
# The suite has 30 minutes: the churn case stops early, and says so, past this.
deadline=$(( $(date +%s) * 1000 + (1620 - (SECONDS - began)) * 1000 ))
result=0
if [[ -x "$work/Red" ]]; then
  run_journey red "$work/Red" "${OPENSTEER_SAFARI_FRONT_RED_CASES:-front}"
fi
run_journey green "$work/Green" "${OPENSTEER_SAFARI_FRONT_CASES:-front,stop,typing,choice,overlay,control,churn}"
[[ "$(cat "$out/green/exit-code.txt")" == 0 ]] || result=1
ls "$HOME/Library/Logs/DiagnosticReports" > "$out/diagnostic-reports-after.txt" 2>/dev/null || true
exit "$result"
