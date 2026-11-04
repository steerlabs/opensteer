---
name: mac-gui
description: Use when running or diagnosing macOS GUI or Electron journeys in disposable Tart VMs (`pnpm test:vm`, goldens, persistent guests), changing Mac app observation, background input, owner viewing or the computer-use helper wire contract, diagnosing a Mac task Watch or owner window picture that freezes, disappears or fails to reopen, or helping a person enable macOS grants for an approved Mac app.
---

# Mac GUI

Procedures for anything that drives a macOS screen, and for Mac app control.
[GUI test VMs](../../../docs/testing.md#gui-test-vms) and
[Computer use](../../../docs/computer-use.md) hold the constraints.

## Safety rules

- Devices have one owner: never take another task's simulator, emulator, USB phone or VM slot.
- Stop everything you start by captured PID or serial, even after a failure; never kill by name.
- Never drive the host screen: GUI and Electron checks run only in the VM (`pnpm test:vm`).
- Never read or operate signing keys, Apple accounts or release credentials.
- Never use a person's real profile, credentials, saved passwords, Messages or personal stores.
- Never touch the live install: `~/Library/Application Support/Opensteer`, `~/Opensteer`,
  `Opensteer Beta`.
- Skipped, blocked or unrun checks are unverified, never passed.
- VM checks run after merge or on request, never as a pre-merge gate. Never boot a golden.

## Procedures

- [VM journeys](references/vm-journeys.md): runs, records, native resources, persistent guests,
  goldens.
- [Mac app control](references/app-control.md): helper checks and app-control journeys.
- [Frozen live view](references/live-view.md): diagnosing window pictures from logs.
- [Set up a Mac app](references/app-setup.md): guiding a person through macOS grants.
