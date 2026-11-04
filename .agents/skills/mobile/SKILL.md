---
name: mobile
description: Use when building or running the Opensteer Expo app on a simulator or device (including mock mode), installing a signed iPhone beta, preparing the mobile VM golden for `pnpm test:vm -- --mobile`, or testing mobile push, dictation, remote text editing and display viewing, or the iPhone Calendar, Contacts and Reminders integrations.
---

# Mobile

Procedures for the Expo client in `apps/mobile`. Constraints live in
[Opensteer on a phone](../../../docs/mobile.md) and [Dictation](../../../docs/dictation.md).

## Safety rules

- Devices have one owner: never take another task's simulator, emulator, USB phone or VM slot.
- Stop everything you start by captured PID or serial, even after a failure; never kill by name.
- Never drive the host screen: GUI and Electron checks run only in the VM (`pnpm test:vm`).
- Never read or operate signing keys, Apple accounts or release credentials.
- Never use a person's real profile, credentials, saved passwords, Messages or personal stores.
- Never touch the live install: `~/Library/Application Support/Opensteer`, `~/Opensteer`,
  `Opensteer Beta`.
- Skipped, blocked or unrun checks are unverified, never passed.
- A build, export, install or launch proves no journey. Keep device IDs and tokens out of evidence.

## Procedures

- [Build and run](references/build-and-run.md): dev client, Release, mock mode, Android push input.
- [Signed iPhone beta](references/install-beta.md): founder install, private-preview signing.
- [Mobile VM golden](references/vm-golden.md): licensed Xcode and runtime inputs.
- [Push](references/push.md): physical-device push.
- [Dictation](references/dictation.md): iPhone and Mac speech capture.
- [Editing and display viewing](references/editing.md): editing, keyboards, viewers, H.264 fixtures.
- [iPhone apps](references/iphone-apps.md): wire checks, native journey, store fixtures.
