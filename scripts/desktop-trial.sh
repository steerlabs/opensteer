#!/bin/bash
# Try this checkout's Opensteer desktop app by hand on a Mac that also has the released Opensteer,
# without changing anything of the installed one. Run it yourself, in your own terminal:
#
#   bash scripts/desktop-trial.sh
#   bash scripts/desktop-trial.sh open-link 'com.opensteer.opensteer:/mcp-authorization?...'
#
# Everything the trial keeps is under one folder (default "~/Opensteer Trial"): its data
# ("Data", the app's own data folder), its Agent home ("Agent home") and its downloads. It runs
# as a development launch with OPENSTEER_DESKTOP_TRIAL_ROOT (apps/desktop/src/config.ts), which:
# keeps the Opensteer account off; registers no callback scheme (the installed app keeps
# com.opensteer.opensteer); runs none of the helpers every Opensteer on a Mac shares (Computer
# use, Passwords, Dictation: their install, socket and macOS grants are inside the installed
# app's folder); and names itself "Opensteer Trial", so its keychain item is its own.
#
# It prints every path, port and identity before it starts, refuses to start when one of them
# meets the installed app's, stops everything it started (by PID and start time) when the app
# ends (Quit Completely in its menu bar menu; Quit alone keeps it running there) or you press
# Ctrl-C here, and then checks the installed app's callback scheme is unchanged.
# `scripts/desktop-trial-remove.sh` lists, then removes, what a trial created.
#
# The Home it starts (PostgreSQL, the Host, the Runner) comes from a desktop resources folder
# holding `personal-runtime` and `process-supervisor`: by default `apps/desktop/generated-resources`,
# which `pnpm desktop:build-release --unsigned --out /absolute/inputs` leaves (desktop-builds
# skill); `--resources DIR` names another.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd -P)
desktop="$repo/apps/desktop"
root="$HOME/Opensteer Trial"
resources=""
build=1
link=""

say() { printf '%s\n' "$*"; }
fail() {
  printf 'desktop-trial: %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --root) root="${2:?--root needs a folder}"; shift 2 ;;
    --resources) resources="${2:?--resources needs a folder}"; shift 2 ;;
    --no-build) build=0; shift ;;
    open-link) link="${2:?open-link needs the link}"; shift 2 ;;
    -h | --help) sed -n '2,26p' "$0"; exit 0 ;;
    *) fail "unknown argument: $1 (see --help)" ;;
  esac
done

[ "$(uname -s)" = Darwin ] || fail "this is for a Mac."
[ "$(id -u)" != 0 ] || fail "run it as yourself, not as root."
case "$root" in /*) ;; *) fail "--root must be an absolute path." ;; esac
root="${root%/}"

data="$root/Data"
agent_home="$root/Agent home"
downloads="$root/Downloads"
state="$root/.trial"
electron_app="$desktop/node_modules/electron/dist/Electron.app"
electron="$electron_app/Contents/MacOS/Electron"
app_name="Opensteer Trial"
keychain_service="$app_name Safe Storage"
scheme="com.opensteer.opensteer"
manifest="$data/personal-deployment.v1.json"
installed_data="$HOME/Library/Application Support/Opensteer"
installed_folders=(
  "$installed_data"
  "$HOME/Library/Application Support/Opensteer Beta"
  "$HOME/Opensteer"
)
installed_manifest="$installed_data/personal-deployment.v1.json"

# The real path through every link of the part that exists, in one case (a Mac's volume ignores
# case, so ~/opensteer is ~/Opensteer).
resolved() {
  local path="$1" rest=""
  while [ ! -e "$path" ] && [ "$path" != / ]; do
    rest="/$(basename "$path")$rest"
    path=$(dirname "$path")
  done
  if [ -d "$path" ]; then path=$(cd -P "$path" && pwd -P); fi
  printf '%s%s' "${path%/}" "$rest" | tr '[:upper:]' '[:lower:]'
}
# True when one path is the other or holds it.
meets() {
  local a b
  a="$(resolved "$1")/"
  b="$(resolved "$2")/"
  case "$a" in "$b"*) return 0 ;; esac
  case "$b" in "$a"*) return 0 ;; esac
  return 1
}
refuse_if_installed() {
  local folder
  for folder in "${installed_folders[@]}"; do
    if meets "$1" "$folder"; then fail "$2 ($1) meets the installed Opensteer's folder $folder."; fi
  done
}
# The app LaunchServices opens a link of this scheme with right now, or "none".
scheme_handler() {
  /usr/bin/osascript -l JavaScript -e "ObjC.import('AppKit');
    const url = \$.NSURL.URLWithString('$scheme:/oauth/account-callback');
    const app = \$.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(url);
    app.isNil() ? 'none' : app.path.js" 2>/dev/null || echo unknown
}
started_at() { ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ' | sed 's/^ //; s/ $//'; }
json_field() { /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null || true; }
listening() { /usr/sbin/lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }

environment=(
  "HOME=$HOME" "USER=${USER:-$(id -un)}" "LOGNAME=${LOGNAME:-$(id -un)}" "SHELL=${SHELL:-/bin/zsh}"
  "PATH=$PATH" "TMPDIR=${TMPDIR:-/tmp/}" "LANG=en_US.UTF-8"
  "OPENSTEER_DESKTOP_MODE=development"
  "OPENSTEER_DESKTOP_TRIAL_ROOT=$root"
)

# `open-link`: hand a link to the running trial. A second launch with the same root finds the
# first one's lock and passes its arguments on, so the link never goes through Launch Services,
# which would give it to the installed app.
if [ -n "$link" ]; then
  case "$link" in "$scheme:/mcp-authorization?"*) ;; *) fail "open-link takes the agent sign-in link (copy the page's Open in Opensteer button's link)." ;; esac
  [ -f "$state/running" ] || fail "no trial is running from $root."
  runtime="$(cat "$state/resources")/personal-runtime"
  exec env -i "${environment[@]}" \
    "OPENSTEER_DESKTOP_PERSONAL_RELEASE_DIR=$runtime" \
    "OPENSTEER_DESKTOP_NATIVE_FS_HELPER=$runtime/bin/opensteer-native-fs" \
    "$electron" "$desktop/dist/main.js" "$link"
fi

[ -n "$resources" ] || resources="$desktop/generated-resources"
case "$resources" in /*) ;; *) fail "--resources must be an absolute path." ;; esac
resources="${resources%/}"
runtime="$resources/personal-runtime"
[ -f "$runtime/release.json" ] && [ -x "$runtime/bin/opensteer-native-fs" ] &&
  [ -f "$resources/process-supervisor/release.json" ] ||
  fail "$resources holds no Home runtime (personal-runtime and process-supervisor); build one with pnpm desktop:build-release --unsigned --out /absolute/inputs, or pass --resources."
case "$(resolved "$resources")/" in *.app/*) fail "--resources must not be inside an app bundle: never the installed app's own." ;; esac

refuse_if_installed "$root" "The trial folder"
for folder in "$data" "$agent_home" "$downloads" "$resources" "$repo"; do
  refuse_if_installed "$folder" "A folder the trial uses"
done
[ "$(resolved "$root")" != "$(resolved "$HOME")" ] || fail "the trial folder must not be your home folder."
! meets "$root" "$repo" || fail "the trial folder must be outside the checkout."
if [ -d "$root" ] && [ ! -f "$state/marker" ] && [ -n "$(ls -A "$root")" ]; then
  fail "$root already holds files and is not a trial folder; choose another --root."
fi
[ ! -f "$state/running" ] || ! kill -0 "$(head -1 "$state/running")" 2>/dev/null ||
  fail "a trial is already running from $root (PID $(head -1 "$state/running"))."

if [ "$build" = 1 ]; then
  say "Building this checkout's desktop app (pnpm --filter @opensteer/desktop build)…"
  (cd "$repo" && pnpm --filter @opensteer/desktop build >/dev/null) || fail "the build failed; run it yourself to see why."
fi
[ -x "$electron" ] || fail "Electron is not installed in this checkout; run pnpm install --frozen-lockfile."
[ -f "$desktop/dist/main.js" ] || fail "apps/desktop/dist is missing; run without --no-build."
bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$electron_app/Contents/Info.plist")
case "$bundle_id" in com.opensteer.*) fail "Electron here claims $bundle_id, an Opensteer identity." ;; esac

handler_before=$(scheme_handler)
host_port=$(json_field "$manifest" hostPort)
postgres_port=$(json_field "$manifest" postgresPort)
installed_host_port=$(json_field "$installed_manifest" hostPort)
installed_postgres_port=$(json_field "$installed_manifest" postgresPort)
deployment=$(json_field "$manifest" deploymentId)
installed_deployment=$(json_field "$installed_manifest" deploymentId)
check_ports() {
  local port
  for port in "$host_port" "$postgres_port"; do
    [ -n "$port" ] || continue
    if [ "$port" = "$installed_host_port" ] || [ "$port" = "$installed_postgres_port" ]; then
      return 1
    fi
  done
  [ -z "$deployment" ] || [ "$deployment" != "$installed_deployment" ]
}
check_ports || fail "the trial's Home ($deployment, ports $host_port/$postgres_port) meets the installed Opensteer's; remove the trial (scripts/desktop-trial-remove.sh) and start again."
for port in "$host_port" "$postgres_port"; do
  if [ -n "$port" ] && [ -n "$(listening "$port")" ]; then
    fail "port $port, which the trial's Home keeps, is in use by PID $(listening "$port")."
  fi
done

# What exists outside the trial folder before the first trial, so removal takes only what a trial
# added. Shared with other Electron development apps; never the installed Opensteer's.
outside=(
  "$HOME/Library/Preferences/com.github.Electron.plist"
  "$HOME/Library/Saved Application State/com.github.Electron.savedState"
  "$HOME/Library/Caches/com.github.Electron"
  "$HOME/Library/HTTPStorages/com.github.Electron"
  "$HOME/Library/Application Support/Electron"
  "$HOME/.cache/opensteer"
  "$HOME/.cache/opensteer/runner-attachments"
)
mkdir -p "$root"
mkdir -p "$state"
chmod 700 "$root" "$state"
if [ ! -f "$state/marker" ]; then
  {
    say "Opensteer trial folder, made by scripts/desktop-trial.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    say "checkout: $repo"
  } >"$state/marker"
  : >"$state/outside-before.txt"
  for path in "${outside[@]}"; do [ -e "$path" ] && say "$path" >>"$state/outside-before.txt"; done
  if /usr/bin/security find-generic-password -s "$keychain_service" >/dev/null 2>&1; then
    say "keychain:$keychain_service" >>"$state/outside-before.txt"
  fi
  say "$handler_before" >"$state/scheme-handler-before.txt"
fi
printf '%s\n' "$resources" >"$state/resources"

cat <<EOF

Opensteer trial
  Checkout          $repo ($(git -C "$repo" rev-parse --short HEAD 2>/dev/null || echo unknown))
  Trial folder      $root
  App data          $data
  Agent home        $agent_home
  Downloads         $downloads
  Home runtime      $resources
  App name          $app_name (keychain item "$keychain_service")
  App binary        $electron ($bundle_id)
  Callback scheme   $scheme: not registered; it opens $handler_before
  Home ports        ${host_port:-chosen at first start}${postgres_port:+ and $postgres_port}${installed_host_port:+ (installed Opensteer: $installed_host_port and $installed_postgres_port)}
  Opensteer account off: no sign-in, no Remote access through Opensteer Connect, no Cloud Computer
  Off in a trial    Computer use, Opensteer Passwords, Dictation (they share the installed app's helpers and grants)
  Your own agents   use your real Claude Code, Codex, ... sign-ins, as the installed app does

  Nothing above is the installed Opensteer's ($installed_data, ~/Opensteer).
  To stop everything this started: Quit Completely in the app's menu bar menu (Quit alone
  keeps it running there), or press Ctrl-C here.

EOF

log="$state/electron.log"
env -i "${environment[@]}" \
  "OPENSTEER_DESKTOP_PERSONAL_RELEASE_DIR=$runtime" \
  "OPENSTEER_DESKTOP_NATIVE_FS_HELPER=$runtime/bin/opensteer-native-fs" \
  "$electron" "$desktop/dist/main.js" >>"$log" 2>&1 &
pid=$!
# From here on nothing may end this script before it has stopped what it started: no errexit, and
# an exit for any reason ends the app and sweeps (`finish`).
set +e
started=$(started_at "$pid")
printf '%s\n%s\n' "$pid" "$started" >"$state/running"
processes="$state/processes.txt"
: >"$processes"
say "Started the trial app, PID $pid; its log is $log."

stopping=0
stop() {
  [ "$stopping" = 0 ] || return 0
  stopping=$(date +%s)
  kill -TERM "$pid" 2>/dev/null || true
}
trap stop INT TERM HUP
finished=0
trap '[ "$finished" = 1 ] || { stop; finish; }' EXIT

# Every process the trial started: the app's descendants, and anything running from the trial
# folder or the runtime (a process its parent left behind no longer descends from the app).
remember() {
  local queue="$pid" next="" child line
  while [ -n "$queue" ]; do
    next=""
    for child in $queue; do
      next="$next $(pgrep -P "$child" 2>/dev/null | tr '\n' ' ' || true)"
      line="$child $(started_at "$child")"
      grep -qxF "$line" "$processes" 2>/dev/null || [ "$line" = "$child " ] || say "$line" >>"$processes"
    done
    queue=$(printf '%s' "$next" | xargs)
  done
  ps -axo pid=,ppid=,command= | while read -r child parent command; do
    [ "$parent" = 1 ] || continue
    case "$command" in "$resources/"* | *" $data/"* | *"=$data/"*) ;; *) continue ;; esac
    line="$child $(started_at "$child")"
    grep -qxF "$line" "$processes" 2>/dev/null || [ "$line" = "$child " ] || say "$line" >>"$processes"
  done
}

# Ends the app if it still runs, then every process it started, by PID and only while that PID
# is still the process that was recorded (same start time).
finish() {
  trap - INT TERM HUP
  local waited=0 child now lstart
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 120 ]; do sleep 1; waited=$((waited + 1)); done
  if kill -0 "$pid" 2>/dev/null; then
    say "The trial app did not finish quitting; ending PID $pid."
    kill -KILL "$pid" 2>/dev/null
  fi
  wait "$pid" 2>/dev/null
  say "The trial app (PID $pid) has quit; stopping what it left running…"
  remember
  left=()
  while read -r child lstart; do
    [ -n "$child" ] || continue
    now=$(started_at "$child")
    if [ -n "$now" ] && [ "$now" = "$lstart" ]; then left+=("$child"); fi
  done <"$processes"
  if [ ${#left[@]} -gt 0 ]; then
    say "  still running: ${left[*]}; asking them to stop"
    kill -TERM "${left[@]}" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      alive=()
      for child in "${left[@]}"; do kill -0 "$child" 2>/dev/null && alive+=("$child"); done
      [ ${#alive[@]} -eq 0 ] && break
      sleep 1
    done
    for child in "${left[@]}"; do
      if kill -0 "$child" 2>/dev/null; then
        say "  PID $child did not stop; ending it"
        kill -KILL "$child" 2>/dev/null || true
      fi
    done
  fi
  rm -f "$state/running" "$state/ready"
  say "  every process the trial started has ended ($(wc -l <"$processes" | tr -d ' ') recorded in $processes)."
  finished=1
}

root_argument=""
[ "$root" = "$HOME/Opensteer Trial" ] || root_argument=" --root '$root'"
ready=0
say "Waiting for the app. On its first screen, press \"Start Opensteer on this Mac\"."
while kill -0 "$pid" 2>/dev/null; do
  remember
  if [ "$ready" = 0 ] && [ -f "$manifest" ]; then
    host_port=$(json_field "$manifest" hostPort)
    postgres_port=$(json_field "$manifest" postgresPort)
    deployment=$(json_field "$manifest" deploymentId)
    if ! check_ports; then
      say "The trial's Home took a port or identity of the installed Opensteer; stopping it."
      stop
    elif [ -n "$host_port" ] && curl -fsS --max-time 2 "http://127.0.0.1:$host_port/healthz" >/dev/null 2>&1; then
      ready=1
      cat <<EOF

Trial ready ($(date +%H:%M:%S))
  Home              http://127.0.0.1:$host_port  (PostgreSQL on 127.0.0.1:$postgres_port)
  Connected agents  http://127.0.0.1:$host_port/internal/v1/mcp
                    On the sign-in page, copy the "Open in Opensteer" link and run:
                    bash scripts/desktop-trial.sh$root_argument open-link '<that link>'
                    Clicking it instead gives it to the installed Opensteer.

EOF
      say "ready $host_port $postgres_port" >"$state/ready"
    fi
  fi
  # An app that has not finished quitting two minutes after being asked to is ended.
  if [ "$stopping" != 0 ] && [ $(($(date +%s) - stopping)) -gt 120 ]; then
    say "The trial app did not finish quitting; ending PID $pid."
    kill -KILL "$pid" 2>/dev/null || true
  fi
  sleep 2 &
  wait $! 2>/dev/null || true
done
finish

handler_after=$(scheme_handler)
if [ "$handler_after" = "$handler_before" ]; then
  say "  $scheme: still opens $handler_after."
else
  say "  WARNING: $scheme: opened $handler_before before the trial and opens $handler_after now."
  exit 2
fi
