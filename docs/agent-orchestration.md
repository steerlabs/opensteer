# Agent orchestration

## One MCP, live caller authority

Runs, Trigger and Watch programs and connected agents share one `opensteer` MCP server; the
[registry](../packages/agent-tools/src/tools/index.ts) filters tools by caller kind, access ceiling
and consent reach. A connected agent starts a managed task for Run-bound tools; the Host records its
messages as that connection, never as the person who approved it. Consent reach comes from the
lineage root: Main-inheriting work reaches the person's Workspaces, other work stays in its
Workspace, specialists stay in their lineage, and shared channel conversations withhold Main
inheritance. A connection uses the reach its owner approved. Membership and live grants still apply.
Trigger and Watch programs act as their anchor, never with owner-wide authority, and the `home`
alias resolves only the caller's own Chat, granting nothing. Writes also respect the access-mode
ceiling, and Settings need full access, which never substitutes for ownership or a grant. Creating
work never raises its access mode. Domain services recheck authority when the effect commits,
including after a wait. Agents may reduce access but never grant it, approve consent, pair or enroll
devices, manage sign-in sessions, reveal credentials or raise their own power. Mutating calls carry
caller- and tool-scoped idempotency keys; a key reused with different input is rejected, and retries
rerun live authorization. The Host never repeats an uncertain external effect; an engine retry is a
new call. Waits pin the observed Run and recheck authority on wake. Disconnecting cancels only the
wait; revoking a connection ends its waits without cancelling work it started
([Thread waits](../apps/host/src/threads/thread-wait.ts)).

## Inbox authority and delivery

[`thread-inbox.ts`](../packages/database/src/thread-inbox.ts) owns delivery. `report` is passive
context: it never starts or steers a Run or notifies. `queue` is actionable work, one input per turn
in work Threads. `steer` needs a compatible active Run and never silently becomes queued work. Only
the original requester with current execution authority can promote a human input, and people cancel
or reorder only their own waiting inputs. Steering intent is not receipt. A proven refusal restores
a promoted queued input but cancels a strict steer. Ambiguous dispatch stays `unknown` and is never
resent automatically, even after Run termination or Host restart. A Run uses its own queued seed's
authority, never later work's. Reports must match requester, membership generation and reply target,
and are not exactly-once: only provider acceptance confirms consumption.

In work Threads, Stop pauses admission before interrupting, cancels the Run's live Requests and
settles it as interrupted even if another outcome races it. Recovery never restarts stopped work.
Only the person who paused or a Workspace owner can Resume, and Resume grants no execution: each
input keeps its requester's authority. In a conversation, only a person's own messages in Chat or
their owner DM can join the reply underway, with the same requester, membership, reply target,
Assignment, engine and model; Stop cancels their untaken inputs without pausing the queue. An
ordinary message never answers a Request. Live harness Requests hold their native turn; a new
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
complete authority and event Workspace sets in order, then rediscover; growth means rollback and
retry. Retryable transactions return only the committed attempt's events, and callbacks doing
external work are never blindly retried. Saved Trigger program versions are immutable syntax
contracts; never relabel v3 source as v2.

## Input context and attachments

Provider history cannot supply live Thread or Assignment authority. The Host owns attachment
originals and PostgreSQL their authorization, so back up Host data and the database together.
A filename is never a Host path, and unknown delivery never authorizes removing a bound original
([attachment store](../packages/database/src/attachment-store.ts)).

Image input requires decoded valid bytes, native engine transport and confirmed model support;
unknown support refuses rather than converting or switching models. Downloads recheck current
membership or Run binding. Runner caches are disposable, hash-verified and outside private state
and Workspaces. Shared Runners expose attachments only where their engine sandbox has qualified
isolation; an unverified platform offers none.

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
proves every process belongs to one tree. Idle engines have no authority; reuse must match the
session, authority, launch configuration, sandbox and tool plan. Windows does not qualify this
containment. [The pool](../apps/runner/src/runtime/warm-engine-pool.ts) owns reuse.

Each Run pins its ProviderSession before admission. Failed execution proves neither that a provider
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

Resource access intersects [consent reach](#one-mcp-live-caller-authority) with the
[resource guard](../packages/database/src/resource-access.ts). Main inheritance needs the lineage
root to act as the requester in their own Main. Projects need the requester's explicit grants;
browser consent also needs the grant creator's active membership, and reads never create grants.
Connection ceilings and owner Off or Main exclusions only narrow access, and cannot erase
instructions already in an engine's history. A specialist adopts its caller's access in its
Workspace, because installing it or asking an agent to make it is the consent: there are no
per-specialist bindings, and a manifest's `access` field grants and limits nothing. Only its owner's
live registration carries that access, so another member's or a removed one reaches nothing. Plugin
owner settings are never agent-reachable. A caller without Main authority cannot reuse, queue to or steer a Main-lineage
Thread; a specialist sends only reports outside its registration. Every capability names the current
attempt's grant. Tool admission needs an active grant, live binding, matching Runner boot and
non-deleting Workspace; reporting needs only the binding, so a stopped Run can record its end.
Revocation and admission share the Run lock, and revoking a grant closes its SSH and computer-use
sessions ([`execution-authority.ts`](../packages/database/src/execution-authority.ts)). A Thread
runs again only once its prior processes are proven gone, with start time checked against PID reuse
([containment](../apps/runner/src/runtime/execution-containment.ts)). Interrupts, restarts and
Request answers replay by command ID after reconnect; unconfirmed steers do not.

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
transactionally; results return only while the requester can still read the worker Workspace.
Cancellation follows Assignments, not Thread lineage.

A result consumed by its assigner must not also arrive as an automatic return. Other readers do
not consume it. Waits recheck authority, and timeout or disconnect cancels no work. Delivery and
return reconciliation live in the [Inbox](../packages/database/src/thread-inbox.ts).

Agents can answer ordinary questions only with live authority to write to the asking conversation;
the asking Run cannot answer itself. Native child questions, secrets, approvals and consent stay
human-only. Answers identify the answering agent, never impersonate a person. An accepted answer
outlives its Run but still needs valid membership, reach and Request revision at delivery.

Done needs active membership and creator or Workspace-owner authority. It stops the Assignment
subtree, withdraws inputs and Requests, pauses anchored Triggers and revokes grants. Reopen starts
nothing. Chat and active channel conversations cannot be Done.

Giving a finished task more work is a separate `delegate_task`, never an effect of
`thread_send`: choosing delegate or join must be one atomic decision, and a retry after the
Assignment finishes could start the work twice. For the same reason a message result carries no hint
to resubmit, since an unassigned queue may already have started a Run.

## Reading another Thread's work

Agents choose what context to read; a task's final result and ordinary questions reach its assigner.
Progress is not injected into its parent.

Tool output can hold mail, pages or credentials. Workspace membership alone does not grant that
text: only the person a Run acted for can read it, and machine operations also require effective
ownership. Sensitive Request payloads remain hidden even on an item read. Integration output is
stored verbatim, so these restrictions reduce exposure without making transcripts secret from
agents authorized to read them. The [activity reader](../apps/host/src/mcp/thread-items.ts)
owns the projection.

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

## Personal memory

Memory is ordinary files in Main reaching eligible Runs through Main's `AGENTS.md`; Projects and
shared channel conversations do not inherit it. The [channel admission rule](../packages/database/src/channel-store.ts)
allows Main inheritance only for an owner-linked DM routed to that owner's Main.

Memory is evidence, never permission. Remembered content cannot grant access or answer a Request.
Standing instructions belong outside `## Memory`, and only the Run that heard the person writes
one. Nightly curation reapplies recorded forgets; disabling memory must stop its workers before
erasing files. Continuity lives in files rather than replayed provider history. Procedures and
writing rules live in the shipped [memory skill](../apps/runner/agent-skills/skills/memory/SKILL.md).
