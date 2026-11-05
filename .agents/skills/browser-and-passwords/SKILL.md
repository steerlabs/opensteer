---
name: browser-and-passwords
description: Use when verifying browser sessions (native profiles, CDP boundary, editing, navigation, agent cursors, downloads), passkeys, Chrome extension pairing, site-cookie admission and sign-in delivery, the native Passwords broker, import worker and Swift/TypeScript wire fixtures, or saved-login leases, browser fills and sealed app delivery.
---

# Browser and passwords

Verification for browser sessions and Opensteer Passwords.
[Browser sessions](../../../docs/browser-sessions.md) and
[Opensteer Passwords](../../../docs/passwords.md) hold the rules these checks protect.

## Safety rules

- Devices have one owner: never take another task's simulator, emulator, USB phone or VM slot.
- Stop everything you start by captured PID or serial, even after a failure; never kill by name.
- Never drive the host screen: GUI and Electron checks run only in the VM (`pnpm test:vm`).
- Never read or operate signing keys, Apple accounts or release credentials.
- Never use a person's real profile, credentials, saved passwords, Messages or personal stores.
- Never touch the live install: `~/Library/Application Support/Opensteer`, `~/Opensteer`,
  `Opensteer Beta`.
- Skipped, blocked or unrun checks are unverified, never passed.
- Use disposable Chromium profiles, roots and test accounts; keep saved values out of reports.

## Procedures

- [Browser sessions](references/browser-sessions.md): editing, downloads, CDP boundary, native
  profiles, certified H.264 and popups.
- [Passkeys](references/passkeys.md): flag, routing tests, VM journey.
- [Chrome sign-ins](references/chrome-signins.md): extension pairing and delivery.
- [Passwords](references/passwords.md): Swift broker, wire fixtures, saved logins.
