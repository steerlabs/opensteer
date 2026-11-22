#!/bin/bash
# What the suite's own session can do with the job's fixture keychain and with Electron's
# protected storage. A guest job of its own; it prints one labelled line a fact:
#
#   pnpm test:vm -- bash ../../scripts/test-vm/keychain-diagnostic.sh
#
# The same guard as fixture-keychain.sh, by calling it: a hypervisor, and the clone's marker
# naming the VM the runner exported to the suite (OPENSTEER_TEST_GUEST_JOB). Every keychain
# change goes through fixture-keychain.sh and touches only the fixture keychain; the Electron
# probes run only while the fixture keychain is the default, so the "Safe Storage" item they may
# create lands in it and goes when it is deleted. Every command is bounded.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fixture() { /bin/bash "$here/fixture-keychain.sh" "$1" "${OPENSTEER_TEST_GUEST_JOB:-}"; }
fixture guard || exit "$?"

# A command that is killed after $1 seconds.
bounded() {
  local seconds="$1"
  shift
  perl -e 'alarm shift; exec @ARGV or exit 127' "$seconds" "$@"
}
say() { printf '%s: %s\n' "$1" "$2"; }

uid="$(id -u)"
user="$(id -un)"
say "session manager" "$(bounded 10 launchctl managername 2>&1)"
say "console user" "$(stat -f '%Su %u' /dev/console)"
say "ssh connection" "${SSH_CONNECTION:+yes}${SSH_CONNECTION:-no}"
default="$(bounded 10 security default-keychain -d user 2>&1 | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//')"
say "default keychain" "$default"
say "search list" "$(bounded 10 security list-keychains -d user 2>&1 | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//' | paste -sd ' ' -)"

electron="$(cd "$here/../../apps/desktop" && bounded 30 node -p 'require("electron")')"
say "electron" "$electron $(bounded 30 "$electron" --version 2>/dev/null || true)"
probe_dir="$HOME/opensteer-job/keychain-diagnostic"
mkdir -p "$probe_dir"
# Its own app name, so its item is "opensteer-keychain-diagnostic Safe Storage".
printf '%s\n' '{"name":"opensteer-keychain-diagnostic","main":"main.cjs"}' >"$probe_dir/package.json"
cat >"$probe_dir/main.cjs" <<'PROBE'
const { app, safeStorage } = require("electron");
const say = (fact, value) => process.stdout.write(`${process.env.PROBE_LABEL}: ${fact}: ${value}\n`);
const attempt = async (fact, work) => { try { say(fact, await work()); } catch (e) { say(fact, `error: ${e.message}`); } };
app.whenReady().then(async () => {
  await attempt("isEncryptionAvailable", () => safeStorage.isEncryptionAvailable());
  await attempt("isAsyncEncryptionAvailable", () => safeStorage.isAsyncEncryptionAvailable());
  await attempt("encryptStringAsync", async () => { const c = await safeStorage.encryptStringAsync("probe"); const d = await safeStorage.decryptStringAsync(c); return d.result === "probe" ? `ok, ${c.length} bytes, decrypt ok` : "decrypt returned different text"; });
  await attempt("encryptString", () => (safeStorage.decryptString(safeStorage.encryptString("probe")) === "probe" ? "ok, decrypt ok" : "decrypt returned different text"));
  app.exit(0);
});
PROBE

# Electron in one condition; Chromium's own keychain log lines (which carry the OSStatus that
# Electron's error hides) follow, prefixed.
electron_probe() {
  local label="$1"
  shift
  if [ "$(bounded 10 security default-keychain -d user 2>&1 | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//')" != "$default" ] ||
    [[ "$default" != */opensteer-journey-fixture.keychain-db ]]; then
    say "$label" "skipped: the fixture keychain is not the default"
    return
  fi
  local log="$probe_dir/$label.stderr"
  bounded 60 "$@" env -u ELECTRON_RUN_AS_NODE PROBE_LABEL="$label" \
    "$electron" --enable-logging=stderr --v=1 "$probe_dir" 2>"$log"
  say "$label" "exit $?"
  grep -iE 'keychain|osstatus|os_crypt|safe storage|encrypt' "$log" | head -20 | sed "s/^/$label: chromium log: /"
}

fixture probe
electron_probe "electron as the suite runs" env
fixture lock
fixture probe
electron_probe "electron after locking the fixture keychain in this session" env
fixture unlock
electron_probe "electron after unlocking it again in this session" env

# The user's GUI (Aqua) session, if a command can reach it from here.
asuser=()
if bounded 10 launchctl asuser "$uid" /usr/bin/true 2>/dev/null; then
  asuser=(launchctl asuser "$uid")
elif bounded 10 sudo -n launchctl asuser "$uid" sudo -n -u "$user" /usr/bin/true 2>/dev/null; then
  asuser=(sudo -n launchctl asuser "$uid" sudo -n -u "$user")
fi
if [ "${#asuser[@]}" -eq 0 ]; then
  say "electron under launchctl asuser" "skipped: launchctl asuser $uid is not allowed here"
else
  say "asuser command" "${asuser[*]}"
  say "asuser session manager" "$(bounded 10 "${asuser[@]}" launchctl managername 2>&1)"
  electron_probe "electron under launchctl asuser" "${asuser[@]}" env HOME="$HOME"
fi
exit 0
