---
name: desktop-builds
description: Use when building or installing a signed local Opensteer desktop app or a keyless desktop proof for local package feedback, building native desktop helpers, dispatching a desktop practice (insider) release or stable promotion, collecting exact-source release evidence, certifying a release draft in VMs, moving the previous-release compatibility baseline, or restoring a Personal database snapshot.
---

# Desktop builds and releases

Procedures for `Opensteer.app` (`com.opensteer.opensteer`). Read
[Builds and releases](../../../docs/releases.md) first. Do only the operation requested.

## Safety rules

- Devices have one owner: never take another task's simulator, emulator, USB phone or VM slot.
- Stop everything you start by captured PID or serial, even after a failure; never kill by name.
- Never drive the host screen: GUI and Electron checks run only in the VM (`pnpm test:vm`).
- Never read or operate signing keys, Apple accounts or release credentials.
- Never use a person's real profile, credentials, saved passwords, Messages or personal stores.
- Never touch the live install: `~/Library/Application Support/Opensteer`, `~/Opensteer`,
  `Opensteer Beta`.
- Skipped, blocked or unrun checks are unverified, never passed.
- Signed operations run only when Tim has prepared the signing configuration and asks.
- Never publish unasked or bypass source, signature, notarization, receipt or asset checks.

## Procedures

- [Local builds](references/local-builds.md): keyless proof, signed local install, helpers.
- [Releases](references/releases.md): dispatch, evidence, promotion, packaging, baseline.
- [Draft certification](references/draft-certification.md): a draft's ZIP in disposable VMs.
- [Snapshot restore](references/snapshot-restore.md): restoring a Personal database snapshot.
