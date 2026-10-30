---
name: check-client-connections
description: Select focused client attachment and Personal connection recovery checks when changing routing, catalog authority or reconnect behavior.
---

Run from the repository root. Choose the affected checks; this is not a checklist
for every change.

For shared attachment, discovery and route behavior:

```sh
pnpm exec vitest run packages/client/src/connections
```

For Personal recovery and log ownership, build the process helper first:

```sh
pnpm --filter @opensteer/desktop build:process-supervisor
pnpm exec vitest run apps/desktop/src/supervisor/personal-deployment-supervisor.test.ts apps/desktop/src/supervisor/personal-process-port.test.ts apps/desktop/src/supervisor/personal-log-retention.test.ts
```

For signed-out and unreachable place behavior:

```sh
pnpm exec vitest run apps/web/src/components/places/place-menu.interaction.test.tsx
```

Use `docs/testing.md` for GUI/VM procedures; never run real desktop journeys on
the host screen. See `docs/connections.md` for the authority and retry constraints
these checks protect. Report skipped checks explicitly.
