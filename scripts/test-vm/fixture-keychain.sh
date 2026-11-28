#!/bin/bash
# A keychain made for a guest job's tests, never the login keychain.
#
#   fixture-keychain.sh begin <vm>    before the job's suite, in its own SSH connection
#   fixture-keychain.sh unlock <vm>   at the start of the suite's own SSH connection
#   fixture-keychain.sh end <vm>      in the job's cleanup, whatever happened
#   fixture-keychain.sh probe|lock|guard <vm>   for keychain-diagnostic.sh
#
# Electron's protected storage (safeStorage) keeps its "<app name> Safe Storage" item in the
# default keychain. A job's suite runs over SSH, where the guest's login keychain is locked, so every
# journey that keeps a secret failed ("the login keychain is locked"). `begin` creates a keychain
# of its own with a fixed test password, unlocked and without auto-lock, first in the user's
# search list and the user's default; `end` puts the previous default and search list back and
# deletes it. The login keychain is never unlocked, read or changed.
#
# The default keychain and the search list are stored preferences and carry over from `begin`'s
# connection to the suite's; whether a keychain is unlocked may belong to the security session
# that unlocked it, and each SSH connection is a session of its own. So the suite's connection
# runs `unlock` first, which says whether the fixture keychain was still unlocked there.
#
# It changes a user's default keychain, so it runs only inside the disposable guest of a job:
# macOS must report a hypervisor (kern.hv_vmm_present is 1, never on a physical Mac), and the
# marker the runner's staging step writes into the clone (~/opensteer-job/guest-job) must name
# the VM the runner passes. Anywhere else it refuses before it touches any keychain.
set -euo pipefail

usage() {
  echo "usage: fixture-keychain.sh begin|unlock|end|probe|lock|guard <vm>" >&2
  exit 64
}
[ "$#" -eq 2 ] || usage
action="$1"
vm="$2"
case "$action" in begin | unlock | end | probe | lock | guard) ;; *) usage ;; esac

refuse() {
  echo "fixture keychain: refused: $1" >&2
  exit 77
}
# The guard, first: nothing below runs on a machine that is not this job's guest.
[ "$(sysctl -n kern.hv_vmm_present 2>/dev/null || true)" = "1" ] ||
  refuse "this is not a virtual machine"
marker="$HOME/opensteer-job/guest-job"
[ -f "$marker" ] || refuse "no guest job marker at $marker"
[ -n "$vm" ] && [ "$(cat "$marker")" = "$vm" ] || refuse "the guest job marker names another VM"
if [ "$action" = guard ]; then
  echo "fixture keychain: guard passed: the guest of $vm"
  exit 0
fi

# Its own constant, and its own file: no password comes from anywhere else.
password="opensteer-journey-fixture"
keychain="$HOME/Library/Keychains/opensteer-journey-fixture.keychain-db"
state="$HOME/opensteer-job/fixture-keychain.state"

# The fixture authority: a certificate authority made for this job, the account service's
# certificate under a public-looking name, and that name on an address of the guest's own loopback
# interface in the hosts file. The Host fetches the account service's keys only from a name that
# resolves to a public address, never from 127.0.0.1 (run on e7080ea31), so the address is one it
# counts as public: 192.88.99.10, in the 6to4 relay prefix RFC 7526 deprecated, which no
# destination a guest reaches uses; the alias holds that one address, in the guest. Nothing is
# trusted here: the first-run journey hands the authority's file to the Mac app as
# NODE_EXTRA_CA_CERTS, which the app passes to its Host, and launches the app's Chromium told to
# accept the account service's one public key. The name and this folder are
# `tests/first-run/account-tls.ts`.
authority="$HOME/opensteer-job/fixture-authority"
authority_name="Opensteer journey fixture authority"
account_name="account.first-run.opensteer.example"
account_address="192.88.99.10"
hosts_line="$account_address $account_name # opensteer-job-fixture-authority"
# What `begin` did, one line each, written before it does it: `end` undoes exactly these, and keeps
# this record and the files until every removal succeeded.
authority_state="$HOME/opensteer-job/fixture-authority.state"

recorded_value() { sed -n "s/^$1 //p" "$authority_state" | head -n 1; }
# Whether an interface (`-a`: any) holds the address now; looking needs no root. The listing is
# read whole first: grep -q stops at its match, and under pipefail the listing it left unread
# would end the pipe with SIGPIPE (141) and read as "not held". 0: held; 1: not; 2: no listing.
holds_address() {
  local listing
  listing="$(ifconfig "$1")" || return 2
  grep -qE "^[[:space:]]inet $(printf '%s' "$2" | sed 's/\./\\./g') " <<<"$listing"
}

authority_begin() {
  [ ! -e "$authority_state" ] || refuse "a fixture authority is already in place"
  # A line appended to a file without a final newline would join its last entry.
  if [ "$(sudo -n tail -c 1 /etc/hosts | od -An -c | tr -d ' ')" != '\n' ]; then
    refuse "the guest's hosts file does not end in a newline"
  fi
  # An address already on an interface is not this step's to add, nor to take away after.
  local held=0
  holds_address -a "$account_address" || held=$?
  [ "$held" -ne 2 ] || refuse "the guest's interfaces could not be listed"
  [ "$held" -ne 0 ] || refuse "$account_address is already an address of this guest"
  mkdir -p "$authority"
  : >"$authority_state"
  # The runner puts this script in the job's folder (this step itself arrives over stdin).
  /bin/bash "$HOME/opensteer-job/fixture-authority-files.sh" "$authority" "$authority_name" "$account_name"
  echo "alias $account_address" >>"$authority_state"
  sudo -n ifconfig lo0 alias "$account_address" 255.255.255.255
  echo "hosts $hosts_line" >>"$authority_state"
  printf '%s\n' "$hosts_line" | sudo -n tee -a /etc/hosts >/dev/null
  # What the guest's resolver answers for the name now, for the run's log.
  echo "fixture authority: $account_name resolves to $(dscacheutil -q host -a name "$account_name" 2>/dev/null | sed -n 's/^ip_address: //p' | paste -sd ' ' - || true)"
  echo "fixture authority: in place, $account_name on $account_address, an address of loopback"
}

authority_end() {
  [ -f "$authority_state" ] || return 0
  local status=0 line
  line="$(recorded_value hosts)"
  if [ -n "$line" ]; then
    # Exactly the line `begin` added: every character matched as itself.
    sudo -n sed -i "" "/^$(printf '%s' "$line" | sed 's/[][\.*^$/]/\\&/g')\$/d" /etc/hosts || status=1
  fi
  line="$(recorded_value alias)"
  # `begin` refused an address already there, so one on loopback now is the one it added; one not
  # there is gone already (or never got there), and nothing is left to undo.
  if [ -n "$line" ]; then
    local held=0
    holds_address lo0 "$line" || held=$?
    if [ "$held" -eq 0 ]; then
      sudo -n ifconfig lo0 -alias "$line" || status=1
    elif [ "$held" -ne 1 ]; then
      # Not knowing whether it is still there, it keeps the record for another end.
      status=1
    fi
  fi
  if [ "$status" -ne 0 ]; then
    echo "fixture authority: not all of it could be removed; its record is kept for another end" >&2
    return 1
  fi
  rm -rf "$authority"
  rm -f "$authority_state"
  echo "fixture authority: removed"
}

# `security list-keychains` prints one quoted path a line.
list() { security list-keychains -d user | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//'; }
# The keychains of a saved list other than the fixture, one array item each, spaces kept.
others_in() {
  others=()
  local item
  while IFS= read -r item; do
    if [ -n "$item" ] && [ "$item" != "$keychain" ]; then others+=("$item"); fi
  done <<<"$1"
}
current_default() { security default-keychain -d user | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//'; }

# Write and read back a throwaway item in the fixture keychain only, and say what happened, with
# the exact error and status when it fails.
probe() {
  local label="$1" out status=0
  out="$(security add-generic-password -U -s opensteer-fixture-probe -a probe -w probe "$keychain" 2>&1)" || status=$?
  if [ "$status" -ne 0 ]; then
    echo "fixture keychain: $label: write failed (status $status): $out"
    return 1
  fi
  out="$(security find-generic-password -s opensteer-fixture-probe -a probe -w "$keychain" 2>&1)" || status=$?
  security delete-generic-password -s opensteer-fixture-probe -a probe "$keychain" >/dev/null 2>&1 || true
  if [ "$status" -ne 0 ] || [ "$out" != probe ]; then
    echo "fixture keychain: $label: wrote, read failed (status $status): $out"
    return 1
  fi
  echo "fixture keychain: $label: write and read ok"
}

if [ "$action" = begin ]; then
  [ ! -e "$state" ] || refuse "a fixture keychain is already in place"
  previous_default="$(current_default)"
  previous_list="$(list)"
  # What `end` restores, written before anything changes.
  {
    printf '%s\n' "$previous_default"
    printf '%s\n' "$previous_list"
  } >"$state"
  security create-keychain -p "$password" "$keychain"
  # No timeout and no lock on sleep: the job's suite may run for half an hour.
  security set-keychain-settings "$keychain"
  security unlock-keychain -p "$password" "$keychain"
  # The journeys' apps run in the guest's GUI session, a security session of its own, where this
  # keychain, the default, stayed locked: Chrome then held its first navigation on reading its own
  # key from it (chrome-background's R4 never sent its request) and its launch kept the cover from
  # becoming key (row 1). So it is unlocked in that session too; only launchd, asked by root, runs
  # a command there. The login keychain is still never unlocked.
  sudo -n launchctl asuser "$(id -u)" security unlock-keychain -p "$password" "$keychain"
  others_in "$previous_list"
  security list-keychains -d user -s "$keychain" ${others[@]+"${others[@]}"}
  security default-keychain -d user -s "$keychain"
  echo "fixture keychain: in place, default and first in the search list"
  authority_begin
  exit 0
fi

if [ "$action" = unlock ] || [ "$action" = probe ] || [ "$action" = lock ]; then
  [ -f "$state" ] || refuse "no fixture keychain is in place"
  case "$action" in
    probe)
      probe "in this session" || true
      ;;
    lock)
      security lock-keychain "$keychain"
      echo "fixture keychain: locked in this session"
      ;;
    unlock)
      probe "in this session before unlock" || true
      security unlock-keychain -p "$password" "$keychain"
      probe "in this session after unlock" || true
      ;;
  esac
  exit 0
fi

# end: undo the fixture authority, then restore the previous default and search list, whatever
# `begin` got to, then delete the keychain.
authority_status=0
authority_end || authority_status=1
[ -f "$state" ] || {
  echo "fixture keychain: nothing to restore"
  exit "$authority_status"
}
previous_default="$(sed -n 1p "$state")"
previous_list="$(sed -n '2,$p' "$state")"
status=0
if [ -n "$previous_default" ]; then
  security default-keychain -d user -s "$previous_default" || status=1
fi
others_in "$previous_list"
security list-keychains -d user -s ${others[@]+"${others[@]}"} || status=1
# Deleted whether or not `begin` got as far as creating it; a failure counts only if it is still there.
security delete-keychain "$keychain" 2>/dev/null || [ ! -e "$keychain" ] || status=1
rm -f "$state"
[ "$authority_status" -eq 0 ] || status=1
echo "fixture keychain: restored the previous default and search list"
exit "$status"
