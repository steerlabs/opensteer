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

Mentioning someone else's agent creates an ask in a task on their personal Opensteer immediately.
Its input waits behind an approval gate and counts as Needs you; opening a notification opens that
task. No model runs or names the task before consent. Approval names the exact revision the owner
reviewed, then releases it at the back of the queue only after the team acknowledges acceptance.
The owner has seven days to approve. Decline, expiry or cancellation removes a task that only ever
held terminal asks; any owner adoption or other work preserves it.
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

Each released ask or self-wake is its own queued input and Run, with an immutable destination
under the asking message, including DMs. Asking again in the same team thread continues the same
local task. The owner can edit the personal copy of an ask; its revisions stay on their computer
and never change the team message. The owner can steer that Run privately without changing its destination. Private
follow-up Runs never auto-post, though the agent can explicitly post with standing access.
The trigger's readable words stay in the private transcript with a link to the source message.
Channel instructions accompany the turn; they never grant access. Thread history is fetched
only when the agent needs it, keeping the per-turn context bounded and the engine prompt stable.

A team Run's final answer posts to its destination unless an explicit post there has already
claimed the reply. The team sees posted replies and bounded status, never a streamed private
transcript or arbitrary tool output. The private task shows whether delivery is sending, sent
or blocked, with a reason. Reconnect reconciles pending publication against its receipt without
rerunning the work or duplicating the post; revoked access or cancellation cannot resurrect it.

<a id="publication-privacy"></a>

Personal Opensteer removes private object and local-file Markdown destinations before
agent replies or notes go to a team, before messaging-bridge delivery, in Voice speech
and notes, and before plain-text excerpts and notification previews are clipped. Labels
remain readable; paths or IDs written in labels, prose or code are not redacted. Explicit
copy and share preserve the person's chosen Markdown. Unsafe unresolved frozen replies
stop visibly rather than changing their body under an existing operation ID.

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

## Names

A name is the person's, never the team's: no per-team names, and admins cannot rename anyone.
Once someone has an Opensteer Account it holds their one name, numbers every change and signs a
receipt of it ([AccountProfiles](../apps/control-plane/src/account/account-profiles.ts)). Account
cannot reach team servers, so a team takes a member's name only from such a receipt: one the
member's own app relays when the team's copy is older (`team.member.profile.apply`), or the one
in the UserInfo of a browser sign-in. Either way the team checks Account's signature and that the
receipt's Account signs in as that user, and applies it only when newer, so a late or replayed
receipt never moves a name backwards. A rename is presentation, not access: it publishes
`team.member.updated` and never moves the access revision, which would reload every session.
Handles are fixed at join, and messages reference user ids, so history shows the current name.

A personal Opensteer with no Account link owns its owner's name; it may be empty (shown as "You")
and starts as the computer account's full name until anyone sets one. Linking adopts the
Account's name, a rename while linked is saved to Account first (never queued), and unlinking
keeps the last name ([owner profile](../apps/host/src/administration/owner-profile.ts)).

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
access was lost. No action or read commits after the revocation commits on any copy. Open streams
on the committing copy close before the command returns; on other copies within notification
latency. A copy whose notification session stalls or drops re-reads the revision at every handoff
and closes its streams within about twenty seconds. A delivery racing a concurrent commit on
another copy can complete inside that window — the same class of race a single process has
between commit and its in-memory revision update.
Removing a person cuts their link; already downloaded data stays on their Mac.
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

Team API version 6 carries shared-channel state, external audiences and the asker's team. Shared
channels (including follower archives) require version 6 for apps and personal Opensteer. Older
peers see only unshared channels in discovery and cross-channel results, cannot read or write shared
channels, and receive no shared-channel requests on personal links. Version 5 remains the minimum
for unshared work because it already sends explicit request kinds. Sharing an open channel ends an
older app's subscription with an Opensteer update message.
A team Host checks only `teamApiVersion`, before authentication and parsing on every team
surface, including bootstrap, subscriptions, binary routes and the personal link. Partner sockets
negotiate their own protocol. Team updates use [deploy/team](../deploy/team/README.md); desktop
supervision updates personal Opensteer. The team API is a window like the personal one
([API compatibility](connections.md#api-compatibility)): discovery and the link's `ready` frame
advertise the team's minimum, so an app below it is told to update before it sends anything. Team
frame readers, in both directions, skip frame types they do not know, and a sender uses new
behavior only when the peer advertises its capability. The search and knowledge inputs a link
frame carries stay strict, because a dropped filter or version guard would change the answer.
Self-hosted Stable teams must keep working as apps update.

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
There is no bearer credential and no key rotation: changed identity requires revocation and a fresh
pairing.

Partner teams update on their own schedules, so the partner protocol changes additively under the
same rules as the team API, with its own `teamPartnerProtocolVersion`. A server parses its partner's
requests strictly and sends a new request field or operation only when the partner advertises a
capability for it, and an unknown one is refused like any inaccessible share. Results and frames are read
tolerantly: unknown fields are dropped and unknown frame types skipped. The pairing offer and the
signed handshake stay strict. The version moves only for a change an older partner would misread,
which [the partner wire guard](../packages/protocol/src/team-wire.test.ts) enforces.

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
attributed to its people against the writes it relayed; unconfirmed edits never replace the
accepted authorship proof. Local profile cards must name people this team recorded for that share
or its history. Imported history creates no pushes, agent requests or unread mentions. Agent context names the external team; shared rooms cannot
be treated as an internal audience for knowledge.

Sharing exposes the channel's full history, including past agent answers, and requires confirmation.
The default channel and direct messages cannot be shared. File bytes stay on the uploader's team;
the other team fetches originals and previews over the partner link and checks their size and digest
before handing them to its own authenticated clients and agents. Verified remote bytes are cached
in the receiving team's file storage and count against its quota. Deleting the message or ending
the share evicts that copy; the uploader retains its own files when the share ends. Transfers have
per-share byte and concurrency limits.
Either side may disconnect while the other is offline. The follower keeps
a readable archive, new writes stop, and the owner's channel continues. Disconnect cannot erase
already received content. Re-sharing creates a fresh share and follower channel; it never merges
archives or transfers ownership.

Each team admits work only for its own agents. A follower evaluates self and sticky wakes after its
own authenticated post commits at the owner, never from an imported row. Cross-team asks need the
target owner's approval of the task copy's revision on their computer; that approval names the
asker's team and the shared channel. Until the target team admits the ask, its reference shows Asking. Only bounded state and
public reply references cross between teams. Private returns bind to the asking team's recorded
post, target principal and share; peers cannot choose a local task or Run. Pending asks cancel on
trigger edits/deletion, participant removal or disconnect. Each team can turn off its own agents in
the channel's details; the owner's people-only setting binds both teams. Owner policy snapshots
are ordered independently of message catch-up, so a late write receipt cannot undo a restriction.
Queued relays recheck the local session, channel and request at the outbound handoff and cancel
before the corresponding removal returns. Channel instructions stay
local to each team's agents. The owner limits new ask references to 60 per share per minute, and
the target team applies its normal requester and target budgets. Partner protocol version 1 is
required for this exchange.
