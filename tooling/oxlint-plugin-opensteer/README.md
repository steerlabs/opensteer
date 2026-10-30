# Test rules

This repository-owned JS plugin loads directly from `.oxlintrc.json`, using oxlint's
ESLint-compatible AST and scope API. It needs no build or workspace package. Its
parser/loader tests run through Vitest in `tests/test-lint-rules.test.ts`.

The test rules cover `*.test.ts(x)`, `*.test-support.ts` and JavaScript/TypeScript
helpers under `tests/`. Suppression reasons apply in every source file. Retry
checks also cover `vitest*.config.*`.

- `opensteer/no-real-time-wait-in-tests`: replace real sleeps with the actual
  event, `vi.waitFor`/`vi.waitUntil` conditions or fake timers. Resolves local
  single-expression wrappers and named/aliased timer imports through lexical scope.
- `opensteer/no-polling-loop-in-tests`: disallow loops containing awaited sleeps.
- `opensteer/no-unreasoned-skip-or-retry`: document skip/todo/fails on the preceding
  line; conditional skipIf/runIf are allowed. Test/suite retries are forbidden;
  configs may specify only `retry: 0`. The integration startup guard already
  enforces zero retries, with regression coverage in `tests/file-poison.test.ts`.
- `opensteer/require-suppression-reason`: end disable comments naming these rules
  with ` -- <reason>`.
- `opensteer/no-unit-test-timeout`: use the default timeout in the default Vitest
  lane. Its lane exclusions come from the same list as Vitest. Real PostgreSQL,
  GUI, engine, device, soak and VM journeys retain their existing budgets.
- `opensteer/no-unbounded-created-promise`: bound directly awaited local promises
  whose resolver escapes their executor, in the same test callback. Use the
  existing `@opensteer/shared/withTimeout` with a useful `timeoutError`. Worker
  callback gates, arbitrary async APIs and cross-function dataflow are outside
  this narrow heuristic. A direct timer in the executor is recognized only when its callback settles that
  promise through the resolver or rejecter binding; passing
  the promise to `withTimeout` or `Promise.race` is not a direct unbounded await.

## Migrating the baseline

`baseline.json` records per-file occurrence budgets keyed by rule and exact source
hash. Editing a violation, adding another occurrence, or moving it to another file
requires a fix. There is no command to accept new debt. `pnpm lint` compares the
baseline against the merge base with `origin/main` and rejects growth. The initial
introducing PR is the only case with no prior baseline. Fetch origin before lint.

After migrating files, run:

```sh
node tooling/oxlint-plugin-opensteer/baseline.mjs --prune
```

This measures with an empty baseline and only removes allowances; it refuses to
add new ones. Run each touched test and the changed-file checks before pushing.
The final migration deletes the JSON, baseline loader/filter, prune script and
lint prefix. Keep the rules and parser tests.

The initial scan found 109 default-lane per-test timeout overrides. Forbidding new
unit overrides is smaller than imposing a universal ceiling across real stacks,
whose existing config budgets range from 30 seconds to hours. No config timeout
was raised. The narrow promise rule catches both Home viewer capture waits while
excluding gates awaited by nested worker callbacks; it is intentionally not a
claim to detect every possible unbounded wait.
