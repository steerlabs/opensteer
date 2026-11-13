# Team knowledge

Knowledge exists only on team servers. Personal memory stays as files in `~/Opensteer`.

A topic is a category whose access list decides who reads everything in it, so nobody grants
access note by note. Grants name a person, a group (nested groups count) or everyone, at read,
write or manage; everyone is never a manager. Owners and administrators manage every topic but read
one only when granted, so they can fix a list without seeing its notes. An archived topic stays
readable and takes no writes. Knowledge is not part of channels: there are no channel topics, and
no people-only switch on topics. Every team starts with a General topic everyone can write.

A note is a title and Markdown body in one topic. Every write appends a numbered version to
[the store](../packages/database/src/team-knowledge-store.ts); a delete is a version too, and
writing again restores it. A writer names the version it read. A stale version saves nothing:
people get a conflict and keep their draft, agents get the current note back to reconcile. The
same writer repeating its exact write gets its first outcome, which is what makes a resent link
frame or a retried phone save safe without an operation key.

## Agents

A person's agent reads and writes exactly what its owner can and never manages, from any Run that
may use the owner's personal context
([`runAllowsPersonalContext`](../packages/database/src/run-personal-context.ts)), not only team
threads. Its authority is the owner's active link, rechecked on every call; a Run started by a team
thread also names its request, which only records where a write came from and lets the team answer
whether everyone in the asking channel can already read each topic (`roomCanRead`). The platform
gives the agent each topic's audience and the room's; deciding what to repeat where is the agent's
judgment, not a rule the server enforces. Keeping something from agents means not granting those
people the topic: anyone who can read a note can hand it to their agent.

Agents use three thin tools (`knowledge_topics`, `knowledge_read`, `knowledge_write`) that the
team Host serves with fixed queries. There is no agent SQL. The team audits every agent call,
allowed or refused, with ids and counts only, never titles, bodies or search words.

Writes hold the team access share lock through commit and authorize inside it; topic changes run
under the exclusive access lock, so a note write never races an access change. Buffered reads
recheck access at handoff and discard the whole answer if it was lost. See
[Teams](teams.md#access-and-removal).
