#!/usr/bin/env bash
set -euo pipefail
[[ "$(/usr/sbin/sysctl -n hw.model)" == *VirtualMac* ]] || { echo 'Popup journey requires a disposable VM' >&2; exit 2; }
popup_dist="$(mktemp -d "${TMPDIR:-/tmp}/opensteer-popup-electron.XXXXXX")"
trap 'chmod -R u+w "$popup_dist"; rm -rf "$popup_dist"' EXIT
/usr/bin/tar -xf '/Volumes/My Shared Files/inputs/Electron.tar' -C "$popup_dist"
export ELECTRON_OVERRIDE_DIST_PATH="$popup_dist"
export VITE_BROWSER_PRESENTATION=h264
pnpm --workspace-root exec playwright-core install chromium
pnpm test:native-browser-journey -- --popups
