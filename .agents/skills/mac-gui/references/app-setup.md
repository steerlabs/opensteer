# Set up a Mac app

The person makes every grant on their own Mac. Use the app's **Set up** action on this Mac's
computer page, after native app approval, one app at a time
([setup guide](../../../../apps/desktop/src/computer-app-setup-guide.ts)).

- **GUI control**: Screen Recording first, then Accessibility, one person action each; wait for
  macOS's dialog or use the guide's Settings action. Enable **Opensteer Computer Use**, not
  Opensteer or Opensteer Beta, and accept **Quit & Reopen** if offered. A returned request or
  `unknown` state is not consent.
- **Messages reads**: enable the helper under Full Disk Access, dragging its row from the guide if
  absent; let the idle helper restart, then answer the Contacts question so names resolve.
- **Messages sending**: answer the Automation question for Messages.
- **Calendar and Reminders**: full access, not add-only.

Keep a pending macOS question open even if an RPC times out; asking again joins it. **Not now**
dismisses setup. Never grant these to the desktop app itself or request grants from a Runner.
