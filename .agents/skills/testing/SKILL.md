---
name: testing
description: Use when diagnosing PostgreSQL integration test failures, containment or worker-contamination errors, lock-order violations or same-SHA reruns, quarantining an unresolved flaky test, selecting client attachment and Personal connection recovery checks after changing routing, catalog authority or reconnect behavior, or maintaining CI selection, shard weights, job timeouts and native-mac inputs.
---

# Testing

Test infrastructure procedures. [AGENTS.md](../../../AGENTS.md#verifying) holds the rules and
[Testing](../../../docs/testing.md) the traps. Report commands run and checks skipped.

## Safety rules

- Devices have one owner: never take another task's simulator, emulator, USB phone or VM slot.
- Stop everything you start by captured PID or serial, even after a failure; never kill by name.
- Never drive the host screen: GUI and Electron checks run only in the VM (`pnpm test:vm`).
- Never read or operate signing keys, Apple accounts or release credentials.
- Never use a person's real profile, credentials, saved passwords, Messages or personal stores.
- Never touch the live install: `~/Library/Application Support/Opensteer`, `~/Opensteer`,
  `Opensteer Beta`.
- Skipped, blocked or unrun checks are unverified, never passed.
- Never weaken an assertion, lengthen a timeout or rerun until green.

## Procedures

- [Integration tests](references/integration-tests.md): focused runs, lock order, reruns, crash
  cleanup.
- [Quarantine a flaky test](references/quarantine.md): recording an unresolved flake.
- [Client connections](references/client-connections.md): attachment and recovery checks.
- [CI maintenance](references/ci-maintenance.md): selection, shard weights, timeouts.
