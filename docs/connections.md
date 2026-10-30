# Client connections

`@opensteer/client` owns shared discovery, routing and authentication. Its
[connections](../packages/client/src/connections) and
[auth](../packages/client/src/auth) modules have no Node APIs; platform access
arrives through injected ports. See [Host boundaries](host-boundaries.md) for
credential authority and [Mobile](mobile.md) for the phone's implementations.

The public stable Mac app has no Opensteer Account issuer. Account sign-in, directory
discovery, adoption and Connect are unavailable; Private network HTTPS access and
one-use pairing codes continue to work without an Account. Beta retains its staging
Account and Connect. See [Stable channel without an Account](releases.md#stable-channel-without-an-account).

## Route selection and lifetime

[`connection-resolver.ts`](../packages/client/src/connections/connection-resolver.ts)
is the sole route selector. `describeConnectionAccess` answers every catalog
row, including inaccessible ones; `resolveConnection` requires a usable route.
Precedence is owner, routed, then native. The computer supervising a Personal
Host uses loopback even when a preferred endpoint or signed route exists;
phones supply a null local runtime.

Agent Phone uses the Host-built pairing target (`agentPhone.target.get`) rather than the
client resolver. [Agent Phone](agent-phone.md#5-pairing) documents its TLS and
Deployment/Host-instance checks and how setup moves an enrolled phone to a changed target
without unpairing it.

Do not independently read routing fields to choose an endpoint. The
[routing-field guard](../tests/connection-routing-fields.test.ts) checks desktop
and shared-client code; mobile must follow the same rule.

`resolved.key` includes Deployment id, Host instance, key fingerprint, origin,
access and route generation. [`HostAttachmentFence`](../packages/client/src/connections/host-attachment-fence.ts)
invalidates work when that key changes, and
[`HostTransport`](../packages/client/src/connections/host-transport.ts) rejects
requests and sockets belonging to an old generation. A socket the fence closes
still reports its close to whoever opened it — on the desktop, the renderer —
so its owner reconnects through the new attachment instead of holding a socket
it believes open. The local Runner resolves
its durable Deployment target through the same resolver and fence key.

Connection state follows bootstrap, authentication, platform network status and
the subscribed realtime channel. A failed ordinary RPC reports an error for
that operation; it does not mark the Deployment offline. RPCs allow 45 seconds for
response headers, above the Host's own 30-second waits on a Runner, and 20 seconds
of body silence, renewed by each nonempty chunk;
timeouts abort the fetch and return a retryable operation error without replay,
while caller cancellation takes precedence. Binary uploads and buffered adapters
allow an additional second per accepted KiB (desktop enforces headers and byte
progress before buffering across IPC). A 401 asks for sign-in as soon as its
headers arrive, and session recovery after a refusal runs on its own deadlines. Decoded JSON is limited to 16 MiB, with existing
attachment and preview limits preserved. The initial bootstrap
sets availability when no synchronized channel can establish a usable session.
Cancellation and an attachment fence discard stale work without claiming that
the Host was unreachable. After publishing bootstrap, the client starts realtime and
task/request reads before recovering omitted tab catalogs in batches of three; newer
catalog revisions and viewer generations continue to fence delayed recovery results.

## Durable stream and live progress

A Workspace channel carries two kinds of message. Durable events (`host.events`)
reach a subscriber strictly in sequence order: the
[realtime hub](../packages/orchestration/src/realtime-hub.ts) holds an event that
was published early until the events before it are sent, and reads a hole that
publication leaves from the store, which is authoritative because a sequence is
published only after every lower one has committed. A client drops anything at or
below its cursor, so sending one event early would lose the ones it overtook.

Realtime readers strip added fields and ignore unknown outer message kinds.
Known envelopes keep their control behavior: every resync reason resets the
cursor, including a reason this reader does not know. Snapshot Thread lists omit
records with unsupported statuses while installing understood siblings; malformed
known fields still fail validation. Durable event readers skip unknown event kinds
and unsupported Thread statuses at the event boundary, advancing their validated
Workspace cursor in order. Every event's Workspace is checked before any part of
the batch changes state or cursor. Unknown live stream kinds are omitted
independently of understood streams. Notices never prove subscription progress.
The Host projects every
outgoing realtime message through its declared reader schema before sending it;
invalid publications produce a final, payload-free refusal.

Malformed known frames stop that Workspace channel without automatic retry:
replaying an unchanged cursor cannot repair the frame. The connection remains
offline until the person's **Retry** or a new client retries after repair.
`refresh()` only rereads: polling, foreground transitions and network handovers
preserve terminal refusals. Web/desktop and Expo connection Retry controls pass
`refresh({ retryConnection: true })`. Parsing and channel validation finish before
projection and transport effects; an acknowledgement send failure takes reconnect
backoff with already-applied state and cursor retained, without a protocol refusal.
`host.realtime.frame-rejected`
diagnostics carry only an allowlisted envelope type (otherwise `unknown`), the
negotiated API epoch, UTF-8 byte size, error category and bounded schema issue
paths. Array indices are normalized and unknown path components become `*`;
payloads, discriminator values and validator messages are never logged.
`host.realtime.frame-ignored` records the same metadata for unsupported kinds.
Desktop main also persists `desktop.host-socket.frame-unrecognized` at its
realtime boundary using the same metadata projection. This records schema
failures even without a renderer console sink. It forwards the original frame;
the client decides which added kinds it can skip and which failures are final.

The Host publishes `thread.state-changed` with absolute `status`, `inputQueuePaused`
and `pendingRequests` whenever the stored tuple changes. Run and queue transitions project
synchronously. Request changes mark their originating Thread for a durable drain; the state
event follows in its own transaction at a later Workspace sequence. The Host drains after
publishing Request events, at startup, and on a periodic sweep. The pending count is stored on
the Thread and counts pending Requests by originating Thread. Snapshots, pages and command
answers read that stored state, including while a Request marker awaits projection.
This contract is part of unreleased Host API epoch 29.

The shared client keeps each Thread's `stateSequence`. Snapshots use their Workspace
sequence; Thread creation, execution-update, listing and state events use their event
sequence; HTTP pages use `readState.asOfSequence`; Thread command answers carry
`asOfSequence` from the transaction's final Workspace head. Only a strictly newer
source replaces the three event-owned fields. Request events update Request records
and transcript entries, without changing the Thread count. The client retains the
latest absolute state for up to 4096 unloaded Threads, then reconciles it when a summary
arrives. Loaded Threads keep their sequence independently of that bounded map.
Each Workspace has one coverage floor, advanced by an installed snapshot or an
evicted record's sequence. A summary older than that floor cannot install state
unless a loaded Thread already holds state at or above the floor. The client rereads and
resamples the floor after each await, with at most three rereads per Thread per load. If
coverage keeps advancing, it installs the newest available read after that cap and lets
subsequent events advance the state. Being newer than a response alone does not make a
retained state valid across an omitting reconnect snapshot.
Summary replacements keep the later `updatedAt`; late command answers keep the list
position and any transcript already projected by realtime events. The run queue follows
the same rule per Run ([`RunQueueProjection`](../packages/client/src/host/run-queue-state.ts)):
events, snapshots, Thread pages and command answers each state one Run at a sequence, the
newest wins, and a Run that ended never returns as active. Every client takes a Thread's
working indicator and Stop button from one selector,
[`threadActivity`](../packages/client/src/host/thread-activity.ts). Stop reaches the
earliest executing Run or, with none executing and the queue not paused, the earliest
queued one, which the Host ends at once. A queued Run whose AI account is getting ready
says so where the indicator or typing would stand (`threadStartHold`); an ordinary start
does not.

Unopened Threads receive domain state updates without accumulating a transcript;
opening one reads fresh durable history. Already hydrated transcripts keep receiving
updates so returning readers retain their older messages and position. Reconnect
snapshots preserve a shown transcript and its matching
history cursor until a history read succeeds. A snapshot that overtakes an ongoing
read invalidates its coverage and requires another read. History failures remain
visible and retryable without clearing the last readable conversation.

Streaming text is live progress (`host.live`), never a durable event. A Runner
coalesces its engine's deltas and sends appends that name the offset they
continue; the Host keeps each active Run's streams in memory
([`LiveRunRegistry`](../packages/orchestration/src/live-run-registry.ts)) and
forwards a frame only after every durable event it follows, so a completion is
never overtaken by the next stream's first words. Live progress never moves a
cursor, acknowledges, or notifies. A resubscription forgets what the old
connection streamed and receives every open stream whole; the client rereads
each Thread it is still drawing a stream for and drops any stream no longer
open. A client that sees an append at an offset it does not hold rereads the
Thread's streams with `thread.live.get`, once more if a gap appears while that
read is in flight, and a history read draws the Thread's live streams again over
the durable page. Signing out forgets all of it. The completing `assistant.message`, `reasoning.completed` or
`tool.completed` carries the whole text, so nothing durable depends on progress
having arrived. Earlier Hosts stored deltas as durable rows; those rows stay, and
every read of the log steps over them and reports how far it scanned.

## Viewer state synchronization

Authenticated bootstrap and Workspace catalog pages carry this viewer's mute
preferences for the Workspaces in those bounded results. Workspace snapshots
and earlier Thread pages carry this viewer's read state alongside the shared
Threads. A direct Thread history read carries its read state too. Clients do not
send those returned IDs back in bulk metadata requests.

The Host derives an unread candidate from published incoming Messages after the
person's durable read marker. Each state has `readSequence`, `unreadSequence`,
`asOfSequence` and the display-only `placement` and `placementRevision`, which
only pre-launch clients read. Placement is null without a read marker; otherwise it
projects shared Done at that exact read position, with revision `asOfSequence`.
That sequence is the Workspace event head from the same database snapshot
(see [Host compatibility](host-boundaries.md#compatibility)).

A MessageView's `published` flag carries input publication in Workspace snapshots:
pending or claimed queue/steer inputs may already be drawn for their sender, but
cannot name a read position until receipt. The client preserves that distinction
through command answers and input events. Input updates also carry the receiving
Run association through history-page boundaries, so snapshot timing cannot rename
a reply's row. A claim records that association without making a requeue marker.
Assignment-return rows present internal
continuation messages and never name a conversation read position.

A Thread is unread when `unreadSequence` is after `readSequence`. The shared client
merges read markers monotonically, uses the newest content cut for the unread
candidate, and tolerates cancellation moving that candidate backward. A mute
preference has a per-person, per-Workspace revision so delayed catalog results
cannot undo a newer choice.

Publication, placement and cancellation refresh affected viewer state on the
ordered Workspace subscription; one person's marker or mute choice goes only
to that person's connections. On every subscription, including cursor resume,
the Host sends current viewer metadata and pages persisted older read markers
and mute overrides. Shared event replay alone cannot recover private changes
made on another device while this one was disconnected. The synchronization
buffer keeps viewer updates behind the matching snapshot and replay cut.

Live `access` does not establish durable supervision: a stopped Personal stack
still belongs to this computer. Desktop's
[`ConnectionSupervisor`](../apps/desktop/src/connections/connection-supervisor.ts)
tracks only the attached Deployment; other rows use `detachedStatus`. Local
process supervision in [`supervisor/`](../apps/desktop/src/supervisor) separately
owns PostgreSQL, Host, Runner and messaging processes.

## Personal process recovery and diagnostics

While Desktop wants its Personal Deployment running, unexpected component exits
keep restarting with exponential backoff: one second initially, capped at 30
seconds, reset after five minutes of healthy uptime. The app reports the component
being restarted and the delay. A Host crash replaces only the Host at its saved
port with the same durable identity; PostgreSQL, the Runner and browser keep
running. A messaging crash replaces only messaging. Losing PostgreSQL or the
Runner rebuilds the stopped service graph under the supervisor's mutation queue.

The selected local Deployment's **Try again** asks that supervisor to start what
is down before attaching. It wakes a pending recovery delay and joins an existing
start. Every start reads the saved manifest, so Try again continues from what a
failed attempt already committed, such as an adopted release update. Service
teardown must finish before another graph can start. Quitting cancels recovery.
What a person must fix (invalid authority, a release that is missing, altered or
built for another Desktop, an unavailable keychain, a taken private port, an
unusable data directory) requires repair and does not trigger blind restarts.
Only the failure's type decides this: words in a child's output never stop
recovery, and a file-system error that can pass while reading the release or the
protected secrets (too many open files, a full or failing disk) is retried with
backoff like a crash. A start that meets a full disk asks for free space.

Desktop writes each Personal child's stdout and stderr to its app logs directory:
`personal-postgresql.log`, `personal-host.log`, `personal-runner.log` and
`personal-messaging.log`. The Personal browser's in-process start diagnostics use
`personal-browser.log`; a browser lent to another Deployment writes its own
`browser.log` in that slot's directory, which is removed with the slot. Each file
is capped at 256 KiB with one rotated `.1` sibling, uses private permissions, and
receives the existing credential redaction before writing. A separate `.lifecycle`
file and its `.1` rotation use the same bounds, permissions and redacted input.
They omit routine HTTP request starts and successful completions, preserving
lifecycle records and unsuccessful completions when polling fills the main log.
Total retention is at most 1 MiB per logger. Opening a log recreates
a removed logs directory. An open, write or rotation failure reports its cause once
and disables that writer for the child; it never stops a child from starting or
interrupts process ownership. Oversized unterminated lines are omitted. Crash issues include
the exit status and a bounded stderr tail. Native process containment reports the
supervisor's exit status; a target killed by a signal also reports that cause on
stderr.

Desktop socket diagnostics use an independent, non-authorizing `socketId` across
`desktop.host-socket.opened`, `.target` and `.closed`. Browser records carry the
session and control/watch mode; validated target subscriptions add a
`surfaceCorrelationId`. It is an HMAC scoped to the session under a random,
in-memory key belonging to that transport. Raw surface values, including URLs or
credentials a producer put in them, never reach the log; correlations cannot be
compared across transport lifetimes or guessed without the unpersisted key.
Close records add initiator, lifetime, code and an allowlisted reason (`other`
for unrecognized reasons). IPC connection IDs, endpoint queries and frame
contents are never persisted by these diagnostics.

Quitting is one irreversible transition shared by menu/Cmd-Q, AppleEvent,
SIGTERM/SIGINT and system shutdown. Desktop cancels new work immediately and
runs ordered cleanup with a 30-second overall deadline. A failed step is logged
and later owners still stop; quitting never shows a modal, restarts services or
returns to the app. Browser profiles save while their Runner relay and Host are
still alive, then the Runner, Host and PostgreSQL stop in order. Cloudflared uses
the same native containment wrapper as Personal services, so a lost Desktop
control pipe also ends its process tree. Supervised Node children inherit the
verified `OPENSTEER_PROCESS_SUPERVISOR_EXECUTABLE` capability; shared harness
launches use the same owner for detached inspection/engine processes, so losing
a Runner cannot orphan an inspection server outside the Runner's group.
Connector shutdown preserves enabled
intent without configuring a remote route or requiring a ready Host/Account;
Account liveness expires after the Host stops refreshing it. The connector sets
cloudflared's `--grace-period 0s`: tunnel WebSockets cannot drain while the Host
itself is quitting. Remote-access stop keeps its five-second deadline. A local
Runner's terminal `runner.worker.stopped` acknowledgement ends the owned utility
process after daemon cleanup. The supervisor still awaits its exit event; a
referenced handle cannot hold it until the five-second force-kill fallback.

`desktop.shutdown.*` records name each component and step, its duration and every
nested `AggregateError`/`cause`, including graceful-to-force escalation. The
existing local diagnostics retain these records on the next launch; an old
shutdown failure does not open a dialog. A save that cannot finish before the
deadline is reported as a failure; Desktop cannot promise to save newly changed
browser state when its storage or native exporter has stopped answering.

Use the cheapest affected checks for connection regressions and reuse one
journey per user-facing flow. The following smoke commands are reference recipes,
not a per-change checklist. Retain their artifacts only for manual acceptance or release checks ([Testing](testing.md#how-to-test)).

The macOS [`quit smoke`](../apps/desktop/scripts/test-electron-quit.ts) runs a
separate hidden Electron bundle with its own identifier, data, ports and test
cryptography. The VM supplies `OPENSTEER_PERSONAL_E2E_RESOURCES` and
`OPENSTEER_QUIT_E2E_ARTIFACT_DIR`; run
`pnpm test:vm -- pnpm test:electron-quit`. It sends AppleEvent and
SIGTERM quits with a live saved browser and an owner socket (without capture),
exercises the system-shutdown callback. Fake-timer tests in
[`desktop-shutdown.test.ts`](../apps/desktop/src/app/desktop-shutdown.test.ts) cover
repeated quit requests after cleanup errors and bound hung cleanup steps. It restarts the same database
and profile, verifies cookies, a 3 Mi-character localStorage value by SHA-256, and
a second origin's normal value. A real local utility Runner and an offline connector
with cloudflared's drain behavior are running before quit. Automatic checkpoints
must commit both origins, and healthy browser/connector/local-Runner steps must
finish within 2.5 seconds without failed steps. Set `OPENSTEER_QUIT_E2E_TRIALS` to
`appleevent,restart` for the focused round trip. The smoke retains step logs, process
trees before/after and `quit-smoke.json`. It does not request an actual OS logout.

Host recovery, committed-update retries, authority failures and log retention are
covered by the host Vitest tests in
[`personal-deployment-supervisor.test.ts`](../apps/desktop/src/supervisor/personal-deployment-supervisor.test.ts),
[`personal-process-port.test.ts`](../apps/desktop/src/supervisor/personal-process-port.test.ts) and
[`personal-log-retention.test.ts`](../apps/desktop/src/supervisor/personal-log-retention.test.ts).
[`server.test.ts`](../packages/browser-runtime-core/src/server.test.ts) checks that
browser initialization precedes listening and that concurrent starts and immediate
attaches share readiness. The
[native browser journey](../apps/desktop/scripts/native-browser-journey.ts)
runs with `pnpm test:vm -- --mobile bash scripts/test-macos-journeys.sh native-browser`.
It exercises native pages through real Host authority and records per-step outcomes,
screenshots, timings and cleanup evidence in the VM run directory.

## Catalog authority

[`deployment-catalog.ts`](../packages/client/src/connections/deployment-catalog.ts)
stores the verified `HostDiscoveryEnvelope`, including its public key, and the
connection's source (`manual` or Account `{issuer, subject}`). Preserve these
rules when changing reconciliation:

- Host identity is the exact `(deploymentId, hostInstanceId, hostKeyFingerprint)`
  tuple. A manual entry stays pinned to it; replacing the instance or key
  requires removal and re-addition. An Account entry follows only its verified
  Account directory.
- An Account entry must match the syncing Account's issuer and subject. Sync
  never deletes or overwrites a manual entry. The directory can rename a
  locally supervised Personal Deployment but cannot repoint it.

These rules prevent directory updates from changing the authority a person
chose. See the adjacent catalog tests and
[`authority.test.ts`](../packages/deployment-authority/src/authority.test.ts).

The Account's signed envelope is seeded at linking or adoption, then refreshed
by [`HostAuthorityPublisher`](../apps/host/src/access/host-authority-publisher.ts)
through `PUT /v1/host/authority`. That update cannot change the identity tuple.
Membership projections carry presence, a generation and the Host-instance
fence, never key material. Hiding a directory row changes the member's listing
preference, not ownership or authority.

## The place list

The Desktop's place list is one projection, owned by
[`DeploymentAccessService`](../apps/desktop/src/connections/deployment-access-service.ts)
and drawn by the sidebar's place menu and the full-window chooser alike
([`place-list.tsx`](../apps/web/src/components/places/place-list.tsx)). It may
only say what a check can vouch for:

- **Account places are shown only while that Account is signed in.** An
  expired or rejected session hides them without deleting them, so they return
  on sign-in; explicit sign-out removes them from the catalog. The selected
  place is the one exception: it stays on screen, asking for sign-in, and is not
  reopened on its own until the Account is back.
- **Status comes from the authority that knows, and is never older than a
  check.** The stack on this computer reports itself; the place a person is
  connected to is ready; an Account place is judged by an Account list read
  within the last minute, counted from the start of the read (a lapsed lease
  then means asleep, a missing Connect route means remote access off, a directory
  verification failure means unreachable); a place added by hand is judged by
  an identity-checked probe of its own discovery document
  ([`deployment-probe.ts`](../apps/desktop/src/connections/deployment-probe.ts)).
  Without such an answer the row reads `checking`; a check that failed reads
  "Couldn’t check", never offline. A place added by hand that does not answer
  reads "Not responding" and stays openable; without a network the list says
  so once.
  A background refresh that did not run successfully neither renews the last
  answer nor clears a previous check failure.
- **Checks are on demand.** The renderer calls `checkDeployments` when a list
  opens and every 30 seconds while it stays open. Calls within five seconds share
  one check, so opening the menu twice costs one read.

An Account session ends only when the Account refuses the refresh grant (HTTP
400 or 401). A refresh that gets no answer — no network, an outage, a rate
limit — keeps the session and surfaces as a retryable error, so waking a
laptop onto a dead network never signs a person out. A refreshed token is not
an Account change: the list is re-read only when a different Account signs in.

The rendered DOM tests in
[`place-menu.interaction.test.tsx`](../apps/web/src/components/places/place-menu.interaction.test.tsx)
cover expired sign-in, unanswered servers and the current place's problem actions.
