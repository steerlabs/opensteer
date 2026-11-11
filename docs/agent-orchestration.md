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

A foreground Run outside voice holds a tool call that opens its own durable Request until the
person answers, then receives the real outcome. The runtime enforces this boundary rather than
asking the model to stop. Work already running beside the call (native subagents, parallel calls
and background shells) is not frozen until the Run stops.

If the hold reaches its limit or a person's message queues behind the Run, the runtime stops the
Run without pausing the Thread. The Request stays open; its later answer wakes the agent. A message
steered into the Run releases the call as still open so the agent can read it; the message never
answers the Request. Leaving the foreground also releases the call as still open. Stop, restart,
lease loss or disconnect can end the call without settling the Request. A live harness Request in
parallel does not end the hold.

Voice and background Runs receive pending immediately. Pending grants nothing; agents must not
poll, repeat, approve or route around a Request. pending_request shows status, not the answer. Outcomes
returned in the held call need no later wake-up. Otherwise, eligible outcomes from one Run arrive
together after its durable siblings settle. A newer Run can also release older settled outcomes,
so an abandoned ask cannot hold up later work. Different Runs stay independent. Requests and
Assignments outlive a Run. Programs receive pending with no continuation: Trigger Occurrences have
no native turn to resume.

Thread state is a stored projection; pending Requests drive Needs you independently of whether a
Run still executes. The [lock order](../packages/database/src/lock-order.ts) is authoritative: lock the
personal event fence before domain rows in order. Retryable transactions return only the committed attempt's events, and callbacks doing
external work are never blindly retried. Saved Trigger program versions are immutable syntax
contracts; never relabel v3 source as v2.

## Input context and attachments

Dispatch adds Thread and Assignment context, which provider history cannot describe
([`run-thread-state.ts`](../packages/database/src/run-thread-state.ts)). The Host keeps immutable
attachment originals and PostgreSQL their authorization, so back up the database and Host data
directory together. Filenames never become Host paths, and clients upload bytes, never a local path.
An original belongs to one human message and is never deleted while bound; editing queued input
moves attachments only after explicit withdrawal, and unknown delivery is not withdrawal
([`attachment-store.ts`](../packages/database/src/attachment-store.ts)). Images are validated by
actual bytes and full decoding. Image input needs native engine transport and catalog-confirmed
model support, rechecked at dispatch and steer; unknown support refuses, never converts or switches
models. Engines fit images themselves, so there are no per-model size tables. Web HEIC decoding uses
`heic-to` (LGPL-3.0) in a blob worker, hence the CSP's blob workers. Dispatch sends references and a
scoped download capability, never bytes; downloads recheck personal ownership or the Run's binding, and
never expose waiting inputs or unselected reports. The Runner cache is disposable, hash-verified and
outside private state, task folders and system temp.

## Runs across connection loss and restarts

A Run belongs to a Runner boot and binding under a durable lease renewed only after commit; the
Runner stops when it expires, and attach reports the complete held set. Lost execution resumes the
same Run and native conversation as a new attempt, with a Host-authored continuation describing
unfinished effects, never a replay of uncertain instructions. Only provably never-started,
unacknowledged same-boot work with a live lease is requeued unchanged; dispatched unknowns are never
resent. Cross-boot dispatch waits until reaping proves old processes gone. Events are journaled
until acknowledged ([`execution-recovery.ts`](../packages/database/src/execution-recovery.ts)).
Restart steering makes a new attempt of the same Run; revocation stops the old attempt's tools, and
its interrupt cannot kill the replacement. Native subagents are nodes of the current attempt and
cannot outlive it. Their own messages, reasoning and tools are retained separately from the
parent transcript and delivered only while a client watches that node or an agent reads it with
`thread_read`. The parent carries the node's lifecycle and a short live progress line. A node's
Stop uses its engine's per-child control, never the parent's interrupt. Only someone allowed to
stop its Run, or that Run's own agent, can ask, and both admission and dispatch fence the current
attempt and authority. Engine confirmation ends the node; acceptance alone says Stopping. Engine background work stays with its Run, since one engine process cannot
attribute later tool calls to another task. Warm engines are reused only after a successful Run
released every turn, Request, grant and terminal, with all processes proven one contained tree;
Windows cannot prove that and keeps none. Idle engines have no authority. Reuse needs the same
authority, session, launch configuration, sandbox and tool plan, and relays are suspended first, so
a connection accepted by one Run never proceeds under the next
([`warm-engine-pool.ts`](../apps/runner/src/runtime/warm-engine-pool.ts)).

Each Run pins its ProviderSession before admission. Failed execution proves neither that a provider
conversation exists nor that none does: startup repeats only when earlier attempts prove it never
happened, and resume returns the exact native reference, never a fresh conversation or replayed Host
messages ([Runner runtime](../apps/runner/src/runtime/runtime.ts)).

Voice is a separate permanent Thread, the person's spoken entry, and a call is one
non-recoverable Run on it. Codex hands each utterance to a turn on that same Thread, so a call has
the personal tool set: it opens Requests, starts tasks and hears what they return. Because a call's
Run stays open between turns, everything sent to its Thread is handed in at once, as a steer, and a
Request's answer is released without waiting for the Run to end. What arrives after hang-up wakes an
ordinary text Run on the Thread, which notifies the person. A call takes the Thread only once
nothing else runs there, so the Host stops what is running and tries again. The Thread's model is
its own and must be a Codex model; tasks it starts can use any engine.
The person's side of a call is stored from the realtime transcript, so memory hears asides the
voice answers alone, not only what it hands to Codex.
Context for the agent waits between turns: Codex samples again for anything injected into a running
turn, and that second answer would replace the reply.

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

Role controls instructions and presentation, never access. Only a Run answering the person directly
may use `person_message` or `person_show`; a task answers its assigner, which shows what the task
reports. A completed Run's last substantive reply is its single result ([`run-reply.ts`](../packages/database/src/run-reply.ts)). An
Assignment spans Runs, one open per worker, and its identity travels with inputs so a late approval
cannot attach to a new task. Completion is derived transactionally, never declared by an agent;
results return only if the requester can still read the worker task. Siblings started by one
Run, program occurrence or Watch observation share one waiting return under the same requester,
reply target and Assignment authority. Each keeps its title and id; long results are shortened
with a pointer to `task_status` or `thread_read`. Taking the message for a Run, steering it or
offering it to an engine seals its contents; later results start another return. Rewriting a
waiting return rechecks access to every included result. A settled result read by its assigner
through `thread_wait`, `delegate_task` mode `wait` or `task_status` is delivery: the same locked
transaction removes only that result from a waiting return, withdrawing the message when none
remain. A return already claimed by a Run owns delivery instead. Only the originating Run or
program source consumes a result; other readers consume nothing. A live assigner's wait holds
automatic return in PostgreSQL until it reads the result or ends. Timeout, cancellation, lost
authority and source settlement release the hold; Host startup releases waits lost on restart.
Unconsumed results stay in the return outbox for reconciliation. An empty result wakes nobody unless a
parent Assignment needs it, but a waiter still receives its settlement. Bounded waits subscribe
before reading, pin their observed Run and recheck live authority on wakes and before return; a
timeout cancels no work. Cancellation follows Assignments, not Thread lineage.
An ordinary question is answerable by any agent whose live authority and access ceiling
allow writing to the conversation that asked it, except the asking Run itself. The direct assigner
alone receives a Host-authored notice, unless its wait already delivers the question; program tasks
and native engine subagents send no such notice. A person can always answer too, and the first answer
wins. Native engine subagent questions, secret fields, approvals, access, sign-ins, credentials and
other consent remain human-only. Agent answers
name the answering Run and conversation, never the person. An accepted answer outlives the Run that
gave it: delivery rechecks the person's authority and access and the Request's revision, not
that the answering Run is still live. Only the personal owner marks a task Done. Done stops the
open Assignment subtree, withdraws actionable inputs and Requests, pauses anchored Triggers and
revokes grants; Reopen starts nothing. A person's own message reopens a Done task they could reopen
by hand, in the same transaction; other writers are still refused. The Host itself moves its
creator's finished, read, idle tasks to Done (`doneReason: "quiet"`) after the days they chose,
through the same Done command re-checked under its locks
([quiet-tasks.ts](../packages/database/src/quiet-tasks.ts)); a Host change to the task or its
creator reading it restarts that clock. A task moves in lists only when a person asks it for
something (`askedAt`).

Giving a finished task more work is a separate `delegate_task`, never an effect of
`thread_send`: choosing delegate or join must be one atomic decision, and a retry after the
Assignment finishes could start the work twice. For the same reason a message result carries no hint
to resubmit, since an unassigned queue may already have started a Run.

## Reading another Thread's work

The platform gives agents tools to get context and the agent decides what it needs. Nothing about a
task's progress is injected or pushed; its final result and ordinary questions reach its assigner.

The `activity` view of `thread_read` is summary-first. Events give one ordering, and message text
comes from published rows, so waiting inputs never appear. Tool text is clipped and arguments are
absent unless the call names that item. Private task transcripts, including tool text, stay on the personal Host. Team viewers get only
published replies and bounded status, because tool output can contain private pages, mail or codes. Node items carry title and status, Request items kind and title, never
a prompt, result or payload. `sign_in`, `use_card`, `trigger_write` and `computer` keep status and
title even by item, because they can carry a credential, a webhook secret, typed values or a phone
PIN, and so does a completion with no resolvable start. A tool call naming a Mac app or phone is
hidden unless the reader is that machine's effective owner, and a place attached to a message
becomes a plain label for a reader who couldn't open it.

This reduces exposure and does not remove it: integration output is stored verbatim, so the person
a Run acted for, through any agent that reaches the Thread, can read an SMS code it returned.

`recentPlaces` means recent, never live. It comes from durable `place.entered` events, filtered for
the reader as [`latestPlaces`](../apps/host/src/browser/browser-service.ts) filters, and nothing is
drained before reading. It never proves a place is still open.

`person_show` with a `runId` shows another Run's place after the same Assignment refusal as any
show. It needs reach to the target Thread, not write access, so a read-write voice Run can show a
full-access task's page. It runs the `current` path against the target Run: a Mac app needs a live
session of that Run and is refused rather than substituted, a phone needs its effective owner, and a
browser is authorized with the caller's actor, never the target Run's. The place names the target
Run while the message stays the caller's.

## Pages and apps in a conversation

Durable browser use is separate from a live Run attachment; a late CDP answer cannot reattach an
ended Run. Place references are frozen with the message, grant no access and never open sessions or
request approval. Browser presence shows authorized viewers only site and title, Mac presence only
its owner, and page addresses never enter notification or channel summaries. Agent activity never
navigates the person's selected place. See [Browser sessions](browser-sessions.md) and
[Computer use](computer-use.md).

## Personal memory

Personal memory is ordinary files in `~/Opensteer`, reaching eligible Runs through its
`AGENTS.md`. Memory is evidence, never permission. Standing instructions remain separate from
`## Memory`; only the Run that heard the person records them. Forgetting must survive the next
curation pass. Only the nightly pass curates memory; other Runs write what the person asks
for or raw inbox scraps. Missing model capacity means waiting, not memory off, and forgetting
waits until memory workers have stopped before erasing files.

The nightly pass is an independent background job. It reads every task, including work started
from team threads, and Voice; it keeps each memory's source and who could see it. It remembers
the person and how they work, leaving shared team facts to the team's knowledge base. Team
Runs may receive personal memory with an explicit audience descriptor so the agent can judge
what to disclose. Non-owner or shared Messaging conversations receive no automatic personal
memory, and changing audiences must not reuse earlier private engine context.
See the shipped [memory skill](../apps/runner/agent-skills/skills/memory/SKILL.md).
