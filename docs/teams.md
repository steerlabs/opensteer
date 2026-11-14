# Teams

A team server is the same Host software with kind `team`, for shared chat and knowledge. A team
runs it themselves or has Opensteer run it for them ([hosted teams](hosted-teams.md)). The team
server authenticates members and relays content; personal Opensteer trusts it to do both honestly.
Members trust their own team server; a partner server receives no membership or personal authority. Membership and administrator roles
never grant access to another person's personal Opensteer, files, credentials or Mac. Each
person's private Opensteer has kind `personal`; only that computer runs their agent. Families
use the same team server. Operational steps live in the
[team-server skill](../.agents/skills/team-server/SKILL.md).

## One agent, owned by one person

Mentioning your own agent, or replying with your thread's agent recipient enabled, wakes your
agent. The recipient belongs to one person and one thread; other people's replies and new
threads inherit nothing. The team Host owns this state across devices.

Mentioning someone else's agent creates an ask. Every such ask needs the owner's approval in
Needs you on their own Opensteer before anything runs. Approval lets their agent use their
normal resources and post its answer in that thread. The owner has seven days to approve.
If an agent made the ask, its answer or terminal outcome returns privately only to the task
whose agent made it. The personal Host binds each return to its local post and link generation, the
posting-time agent handle, target person and ask ID. A team receipt narrows the locally parsed
mentions; renames never change those bindings. Provenance lasts at most fourteen days and is
removed after all returns settle. Asks are limited to ten per minute per requester and 32
unstarted per target per team.

The link is an outbound authenticated WebSocket from personal Opensteer. A one-time, hashed
link code establishes a revocable credential; the personal secret stays in the local vault.
The owner's agent has standing access to linked teams from any private task. The team Host
checks the owner's live membership and the agent's channel access on every read, search, file
operation and post, and audits each call. A request identifies provenance and a reply destination;
it grants no access. An unreachable durable link still makes the team available to the agent,
but operations need a connection. Disconnecting an agent revokes the person's links at the team
Host (`team.link.revoke`), so it holds while their computer is off and for links made from any device.

Each wake is its own queued input and Run, with an immutable destination in the thread under
the asking message, including DMs. Asking again in the same team thread continues the same
local task. The owner can steer that Run privately without changing its destination. Private
follow-up Runs never auto-post, though the agent can explicitly post with standing access.
The trigger's readable words stay in the private transcript with a link to the source message.
Channel instructions accompany the turn; they never grant access. Thread history is fetched
only when the agent needs it, keeping the per-turn context bounded and the engine prompt stable.

A team Run's final answer posts to its destination unless an explicit post there has already
claimed the reply. The team sees posted replies and bounded status, never a streamed private
transcript or arbitrary tool output. The private task shows whether delivery is sending, sent
or blocked, with a reason. Reconnect reconciles pending publication against its receipt without
rerunning the work or duplicating the post; revoked access or cancellation cannot resurrect it.

## Entering a team

Desktop and mobile share `NativeTeamEntry.authorize` for startup, explicit entry and recovery.
Its short-lived attempt fence handles single-flight entry, supersession and explicit team sign-out,
including queued continuations and retries. Passive callers may use or refresh a credential while
browser entry is pending; browser entry releases its slot on callback, expiry or supersession.
Recovery refreshes a rejected credential before discovery and replays only with a different
authorization. Native token refresh never exchanges an assertion or publishes logout on refusal.
Obsolete entry cleanup removes only the catalog revision that attempt created.
It is independent of Account authorization and persistent viewer state. Entry verifies fresh signed
discovery before updating the catalog or reusing a credential. With an Account session, they
enter a team advertising `team-session-exchange-v1` without a
browser. Account signs a single-use assertion, valid for one minute, of who the person is for
that exact team Host and app; it proves identity, never membership. The team Host verifies it
against Account's published keys and, in one transaction, spends it and either signs in an active
member or admits a newcomer through the invite sent beside it. It then issues the same native
tokens a browser sign-in would. Every team credential is bound to the device's Account issuer and subject, or explicitly to
no Account. Browser flows capture that binding when they start and discard and revoke callbacks
after an identity change. Legacy credentials without a binding never authorize a request. Binding and sign-out metadata
are stored separately from the previous credential format so Stable/Beta downgrades preserve Account
authorization; missing or mismatched binding metadata requires silent reauthorization.
Credential reads and refreshes enforce the binding even if deletion or revocation fails.
A `TeamRuntimeOwner` belongs to one Account issuer and subject, or explicitly to no Account.
Native OAuth creates it during hydration or identity establishment on desktop main and mobile;
the desktop renderer's team provider owns the corresponding UI runtime. An identity change
retires the outgoing owner synchronously, before asynchronous credential cleanup: its signal
aborts, transports and sockets close, viewer clients dispose, and read caches drop. It owns
the viewer's persistence handles and in-flight team file transfers, uploads, exports,
notifications and previews. Storage commits, IPC and response delivery, and OS handoffs check
that owner; aborted or completed exports erase their staged files. Team UI subtrees are keyed
by the owner id, including nested knowledge and settings screens, so no hook carries an old
Account's values into the next one. Each surface has one shared terminal and recovery gate.

Token rotation and same-Account reauthorization retain the owner and its drafts. Entry-attempt
supersession affects only entry work. Hydration preserves credentials for the saved Account.
Personal Host connections and maintenance requests are outside the team owner. Explicit team
sign-out suppresses silent entry until an explicit sign-in. Account or JWKS outages remain
retryable; membership refusals ask for an invite without a browser loop. Among entry refusals, only membership
refusals (not-a-member or removed) erase the viewer's saved state. For older servers, a reasonless
forbidden at authenticated bootstrap also removes it; channel permission failures
do not. Assertion, authority and invite
refusals preserve drafts and pending sends. An expired assertion is renewed once; another
assertion expiry remains retryable. Silent entry sends no
invite unless the person explicitly joins with one. Native browser entry requires `team-native-browser-return-v1`, including entry through an invite.
Without it, entry asks for a team server update, or an Opensteer Account sign-in on this device
when the team supports exchange; it opens no browser. Passive entry that needs a browser offers
explicit Sign in on desktop and mobile. The app carries an invite through browser entry only when
the team also advertises `team-invite-native-continuation-v1`. An invite re-admits a
removed person only if it was created after their removal, on every admission path. The
assertion is requested and exchanged where the credential lives (desktop main, the phone's secure
storage); neither it nor the tokens reach a renderer. A team just joined shows from its verified
discovery until Account's directory lists it, and is restored from the device's connection intent
if the app restarts before then; the intent is kept even when no agent connects from that device.

Drafts and pending sends are stored per team and team user, a key every Account already maps to
distinctly, so they stay in the location older apps read and survive Stable↔Beta moves. The device
uses them only after authenticated team bootstrap names that same user. An agent link's owner can
be a different person and never supplies the device's team identity.

## Access and removal

Channel membership and topic grants define access, including nested groups. A channel marked
people only excludes agents from its content, search and files, and prevents wakes there; topics
have no such switch ([knowledge](knowledge.md)). Administrators can manage access
without reading restricted content; self-adding to a restricted channel or topic is logged and
notifies its managers. Administrators cannot self-add to DMs. One-to-one DM membership is fixed;
adding someone to a group DM requires confirmation because they see its history.

Access mutations take the team access-state row exclusively before affected rows in ID order,
and terminalize affected requests and revoke affected links in that same transaction. Content
writes take its shared lock before the channel lock, recheck authority and hold it through
commit. The [lock-order registry](../packages/database/src/lock-order.ts) governs actual ranks.
Buffered reads compare the authorization revision at handoff and discard the whole answer if
access was lost. After commit, removal closes affected sockets, link sockets and file streams
before the command returns. Tests must assert **after the command returns**, not an earlier
internal point. Removing a person cuts their link; already downloaded data stays on their Mac.
The team audits agent reads, searches, posts and knowledge calls as well as admin actions.

## Invites

A team has one current reusable invite, `https://<team>/invite/<selector>#<verifier>`, that
works for 1, 7 or 30 days with unlimited or capped uses. Reset revokes it and creates the next in
one transaction. The Host verifies the verifier by digest and also seals it with a key derived
from its auth secret, so any manager can show the same link on another device; rotating that
secret leaves the link working but unshowable until a reset. The verifier travels only in the
fragment and request bodies; the invite page drops it from history. Older single-use invites stay
valid. Expiry, revocation and uses are checked inside the admission transaction, and a removed
person gets back in only with an invite created after their removal. Browser sign-in and native
session exchange both admit through `TeamInvitesStore.acceptInTransaction`
([store](../packages/database/src/team-invites-store.ts)); add no second admission path.

## Transport and versions

Team API version 5 requires version 5 peers for asks that need approval and private returns.
A team Host checks only `teamApiVersion`, before authentication and parsing on every team
surface, including bootstrap, subscriptions, binary routes and the personal link. Partner sockets negotiate their own protocol. Personal Hosts check
only the personal Host epoch. Team updates use [deploy/team](../deploy/team/README.md); desktop
supervision updates personal Opensteer.

Team servers, apps and personal Opensteer update on their own schedules, so the team API is a
window, not an exact match ([authority.ts](../packages/deployment-authority/src/authority.ts)):

- Each side states its own `teamApiVersion` and serves any peer at or above its own
  `minimumTeamApiVersion`. A newer peer is admitted, because it learns this side's version from
  discovery or the link's `ready` frame and enforces its own minimum. Discovery also advertises
  the team's minimum, so an app below it is told to update before it sends anything.
- Changes are additive by default and keep the version: new commands, reads, optional fields
  and frame types. The team Host parses commands and reads strictly, so a client uses a new
  input only when the team advertises a capability for it. Every other reader is tolerant:
  replies and realtime and link frames, in both directions, drop unknown fields, and frame
  readers skip frame types they do not know. A sender relies on a new field or frame type only
  when the peer's version reads it. Two things stay strict: the signed discovery document, and
  the search and knowledge inputs a link frame carries, because a dropped filter or version
  guard would change the answer.
- Bump `teamApiVersion` only for a change an older peer would misread or refuse. Whoever bumps
  decides `minimumTeamApiVersion`: keep the old version and speak it to older peers, or raise
  the minimum and strand them with an update message.
- A refusal names the side that is behind: the app or personal Opensteer says "Update
  Opensteer", and a team older than the peer's minimum says the team server needs an update.

[The team wire guard](../packages/protocol/src/team-wire.test.ts) holds a snapshot of every team
schema as its reader parses it and fails on a non-additive change unless the version moves.

First-owner setup expires after 24 hours; restarting with the same token does not renew it.
Rotating only that token and recreating the Host opens a fresh setup window while no owner exists.
Once claimed, token rotation cannot reopen setup. The Host keeps only the token's digest, so a
provisioner that must never hold the token configures `OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN_DIGEST`
instead. Account adoption requires a publicly reachable HTTPS origin at first-owner setup, such as a
public hostname or Tailscale Funnel. Private-only tailnet access works for members after setup;
it cannot satisfy Account's pinned public proof fetch. Keep that SSRF boundary intact.
Teams have no Connect routes in v1. Native apps combine personal and team views; web stays
per-origin and opens the team at its own address.

Files use authenticated routes that recheck access, with fixed byte limits and cancellation on
revocation. An optional team storage limit counts every stored or unfinished upload; an upload
reserves its bytes before any are written, so concurrent uploads cannot overshoot it. A file
stays reserved until its bytes leave the disk; deleting a message, cancelling an upload or
removing a person frees the files no message holds before the command returns, and other unsent
uploads expire after a day. Link credentials and request provenance belong in headers, never URLs. Mobile push uses
generic text and sealed previews through Account; no plaintext team content enters the push
provider. Desktop notifications come from team sidebar sockets; there is no Web Push.

## Partner teams

Partner links are separate from person-owned agent links and grant no content access by themselves.
The redeemer is always the dialer; the issuing team never fetches a partner-chosen address. Hosted
teams dial public addresses only. Each side pins the other's signed team identity, origin, Host key
and instance, then proves possession of that key against fresh challenges on every connection.
Partner protocol compatibility is independent of the team-client API window. There is no bearer
credential and no key rotation: changed identity requires revocation and a fresh pairing.

Sharing defaults to administrators. An unaddressed invite still needs the issuing team's approval
after it learns the redeemer's identity; members-propose requires local admin approval on both sides.
The members policy allows member approvals and automatic acceptance. Turning sharing off closes
connections and retains proposals and approvals; turning it back on reconnects them. Either team can
revoke unilaterally, closing its sockets before returning and notifying the other when connected.
A dialer learns a listener’s offline revocation at its next authenticated connection.

## Shared channels

A linked partner receives content only after a channel share is offered and accepted under each
team's sharing policy. The owning team orders and authorizes every write; the partner serves its
own local copy and relays its people's writes over the existing authenticated partner connection.
Remote authors are content principals, never members, and gain no access to other channels,
knowledge, sessions or personal Opensteer. The partner protocol names only share IDs and public
message IDs; each receiving team maps them to its own local keys. A follower verifies rows
attributed to its people against the writes it relayed, and imported history creates no pushes,
agent requests or unread mentions. Agent context names the external team; shared rooms cannot
be treated as an internal audience for knowledge.

Sharing exposes the channel's full history, including past agent answers, and requires confirmation.
The default channel and direct messages cannot be shared. File bytes stay on the uploader's team;
the other team fetches originals and previews over the partner link and checks their size and digest
before handing them to its own authenticated clients and agents. Remote files have no persistent
cache, and stop working when the share ends; the uploader retains its own files. Transfers have
per-share byte and concurrency limits. Agent wakes in shared channels are not available yet.
Either side may disconnect while the other is offline. The follower keeps
a readable archive, new writes stop, and the owner's channel continues. Disconnect cannot erase
already received content. Re-sharing creates a fresh share and follower channel; it never merges
archives or transfers ownership.
