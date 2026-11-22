#!/bin/bash
# What the suite's own session can do with the job's fixture keychain and with Electron's
# protected storage. A guest job of its own; it prints one labelled line a fact:
#
#   pnpm test:vm -- bash ../../scripts/test-vm/keychain-diagnostic.sh
#
# Three conditions, each quick: as the suite runs (after its own unlock), after locking the fixture
# keychain in this session, and after unlocking it again. It settled the cause: an unlock does not
# carry between SSH connections, and Electron in a session where the fixture keychain is locked
# gets errSecInteractionNotAllowed (-25308). (A fourth, under `launchctl asuser`, left an Electron
# behind that held the suite's connection open; it is gone.)
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

# A command in a process group of its own, killed after $1 seconds; when it ends, for any reason,
# whatever it left in its group (Electron's helpers) is killed too, so nothing outlives it to hold
# the suite's SSH connection open.
bounded() {
  local seconds="$1"
  shift
  perl -e '
    my $seconds = shift;
    my $pid = fork() // exit 126;
    if ($pid == 0) { setpgrp(0, 0); exec(@ARGV) or exit 127 }
    setpgrp($pid, $pid);
    local $SIG{ALRM} = sub { kill("KILL", -$pid); waitpid($pid, 0); exit 137 };
    alarm($seconds);
    waitpid($pid, 0);
    my $status = $?;
    alarm(0);
    kill("KILL", -$pid);
    exit($status & 127 ? 128 + ($status & 127) : $status >> 8);
  ' "$seconds" "$@"
}
say() { printf '%s: %s\n' "$1" "$2"; }

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

exit 0
