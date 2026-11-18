# Quarantine a flaky test

Fix at the root when you can. If causality is unclear, rerun the failing test once at the same SHA:
a repeated failure is real.

## A flake blocks at most once

A flake is a test that failed and passed on code it cannot tell apart. The ledger proves it one of
three ways:

- **rerun**: a later attempt of the same job, on the same commit, passed;
- **same commit**: another main run of that commit ran the test and passed it;
- **unreachable diff**: the nearest main run before or after that ran and passed it is on a commit
  whose diff from the failing one cannot reach the test, as `ci-changes.mjs` selects tests.

```sh
git fetch origin main
node .github/scripts/ci-flake-ledger.mjs --runs 100   # or --days 14 --runs 1000; --json
```

It is read-only (`gh` with actions:read). It reads the log of every failed job, every attempt, each
run's plan artifact and main's first-parent history; 100 runs take about two minutes. "Failures
without flake evidence" may be regressions or unproven flakes: they never qualify.

The rule: the first proven flake of a test on main is quarantined the same day, from its ledger
entry. Waiting for a second would let it block twice. Map the entry as follows: `file` and `name`
as the ledger prints them, `status: "quarantined"`, `firstSeen` the proven failure's time,
`deadline` at most seven days later, `sha` its full failing SHA, and `evidence` the failing job,
the passing evidence, a reproduction and acceptance criteria. A quarantine is never renewed:
when it expires, lint fails until the test is fixed at the root or deleted. A whole-file failure
(the ledger prints no title) and a non-Vitest failure cannot be quarantined; fix them.

## Record a quarantine

Add an entry to [tests/quarantine.json](../../../../tests/quarantine.json) per the schema in
[quarantine.ts](../../../../scripts/quarantine.ts): exact `file` and `name` title path, `area`,
`owner`, `status`, `firstSeen`, a `deadline` within seven days, `sha` and `evidence` (include
reproduction and acceptance criteria). `quarantined` needs a full failing SHA and nonblank
reason/evidence. It skips only that exact case in the shared Vitest runner, before fixture hooks,
and prints the owner, deadline and evidence. Other tests still gate merges and releases; the
skipped test remains unverified. Do not edit individual tests to skip them, add retries or
lengthen timeouts.

The runner covers every Vitest lane: unit, integration, real-browser, the Darwin-only files of
native-mac and Windows-real files. It does not cover Go (native-fs and the Windows helpers),
Swift (native-mac), Gradle (android) or the browser extension and web journeys of
browser-journeys.

The deadline must be no later than seven days after `firstSeen`; expiry fails CI, even on an
unchanged scheduled run. A stale or ambiguous title fails when its file is collected. Use
`investigating` or `known-failure` for informational records that keep running; their historical
deadlines do not authorize an exemption. Do not renew a skip on historical rerun evidence.
Review the current test and fixes before activating a record. Remove a resolved entry only with
evidence of the root fix and focused qualification, recorded in the fixing PR.

```sh
pnpm exec prettier --write tests/quarantine.json
pnpm exec vitest run tests/quarantine.test.ts
pnpm exec tsx scripts/quarantine.ts
```
