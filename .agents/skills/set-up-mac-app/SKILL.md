---
name: set-up-mac-app
description: Use when helping a person enable macOS grants for an approved Mac app on that Mac.
---

# Set up a Mac app

Use the app's **Set up** action on this Mac's computer page. Complete native app
approval first; permission setup is separate from app authority. Let the setup
guide finish one app before starting another.

For GUI control, request Screen Recording first, then Accessibility, one explicit
person action each. Wait for macOS's dialog; use the guide's separate Settings
action if needed. Enable **Opensteer Computer Use**, not Opensteer or Opensteer
Beta. If macOS offers **Quit & Reopen**, accept it to refresh cached permission
state. Do not infer consent from a request returning or from `unknown`.

For Messages reads, enable the helper under Full Disk Access. Drag its row from
the setup guide into Settings if absent; main supplies the installed helper path.
Allow the idle helper to restart after the grant. For Messages sending, answer
the Automation question for Messages. Calendar and Reminders require full access,
not add-only. Keep a pending macOS question open even if an RPC times out; asking
again joins it. Use **Not now** to dismiss setup.

Do not grant the desktop app these permissions or request grants from a Runner.
See `apps/desktop/src/computer-app-setup-guide.ts` for current guide behavior.
