# Client connections

`@opensteer/client` owns discovery, routing and authentication through injected platform ports and
cannot depend on Node APIs. Start at [connections](../packages/client/src/connections) and
[auth](../packages/client/src/auth). Credential authority and Account origins are in
[Host boundaries](host-boundaries.md); focused checks are in the
[testing skill](../.agents/skills/testing/SKILL.md). Connect routes live under `opensteerapp.com`.
The Account never provisions or hosts Deployments.

## Route selection and lifetime

[`connection-resolver.ts`](../packages/client/src/connections/connection-resolver.ts) is the only
route selector; never pick endpoints by reading routing fields elsewhere. Local supervision takes
loopback over signed or preferred routes. Agent Phone uses its Host-built pairing target instead.

Attachment identity includes authority and route generation, not just origin. The
[fence](../packages/client/src/connections/host-attachment-fence.ts) and
[transport](../packages/client/src/connections/host-transport.ts) discard stale requests and
sockets, but a fence-closed socket still reports its close so its owner can reconnect.

An ordinary RPC failure is an operation error, not evidence the Deployment is offline. Timeouts
abort without replay, cancellation wins, and an authentication refusal acts when headers arrive.
Availability follows bootstrap, authentication, network and realtime; cancellation and stale fences
never claim the Host was unreachable. Deadlines and size limits live in the transport.

## What a person is told

Reconnecting resumes from the cursor and loses nothing, so a connection that returns within
[the hold](../packages/client/src/host/lifecycle.ts) never happened as far as a person can tell, and
`describeHostConnection` keeps saying Connected. `canRespondToRequests` does not hold: decisions
still need a synchronized Host, so controls may dim through a drop nobody is told about. Stopping is
said at once, and nothing counts while hidden, because a frozen timer fires mid-reconnect on return.

Only the Workspaces being read decide the connection; the others retry quietly. An outage settles on
Unavailable with Retry, and the sockets keep trying behind it. Saying it never moves content: a new
surface reads this state in existing chrome or floats over the page.

A phone also reports network paths that did not move, so `same` costs a ping and only `changed`
replaces sockets. A socket that does not answer shows a move the phone could
not see, such as between two Wi-Fi networks, and everything on that path is replaced with it.

## MCP routes

MCP discovery and OAuth must reach the same Host as `/internal/v1/mcp`. Development and deployed
gateways forward `/.well-known/oauth-protected-resource` (with its resource suffix),
`/.well-known/oauth-authorization-server` and `/oauth/mcp/*`; an SPA fallback there breaks discovery
or code exchange. A route is reachability, never consent or caller authority
([connected agents](host-boundaries.md#connected-agents-mcp-oauth)). Connected-agent Settings load
only when opened, on every client, adding no attach round trip; opening, reconnecting, refreshing or
a `host.connections-changed` notice rereads current Host authority.

## Remote administration

The Host persists owner intent and progress; the desktop app executes it through its Connect and
Account coordinators, and every owner device uses the same Host commands for remote access. A missing
executor leaves a visible pending operation. A request persists before it is acknowledged, and execution that can
remove the current route starts only after that response, under the supervisor's process capability.
Unlink never needs another request from the session it revokes. Revoked credentials stop
authenticating before success; their live connections close after the response.

Account steps are journaled on the exact link before network I/O, and no Account request holds a
Host transaction or session lock. Recovery replays the idempotent step with the same external
operation identity. Unlink keeps its credential until the Account acknowledges removal. A definitive
refusal with a validated reason retires only the rejected step and keeps the credential; unknown,
malformed, reasonless and temporary failures stay journaled and visible.

Account deletion needs no Host, so a lost computer can't block it: the Account revokes Connect, then
one transaction removes the Deployments it owns. There is no ownership transfer, so deleting a
server's owner ends Account sign-in there for every member. The Host learns on its next call, when
its credential answers 401, which alone could be a proxy. Activation is the probe, because it
changes nothing and an ended link answers not-found or cancelled; never probe with unlink, which
deletes a link that still works. Only revoke and a `disabled` projection accept that answer, since
`ready` would report a tunnel that is gone, and revoke or unlink may replace a stuck projection. The
link row stays until the person unlinks, so an empty Account database can't make Macs discard their
credentials. Apple's token is revoked only after the commit, because Apple must not hear of a
deletion that was refused. The Sign in with Apple client secret is minted at startup and lasts 180
days, so the Account service must restart within that.

For Account linking, the Host signs a per-challenge encryption key into its proof, and the Account
seals completion to that key only after verifying the pinned Host signature, so the courier and
desktop recovery journal hold only ciphertext. The Host verifies completion outside its transaction,
then atomically revalidates the session and challenge, deletes the key and stores the credential.
Expired and cancelled keys are erased. Connector credentials stay on the Host computer and reach
only the supervisor's private executor channel; owner sessions request intents and read status,
which clients read only while Settings or first-run setup is open.

Desktop updates reach only the installation supervising its own Personal Host, never a borrowed
Runner or a server Deployment. The epoch-independent [maintenance v1 contract](../packages/protocol/src/maintenance.ts)
is its sole browser API. A page its Host served calls it same-origin. Phones and the desktop's main
process verify identity and reuse session authentication below ordinary attachment, so they can
update a Host they can't attach to. All of them long-poll only while Updates is visible. An
already-shipped desktop without this contract needs one local update first. The target is journaled before native staging, since any
quit can apply it; only a new desktop process incarnation reconciles the installed version.
Failed install handoff relaunches the desktop to restore the Personal stack and reconcile the journal.

First-run setup's Phone row composes these steps and adds no authority. Its QR code is
`<portal>/open#d=<DeploymentId>`: a destination, never a pairing code, Host origin or grant. The
phone signs in to its own Account and opens that ID only from its authenticated directory.

## Durable stream and live progress

Durable events arrive strictly in Workspace sequence order, since an early event makes clients
discard the lower events it overtook; the [hub](../packages/orchestration/src/realtime-hub.ts) fills
publication holes from the store. Readers skip unknown kinds and Thread statuses, validate every
event's Workspace before changing batch state, and advance cursors in order.

A frame a client cannot read costs what [losing it costs](../packages/client/src/host/realtime-frames.ts),
and never strands the channel. A notice is dropped with the socket up and repaired by the read that
answers for it, which is not always a bootstrap: a cache the bootstrap does not touch is invalidated
directly. A replay or sync frame is never applied or acknowledged: the channel reconnects from the
same cursor, and only `host.synchronized` forgets the failures, so a frame that fails on every
connect keeps backing off. Not everything a subscribe sends follows the cursor, though: read states
come only with replayed events and a resync only with a live condition, so losing one starts over
from a snapshot at once. Replay also cannot get past an event this build will never read, so a
position that keeps failing starts over from a snapshot too. If the snapshot is unreadable too, the
connection reads Unavailable with Retry while it keeps trying on a long cap: each try can cost a
whole snapshot over cellular, and a later Host or app update must recover it unattended. Network and
foreground signals wait for that retry's time as well; only Retry skips it.

A snapshot may skip a Thread this build cannot read, because a snapshot is state at a position. An
event may not: acknowledging past a malformed Thread event would leave what the client holds stale
with nothing to repair it, so only an unknown status is skipped there. Only a Host's `host.error`
refusal stops a channel until Retry.

A browser viewer's snapshot and subscription are the whole of its state, so a viewer that cannot read
a frame reconnects on the same backoff, keeping its last picture and taking no input. Failures are
forgotten only once a socket has stayed up a while: every connect brings a snapshot, a dialog reply
and often a picture, so a frame read fine proves nothing about the next one.
Everything else stays final: a Host refusal, a Host's 4002 for what the client sent, ended access and
a frame for the wrong target.

Wire schemas must answer the same in Node, Chromium and Hermes, and `URL` does not: Chromium treats
`chrome-error:`, `chrome:` and `devtools:` as standard schemes and refuses them bare, which Node and
Hermes accept. So a Host-side parse proves nothing about a client's, and a check on a value a client
receives reads the text instead. A client view does not repeat a rule the Host enforces before
sending; rejecting a frame after it arrives protects nothing.

A failed acknowledgement send reconnects, keeping applied state. Diagnostics never log payloads,
discriminator values or validator messages, only envelope metadata and issue paths, which name
fields the wire schemas declare and mask a peer's record keys. The renderer reports its own failures
to the desktop log; the main process does not read realtime frames, but it does check that what it
is told to log names only that vocabulary, because the bridge can be called directly.

Thread and Run state are absolute and sequenced: only newer state replaces event-owned fields, and
an ended Run never returns active. Request counts come from the Host's projection, not client
inference. A response older than a retained event does not prove coverage across a reconnect
snapshot that omitted it
([Host session client](../packages/client/src/host/host-session-client.ts)).

Unopened Threads get state updates without accumulating a transcript; opening one reads fresh
history. Reconnect keeps a shown transcript and its cursor until a history read succeeds, and
rereads only when the snapshot's sequence exceeds the page's `readState.asOfSequence`. A snapshot
with `messagesOmitted` means history was not loaded, not that it is empty.

Streaming text is live progress, never durable state. It never advances a cursor or notifies and can
be lost, so complete durable text must not depend on it. Reconnect replaces old progress with whole
open streams; gaps need a reread, not invented appends
([`live-run-registry.ts`](../packages/orchestration/src/live-run-registry.ts)).

## Viewer state synchronization

Read and mute state is private, sent only to that person's connections behind the matching snapshot
or replay cut. Every subscription, including cursor resume, resynchronizes it, since shared replay
cannot recover private changes made elsewhere. Read markers merge monotonically; mute and catalog
revisions stop late reads undoing a choice. Pages carry their own bounded viewer metadata, so never
send returned IDs back in bulk reads. Pending inputs set no read position until received, and
Assignment continuations never set one.

## Conversation history

`conversationRows` in
[`agent-activity-model.ts`](../packages/client/src/host/agent-activity-model.ts) alone decides what
a conversation shows. The Host pages by whole turns and never predicts what a client draws, because
a second copy drifts; opening and Earlier scan in bounded reads until something draws. Inputs from
agents, Triggers and Opensteer never get a row or count as unread. Keeping silent wakes rare is the
waker's job, since each costs scan reads.

## Personal process recovery and diagnostics

A stopped Personal stack still belongs to its computer; route access does not establish local
supervision. The [connection supervisor](../apps/desktop/src/connections/connection-supervisor.ts)
tracks the attached Deployment, and [process supervision](../apps/desktop/src/supervisor) owns local
services. Recovery replaces only the failed component and reads the committed manifest, so a retry
cannot undo a failed update. Repair-required authority, release, keychain, port and directory
failures never trigger blind restart, and classification uses typed failures, never child output.
Child logs are bounded, private and credential-redacted. Socket diagnostics never persist endpoint
queries, frame contents, IPC connection IDs or raw surfaces.

Ordinary quit is irreversible: stop new work, cancel recovery, continue cleanup after errors, and never
reopen the app or a modal. Native browsers close without clearing their stores, then Runner, Host
and database stop in order. A lost parent control pipe must still contain process trees, including
tunnel and detached engine helpers. See
[`desktop-shutdown.test.ts`](../apps/desktop/src/app/desktop-shutdown.test.ts).

## Catalog authority

Host identity is the exact Deployment, instance and key-fingerprint tuple. Manual entries pin it and
must be re-added to change it. Account entries follow only their verified issuer and subject
directory; sync never deletes or overwrites manual entries or repoints a locally supervised Personal
Deployment. Membership projections hold no key material
([`deployment-catalog.ts`](../packages/client/src/connections/deployment-catalog.ts)).

## The place list

Account rows show only while signed in: expiry hides them, sign-out removes them. Status comes only
from an authority that can vouch for it: local supervision, the attached connection, a fresh
verified Account read or an identity-checked manual probe. A failed check is never called offline,
and a failed refresh never renews stale evidence. Only the Account refusing the refresh grant ends
its session; network failure, rate limiting and outage stay retryable
([`deployment-access-service.ts`](../apps/desktop/src/connections/deployment-access-service.ts)).
