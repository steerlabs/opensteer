# Client connection checks

Choose the affected group; [Client connections](../../../../docs/connections.md) holds the
constraints. In order: shared attachment, discovery and routes; Personal recovery and log ownership
(build the process helper first); signed-out and unreachable places.

```sh
pnpm exec vitest run packages/client/src/connections
pnpm --filter @opensteer/desktop build:process-supervisor
pnpm exec vitest run apps/desktop/src/supervisor/personal-deployment-supervisor.test.ts apps/desktop/src/supervisor/personal-process-port.test.ts apps/desktop/src/supervisor/personal-log-retention.test.ts
pnpm exec vitest run apps/web/src/components/places/place-menu.interaction.test.tsx
```
