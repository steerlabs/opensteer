#!/bin/bash
# Lists, then removes, everything an Opensteer trial (`scripts/desktop-trial.sh`) created, and
# nothing else. Run it yourself, in your own terminal, with the trial app quit:
#
#   bash scripts/desktop-trial-remove.sh            # lists, then asks before removing
#   bash scripts/desktop-trial-remove.sh --list     # lists only
#
# What a trial makes: its folder (default "~/Opensteer Trial": data, Agent home, downloads);
# the keychain item "Opensteer Trial Safe Storage"; each of its Runners' attachment caches in
# ~/.cache/opensteer/runner-attachments (named by the hash of the Runner's own folder); and
# Electron's own preferences and caches for this checkout's Electron (com.github.Electron) when
# none existed before the first trial. It never touches the installed Opensteer's folders, and it
# refuses a folder that is not a trial folder.
set -euo pipefail

root="$HOME/Opensteer Trial"
list_only=0
assume_yes=0
say() { printf '%s\n' "$*"; }
fail() {
  printf 'desktop-trial-remove: %s\n' "$*" >&2
  exit 1
}
while [ $# -gt 0 ]; do
  case "$1" in
    --root) root="${2:?--root needs a folder}"; shift 2 ;;
    --list) list_only=1; shift ;;
    --yes) assume_yes=1; shift ;;
    -h | --help) sed -n '2,14p' "$0"; exit 0 ;;
    *) fail "unknown argument: $1 (see --help)" ;;
  esac
done
[ "$(uname -s)" = Darwin ] || fail "this is for a Mac."
case "$root" in /*) ;; *) fail "--root must be an absolute path." ;; esac
root="${root%/}"
state="$root/.trial"
keychain_service="Opensteer Trial Safe Storage"
installed_folders=(
  "$HOME/Library/Application Support/Opensteer"
  "$HOME/Library/Application Support/Opensteer Beta"
  "$HOME/Opensteer"
)
resolved() {
  local path="$1" rest=""
  while [ ! -e "$path" ] && [ "$path" != / ]; do
    rest="/$(basename "$path")$rest"
    path=$(dirname "$path")
  done
  if [ -d "$path" ]; then path=$(cd -P "$path" && pwd -P); fi
  printf '%s%s' "${path%/}" "$rest" | tr '[:upper:]' '[:lower:]'
}
meets() {
  local a b
  a="$(resolved "$1")/"
  b="$(resolved "$2")/"
  case "$a" in "$b"*) return 0 ;; esac
  case "$b" in "$a"*) return 0 ;; esac
  return 1
}
started_at() { ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ' | sed 's/^ //; s/ $//'; }

for folder in "${installed_folders[@]}"; do
  meets "$root" "$folder" && fail "$root meets the installed Opensteer's folder $folder; nothing removed."
done
[ "$(resolved "$root")" != "$(resolved "$HOME")" ] || fail "that is your home folder."
[ -d "$root" ] || fail "there is no trial folder at $root."
[ -f "$state/marker" ] || fail "$root is not a trial folder (no .trial/marker); nothing removed."
[ ! -L "$root" ] || fail "$root is a link; nothing removed."
if [ -f "$state/running" ]; then
  pid=$(sed -n 1p "$state/running")
  if [ -n "$pid" ] && [ "$(started_at "$pid")" = "$(sed -n 2p "$state/running")" ]; then
    fail "the trial is still running (PID $pid); quit it first."
  fi
fi
existed_before() { grep -qxF "$1" "$state/outside-before.txt" 2>/dev/null; }

remove=()
kept=()
say "A trial made these:"
say "  $root ($(du -sh "$root" 2>/dev/null | cut -f1 | tr -d ' '))"
remove+=("$root")

keychain=0
if /usr/bin/security find-generic-password -s "$keychain_service" >/dev/null 2>&1; then
  if existed_before "keychain:$keychain_service"; then
    kept+=("keychain item \"$keychain_service\" (it existed before the first trial)")
  else
    say "  keychain item \"$keychain_service\""
    keychain=1
  fi
fi

# A Runner keeps its attachment cache under the SHA-256 of its own folder's real path.
cache="$HOME/.cache/opensteer/runner-attachments"
if [ -d "$cache" ] && [ -d "$root/Data" ]; then
  data_real=$(cd -P "$root/Data" && pwd -P)
  while IFS= read -r folder; do
    hash=$(printf '%s' "$data_real${folder#"$root/Data"}" | shasum -a 256 | cut -d' ' -f1)
    if [ -d "$cache/$hash" ]; then
      say "  $cache/$hash (attachments of the Runner in ${folder#"$root/"})"
      remove+=("$cache/$hash")
    fi
  done < <(find "$root/Data" -maxdepth 6 -type d -not -path "*/session/*" 2>/dev/null)
fi

electron_state=(
  "$HOME/Library/Preferences/com.github.Electron.plist"
  "$HOME/Library/Saved Application State/com.github.Electron.savedState"
  "$HOME/Library/Caches/com.github.Electron"
  "$HOME/Library/HTTPStorages/com.github.Electron"
  "$HOME/Library/Application Support/Electron"
)
for path in "${electron_state[@]}"; do
  [ -e "$path" ] || continue
  if existed_before "$path"; then
    kept+=("$path (it existed before the first trial; other Electron development apps use it)")
  else
    say "  $path"
    remove+=("$path")
  fi
done
# The cache folders themselves, only when the first trial made them and they end up empty.
parents=()
for path in "$cache" "$HOME/.cache/opensteer"; do
  [ -d "$path" ] && ! existed_before "$path" && parents+=("$path")
done

if [ -f "$root/Data/tailscale-share.json" ]; then
  port=$(/usr/bin/plutil -extract port raw -o - "$root/Data/tailscale-share.json" 2>/dev/null || true)
  kept+=("a Tailscale serve handler the trial added on HTTPS port ${port:-?}: turn sharing off in the trial (Settings, Remote access) or run: tailscale serve --https=${port:-PORT} off")
fi
agent_real=$( [ -d "$root/Agent home" ] && cd -P "$root/Agent home" && pwd -P || true)
if [ -n "$agent_real" ]; then
  for history in "$HOME/.claude/projects/$(printf '%s' "$agent_real" | sed 's/[^A-Za-z0-9]/-/g')"*; do
    [ -e "$history" ] && kept+=("$history (Claude Code's own history of the trial's runs; yours to keep or remove)")
  done
fi
if [ ${#kept[@]} -gt 0 ]; then
  say "Not removed:"
  for item in "${kept[@]}"; do say "  $item"; done
fi
say "Never touched: ${installed_folders[*]}"

[ "$list_only" = 0 ] || exit 0
if [ "$assume_yes" = 0 ]; then
  printf 'Remove what is listed under "A trial made these"? [y/N] '
  read -r answer
  case "$answer" in y | Y | yes) ;; *) say "Nothing removed."; exit 0 ;; esac
fi
# Checked again right before: the folder is still a trial folder and still not the installed one's.
[ -f "$state/marker" ] || fail "$root is no longer a trial folder; nothing removed."
for folder in "${installed_folders[@]}"; do
  meets "$root" "$folder" && fail "$root meets $folder; nothing removed."
done
for path in "${remove[@]}"; do
  rm -rf -- "$path"
  say "removed $path"
done
if [ "$keychain" = 1 ]; then
  while /usr/bin/security delete-generic-password -s "$keychain_service" >/dev/null 2>&1; do
    say "removed keychain item \"$keychain_service\""
  done
fi
for path in ${parents[@]+"${parents[@]}"}; do
  rmdir "$path" 2>/dev/null && say "removed $path (empty)" || true
done
say "Done."
