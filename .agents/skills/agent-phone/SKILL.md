---
name: agent-phone
description: Use when building Agent Phone APKs or checking their Android build prerequisites, setting up or recovering a dedicated Android Agent Phone over USB (pairing, permissions, connectivity), or running Agent Phone wire, Android instrumentation, emulator device, self-update, soak or display-performance checks after changing phone behavior.
---

# Agent Phone

Procedures for `apps/agent-phone`. [Agent Phone](../../../docs/agent-phone.md) holds its constraints
and what each kind of test cannot prove.

## Safety rules

- Devices have one owner: never take another task's simulator, emulator, USB phone or VM slot.
- Stop everything you start by captured PID or serial, even after a failure; never kill by name.
- Never drive the host screen: GUI and Electron checks run only in the VM (`pnpm test:vm`).
- Never read or operate signing keys, Apple accounts or release credentials.
- Never use a person's real profile, credentials, saved passwords, Messages or personal stores.
- Never touch the live install: `~/Library/Application Support/Opensteer`, `~/Opensteer`,
  `Opensteer Beta`.
- Skipped, blocked or unrun checks are unverified, never passed.
- Release APKs come only from the release workflow; never touch the permanent keystore.

## Procedures

- [Build](references/build.md): prerequisites, debug and test-TLS builds.
- [Set up a phone](references/setup.md): USB setup and recovery.
- [Test](references/testing.md): wire, device suites, instrumentation, benchmark, evidence.
