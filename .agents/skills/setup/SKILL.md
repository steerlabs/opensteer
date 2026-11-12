---
name: setup
description: Use when enrolling a computer in an Opensteer Deployment or resolving its SSH, Full Disk Access and app access setup, registering an integration OAuth app or configuring managed or custom consent and testing an integration authorization flow, or setting up, adding or testing a messaging provider and its channel transport.
---

# Setup

Lending a computer, connecting integrations and wiring messaging.
[Computers](../../../docs/computers.md), [Integration OAuth](../../../docs/integration-oauth.md) and
[Messaging](../../../docs/messaging.md) hold the authority rules.

## Safety rules

- Devices have one owner: never take another task's simulator, emulator, USB phone or VM slot.
- Stop everything you start by captured PID or serial, even after a failure; never kill by name.
- Never drive the host screen: GUI and Electron checks run only in the VM (`pnpm test:vm`).
- Never read or operate signing keys, Apple accounts or release credentials.
- Never use a person's real profile, credentials, saved passwords, Messages or personal stores.
- Never touch the live install: `~/Library/Application Support/Opensteer`, `~/Opensteer`,
  `Opensteer Beta`.
- Skipped, blocked or unrun checks are unverified, never passed.
- Owners enter provider secrets and bot tokens through the product, never in commits or logs.

## Procedures

- [Computers](references/computers.md): enrollment, app access, agent SSH.
- [Integration OAuth](references/integration-oauth.md): managed and custom apps, checks.
- [Messaging](references/messaging.md): Slack, new providers, checks.
- [Team server](../team-server/SKILL.md): Docker testing and first-owner setup renewal.
