# Controls

Opensteer creates both passes and owns their schedules: each is a hidden task Thread woken by a
Trigger. Find them with `trigger_read` action `list` and `systemRole` `memory-light` or
`memory-nightly`; each Trigger's `anchorThreadId` is its worker. Never create, archive or
reprogram them; Opensteer refuses.

## Pause and resume

Use `trigger_write` action `set_status` with each `triggerId` and status `paused`, or `active` to
resume. To keep memory but turn the passes off, pause both; they stay paused until the person asks.
A pass already running finishes its turn. Opensteer picks each pass's model from the person's
automatic models in AI settings; an active pass with a `waitingReason` has no model it can use yet
and resumes by itself, so tell the person the reason rather than pausing or resuming it.

## Stop remembering

1. Replace only the contents under `## Memory`, keeping its heading and everything outside that
   section byte-for-byte (including standing instructions), with
   `Memory: off at the person's request; deleting memory once both passes stop.`
2. Pause both Triggers, then call `thread_update` action `done` with each worker's `threadId`. Done
   cancels queued wakes and asks a running pass to stop.
3. Call `thread_read` with `limit: 1` on each worker. Once neither `thread.status` is `running` or
   `waiting`, delete
   `memory/` and `skills/light-pass/`, then shorten the line to
   `Memory: off at the person's request.`

If a worker is still stopping, make at most three further pairs of `thread_read` checks in this
Run. Keep the files while either is running or waiting. If both stop, finish deletion now;
otherwise arrange the continuation below before ending this Run.

If they still have not stopped, read the existing `opensteer:triggers` reminders reference
(`references/reminders.md`), then call `trigger_write` action `create` for a one-shot reminder
named `Reminder: finish deleting memory`,
anchored to `home`, a few minutes later using the person's context time zone and an ISO-8601 instant
with its date's offset. Declare `toolContractVersion: 3`; its program is:

```ts
export default async function ({ opensteer }) {
  await opensteer.callTool("thread_send", {
    delivery: "queue",
    message: "Finish deleting memory",
    threadId: "home",
  });
}
```

Confirm `nextFireAt` with `trigger_read`, then tell the person deletion is pending and Chat will
recheck and finish then. That continuation repeats the pause and Done steps, then rechecks both workers before deleting; if still busy,
arrange another one-shot follow-up. Never claim erasure before deletion. If Chat lacks full access
to create the reminder (or creation fails), keep the pending line and files, explain that automatic
follow-up could not be arranged, and tell the person to say "finish deleting memory". If the context
time zone is unknown, ask for it as the reminders reference requires; do not promise a scheduled
follow-up until creation succeeds.

## Turn back on

Finish any pending deletion first. Clear only the contents under `## Memory`, preserving
everything outside it byte-for-byte; reopen each worker marked Done with `thread_update` action `reopen`, then resume both
Triggers. Preserve both worker and Trigger identities.
