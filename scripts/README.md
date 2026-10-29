# Repository scripts

Run `pnpm check:changed --base origin/main` before opening a pull request.
The manifest graph shared with CI selects checks and fails open to full checks
when ownership is unknown. `pnpm check` runs the full local recipe; the required
GitHub `Check` determines whether a pull request can merge.

## Integration databases

[test-integration.ts](test-integration.ts) owns the launcher;
[run-record.ts](run-record.ts) owns its evidence contract.

`pnpm test:migration-compat` provides the SQL/migration compatibility check.
Pass `--baseline <released SHA>` explicitly; tags and deployed state are never consulted.
The chosen baseline must be a strict ancestor of the candidate's `HEAD`.
It uses disposable PostgreSQL without Runner, desktop or native builds.

It checks out that release with `git archive`, installs the database and Account
production dependency closure from its frozen lockfile without lifecycle scripts,
and runs its production migrators through the same
run-owned template lifecycle described below. A clone is seeded by the previous
store with reproducible users, Deployment, Workspace, task/Thread, Run, execution
settings and grant data. Account coverage preserves a verified Account, managed
Deployment and stored portal OAuth client.
Current production migrations have a **30-second wall-clock bound per authority**
and a matching PostgreSQL statement timeout. The previous release's store then
reads the seeded graph and writes users, task names, settings and the Account
client against the upgraded schema. This complements the release pipeline's
prior-reader replay, which checks wire frames rather than database access.

Use `pnpm test:migration-compat --verify-controls` to also prove rejection of a
real migration that renames `users.display_name`, and one that sleeps beyond the
30-second bound. These controls are opt-in acceptance checks; the ordinary
command runs only the two authority upgrades. `--testNamePattern <pattern>` narrows
an affected rerun. Child process groups, clones,
templates, the archived source and the PostgreSQL container are cleaned after
success, failure or cancellation. The ci-local premerge selector owns deciding
when SQL or migrations changed.

`pnpm test:integration [path/to/file.integration.test.ts]` creates a uniquely
named `opensteer-integration-<uuid>` PostgreSQL container for each invocation.
Docker assigns a free port bound to `127.0.0.1`; concurrent runs share neither a
server nor a port. The launcher reads the PostgreSQL image pin from the development
service in [Compose](../deploy/compose/compose.yaml), initializes the Host and
Control Plane databases, and prints the container ID, address and startup time.
Global setup runs the production migrators once to create one uniquely named
Host template and one Control Plane/Account template per run. Before cloning, it closes all template connections and disables new ones.
Templates carry schema and migration history without Deployment or Account
identity, plus `pgrowlocks` for row-lock assertions in every lock-order mode.
Worker database pairs, vertical stacks and machine-access fixtures clone them;
Host startup still performs its normal migration check. Empty and historical
startup journeys independently cover real migration work and restart idempotence.
Those journeys close Host and assertion pools, then drop their databases without
`FORCE`: PostgreSQL waits for disconnecting clients and refuses a drop if sessions
remain, avoiding administrative termination errors while pool sockets close.

Holding its checkout's build outputs, the launcher builds the native filesystem
test helper, the recovery Runner integration bundle and the desktop bundles,
including the worker that local Runner startup launches. It snapshots each
bundle's sources and resolution/build configuration before its build, verifies
them afterward, and records the entry and shared chunks in that build's manifest.
Every recovery/desktop test fork validates its own manifest and bytes; missing or
stale evidence fails with the rebuild command. A failed or canceled preparation
invalidates both manifests. Recovery forks use Node with no tsx fallback. Utility
and preparation wrappers retain their existing native Node launches. A pnpm
lifecycle hook would build before that hold.

The PostgreSQL store cases are split across eight files in `packages/database/src`:

- `store-thread-state-and-locking.integration.test.ts`
- `store-request-and-authority.integration.test.ts`
- `store-harness-workspace-trigger.integration.test.ts`
- `store-execution-fences.integration.test.ts`
- `store-execution-input.integration.test.ts`
- `store-results-messaging-history.integration.test.ts`
- `store-runner-and-browser.integration.test.ts`
- `store-grants-sharing-machine.integration.test.ts`

Run the partitions and their isolation regression with
`pnpm test:integration packages/database/src/store-*.integration.test.ts`.
`describeStore` in `store.integration.test-support.ts` gives each test an immutable
database/store/helper bundle; direct store suites use the same clone lifecycle.
Cases start from the migrated template's system principal and Personal singleton,
without shared TRUNCATE or baseline reseeding. Domain setup belongs to the case's
fixture. Parameter matrices use Vitest `it.for` for the test-local bundle without
changing rows or assertions.

Store lock-race barriers observe the intended lock set, not a backend PID across
transaction retries: a retry can acquire another pooled connection. The
integration-resolution/withdrawal regression forces that handoff with single-use
connections while holding the new origin until the expanded lock query waits.

To measure fixture preparation, set `OPENSTEER_STORE_SETUP_TIMINGS` to an absolute
JSONL path. Each sample records the file, test name and setup milliseconds; the
file's ordinary Vitest duration includes body and cleanup as well. Compare the
same files and worker count.

The launcher removes only its own container and temporary database storage after
success, failure or `SIGINT`, `SIGTERM` and `SIGHUP`, including interruptions
during startup. Test subprocesses are canceled before container cleanup. Compose
is used by `pnpm setup:local` for the development database, independently of tests.

To supply caller-owned PostgreSQL servers, set both
`OPENSTEER_TEST_DATABASE_URL` and `OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL`.
Setting only one is an error. The launcher does not invoke Docker or stop those
servers; global setup still owns and drops its templates, worker databases and
fixture clones. The same launcher serves `test:engines`, `test:agent-phone` and
`test:agent-phone:soak`.

Clone handles are immutable and never rebound to another test's database.
Fixtures register `onTestFinished` cleanup before async startup, including for
timeouts, and consult `context.signal` around owned async work. Cleanup stops
producers, fences new database connections, drains sessions for a bounded time,
terminates remaining sessions and uses `DROP DATABASE ... WITH (FORCE)`, then
checks that both database and sessions are gone. Only files acquiring a database
clone or producer register timeout containment, including suite-owned databases
allocated in `beforeAll`; ordinary unit/browser tests do not.
An unexpected timeout or aborted signal, or unproved cleanup, poisons the current
Vitest file object. Expected-failure timeout tests may continue after their own
drain; an unproved database cleanup still poisons them. Poison never carries to
another file when Vitest reuses a worker. Cleanup handlers capture the test name
and original failure before a dynamic `context.skip()` can discard its result.
Every later test fails in the first `beforeEach`, before touching its fixture,
with `worker contaminated by <test>: <original error>`. The file finishes normally
so Vitest preserves the original failure and all later results. Normal completion
drops its clones without poisoning the file. Integration requires isolated `forks`
and `retry: 0`; global setup rejects unsafe configuration before database access.
The global setup's run-owned manifest recovers clones after process failure.
Runner children enter their own process groups and register ownership at fork,
before readiness. Teardown attempts bounded graceful shutdown, then TERM/KILL
and verifies group disappearance and child exit during cleanup. Preparation engines
also carry the child boot's execution marker; cleanup uses the production reaper
to prove detached engine groups gone before closing the Host. Each child stop
reaps only its own boot, so closing a crashed owner cannot signal its replacement.
The local group helper also bounds the final reap wait. Clone allocation completes before service
startup; a failed CREATE releases its admin connection and propagates the original error.

`SIGKILL`, power loss and host crashes cannot execute cleanup. If a run dies that
way, use its printed ID to remove only that run's container with
`docker rm --force --volumes <container-id>` before retrying.

If those builds leave an output the suite drives missing, the launcher stops
before starting a database; the [list](test-integration.ts) names
each output and its build. Each failure prints as it happens with its
time and the run's elapsed time; the summary still follows. `pnpm
test:integration --preflight [files]` stops at the first failure (`--bail=1`)
and records its outcome under `~/.local/state/opensteer/check-diagnostics/<sha>/`;
it never reads or writes proof. The unit and integration suites keep Vitest's
results under `~/.cache/opensteer/vitest/`, so every checkout runs last-failed,
then slowest, files first.

### Lock-order modes

`OPENSTEER_LOCK_ORDER_MODE=enforce` fails on violations. `record` records diagnostics;
`off` disables instrumentation. CI merges shard edges and checks their union.
