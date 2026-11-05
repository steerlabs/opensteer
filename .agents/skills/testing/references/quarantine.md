# Quarantine a flaky test

Fix at the root when you can. If causality is unclear, rerun the failing test once at the same SHA:
a repeated failure is real.

Add an entry to [tests/quarantine.json](../../../../tests/quarantine.json) per the schema in
[quarantine.ts](../../../../scripts/quarantine.ts): exact `file` and `name` title path, `area`,
`owner`, `status`, `firstSeen`, a `deadline` within seven days, `sha` and `evidence` (include
reproduction and acceptance criteria). `quarantined` needs a full SHA and evidence; otherwise use
`investigating` or `known-failure`. An entry never exempts execution or grants a passing gate.
Remove resolved entries.

```sh
pnpm exec prettier --write tests/quarantine.json
pnpm exec vitest run tests/quarantine.test.ts
```
