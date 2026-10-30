---
name: quarantine-test
description: Record an unresolved flaky test with ownership and actionable evidence without weakening its gate.
---

Read `docs/testing.md#known-flaky-tests` and `scripts/quarantine.ts`.
Fix at the root when possible. If causality is unclear, rerun the failing test
once at the same SHA; a repeated failure is real, and a skipped case proves nothing.

Add the exact file and title path to `tests/quarantine.json`, with an owner,
reason/evidence, first-seen timestamp and a fix-or-delete deadline within seven
days. Use `quarantined` only with a full SHA and evidence; distinguish
`investigating` and `known-failure`. Record reproduction and acceptance criteria.
The entry never exempts execution or grants a passing gate. Keep assertions and
timeouts intact. Remove resolved entries rather than adding history to the docs.

```sh
pnpm exec prettier --write tests/quarantine.json
pnpm exec vitest run tests/quarantine.test.ts
```
