# Client connections

`@opensteer/client` owns discovery, routing and authentication through injected
platform ports; it cannot depend on Node APIs. Start at
[connections](../packages/client/src/connections) and [auth](../packages/client/src/auth).
Credential authority belongs in [Host boundaries](host-boundaries.md).
Focused checks: [check-client-connections](../.agents/skills/check-client-connections/SKILL.md).

The public stable Mac app has no Account issuer: Account discovery, adoption and
Connect are unavailable, but private HTTPS and one-use pairing still work. Beta
retains staging Account and Connect. See
[Stable channel without an Account](releases.md#stable-channel-without-an-account).

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
and never reopen the app or a modal. Browser profiles save while Runner relay
and Host remain alive; Runner, Host and database then stop in order. Lost parent
control pipes must contain process trees, including tunnel and detached engine
helpers. Connector shutdown preserves enabled intent without requiring live
Host/Account or configuring routes. Tunnel WebSockets cannot drain while their
Host quits. A stuck save is a reported failure, never a promise that new browser
state survived. See
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
