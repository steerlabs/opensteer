# Controls

Opensteer creates both passes and owns their schedules: each is a hidden task woken by an
automation. Find them with `opensteer_automation_list` and `systemRole` `memory-light` or
`memory-nightly`; each automation's `taskId` is its worker. Never create, archive or
reprogram them; Opensteer refuses.

## Pause and resume

Use `opensteer_automation_control` with each `automationId` and action `pause`, or `resume`.
To keep memory but turn the passes off, pause both; they stay paused until the person asks.
A pass already running finishes its turn. The tasks the light pass opened for open items stay;
they are ordinary tasks the person can finish or mark Done.

Opensteer picks each pass's model from the person's background models below; an active pass
with a `waitingReason` has no model it can use yet and resumes by itself, so tell the person the reason rather than pausing or resuming it.

## Background models

`settings.json` in Agent home says which models do background work: `naming` names new tasks,
`light` runs the light pass, and `deep` runs the nightly pass. Change it only when the person asks,
with ordinary file edits:

```json
{
  "backgroundModels": {
    "naming": [],
    "light": [{ "engine": "claude", "model": "anthropic/claude-haiku-5-5" }],
    "deep": [{ "engine": "codex", "account": "<aiAccountId>" }],
    "excludedAccounts": ["<aiAccountId>"]
  }
}
```

Each entry names an `engine`, and optionally a `model` and an `account` from
`opensteer_ai_account_list`; without `model` it uses that account's own small model. Opensteer
tries the person's entries in order, then its recommended order, so a missing file, key or empty
list means the recommended order. `excludedAccounts` keeps those AI accounts out of background
work. Read the file before editing and keep it strict JSON with only these keys. If it is invalid,
the last valid settings keep running and your next Run's instructions name the error; fix the file
then.

## Stop remembering

1. Replace only the contents under `## Memory`, keeping its heading and everything outside that
   section byte-for-byte (including standing instructions), with
   `Memory: off at the person's request; deleting memory once both passes stop.`
2. Pause both automations, then call `opensteer_task_update` with `done: true` and each worker's
   `taskId`. Done cancels queued wakes and asks a running pass to stop.
3. Call `opensteer_task_read` with `limit: 1` on each worker. Once neither `task.status` is
   `running` or `waiting`, delete `memory/` (and `skills/light-pass/` if an older version left
   it), then shorten the line to
   `Memory: off at the person's request.`

If a worker is still stopping, make at most three further pairs of `opensteer_task_read` checks in
this Run. Keep the files while either is running or waiting. If both stop, finish deletion now;
otherwise arrange the continuation below before ending this Run.

If they still have not stopped, read the existing `opensteer:automations` reminders reference
(`references/reminders.md`), then call `opensteer_automation_create` for a one-shot reminder
named `Reminder: finish deleting memory`,
on this task, a few minutes later using the person's context time zone and an ISO-8601 instant
with its date's offset. Declare `toolContractVersion: 5`; its program is:

```ts
export default async function ({ event, opensteer }) {
  await opensteer.callTool("opensteer_task_send", {
    delivery: "queue",
    message: "Finish deleting memory",
    taskId: event.trigger.anchorThreadId,
  });
}
```

Confirm `nextFireAt` with `opensteer_automation_read`, then tell the person deletion is pending and
this task will recheck and finish then. That continuation repeats the pause and Done steps, then rechecks both workers before deleting; if still busy,
arrange another one-shot follow-up. Never claim erasure before deletion. If this task lacks full access
to create the reminder (or creation fails), keep the pending line and files, explain that automatic
follow-up could not be arranged, and tell the person to say "finish deleting memory". If the context
time zone is unknown, ask for it as the reminders reference requires; do not promise a scheduled
follow-up until creation succeeds.

## Turn back on

Finish any pending deletion first. Replace only the contents under `## Memory` with
`Memory: on again from <the current ISO-8601 instant>.`, preserving everything outside it
byte-for-byte, so the passes start fresh rather than from their handoffs before erasure; reopen each worker marked Done with `opensteer_task_update`
and `done: false`, then resume both automations. Preserve both worker and automation identities.
