#!/bin/sh
set -eu
umask 077
fail() { printf 'Opensteer: %s\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || fail 'This installer requires macOS.'
[ "$(uname -m)" = arm64 ] || fail 'Opensteer requires an Apple silicon (arm64) Mac; Intel is not supported.'
major=$(sw_vers -productVersion | cut -d . -f 1)
[ "$major" -ge 13 ] || fail 'Opensteer requires macOS 13 or later.'
repo=${OPENSTEER_RELEASE_REPOSITORY_URL:-https://github.com/steerlabs/opensteer}
repo=${repo%/}
# Disallow credentials, queries, fragments and shell/URL ambiguity.
printf '%s\n' "$repo" | LC_ALL=C grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~-]+)*$|^http://(127\.0\.0\.1|localhost)(:[0-9]+)?(/[A-Za-z0-9._~-]+)*$' || fail 'Repository URL must use HTTPS (HTTP is allowed only on localhost or 127.0.0.1).'
proto='=https'
case "$repo" in http://*) proto='=http,https' ;; esac
fetch() { curl -q -fsSL --proto "$proto" --proto-redir "$proto" --tlsv1.2 --connect-timeout 30 --max-time 600 "$@"; }
target=${OPENSTEER_INSTALL_DIRECTORY:-}
if [ -z "$target" ]; then
  if [ -w /Applications ]; then target=/Applications; else target=$HOME/Applications; fi
fi
case "$target" in /*) ;; *) fail 'Install directory must be absolute.' ;; esac
# Check every existing component before mkdir or resolving the directory.
part=$target
while [ "$part" != / ]; do
  [ ! -L "$part" ] || fail "Symlinked install directory: $part"
  part=$(dirname "$part")
done
mkdir -p "$target"
target=$(cd "$target" && pwd -P)
app=$target/Opensteer.app
lock=$target/.opensteer-install.lock
mkdir "$lock" 2>/dev/null || fail "Another installer holds $lock (remove it only after confirming that installer has stopped)."
tmp=
stage=
backup=
committed=0
cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  if [ "$committed" = 0 ] && [ -n "$backup" ] && [ -d "$backup/Opensteer.app" ]; then
    if [ ! -e "$app" ] && [ ! -L "$app" ]; then
      mv "$backup/Opensteer.app" "$app" || printf 'Restore failed; previous app is at %s\n' "$backup/Opensteer.app" >&2
    fi
  fi
  [ -z "$stage" ] || rm -rf "$stage"
  if [ -n "$backup" ] && [ ! -e "$backup/Opensteer.app" ]; then rmdir "$backup"; fi
  [ -z "$tmp" ] || rm -rf "$tmp"
  rmdir "$lock"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
tmp=$(mktemp -d "${TMPDIR:-/tmp}/opensteer-install.XXXXXXXX")
plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist"; }
signed_by_opensteer() {
  codesign --verify --deep --strict "$1" 2>/dev/null || return 1
  codesign -dv --verbose=4 "$1" 2>&1 | grep -qx 'TeamIdentifier=B47U2LLKHW'
}
# An installed copy is trusted (kept, compared or launched) only when it is an
# intact Opensteer-signed build; anything else claiming its name is refused.
check_destination() {
  [ ! -L "$app" ] || fail 'Destination Opensteer.app is a symlink.'
  if [ -e "$app" ]; then
    [ "$(plist "$app" CFBundleIdentifier)" = com.opensteer.opensteer ] || fail 'Destination has a different bundle id.'
    signed_by_opensteer "$app" || fail "$app is not a valid Opensteer build signed by Opensteer; move it aside and retry."
  fi
}
check_destination
latest=$(fetch -o /dev/null -w '%{url_effective}' "$repo/releases/latest")
case "$latest" in "$repo/releases/tag/"*) tag=${latest#"$repo/releases/tag/"} ;; *) fail "Unexpected Latest URL: $latest" ;; esac
printf '%s\n' "$tag" | LC_ALL=C grep -Eq '^desktop-v[0-9]+\.[0-9]+\.[0-9]+$' || fail "Invalid release tag: $tag"
version=${tag#desktop-v}
base=$repo/releases/download/$tag
fetch -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"
fetch -o "$tmp/application.zip" "$base/Opensteer-mac-arm64.zip"
expected=$(awk '$2 == "Opensteer-mac-arm64.zip" {print $1}' "$tmp/SHA256SUMS")
printf '%s\n' "$expected" | LC_ALL=C grep -Eq '^[a-fA-F0-9]{64}$' || fail 'Missing or ambiguous zip checksum.'
actual=$(shasum -a 256 "$tmp/application.zip" | cut -d ' ' -f 1)
[ "$actual" = "$expected" ] || fail 'Archive SHA-256 mismatch.'
# Reject absolute and parent paths before allowing ditto to write anything.
unzip -Z1 "$tmp/application.zip" > "$tmp/entries"
if LC_ALL=C grep -Eq '^/|(^|/)\.\.(/|$)' "$tmp/entries"; then fail 'Unsafe archive paths.'; fi
mkdir "$tmp/extracted"
ditto -x -k "$tmp/application.zip" "$tmp/extracted"
set -- "$tmp/extracted/"*.app
[ "$#" = 1 ] && [ "$1" = "$tmp/extracted/Opensteer.app" ] && [ -d "$1" ] && [ ! -L "$1" ] || fail 'Archive must contain exactly one Opensteer.app.'
incoming=$1
[ "$(plist "$incoming" CFBundleIdentifier)" = com.opensteer.opensteer ] || fail 'Unexpected bundle id.'
[ "$(plist "$incoming" CFBundleShortVersionString)" = "$version" ] && [ "$(plist "$incoming" CFBundleVersion)" = "$version" ] || fail 'Bundle version does not match release tag.'
exe=$(plist "$incoming" CFBundleExecutable)
case "$exe" in ''|*/*|.|..) fail 'Invalid bundle executable.' ;; esac
[ "$(lipo -archs "$incoming/Contents/MacOS/$exe")" = arm64 ] || fail 'Bundle executable must be arm64 only.'
codesign --verify --deep --strict "$incoming"
signed_by_opensteer "$incoming" || fail 'Unexpected signing team.'
spctl --assess --type execute "$incoming"
launch() {
  if [ "${OPENSTEER_INSTALL_NO_OPEN:-0}" != 1 ]; then open "$app"; fi
  printf 'Opensteer is installed at %s\n' "$app"
}
# True when the destination already holds this release or a newer one.
current() {
  check_destination
  [ -e "$app" ] || return 1
  installed=$(plist "$app" CFBundleShortVersionString)
  printf '%s\n' "$installed" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail 'Invalid installed version.'
  awk -v a="$installed" -v b="$version" 'BEGIN {split(a,x,".");split(b,y,".");for(i=1;i<=3;i++){if(x[i]+0>y[i]+0)exit 0;if(x[i]+0<y[i]+0)exit 1}exit 0}'
}
if current; then launch; exit 0; fi
running() {
  ps -axo command= | awk '$0 ~ /^\/.*Opensteer[.]app\/Contents\/MacOS\// || ($0 ~ /^\/.*ShipIt/ && index($0,"com.opensteer.opensteer")) {found=1} END {exit !found}'
}
if running; then
  osascript -e 'ignoring application responses' -e 'tell application id "com.opensteer.opensteer" to quit' -e 'end ignoring' >/dev/null
  deadline=$(($(date +%s) + 120))
  while running; do
    [ "$(date +%s)" -lt "$deadline" ] || fail 'Opensteer or its ShipIt updater is still running after two minutes. Quit it and retry.'
    sleep 1
  done
fi
stage=$(mktemp -d "$target/.opensteer-stage.XXXXXXXX")
ditto "$incoming" "$stage/Opensteer.app"
codesign --verify --deep --strict "$stage/Opensteer.app"
if running; then fail 'Opensteer or ShipIt restarted during installation; quit it and retry.'; fi
# While we waited, ShipIt may have installed an update newer than this release.
if current; then launch; exit 0; fi
backup=$(mktemp -d "$target/.opensteer-previous.XXXXXXXX")
if [ -e "$app" ]; then mv "$app" "$backup/Opensteer.app"; fi
mv "$stage/Opensteer.app" "$app"
committed=1
# Never restore after launch: the new app may have migrated user data.
rm -rf "$backup"
backup=
launch
