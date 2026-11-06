# Opensteer test lint rules

An oxlint JS plugin loaded directly from `.oxlintrc.json`; it needs no build. Its tests are
[tests/test-lint-rules.test.ts](../../tests/test-lint-rules.test.ts). The rules cover
`*.test.ts(x)`, `*.test-support.ts` and code under `tests/`; the retry check also covers
`vitest*.config.*`, and suppression reasons are required in every file. Together they enforce
the waiting rules in [AGENTS.md](../../AGENTS.md#verifying). Each rule is prefixed `opensteer/`.

- `no-real-time-wait-in-tests`: no real sleeps, including through local wrappers and aliased
  timer imports. Await the event, use a `vi.waitFor`/`vi.waitUntil` condition, or fake timers.
- `no-polling-loop-in-tests`: no loops around awaited sleeps.
- `no-unreasoned-skip-or-retry`: `skip`, `todo` and `fails` need a reason on the line before;
  conditional `skipIf`/`runIf` are fine. Test and suite retries are forbidden, and configs may
  set only `retry: 0`.
- `require-suppression-reason`: disabling one of these rules needs ` -- <reason>`.
- `no-unit-test-timeout`: default-lane tests keep the default timeout. Real PostgreSQL, GUI,
  engine, device, soak and VM suites, plus the exact `realBrowserTests` list in
  [ci-test-files.mjs](../../.github/scripts/ci-test-files.mjs), keep their own budgets, from 30 seconds to hours, so a
  universal ceiling would be wrong.
- `no-unbounded-created-promise`: a locally created promise whose resolver escapes its executor
  must be bounded, with `@opensteer/shared/withTimeout` and a useful `timeoutError`, before it is
  awaited in the same test. It is a narrow heuristic, not a detector of every unbounded wait.

## Baseline

[baseline.json](baseline.json) holds existing violations, keyed by rule and exact source hash.
It may only shrink: `pnpm lint` compares it with the merge base on `origin/main` (fetch first),
and editing, adding or moving a violation needs a fix. There is no way to accept new debt.
After fixing violations, remove their allowances with:

```sh
node tooling/oxlint-plugin-opensteer/baseline.mjs --prune
```

The baseline is temporary. Once it is empty, delete it with its loader, filter and prune script,
and keep the rules.
