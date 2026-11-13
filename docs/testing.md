# Testing

[AGENTS.md](../AGENTS.md#verifying) holds the test rules; this file holds the traps behind them.
Procedures are in the [testing skill](../.agents/skills/testing/SKILL.md) and, for anything that
drives a screen, the [mac-gui skill](../.agents/skills/mac-gui/SKILL.md).

## How to test

Import-based selection misses IPC, subprocess entry points, SQL and copied assets; choose a
focused journey across any boundary you change. Empty selections and skipped, blocked or
`NOT-AUTOMATABLE` cases are not passing evidence.

## Selecting checks

Import selection misses runtime reads and launches. Declare those in the native task's
[extra inputs](../.github/scripts/ci-native-mac.json). CI inventories and the merged lock graph
must fail closed when incomplete or inconsistent. Selection and scheduling live in
[local-check.mjs](../.github/scripts/local-check.mjs) and
[ci-changes.mjs](../.github/scripts/ci-changes.mjs); procedures belong in the testing skill.

## Suites

Default Vitest discovery excludes the integration, GUI, engine, device, soak and VM suffixes; use
the matching root config or launcher. Direct `pnpm exec vitest` skips the native builds
`pnpm test` runs first. Browser journeys need Playwright's pinned Chromium: installed Chrome is no
substitute, and a missing one fails. Real Chromium suites are classified by the shared
[`realBrowserTests` list](../.github/scripts/ci-test-files.mjs), excluded from default discovery,
and run by `pnpm test:browser` in the existing Linux browser-journeys job. Their process startup
and cleanup have a separate budget; explicit scenario and operation deadlines still apply.

## Integration databases

Integration requires isolated `forks` and `retry: 0`; global setup rejects anything else before
touching a database. Tests own immutable database clones, register cleanup before asynchronous
startup, stop producers before dropping databases and respect cancellation. Never replace
isolation with a shared TRUNCATE. Templates hold baseline schema, never a Deployment or Account identity. Personal fixtures seed
one owner, hosting computer and agent home; team fixtures seed team access state and membership.
Do not turn a personal fixture into a multi-person Host. See the
[personal fixture](../packages/database/src/personal-fixture.test-support.ts) and
[team fixture](../packages/database/src/team-fixture.test-support.ts).

An unexpected timeout, aborted signal or unproved cleanup poisons the rest of that file: later
tests fail with `worker contaminated by <test>: <original error>`. Diagnose the first failure.
Poison does not cross files ([file-poison.test.ts](../tests/file-poison.test.ts)).

[test-integration.ts](../scripts/test-integration.ts) builds prerequisites while it holds the
checkout's outputs, so a pnpm lifecycle hook would build too early; bypassing its bundle manifests
tests stale code. Caller-owned PostgreSQL needs both `OPENSTEER_TEST_DATABASE_URL` and
`OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL`, with permission to create databases.
The fresh baseline contains both Deployment kinds in one lineage. Databases from before that baseline
are refused; forward migrations preserve its lineage. Test Start fresh with disposable supervisor
fixtures or a VM, never a real install.
Migration-compatibility evidence from the previous lineage cannot qualify this baseline.

### Lock-order modes

CI's integration shards run `OPENSTEER_LOCK_ORDER_MODE=enforce`. The local default, `off`, still
fails on deadlocks and serialization failures; `record` is diagnostic only. Neither substitutes
for enforcing evidence. Team access/content races must prove the commit fence and revocation
after the removal command returns; the personal event fence precedes personal domain locks
([lockOrderMode.ts](../packages/shared/src/lockOrderMode.ts)).

## Same-SHA reruns

[integration-rerun.ts](../scripts/integration-rerun.ts) reruns a complete, unfiltered attempt's
failing files at the same SHA and input contract, and always exits 1: a rerun diagnoses, it never
qualifies a merge or release. A different SHA or a skipped case proves nothing about the original
failure.

## Known flaky tests

Fix failures at the root, or quarantine with a reason in
[tests/quarantine.json](../tests/quarantine.json), the current inventory with owners and
fix-or-delete deadlines at most seven days out. It never exempts a test or authorizes a passing
gate. Closed-flake history stays in the fixing PRs.

## Fixtures and evidence

Fixtures compose production code and own their state, faults and observation; observers must not
change what they measure. Runner readiness must come from the authenticated new boot's committed
catalogs. Own each child before readiness, and join unready startup before teardown. Order through
acknowledgements and shared domain clocks, never CPU stress or longer timeouts; real deadlines
stay real. Never drain recurring work until idle; timestamps and committed rows alone do not prove
a producer finished. Coding harnesses probe new listeners with GETs and TLS handshakes: the [probe
helpers](../packages/shared/src/serverProbes.test-support.ts) exclude only identified foreign
traffic, so unexpected requests on owned paths still fail.

## Agent context budget

[agent-context-budget.test.ts](../tests/agent-context-budget.test.ts) snapshots
Opensteer-controlled UTF-8 bytes, not tokens. Its workflow never fails a PR for growth: behavioral
evals judge whether a tool earns its place.

## Agent tool-use evaluations

Real-engine evals spend local subscription capacity and run by hand, outside `pnpm check`. Native
tools execute for real inside the driver's own sandbox, as on a macOS Runner; the disposable HOME
is not filesystem isolation and macOS cannot nest another Seatbelt profile, so cases never point
at host files. Approvals are never granted. See
[evals/agent-tools](../evals/agent-tools/README.md).

## GUI test VMs

The host screen belongs to the founder. GUI and Electron checks run only in private clones of
stopped goldens through [test-vm.ts](../scripts/test-vm.ts), after merge or on demand, never as a
pre-merge gate; never boot a golden. Apple's licence allows two macOS guests at once, counting
other tools' guests. Never touch slot lock files while runners live. Admission needs 40 GiB free;
work stops below 30 GiB. After SIGKILL or power loss, the job record names the only clone you may
clean up. Native seeds (`OPENSTEER_VM_NATIVE_RESOURCES`) must be validated release resources,
never an installed app. [Retention](../scripts/storage-retention.ts) keeps anything live, locked
or of unknown ownership and never touches goldens or the installed app.

Goldens keep `admin/admin`, disabled SIP and SSH permission grants: never publish a VM, its key or
a login endpoint. One SSH key opens every golden; keep its pair. Only a cold boot with real input,
capture or simulator proof certifies a golden, and simulator proof never qualifies the app.

## Persistent guest journey protocol

On a persistent credential-free guest, [the runner](../apps/desktop/scripts/run-macos-journeys.ts)
needs a clean preflight at the exact run ID and full HEAD SHA, and a postflight even after
failure. Quarantine or reset a guest that cannot certify clean state. `mac-owner` needs the legacy
job layout and stays out of default sweeps.

Only validated ownership records
([journey-isolation.ts](../apps/desktop/scripts/journey-isolation.ts)) authorize cleanup:
registered roots and keychain services, and process-group leaders that still match. Prefix
matches, command lines, reused PIDs, orphan groups and unregistered `/tmp/oj-*` roots are residue,
not authority. Listeners count by process ownership, not ports. Crash reports are read-only
evidence; export success never stands in for journey results.
