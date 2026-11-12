# Integration tests

Run focused files through the launcher, never bare Vitest. Use Docker, or set both
`OPENSTEER_TEST_DATABASE_URL` and `OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL` to caller-owned
servers that allow creating databases; the launcher owns only its clones and templates.

```sh
pnpm test:integration path/to/file.integration.test.ts
pnpm test:integration --preflight path/to/file.integration.test.ts
OPENSTEER_LOCK_ORDER_MODE=record pnpm test:integration path/to/file.integration.test.ts
pnpm integration:rerun /absolute/run-record/attempt
```

- Diagnose the first failure before later contaminated ones. Use the bundle manifest diagnostics'
  rebuild command; never bypass stale evidence or fall back to tsx for recovery forks. Stop a broad
  run if unrelated cases fail shared setup. Across transaction retries, watch lock sets, not backend
  PIDs.
- `record` lock-order mode is for diagnosis only; acceptance keeps enforcing mode.
- `integration:rerun` takes a complete, unfiltered attempt and reruns it once at its original SHA.
  It always exits 1; read its JSON for whether failures reproduced.
  [run-record.ts](../../../../scripts/run-record.ts) owns attempt storage.
- After SIGKILL or a host crash, identify the printed run-owned container, then
  `docker rm --force --volumes <container-id>`.

Report the first failure, command, SHA and cleanup outcome.

Use the fresh personal and team fixtures for their respective Host kinds. A team fixture has
no Runner; a personal fixture has one owner and hosting computer. Run authority races with:

```sh
OPENSTEER_LOCK_ORDER_MODE=enforce pnpm test:integration -- --config vitest.integration.config.ts path/to/file.integration.test.ts
```

Hold writes across the real access fence and test buffered reads at handoff. Removal evidence
starts after the command returns. Old-lineage migration compatibility cannot qualify the fresh
baseline; test old-database refusal and rename-aside reset in disposable fixtures instead.
