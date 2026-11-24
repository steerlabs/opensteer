#!/bin/bash
# Runs in the disposable guest, over SSH, before the job's first journey (test-macos-journeys.sh
# calls it): the screen capture the image's SSH sessions were allowed to make is approved again, as
# of the guest's own clock.
#
# Why: macOS keeps, per responsible program, when it last asked whether that program may capture
# the screen without the system picker (replayd's ScreenCaptureApprovals.plist). It asks again once
# kScreenCapturePrivacyHintDate has passed: the last ask plus kScreenCapturePrivacyHintPolicy
# (30 days). The image asked on the day it was made, so every guest whose clock is more than 30
# days past that day shows "com.apple.sshd-session is requesting to bypass the system private
# window picker" at the first capture a journey makes over SSH, and the prompt takes the active app
# from whatever journey is running. Nobody answers it in a guest.
#
# What: for every program the image already approved, the last ask becomes now and the next one
# now plus that program's own policy, as an Allow at this moment would record; replayd is then
# restarted so it reads them. Nothing is approved that the image had not approved, and the guest
# is thrown away after the job. Prints what it found and what it wrote; exits non-zero when it
# could not write, so a job never runs believing it settled the prompt when it did not.
set -euo pipefail

plist="$HOME/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist"
# The guest only: never on a machine that is not a VM of this job.
if [ "$(sysctl -n kern.hv_vmm_present 2>/dev/null || echo 0)" != 1 ]; then
  echo "screen capture approval: not a virtual machine; nothing done" >&2
  exit 1
fi
if [ ! -f "$plist" ]; then
  echo "screen capture approval: the image holds no approvals; nothing to renew"
  exit 0
fi

now_epoch=$(date -u +%s)
iso() { date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ; }
now=$(iso "$now_epoch")
settled=2100-01-01T00:00:00Z
echo "screen capture approval: guest clock $now"
# Its top-level keys are the programs, one a line at the first indent of plutil's listing.
programs=$(plutil -p "$plist" | sed -n 's/^  "\(.*\)" => {$/\1/p')
[ -n "$programs" ] || { echo "screen capture approval: no programs in $plist"; exit 0; }
while IFS= read -r program; do
  [ -n "$program" ] || continue
  # plutil's key paths split on dots; every key the image holds is a program path without one.
  case "$program" in *.*)
    echo "screen capture approval: cannot address '$program' (a dot in its path)" >&2
    exit 1
    ;;
  esac
  before=$(plutil -extract "$program.kScreenCaptureApprovalLastAlerted" raw -o - "$plist" 2>/dev/null || echo none)
  # An ask stamped now still alerted again within minutes (Nov 24, 10:09 then 10:14): replayd's
  # rule is not the age of the last ask alone. The last ask and the next reminder go past any
  # job's life, the same on every run, and the last use is now.
  plutil -replace "$program.kScreenCaptureApprovalLastAlerted" -date "$settled" "$plist"
  plutil -replace "$program.kScreenCapturePrivacyHintDate" -date "$settled" "$plist"
  plutil -replace "$program.kScreenCaptureApprovalLastUsed" -date "$now" "$plist"
  echo "screen capture approval: $program last asked $before; now marked asked at $settled"
done <<<"$programs"

# replayd holds what it read; it reads the file again when it starts.
if launchctl print "gui/$(id -u)/com.apple.replayd" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/com.apple.replayd"
  echo "screen capture approval: replayd restarted"
else
  echo "screen capture approval: replayd is not running in this session; it reads the file at start"
fi
