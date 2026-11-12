# Client connections

`@opensteer/client` owns discovery, routing and authentication through injected platform ports and
cannot depend on Node APIs. Start at [connections](../packages/client/src/connections) and
[auth](../packages/client/src/auth). Credential authority and Account origins are in
[Host boundaries](host-boundaries.md); focused checks are in the
[testing skill](../.agents/skills/testing/SKILL.md). Connect routes live under `opensteerapp.com`,
beside [app origins](apps.md#origins), which reach a Deployment through a stateless Worker. Connect
hostnames keep exact no-script routes so they skip it, and the Worker must be live before a Host
that returns Connect app origins ships. The Account never hosts a person's Deployment; it only records which
[hosted teams](hosted-teams.md) should exist.

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

Brief reconnects keep the Connected presentation and resume from the cursor, while answering
Requests still needs a synchronized Host. Hidden surfaces must not accrue outage time. Report
connection state without moving content. The personal event stream decides the personal
connection; team transports retry quietly and independently.
[The lifecycle](../packages/client/src/host/lifecycle.ts) owns presentation timing.

A phone can report the same network path after an actual move. Probe unchanged paths before
replacing sockets; a failed probe invalidates the whole path.

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
The Host's admission is the only gate: Connect and key resets (recovered ones too) are refused
unless the Account link is active with no unlink pending, so no client or executor checks it again.
Recover names the failed operation its device saw and is refused (`remote-access-changed`) once
another change follows it, so one device never replays another device's intent.
Every surface shows remote access through one
[view model and step runner](../packages/client/src/host/remote-access.ts), which treats a change
the Host accepted, from any device, as in progress. The latest operation, once failed, stands until
the Host records a newer one, even when the mode already matches: enable commits the route before
Account publication and disable commits Off before cleanup. An operation's `detail` is always a
sentence a person can read; raw failures go only to the redacting log. The desktop's link journal
acts only on its own personal deployment; a desktop window viewing another computer links that
Host through the challenge commands, with the desktop's Account as courier.

Account steps are journaled on the exact link before network I/O, and no Account request holds a
Host transaction or session lock. Recovery replays the idempotent step with the same external
operation identity. Unlink keeps its credential until the Account acknowledges removal. A definitive
refusal with a validated reason retires only the rejected step and keeps the credential; unknown,
malformed, reasonless and temporary failures stay journaled and visible.

Account deletion must work without a reachable Host. It revokes Connect and removes the owned
Deployments; there is no ownership transfer. A 401 alone may come from a proxy, so only the
Account's validated terminal response proves a link ended. Probe with activation, never unlink:
a diagnostic must not delete a working link. Keep local credentials until removal is confirmed.
Apple token revocation follows the deletion commit. The Sign in with Apple client secret expires,
so the Account must restart before its startup-minted secret does.

Account linking seals completion to a per-challenge Host key after verifying Host identity. The
courier and recovery journal hold only ciphertext. Commit rechecks the session and challenge, then
erases the key. Connector credentials reach only the supervisor's private executor, never owner
status payloads.

Desktop updates target only the installation supervising its Personal Host, never a team server.
The [maintenance contract](../packages/protocol/src/maintenance.ts) works below normal attachment
and independently of its epoch, with verified identity and session authentication. A desktop
without that contract needs one local update. Journal the target before native staging: any quit
can apply it, and only a new process can confirm installation. A failed handoff must restore the
Personal stack.

First-run setup's phone step composes these steps and adds no authority. With Connect its QR code
is `<portal>/open#d=<DeploymentId>`: a destination, never a pairing code, Host origin or grant. The
phone signs in to its own Account and opens that ID only from its authenticated directory.

Private mode uses Tailscale or the person's own address. Tailscale serves only the tailnet, never
Funnel, and must preserve route headers needed by session exchange. Manage only the handler this
installation created; never remove another process's handler.

A Connect QR names a destination; a private pairing QR carries a short-lived one-use secret and
needs confirmation. Neither bypasses Host authentication. Private pairing gets push only when the
computer is Account-linked and the phone is signed in to that Account.

## Durable stream and live progress

Durable events arrive strictly in personal Deployment sequence order, since an early event makes clients
discard the lower events it overtook; the [hub](../packages/orchestration/src/realtime-hub.ts) fills
publication holes from the store. Readers skip unknown kinds and Thread statuses, validate every
event's Deployment before changing batch state, and advance cursors in order.

Unreadable notices may be dropped only when an authoritative read repairs their state. Never
acknowledge an unreadable durable event: reconnect from the cursor or take a fresh snapshot when
replay cannot repair it. An unreadable snapshot backs off rather than repeatedly downloading over
cellular; explicit Retry can bypass the delay. A snapshot may omit an unreadable Thread, but an
event cannot silently leave stale state behind. The
[frame policy](../packages/client/src/host/realtime-frames.ts) owns recovery decisions.

A browser viewer keeps its last picture and refuses input while recovering. Recovery never
reroutes an ended target or converts lost access into a transient network error.

Wire schemas must answer the same in Node, Chromium and Hermes, and `URL` does not: Chromium treats
`chrome-error:`, `chrome:` and `devtools:` as standard schemes and refuses them bare, which Node and
Hermes accept. So a Host-side parse proves nothing about a client's, and a check on a value a client
receives reads the text instead. A client view does not repeat a rule the Host enforces before
sending; rejecting a frame after it arrives protects nothing.

Diagnostics must never persist frame contents, arbitrary discriminator values or validator
messages; even a peer's record keys can be secret. Desktop main validates renderer diagnostics
against the fixed log vocabulary, because callers can invoke the bridge directly.

Newer events own Thread and Run state; a late RPC cannot overwrite them or revive an ended Run.
Request counts come from the Host. Keep a shown transcript until a successful history read replaces
it; omitted history is unknown, never empty. [The session client](../packages/client/src/host/host-session-client.ts)
owns reconciliation.

Streaming text is live progress, never durable state. It never advances a cursor or notifies and can
be lost, so complete durable text must not depend on it. Reconnect replaces old progress with whole
open streams; gaps need a reread, not invented appends
([`live-run-registry.ts`](../packages/orchestration/src/live-run-registry.ts)).

## Viewer state synchronization

Visits and mute state belong to one person and must resynchronize even on cursor resume: shared
event replay cannot recover private changes from another device. Visits merge by greatest
Host-authored timestamp across frames, pages, responses and checkpoints.
Unread follows the latest Run completion; newer active work hides an older completion. Presented
replies can advance a visit before completion, suppressing their push on every device.

## Conversation history

`conversationRows` in
[`agent-activity-model.ts`](../packages/client/src/host/agent-activity-model.ts) alone decides what
a conversation shows. The Host pages by whole turns and never predicts what a client draws, because
a second copy drifts; opening and Earlier scan in bounded reads until something draws. Inputs from
agents, Triggers and Opensteer never get a row. Passive reports never make a task unread. Keeping
silent wakes rare is the waker's job, since each costs scan reads.

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
