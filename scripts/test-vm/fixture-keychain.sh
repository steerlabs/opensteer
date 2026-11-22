#!/bin/bash
# A keychain made for a guest job's tests, never the login keychain.
#
#   fixture-keychain.sh begin <vm>   before the job's suite
#   fixture-keychain.sh end <vm>     in the job's cleanup, whatever happened
#
# Electron's protected storage (safeStorage) keeps its "… Safe Storage" item in the default
# keychain. A job's suite runs over SSH, where the guest's login keychain is locked, so every
# journey that keeps a secret failed ("the login keychain is locked"). `begin` creates a keychain
# of its own with a fixed test password, unlocked and without auto-lock, first in the user's
# search list and the user's default; `end` puts the previous default and search list back and
# deletes it. The login keychain is never unlocked, read or changed.
#
# It changes a user's default keychain, so it runs only inside the disposable guest of a job:
# macOS must report a hypervisor (kern.hv_vmm_present is 1, never on a physical Mac), and the
# marker the runner's staging step writes into the clone (~/opensteer-job/guest-job) must name
# the VM the runner passes. Anywhere else it refuses before it touches any keychain.
set -euo pipefail

usage() {
  echo "usage: fixture-keychain.sh begin|end <vm>" >&2
  exit 64
}
[ "$#" -eq 2 ] || usage
action="$1"
vm="$2"
case "$action" in begin | end) ;; *) usage ;; esac

refuse() {
  echo "fixture keychain: refused: $1" >&2
  exit 77
}
# The guard, first: nothing below runs on a machine that is not this job's guest.
[ "$(sysctl -n kern.hv_vmm_present 2>/dev/null || true)" = "1" ] ||
  refuse "this is not a virtual machine"
marker="$HOME/opensteer-job/guest-job"
[ -f "$marker" ] || refuse "no guest job marker at $marker"
[ "$(cat "$marker")" = "$vm" ] || refuse "the guest job marker names another VM"

# Its own constant, and its own file: no password comes from anywhere else.
password="opensteer-journey-fixture"
keychain="$HOME/Library/Keychains/opensteer-journey-fixture.keychain-db"
state="$HOME/opensteer-job/fixture-keychain.state"

# `security list-keychains` prints one quoted path a line.
list() { security list-keychains -d user | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//'; }
current_default() { security default-keychain -d user | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//'; }

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
  # shellcheck disable=SC2086 # one path a line, none with spaces in a guest's home
  security list-keychains -d user -s "$keychain" $(printf '%s\n' "$previous_list" | grep -vxF "$keychain" || true)
  security default-keychain -d user -s "$keychain"
  echo "fixture keychain: in place, default and first in the search list"
  exit 0
fi

# end: restore the previous default and search list, whatever `begin` got to, then delete it.
[ -f "$state" ] || {
  echo "fixture keychain: nothing to restore"
  exit 0
}
previous_default="$(sed -n 1p "$state")"
previous_list="$(sed -n '2,$p' "$state")"
status=0
if [ -n "$previous_default" ]; then
  security default-keychain -d user -s "$previous_default" || status=1
fi
# shellcheck disable=SC2086
security list-keychains -d user -s $(printf '%s\n' "$previous_list" | grep -vxF "$keychain" || true) || status=1
# Deleted whether or not `begin` got as far as creating it; a failure counts only if it is still there.
security delete-keychain "$keychain" 2>/dev/null || [ ! -e "$keychain" ] || status=1
rm -f "$state"
echo "fixture keychain: restored the previous default and search list"
exit "$status"
