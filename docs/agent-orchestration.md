# Agent orchestration

Messages between Threads enter the durable Thread Inbox with one explicit delivery policy:

- `report` records passive context. It never starts a Run and never steers one. A later real Run
  receives pending reports as context. A report never notifies anyone: people are notified when an
  agent replies to them, when a Request needs them, or when a Run they were waiting on fails
  ([Notifications](mobile.md#6-notifications)). To tell the person something, `queue` it to the
  agent that talks with them; that agent's reply is the notification.
- `queue` is actionable. It starts an idle Thread, or waits while the Thread is busy. Each queued
  input gets its own turn in queue order, which is send order until a person rearranges it;
  finishing one turn admits the next. Explicitly stopping a work Thread's Run pauses its input
  queue so queued work does not start unexpectedly. A person's own message in a conversation is
  the exception: it joins the reply under way (see
  [A person's messages in a conversation](#a-persons-messages-in-a-conversation)).
- `steer` targets a compatible active Run. It fails with a conflict when the Thread has no Run that
  can accept steering; it never silently becomes queued work. An engine that steers natively takes
  the message mid-turn; any other restarts the Run with it (see [Restart steering](#restart-steering)).

`thread_message` requires the caller to choose a policy. Human composer sends always use `queue`;
the Host, not the client, decides what that means for the Thread's role.
`thread.inputQueue.get` exposes the durable queued messages; clients do not schedule them or infer
them from the Run queue. It lists only queued messages that no Run has picked up: a message that
seeds a queued Run, or that a promotion has handed to one, belongs to the transcript. Each item says
whether the reader may Steer or cancel it. While a work Thread's work is active, each eligible
queued message offers **Steer**; a conversation offers no queue controls. `thread.input.cancel` takes back one of the reader's own queued messages before a
Run picks it up, and answers with a conflict once one has; the input is cancelled with reason
`withdrawn`. The Message row stays in the durable ledger, the workspace snapshot omits it, and
clients replace it in the conversation with a withdrawal marker, so it is never shown as sent.
Protocol epoch 13 requires the cancel command.
`thread.input.steer` promotes that same Message to the explicitly expected active Run, under the
[declared database lock order](../packages/database/src/lock-order.ts). It never creates a second Message. The original queue policy,
send fingerprint, and idempotency key remain unchanged; the promotion has its own idempotency key.
Only the original requester with current execution authority may promote a human input, and only
to a compatible Run whose Runner, by its last signed advertisement, can take it: through its
engine's own steering, or by restarting the Run (`attempts-v1`). A stale Run, paused queue,
changed authority, or a Runner that can do neither leaves the message untouched. Protocol epoch 11 requires
this queue read and promotion contract. A paused input queue remains durable and can be resumed
with `thread.inputQueue.resume`.

Queue order is `thread_inputs.queue_rank`, not message sequence. A new input takes its message's
sequence as its rank, so unrearranged work stays first-in, first-out. `thread.input.move` stands one
of the reader's own waiting messages in front of another waiting message, or at the back when
`beforeMessageId` is null, by handing the ranks the queue already holds out again in the new order;
work sent afterwards still lands behind all of it. A move naming a message that has left the queue,
as either side, is refused with a conflict rather than guessed at, and a replayed key never applies
over a newer arrangement. Each queue item carries `canMove`, and a move emits
`thread.input-queue-updated`. Clients show only people's messages in the composer tray; follow-ups,
delegation results and automation runs wait in the same queue, and a tray marks its first message as
next only when the queue's first item is that message. Protocol epoch 18 requires the move command.

The Host admits commands for one Thread in the order it receives them and commands for different
Threads side by side ([`KeyedAdmissionQueue`](../packages/orchestration/src/admission-queue.ts));
row locks keep them correct, and a command whose transaction lost a deadlock is run again.
Assignment cancellation holds admission keys for every Thread in its subtree. It rereads that
subtree after admission and releases and reacquires the expanded key set if an earlier delegation
added a descendant while it waited. Holding every parent Thread prevents further delegation
until cancellation finishes.

A queued message joins the conversation where a Run takes it, not where it was sent. When a
message seeds a Run or a promotion hands it to the running one, the Host gives it the Thread's next
message sequence, so everything said while it waited comes before it in history, and emits
`message.placed` with the placed Message. Clients move the message's transcript entry to that event,
and a message found on two history pages keeps the later page's place.

Follow-ups remain pending inputs while a nonterminal Run exists. They reserve neither a future
Run nor its budget or execution settings. Finalization admits the oldest eligible queued input;
an idle Thread still creates an admission-queued Run immediately. Explicit promotion may take a
selected message ahead of other queued messages without draining or reordering the remaining queue.

Steering receipt is separate from intent. A promoted input is `claimed` until the Runner proves
injection with `message.injected`. A proven refusal restores the original queued input; a strict
`steer` input is cancelled instead. An ambiguous transport outcome is `unknown`, remains visible
as unconfirmed, and is never automatically resent—even after the target Run ends or the Host
restarts. Terminal cleanup restores a promotion only when its command was provably not dispatched;
it does not mistake a missing acknowledgement for a refusal. A late positive receipt can confirm
delivery while the Run's event fence still permits it. Stop does not silently turn uncertainty
into queued work. Runner command outcomes distinguish proven rejection from uncertain delivery.

Schedules, webhooks, manual Trigger runs, delegations, and request continuations use `queue` because
they represent work to perform. Status reports and observations that should only inform the next
real task use `report`.

Trigger program objects declare `toolContractVersion`, which versions the program's tool input
syntax; tool results use current canonical receipt policies. Version 3 uses the policies above and separates `environment_list` discovery from
`workspace_list`, which returns only Workspaces and its window. Saved version 2
programs keep the previous `workspace_list` discovery inputs and results and use
the policies above.
Version 1 is the immutable compatibility contract for saved programs: its `queue` is passive
context and its `trigger` is actionable work. Editing a Trigger without replacing its program preserves that
version; replacing program code must explicitly retain version 1 or migrate the code and select
version 3. Version 3 requires the anchor computer's stored Runner advertisement to
include `trigger-program-v3`, even when the computer is offline. Creating or updating
an unsupported v3 program is refused: use version 2 or update that computer. Dispatch
and Watch reconciliation recheck support, so a later downgrade fails the occurrence
or records the Watch activation's backoff reason without sending the program. The Host
never relabels v3 source as v2. Legacy Runner agent sessions retain the inline v1/v2
`trigger_write` runtime contract; current Runners deliver `opensteer-triggers` to every
profile with Trigger tools. Protocol epoch 7 requires this explicit contract on newly authored programs.

Agents that can delegate can call `environment_list` to discover their inherited
selection and authorized environments and engine profiles. Profiles retain their
account-specific IDs; models use canonical provider/model pairs and compact live
options with string select values or boolean toggle values. Disabled, disconnected
and unready profiles are distinct from ready catalogs with no query matches.
Omitted, empty and whitespace-only `query` values normalize to absent at both the tool and RPC
boundaries. They share unfiltered results, omitted counts and model cursors.
`query` matches every word, case-insensitively, across model/provider IDs, model
display name, engine name and driver kind before limiting models. Catalog order
is preserved: at most eight models per profile and forty per reply, with
`modelsOmitted` counting remaining matches. Model metadata and options retain the
live catalog's bounds (16 options, 32 select values). Whole model entries share a
256 KiB budget, so option-heavy replies may contain fewer than eight models; no
allowed option value is shortened or dropped. A single entry above that bound is
refused with a metadata-limit error. Focus `harnessInstanceId`
and follow `modelsNextCursor` as `cursor`; a cursor is bound to that profile,
normalized query and catalog contents and is refused after a change. Directory
pages contain at most 64 environments and 64 profiles: follow
`environmentsNextCursor` as `environmentCursor` and `harnessesNextCursor` as
`harnessCursor`. A focused profile resolves its environment even beyond the first
directory page. Discovery reads no Workspace or Thread pages. Watches may discover
and delegate only within the intersection of their program and anchor authority.
Legacy `workspace.inspect` retains its strict shape and 20/100 model limits.

The Host owns these semantics. `thread_inputs` is a delivery ledger shared by all three policies;
`thread_work_inputs` is the scheduler's queue-only view. A database guard prevents inserting a Run
whose seed is a report or steer. New Runs use their own queued message as both seed and activation,
so a later task cannot lend its authority to older reports. Explicit steering never drains reports.

When a queued Run is claimed, the Host freezes its work input and report context under the Thread
lock. Reports must match the Run's requester, membership generation, and reply target. Their causal
chains do not divide context into additional work. The Run stores the selected report IDs, snapshot
sequence, and omitted count. Dispatch retries reuse that exact snapshot. Reports arriving afterward
wait for another independently authorized Run.

The Runner receives actionable `inputs` and a separate `reports` field. Every engine includes the
reports, with their original authorship, IDs, and timestamps, in the same native turn as the task.
Resuming an engine conversation does not replay Host history. At most 50 reports and 512 KiB enter a
snapshot; an omission notice points to `thread_read`. Omitted reports stay available and cannot
schedule overflow turns. Pending report capacity is separate from work capacity, so a full report
inbox cannot block a person's task.

An engine's own history cannot show how a Run ended on the Host, so every Run command also carries
`threadState`, read from durable Run and Assignment records at dispatch
(`packages/database/src/run-thread-state.ts`), and `requesterTimeZone`, the IANA zone the
requester's client last reported with `viewer.timeZone.update` (null when none has). Every engine
states them ahead of the first input as one `[Opensteer thread context]` block: the person's time
zone and their local time when the Run started, in words and as an ISO-8601 local time with its
offset, or that the zone is unknown and the agent should ask before scheduling for a clock time;
the Run's task, or "none" once the Thread has had one; the previous Run when it failed or was
stopped; and how the Thread's previous task ended and whether its outcome reached the assigner.
The block holds facts only, with a failure quoted and bounded. The assigner is named only while
the requester can still read its Thread. The wire checks the zone's shape only, so a Runner whose
time zone data lacks a name the Host accepted still runs the Run and says it does not recognize
the zone. The dispatcher requires Runner capabilities `thread-state-v1` and
`requester-time-zone-v1`, so an older Runner gets an explicit upgrade error instead of Runs without
this context.

Attachments on an accepted input remain immutable Host originals. The Run command carries stable
references and a scoped download capability, never file bytes or a lifetime manifest. Before the
provider turn starts, the Runner pages the Host inventory of previously delivered references plus
the current frozen input and selected reports. The Host excludes later queued inputs, withdrawn
inputs never admitted, and unselected reports. The Runner verifies every cached file against its
Host SHA-256, restores missing or changed bytes, and gives the harness an absolute path in its own
per-Thread cache. It clears that disposable cache after the Run; a resumed provider session gets
the same paths reconstructed from the Host inventory, including files older than the bounded
transcript window. A steer obtains its newly authorized references through the same inventory
before injection.

The disposable cache sits under the Runner user's home cache, outside Runner private state,
Workspaces, and the system temporary directory. Each Runner data directory gets its own root. An
isolated-service Linux Runner masks the shared cache root and binds back only the active Thread's
directory read-only. A native-user Runner uses its owner's file authority. On macOS shared-service
Runners, only Codex and Claude advertise attachments: their provider sandboxes deny the cache root
and grant the current Thread's directory read-only. Windows shared-service Runners do not advertise
attachments because that per-Thread path policy is not verified there. Provider adapters render
generic files as readable paths and send
images through their confirmed native input format. A route with unknown or unsupported native
image capability refuses the image before admission; it never substitutes a text description.

A frozen snapshot records an attempted delivery; `run.started` records provider acceptance. If a
Run ends before acceptance is confirmed, its reports remain `unknown`. A later real Run can include
them again with their stable IDs; the earlier Run retains its immutable snapshot. This is not a
claim of exactly-once model consumption. Run and binding fences prevent a late start event
from rewriting a settled receipt.

In a work Thread, Stop pauses admission before sending the interrupt. A Run no Runner holds ends
at once: one still queued, or claimed but not yet bound, which binding then refuses. For a bound
Run, Stop cancels its pending Requests in the same transaction; an answer, a steer or a native
question arriving afterwards is refused or recorded as cancelled. Recovery never queues a stopped
Run again, and a Run someone stopped ends `interrupted` whatever else the Host found first
([`finalizeRunTransaction`](../packages/database/src/run-finalization.ts)). Pending work and
passive reports survive the pause and Host restarts. Resume is an idempotent explicit command authorized for the person who
paused the queue or a Workspace owner. Resume controls the durable queue; it does not grant
execution access. Each queued item still runs only under its original requester's membership and
execution-environment authority. A new queued message, a schedule, or a delegation result does not
clear that pause. Ordinary failures do not pause the queue. Stopping a conversation's reply does
not pause anything; see below.

Thread status is a stored projection of Run facts, derived by
[`deriveThreadStatus`](../packages/core/src/thread-status.ts) and written in the caller's
transaction by `projectThreadState`. Historical archived status remains decodable, but the Host no longer produces it. The earliest
nonterminal Run by Run ordinal determines the status: `waiting` stays `waiting`, and queued,
starting or running work is `running`. A paused queue's queued Run does not count as active;
pausing does not hide a Run that is already starting, running or waiting. With no active work, the latest Run by
ordinal leaves the Thread `failed` if it failed, or `idle` otherwise. Admitting another Run
replaces that failure projection. Projection reads of Runs and Requests take no new locks;
callers acquire the Thread fence in the [declared order](../packages/database/src/lock-order.ts).

When status, queue pause or pending Request count changes, `projectThreadState` appends
`thread.state-changed` with absolute `{ status, inputQueuePaused, pendingRequests }`;
unchanged state appends nothing. Run transitions and queue pause/resume project synchronously
and clear any pending marker. Migration 0075 stores the count of pending Requests by
originating Thread, regardless of target Workspace or Request mode, and the last projected
pause value. Nested Run and queue mutations can share the projector without duplicate events.

Request changes append their existing Request events and insert a deduplicated marker in
`thread_state_pending` (migration 0076). They do not project or acquire Thread locks for
projection. The Host wakes a coalesced drain when publishing Request events, drains at startup,
and sweeps every second. Each committed projection is published before the drain moves to
the next Thread, so a later failure cannot swallow earlier committed events. Each pending
Thread is projected in its own transaction under
the [declared database fences](../packages/database/src/lock-order.ts); projection reads Runs and Requests without locking them. A Request
writer records its marker after allocating its originating Workspace event sequence, so a
concurrent drain cannot clear an unobserved committed change. Snapshots and pages read the
stored count; the later state event has a newer sequence and brings clients up to date.
When the count changes, projection also publishes the corrected open Assignment card in the
worker Workspace. That event has no Run attribution, avoiding a Run foreign-key lock after
the Workspace lock.

The [declared database lock order](../packages/database/src/lock-order.ts) is the single source
for table and advisory ranks and row-lock strength rules. The integration configuration installs
[a pg-client checker](../packages/database/src/lock-order-checker.test-support.ts) for all pools
and direct clients. It checks explicit row locks (on every relation a locking read names, joined
or comma-separated), updates, deletes, conflict updates, and locks inside installed functions and
triggers. It distinguishes previously held rows and new private rows from new acquisitions. Test
databases need PostgreSQL's `pgrowlocks` extension: the integration global setup installs it in
every worker database with the test database role, whatever the lock-order mode, and the checker
reinstalls it when it observes a transaction after schema recreation. Each checked statement adds three round
trips (its tables' catalog, a snapshot before it, and its row locks and writes after it), so the
checker dominated store-test time; a transaction re-expands installed functions and triggers only
when their catalog digest changes, a migration transaction is not checked, and stacks are
formatted only for an edge or a violation.

The full integration run enforces (`OPENSTEER_LOCK_ORDER_MODE=enforce`); a run with the mode
unset observes no lock order; `record` records acquisitions without aborting. See
[lock-order modes](../scripts/README.md#lock-order-modes). `OPENSTEER_LOCK_ORDER_TRACE` selects the merged
JSONL artifact. Workers write
separate file traces; teardown requires a complete, valid trace for every scheduled file before
merging their graphs. Each edge retains the two
statements, stacks, representative row keys, and PostgreSQL lock modes. Multiple rows in one
statement share an edge; separate statement acquisitions remain separate; an enforcing run keeps
one witness per resource and mode pair. Compatible reader reversals pass the local rank check.
Suite teardown checks mode-labelled cycles across all connections, including longer cycles; it
compares modes at their shared row resource, and a cycle or trace-only violation fails the run.
Any error thrown by the lock-order or database teardown also fails it; Vitest would otherwise
exit 0 after a teardown error.
Host paths from separate temporary test databases are combined because they can meet in one
deployed Host. Account-service paths form a separate schema graph and use `control-plane:`
table ranks, including for tables with the same name as Host tables. Dedicated negative
checker fixtures are excluded from the application graphs. A passing run leaves the graph
summary (`trace.jsonl.graph.json`, path printed at teardown) with the exercised edges. Raw traces
are kept when a path is requested or a check fails; otherwise a passing run removes them.
Each test also fails on any deadlock or serialization failure, including one the bounded retry
absorbed; a test that causes one on purpose claims it with `takeTransactionConflicts`.
A passing trace describes exercised transactions, not unexercised predicates or every possible
PostgreSQL implicit lock.

Every Thread creator uses `prepareThreadInsertion` to fence and recheck its execution parents.
The Request Workspace set includes both authority scopes and every event origin, including
Requests covered by an integration resolution.
The source guard covers every `packages/*/src` and `apps/*/src` tree. Historical migration text
is exempt; the migration suite audits installed public functions for unreasoned strong locks.

[`withRequestWorkspaceLocks`](../packages/database/src/request-workspace-locks.ts) discovers the
complete Workspace set with unlocked reads, locks it in one ordered query, and rediscovers it. If it
grows, the transaction rolls back and retries with the union; a nested mutation or event append
also refuses to acquire an additional Workspace. Database-only transaction entry points share
[`withDatabaseTransaction`](../packages/database/src/connection.ts), which retries deadlocks and
serialization failures with jitter and four total attempts. Attachment completion and the two
Runner send transactions remain non-retrying because their callbacks perform external work.
Events and recovery results are returned from the committed attempt. Browser saves, computer
approvals, delegation and channel admission reserve their complete authority prefix in the
[declared order](../packages/database/src/lock-order.ts). Channel ingress can inspect its source
for an early ignore, then fences and revalidates it before admission.
A pending live Request keeps the Run and Thread waiting even if the Runner reports
running. Accepting the answer to the Run's last pending live Request, or the engine cancelling
it, makes the Run `running` again in that transaction. Clients apply these fields only from a
newer sequence, as described in [Connections](connections.md#durable-stream-and-live-progress).
A queued Run behind a paused queue also shows no typing or starting activity in the transcript.
Host API epoch 29 carries these semantics.

Migration 0044 converts old passive `queue` deliveries into reports and old `trigger` deliveries
into queued work, preserving already-issued steers. Startup recovery retires legacy queued Runs
seeded by reports, refunds their unused admission charge, and admits the actual pending work with
its own authority. No provider session is replaced or replayed to perform this repair.

## Thread names and symbols

The Host keeps `title_source` and `icon_source` private to the database. Each is
`provisional`, `generated` or `chosen`, independently. A new task opts into a
provisional title with `thread.create.generateTitle`; other API-created Threads
and existing Threads keep chosen names. Delegation, Trigger and Watch requests
without a title use `provisionalThreadTitle(task)` until generation succeeds.
Explicit titles, channel conversations and home Chat have chosen titles.

Ordinary tasks start with a null, provisional symbol. A delegation may choose an
icon for a new Thread; supplying an icon with `threadId` is refused, and reuse
preserves the worker's title, symbol, colour and provenance. Chat's null symbol is
chosen, identified by the Workspace's actual `homeThreadId`, not conversation role.

The Host keeps the outer `thread-title-v1` Runner capability gate. It requests a
name when the title is provisional, or the symbol is provisional and the Runner
also advertises `thread-icon-v1`. Only that latter capability permits `icon: true`
in `titleRequest`. The store reads the first authored input by sequence,
independently of the Run's inputs and history, bounding text and file/place labels
to 2,000 UTF-16 units without splitting surrogate pairs. An attachment-only first
input stays ineligible, even after later text. Failed generation leaves the next
eligible Run free to try once again. See the [engine notes](ai-engines.md#thread-names-and-symbols).

The Runner reports through `runner.thread-title` under the current Run binding.
Foreign, stale and revoked bindings are dropped. In one transaction the Host
independently compares and sets each supplied provisional field to generated;
a chosen title does not block a provisional symbol, or the reverse. An empty
report does nothing. The neutral settled symbol is `document`.

`thread.rename` and `thread.icon.set` require active Workspace membership and
record idempotent commands. Both refuse Chat. A same-value choice still sets that
field to chosen without emitting an event. `thread.icon.set` with null means Use
default and stores `document`. Neither command changes the other field. Workspace
lock discovery and transaction retries serialize generation and person edits,
so a late candidate cannot replace a person's choice.

Every new `thread.state-changed` event includes the absolute title, icon, status,
queue pause and pending Request count. A combined generation emits one event.
Visible name or symbol changes republish every assignment of that worker,
including completed assignments in other Workspaces. Their worker summaries carry
icon and colour. These metadata events create neither notifications nor unread.

Thread and Workspace colours are stored once. At insertion the Host selects the
creator's six newest colours by `created_at desc, id desc` using a creator index,
then takes the first unused colour in `markColorAllocationOrder`. Seven serial
creations by one person have distinct colours; concurrent creations may collide.
Home and unlisted children consume the same Thread sequence. Workspace creation
may specify a colour, which is included in the idempotency fingerprint; allocated
colours are not. Replay preserves the stored colour. `workspace.color.set` follows
Workspace icon rules: owner only, no Main, no deleting/deleted Workspace, with
ledger replay preventing an old retry from undoing a newer edit. Changing a
specialist's colour leaves its tasks' colours unchanged.

## A person's messages in a conversation

A conversation (`Thread.role` `conversation`: Chat and owner direct messages) is the person
talking with the agent, so what they send contributes to the reply under way instead of waiting
for it to finish. The wire is the same `thread.sendMessage` with `queue`; the Host applies this
only to a person's own messages there — sent in the app, or by their linked identity in their
direct message — and never to Triggers, watches, tasks or other agents, which keep the rules above.
A message joins a Run only when the Run answers the same person under the same membership, for the
same reply target (an in-app message never joins a reply going to a channel, or the reverse) and
Assignment, on the Thread's current engine and model.

[`deliverConversationInputsInTransaction`](../packages/database/src/thread-inbox.ts) is the one
operation that hands a person's waiting messages to such a Run, oldest first, under the Run,
Workspace, channel authority, Thread and projection fences. The Host calls it at each moment the
Run can take them: when a message is admitted, when the engine starts (`run.started`), when the
person's answer to the Run's last open live Request is accepted, and when the engine cancels that
Request itself. Each hand-off is the same claimed input and `run.steer` command explicit Steer
uses, keyed by message, Run and hand-off number, so a message a refusal returned can be handed to
the same Run again without colliding. On an engine that steers natively each message reaches the
model at its next step, one command per message for everything waiting; any other restarts the
attempt once with the messages handed over, up to what one dispatch carries
(`runExecuteInputsMax`), and the rest wait for the replacement's start
([Restart steering](#restart-steering)). A picture waits, with everything after it, for the next
Run when the holding Runner's driver does not advertise native image steering. When a Run is
dispatched, it takes the person's other waiting messages along with the one that starts it (up to
`runExecuteInputsMax`), each placed in order, so a burst sent before the engine starts is one turn;
a restart's replacement attempt does the same. Work Threads keep one input per turn.

Receipts work as they do for Steer: a proven refusal returns the message to the inbox, and with it
the later messages of that exchange handed to the same Run whose commands were not sent yet. One
control command per Thread is in flight at a time, so those never reached the Runner, and nothing
the person sent after a refused message is answered before it. The next of those moments, or the
Run's end, hands them over again in order or starts the next Run with them, so a message is
answered in exactly one Run; an uncertain outcome stays `unknown`, is never resent and holds
nothing back. Nothing retries on a timer or after a refusal.

Stopping a conversation's reply ends that exchange and leaves the conversation open. In the Stop's
transaction, the person's messages for that reply that it had not taken — still waiting, or handed
over by a command not yet sent to the Runner — are cancelled with reason `stopped`; their records
stay and clients show them as not sent. A hand-off already on its way keeps its receipt, except that
a refusal arriving after the person's Stop also ends with `stopped` instead of starting another
reply; a background deadline is not the person's Stop and returns such messages to the inbox.
Anything sent after the Stop commits is answered next, without Resume, and work the person did not
send — reminders, task results, other agents' messages — keeps its own meaning and runs next. A
conversation is never paused. Startup recovery settles any conversation an earlier Host paused,
once ([`settlePausedConversation`](../packages/database/src/thread-inbox.ts)): what the person
sent for the stopped reply ends `stopped`, and what Triggers, tasks and other agents left for it
becomes a report — context for the person's next turn — rather than running then or being dropped.

An ordinary message never answers a Request. A live approval holds the Run `waiting`; the person's
message waits in the inbox, and the explicit answer (or Stop) on the approval is what lets the Run,
and with it the message, continue. Host API epoch 32 carries these semantics. An engine can accept
a message as it finishes its answer and run it as a turn of its own; a Runner whose drivers answer
every message they accept in that same Run advertises `steer-answer-v1`. The Host hands a
conversation's messages only to a Run whose holding Runner advertises it, and the dispatcher sends a
conversation's Run only to such a Runner. A Run an older Runner keeps across a Host upgrade
therefore leaves the person's messages for the next Run, whose dispatch tells that Runner to update
rather than trusting it.

## Restart steering

A Run executes as one or more attempts ([`run-attempts.ts`](../packages/database/src/run-attempts.ts)).
Each attempt has its own binding generation and grant and records where it ran, with which model,
when it was sent, started and ended, how it ended, and what it consumed; the Run's usage is the sum
over its attempts. `run.attempts.list` returns them for inspection; no transcript draws them (see
[Conversation roles and Assignments](#conversation-roles-and-assignments)).

When the Runner holding a Run cannot steer its engine natively but advertises `attempts-v1`, a
steered message restarts the Run instead:

1. Admission writes a `run.restart` command carrying the message, supersedes the current attempt
   with a waiting replacement, and revokes the Run's grant, so the interrupted attempt's tools stop
   at once. A message steered while the replacement still waits joins it; there is one restart.
2. The dispatcher sends `run.interrupt` aimed at the superseded attempt's binding generation, so
   it can never stop the attempt that takes over.
3. Until the superseded attempt ends, its events are acknowledged and their ordinals consumed, but
   they are not stored; only its `run.usage` is recorded, on its attempt. Its plain
   `run.interrupted` puts the Run back in its queue with a new `run.execute` and appends
   `run.restarted`, which carries what the earlier attempts consumed.
4. The replacement starts in the same conversation with only the restart's messages, at the Run's
   next ordinal (`firstOrdinal`), and its start delivers them.

An end the Run shares is the Run's: if the superseded attempt completed or failed before the
interrupt landed, or someone also stopped the Run, the Run ends that way, the replacement is
`cancelled`, and the restart's messages settle like a steer that was never dispatched.

Recovery uses the same replacement-attempt dispatch and usage accounting, but ends the lost
attempt immediately. Its retired binding is refused instead of consuming late ordinals, and
its fixed batch is exactly one recovery message. See [Runs across connection loss and restarts](#runs-across-connection-loss-and-restarts).

## Native subagents

A subagent an engine starts inside a Run is an execution node of that Run
([`execution-nodes.ts`](../packages/database/src/execution-nodes.ts)), under the attempt that ran
it and with the Run's own authority. The driver reports `node.started`, `node.updated` and
`node.completed` through [`SubagentNodes`](../packages/harness/src/subagent-nodes.ts):

- A subagent's tool calls carry its `nodeId`, and a Request it asks carries `originatingNodeId`,
  so "Needs you" names the asking subagent. The Host refuses a node it was never told about.
- Its own words are its result, never a message of the Thread or the Run's reply.
- Whatever reaches the driver first about a child — its spawn, its first event, or a question —
  opens its node, and later reports fill in its title, prompt, model and spawning call.
- A resumed child session is a new node with the same `sessionRef`.
- Nodes never outlive their attempt: a restart, a Stop, or the Run ending closes any still running
  as `interrupted`.

Clients draw a subagent as one card where it started, in place of the call that started it, with
its own steps inside; `run.attempts.list` also returns the Run's nodes. Cross-engine delegation
stays with Assignments.

## Background work

Work an engine leaves running when its turn ends — a background subagent, a shell, a Codex child —
stays joined to the Run that started it, because one engine process cannot say which task made a
tool call. The driver reports `run.phase`:

- `background`: the turn answered while that work still runs. The Run stays `running` in phase
  `background` (`runs.phase`), its Assignment stays open, and Stop ends it and all its work.
- `turn`: the engine began another turn in the same Run — a message steered in, or a turn a
  finished task woke (Claude Code wakes one; Codex never does).

The Run ends when its engine is idle, no background node is live, and no wake-up is pending. A
turn that ends in the background has answered: the Host records its reply on `run.phase`
(`replyMessageId`), every client shows it as that turn's reply rather than typing on, and a
channel hears it once (`runs.turn_reply_message_id`), not only when the Run ends. A message from the Run's own requester
on the same engine, model and reply target joins the Run as a new turn, even sent as `queue`;
anything else waits behind it. An engine that runs a steered message as a turn of its own after
answering (Claude Code and Pi when the message arrives as they finish) reports the same phases, so
each turn keeps its reply. Background work runs against a deadline set the first time the Run
goes to the background (`runBackgroundMaxMs`, 4 hours), which neither a reconnect nor a Host
restart moves; past it the Host stops the Run as a Stop would, without pausing the Thread's queue.

Recovery preserves background phase and its original deadline, including while the Run waits
queued for its computer. A queued recovery past that deadline is finalized directly; an active
one is stopped by the ordinary deadline sweep. The already published reply is not published
again merely because execution was recovered. Attempt-owned scripts and native subagents are
stopped and never resurrected; the resumed agent decides what to restart after checking effects.

## Warm engines

A Thread's engine can serve its next Run without starting again
([`warm-engine-pool.ts`](../apps/runner/src/runtime/warm-engine-pool.ts)). A driver offers this
with `warmReuse` (Codex and OpenCode); the Runner keeps the engine after a Run only when all of
these hold:

- the Run completed: a Stop, a restart, a failure, a lost lease or a draining Runner ends the
  engine with its Run, as before;
- the engine let go of everything of the Run (`releaseForReuse`): no turn or Request is open, no
  answer granted for the rest of its runtime, and Codex has ended the background terminals of the
  Run's thread and of every subagent thread it used;
- its processes are still one tree under the process the Runner launched, with nothing detached
  (`isSingleTree`); Windows cannot show that, so it keeps no engine.

An idle engine holds no authority. Its credential proxy answers `403`, and its browser and shell
relays refuse connections, until the Thread's next Run takes it and lends it that Run's tokens.
The engine keeps the MCP sessions it opened, and the Host serves one an earlier Run opened on the
current Run's token alone, as it does one from before a Host restart. The next Run takes the
engine only when everything it was started with is the same: requester and
membership, account and harness config,
provider session, Workspace, instructions, access mode, writable roots, capability profile, model
selection, integration skills (by content), the Runner's endpoints, and its routes to other
computers. Otherwise the engine is retired, as it is after 15 idle minutes, when
eight others are newer, and when its account, Workspace or Runner goes away. Retiring proves its
processes gone like a stopped Run's; until then its Thread takes no new execution. Each attempt
records whether its engine was already running (`engineStart`), which `run.attempts.list` reports.

An engine reaches other computers ([Machine access](computers.md#machine-access)) through the
launch directory it started with — the `ssh`, `scp` and `sftp` shims, `ssh_config`, `known_hosts`
and relay socket on its `PATH` and in its sandbox — so that directory's routes are part of the
key: each computer the Run's note lists, by alias, Runner and pinned host key; the ssh clients and
helper it runs; and whether setup succeeded. A computer added, removed, revoked, renamed or left
out of the note, a rotated host key, or a Run with computers after one without (or the reverse)
starts a new engine. What a computer allows and whether it is online are the Run's own: the Host
decides every connection against the live policy, and each Run sends its own note, so changing
them keeps the engine. The engine's shell relay serves one Run at a time and only the computers
that Run's note lists, presenting its current token on each connection. It is suspended — every
session and Host handshake it carries ends — when the Run ends, before the engine's reuse is
weighed, and on a Stop, a lost lease or a revoked grant, before the engine is stopped. A
connection accepted under one Run never proceeds under the next.

## Runs across connection loss and restarts

A Run belongs to the Runner boot that holds its execution binding, under a lease
(`OPENSTEER_EXECUTION_LEASE_SECONDS`, 90 seconds by default). Heartbeats renew the
lease; the Host tells the Runner only after the renewal is durable, and the
Runner stops a Run whose lease ran out without one. A newly admitted Run waits
for its first correlated lease grant, measured from the Runner's own heartbeat
or attach request, before preparing its Workspace or opening a harness session.
Admission starts a local deadline for that wait; if no grant arrives in time,
the Run ends with a terminal event without executing. The lease is the whole grace
a Runner out of reach has: losing the connection, or the Host restarting, costs a
Run nothing while it lasts. A lost execution ends its attempt, then resumes the same Run
and native conversation with a recovery attempt. The same rule applies to lease expiry
(discovered by attach, the sweep, or the Runner's `run.interrupted {cause: "lease-lost"}`),
a Runner restart, and a Runner that lost its state.

Every connection opens with `runner.executions.attach`, the complete list of Runs
the Runner holds, and nothing is dispatched to it until the Host answers. The
Host settles each announced Run in its own transaction: it continues from the
first event the Host has not committed while its binding, lease and authority
all hold, and is revoked otherwise. Every other active Run bound to that Runner
is one it no longer holds ([`attachRunnerExecutions`](../packages/database/src/execution-recovery.ts)).
An omitted Run is requeued unchanged only while its lease is live and the same boot never
acknowledged its execute command nor bound its native session. Otherwise the Host performs
terminal cleanup of the lost attempt without ending the Run. It retires the session binding,
clears its lease, revokes grants, ends native execution nodes, cancels live Requests with
`process-lost`, and settles outstanding commands. Late events, acknowledgements, refreshes
and renewals cannot advance the successor. Never-dispatched steers return to their queue;
unacknowledged dispatched steers retain an unknown receipt and are never resent.

Recovery creates an attempt with reason `recovery`, queues `run.execute`, and publishes
`run.restarted {reason: "recovery"}`. Assignment, requester, seed, reply target, queue order,
phase and background deadline stay unchanged. No failure notice or Assignment result is sent.
The only actionable input is a Host-authored `continuation`, cause `run-recovery`, describing
unfinished commands, native subagents and live Requests. When acceptance was never confirmed,
it quotes the claimed originals, including artifact and place references, instead of resending
them as instructions. The recovery start delivers those receipts. At most one unconfirmed
recovery message exists per Run; another loss before it starts reuses it. Frozen reports and
initial context are included only when no attempt of the Run ever started.

Stop and an elapsed background deadline end the Run `interrupted`. Lost authority fails it
`workspace_access_revoked`. Without a native session reference, or after three recoveries
created in the preceding five minutes, it fails with the original loss code
(`runner_restarted`, `runner_state_lost`, or `execution_binding_expired`). A resume failure is
visible and never starts a fresh conversation silently. At dispatch, recovery across Runner
boots additionally requires `earlier-boots-contained-v1`; an older or unproven boot fails the
Run `runner_restarted`. A Runner advertises that capability only when startup reaping proved
its earlier processes gone. Same-boot recovery uses the Runner's existing per-Thread hold.
Runner shutdown stops and contains engines without journaling a terminal Run event; the Host
classifies their loss when it next hears from the computer.

The Runner keeps each Run's durable events and its session binding in a journal
until the Host acknowledges them, and replays the rest after attaching; the Host
deduplicates a replay by Run and ordinal. A Run whose events it can no longer
hold stops instead of dropping one. An ended Run's journal is kept until it is
acknowledged, for up to 24 hours and 64 MiB across Runs. A lease that ran out is
never renewed, and a Host that was down gives each live binding one fresh lease
at boot (`restartExecutionLeases`): it heard nothing while down, so a Run that
finished meanwhile still counts when its Runner returns. Live progress is not journaled: after
attaching, the Runner states each open stream again.

What an engine reports can be longer than its durable record may be: an answer
or reasoning block, a tool call's input such as a script with an inline image,
what a Request asks, or why the Run failed. The Runner fits every event to its
record before journaling it (`fittedDurableEvent` in
[the Runner runtime](../apps/runner/src/runtime/runtime.ts)) and says what it
cut, so a Run never fails over what its engine said. A tool call's arguments go
through [`createToolArguments`](../packages/core/src/tool-arguments.ts), which
keeps them within 64 KiB by cutting their longest texts to a head and tail and
keeps short values, such as a path or an integration's `toolRef`, whole. The
engine always runs the call with its whole input.

## Run tool authority

Each execution binding issues a grant for the Run's current attempt
([`run-grants.ts`](../packages/database/src/run-grants.ts), migration 0079), and every
Run capability token names it: agent control and tools, browser control, integration
tools and skills, attachments and egress. [`assertActiveGrant`](../packages/database/src/execution-authority.ts)
authorizes tool use: the live binding plus an active grant for that binding generation,
issued to the same Runner boot, in a Workspace that is not being deleted. The Runner's
own reporting needs only its binding, so a stopped Run still records how it ended.

A stopped Run's engine gets three seconds to wind down; then the Runner ends every
process the Run started: each that carries the `OPENSTEER_EXECUTION_SCOPE` environment marker
its launch set, including any that left the process group, and everything below one, so a
child that drops the marker is found too
([`execution-containment.ts`](../apps/runner/src/runtime/execution-containment.ts)). The Runner
notes them before it tells the engine to stop, and follows each by its pid and start time
until it is gone, so what the engine orphans as it exits is still ended and a pid given out
again between two looks is not taken for one of them. The Thread takes no new execution until they are
proven gone, and a new Runner boot first ends what an earlier boot of the same data directory
left running, so a Thread's executions never overlap. macOS and Linux can prove it. A process
that drops the marker and leaves the tree between two looks is beyond any user-level
inventory. A shared Linux Runner whose sandbox gets a `/proc` of its own runs each engine in a
pid namespace that ends such a process with its engine; one whose container refuses that
keeps the container's pid namespace, and there, as on a person's own computer, the engine
already acts with the authority it could use to leave work behind. On Windows an execution
ends with its engine's own process-tree stop, which follows the tree by parent id even after
its leader exits, counting only children created while their parent lived. Trigger and Watch
programs are contained the same way.

A grant is revoked only when authority ends while its Run lives on, in the transaction
that ends it: Stop and a background deadline (`stopped`), a restart (`superseded`),
cancelling the Run's Assignment (`assignment-cancelled`) and a new binding
(`binding-replaced`). A Run's end, a revoked Runner, a lost membership
or a Workspace being deleted already fails the check through the Run and binding the
token names. Agent-control admission and Run-originated Request creation check the grant
under the Run lock, which revocation also holds: an action admitted before a revocation
may still complete, and nothing is admitted after it. Tokens issued before grants existed
name none; their grant is found by binding generation. After commit the store announces
each revoked grant, and the SSH sessions and computer-use sessions it admitted end
([Machine access](computers.md#machine-access), [Computer use](computer-use.md)).

The Host handles a Runner's messages in order per Run, everything else in a lane of its
own, and each command receipt on its own: a Request answer is delivered inside a
transaction that holds its Workspace until the Runner's receipt arrives, and no other
Run's event or command's receipt waiting on that Workspace may stand in front of it
([`attachRunnerSocket`](../apps/host/src/server.ts)).

A Run is dispatched once its Runner is attached with room for it and its AI
account is not preparing. A Runner that has just started prepares an account
whose engine needs it before the account can run anything, which can take
minutes while Codex indexes its transcripts; the account's Runs stay queued,
without further dispatch attempts, until the Runner reports preparation
settled. An inspection error, or a Runner that leaves during dispatch, likewise
returns the Run to its queue. Only an account that is unavailable or signed out fails the
Run, because a person must act on it
([`isRetryableHarnessCatalogStatus`](../packages/harness/src/registry.ts)).

A dispatch slot ends when the Runner accepts the Run, and each Runner admits no
more Runs than the capacity it advertised, so Runs waiting on a person hold a
place on their own Runner and nowhere else. A stop or Request answer for a Run
whose Runner is out of reach waits for it to reattach; the Run's end settles it
if the Runner never does. After a lost connection or a Host restart, interrupts,
restarts and Request answers left in flight are sent again, which the Runner
records once by command ID (`resendableControlCommandTypes`), and an unconfirmed
steer becomes `unknown`.

## Conversation roles and Assignments

A Thread is a durable address and native AI history. Its `role` is `conversation` for Chat and
owner direct messages, or `work` for focused tasks. Role controls the Runner's instructions and
client presentation. It does not grant authority: capability profiles, Workspace membership,
execution placement, and tool admission still enforce access independently.

Streaming text is live progress, not a durable record (see
[Connections](connections.md#durable-stream-and-live-progress)). A Run that ends
mid-answer keeps what its reader already saw: before the terminal event the
Runner records an answer or reasoning block that never completed, from the same
tail the reader holds. A tool's partial output is not recorded, because only the
tool can say how it ended.

A completed Run's reply is the last message its agent wrote that says something (text or a file),
which every engine ends a successful turn with. The Host records it as `replyMessageId` when it
commits the Runner's `run.completed` ([`runReply`](../packages/database/src/run-reply.ts)); a
failed or stopped Run has none. That one message is what a conversation shows, what a channel sends
and what an Assignment returns. Conversation clients draw it as Opensteer's message and keep
everything else the turn wrote and did as its steps, opened from the reply on request
(`conversationTurn` in the shared client). Until there is a reply, a live turn shows Opensteer
typing, and nothing else, unless its Run is still queued while its AI account gets ready, which it
says instead: the answer it is still writing is not a step, wherever its live text is drawn. A
turn's steps open as Activity — from the typing, for that reply and still for it once it lands, or
from a reply's menu, for that reply — in a popover on a wide screen and a sheet on a phone; the
conversation's header carries only its name. A search or link to a step, an approval already answered included, opens
that turn's Activity at its reply. A waiting turn's Request is docked in the composer; a completed Run that said
nothing says it finished without a reply. The person's own messages the Host has not handed to a Run
yet, or handed to one that did not take them, are drawn as sent messages at the end of the
conversation, never as a queue. A stretch of a reply with nothing of its own to show — the part
before a message that joined it, a reply waiting on an approval, or work on a Mac its reader is not
shown (someone else's, a session that has ended, a Mac gone offline) — is not drawn, and the reply
going on after a joined message keeps one row from the moment it starts (`conversationRows`; the
screen says which Macs it shows, and keeps the row while a Stop its reader pressed there is still on
its line).
No transcript shows what a Run consumed or lists its attempts: a turn already says how long
it worked and what it did, and how much of an account's plan is left is the account's usage bar
([AI engines](ai-engines.md#what-a-driver-reports)). A
message a turn wrote counts as seen only once the turn settles (`observedSequence`), because
until then a conversation has not shown it.
Only the person and the conversation's agent speak there. What another agent, a Trigger or a watch
sends the agent is one line naming the sender and how it was sent: a `report` "left a note" for its next
turn; a `queue` or `steer` from a Trigger or watch "ran", and from another agent "asked Opensteer"
(`incomingMessageAction` in the shared client). The reply under that line is Opensteer's message to the
person, and it is what notifies them. Opening
the line shows the full message; an agent's message offers to quote it into Chat's composer, labeled
"Ask about this" in Chat and "Ask in Chat" elsewhere. The line also opens itself for a message
search link. The reads that build a transcript carry each input's `policy` for this; Runners never
receive it. Work Threads keep attributed bubbles, bounded by
`incomingMessagePreview` in the shared client. The conversation's own answer, delivery failures and
actionable Requests remain visible.
Chat uses the same Thread and composer commands, with execution controls opened explicitly. Its
presentation is a client choice; how a person's message is delivered there is the Host's rule
above, not a client one.

The conversational agent answers brief requests directly and delegates sustained, self-contained
work. There is no keyword, duration, or tool-count router. A new task uses `thread_delegate` with
`workspaceId` and runs on the delegating Thread's engine and model unless the agent names another
engine profile or model (see [AI engines](ai-engines.md)); the next task for an existing work
Thread uses `threadId` and retains that Thread's engine and placement. A successful delegation
returns both identities.

Trigger and Watch delegations store the task text exactly as supplied. Their message authors
carry the occurrence or activation ID, which the harness includes in the structured input header.

An Assignment is work handed to a work Thread by a Run or a Trigger, with the assigning Thread as
its return address. It can span several Runs. Each Run and actionable input stores its Assignment
identity, so a late approval cannot join a newer Assignment in the same Thread. One open Assignment
per worker is enforced by the database. A person's input into a work Thread joins its open
Assignment; otherwise it is ordinary conversation with that Thread. The existing `delegations`
table stores this lifecycle; there is no separate execution queue or scheduler.

Agents do not declare completion. When a Run bound to an open Assignment ends, Run finalization
checks for pending work in the same transaction: a pending Request from the Assignment's Runs, a
queued or steered input bound to it, a child Assignment that is open or whose result has not been
delivered, or another active Run. With pending work the Assignment stays open and the resolution
resumes it. Otherwise a completed Run completes it with that exact Run's reply as the bounded
result, and a failed Run fails it with the failure. An interrupted Run leaves it
open. This matches how harness subagents already behave: the final reply is the result.

Result delivery uses the existing durable inbox, preserving the recorded origin, reply target,
and current authority checks. A completed or failed result is queued to the assigning Thread; a
cancellation is recorded there as a passive report that starts no Run. Delivery is attempted
immediately after finalization and retried by reconciliation from the stored result and return
receipt, never by searching for a later message.

`assignment_cancel` cancels the selected Assignment and its Assignment descendants, withdraws their
pending Requests, fences their pending work and late continuations, and interrupts active Runs.
Thread lineage is not used as a cancellation tree because a worker can serve later independent
Assignments. Stopping one Run of a work Thread pauses its queue; stopping a task terminates the
objective.

Transactions that already hold the worker's Workspace, such as Runner events, Request resolution
and Run finalization, publish Assignment updates only to that Workspace. Creation, cancellation
and result delivery lock both Workspaces in ID order and update the assigning side.

`assignment.get` returns the authorized task detail; `thread.assignments.list` and agent
`thread_read` provide bounded, separately paginated summaries. Summaries carry revisions so live
updates cannot be overwritten by older snapshots. Cards are created from Host records, not model
prose. Clients can observe a worker without changing the active Chat conversation. Protocol epoch
25 requires this contract, and the dispatcher requires Runner capability `assignments-v1` before
delivering role and Assignment context.

Each summary names the latest worker Run's canonical model ID when it differs from the assigning
Run's pinned model. Trigger and watch tasks name their worker model because they have no assigning
Run. The comparison uses the task's Runs, so changing or reusing either Thread does not rewrite a
finished task's model. The label remains available when the worker Thread or its model catalog is
not loaded. Protocol epoch 27 requires this field; migration 0071 fills historical Assignment
events from the Run named in each event before those events are replayed.

Navigation lists a person's tasks: root Threads, and work a person handed off from a
`conversation` Thread such as Chat. A person's own new Thread is listed as a root or when made in
a conversation; a conversation's delegation is listed only during a Run whose seed input was
authored by a `human`. Delegation must have origin `run`; trigger and watch origins never
list work. The same rule promotes an existing unlisted Thread and publishes `thread.listed`.
Work handed to a task stays inside that task, whoever handed it, even when a person woke the Run. Nothing
at runtime unlists a Thread. Migration 0113 recomputes existing listing by this rule
(keeping roots listed), and rewrites every durable Thread snapshot an event carries.
`parentThreadId` stays lineage only. Workspace snapshots and `tasks.list` filter on `listed`
before pagination; clients apply the event's flag on replay. Direct navigation and authorized
agent searches reach unlisted work. Questions in unlisted work roll up to the nearest listed
ancestor, including Chat for automation-anchored work.

Chat shows what was said and work that needs its reader. A Run's seed author
(`startedBy` on lifecycle events) distinguishes human work from automatic wakes;
`personWaiting` records whether its seed or any input it took is human-authored, so a steer remains known on every history page. `startedAt` records the Run's real start. Known
non-human turns show only their reply, tasks needing the reader or failed tasks,
and live computer use with its Stop. Their waking input becomes one linked source
line above a reply; silent completion leaves nothing in Chat. Standalone trigger
and watch assignments appear only for decisions or failure. A person's silent
completion shows “Worked for” with elapsed time from `startedAt` (or “Worked” when unknown) and opens Activity;
stops and failures keep their outcomes. Older Hosts omit `startedBy`, preserving
the prior presentation ([compatibility](host-boundaries.md#compatibility)).

In the conversation that handed it out, a task is one bubble that changes in place and opens the
task's own Thread. Its result draws nothing more: the bubble shows how the task ended, and the reply
it starts says what came back. There is no separate task panel: every client opens the Thread
itself.

A result is copied into the assigning conversation only while its requester can still read the
worker's Workspace; otherwise the return is undeliverable. A handoff from someone's Chat is
authored as that person's Opensteer, because "Chat" names a conversation only to its owner, and a
client links an agent message to its source only when the reader belongs to that Workspace.

### Requests waiting on a person

`requests.list` returns the pending Requests the signed-in person is the one to answer, across
every Workspace they belong to. Who answers is the rule Request responses enforce and
`requestNotificationAudience` notifies. Each Request carries the Assignments it holds up, innermost
first: its Run's own Assignment, then each parent Assignment, cut where the reader could not open a
link. The chain is read from Assignment records, never Thread lineage, because a reused Thread's
history says nothing about whose work it is doing now. Any committed `request.*` event makes the
realtime hub broadcast a payload-free `host.requests-changed`; every client rereads its own list,
including for Workspaces it is not subscribed to, and rereads after each bootstrap to recover a
missed notice.

Clients derive every "Needs you" from this one list: a task's bubble when a Request holds up its
Assignment, a Thread's row when a Request was asked there or holds up work it handed out, and the
questions above a conversation's composer. A task's question is answered there by choosing, through
the originating Thread's own authority, never by the conversation's composer. A Run waiting on a
Request someone else must answer reads "Waiting for approval". Protocol epoch 26 carries this
contract.

### A person's task list

`tasks.list` pages the signed-in person's listed, unarchived Threads across every Workspace they
actively belong to, Chat included, or in one of them when it names a `workspaceId`, most recently
updated first; a cursor continues only the list it came from. Each carries `lastReply`, the first
words of its newest published assistant message as one plain line, and `failure`, its newest Run's
failure when that Run failed. Both are at most `taskLineMaxLength` and made from a bounded prefix
the database cuts, so a large message never leaves it whole. The page carries the reader's read
state for each task. The optional `active: true` filter returns only `running` or `waiting`
Threads, including work waiting on the reader’s Request, with the same authorization, entries, read
states and paging. Its cursors are scoped to the filter.

The realtime hub broadcasts a payload-free `host.tasks-changed` for each committed event that
changes what a list shows: a listed Thread created or listed, `thread.state-changed`, a Run's
`run.queued`, `run.started`, `run.status`, `run.completed`, `run.failed` or `run.interrupted`, and
`message.created`, `message.placed` and `thread-input.updated`, which change read state. Streamed
progress never does. Every client rebuilds its loaded prefix on the notice, one refresh at a time and one
more for notices during it, and after each bootstrap and stream synchronization. It starts at the
first page and follows fresh cursors until it has at least as many tasks as before, or reaches the
end, then replaces the held list and continuation together. Alongside that prefix it reads every
active page, coalesced with the same refresh. The running count and open task rows use
the union of history and this complete active set, deduplicated by Thread with the freshest update
winning; Workspace lists include the same active set filtered to that Workspace. Active work never
depends on how much history the reader loaded. A client refreshes each Workspace's
list a screen asked for the same way. Membership changes notify the affected reader even when
they do not follow that Workspace; a scoped authorization refusal clears its held list.

`thread.shared-done.set` (Host capability `shared-task-done-v1`) writes one shared `Thread.doneAt` fact and returns the Thread, its Workspace
sequence and an idempotency receipt. Every member hears `thread.state-changed`. Read positions
remain per person and do not change when someone marks a task Done. Chat and active channel
conversations cannot be Done; a rotated historical channel Thread is an ordinary task.

Done stops the task and the subtask Threads reached through its open Assignments. One transaction
reserves the affected set in the [declared order](../packages/database/src/lock-order.ts), revalidates
it and retries if it changed. It cancels Assignments and pending Requests, withdraws pending and
claimed actionable inputs with reason `task-done`, pauses anchored Triggers and revokes execution
grants. Durable interrupts dispatch after commit. Passive reports remain. Done keeps the input queue
unpaused, so Reopen clears Done without requiring Resume. Reopen does not restart work or Triggers.
Actionable input, delegation into the task and Run admission refuse Done tasks with
"This task is Done. Reopen it first." Late Assignment returns arrive as passive reports.

People need active membership for task writes; Done and Reopen also require the task's creator or
a Workspace owner. Agents act for their Run's requester: Main has that person's reach, Workspace
stays within its Workspace, and delegated agents may write themselves and Assignment descendants
they handed out. Read reach does not grant write reach. `thread_write` uses these same operations
for rename, icon, Done and Reopen. It is served only to Runners advertising `task-done-v1`.

An agent marking its own task Done records `runs.done_when_finished`. Finalization settles its
Assignment first and applies Done only if the Thread has no actionable pending or claimed inputs,
pending Requests or waiting continuations, open served Assignment, open children or completed child
results still awaiting return. Otherwise it drops the intent. Reopen clears active Runs' intents.

Clients draw the list only from the shared [task list model](../packages/client/src/host/task-list.ts):
Working holds open work under way, questions first and then newest created first; Ready holds
stopped open tasks and unread Done tasks, most recently changed first; Done holds Done tasks the
reader has read, most recently changed first. There is no automatic age rule or per-reader
placement. Mark Done and Reopen appear in task row and title menus; Mark Done on work under way
first asks "Stop and mark Done?", and a Done task's composer shows "This task is Done · Reopen".
[Action reviews](../packages/client/src/host/action-review.ts) bind Stop, delegated Stop, Done,
Reopen and browser closure to the state reviewed. Their shared React owner dismisses
web dialogs and native sheets when that state ends; retained confirmation callbacks are single use
and silently ignore obsolete actions. A row moves only when what its task is doing changes. A
question marks one row: the first Thread the list holds from where it was asked up the work that
handed it out. A task an agent delegates is named by its `title`, which the delegation tool asks to
be a few words a person would find in that list; without one, its first line names it.

## Pages and apps in a conversation

The Host records browser use durably and apart from a Run's live attachment
([`browser-session-store`](../packages/database/src/browser-session-store.ts)). A use is one row
per conversation: its membership in a session (no Run, no page), a page a person included (no
Run), or a page a Run used. Every use also writes the conversation's membership row, which keeps
no page of its own and whose `lastUsedAt` moves with each use. A Run's use of the session is
recorded when it connects to it, and each tab once its `Target.attachToTarget` has answered the
agent, with the page's title and site at that use; recording a tab never delays or fails the
agent's command, and a failed record is reported and lost. A later use of the same row moves only
`lastUsedAt` and refreshes the title and site. A use stays true after the Run ends. A delegated
Run credits its own conversation and the requesting conversations in its Assignment lineage at
the time of use; reusing the worker later does not add that browsing to an earlier parent's
conversation. A person who opens a browser from a conversation (`browser.session.start` with
`threadId`) makes it that conversation's at once, and the answer already names it.

The browser catalog (the bootstrap's session list) names, as `threadIds`, the conversations
using each session that the reader can open — they are an active member of its Workspace — at
most `browserSessionMaxThreads`, most recently active first. Which pages each Run used is not in
the catalog; it is read per conversation, for the reply links that need it.

The live attachment is separate: a Run's binding holds a session only while the Run is active.
The store reads the Run's row under a share lock before writing the attachment, so an
attachment cannot be written after the Run's end detached it, however long a CDP command took to
answer. A connection the Host refuses (no `cdpBoundary` or `sharedControl`) records nothing.

`thread.browserUsage.get` returns, per session in the reader's bounded catalog, the membership
(with the title and site last seen there), the latest `browserUsageTabsPerRun` pages people
included, and for each requested Run its latest `browserUsageTabsPerRun` distinct pages — or its
use of the session when it chose no page. So a Run that used tab A and then tab B links to both,
and a link to an ended browser still names its site. Clients key these by session, Run and tab,
and keep a use of a session their catalog does not list yet until a catalog read brings it.

A person includes a page in a message as a `browser-page` content part — an untouched web Chat or
new-task draft follows the place shown beside it, page, Mac app or phone, as a removable chip
([composer context](../apps/web/src/components/workspace/composer-context.ts)) — carrying the session,
tab, title and address, frozen when the message is kept so a retry sends the same page after the
person has moved on. A message's words stay its own; clients draw its pages as chips. The Host
refuses the message, before it exists, if the sender can no longer see that session, or if the
conversation's agent could not use it — the rule its CDP connection meets: a session of the
conversation's own Workspace, or any session for a conversation in Main, with a profile session
needing that Workspace's grant. Otherwise the transaction that keeps the message credits the conversation with the page,
so neither exists without the other. The part is a reference, not a grant:
the engine receives one line naming the page, its Browser Session and surface, and to find it
with Browser Harness `listTabs()`, or to say so if it is gone
([input projection](../packages/harness/src/input-projection.ts)). People include places in their
messages. An agent's ordinary message cannot attach a place;
`thread_delegate` may forward selected `places` as structured browser-page, computer-app or phone
parts in the child's first message. The Host checks each reference's provenance (a person included
it in the parent conversation, or the delegating Run may use it), current sender visibility and
the child's own Workspace access. Forwarding does not transfer a session or grant. Included
browser pages are credited to the child atomically with its message. The place's display label
stands in for the message wherever its words are
summarized: quotes, and the notification or channel reply a reply would get, which never shows
the page's address. Search matches message text only.

A native reference is `computer-app {machineId, app, name}` or
`phone {machineId, display: "main", name}`. It identifies the app on the computer or the phone's
display, so "my screen" names which computer; on the wire it is never marked automatic, which the
previous release's Host and Runner refuse. A person's message is admitted when the sender owns
each computer and a phone names `main`: whether the computer is ready, the app approved, the
conversation's scope able to observe it or the phone free is the agent's to find at use, never a
reason to refuse what the person said. Forwarding by `thread_delegate` instead requires that the
child may use the place now: an available matching computer, observe access in the child's scope,
and a phone no other Thread holds. Including it never opens a session, requests approval or takes control. The
agent discovers its own integration toolRefs and uses the normal execution-time checks; missing
or broader access needs the task's explicit request where its capability profile permits one.
The single Host coordinates preflight and enqueue per requester/idempotency key. Concurrent
same-key attempts share admission before a refusal can become definitive; unrelated keys proceed.
An unlocked accepted-key read skips external place checks for a committed retry, then enqueue
validates exact replay under its database lock. Runtime/Account/network checks never run inside
that transaction. An acknowledged duplicate stays acknowledged when its target later disappears. Runner capability `native-place-input-v1` gates
native parts at admission, dispatch (including initial history and reports), queue delivery and
steering. Tool reads and delegation results project native references to address-free
text for an older calling Runner, so its strict message parser never receives unknown parts. All five engines use the
same common input projection. Exact pending commands and `messageDraftParts` retain all place
parts; clients must restore the entire array when editing or recovering a draft.

What changes often travels as small patches, never as a reread of a Workspace or a list:

- `host.browser-sessions-changed` means the list changed: a session opened, changed state,
  closed or failed, which Runs hold it or its access changed, or a conversation started using it
  (sent to that conversation's Workspace). Clients reread the bootstrap.
- `host.browser-presence` carries a session's page (title and site, never path or query) and
  whether an agent is `acting`. It reaches every socket of the people who may see that session
  — a profile's owner, or a fresh session's active Workspace members — and nobody else. Clients
  patch the session in place, and keep a patch for a session they do not list yet; a bootstrap
  read that began before a patch does not undo it. When the Host cannot read who may see the
  session, it reports the error and sends the latest presence again after a growing wait.
- `host.browser-usage-changed` names the conversations that gained a session or page. A client
  rereads usage only for the ones it shows. It reads a conversation's usage when it first shows it,
  once that conversation's Workspace stream is live, and again after the stream reconnects; a
  bootstrap poll reads none.
- `host.computer-presence` carries which apps an agent is acting in on a Mac, for each changed
  session, to that Mac's owner only ([Computer use](computer-use.md)).

`acting` means an agent is acting now, not that a Run is attached: the session is live and an
agent's CDP command arrived within the last 15 seconds. It turns off when the window passes, and
at once when the Run ends; a command of an ended Run that still answers does not turn it on
again. The bootstrap's session list carries `acting` and `page` too.

The shared client selector reads these records: a conversation's browsers are the open
sessions whose catalog `threadIds` name it, and Mac apps are those its Runs, or its open tasks'
Runs, hold now; the mobile app's live-work grid draws them in stable creation order, including
delegated work. The web and desktop apps instead list every place the reader can see — each
browser tab, Mac app and phone display — in the sidebar's Tabs section from `placeList`, with the
faces of the listed tasks holding or acting there now, never historical use, and show one place at
a time in the middle, chosen only by the person
([navigation](../apps/web/src/components/workspace/navigation.ts)). A task row changes the
conversation, a tab row the place, a face on a tab both, each as one history entry; agent
activity, requests and completions never navigate. The one exception is the place in the middle
ending while shown — its tab closed by anyone, its browser ended, its task session over, the
person's view closed — as its identity and lifecycle say (`placeDestinationEnded`), never its
readiness: a Mac asking for permission or offline keeps the place, saying why. Then the tab after
it on its side of the Tabs' hairline takes its history entry, else the one before it, passing
over rows that cannot be shown, else the start page
([succession](../apps/web/src/components/workspace/place-succession.ts)). The Workspace still
governs access and profile grants; its session order never determines which browser a
conversation opens. A transcript link names the exact browser and tab its Run used. A session-only
attachment produces no page chip. Page chips take current labels from the authorized tab catalog,
falling back only to that exact use's recorded labels. Their activity requires the Run's live
session attachment and its conversation's acting occupant on that tab. A reply lists every place
its Run used as chips, in the order it first used them. While that Run works, including while it
waits on the person, a live picture of the place it acted in last sits under them and that chip is
highlighted; the picture shows only when the Thread's newest place reference names that Run and
the place is still live, so it never outlasts its Run or follows a later reply
([`useRunPicture`](../apps/web/src/components/workspace/viewfinder.tsx)). An address that names a
place never listed while shown — an old link, Back to a closed tab — stays exact and shows an ended
state rather than substituting another stream. Mac app
destinations name both the session and app; passive capture cannot follow whichever app the agent
looked at later.

Browser details always accept the person's input alongside the agent. A page takes the size of
the page area the person views it in, as a window does, unless an agent set its own size.
Previews never resize a page, a phone resizes one only when the person fits it, and opening or
switching a view never redirects the agent's target. There is no takeover or turn-taking mode. Run details remain in the
conversation, while finished files arrive as attachments; Files and Activity are no longer
top-level stage destinations. See [Browser sessions](browser-sessions.md) and
[Computer use](computer-use.md) for transport and access boundaries.

## Chat and native AI sessions

Chat is one durable Thread in the person's Main Workspace, identified by
`Workspace.homeThreadId`; the wire and code keep the earlier name `home`. `thread.create` with
`home: true` atomically returns or creates that Thread after a valid execution selection exists.
The Host titles it `CHAT_THREAD_TITLE` whatever title a client sends, so an older client cannot
bring back an earlier name; migration 0070 renamed the Threads clients had titled Home. Every
client calls the place Chat and the agent that answers there Opensteer — the field that writes to
it, the owner of the work it hands out — through the shared `conversationName` and
`messageAuthorName`, so no client renames either. Clients show Chat above one list of the reader's
tasks from every Workspace they belong to, drawn only from the shared `taskList` model, and give
specialists, their name for Workspaces of `kind: "specialized"`, a page of their own that reads
that Workspace's tasks alone (`workspaceTaskList`). Ordinary tasks remain independent Threads with
their own queues and native sessions. The same Host contract serves local, cloud and self-hosted
Deployments and all three clients.

Agents, Triggers and watches can address the person's Chat as `threadId: "home"`. The Host
resolves only the caller's own Chat and preserves the original author. Any agent may leave Chat a
`report`, including a specialist outside Main; `queue` and `steer` require the same reach as
addressing Chat by its id, so the alias grants no general cross-Workspace read or execution
authority. Triggers anchored at Chat can queue to Chat; Chat's agent replies, and that reply is
what notifies the person, which is how a reminder reaches them. A one-shot Trigger whose run
succeeds after its instant is finished and archived, so the Automations page lists only what is
still to come or needs its owner; its messages stay in their conversation.
A person's reply remains a human queued input. An optional `quotedMessageId` is resolved against
an authorized, published Message; the Host stores its exact source ID, author and bounded excerpt.
Quoted text is historical evidence, not a second instruction or an approval receipt.
A report never produces an alert, in Chat or anywhere else; it stays passive and visible.

**Trigger authority.** Every agent can see Triggers within its Thread's reach. The control tier
allows pause, resume, cancellation of pending Occurrences and `set_next_fire` only when the
anchor's access mode is no higher than the actor's; `set_next_fire` moves an active cron Trigger's
next run to a future instant, then normal cadence resumes. The define tier (create, update, manual
run or archive) requires full access in the same kind of Thread and Workspace as the anchor,
except Main can define across its reach. Trigger and Watch programs act as their anchor Thread,
including its reach and allowed tools; programs anchored at non-main Threads no longer have
owner-wide authority. Trigger and Revision `createdByThreadId` fields attribute agent writes to
the calling Thread or program's anchor; null means a person or unknown author. Automations links
to the creating conversation. No push notification accompanies these writes, so agents tell the
person when they create a Trigger or change what it runs.

The Thread's selected ProviderSession is created before Run admission. Every new Run pins that
exact row. Native identity and state layout belong to the ProviderSession; the Thread's
`continuationIdentity` is a derived compatibility projection. Binding, dispatch and recovery never
look up a different session by whichever one happens to be selected later.

A compatible model/account change updates the selection normally. An explicit continuation sends
`thread.execution.update` with `continuation.expectedProviderSessionId`, creating a fresh selected
session under the same Thread, even when the selected route is compatible or unchanged. This is
also the explicit recovery operation when native startup or resume cannot safely continue; it
never silently repeats an uncertain turn. A stale expected selection or any nonterminal Run refuses the
change. Waiting inputs that have not been admitted survive, and a paused queue stays paused.
Switching back creates another fresh session; it does not revive an older session with stale
context. `thread.execution-updated` records the selection in the conversation.

When the new session first receives work, the Host freezes candidate IDs and a history cutoff with
the work-input snapshot. After inspecting the live model catalog, dispatch finalizes a newest
suffix exactly once. Known context windows bound the added history conservatively after reserving
space for output, current inputs, reports and prompt overhead. Unknown windows retain the generic
transport bound. This does not replace the harness's tokenizer or guarantee room for its entire
native prompt. Retries reuse the final subset; a later route with less room fails before sending
rather than changing it.

The window retains authored records, quotes and source IDs, and tells the agent how much was
omitted. It is context on the first native turn, never a synthetic Message or an extra model run.
A minted native reference without an accepted turn still needs that context. Unknown delivery
never proves that startup is safe to repeat.

Native compaction stays with each harness. Subsequent turns resume the exact native reference
without importing the transcript or creating a platform summary. A missing reference or failed
resume remains an error. New sessions use private state keyed by ProviderSession ID; migrated
sessions retain their explicit legacy Thread layout. All Runner adapters share this distinction.
Runner capability `native-session-continuation-v1` and Host API epoch 21 require this contract;
an older Runner must upgrade before dispatch rather than silently omit continuation context.

The durable conversation remains available beyond the native context window. `thread_read` supports
bounded text search and exact message anchors. Client `thread.messages.list` returns canonical
messages for search, and `thread.events.list` can load an anchored event window including tool
activity. Search and quote reads exclude undelivered or withdrawn work. Loading an old window does
not mark unseen later messages as read.

## Starting versus resuming an AI conversation

A failed Run is an execution attempt, not proof of a provider conversation. Workspace or profile
setup may fail before the first session exists. `acquireExecutionBinding` permits another initial
startup only when the selected ProviderSession has no established native reference or accepted
turn and earlier attempts prove that provider startup did not occur. Legacy sessions also consider
older Thread runs that could not be backfilled to a specific ProviderSession. A lost Runner boot
alone cannot prove that a session never started.

Once a provider conversation exists, subsequent runs must resume that exact reference. A missing
reference or failed resume never falls back to a fresh conversation. Domain errors remain visible
to the user, while the Host logs the original dispatch exception with its command ID for diagnosis.

`HarnessAdapter.resumeSession` attaches that provider conversation; the Runner checks the returned
reference before publishing `runner.session-bound`. Resume must neither replay Host messages nor
publish provider history as new Run events. The only initial historical context is the explicitly
frozen first-turn window described above. Exclude history from startup responses where supported
(`excludeTurns` in Codex). Provider compaction does not bound serialized transcript size, so keep
transport limits intact. All deployment shapes use `apps/runner/src/runtime/runtime.ts` for this
boundary.
