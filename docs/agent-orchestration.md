# Agent orchestration

## Inbox authority and delivery

The Host owns delivery semantics in
[`thread-inbox.ts`](../packages/database/src/thread-inbox.ts). `report` is passive
context: it never starts or steers a Run, schedules overflow turns, or notifies a
person. `queue` is actionable work; work Threads take one input per turn.
`steer` requires a compatible active Run and never silently becomes queued work.
Human composers send `queue`; the Host applies the conversation exception below.

Queue order is independent of message sequence because people can rearrange
waiting work. Placement in history happens when a Run takes the message, after
what was said while it waited. Promotion keeps the original Message and send
identity; it neither drains reports nor rearranges other waiting inputs. Only
the original requester with current execution authority can promote a human
input. Stale targets, paused queues and incompatible Runners leave it untouched.
With active Workspace membership, people may cancel or reorder only their own
membership-authorized waiting inputs. Cancellation is allowed only before pickup; the durable record remains, but is
not presented as sent. See the inbox source for move, replay and receipt contracts.

Commands are admitted in arrival order per Thread, concurrently across Threads
([`admission-queue.ts`](../packages/orchestration/src/admission-queue.ts)).
Assignment cancellation fences its entire Assignment subtree and expands its
admission set if a delegation committed while it waited. Thread lineage is not
that subtree: a worker can serve independent later Assignments.

Steering intent is not receipt. A proven refusal restores a promoted queued
input, but cancels a strict steer. Ambiguous dispatch remains `unknown` and must
never be automatically resent, even after Run termination or Host restart.
Missing acknowledgement is not proof of refusal; Stop does not turn uncertainty
into queued work. Late positive receipts remain subject to the Run event fence.

A Run uses its own queued seed's authority, never authority borrowed from later
work. Reports must match requester, membership generation and reply target. The
Host freezes report selection with the work input under the Thread lock;
dispatch retries reuse it, and later reports wait for independently authorized
work. Report capacity cannot block actionable input. Engines receive reports
with original authorship in the task's native turn. A frozen snapshot proves an
attempt, not consumption: only provider acceptance confirms it. Unconfirmed
reports can appear in a later real Run with stable IDs; this is not exactly-once
model consumption.

In work Threads, Stop pauses admission before interruption and cancels the bound
Run's pending Requests transactionally. A person's Stop settles the Run as
interrupted even when another terminal outcome races it. Recovery cannot restart stopped work.
Pending inputs and reports survive restarts; new messages, schedules and results
do not clear the pause. Only the person who paused it or a Workspace owner can
Resume. Resume grants no execution access: each input retains its original
requester's authority. Ordinary failure does not pause the queue.

### Compatibility and projection fences

Saved Trigger program versions are immutable syntax contracts: v1 `queue` is
passive and `trigger` actionable; v2/v3 use current policies. Editing without
replacing code preserves the version. V3 separates environment discovery from
Workspace listing and requires the anchor's stored `trigger-program-v3`
capability even offline; dispatch and Watch reconciliation recheck it. Never
relabel v3 source as v2. See [shipped Trigger skills](../apps/runner/agent-skills/skills)
and [tool catalog](../packages/agent-tools/src/catalog.ts) for syntax and discovery.
Watch discovery and delegation use the intersection of program and anchor authority.

Thread state is a stored projection, not a client inference from Request events.
Run and queue mutations project synchronously; Requests mark their originating
Thread for a later durable drain. The marker follows Workspace sequence
allocation so a concurrent drain cannot clear an unseen committed change. Each
drain transaction publishes before advancing to the next Thread. Readers use
the stored count even while projection is pending; clients accept only newer
absolute state ([Connections](connections.md#durable-stream-and-live-progress)).
A live pending Request keeps a Run waiting even if its Runner reports running.

The [database lock order](../packages/database/src/lock-order.ts) is authoritative.
Projection reads take no new Run/Request locks. Complete authority and event
Workspace sets must be discovered, locked in order, then rediscovered; growth
requires rollback and retry, not another nested lock. Retryable transactions
must return only the committed attempt's events. Callbacks doing external work
cannot be blindly retried. See
[`request-workspace-locks.ts`](../packages/database/src/request-workspace-locks.ts)
and [`connection.ts`](../packages/database/src/connection.ts).

### Input context and attachments

Provider history cannot describe Host outcomes, so dispatch adds durable Thread
and Assignment context and the requester's reported time zone. Failures are
bounded quoted facts; an assigner is named only while readable. Missing or
unrecognized time zones do not block execution. Older Runners must upgrade
rather than omit required context. See
[`run-thread-state.ts`](../packages/database/src/run-thread-state.ts) and
[dispatcher](../apps/host/src/agents/dispatcher.ts).

Input attachments remain immutable Host originals. Dispatch supplies references
and a scoped download capability, never bytes or a lifetime manifest. Inventory
excludes later waiting inputs, withdrawn inputs never admitted and unselected
reports. Cached bytes are verified against Host hashes and reconstructed at
stable per-Thread paths, including attachments outside the transcript window.
Steering uses the same authorization boundary before injection.

The disposable cache lives outside private Runner state, Workspaces and system
temporary storage, with a distinct root per Runner data directory. Isolated
Linux services expose only the active Thread's directory read-only. Native-user
Runners use owner authority. Shared-service macOS advertises attachments only
for Codex and Claude, whose sandboxes deny the root and allow that Thread's
read-only directory; shared-service Windows does not advertise them because
that isolation is unverified. Unknown native image support refuses admission;
it never substitutes a text description. See [AI engines](ai-engines.md).

## Thread names and symbols

Names and symbols have independent provenance. A late generated candidate must
never replace a person's choice, including a same-value choice; one chosen field
does not prevent generating the other. Reports require the current Run binding.
Chat is identified by the Workspace's actual `homeThreadId`, not conversation
role, and cannot be renamed through ordinary Thread commands. Reusing a worker
preserves its identity. See [engine naming contract](ai-engines.md#thread-names-and-symbols)
and [Thread store](../packages/database/src/thread-store.ts).

## A person's messages in a conversation

Only a person's own messages in Chat or their owner direct message can join the
reply underway. Triggers, watches, tasks and other agents retain normal inbox
semantics. Joining requires the same requester, membership, reply target,
Assignment, engine and model; an app message cannot join a channel reply.
An ordinary message never answers a Request: only its explicit answer or Stop
releases the live approval hold.

Delivery is ordered. A proven refusal returns the message and later handoffs
not yet dispatched; those later messages cannot overtake it. Unknown delivery
is never resent and does not block following work. No timer retries refusals.
Image inputs and everything behind them wait for another Run when the holding
driver cannot steer images. Conversation handoff requires `steer-answer-v1`:
older holding Runners leave messages for the next Run and must upgrade before
dispatch, rather than accepting a message without answering it in that Run.

Stopping a conversation ends the exchange without pausing the queue. It cancels
the person's untaken inputs for that reply, including commands provably unsent.
An in-flight handoff keeps its receipt; a later refusal becomes stopped rather
than starting a new reply. Messages committed after Stop get the next reply.
Other authors' work retains its own meaning. A background deadline is not the
person's Stop and returns refused inputs to the inbox. See
[`thread-inbox.ts`](../packages/database/src/thread-inbox.ts), including settlement
of paused conversations from older Hosts. This contract requires Host API epoch 32.

## Restart steering

A Runner without native steering may advertise `attempts-v1` to restart the
same Run and native conversation. Attempts have independent binding generations
and grants, but usage accumulates on the Run. Revocation stops the superseded
attempt's tools immediately; the interrupt names that attempt so it cannot kill
the replacement. Superseded events consume ordinals without entering history,
except usage. A normal completion, failure or Stop that wins the race ends the
Run and cancels the replacement; restart never overrides it.

Recovery differs: it immediately retires the lost binding and refuses its late
ordinals. See [`run-attempts.ts`](../packages/database/src/run-attempts.ts) and
[recovery](#runs-across-connection-loss-and-restarts).

## Native subagents

Native subagents are nodes of the current attempt with its Run's authority,
not independent Assignments. Unknown nodes cannot issue tool calls or Requests.
Their words are results, not the Thread's reply. A resumed child is a new node
with the same native session reference. Nodes cannot outlive their attempt:
restart, Stop or termination interrupts them. See
[`execution-nodes.ts`](../packages/database/src/execution-nodes.ts) and
[`subagent-nodes.ts`](../packages/harness/src/subagent-nodes.ts).

## Background work

Engine-owned background work stays with its originating Run because one engine
process cannot reliably attribute later tool calls to another task. Its
Assignment stays open and Stop ends all that work. A turn's reply is published
once when the turn answers, rather than waiting for background work to end.
The Run ends only when the engine is idle, no background node lives and no wake
is pending. Claude can wake another turn on child completion; Codex does not.

The deadline starts on first entering background and survives reconnects and
Host restarts, including queued recovery. Expiry interrupts without pausing the
queue. Recovery does not republish the prior reply or resurrect attempt-owned
scripts/subagents; the resumed agent checks effects before restarting them.
See [Runner runtime](../apps/runner/src/runtime/runtime.ts).

## Warm engines

Reuse requires successful completion, release of every Run-owned turn, Request,
answer grant and background terminal, and proof that all processes remain one
contained tree. Windows cannot prove the latter and keeps no warm engine.
Stops, restarts, failures, lost leases and draining Runners end the engine.

Idle engines have no authority: credential proxies and relays refuse access.
Reuse requires the same authority, native session, launch configuration and
sandbox, including integration skill contents and computer routes. A changed
route or pinned key requires a new engine; live computer policy is still checked
on each connection. Relays are suspended and sessions closed before reuse is
considered, so a connection accepted by one Run never proceeds under the next.
Retirement must prove processes gone before that Thread executes again. See
[`warm-engine-pool.ts`](../apps/runner/src/runtime/warm-engine-pool.ts).

## Runs across connection loss and restarts

A Run belongs to a Runner boot and binding under a durable lease. Renewal is
acknowledged only after commit. Execution waits for its first correlated grant,
and the Runner stops when its lease expires. Disconnect and Host restart alone
cost no execution while the lease holds. Attach reports the complete held set;
no dispatch precedes the Host's response. Omission is meaningful, not a partial
inventory. See [`execution-recovery.ts`](../packages/database/src/execution-recovery.ts).

Lost execution resumes the same Run and native conversation with a new attempt;
Assignment, authority, queue order, reply target and background deadline remain.
Only provably never-started, unacknowledged same-boot work with a live lease can
be requeued unchanged. Recovery retires the binding, grants, live Requests and
native nodes. Never-dispatched steers return to the queue; dispatched unknowns
are never resent. Late events or renewals cannot advance the successor.

Recovery sends a Host-authored continuation describing unfinished effects, not
a replay of uncertain instructions. Unaccepted originals are quoted as context.
A further loss before acceptance reuses the unconfirmed recovery message.
Reports and initial context return only if no attempt ever started. Recovery
is bounded; missing native references, lost authority or unproven earlier-boot
containment fail visibly. Cross-boot dispatch requires
`earlier-boots-contained-v1`, advertised only after reaping proves old processes
gone. Stop and elapsed background deadlines remain terminal. Runner shutdown
contains engines without inventing a terminal Run event.

Durable events and session bindings are journaled until acknowledgement and
replayed by Run/ordinal; inability to retain events stops execution rather than
dropping them. Ended journals have bounded retention. Host boot grants each live
binding a fresh lease because it could not hear completions while down; an
expired lease is never renewed. Live progress is not journaled and is restated
on attach. Durable record fitting must not truncate the engine's actual tool
input or fail a Run merely because its output exceeds storage limits. See
[Runner runtime](../apps/runner/src/runtime/runtime.ts).

## Run tool authority

Every capability names the current attempt's grant. Tool admission needs an
active grant, live binding, matching Runner boot and non-deleting Workspace;
Runner reporting needs only the binding so a stopped Run can record its end.
Legacy tokens resolve grants by binding generation. Revocation and admission
share the Run lock: admitted work may complete, but nothing is admitted after
revocation. Revoked grants also close admitted SSH and computer-use sessions.
See [`execution-authority.ts`](../packages/database/src/execution-authority.ts).

The Thread cannot execute again until prior processes are proven gone, including
marked processes that left their process group and their unmarked descendants.
Identity checks include process start time to avoid PID reuse. New boots reap
prior executions from the same data directory. User-level inventories cannot
catch a process dropping its marker and leaving the tree between observations;
isolated Linux PID namespaces contain that escape where available. Windows
uses parent/creation-time process-tree stopping. Triggers and Watches use the
same containment. See
[`execution-containment.ts`](../apps/runner/src/runtime/execution-containment.ts).

Runner events are ordered per Run; control receipts have independent lanes.
A Request answer can hold a Workspace transaction until receipt, so another
event waiting for that Workspace must not block the receipt behind it.
Preparation and transient inspection failures keep work queued; only an
unavailable or signed-out account requires user action. Capacity belongs to
each Runner, so waiting Requests consume no other Runner's slots.

Interrupts, restarts and Request answers are replayable by command ID after
reconnect; unconfirmed steers are not. See
[dispatcher](../apps/host/src/agents/dispatcher.ts) and
[Runner socket](../apps/host/src/server.ts).

## Conversation roles and Assignments

Role controls instructions and presentation, never access. Membership,
capability profile, execution placement and tool admission remain independent.
An addressed message from person_notify alerts the Run's requester in the same
Thread without ending work; reports remain passive context for another agent.
Addressed messages are excluded from reply selection. A completed Run's last
substantive reply is the single result used by
conversations, channels and Assignments. Stopped/failed Runs have no completed
reply; interrupted answer/reasoning text already shown is retained before the
terminal event, but tool output cannot be invented as completed. See
[`run-reply.ts`](../packages/database/src/run-reply.ts).

An Assignment can span Runs, with only one open Assignment per worker. Inputs,
Runs and continuations carry its identity so a late approval cannot attach to a
new task in the reused Thread. Completion is derived transactionally, not
declared by an agent: pending Requests, inputs, children, undelivered child
results or other active Runs keep it open. Interruption leaves it open.
Completed/failed results queue to the recorded assigning Thread; cancellation
is a passive report. Reconciliation retries the stored result and receipt,
never guesses from later messages. Return requires the requester still to read
the worker Workspace; otherwise it is undeliverable.

Assignment cancellation follows Assignment descendants, not Thread lineage,
withdraws Requests, fences continuations and interrupts Runs. Events already
holding the worker Workspace publish there only; cross-Workspace creation,
cancellation and return lock both in ID order. Role/Assignment dispatch requires
`assignments-v1`. See [database sources](../packages/database/src).

Only human-rooted tasks are listed: root Threads and work handed off by a
conversation Run seeded by a human. Automation and work delegated by a task
remain nested; lineage alone does not decide listing. Promotion to listed is
permanent at runtime. Authorized direct navigation can reach unlisted work;
questions roll up to the nearest listed ancestor. Clients must not expose links
to Workspaces the reader cannot open. See
[task list model](../packages/client/src/host/task-list.ts).

### Requests waiting on a person

The pending Request list is scoped to who may answer, across their active
memberships. Dependency chains come from Assignments, not reused Thread lineage,
and stop before inaccessible links. Questions docked in another conversation
are answered through the originating Thread's authority; its composer cannot
approve them. Payload-free change notices and bootstrap rereads recover private
list changes outside subscribed Workspaces. See
[`realtime-hub.ts`](../packages/orchestration/src/realtime-hub.ts).

### A person's task list

Read positions are private; Done is shared. Done/Reopen require active membership
and the task's creator or Workspace owner. Agent write reach is narrower than
read reach: Main acts for the requester, Workspace stays local, and delegated
agents can write themselves and their Assignment descendants. Chat and active
channel conversations cannot be Done. The agent `thread_write` tool requires a Runner advertising `task-done-v1`.

Done atomically revalidates and stops the task's open Assignment subtree,
withdraws actionable inputs and Requests, pauses anchored Triggers and revokes
grants; interrupts follow commit. Reports survive and late results become
reports. The queue stays unpaused. Until Reopen, Done tasks reject actionable inputs and
delegation and admit no new Runs. Reopen neither starts work nor resumes
Triggers. An agent's own Done intent applies only after Assignment settlement
and only with no pending work or returns; otherwise it is dropped. Reopen
clears active intents. See [database sources](../packages/database/src).

Active work must not depend on how much task history was loaded: clients combine
the complete active set with their loaded history. Scoped authorization refusal
clears cached lists. Action confirmations are tied to the reviewed state and
single use; stale callbacks cannot stop newer work. See
[`action-review.ts`](../packages/client/src/host/action-review.ts).

## Pages and apps in a conversation

Durable browser use is separate from a live Run attachment. Delegated use credits
the Assignment lineage at use time; later reuse cannot credit an old parent.
Recording usage cannot delay or fail the agent command, so failed records can be
lost. Live attachment creation shares the Run fence: a late CDP answer cannot
reattach an ended Run. See
[`browser-session-store.ts`](../packages/database/src/browser-session-store.ts).

Place references are frozen with the message for idempotent retry; they grant no
access and never open sessions or request approval. Browser admission checks
sender visibility and the conversation's own CDP scope. Delegation additionally
checks provenance and the child's current access, atomically credits included
pages, and transfers no session or grant. Native human references require
computer ownership and a phone's main display, not readiness or approval;
forwarding instead requires current availability, child observe access and an
unheld phone. Actual tool use still checks execution-time authority.

External preflight stays outside database transactions. Same-key attempts share
admission; a committed replay stays acknowledged after its target disappears.
`native-place-input-v1` gates native parts throughout admission and delivery;
older callers receive address-free text projections. Wire parts never gain an
"automatic" marker the previous release refuses. Draft recovery retains all
parts. Page addresses never enter notification or channel summaries.

Browser presence reaches only authorized viewers and exposes site/title, never
path/query. Mac presence reaches only its owner. Patches cannot be overwritten
by older bootstrap reads. Live acting ends with the Run, even if a late command
answers. Agent activity never navigates the person's selected place; a place
ending may select a successor, but being offline or awaiting permission does
not mean ended. Old links stay exact and show ended state. Mac pictures name
both session and app; capture cannot follow a later agent target. Previews do
not resize pages, and switching views never redirects the agent.
See [Browser sessions](browser-sessions.md) and [Computer use](computer-use.md).

## Chat and native AI sessions

Chat is the Main Workspace's durable `homeThreadId`. The `home` alias resolves
only the caller's Chat and preserves authorship. Cross-Workspace reports may
reach it, but actionable work needs ordinary reach; the alias grants no read
or execution authority. Reports never alert. Quotes are authorized published
historical evidence, not instructions or approval receipts.

Trigger control cannot exceed the actor's access mode; definition requires full
access within the anchor's kind/scope, except Main's reach. Trigger and Watch
programs act as their anchor, never with implicit owner-wide authority.
See [tool catalog](../packages/agent-tools/src/catalog.ts).

Each Run pins the selected ProviderSession before admission. Binding, dispatch
and recovery never substitute a subsequently selected session. Explicit
continuation requires the expected selection and no nonterminal Run, creates a
fresh session, preserves waiting inputs and queue pause, and never repeats an
uncertain turn silently. Switching back does not revive stale context.

First-turn continuation history is frozen with the input and finalized once
against the live model budget. Retries reuse that subset; a later smaller route
fails rather than changes it. It is context, not a synthetic Message or another
Run, and does not guarantee room for the harness's native prompt. Unknown
acceptance never proves startup safe to repeat. Subsequent turns use native
compaction and exact resume, without importing Host history. Private state is
keyed by ProviderSession; migrated sessions retain explicit legacy layouts.
`native-session-continuation-v1` gates dispatch. See
[Runner runtime](../apps/runner/src/runtime/runtime.ts).

Durable search excludes undelivered/withdrawn work; reading an old window cannot
mark unseen later messages read.

## Starting versus resuming an AI conversation

Failed execution is not proof a provider conversation exists, or proof none
exists. Initial startup may repeat only when no native reference/accepted turn
exists and earlier attempts prove startup never occurred, including relevant
legacy Thread Runs. Runner boot loss alone proves nothing.

Once established, resume must return the exact native reference. Missing state
or failed resume stays visible; it never falls back to a fresh conversation.
Resume cannot replay Host messages or publish provider history as new Run
events. Provider compaction does not bound serialized history, so transport
limits remain necessary. All deployment shapes share the
[Runner runtime](../apps/runner/src/runtime/runtime.ts).
