---
name: opensteer-triggers
description: For reminders, scheduled updates, webhooks or watches, create/inspect/repair/control an Opensteer Trigger. Load before authoring its program.
---

# Opensteer Triggers

## Recurring work

Inspect existing Triggers before creating another for the same work. Reuse the anchor Thread and
Workspace that own the task. Keep reusable logic and observations in that Workspace so later
Occurrences can continue it. Use ordinary code for deterministic checks; queue model work when
judgment or action is needed.

Carry the user's criteria and authorization into the program or queued task. Unless periodic
updates were requested, suppress unchanged or non-actionable observations before queueing a
Thread; queue meaningful changes, needed decisions, and failures the automation could not recover
from. Persist the last handled observation so restarts do not repeat the same notification or
external action.

Visibility follows your Thread's reach. Pausing, resuming, canceling pending Occurrences or moving
the next run requires an anchor whose access mode is no higher than your own. Creating, updating,
manually running or archiving one requires full access in the same kind of Thread and Workspace
as its anchor; Main can define across its reach. Tell the person when you create a Trigger or
change what it runs.

### Keep it running

Recurring work is useful only while it runs. Build it to recover from ordinary failures by itself:
a page that did not load or shows an error, a missing element or dialog, a lost setting, a
timeout, an ended session. Restore the expected state and retry with growing waits, such as 30
seconds doubling to 15 minutes, then return to the normal cadence once a check succeeds. Never
abandon recovery or wait for a person on an ordinary failure; a Run may end once the next retry is
confirmed or the unresolved recovery is handed to its assigning Thread. A retry budget an agent
chose, including one recorded in the monitor's own files, may slow repeated unsuccessful attempts,
but never delays a different repair supported by new evidence, such as a fixed bug; revise it when
it costs coverage.

Give each monitor one recovery owner. Persist its retry timing where every Occurrence and Run reads
it, and skip a check or repair while another is in progress. Before a Run ends or the monitor's
only Trigger is paused, confirm what will continue the recovery; never promise a retry without it.

Respect site blocks and rate limits; never change identity or session to get past them. After a
rate limit, retry once the longer of the site's requested delay and 15 minutes has passed. For
sign-in, follow opensteer-browser. When a CAPTCHA, approval or missing credential needs the person,
tell them once and suspend the affected checks until it is resolved; do not reload the challenge
or repeat a pending Request.

When a program hands each check to a Thread task, give the task the same rules: repair ordinary
failures within its Run and continue. Escalate what stays unresolved to the Thread that assigned
it, with evidence and the next repair step; ask the person only for decisions or access agents
cannot supply. Never write a rule into the program, its task or the Workspace that stops the work
on an ordinary failure.

For an active cron schedule, back off with `trigger_write` action `set_next_fire`, supplying a
future ISO instant as `nextFireAt`; normal cadence resumes after that run. Pause only when nothing
should run, and resume when work can continue. A worker dispatched by a Trigger can manage that
Trigger within its own authority, without a round trip through Main.

## Reminders and updates for the person

The person is notified when an agent replies to them, never by a `report`. A Trigger reaches the
person by queueing a message to Chat; Chat's agent replies, and that reply is the notification.

A reminder is a one-shot schedule anchored to Chat, the Thread the person asked in:

- `anchorThreadId` is `"home"`, which names the person's Chat.
- Name the Trigger after the reminder, such as `Reminder: buy groceries`.
- `source` is `{ kind: "schedule", at }`. Compute `at` from the person's time zone and local time
  in the Opensteer thread context, as an ISO-8601 instant with the offset in effect on that date.
  When the context says the time zone is unknown, ask the person before creating it.
- The program declares `toolContractVersion: 3` and queues the reminder to `home`:

```ts
export default async function ({ opensteer }) {
  await opensteer.callTool("thread_message", {
    delivery: "queue",
    message: `Reminder: buy groceries (set for 6:00 PM).`,
    threadId: "home",
  });
}
```

Do not add the staleness guard from "Concurrency and staleness" to a reminder: a late reminder is
still useful, and Chat's agent can say it is late. Do not `run` a reminder to test it; that sends
it now. Confirm its `nextFireAt` with `trigger_read` and tell the person when it will fire.

A one-shot schedule is finished once a run succeeds after its instant: Opensteer archives it, so it
leaves `trigger_read` action `list` and the person's Automations page, while `get` still reads it
by id. An archived Trigger cannot be changed or resumed; to remind the person again, create a new
reminder.

For a recurring or conditional update, such as a morning summary or a price alert, anchor to Chat
the same way and use the person's zone as a cron `timezone`. Queue to `home` only when there is
something worth telling: compare with the last handled result in code and return without queueing
when nothing changed, because each reply in Chat can notify the person. When the update needs
judgment or real work, have the program call `thread_delegate` instead; the task's result returns
to the anchor, Chat, whose agent tells the person.

When an automation stops working, because its one-shot run failed or Opensteer paused it after
repeated failures, Opensteer queues a message saying so to its anchor Thread. That Thread's agent
repairs it: inspect the failure, fix the program or delegate the repair, resume it once the fix is
confirmed, and tell the person what happened. Ask the person only for what needs their decision or
access.

## Program contract

Trigger programs execute as Node.js ESM modules (Node 24 or newer) on the anchor Thread's Runner, with the anchor Workspace mounted as the working directory, so relative paths and relative imports resolve from the Workspace root. The source must export one default function (async or not): The program object must declare toolContractVersion: use 3 for new programs. Version 3 uses report/queue/steer delivery and environment_list for environment, engine and model discovery; workspace_list returns only Workspaces and its window. Saved version 2 programs preserve report/queue/steer delivery and the previous workspace_list discovery schema/results; saved version 1 programs also preserve queue/trigger delivery semantics. Editing timing or status preserves the saved program version. `export default async function ({ event, capabilities, opensteer }) { ... }`. `event` is frozen ({ id, payload, receivedAt, source, trigger }); `event.source.kind` is "schedule" (with scheduledFor), "webhook" (with method, headers, and optional deliveryId), "manual" (a manual run carries only the payload), or "watch" (the single startup event for a continuous watch). A watch program runs continuously on the anchor Thread's machine and must not resolve; Opensteer restarts unexpected exits with exponential backoff and pauses the Trigger after three consecutive unexpected exits. `capabilities.mcp` and `capabilities.integrationMcp` are short-lived Opensteer MCP endpoints ({ url, token }); `capabilities.browserCdp` is a short-lived CDP WebSocket endpoint ({ url, token }) or null when the Workspace has no browser grant. For a watch, every non-null capability also has expiresAt. Watch capabilities rotate while the process runs: call `opensteer.capabilities()` for the current values, and reconnect an expired CDP session with its current browserCdp value. `opensteer.callTool(name, input)` calls Opensteer product tools (Workspaces, Threads, Triggers); `opensteer.integrations.callTool(name, input)` calls integration tools already granted to the Workspace. Supply a stable observationId with each watch call to thread_message or thread_delegate; when omitted, the request ID is used. Opensteer deduplicates the ID and admits up to 120 independent observations per activation per hour. Node built-ins (node:fs, node:child_process, ...), fetch, and packages installed in the Workspace's own node_modules are available; Deno, Bun, and DOM globals such as window and document do not exist, and nothing installs packages automatically. TypeScript runs through Node's built-in type transform: type annotations, enums, and namespaces work; tsconfig paths, decorators, and JSX do not. For schedule, webhook, and manual runs, the awaited return value serialized as JSON (at most 512 KiB) becomes the occurrence result, and a thrown error fails the occurrence with its message and stack. Their console output is captured as stdout and stderr (512 KiB each); watch stdout and stderr retain only their latest 16 KiB tails. A program acts as its anchor Thread: its Opensteer tool calls reach only what that Thread can reach, and only a full-access agent can write one.

## Tool usage

- `trigger_read` action `list` accepts optional `workspaceId` and `limit`. Action `get` needs `triggerId` and returns current Trigger state, its current Revision, and recent Occurrences.
- `trigger_write` actions are `create`, `update`, `set_status`, `set_next_fire`, `run`, and `cancel`. `create` needs `name`, `anchorThreadId`, `program`, and `source`. `update` needs `triggerId`, a fresh `expectedRevisionId` from `get`, and at least one changed field. `set_status` needs `triggerId` and `status`. `set_next_fire` needs `triggerId` and a future `nextFireAt`; it only changes the next run of an active cron schedule. `run` needs `triggerId` and accepts optional `payload`. `cancel` needs `triggerId` and optionally one `occurrenceId`; omitting it cancels every pending Occurrence.
- `source` is flat. `kind: "schedule"` takes exactly one of `at` or `cron`; `cron` also needs an IANA `timezone`. `kind: "webhook"` and `kind: "watch"` take none of `at`, `cron`, `timezone`, or `payload`.

## Folder watch

Keep the process alive, use a stable observation ID, and let Opensteer stop it:

```ts
import { readFile, rename, watch, writeFile } from "node:fs/promises";

export default async function ({ event, opensteer }) {
  const cursorPath = ".opensteer-folder-watch-cursor";
  let cursor = Number(await readFile(cursorPath, "utf8").catch(() => "0"));
  const folder = watch("./incoming");
  for await (const change of folder) {
    if (!change.filename) continue;
    const nextCursor = cursor + 1;
    await opensteer.callTool("thread_message", {
      delivery: "queue",
      message: `Changed: ${change.filename}`,
      observationId: `folder:${nextCursor}`,
      threadId: event.trigger.anchorThreadId,
    });
    await writeFile(`${cursorPath}.next`, String(nextCursor));
    await rename(`${cursorPath}.next`, cursorPath);
    cursor = nextCursor;
  }
}
```

## Reporting rules

- “Trigger created” means the Trigger record exists.
- “Test queued” means a manual Occurrence was accepted.
- An occurrence-based Trigger works only after you inspect a terminal `succeeded` Occurrence.
- A watch works only when its activation is healthy and you observe its intended effect.
- “Trigger activated” means schedule or webhook ingress is on, or the current watch activation reports `running`.

Never claim an occurrence-based Trigger works when it has zero Occurrences, when the relevant Occurrence is `pending` or `running`, when it failed, or when you did not inspect its result. Report exactly what Opensteer returned, including status, error, result, stdout, and stderr where relevant.

## Manual runs

`run` creates a real Occurrence with real side effects; it is not a dry run. Use it only when the user asks for it or the program has no external side effects. Never have more than one manual Occurrence in flight for a Trigger: do not call `run` again while one is `pending` or `running`. Cancel a pending Occurrence first if abandoning it; a running Occurrence cannot be canceled, so wait for it to become terminal.

A manual Occurrence has `event.source.kind === "manual"`. It verifies the runtime and general program path, not schedule- or webhook-specific branches.

## Repair

A failing active Trigger may already have pending Occurrences pinned to its old Revision. Cancel its pending Occurrences before `update`; pause only if nothing should run during repair, then resume when the repair is confirmed. A Trigger with `status: "paused"` and a non-null `pauseReason` was paused automatically by Opensteer. For a watch, inspect `activation.lastError` and `activation.stderrTail` from `trigger_read` action `get`; otherwise inspect the latest Occurrence's `error` and `stderr`. Fix the program, then set its status to `active`.

For an `at` schedule, activating after its instant has passed never fires it: `nextFireAt` remains
null. Give it a new `at` with `update` instead; a failed one-shot stays listed until it is fixed,
rescheduled or archived.

## Concurrency and staleness

A Trigger program may run concurrently with itself. Use `event.id` as the idempotency key for external effects and never assume exclusive Workspace access.

Pending Occurrences can execute long after ingress. Guard schedule and webhook work explicitly; manual Occurrences do not carry either source-specific timestamp:

```ts
const eventTime =
  event.source.kind === "schedule"
    ? event.source.scheduledFor
    : event.source.kind === "webhook"
      ? event.receivedAt
      : null;
if (eventTime) {
  const lateBy = Date.now() - Date.parse(eventTime);
  if (lateBy > 15 * 60 * 1_000) return { lateBy, skipped: "stale" };
}
```

Use a small `occurrenceLimit`, normally 1–5, on `trigger_read` action `get`. Occurrences carry stdout and stderr; inspect them with the terminal result.

Creating a Trigger does not run a model. Its program may queue ordinary Thread work through `opensteer.callTool`.

Before delegating with a named engine or model in a version 3 program, call
`environment_list` with `query` to find the canonical provider/model pair and its
options. Focus `harnessInstanceId` and follow `modelsNextCursor` with `cursor`
for more matching models. Follow `harnessesNextCursor` with `harnessCursor` and
`environmentsNextCursor` with `environmentCursor` to enumerate the directory.
Watch programs may call `environment_list`, `thread_message` and `thread_delegate`,
intersected with their anchor Thread's authority.
