# Testing

Work in a small branch and open one pull request per change. GitHub `Check`
is the landing authority.

## How to test

Test what a person would notice breaking, at the cheapest layer that can catch
it: a unit or host test first, a headless browser or PostgreSQL journey when the
behavior crosses those boundaries, and a real macOS GUI journey only when nothing
cheaper can show the bug. Keep one journey per user-facing flow; edge cases
belong in cheaper tests beside the code.

Every test should earn its place: it guards something specific, says what, runs
quickly and isn't a duplicate. A unit test runs in milliseconds, a journey in a
minute or two, and the whole VM set in minutes. If a check is slower, there
should be a reason. Delete duplicate, superseded or never-useful tests freely.
Never drop the only coverage of a past real bug or a security property without
moving it to a cheaper layer. Keep artifacts only for journeys a founder or a
maintainer reads.

## How changes land

Changes land as pull requests on steerlabs/opensteer, squash-merged once the
required `Check` passes; [Landing changes](../AGENTS.md#landing-changes) covers
the steps and who may merge.

## Suites

`pnpm check` runs on the host without a macOS VM. Root Vitest uses a third of
the available cores (rounded down, with a minimum of two workers), leaving room
for the browser and engine subprocesses. Workspace shards prime and dispose an
app-shell mount in `beforeAll`, before any individual case deadline. Ordinary `*.test.ts` and
`*.test.tsx` files include headless Chromium journeys. `*.integration.test.*`
means PostgreSQL and runs only through `pnpm test:integration`;
`*.gui.test.*` means a real macOS GUI session and runs only in the VM through
`test:gui`. `*.vm.test.*` journeys run only inside `pnpm test:vm` with their own
config. Default Vitest discovery excludes all three suffixes. Missing Chromium
fails with its install command; it is never a passing skip.

## Mobile network benchmark

`pnpm bench:mobile-network` runs the production `HttpHostClient` against a real
Host and isolated PostgreSQL through an in-process TCP shaper. It uses the
integration launcher's pinned Docker image, templates, producer ownership and
teardown. No simulator, GUI, browser process or native-helper build is required.
An existing server may be supplied with `OPENSTEER_TEST_DATABASE_URL`; it must
allow database creation. Without a URL or running Docker it exits 2 with
`SKIPPED`, which is not a passing benchmark.

```sh
pnpm bench:mobile-network --profile weak-cell --seed heavy --runs 3 --out /tmp/mobile-network.json
pnpm bench:mobile-network --scenario reconnect --runs 1
```

Defaults select both seeds, all four links and all five scenarios, with three
serial samples. `--profile` accepts `lan`, `4g`, `weak-cell`, `edge`, or `all`;
`--seed` accepts `light`, `heavy`, or `all`. `--scenario` accepts `cold-attach`,
`open-task`, `reconnect`, `foreground-after-30s`, `network-change`, or `all`.
The report defaults under `os.tmpdir()`; `OPENSTEER_MOBILE_BENCH_REPORT` also
selects its path. Partial results survive a failed matrix with `status: failed`.

The client has a fixed resolved route, no local runtime, a stored fixture session,
mobile-style discovery/capability verification, and a driven lifecycle. Storage,
OAuth, React rendering, and native networking are outside this measurement. Heavy
seeds contain 300 mixed-state tasks, 2,000 Chat messages, long tool results and 20
suspended tabs; light seeds contain five tasks, 20 Chat messages and two tabs.
Suspended tabs exercise the real catalog and `placeList` without Chromium.

Cold attach records public-store readiness, including history and `taskList`.
Warm scenarios first attach; requesting one warm scenario excludes unrelated
warm scenarios. Reconnect commits a real task rename during the outage and
requires a nonzero retained cursor, replayed events and no new snapshot.
Foreground waits a real 30 seconds before measuring recovery. The normal refresh
and reconnect timers remain enabled, with reconnect jitter fixed at 0.5.

JSON retains every sample, median milestones, delivered TCP bytes by connection,
sanitized request lines, request concurrency waves, failed request counts, RPC
body bytes, and WebSocket
payload bytes by type. Follow-up traffic is counted until quiet, separately from
user readiness. Request waves describe observed serialization, not a proven
causal graph. HTTP and WebSocket share each direction's configured bandwidth.
Plain HTTP timings exclude TCP handshakes and TLS: the report separately models
one TCP RTT and one additional TLS 1.3 RTT per new connection. These are aggregate
costs, not additive critical-path timings when handshakes overlap. TCP slow
start, congestion, radio behavior and retransmission are not modeled.
`--stall-every 8 --stall-ms 500` adds an occasional queue delay; it is not packet
loss. Keep reports outside the checkout.

`pnpm exec vitest run tests/mobile-network/proxy.test.ts` verifies the shaper and
redaction. The normal PostgreSQL integration suite also runs a light/LAN
structural journey for paged models and cursor recovery, without time budgets.

## Agent context budget

`pnpm exec vitest run tests/agent-context-budget.test.ts` records compact UTF-8
JSON bytes for the production MCP tool lists, initialization instructions, run
guides and common rendered skill indexes for every capability profile. It uses
in-memory MCP exchanges without credentials. Skill paths use the fixed
`/opensteer/skills` prefix so checkout locations do not affect the measurement.
These are Opensteer-controlled bytes, not provider token counts or full prompts.

Both MCP servers compact advertised input schemas at registration, removing
`$schema` and `pattern` and merging a root union of objects into one object,
while retaining the full call validators. Anthropic rejects union input roots
and Claude Code then drops the tool without telling the model. The product
server keeps SDK call handling and overrides only its public `tools/list` handler;
the integration gateway compacts its existing custom list handler.

After an intentional surface change, run the test with `-u` and review
`tests/agent-context-budget.json`. Exact equality requires recording savings too.
The Agent context budget PR workflow compares each metric with current
`origin/main`, rejecting any increase or removed/renamed key. New positive
metrics also need review. The `agent-context-increase` PR label permits those
changes; it does not bypass the snapshot test. Label changes rerun the gate.
The first baseline bootstraps when main does not yet contain the JSON file.

Transcript-link fixtures choose Talk before loading their next document, so
remembered-place restoration cannot replace that fixture's starting surface.
Waiting for transcript text alone does not acknowledge restoration. Their
Back/Forward checks preserve document identity and the exact workspace tabs.
The repaired journey is selected again for relevant web changes.

## Local fake servers

Developer tools probe new localhost listeners with GETs and TLS handshakes. Before
recording traffic, HTTP fakes use `ignoreForeignTestRequest` from
`@opensteer/shared/test-support/serverProbes` with their served paths. It excludes
only GETs outside those paths; wrong methods and unexpected requests on owned
paths still reach the original assertions. Node's HTTP parser rejects TLS before
the request handler. `probeTestServer` injects both probes and acknowledges their
receipt at the parser boundary, without sleeps. `resetTestServer` resets a
TCP peer only after the supplied protocol acknowledgement, then waits for both
ends to close. It never adds an error handler to the server's accepted socket:
the listener owner must handle the reset. The shared machine-access echo fixture
runs this probe on every listener it opens and owns all sockets through teardown.
Raw HTTP handshake fakes use the HTTP parser and count only parsed WebSocket
upgrades on their owned paths. A foreign connection cannot satisfy a handshake
gate; non-upgrade requests on owned paths still fail. The probe also acknowledges
a fixture that rejects a connection before reading it.

When a journey asserts that no requests occurred, inject its retained probe
between the counter snapshot and the assertion, so the check covers foreign
traffic during that interval rather than only during fixture startup.

Counters for plain TCP fixtures use `observeTestConnection` to exclude only a positively
identified GET `/` or TLS prefix. Idle, partial and other peers remain counted.
Before a snapshot, `settleTestConnections` waits for classification or closure,
bounded by the test's own signal. An idle or dropped real connection can never
turn an incorrect late connection into a passing zero assertion.

Container COPY guards use a strict local ignore matcher. Checks exercise the source
upload. Keep SDK startup and network timing out of these guards.

## Known flaky tests

Not every red is about the change. When a failure clearly has nothing to do with
the change or with Opensteer's behavior (environment or tooling noise, or a known
flake in code the change didn't touch), don't rerun it: land, record why in the
run evidence, and send it to the test's owner to fix at the root.

Rerun only when it's genuinely unclear whether the change caused the failure:
once, the failing test only, on the same SHA. A pass there makes it a flake. It
goes into [tests/quarantine.json](../tests/quarantine.json) with an owner and a
seven-day fix-or-delete deadline, and it stops blocking. A failure that repeats
is real and blocks. A pass on another SHA, after a code change or from a skipped
test proves nothing. [scripts/quarantine.ts](../scripts/quarantine.ts) checks the
register's format; an entry never exempts a test by itself.

### Resolved

- [ChromeBackgroundJourney/Journey.swift](../apps/desktop/native/computer-use/Tests/Fixtures/ChromeBackgroundJourney/Journey.swift): R0 Chrome setup `invalid` ("open window that Accessibility cannot read"); closed 2026-10-28; fix `4be789814`, red `a5205b0a5`. The helper gave a running app's on-Space window only the 2 s hide/Space-move bound while Chrome's Accessibility was still starting; such a window now gets the request's timeout. Evidence: post-merge macos-journeys-typing at `283c39a4a` (VM run 20261028T230629Z-4fa98397, R0 ×5, no `invalid` rows).

- `transcript-links-journey.ts`: HTTP from Talk and linked-image history checks; closed 2026-10-28; fix `7c7816e2c`. Stale Talk setup let remembered New tab replace the current history entry, so Back left the document and reset the mock. Same-document and exact-tab assertions now guard history.
- `transcript-links-journey.ts`: phone-width HTTPS; closed 2026-10-28; fix `7c7816e2c`. Remembered Work hid the transcript behind the phone sheet; the fixture now selects Talk through its current control before reload and waits for Talk. All 12 journey checks pass. All three registered failures were fixture preconditions; no product link/history defect was demonstrated.

- Credential proxy, PortableFS Manager client, auxiliary-stream, browser CDP relay, Runner handshake shutdown and OpenCode fake listeners: closed 2026-10-28; fix `dc1d14761`; foreign GET/TLS probes remain in the fixtures.

- [egress-proxy.test.ts](../apps/browser-runtime/src/egress-proxy.test.ts): delayed resolution after close; closed 2026-10-28; fix `48884b5a0`, red `9d997bedd`.

- `integration-schemas.integration.test.ts` (large API) and `watch-supervisor.test.ts` (stale artifacts): closed 2026-10-28 by the shared HTTP fixture path filter in this change; red reproduction `8fcd16dd0`.

- `computer-repl.test.ts`: image budgets and producer-message limits; closed 2026-10-28; fixes `074a72c17`, `89388e4f4`, `c92fdee76`, `04fa64da3`.
- `harness-actions-input-lifecycle.test.ts` A13-dialog-closes-during-exit: closed 2026-10-28; fix `9ec07ab02`; cross-channel timestamps replaced by acknowledged causal phases, with all grace and cleanup bounds retained.
- `apps/runner/src/runtime/runtime.test.ts`: interrupts the active harness turn without detaching the workspace; closed 2026-10-28; fix `ff00efbc2`, landed `0d295e69f`.
- `packages/runner-client/src/auxiliary-stream.test.ts`: exposes only the Passwords capabilities opted into by this welcome; closed 2026-10-28; fix `94e2e5c33`, landed `18c5103ad`.
- `packages/harness-codex/src/process.test.ts`: attaches a bounded redacted stderr diagnostic to a timed-out request; closed 2026-10-28; fix `2eb6ed588`, landed `18c5103ad`.

- `machine-access-warm.integration.test.ts`: Run handover counters; closed 2026-10-28 by admitting parsed shell WebSocket upgrades before holding/counting; fix `b0818852c`; red regression `f9bdc9597`. The saved failure already counted the old Run closed; an extra foreign connection polluted the counters.

## Selecting checks

`pnpm check:changed --base origin/main` uses the same manifest graph as CI.
It includes committed, staged, unstaged and untracked changes, checks formatting
and lint for changed files, typechecks owning workspaces and reverse dependents,
and runs changed tests and basename siblings. A global or unknown input makes CI
run everything; locally it only widens typecheck to every workspace and prints
why. Builds and full suites stay with GitHub `Check`. `--dry-run` prints the plan
without running checks.
Non-manifest generators and build consumers select conservative coverage.

`pnpm check` always runs the full developer recipe without issuing qualification
receipts. GitHub `Check` is the landing authority. CI uses duration-balanced
default-test and integration shards; counts live in
[ci-shards.json](../.github/scripts/ci-shards.json), and recorded file durations
come from a green hosted CI run: download its `tests-*` and `integration-*`
artifacts and run `pnpm exec tsx scripts/ci-durations.ts <directory>`. New files
receive a small default weight. Each job's `timeout-minutes` is 1.5 times its
slowest measured run in the current layout, at least 3:
`pnpm exec tsx scripts/ci-timeouts.ts <run id>...` prints them, counting failed
runs, and cancelled or timed-out ones as lower bounds. Re-measure after changing
shards or job contents. Every shard uploads discovery and execution
inventories; Check requires their exact union and pairwise disjoint membership. Integration
shards also upload enforcing lock graphs, merged through the global cycle check;
each shard's graph must trace every file that shard ran. Tests that need Darwin
(`darwinOnlyTests` in
[ci-test-files.mjs](../.github/scripts/ci-test-files.mjs)) leave the Linux shards
and run in the native-mac matrix with their own discovery and execution inventory.
The native lane separates helper builds, Swift packages, and native wire checks:
one job per task in [ci-native-mac.json](../.github/scripts/ci-native-mac.json).
Each task, including `iphone` with the Darwin-only files, runs only when one of its
inputs changes: its Swift packages, the CI definition, what its node scripts and
Vitest files import (including files loaded through `createRequire`), or a file its
tests read. `ci-native-inputs.json` lists those
imports (whole workspace packages), `pnpm exec tsx scripts/ci-native-inputs.ts`
regenerates it, and `tests/ci-native-inputs.test.ts` fails when it is stale or when
a Swift test names a repository file its task does not list. The `iphone` task's
Vitest runs load [ci-access-trace.mjs](../.github/scripts/ci-access-trace.mjs), and
[ci-native-access.mjs](../.github/scripts/ci-native-access.mjs) fails the task when
they read, list or launch a tracked file it does not list. A root
`tests/*.test.ts` edit selects its own lane, the repo-wide test guards in `tests`
and `build-types`; other files under `tests/` stay global inputs. A main push runs
every other lane and picks its macOS tasks from its one commit. Every four hours, a
scheduled run takes every task if main changed since the last scheduled or manual
run; manual runs always do, and Check refuses a skipped task in either.
Integration shards run `pnpm test:integration` with its own tmpfs PostgreSQL, as
local runs do. Browser journeys that accept `OPENSTEER_CHROMIUM_EXECUTABLE` get
the pinned Playwright Chromium there, never the runner image's browsers. Missing or
corrupt evidence fails Check. Main runs every public lane and is never cancelled
by a newer main push. GUI, device and account suites require their separate
environments.

Tabs profile filtering is covered by `pnpm --filter @opensteer/web
test:tab-profile-filter` (headless Chromium and the mock Host). Its repeatable
`result.json` and sidebar screenshots live under
`OPENSTEER_TAB_PROFILE_FILTER_EVIDENCE_DIR`; it covers exact identities, counts,
Guest, mixed-profile groups, global search, filtered reordering, last-tab removal
and the narrow drawer.

```sh
pnpm exec vitest run path/to/file.test.ts
pnpm exec vitest related path/to/source.ts --run --passWithNoTests=false
pnpm exec vitest run --changed=<merge-base-sha>
```

`pnpm exec vitest` skips the native-helper builds that `pnpm test` runs; build
the helper first when a test needs it. Bare `--changed` covers only uncommitted
files. Import-based selection misses IPC, subprocess entry points, SQL and copied
assets. When you change code behind such a boundary, run the journey or
integration file that crosses it; the subsystem doc and the tests beside the code
name them. `pnpm check:changed --dry-run` shows the local plan. An
empty selection or skipped tests are not evidence.

Browser history and hard reload use the same headless Chromium engine setup:
`pnpm exec vitest run apps/browser-runtime/src/browser/navigation.test.ts`.
`OPENSTEER_NAVIGATION_EVIDENCE_DIR` receives JSON traces for negotiated and old-Host
sessions. `pnpm --filter @opensteer/web test:browser-navigation` records toolbar
availability and the web's untouched reserved chords as screenshots and JSON under
`OPENSTEER_NAVIGATION_WEB_EVIDENCE_DIR`. Host boundary coverage lives in
`browser-service.test.ts` and `browser-route.integration.test.ts`. Desktop key and
menu delivery need the real preload bridge, so they belong to the native-browser
VM journey.

Browser journeys require the Chromium revision pinned by Playwright. `pnpm setup:local`
installs it; for tests without local services, run `pnpm exec playwright-core install chromium`.
Tests fail with that install command when the pinned build is absent; they never fall
back to installed Chrome or an executable override. Production browser selection is
unchanged. Native Clipboard API image writes can re-encode PNGs in other browser
builds, so the exact PNG paste assertion runs against the shipped, pinned engine.
Run the journey with `pnpm exec vitest run apps/browser-runtime/src/browser/favicon.test.ts`. It writes decoded
PNG evidence and `journey.json` under `OPENSTEER_FAVICON_EVIDENCE_DIR`, defaulting to
`opensteer-favicons` in the system temporary directory.

Browser Harness element actions (hosted Chromium) run with
`pnpm exec vitest run apps/browser-runtime/src/browser/harness-actions*.test.ts`.
Use the Chromium selection above. Each acceptance case writes `result.json` and
`page.png` under `OPENSTEER_HARNESS_ACTIONS_EVIDENCE_DIR` (default:
`opensteer-harness-actions` in the system temporary directory), including harness
hashes, Chromium version, scripts, page-state oracles and an exact rerun command.
`-t 'fixture baseline'` selects the legacy misclick and real React negative controls.

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

`pnpm test:integration [file]` uses disposable PostgreSQL. Launcher, database and run-record details live in
[the scripts README](../scripts/README.md#integration-databases).

### Lock-order modes

See [integration lock-order modes](../scripts/README.md#lock-order-modes).

## Same-SHA reruns

See [run records and same-SHA diagnostics](../scripts/README.md#same-sha-reruns)
and the [flaky-test policy](#known-flaky-tests).

## Fixtures and evidence

E2E fixtures compose the production startup, transport, supervisor and client
code; they own only temporary state, inputs, fault injection and observation.
Runner startup and restart barriers require the authenticated new boot's own
committed ready catalogs on one authenticated connection, including captures
after preparation; discarded catalog writes and a previous boot's ready answer cannot satisfy
them (the first startup may settle as sign-in-required before fixture sign-in).
The recovery child acknowledges readiness only after authentication and the
parent's boot-specific catalog commit acknowledgement. Fixtures own each Runner
boot before readiness and stop and join unready startup before Host/database teardown.
An observer must never change the behavior it records. Before a broad run,
run one healthy case; stop the run when unrelated cases fail in shared setup.

Lease journeys share one execution clock across the Host, store, Runner and its
heartbeat timestamps. Request, socket and test deadlines retain real time. Advance
only after observing the required disconnect, journal settlement or other effect;
then await the active cleanup pass before the next bounded step. Never drain recurring
work until idle. A completed offline turn must settle its terminal journal before
aging, and watchdog outages must settle `lease-lost` before the Host restarts.
Grant-refresh journeys use the existing capability clock and observe credential
replacement before the next advance. Their artifacts record domain milestones
alongside the original outcome and exactly-once assertions.

Load-sensitive fixture ordering must be controlled without CPU stress or larger
timeouts. The mobile Tabs interaction journey gives the preview a manually
advanced clock: asynchronous render turns drain zero-delay work without spending
the picture hold. The helper-install lock journey registers child exit promises
at spawn, then gates the refused child's output until after exit to prove a slow
reader cannot miss it. Run these files individually with `pnpm exec vitest run`
for these fixture changes; neither starts a GUI or needs native-helper builds.

The Go forwarding fixtures acknowledge their target only after reading `ping`;
foreign GETs and TLS handshakes are closed before that gate. Their simulator
sends both first. The OpenSSH policy test owns a 15-second context deadline for
its socket I/O and SSH children, so a stalled fixture fails with its own message
instead of consuming the package timeout. Existing five-second listener polls
and forwarding, refusal and cleanup assertions retain their bounds.

Report the commands and results. For a journey consumed by a founder or release
check, keep its source SHA, executed checks and required artifacts outside the
checkout. Scripts may emit diagnostic files by default; that does not require a
new artifact for each change. Confirm selected cases ran and passed. Skipped,
blocked and `NOT-AUTOMATABLE` are not passes.

## GUI test VMs

Only checks that drive the real screen, keyboard, windows or Electron need a
macOS VM; they never run on the host screen, which belongs to the founder. Logic
around them, including Swift, runs on the host. The VM set is a few journeys,
one per native flow that needs a real GUI, run together in one boot by
[test-macos-journeys.sh](../apps/desktop/scripts/test-macos-journeys.sh), after
merge or on demand. Reproduce at a cheaper layer first when possible; extend an
existing journey unless a new native flow needs its own. Each VM run costs minutes.
`--mobile` selects the Xcode golden needed by the journeys' live XCTests.

```sh
pnpm test:vm -- --mobile bash scripts/test-macos-journeys.sh
```

See [VM operation, payloads and goldens](../scripts/test-vm/README.md).

### Shared streamed editing

Run `pnpm --filter @opensteer/web exec tsx scripts/remote-editing-journey.ts` for the real
browser viewport, reducer, editing transport and mock Host in Chromium, Firefox and WebKit. It keeps
JSON, screenshots and Playwright traces under `OPENSTEER_EDITING_WEB_EVIDENCE_DIR` (default
`/tmp/opensteer-editing-web`). These are browser automation journeys, not native IME certification.
For a real Host/runtime, supply `OPENSTEER_EDITING_HOST_URL`, `OPENSTEER_EDITING_SESSION_ID` and
`OPENSTEER_EDITING_SURFACE_ID` for a disposable session with one page; an optional
`OPENSTEER_EDITING_STORAGE_STATE` names caller-owned authentication state. The journey replaces that
page with its editing fixture and verifies its actual value through the authorized CDP path.

Native desktop clipboard and menu shortcuts are the `remote-input` VM journey, which runs
`scripts/test-viewer-clipboard.sh`. Its `--editing-v2` mode focuses on Personal editing (v1
baseline projection, v2 editing without an engine clipboard, and keyboard/menu Cut from a PC
viewer); Personal ships no native clipboard addon. The smoke builds its fixture inside the guest,
uses the production preload and main handlers, and posts macOS shortcuts through System Events.
The second smoke uses the production HttpHostClient and browser viewport with a real non-editing
Electron Runtime. Its RPC inventory is a fixture; the Host integration journey above covers the
authenticated relay. It verifies keydown-owned typing, ⌘A, ⌘Z, ⌘←, ⌘⌫ and copy through the native port.
Evidence lives under the VM job's `guest/viewer-clipboard/` and `guest/baseline-viewer/`. Missing OS automation permission is a
failed native check. The native recorder in
`apps/web/src/components/remote-editing/native-trace.cjs` also runs only in the VM; its JSON event
fixtures are replayed by `packages/client/src/editing/native-traces.test.ts`. Missing fixtures are a
failure, never a synthetic native-trace pass.

## Domain time in integration journeys

The Browser Harness dialog-exit journey acknowledges both its held CDP release
and the harness waiting notice before the person answers. Its journal checks
dialog close, release reply, detach and exit in that order; timestamps from the
WebSocket and stderr channels remain diagnostics, not causal evidence. Existing
grace and duration bounds still apply.

Keep transport, process and browser deadlines on real time. `BrowserService.activityClock`
controls only agent activity timestamps and expiry scheduling; production uses
`systemClock`. The page-chip journey in `tests/browser-sessions-context.integration.test.ts`
advances a `ManualClock` through the same 300 ms discovery pause and 15,100 ms
idle interval, retaining the before/after page, occupant and acting assertions.
That clock does not advance the real 100 ms catalog-notice timer. After discovery,
the journey flushes pending catalog work, reads the authoritative catalog, and
waits for the same client snapshot used by the assertions to reach its generation
and revision. Its view report records that revision and the phases; the removed fixed sleeps total
15.4 seconds per file run (source accounting, not a measured runtime speedup).

`NotificationDispatcher.wait` controls only reply grace and retry backoff; its
existing `now` option is shared with `NotificationStore` for both the decision
and the publication recheck, so they agree at the push-window boundary. The
standalone dispatcher integration journey tests one millisecond before expiry
and at expiry. Account requests retain real
transport deadlines. `drain()` waits for every admitted decision/publication;
the Host exposes it as `notifications.drain()`. The live-client journey then
uses a WebSocket ping/pong barrier so earlier notification frames are observed
before its negative assertions. A committed row alone is not a producer barrier:
the note journey subscribes before triggering the note and awaits its published
message event and the program's successful completion before draining. Completion
proves the awaited message command returned after publishing, even if the live
stream first exposed its committed row through gap filling. The artifact records
the producer event and occurrence IDs. The five 2,500 ms settle intervals still
advance in domain time. The readiness matrix advances three 5,050 ms grace intervals,
and the shutdown journey advances 5,100 ms before closing while authority is
unavailable. Assertions, retry intervals and shutdown bounds remain unchanged.
Removed fixed sleeps: 15.15 seconds in `notification-dispatcher.integration.test.ts`
and 17.6 seconds in `notifications.integration.test.ts`, excluding condition polls
and additional production grace/retry waits driven by the clock. Existing
`rechecks.json` and `notifications.json` artifacts remain the acceptance evidence.

The warm machine-access journey injects `runCapabilityNow` only into the Host's
Run-capability signer/verifier and `credentialRefreshClock` only into the
Runner's refresh scheduler. It advances 6,000 ms across the unchanged 4,000 ms
token lifetime, then awaits the next refresh scheduling event: that event occurs
after the real Host response has replaced the Runner's credentials. The original
SSH, warm-engine identity, session authority and teardown assertions remain.
`warm-machine-access.json` records both intervals. This removes a 6-second fixed
sleep; execution leases, real SSH/process I/O and slow-exit containment still use
real time.

`ComputerReplService` takes a `clock` for its 100-second wall deadline and a
`wait` for script `sleep`; the invocation deadline it hands each computer
operation stays real. The computer-use journey's wall-deadline case advances
100,000 ms once the script's sleep is pending, so the deadline still ends a
sleeping script, and keeps its assertions. This removes a 100-second real wait.

The Host's `workspaceReconcileClock` decides only when its periodic workspace
reconciliation passes run; production uses `systemClock`, and each pass's work
stays real. The engine-inspection recapture journeys advance it 45,000 ms once,
the longest jittered interval, so the real loop's next pass recaptures the
catalog now; their durable-state polls and assertions are unchanged. This
removes a 15–45-second wait from each.

## Agent tool-use evaluations

`pnpm eval:agent-tools` runs behavioral cases against the shipped Claude Code or
Codex driver using an existing local subscription login. It does not use model
API keys, provider prompt captures, a simulated native tool executor, or an LLM
grader. Cases live in `evals/agent-tools/cases/*.ndjson`; their provenance names
a historical commit and explains the sanitized incident, guard or control.

```sh
pnpm eval:agent-tools --engine claude
pnpm eval:agent-tools --engine codex --model gpt-6.1-sol
pnpm eval:agent-tools --engine codex --case workspace-model-discovery-gap --samples 1
pnpm eval:agent-tools --engine codex --baseline /absolute/baseline/results.jsonl
pnpm --filter @opensteer/eval-agent-tools test
```

The default is two independent samples per case and a third on disagreement.
`--samples N` fixes the count; `--concurrency N` bounds active samples (default
2). A case passes by strict majority; ties fail. `--effort` must be a value the
engine's live model catalog offers. The default Claude model comes from that
catalog; Codex prefers `gpt-6.1-sol` when offered, otherwise its listed default.

Every sample has disposable fixtures, provider state, MCP servers and native
engine processes. Only authentication is copied from the existing local login;
user hooks, plugins, MCP configuration, history and instructions are excluded.
Runs use the driver's normal Full access mode inside its isolated-service
sandbox, exactly as on a Runner on this Mac; that sandbox denies native tools
the sample's private provider state. Each sample's HOME, temporary directory and
engine profile are disposable, so engines start without the user's
configuration, hooks, MCP servers or history. Native tools can still read any
file the macOS user can read by absolute path, as on a Runner: macOS cannot nest
Seatbelt profiles, and an outer sandbox would disable the engine's own (see
`apps/runner/src/sandbox/harness-sandbox.ts`). Cases therefore never point at
host files. It never grants a
native tool's approval request. The Host is fake: production MCP registration
and Zod validation run in-process, but product and integration mutations cannot
reach real services. Case mocks supply results after validation. Native file
and command tools execute for real within these boundaries.

Results default to `~/.local/state/opensteer/evals/<timestamp>-<engine>`.
`--out /absolute/directory` chooses another location outside the checkout; an
existing results file is never overwritten. `results.jsonl` is flushed after
every sample, with calls, raw arguments, invalid calls, checks, final reply,
usage, duration and transcript location. `run.json` records the selected corpus
and engine identity, and `corpus.ndjson` preserves the exact validated cases. `summary.md` reports sample rates by case, kind and area,
case-majority passes, incomplete execution and baseline deltas. Full native
events remain in each sample's transcript, including preceding turns; grading
uses only the final turn's Opensteer calls and last assistant reply.

Baselines must have matching engine, engine version, model, effort and selected
corpus fingerprints and complete sample sets. Prompt/skill and advertised-schema
hashes are recorded as treatment and may differ. Exit status is nonzero for an
incomplete run, incompatible baseline, or a previously majority-passing case
that now fails beyond `--regression-budget N` (default 0). Behavioral failures
without a baseline remain report data; they are not infrastructure failures.

For credential-free inner-loop coverage, run
`pnpm exec vitest run evals/agent-tools`. The real MCP HTTP journey writes a
repeatable `journey.json` inventory/call artifact under the operating system's
temporary directory. Real-engine runs are manual and consume subscription
capacity; they are not part of `pnpm check`.

### Persistent guest journey protocol

`apps/desktop/scripts/test-macos-journeys.sh` accepts a credential-free guest with
`$HOME/.opensteer-test-guest`, as well as the legacy disposable job layout. From
`apps/desktop`, invoke these three commands separately, always running postflight:

```sh
bash scripts/test-macos-journeys.sh --preflight --run-id "$id" --out "$HOME/opensteer-runs/$id"
bash scripts/test-macos-journeys.sh --run-id "$id" --sha "$sha" --out "$HOME/opensteer-runs/$id" saved-password windows launch
bash scripts/test-macos-journeys.sh --postflight --run-id "$id" --out "$HOME/opensteer-runs/$id"
```

The on-demand `mac-owner` selection uses the registered launcher and requires the
legacy `/Users/admin/opensteer-job` layout. Its temporary fixture directories live
under the registered run root. On interruption, its group gets a bounded grace
period for its cleanup trap before the normal forced stop and registered cleanup.
Files written or changed in `~/opensteer-job/artifacts/mac-owner` during the run
are copied read-only into the selected run's `mac-owner/` directory; earlier
or unselected engine evidence is omitted. It is excluded from default journeys
and sweeps.

After each journey, both invocation modes copy `.ips` and `.crash` files from
`~/Library/Logs/DiagnosticReports` modified since that journey started into its
`crash-reports/` directory. Copies are read-only, originals stay untouched, and
`crashReports` in each manifest row records the count. A report macOS removes
during collection is skipped. Any other collection failure is recorded as the
row's `evidenceError`; it never changes the journey's result or stops later
journeys. Reports are evidence only and never authorize process or file cleanup.

IDs have format `yyyymmddThhmmssZ-xxxxxxxx` (eight lowercase hexadecimal digits).
Preflight returns 0 for clean, 3 for unknown residue, or 2 for invalid arguments or
setup failure. Run requires a matching clean preflight and exact full HEAD SHA;
it returns 0 for passing journeys and 1 for any failure, interruption or skip after
authorization, including preparation failure. Exit 2 is reserved for usage and
authorization refusals.
Postflight returns 0 for clean and 4 for leaks. Collector failures are setup errors
and cannot certify cleanliness. The orchestrator must quarantine/reset a guest
that cannot certify clean state.

Inventories, cleanup actions and the resource/egress registry are in
`preflight.json` and `postflight.json`. `manifest.json` records run ID, SHA, shared
preparation timings and each selected journey, including never-started journeys.
An interrupted run keeps its active marker until clean postflight. Only validated
version-2 ownership records authorize cleanup. Each filesystem
root records its real location and ancestor device/inode identities; symlinked
ancestors are refused, except for the explicit `/tmp` → `/private/tmp` system
alias. The same validation applies to output directories. Only exact registered
keychain services and filesystem roots may be removed. Prefixes and command-line
path mentions detect residue but never authorize removal or signaling.

Every workload starts behind a waiting wrapper. The runner records its PID,
process group and start time using an atomic, directory-synced journal update
before releasing it. A parent crash before release closes IPC and the wrapper
exits without executing work. Signals require a still-matching registered group
leader; confirmed terminated groups are retired. A reused PID or an orphan group
whose leader cannot be verified remains residue and cannot authorize signals.
The Chrome cold-launch assertion uses a registered canonical Chrome location;
preflight refuses an existing profile, and postflight removes the fresh test
profile. It never supplies an existing Chrome profile as a fixture.

Evidence stays under the explicit output directory. Each journey uses the short
`/tmp/oj-<last-eight-run-ID-hex>-<journey>/` temporary root to stay below macOS's
Unix socket path limit, independently of HOME or the artifact path. The runner
registers these roots before creating them. Preflight records every leftover
`/tmp/oj-*`; only exact registered roots are
removed. Unregistered matches remain unknown residue (preflight 3, postflight 4).
Postflight removes validated registered roots and verifies their absence.
Installed app fixtures use the registered `~/Applications/Opensteer Journey Fixtures`
location because the production app catalog scans Applications. Swift `.build`,
pnpm, Playwright and Electron download caches remain outside cleanup roots.
No flags retains the disposable VM workflow and its flat `artifacts/journeys/`
layout, including `manifest.json` and `saved-password/mac/` evidence. These scripts
must never run on a personal desktop.

For `native-browser` and the folded quit smoke in `electron`, provisioning supplies a validated, credential-free native
runtime distribution at `~/.cache/opensteer/journey-resources`. Preparation stages
it beneath the journey output and rebuilds source-owned services using
`electron-native-browser-resources.ts`. Missing or invalid distributions fail
setup; an older Host/Runner cannot satisfy the journey. Legacy VM jobs may still
supply their staged resource tree through `OPENSTEER_PERSONAL_E2E_RESOURCES`.

The `electron` command runs the folded `:run` smokes serially beneath the registered
journey workload. Each smoke's log, result and supporting artifacts stay below
`OPENSTEER_JOURNEY_OUT`; its `results.jsonl` requires all thirteen smokes in order.
Smoke failures are recorded and the remaining smokes still run. The outer journey
fails if any smoke fails, is skipped or is missing.

Listener certification uses process ownership, without a reserved port range:
listeners owned by test-process matches or descendants of recorded run groups
count as residue/leaks regardless of port. Other listeners (including macOS
daemons) are retained in `otherListeners` for information and do not fail
certification. This preserves evidence of AirPlay, rapportd and sharingd without
mistaking their ephemeral ports for journey leaks.
