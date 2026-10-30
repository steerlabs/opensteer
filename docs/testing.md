# Testing

## How to test

Follow [AGENTS.md](../AGENTS.md#verifying) for test design and landing rules.
Import-based selection misses IPC, subprocess entry points, SQL and copied assets;
choose a focused journey across any boundary you change. Empty selections and
skipped, blocked or `NOT-AUTOMATABLE` cases are not passing evidence.

## Selecting checks

`pnpm check:changed --base origin/main` checks changed-file formatting and lint,
typechecks owners and reverse dependents, and runs changed tests and basename
siblings. It includes committed, staged, unstaged and untracked changes. A global
or unknown input widens local typecheck only; builds and full suites belong to
GitHub `Check`. Use `--dry-run` to inspect selection. See
[scripts/check-changed.ts](../scripts/check-changed.ts).

CI shard discovery and execution inventories must have an exact union with
pairwise disjoint membership. Missing or corrupt evidence fails Check.
Integration shards must trace every executed file in enforcing lock graphs;
the merged graph must be acyclic. Darwin-only files leave Linux shards and need
native-mac inventory coverage. Keep native inputs complete, including repository
files tests read or launch; regenerate them with `scripts/ci-native-inputs.ts`.
See [.github/scripts](../.github/scripts) and [.github/workflows/ci.yml](../.github/workflows/ci.yml).

Shard weights come from green hosted runs. Re-measure job timeouts after changing
shards or job contents; failed runs count and cancellations/timeouts are lower
bounds. See `scripts/ci-durations.ts` and `scripts/ci-timeouts.ts`. Main's full
public lanes are never cancelled by a newer push. Scheduled/manual runs require
all native tasks; a skipped task cannot qualify them.

## Suites

Default Vitest discovery excludes integration, GUI and VM suffixes. Use the
matching config/launcher, rather than treating a default-suite pass as coverage.
See [vitest.config.ts](../vitest.config.ts) and the other root Vitest configs.
Direct `pnpm exec vitest` skips the native builds in `pnpm test`.
Browser journeys require Playwright's pinned Chromium: installed Chrome is not a
substitute, and a missing engine must fail rather than skip.

## Integration databases

Integration requires isolated `forks` and `retry: 0`; global setup rejects unsafe
configuration before database access. Tests own immutable database clones and
must register cleanup before asynchronous startup, stop producers before dropping
databases, and respect cancellation. Never replace isolation with shared TRUNCATE.
See [vitest.integration.config.ts](../vitest.integration.config.ts) and
[database test support](../packages/database/src/test-database.test-support.ts).

An unexpected timeout, aborted signal or unproved cleanup poisons the current
Vitest file. Later tests fail before fixtures with
`worker contaminated by <test>: <original error>`; diagnose the first failure,
not each downstream case. Poison does not carry to another file. Expected-failure
timeout tests may continue after a proved drain, but unproved database cleanup
still poisons them. See [tests/file-poison.test.ts](../tests/file-poison.test.ts).

Caller-owned PostgreSQL requires both `OPENSTEER_TEST_DATABASE_URL` and
`OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL`, with permission to create databases.
The launcher owns its clones/templates, never those servers. See
[scripts/test-integration.ts](../scripts/test-integration.ts) and the
[debugging skill](../.agents/skills/debug-integration-tests/SKILL.md).

### Lock-order modes

Full integration runs enforce lock order. `record` is diagnostic only; `off`
disables instrumentation but still rejects deadlocks and serialization failures.
Neither substitutes for enforcing evidence. CI checks the union of shard edges,
since separate acyclic shards can form a cycle together. See
[lockOrderMode.ts](../packages/shared/src/lockOrderMode.ts).

## Same-SHA reruns

A rerun diagnoses a failure; it cannot qualify a merge or release.
`scripts/integration-rerun.ts` accepts a complete unfiltered integration attempt,
reruns failing files at the same SHA/tree/toolchain/input contract, and always
exits 1, even when failures disappear. A different SHA or skipped case proves
nothing about the original failure. Use the
[debugging skill](../.agents/skills/debug-integration-tests/SKILL.md).

## Known flaky tests

Fix failures at the root, or record a quarantine with a reason in
[tests/quarantine.json](../tests/quarantine.json). That register is the current
inventory, including owners and seven-day fix-or-delete deadlines; it never
exempts a test or authorizes a passing gate. Keep closed-flake history in the
fixing PRs. Use the [quarantine skill](../.agents/skills/quarantine-test/SKILL.md).

## Fixtures and evidence

Fixtures compose production startup, transport, supervisor and client code;
they own temporary state, input, faults and observation. Observers must not change
what they measure. Runner readiness must belong to the authenticated new boot's
committed catalogs, never a discarded write or previous boot. Own each child
before readiness and join unready startup before Host/database teardown.

Control ordering through acknowledgements and domain clocks, not CPU stress or
larger timeouts. Transport, process and browser deadlines stay real. Share domain
time across participants; observe settlement before advancing and await the active
cleanup pass afterward. Never drain recurring work until idle. Cross-channel
timestamps and committed rows alone do not prove producer completion.

Local tooling probes new listeners with GETs and TLS handshakes. Use
[shared server probe helpers](../packages/shared/src/serverProbes.test-support.ts)
to exclude only positively identified foreign traffic; unexpected requests on owned
paths must still fail. Inject a probe within a no-traffic assertion's observation
window. Idle or partial TCP peers must not disappear from connection counts.

Report commands and results. Retain SHA, executed checks and artifacts outside
the checkout when a founder or release check consumes the journey; diagnostic
output alone does not require artifacts for every change.

## GUI test VMs

The host screen belongs to the founder. Follow [AGENTS.md](../AGENTS.md#verifying)
for VM-only GUI execution and process ownership. Reuse one journey per native
flow. VM runs are post-merge or on demand, never a pre-merge gate.
See [VM constraints and operation](../scripts/test-vm/README.md).

Signed desktop updates for stable and Beta are proven by
`pnpm exec tsx scripts/public-download/eu-run.ts /absolute/prepared-inputs`,
which runs the GitHub-provider journeys in fresh clones. Set
`OPENSTEER_UPDATE_JOURNEY_DIR` to an absolute work directory; see
[build preparation and evidence](../scripts/public-download/README.md).

## Agent context budget

[tests/agent-context-budget.test.ts](../tests/agent-context-budget.test.ts) measures
Opensteer-controlled UTF-8 bytes, not provider tokens or complete prompts.
Intentional surface changes require snapshot review, including savings.
The [budget workflow](../.github/workflows/agent-context-budget.yml) rejects
increases and removed/renamed keys against main; `agent-context-increase` permits
reviewed increases but does not bypass the snapshot test.

## Agent tool-use evaluations

Real-engine evals consume local subscription capacity and run manually, outside
`pnpm check`. Native tools execute for real: disposable HOME/profile state is not
host filesystem isolation. macOS cannot nest Seatbelt profiles; cases must never
point at host files. Product mutations use a fake Host after production MCP/Zod
validation. Approval requests are never granted.

Baselines require matching engine/version, model, effort, corpus fingerprints and
complete samples; prompt/skill/schema hashes may differ as treatment. Without a
baseline, behavioral failures are report data, not infrastructure failures.
See [evals/agent-tools](../evals/agent-tools) and the
[eval skill](../.agents/skills/run-agent-evals/SKILL.md).

## Persistent guest journey protocol

The credential-free guest protocol in
[the journey runner](../apps/desktop/scripts/test-macos-journeys.sh) requires
clean preflight at the exact run ID and full HEAD SHA, then postflight even after
failure or interruption. Quarantine/reset a guest that cannot certify clean state.
The on-demand `mac-owner` case requires the registered legacy job layout and is
excluded from default sweeps.

Only validated ownership records authorize cleanup: exact registered filesystem
roots/keychain services and still-matching process-group leaders. Prefix matches,
command-line paths, reused PIDs and unverifiable orphan groups are residue, not
authority. Symlinked ancestors are refused except `/tmp` → `/private/tmp`.
Unregistered `/tmp/oj-*` roots remain residue. Short registered temporary roots
avoid macOS Unix-socket path limits; caches remain outside cleanup roots.

Listeners count by process ownership, not reserved ports. Unrelated system
listeners are information, not leaks. Crash reports are read-only evidence and
never authorize cleanup. Export success, skipped cases and simulator screenshots
cannot substitute for selected journey results. See the manifests and logs under
the run's explicit output directory.
