# Opensteer

Opensteer is a person's Personal Cloud Computer for AI. They connect a device once; every AI
agent they use can reach their real accounts and devices, only as far as they allow, and they
can watch and stop it from their phone. Two product names exist: Opensteer and Opensteer Cloud
Computer. Read [docs/architecture.md](docs/architecture.md) before changing authority, sessions,
Stop or Disconnect.

- **Home**: where a person's browser profiles, apps, plugins, tasks and rules live. The Host
  (`apps/host`) with its own PostgreSQL, on their Mac (loopback), a Linux server (`deploy/home`)
  or an Opensteer Cloud Computer (a VM Opensteer runs: `apps/control-plane` is the Opensteer
  account service, `apps/home-provisioner` its reconciler).
- **Device**: a Mac, a phone or a Cloud Computer, connected once. Runners (`apps/runner`), the
  Android Agent Phone app and the Chrome tab sharing extension serve devices; they always dial
  the Home.
- **Agent**: a **connected agent** signs in over MCP with OAuth and consent and holds an
  `AgentGrant` (`everything`, or selected tasks, browser profiles, Mac apps and phone screens,
  plugins, shared Chrome tabs). **Your own agents** are the engines Opensteer runs as Runs of a
  task (Claude Code, Codex, Grok, Antigravity, Muse Code, Cursor, OpenCode, Pi).
- **You**: the person, on the web, desktop (Electron) and mobile (Expo) clients. They grant,
  answer Requests (Needs you), watch, Stop and Disconnect.

## What you would get wrong here

1. **One authority rule, one place.** Ownership ∩ organization policy ∩ grant ∩ task mode ∩
   device switch ∩ target approval, resolved in `packages/database/src/resource-access.ts`
   (`admitExecution`, `authorizeTarget`). Never decide authority anywhere else, never default to
   `full-access`, and read a connection's grant and policy in the same statement.
2. **Direct tools of a connected agent go through `AgentSessionService.run()`**
   (`apps/host/src/agent-sessions/agent-session-service.ts`): one recorded operation, the witness
   re-checked before each command, the person asked when the mode says so. **A change to the Home
   is a command through one door**, `dispatchCommand` (`apps/host/src/commands/dispatch.ts`),
   admitted by `admitCommand` in rule 1's file, sent by your app, a Run, an automation or a
   connected agent. A connected agent's command is that connection acting at the door, never a
   `run()` operation (`apps/host/src/commands/command-tools.integration.test.ts`).
3. **Nothing leaves the Home before it is in the Disconnect set**
   (`packages/database/src/connection-disconnect.ts`). Write the attempt row before the frame,
   the IPC call or the ticket. Disconnect shows an end only with evidence.
4. **Unknown stays unknown.** An effect that may have happened is `unknown`
   (`OperationOutcomeUnknown`): never `failed`, never `completed`, never retried by the Home.
5. **Outside a grant reads exactly like non-existent** (`not_found`, same message, no advice;
   `apps/host/src/mcp/agent-tool-failure.ts`). A connection's tool list, descriptions and server
   instructions name only what it holds (`apps/host/src/mcp/connection-contract.test.ts`).
6. **No new Host capability names.** Released apps cap the saved list at 32
   (`packages/protocol/src/desktop.ts`). Wire changes that released apps read are additive and
   optional (`packages/protocol/src/personal-wire.test.ts`). Migrations are expand-only.
7. **Your own agents' hot paths stay as cheap as before**, and a personal Home runs no
   organization query (`apps/host/src/runtime/personal-hot-paths.integration.test.ts`).
8. **Words.** "connected agent", "your own agents", "Opensteer account", "device" in sentences.
   Never write that an agent cannot see a password or card: Opensteer fills it into the page and
   does not return it; an agent working in that page can read it.

## Checks

```sh
pnpm lint
pnpm typecheck          # every package and the root tests
pnpm test
pnpm format:check
OPENSTEER_LOCK_ORDER_MODE=enforce pnpm test:integration [files]
```

Procedures for builds, VMs, phones, browsers and passwords, setup and tests are skills in
`.agents/skills` (also `.claude/skills`).
