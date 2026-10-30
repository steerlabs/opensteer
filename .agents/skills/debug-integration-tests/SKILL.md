---
name: debug-integration-tests
description: Diagnose PostgreSQL integration failures, containment errors, lock-order violations, or same-SHA reruns.
---

Read `docs/testing.md#integration-databases` for isolation and contamination rules.
Run a focused file through the launcher, not bare Vitest:

```sh
pnpm test:integration path/to/file.integration.test.ts
pnpm test:integration --preflight path/to/file.integration.test.ts
```

Use Docker, or supply both caller-owned database URLs named in testing.md.
Inspect the first failure before downstream contaminated cases. Check bundle
manifest diagnostics and use their rebuild command; do not bypass stale evidence
or fall back to tsx for recovery forks. Stop a broad run if unrelated cases fail
shared setup. Observe lock sets rather than backend PIDs across transaction retries.

Keep enforcing mode for acceptance. For diagnosis only:

```sh
OPENSTEER_LOCK_ORDER_MODE=record pnpm test:integration path/to/file.integration.test.ts
```

For an eligible complete unfiltered attempt, diagnose once at its original SHA:

```sh
pnpm integration:rerun /absolute/run-record/attempt
```

Read the JSON decision; exit 1 is intentional even when failures disappear.
See `scripts/run-record.ts` for attempt storage and contract requirements. Do not
use a rerun as a qualification receipt or rerun until green.

After SIGKILL or a host crash, identify the printed run-owned container before
removing it: `docker rm --force --volumes <container-id>`. Never stop caller-owned
servers or another run's resources. Report the first failure, command, SHA and
cleanup outcome.
