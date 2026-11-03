# Set up the background passes

Two task Threads in Main keep memory useful between conversations. The light pass runs often on a
cheap model and tells Chat when something deserves the person's attention soon. The nightly pass
runs once a night on your own model, curates memory and prepares the next day. Neither reaches the
person except by queueing a message to Chat.

Chat sets both up once, on its own, without asking or announcing it. They are visible in the
person's task list and Automations, where the person can pause or delete them. The
`Background passes:` line in the `## Memory` section of Main's `AGENTS.md` records setup:

- `Background passes: setting up, see memory/passes/setup.md.` Finish setup from that file.
- `Background passes: set up YYYY-MM-DD, see memory/passes/setup.md.` Done; never set up again.
- `Background passes: off at the person's request.` Set up only when the person asks.

Set up only when memory is on and no such line exists. A `## Memory` section without one, from
the person or a remembered fact, still gets setup: add the line and keep everything in it.
A pause or deletion the person made in Automations is their choice; keep it.

## Files

These paths are fixed so every pass finds them. Everything else under `memory/` is notes.

- `memory/passes/setup.md`: Main's `workspaceId`, the time zone, the light pass's model, both
  worker Thread IDs, both Trigger IDs and the setup date. Chat writes it; the nightly pass updates
  it when it changes a schedule.
- `memory/passes/light.md`: the light pass's state. Only the light pass writes it, except a forget.
- `memory/passes/nightly.md`: the nightly checkpoint and morning notes. Only the nightly pass
  writes it.
- `memory/forgotten.md`: content-free lines for what the person asked to forget.
- `skills/light-pass/SKILL.md`: what this person's light pass watches, from the template below.
  The nightly pass tunes it and logs each change in `skills/light-pass/changes.md`.

## Steps

Creating a Trigger needs full access; without it, leave setup for a later Run that has it.

1. Call `thread_read` with `threadId: "home"` and `maxMessages: 1`: `thread.id` is Chat and
   `thread.workspaceId` is Main. Use the person's time zone from the Opensteer thread context;
   when it is unknown, use the computer's IANA zone (`node -p "Intl.DateTimeFormat().resolvedOptions().timeZone"`).
2. Read `environment_list`'s `harnesses` entry for your own engine. Pass its `lightModel`
   unchanged as `thread_delegate`'s `model`. If choosing another engine, also pass its `id` as
   `harnessInstanceId`. If none is available, use your own model and a slower light schedule,
   such as `0 8-22/2 * * *`.
3. Write `memory/passes/setup.md` with what you have so far, then add the `setting up` line to
   the `## Memory` section, creating the section with a one-line placeholder summary if needed.
4. Write `skills/light-pass/SKILL.md` from the template and create `memory/inbox/`.
5. Create the workers with `thread_delegate`, `workspaceId` set to Main, recording each Thread
   ID in `memory/passes/setup.md` as soon as it returns:
   - title `Light memory pass`, `model` set to the light model (omit it when using your own), task:
     "You are the person's light memory pass. A schedule wakes you with a queued message; each time,
     load opensteer:memory and follow its light-pass reference. Nothing to do now: end this turn
     with no reply text."
   - title `Nightly memory pass`, no `model`, the same task naming the nightly-pass reference.
6. Create one schedule per worker with `trigger_write` action `create`, recording each Trigger ID
   as soon as it returns: `name` matching its title, `anchorThreadId` the worker's Thread ID,
   `source` `{ kind: "schedule", cron, timezone }` with cron `*/30 8-22 * * *` for the light pass
   and `0 3 * * *` for the nightly pass, and `program`
   `{ language: "javascript", toolContractVersion: 3, source }` from the program below.
7. Confirm each Trigger is active with a `nextFireAt` using `trigger_read` action `get`, then
   change the line to `set up <date>`.

When resuming, check every recorded ID with `thread_read` or `trigger_read` before creating
anything; look for an unrecorded worker or Trigger with `thread_list` and `trigger_read` action
`list`, and reuse it. Create only what is missing.

Then carry on with whatever the person asked; setup needs no mention.

## Program

The program wakes its worker with a queued message. Each queued message becomes its own Run, so it
skips a worker that is running, waiting on a Request, already holding a queued wake, or stopped:

```js
export default async function ({ event, opensteer }) {
  const threadId = event.trigger.anchorThreadId;
  const { thread } = await opensteer.callTool("thread_read", { threadId, maxMessages: 1 });
  if (thread.status === "running" || thread.status === "waiting" || thread.inputQueuePaused) {
    return { skipped: thread.inputQueuePaused ? "stopped" : thread.status };
  }
  await opensteer.callTool("thread_message", {
    delivery: "queue",
    message: `Light pass due (${event.source.scheduledFor ?? event.receivedAt}). Load opensteer:memory and follow its light-pass reference. Write no text at any point in this Run; reach Chat only with a queued thread_message.`,
    threadId,
  });
}
```

For the nightly pass, say `Nightly pass due` and name the nightly-pass reference. Keep the last
sentence: an engine can announce a step before the skill loads, and any text is a reply.

## Light-pass template

```markdown
---
name: light-pass
description: What this person's light memory pass watches. Only the light pass follows it; the nightly pass tunes it.
---

# Light pass

Tell Chat soon about: replies the person is waiting for, messages from people who matter to them,
changes to today's or tomorrow's calendar, commitments due within a day, and anything the nightly
pass or a task flagged for today.

Leave for the nightly pass: routine mail, newsletters, receipts, notifications the person ignores,
and anything that can wait until tomorrow.

Sources: Chat and the tasks in its lineage, `memory/inbox/`, the nightly pass's morning notes,
and the mail, Messages and calendar integrations connected to Main.
```

## Off and on again

A pause the person asks for is `trigger_write` action `set_status` `paused` on both Triggers;
resume them with `active` when asked.

To turn the passes off, first stop both workers with `thread_write` action `done` and each
worker's `threadId`. That cancels queued wakes and interrupts a running pass, so neither can write
afterwards. Then archive both Triggers with `trigger_write` action `set_status` `archived`, and
change the line to `off at the person's request`. To stop remembering altogether, stop and
archive the same way, then delete `memory/` and `skills/light-pass/`, and replace the whole
section with `Memory: off at the person's request.`

To turn them back on, reopen each worker listed in `memory/passes/setup.md` with `thread_write`
action `reopen` before touching its schedule, then resume a paused Trigger or create a new one in
place of an archived one. After memory was off, start a fresh section and follow the steps.
Recreate any missing file, and change the line to `set up <date>`.
