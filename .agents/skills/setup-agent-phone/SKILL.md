---
name: setup-agent-phone
description: Set up or recover a dedicated Android Agent Phone over USB when pairing, permissions or connectivity need repair.
---

# Set up an Agent Phone

Read [the phone constraints](../../../docs/agent-phone.md). Reserve one owner for the USB
phone; do not take another task's device. Use a dedicated Android 11+ phone, data cable,
USB debugging and Chromium WebUSB or Opensteer Desktop. Unlock and accept the USB debugging
prompt if needed. Safari/Firefox cannot perform setup. A charging-only cable exposes no ADB.

Open Settings → Computers → Add a phone. Enable Personal remote access first and keep its
Mac awake. Select the intended phone; cancellation selects nothing. Desktop automatically shares an
existing local ADB server for the selected USB phone. If browser setup is busy, use Desktop;
another direct USB controller must release its session. Run `adb kill-server` only for a
server you own. Retry/replug in the same
dialog to retain enrollment idempotency. Confirm foreign-signer data erasure or another
Deployment's unpair only with the owner's consent. Existing same-Deployment setup should
retarget and preserve keys/access. Check online state and access in Computers.

For recovery, reopen Agent Phone after force-stop; re-enable accessibility/battery exemption
in Android settings if OEM management disabled it. Unlock once after a locked reboot.
Run USB setup again after a Host origin change or for pre-proof-v2 phones. Advanced Protection
may prohibit the service; retrying connectivity cannot fix that restriction.

Stop any diagnostic capture loop or server you started with its recorded PID (`kill <pid>`).
Stop an emulator you started with `adb -s <serial> emu kill`; stop an ADB server you started
with `adb kill-server`. Leave caller-owned devices and servers running. Do cleanup on failure too.
