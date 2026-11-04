# Set up an Agent Phone

Needs a dedicated Android 11+ phone, a data cable (charging-only cables expose no ADB), USB
debugging, and Chromium WebUSB or Opensteer Desktop; Safari and Firefox cannot set up.

1. Turn on Personal remote access (Settings → Account → Remote access) and keep that Mac awake.
2. Open Settings → Devices → Computers → **Add a phone**, unlock the phone, accept the USB debugging
   prompt and select it.
3. Desktop shares an existing local ADB server. If browser setup is busy, use Desktop; another
   direct USB controller must release its session. Run `adb kill-server` only for a server you own.
4. Retry or replug in the same dialog to keep enrollment idempotent. Erase a foreign signer's data
   or unpair another Deployment only with the owner's consent; same-Deployment setup retargets and
   keeps keys and access.
5. Check online state and access in Computers.

**Recovery.** Reopen Agent Phone after a force-stop, and re-enable the accessibility service and
battery exemption if OEM management disabled them. Unlock once after a locked reboot. Run USB setup
again after a Host origin change, or once for a phone on an older proof format. Advanced Protection
can prohibit the service; retrying cannot fix that.
