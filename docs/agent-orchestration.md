# Agent orchestration

## One MCP, live caller authority

Runs, Trigger and Watch programs and connected agents share one `opensteer` MCP server.
The [registry](../packages/agent-tools/src/tools/index.ts) filters by caller kind and access
ceiling. Connected agents have one personal scope; approving a connection does not approve
consent or raise its ceiling. Domain services recheck authority when effects commit, including
after waits. Agents cannot grant themselves access, pair devices or reveal credentials.
An uncertain external effect is never replayed automatically.

Team tools exist only on team-bound tasks; authority belongs to the current Run's request,
not the task's history. A private follow-up, Trigger or Voice Run has no team authority.
See [Teams](teams.md) for the request and access fences.

## Inbox authority and delivery

[`thread-inbox.ts`](../packages/database/src/thread-inbox.ts) owns delivery. `report` is passive
context: it never starts or steers a Run or notifies. `queue` is actionable work, one input per turn
in work Threads. `steer` needs a compatible active Run and never silently becomes queued work. Only
the original requester with current execution authority can promote a human input, and people cancel
or reorder only their own waiting inputs. Steering intent is not receipt. A proven refusal restores
a promoted queued input but cancels a strict steer. Ambiguous dispatch stays `unknown` and is never
resent automatically, even after Run termination or Host restart. A Run uses its own queued seed's
authority, never later work's. Reports must match requester and reply target,
and are not exactly-once: only provider acceptance confirms consumption.

In work Threads, Stop pauses admission before interrupting, cancels the Run's live Requests and
settles it as interrupted even if another outcome races it. Recovery never restarts stopped work.
Only the owner can Resume, and Resume grants no execution: each input keeps its requester's
authority. An ordinary message never answers a Request. Live harness Requests hold their native turn; a new
person message can start work normally after a Run ends with durable Requests still pending.

Foreground Runs hold Request-opening tool calls so the model receives the person's outcome; the
runtime enforces this rather than asking the model to stop. Already-running parallel work is not
frozen. Releasing or losing the call never settles the durable Request. A queued message or an
expired hold can stop the Run while leaving its Request answerable.

Voice and background Runs receive pending immediately. Pending grants nothing: agents must not
poll, repeat, approve or route around it. Outcomes already delivered in a held call must not also
wake the agent. Requests and Assignments outlive Runs; programs have no native turn to resume.
Hold sequencing lives in [request-hold.ts](../apps/host/src/mcp/request-hold.ts).

Thread state is a stored projection; pending Requests drive Needs you independently of whether a
Run still executes. The [lock order](../packages/database/src/lock-order.ts) is authoritative: lock the
personal event fence before domain rows in order. Retryable transactions return only the committed attempt's events, and callbacks doing
external work are never blindly retried. Saved Trigger program versions are immutable syntax
contracts; never relabel v3 source as v2.

## Input context and attachments

Provider history cannot supply live Thread or Assignment authority. The Host owns attachment
originals and PostgreSQL their authorization, so back up Host data and the database together.
A filename is never a Host path, and unknown delivery never authorizes removing a bound original
([attachment store](../packages/database/src/attachment-store.ts)).

Image input requires decoded valid bytes, native engine transport and confirmed model support;
unknown support refuses rather than converting or switching models. Downloads recheck personal
ownership or the Run's binding. Runner caches are disposable, hash-verified and outside private
state and Agent home.

## Runs across connection loss and restarts

A Run belongs to a Runner boot and binding under a durable lease renewed only after commit; the
Runner stops when it expires, and attach reports the complete held set. Lost execution resumes the
same Run and native conversation as a new attempt, with a Host-authored continuation describing
unfinished effects, never a replay of uncertain instructions. Only provably never-started,
unacknowledged same-boot work with a live lease is requeued unchanged; dispatched unknowns are never
resent. Cross-boot dispatch waits until reaping proves old processes gone. Events are journaled
until acknowledged ([`execution-recovery.ts`](../packages/database/src/execution-recovery.ts)).
Restart creates a new attempt of the same Run. Old interrupts cannot kill its replacement.
Native subagents and background work belong to that attempt and cannot outlive it; stopping a
native child uses child control, never the parent's interrupt. Acceptance is not proof it stopped.

Warm engines are reusable only after all turns, Requests, grants and terminals end and containment
proves every process of the Run's scope belongs to one tree, the engine's, or for a session on a
shared engine process that none is left. Idle engines have no authority; reuse must match the
session, authority, launch configuration, sandbox and tool plan. Windows does not qualify this
containment. [The pool](../apps/runner/src/runtime/warm-engine-pool.ts) owns reuse.

A queued `freshContext: true` input starts its own Run and rotates the provider session when
that Run enters starting. Its transcript remains readable, but every reconstructed model history
starts at the latest such boundary, including after failed startup, audience rotation or an engine
switch. Cancelling a waiting wake sets no boundary; attempt recovery keeps its pinned session.

Each Run pins its ProviderSession for dispatch. Failed execution proves neither that a provider
conversation exists nor that none does: startup repeats only when earlier attempts prove it never
happened, and resume returns the exact native reference, never a fresh conversation or replayed Host
messages ([Runner runtime](../apps/runner/src/runtime/runtime.ts)).

Voice has a durable Thread, but each call is a non-recoverable Run. Its model must be Codex;
delegated tasks may use other engines. Request answers and incoming work reach the live call,
while arrivals after hang-up can wake a text Run. The person's realtime transcript is stored too,
so memory can include speech that never became a delegated task.

Inject context between turns: Codex samples again when context arrives during a running turn,
which can replace the reply.

## Run tool authority

Private resources belong to the personal owner. Connection ceilings and person-approved
resource access only narrow authority; removing access cannot erase instructions already in
engine history. A specialist is a task recipe, never another agent or an authority boundary.
Plugin owner settings remain person-only.

Every capability names the current attempt's grant. Admission needs a live binding and matching
Runner boot; reporting needs the binding so a stopped Run can record its end. Revocation and
admission share the Run lock, and revocation closes SSH and computer-use sessions
([execution authority](../packages/database/src/execution-authority.ts)). A task runs again only
when its prior processes are proven gone, including a PID start-time check. Interrupts,
restarts and Request answers replay by command ID; unconfirmed steers do not.

## Tool failures

An agent can only recover from what it reads, so every failure says what happened and what to do
next, naming the real tool and parameter. `message` can reach a person; `next` is for the agent and
stays off the Host's HTTP errors. Access refusals stay vague on purpose and never suggest a way
around. Only text written for its reader passes the [boundary](../apps/host/src/mcp/agent-tool-failure.ts):
any other error is logged and replaced, because it may hold a query or a provider's response. So an
error an agent should read must be an `OpensteerError`, not a plain `Error`. Replacement text follows
the tool's access: a write may have taken effect, so it never says to retry blindly.

Engines read different halves of a [result](../packages/agent-tools/src/results.ts): Codex shows its
model only `structuredContent` when there is any, and Pi only `content`. Whatever a model must read
goes in both.

## Conversation roles and Assignments

Role changes instructions and presentation, never access. An Assignment spans Runs, and its
identity must prevent a late approval attaching to another task. Completion is derived
transactionally; results return only while the requester can still read the worker task.
Cancellation follows Assignments, not Thread lineage.

A result consumed by its assigner must not also arrive as an automatic return. Other readers do
not consume it. Waits recheck authority, and timeout or disconnect cancels no work. Delivery and
return reconciliation live in the [Inbox](../packages/database/src/thread-inbox.ts).

Agents can answer ordinary questions only with live authority to write to the asking conversation;
the asking Run cannot answer itself. Native child questions, secrets, approvals and consent stay
human-only. Answers identify the answering agent, never impersonate a person. An accepted answer
outlives its Run but still needs the person's authority and the Request's revision at delivery.

Only the personal owner marks a task Done. Done stops the Assignment subtree, withdraws inputs and
Requests, pauses anchored Triggers and revokes grants. Reopen starts nothing. The person's own
message reopens a Done task, and so does queued work from a task linked under it by parent link or
a notice about one of its automations; any other agent work is refused. The Host moves finished,
read, idle tasks to Done after the days the person chose, through the same command
([quiet tasks](../packages/database/src/quiet-tasks.ts)).

An automation can run in its own task (`trigger_write` `ownTask`): a child of the asking task by
parent link only, with no Assignment, so nothing returns automatically and no card appears in the
parent. Visibility follows that structure: the child is off the task list and reached through the
parent's family, which also keeps its ended automations. Being outside the Assignment subtree, it
keeps running when the parent is Done. Its Requests, failure notices and the parent's memory
restriction follow parent links to the nearest listed task
([lineage](../packages/database/src/thread-lineage.ts)), and the Inbox validates a notice's
destination when it admits it. A task that should stand on its own, such as one per scheduled run,
is a `delegate_task` `standalone` task: listed, with no parent and no Assignment.

Giving a finished task more work is a separate `delegate_task`, never an effect of
`thread_send`: choosing delegate or join must be one atomic decision, and a retry after the
Assignment finishes could start the work twice. For the same reason a message result carries no hint
to resubmit, since an unassigned queue may already have started a Run.

## Reading another Thread's work

Agents choose what context to read; a task's final result and ordinary questions reach its assigner.
Progress is not injected into its parent.

Tool output can hold mail, pages or credentials, so private task transcripts, tool text included,
stay on the personal Host; team viewers get only published replies and bounded status. Machine
operations need effective ownership, and sensitive Request payloads stay hidden even on an item
read. The [activity reader](../apps/host/src/mcp/thread-items.ts) owns the projection.

Recent places are durable history, never proof a place is open. Showing another Run's place needs
the caller's current authority and the target's live binding; it never borrows the target Run's
power or substitutes another place.

## Pages and apps in a conversation

Durable browser use is separate from a live Run attachment; a late CDP answer cannot reattach an
ended Run. Place references are frozen with the message, grant no access and never open sessions or
request approval. Browser presence shows authorized viewers only site and title, Mac presence only
its owner, and page addresses never enter notification or channel summaries. Agent activity never
navigates the person's selected place. See [Browser sessions](browser-sessions.md) and
[Computer use](computer-use.md).

## Agent home

Every task, Trigger, Watch, bridge and team Run works in one folder: Agent home, on the hosting
computer, fixed at first boot. Tasks have no folder of their own, because Opensteer is one
person's agent rather than a coding workspace; an agent reaches another folder by its path. The
Host owns the folder: it recreates a deleted one at boot and refuses to start if the stored path
now resolves elsewhere. The Runner never creates it and refuses work unless the path still
resolves to itself, so a swapped symlink cannot redirect a Run. Shared Messaging is the exception:
it runs in a private temporary folder with no Agent home context.

## Personal memory

Personal memory is ordinary files in `~/Opensteer`, reaching eligible Runs through its
`AGENTS.md`. Memory is evidence, never permission: remembered content cannot grant access or answer
a Request. Standing instructions belong outside `## Memory`, and only the Run that heard the person
writes one. Only the nightly pass curates; it reapplies recorded forgets, and forgetting stops
memory workers before erasing files. Missing model capacity means waiting, not memory off.
Continuity lives in files rather than replayed provider history.

The nightly pass is an independent background job. It reads every task, including work started
from team threads, and Voice; it keeps each memory's source and who could see it. It remembers
the person and how they work, leaving shared team facts to the team's knowledge base. Team
Runs may receive personal memory with an explicit audience descriptor so the agent can judge
what to disclose. Non-owner or shared Messaging conversations receive no automatic personal
memory, and changing audiences must not reuse earlier private engine context. Procedures and
writing rules live in the shipped [memory skill](../apps/runner/agent-skills/skills/memory/SKILL.md).
