#!/bin/bash
# The person's front app through an agent's work in Safari, on a real Mac (pnpm test:vm).
#   pnpm test:vm -- [--inputs DIR] bash native/computer-use/Tests/Fixtures/SafariFrontJourney/run-vm.sh
# With --inputs holding a FocusEnforcer.swift, a second journey is built with that file in
# place of the checkout's and runs first, for comparison (OPENSTEER_SAFARI_FRONT_RED_CASES).
# Include ActionRunner.swift from the same revision if the FocusGuard interface differs.
set -euo pipefail
fixtures=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$fixtures/../../../../.."
default_cases=front-watch,front,stop-watch,typing-watch,choice-watch,overlay,control,type-into

compile() {
  local output=$1 replacements=${2:-}
  local sources=()
  while IFS= read -r file; do
    case "$file" in
      */Focus/FocusEnforcer.swift|*/Act/ActionRunner.swift)
        if [[ -n "$replacements" && -f "$replacements/${file##*/}" ]]; then
          file="$replacements/${file##*/}"
        fi ;;
    esac
    sources+=("$file")
  done < <(find native/computer-use/Sources/ComputerUseCore -name '*.swift' | sort)
  local flags=()
  if [[ "$output" == --typecheck ]]; then
    flags=(-typecheck -I "$modules")
  else
    flags=(-I "$build" -L "$build" -lOpensteerAppleData -lMacOSSigning -o "$output")
  fi
  if [[ "${OPENSTEER_SAFARI_FRONT_TRACE_KEYS:-0}" == 1 ]]; then
    flags+=(-D SAFARI_FRONT_KEY_TRACE)
  fi
  xcrun swiftc -parse-as-library -module-name ComputerUseCore -swift-version 5 \
    "${flags[@]}" "${sources[@]}" "$fixtures/Journey.swift" "$fixtures/Reminders.swift"
}

if [[ "${1:-}" == --check ]]; then
  case ",$default_cases," in
    *,type-into,*) ;;
    *) echo "Default Safari front cases must include type-into"; exit 1 ;;
  esac
  node --check "$fixtures/server.cjs"
  node --check "$fixtures/front.cjs"
  swift build --package-path native/computer-use
  modules=$(swift build --package-path native/computer-use --show-bin-path)
  if [[ -d "$modules/Modules" ]]; then modules="$modules/Modules"; fi
  compile --typecheck
  echo "Type-checked Safari front journey. Default cases: $default_cases"
  exit
fi

[[ "$HOME" == /Users/admin && -d "$HOME/opensteer-job" ]] || { echo 'Use pnpm test:vm'; exit 2; }
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
began=$SECONDS
out="$HOME/opensteer-job/artifacts/safari-front"
mkdir -p "$out" "$HOME/Applications"
# A tee pipe could keep the VM command open after the result; the log is a file.
exec > "$out/runner.log" 2>&1
work=$(mktemp -d "$HOME/Applications/opensteer-safari-front.XXXXXX")
server_pid=''
cleanup() {
  status=$?
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  rm -rf "$work"
  defaults delete com.opensteer.safari-front-stand-in >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT INT TERM
# The image's screen-capture approval is renewed past this job, so macOS's reminder prompt
# does not take the front app in the middle of a case (as test-macos-journeys.sh does).
bash ../../scripts/test-vm/screen-capture-approval.sh
sw_vers > "$out/guest-macos.txt"
git rev-parse HEAD > "$out/checkout.txt" 2>/dev/null || echo unknown > "$out/checkout.txt"
ls "$HOME/Library/Logs/DiagnosticReports" > "$out/diagnostic-reports-before.txt" 2>/dev/null || true

# The core is compiled into each journey, as the helper app compiles it.
build="$work/build"
mkdir -p "$build"
bash scripts/test-support/build-apple-data-module.sh "$build"
red_sources="/Volumes/My Shared Files/inputs"
compile "$work/Green" &
green_build=$!
if [[ -f "$red_sources/FocusEnforcer.swift" ]]; then
  mkdir -p "$work/red"
  cp "$red_sources/FocusEnforcer.swift" "$work/red/"
  if [[ -f "$red_sources/ActionRunner.swift" ]]; then
    cp "$red_sources/ActionRunner.swift" "$work/red/"
  fi
  shasum -a 256 "$work/red/FocusEnforcer.swift" > "$out/red-source.sha256"
  if [[ -f "$work/red/ActionRunner.swift" ]]; then
    shasum -a 256 "$work/red/ActionRunner.swift" >> "$out/red-source.sha256"
  fi
  compile "$work/Red" "$work/red"
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
  OPENSTEER_SAFARI_FRONT_OWNED="$dir/owned-pids.txt" \
    "$binary" "$dir" && status=0 || status=$?
  echo "$status" > "$dir/exit-code.txt"
  # A journey that ended without quitting its apps: they are stopped here by their PIDs.
  if [[ -f "$dir/owned-pids.txt" ]]; then
    while IFS= read -r pid; do
      [[ -n "$pid" ]] && kill "$pid" 2>/dev/null && echo "stopped leftover app $pid" || true
    done < "$dir/owned-pids.txt"
    sleep 2
  fi
  echo "$name finished with $status at $((SECONDS - began)) s"
}
# The suite has 30 minutes: the churn case stops early, and says so, past this.
deadline=$(( $(date +%s) * 1000 + (1620 - (SECONDS - began)) * 1000 ))
result=0
if [[ -x "$work/Red" ]]; then
  run_journey red "$work/Red" "${OPENSTEER_SAFARI_FRONT_RED_CASES:-front,front-watch,stop-watch}"
fi
run_journey green "$work/Green" "${OPENSTEER_SAFARI_FRONT_CASES:-$default_cases}"
[[ "$(cat "$out/green/exit-code.txt")" == 0 ]] || result=1

# Item i: Calendar and Reminders set up through the real helper app built from this checkout.
if [[ "${OPENSTEER_SAFARI_FRONT_REMINDERS:-1}" == 1 ]]; then
  mkdir -p "$out/reminders"
  pnpm build:computer-use-helper > "$out/reminders/helper-build.log" 2>&1
  helper_app="$PWD/native/computer-use/dist/Opensteer Computer Use.app"
  codesign -dv "$helper_app" > "$out/reminders/helper-signature.txt" 2>&1 || true
  log stream --info --predicate 'process == "tccd" OR subsystem == "com.apple.TCC"' > "$out/reminders/tcc.log" 2>&1 &
  log_pid=$!
  "$work/Green" --reminders "$out/reminders" "$helper_app" && status=0 || status=$?
  kill "$log_pid" 2>/dev/null || true
  wait "$log_pid" 2>/dev/null || true
  echo "$status" > "$out/reminders/exit-code.txt"
  echo "reminders finished with $status at $((SECONDS - began)) s (log stream $log_pid stopped)"
fi

# Last, up to the suite's deadline: about 2,000 single-key acts in bursts of 64.
run_journey churn "$work/Green" "${OPENSTEER_SAFARI_FRONT_CHURN_CASES:-churn-watch}"
ls "$HOME/Library/Logs/DiagnosticReports" > "$out/diagnostic-reports-after.txt" 2>/dev/null || true
exit "$result"
