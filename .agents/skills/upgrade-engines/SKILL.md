---
name: upgrade-engines
description: Use when bumping an engine pin, qualifying shipped, installed or downloaded engines on real accounts with `pnpm test:engines`, qualifying a local model server such as oMLX, or adding a newly available model.
---

# Upgrade engines

Read [Engine releases and new models](../../../docs/ai-engines.md#engine-releases-and-new-models)
and the affected `packages/harness-*` driver. Qualification spends real account capacity.

## Safety rules

- Devices have one owner: never take another task's simulator, emulator, USB phone or VM slot.
- Stop everything you start by captured PID or serial, even after a failure; never kill by name.
- Never drive the host screen: GUI and Electron checks run only in the VM (`pnpm test:vm`).
- Never read or operate signing keys, Apple accounts or release credentials.
- Never use a person's real profile, credentials, saved passwords, Messages or personal stores.
- Never touch the live install: `~/Library/Application Support/Opensteer`, `~/Opensteer`,
  `Opensteer Beta`.
- Skipped, blocked or unrun checks are unverified, never passed.
- Use spending-limited `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` or machine sign-ins; never log them.

## Procedures

- [Bump and qualify](references/qualify.md): pins, qualification, new models, local endpoints.
