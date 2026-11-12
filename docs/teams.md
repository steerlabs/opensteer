# Teams

A team server is the same Host software with kind `team`, self-hosted for shared chat and
knowledge. Each person's private Opensteer has kind `personal`; only that computer runs their
agent. Team owners and administrators gain no access to anyone's personal Opensteer, files,
credentials or Mac. Families use the same team server. Operational steps live in the
[team-server skill](../.agents/skills/team-server/SKILL.md).

## One agent, owned by one person

Only a person's own agent mention wakes their agent. Other people's agent mentions are inert
references; agent messages never wake agents. Requests are limited to ten per minute and 32
queued per owner per team. Replies always belong in the thread under the asking message,
including DMs. The team sees posted replies and bounded status, never a streamed private
transcript or arbitrary tool output.

The link is an outbound authenticated WebSocket from personal Opensteer. A one-time, hashed
link code establishes a revocable credential; the personal secret stays in the local vault.
Machine calls name a request over that link. The run ticket is the request row itself, scoped
to team, channel, thread and owner, expiring seven days after first acceptance. Every call
rechecks it. No link means no request; an offline computer leaves accepted work durably queued.

Each ask is its own queued input and Run, not a steer. Asking again in the same team thread
continues the same local task, whose folder stays fixed. A private follow-up has no team
request authority. Channel instructions and recent thread context are read when the Run starts;
the agent can fetch older context. Audience/source descriptors accompany team context, but
instructions never grant access. Publication uses that Run's final reply unless it already
posted an explicit reply; reconnect recovers pending publication without rerunning failed work.

## Access and removal

Channel membership and topic grants define access, including nested groups. Attaching a topic
grants nothing. Either a channel or a topic marked people only excludes agents from its
content, search, files and SQL, and prevents wakes there. Administrators can manage access
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
The team audits agent reads, searches, posts and knowledge queries as well as admin actions.

## Transport and versions

A team Host checks only `teamApiVersion`, before authentication and parsing on every team
surface, including bootstrap, subscriptions, binary routes and the link. Personal Hosts check
only the personal Host epoch. A mismatch tells whichever side is behind to update. Team updates
use [deploy/team](../deploy/team/README.md); desktop supervision updates personal Opensteer.

First-owner setup expires after 24 hours; restarting with the same token does not renew it.
Rotating only that token and recreating the Host opens a fresh setup window while no owner exists.
Once claimed, token rotation cannot reopen setup. Account adoption requires a publicly reachable HTTPS origin at first-owner setup, such as a
public hostname or Tailscale Funnel. Private-only tailnet access works for members after setup;
it cannot satisfy Account's pinned public proof fetch. Keep that SSRF boundary intact.
Teams have no Connect routes in v1. Native apps combine personal and team views; web stays
per-origin and opens the team at its own address.

Files use authenticated routes that recheck access, with fixed byte limits and cancellation on
revocation. Link credentials and request IDs belong in headers, never URLs. Mobile push uses
generic text and sealed previews through Account; no plaintext team content enters the push
provider. Desktop notifications come from team sidebar sockets; there is no Web Push.
