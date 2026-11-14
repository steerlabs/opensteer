# Teams

A team server is the same Host software with kind `team`, for shared chat and knowledge. A team
runs it themselves or has Opensteer run it for them ([hosted teams](hosted-teams.md)). The team
server authenticates members and relays content; personal Opensteer trusts it to do both honestly.
Hostile team-server operators are outside this trust model. Membership and administrator roles
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

The desktop and mobile apps enter a team advertising `team-session-exchange-v1` without a
browser. Account signs a single-use assertion, valid for one minute, of who the person is for
that exact team Host and app; it proves identity, never membership. The team Host verifies it
against Account's published keys and, in one transaction, spends it and either signs in an active
member or admits a newcomer through the invite sent beside it. It then issues the same native
tokens a browser sign-in would. Older teams keep the browser sign-in; the app carries an invite
through it only when the team advertises `team-invite-native-continuation-v1`, because older invite
pages drop the app's sign-in. Otherwise the person joins on the invite page in their browser and
the app signs in once they come back, a member by then. An invite re-admits a
removed person only if it was created after their removal, on every admission path. The
assertion is requested and exchanged where the credential lives (desktop main, the phone's secure
storage); neither it nor the tokens reach a renderer. A team just joined shows from its verified
discovery until Account's directory lists it, and is restored from the device's connection intent
if the app restarts before then; the intent is kept even when no agent connects from that device.

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
surface, including bootstrap, subscriptions, binary routes and the link. Personal Hosts check
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
