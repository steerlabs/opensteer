# Quarantine a flaky test

Fix at the root when you can. If causality is unclear, rerun the failing test once at the same SHA:
a repeated failure is real.

Add an entry to [tests/quarantine.json](../../../../tests/quarantine.json) per the schema in
[quarantine.ts](../../../../scripts/quarantine.ts): exact `file` and `name` title path, `area`,
`owner`, `status`, `firstSeen`, a `deadline` within seven days, `sha` and `evidence` (include
reproduction and acceptance criteria). `quarantined` needs a full failing SHA and nonblank
reason/evidence. It skips only that exact case in the shared Vitest runner, before fixture hooks,
and prints the owner, deadline and evidence. Other tests still gate merges and releases; the
skipped test remains unverified. Do not edit individual tests to skip them, add retries or
lengthen timeouts.

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
