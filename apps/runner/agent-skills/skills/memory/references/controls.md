# Controls

Opensteer creates both passes and owns their schedules: each is a hidden task Thread woken by a
Trigger. Find them with `trigger_read` action `list` and `systemRole` `memory-light` or
`memory-nightly`; each Trigger's `anchorThreadId` is its worker. Never create, archive or
reprogram them; Opensteer refuses.

## Pause and resume

Use `trigger_write` action `set_status` with each `triggerId` and status `paused`, or `active` to
resume. Before resuming light, read its Trigger: if its pause reason says the engine has no light
model, leave it paused and ask the person to choose a model for the light pass or explicitly accept
running it on the current model. To keep memory but turn the passes off, pause both; they stay paused until the person asks.
A pass already running finishes its turn.

## Stop remembering

1. Replace the whole `## Memory` section with
   `Memory: off at the person's request; deleting memory once both passes stop.`
2. Pause both Triggers, then call `thread_write` action `done` with each worker's `threadId`. Done
   cancels queued wakes and asks a running pass to stop.
3. Call `thread_read` on each worker. Once neither status is `running` or `waiting`, delete
   `memory/` and `skills/light-pass/`, then shorten the line to
   `Memory: off at the person's request.`

If a worker is still stopping, recheck both with `thread_read` a handful of times over about a
minute in this same Run, spacing checks apart (no tight loop). Keep the files while either is
running or waiting. If both stop, finish deletion now.

If they still have not stopped, use the existing `opensteer:triggers` reminders reference
(`references/reminders.md`) exactly: create a one-shot reminder named `Reminder: finish deleting memory`,
anchored to `home`, a few minutes later using the person's context time zone and an ISO-8601 instant
with its date's offset. Declare `toolContractVersion: 3`; its program is:

```ts
export default async function ({ opensteer }) {
  await opensteer.callTool("thread_message", {
    delivery: "queue",
    message: "Finish deleting memory",
    threadId: "home",
  });
}
```

Confirm `nextFireAt` with `trigger_read`, then tell the person deletion is pending and Chat will
recheck and finish then. That continuation rechecks both workers before deleting; if still busy,
arrange another one-shot follow-up. Never claim erasure before deletion. If Chat lacks full access
to create the reminder (or creation fails), keep the pending line and files, explain that automatic
follow-up could not be arranged, and tell the person to say "finish deleting memory". If the context
time zone is unknown, ask for it as the reminders reference requires; do not promise a scheduled
follow-up until creation succeeds.

## Turn back on

Finish any pending deletion first. Start a fresh `## Memory` section, reopen each worker marked
Done with `thread_write` action `reopen`, then resume nightly. Read the light Trigger's pause reason:
if it says the engine has no light model, leave light paused and tell the person to choose a model
for the light pass (or explicitly accept running it on the current model) before resuming it.
Otherwise resume light too. Preserve both worker and Trigger identities.
