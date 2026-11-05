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

In work Threads, Stop pauses admission before interrupting, cancels the Run's pending Requests and
settles it as interrupted even if another outcome races it. Recovery never restarts stopped work.
Only the person who paused or a Workspace owner can Resume, and Resume grants no execution: each
input keeps its requester's authority. In a conversation, only a person's own messages in Chat or
their owner DM can join the reply underway, with the same requester, membership, reply target,
Assignment, engine and model; Stop cancels their untaken inputs without pausing the queue. An
ordinary message never answers a Request; only its answer or Stop releases the hold.

Thread state is a stored projection; a pending Request keeps a Run waiting even if its Runner
reports running. The [lock order](../packages/database/src/lock-order.ts) is authoritative: lock the
complete authority and event Workspace sets in order, then rediscover; growth means rollback and
retry. Retryable transactions return only the committed attempt's events, and callbacks doing
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
scoped download capability, never bytes; downloads recheck membership or the Run's binding, and
never expose waiting inputs or unselected reports. The Runner cache is disposable, hash-verified and
outside private state, Workspaces and system temp. Isolated Linux services see only the active
Thread's directory, read-only; shared-service macOS offers attachments only to engines whose sandbox
enforces that (Codex, Claude); shared-service Windows offers none, as that isolation is unverified.

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
cannot outlive it. Engine background work stays with its Run, since one engine process cannot
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

A voice call is one non-recoverable Run on a hidden child Thread of Chat. Its Thread accepts only
the call seed and is archived atomically when the Run ends. Durable work goes through Chat, so tasks
and their results survive the call. The person's screen [follows the call](../apps/host/src/voice/voice-follow.ts)
from Host events, because a model step per place costs seconds on a call and forgets. Context for
the agent waits between turns: Codex samples again for anything injected into a running turn, and
that second answer would replace the reply.

## Run tool authority

Resource access intersects [consent reach](#one-mcp-live-caller-authority) with the
[resource guard](../packages/database/src/resource-access.ts). Main inheritance needs the lineage
root to act as the requester in their own Main. Projects need the requester's explicit grants;
browser consent also needs the grant creator's active membership, and reads never create grants.
Connection ceilings, owner Off or Main exclusions and specialist bindings only narrow access, and
cannot erase instructions already in an engine's history. Plugin owner settings are never
agent-reachable. A caller without Main authority cannot reuse, queue to or steer a Main-lineage
Thread; a specialist sends only reports outside its registration. Every capability names the current
attempt's grant. Tool admission needs an active grant, live binding, matching Runner boot and
non-deleting Workspace; reporting needs only the binding, so a stopped Run can record its end.
Revocation and admission share the Run lock, and revoking a grant closes its SSH and computer-use
sessions ([`execution-authority.ts`](../packages/database/src/execution-authority.ts)). A Thread
runs again only once its prior processes are proven gone, with start time checked against PID reuse
([containment](../apps/runner/src/runtime/execution-containment.ts)). Interrupts, restarts and
Request answers replay by command ID after reconnect; unconfirmed steers do not.

## Conversation roles and Assignments

Role controls instructions and presentation, never access. Only a Run answering the person directly
may use `person_message` or `person_show`; a task answers its assigner. A completed Run's last
substantive reply is its single result ([`run-reply.ts`](../packages/database/src/run-reply.ts)). An
Assignment spans Runs, one open per worker, and its identity travels with inputs so a late approval
cannot attach to a new task. Completion is derived transactionally, never declared by an agent;
results return only if the requester can still read the worker Workspace, and an empty result wakes
nobody unless a parent Assignment needs it. Cancellation follows Assignments, not Thread lineage.
Pending Requests are scoped to who may answer; a question docked in another conversation is answered
through its own Thread's authority. Done is shared and needs active membership plus the task's
creator or a Workspace owner; Chat and active channel conversations cannot be Done. Done stops the
open Assignment subtree, withdraws actionable inputs and Requests, pauses anchored Triggers and
revokes grants; Reopen starts nothing. A task moves in lists only when a person asks it for
something (`askedAt`). Clients never link to Workspaces the reader cannot open.

## Pages and apps in a conversation

Durable browser use is separate from a live Run attachment; a late CDP answer cannot reattach an
ended Run. Place references are frozen with the message, grant no access and never open sessions or
request approval. Browser presence shows authorized viewers only site and title, Mac presence only
its owner, and page addresses never enter notification or channel summaries. Agent activity never
navigates the person's selected place. See [Browser sessions](browser-sessions.md) and
[Computer use](computer-use.md).

## Personal memory

Memory is ordinary files in Main reaching Runs through Main's `AGENTS.md`, with no memory store or
tool. Projects never see it, since Project members read what reaches a Project. Memory is evidence,
never permission: nothing remembered authorizes an action, and inbound content never becomes a
standing rule. Only the nightly pass curates; others write only what the person asks for or raw
inbox scraps, and each nightly pass reapplies recorded forgets. Opensteer creates each Main's two
background passes (the Trigger's `systemRole`); the Host refuses archive, reprogramming and manual
runs, and inserts them paused when memory is off. Stopping memory writes the off line first, pauses
both workers and marks them Done, and erases files only once neither is running or waiting. Each pass
chooses its model at admission on Main's computer, keeps it for that pass, and starts a fresh native
session, since continuity lives in the files. With no usable model a pass waits, which is neither a
pause nor memory off, so recovery can't undo either. Main is not yet a private boundary: a shared channel routed into Main receives its `AGENTS.md`. See
[`opensteer:memory`](../apps/runner/agent-skills/skills/memory/SKILL.md).
