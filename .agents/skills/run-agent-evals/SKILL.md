---
name: run-agent-evals
description: Use when running agent tool-use behavioral evaluations (`pnpm eval:agent-tools`), checking a model-facing tool, guide or skill change, repeating the personal memory cases, or comparing a treatment with a compatible baseline.
---

# Run agent evals

Real-engine evals spend local subscription capacity and run by hand. Read
[the safety boundaries](../../../docs/testing.md#agent-tool-use-evaluations) first.

## Safety rules

- Devices have one owner: never take another task's simulator, emulator, USB phone or VM slot.
- Stop everything you start by captured PID or serial, even after a failure; never kill by name.
- Never drive the host screen: GUI and Electron checks run only in the VM (`pnpm test:vm`).
- Never read or operate signing keys, Apple accounts or release credentials.
- Never use a person's real profile, credentials, saved passwords, Messages or personal stores.
- Never touch the live install: `~/Library/Application Support/Opensteer`, `~/Opensteer`,
  `Opensteer Beta`.
- Skipped, blocked or unrun checks are unverified, never passed.
- Use an existing subscription login, add no API keys, and never target host files in a case.

## Procedures

- [Run and compare](references/running.md): harness tests, focused runs, baselines.
