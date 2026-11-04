# Client connections

`@opensteer/client` owns discovery, routing and authentication through injected
platform ports; it cannot depend on Node APIs. Start at
[connections](../packages/client/src/connections) and [auth](../packages/client/src/auth).
Credential authority belongs in [Host boundaries](host-boundaries.md).
Focused checks: [check-client-connections](../.agents/skills/check-client-connections/SKILL.md).

Both desktop update channels use the Account at `https://accounts.opensteer.com`
and portal at `https://app.opensteer.com`. Personal Hosts run on the person's
computer; self-hosted servers can attach to an Account. Connect routes remain
under `opensteerapp.com`. The Account does not provision or host Deployments.

## Route selection and lifetime

[`connection-resolver.ts`](../packages/client/src/connections/connection-resolver.ts)
is the sole route selector; never choose endpoints by reading routing fields
elsewhere. Local supervision takes loopback precedence over signed/preferred
routes. Agent Phone instead uses the Host-built pairing target and its
[identity checks](agent-phone.md#5-pairing).

Attachment identity includes authority and route generation, not just origin.
The [fence](../packages/client/src/connections/host-attachment-fence.ts) and
[transport](../packages/client/src/connections/host-transport.ts) discard stale
requests and sockets. A fence-closed socket must still notify its owner of close
so it can reconnect. Phone discovery evidence is reusable only within the
verified fence; reconnect and authentication/protocol refusals reverify it.

Ordinary RPC failure is an operation error, not evidence the Deployment is
offline. Timeouts abort without replay, cancellation wins, and authentication
refusal acts when headers arrive. Buffered IPC must enforce progress before
buffering. Availability follows bootstrap, authentication, network and realtime;
cancellation and stale-fence discards cannot claim the Host was unreachable.
Catalog recovery follows realtime and task/request reads; newer revisions and
viewer generations fence delayed catalogs. Deadline/size policy lives in the
transport source, not this document.

## MCP routes

MCP discovery and OAuth must reach the same Host as `/internal/v1/mcp`. Forward
`/.well-known/oauth-protected-resource` (including its resource-specific suffix),
`/.well-known/oauth-authorization-server` and `/oauth/mcp/*` through development
and deployed gateways; an SPA fallback at those paths breaks discovery or code
exchange. Keep the approved route's exact origin through consent and completion.
Personal Connect forwards these paths with the whole tunnel hostname; Stable's
loopback route needs no Account. A route is reachability, never consent or caller
authority. See [MCP OAuth boundaries](host-boundaries.md#credentials-and-session-authority).

Connected-agent Settings load only when opened, on web, desktop and both mobile
platforms. Listing or revoking connections must add no attach round trip or
bootstrap dependency. Opening Settings, reconnecting, explicitly refreshing or
the person's `host.connections-changed` notice (approval or revocation on any of
their devices) rereads current Host authority.

## Remote administration

The Host persists owner intent and progress; the desktop app executes it through
its existing Connect and Account coordinators. Every owner device uses the same
Host commands. An absent executor leaves a visible pending operation with that
reason. Recovery resumes the failed action with the same external operation
identity; turning access Off can supersede pending work. Account steps are admitted
under the shared session fence and journaled on the exact link before network I/O.
No Account request holds a Host transaction or session lock. Restart and executor
recovery replay the idempotent step, then conditionally finalize that link;
unlink retains its credential until the Account acknowledges removal. A definitive
Account refusal with a validated reason for that operation retires only the
rejected step, preserving the credential for prerequisite changes or unlink.
A completed operation whose result was superseded is finalized against the exact
link and journal identity. Unknown, malformed, reasonless and temporary failures stay journaled;
a failed recovery is visible and leaves the executor connected for the next action.

A request persists before acknowledgement. Execution that can remove the current
route starts only after that response completes, and continues under the
supervisor's process capability. Unlink never requires another request from the
session it revokes. Clients warn that these actions can disconnect the initiating
device and others. Revoked credentials stop authenticating before success; their live
connections close after the revocation response is sent.

Account linking signs in on the initiating device and uses its challenge/proof
exchange. Browser linking uses an Account-portal confirmation with exact
origin/source-bound messaging; native devices use their own Account credentials.
The Host signs a per-challenge encryption key into its proof; the Account seals
completion to that key only after verifying the pinned Host signature. The
courier and desktop recovery journal hold ciphertext. The Host opens and verifies
the completion outside its transaction, then atomically revalidates the session
and exact challenge key, deletes that key and stores the linked credential before
activation.
Expired keys are erased on startup and by Host maintenance; cancellation
and unlink erase pending keys. The linked Host credential authorizes fenced
Connect provision/rotation and teardown, so execution does not require a second
Account sign-in on the desktop.
Connector credentials stay on the Host computer. Only the supervisor's private
executor channel can obtain them; owner sessions request durable intents and
read status.

Administration status is observed only while Settings or first-run setup is
open, invalidated by the Host event stream and reread after reconnect. It adds no
attach round trips or initial-screen dependencies.

First-run setup's Phone row composes these same steps; it adds no authority. It
reads live state, skips what is already true, links through the desktop's
Account-link operation and settles a Connect request on that operation's own
result. Cancelling stops later steps and never undoes a finished link or route.
Its QR code is `<portal>/open#d=<DeploymentId>`: a destination in the fragment,
never a pairing code, Host origin or grant. The phone still signs in to its own
Account and opens only that id from its authenticated directory. See
`apps/web/src/components/first-run/phone-setup.ts`.

## Durable stream and live progress

Durable events arrive strictly in Workspace sequence order; an early event
would make clients discard the lower events it overtook. The
[hub](../packages/orchestration/src/realtime-hub.ts) fills publication holes from
the authoritative store, whose sequence publication follows all lower commits.

Readers strip added fields, skip unknown kinds and unsupported Thread statuses,
and advance validated durable cursors in order. They validate every event's
Workspace before changing any batch state. Known resync envelopes reset the
cursor even for unknown reasons. Unknown live kinds are independently omitted;
notices prove no progress. The Host projects outbound messages through declared
reader schemas and refuses invalid publications without a payload.

Malformed known frames stop that Workspace channel without automatic retry:
replaying cannot repair them. Polls, foregrounding and network changes preserve
terminal refusal; only explicit Retry or a new client retries. Validation
precedes effects. Failed acknowledgement sends instead reconnect with applied
state/cursor retained. Diagnostics must never log payloads, discriminator values
or validator messages: only allowlisted envelope metadata and bounded normalized
issue paths. Desktop records the same safe metadata while forwarding original
frames for the client to classify.

An unusually frequent bootstrap logs a count-only `host.bootstrap.loop` summary,
at most once a minute. Client trigger counts survive client recreation; Host
publication counts precede socket fanout and retain only fixed type/source labels.
The optional diagnostic header rides existing reads, so older Hosts ignore it
and ordinary polling adds no traffic or log lines.

Thread state is absolute and sequenced. Requests update Request records, not
client-inferred pending counts; the Host's later projection supplies those.
Only newer state replaces event-owned fields. Reconnect snapshots can invalidate
retained unloaded state: a response being older than a retained event does not
prove coverage across an omitting snapshot. Run state follows the same rule,
and an ended Run never returns active. See
[Host session client](../packages/client/src/host/host-session-client.ts),
[Run queue](../packages/client/src/host/run-queue-state.ts) and
[activity selector](../packages/client/src/host/thread-activity.ts).

Unopened Threads receive domain state updates without accumulating a transcript;
opening one reads fresh durable history. A client that opens on Chat (the phone,
`prefetchHome`) starts Home's history as soon as authenticated bootstrap names it;
activation joins that read without claiming it early or advancing a read marker.
Other clients read Home when it opens, so an unopened Home never enters a
Workspace's Thread page by timing. Already hydrated transcripts keep receiving
updates so returning readers retain their older messages and position. Reconnect
snapshots preserve a shown transcript and its matching
history cursor until a history read succeeds. A snapshot requires another history
read only when its sequence exceeds the page's `readState.asOfSequence`, including
for a read still in flight; a page covering that snapshot is retained. History failures remain
visible and retryable without clearing the last readable conversation.

Hosts advertising `snapshot-messages-omit-v1` accept `client.subscribe` with
`snapshotMessages: "omit"`. The shared client opts in only after that advertisement.
The snapshot carries `messagesOmitted: true` and empty `messages` and
`messageWindows`: history is not loaded, rather than known empty. The Host skips
history rows and counts, retaining Thread, run queue, pending Request and viewer
metadata. No message totals are needed until the durable page supplies its window.
Unshown Threads lose any snapshot-seeded transcript and window; shown and historical
reading keeps its existing recovery behavior. Without the option, Hosts still send
the original snapshot, so this additive contract needs no API epoch change.

Streaming text is live progress, never durable state. It follows the durable
events it depends on, never advances/acknowledges a cursor or notifies, and can
be lost. Complete durable text must not depend on receiving it. Reconnection
replaces old progress with whole open streams; gaps require rereading, not
invented appends. History reads redraw current live streams, and sign-out
forgets them. Historical durable delta rows remain readable but are skipped
with scan progress reported. See
[`live-run-registry.ts`](../packages/orchestration/src/live-run-registry.ts).

## Viewer state synchronization

Read/mute state is private to the viewer. Updates go only to that person's
connections and stay behind the matching snapshot/replay cut. Every subscription,
including cursor resume, synchronizes current and persisted older metadata:
shared replay cannot recover private changes made elsewhere while disconnected.
Bootstrap/catalog/history pages carry their own bounded viewer metadata; do not
send returned IDs back in bulk metadata reads.

Read markers merge monotonically. Unread candidates use the newest content cut
but can move backward on cancellation; mute revisions prevent late catalog reads
undoing a choice. Pending/claimed inputs may be visible to their sender without
being published and cannot establish read positions until receipt. Assignment
continuations never establish a conversation read position. Input/Run association
survives history boundaries. See
[`host-session-client.ts`](../packages/client/src/host/host-session-client.ts).

## Conversation history

Conversations page by whole turns like any Thread, and the Host never predicts
what a client draws: a second copy of that rule drifts, and the pages it counts
then draw almost nothing. `conversationRows` in
[`agent-activity-model.ts`](../packages/client/src/host/agent-activity-model.ts)
alone decides what a conversation shows, and opening and Earlier read back in
bounded scans until something draws. Oversized turns can be split by the page
budget.

A conversation shows what its agent says to the reader and what needs them. A
turn nobody waited on draws only its reply, a task needing the reader, a failure
or live computer work. Inputs from agents, Triggers and Opensteer, reports
included, are for the agent: they never get a row or count as unread. Keeping
silent wakes rare is the waker's job, since each run of them costs scan reads: an
empty task result wakes nobody, and Triggers queue to Chat only with news.

## Personal process recovery and diagnostics

Live route access does not establish local supervision: a stopped Personal stack
still belongs to its computer. Only the attached Deployment is tracked by the
[connection supervisor](../apps/desktop/src/connections/connection-supervisor.ts);
[process supervision](../apps/desktop/src/supervisor) owns local services separately.

Recovery replaces only the failed independent component where possible. Starts
and teardown serialize; retries read the committed manifest so a failed update
cannot be undone by retry. Quit cancels recovery. Repair-required authority,
release, keychain, port and directory failures cannot trigger blind restart;
classification uses typed failures, never words in child output. Transient I/O
failures remain retryable. See
[`personal-deployment-supervisor.test.ts`](../apps/desktop/src/supervisor/personal-deployment-supervisor.test.ts).

Child logs are bounded, private and credential-redacted; logging failure cannot
block child startup or process ownership. Oversized unterminated lines are
omitted. Socket diagnostics never persist endpoint queries, frame contents, IPC
connection IDs or raw surfaces. Surface correlations use a transport-lifetime
in-memory HMAC key: they cannot correlate across lifetimes or expose URLs and
credentials. See [supervisor sources](../apps/desktop/src/supervisor).

Quit is irreversible: stop new work immediately, continue cleanup after errors,
and never reopen the app or a modal. Native browsers close without clearing their
stores. Runner, Host and database then stop in order. Lost parent
control pipes must contain process trees, including tunnel and detached engine
helpers. Connector shutdown preserves enabled intent without requiring live
Host/Account or configuring routes. Tunnel WebSockets cannot drain while their
Host quits. An unconfirmed browser close never proves that new browser state
survived. See
[`desktop-shutdown.test.ts`](../apps/desktop/src/app/desktop-shutdown.test.ts).

## Catalog authority

Host identity is the exact Deployment/instance/key-fingerprint tuple. Manual
entries pin it and require removal/re-addition to change instance or key.
Account entries follow only their verified issuer/subject directory; sync never
deletes or overwrites manual entries or repoints a locally supervised Personal
Deployment. The Account may rename it. Authority publication cannot change the
identity tuple. Membership projections contain no key material; hiding a row
changes listing preference, not ownership. See
[`deployment-catalog.ts`](../packages/client/src/connections/deployment-catalog.ts)
and [authority tests](../packages/deployment-authority/src/authority.test.ts).

## The place list

Account rows are visible only while signed in; expiration hides rather than
deletes them, while sign-out removes them. The selected place remains visible
asking for sign-in; a previously used selected Account place reattaches after
sign-in returns. Status must come from the authority able to vouch for it:
local supervision, attached connection, a fresh
verified Account read, or an identity-checked manual probe. A failed check cannot
be called offline, and an unsuccessful refresh cannot renew stale evidence or
clear failure. See
[`deployment-access-service.ts`](../apps/desktop/src/connections/deployment-access-service.ts).

Only Account refusal of the refresh grant ends its session. Network failure,
rate limiting and outage stay retryable without signing the person out. Token
refresh is not an Account change. See
[place menu tests](../apps/web/src/components/places/place-menu.interaction.test.tsx).
