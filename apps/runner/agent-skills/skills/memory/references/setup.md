# Set up the background passes

Two task Threads in Main keep memory useful between conversations. The light pass runs often on a
cheap model and tells Chat when something deserves the person's attention soon. The nightly pass
runs once a night on your own model, curates memory and prepares the next day. Neither reaches the
person except by queueing a message to Chat.

Chat sets both up once, on its own, without asking or announcing it. They are visible in the
person's task list and Automations, where the person can pause or delete them. The `## Memory`
section of Main's `AGENTS.md` is the record that setup happened: once it exists, never set the
passes up again unless the person asks. A pause or deletion is the person's choice; keep it.

## Files

These paths are fixed so every pass finds them. Everything else under `memory/` is notes.

- `memory/passes/setup.md`: Chat's Thread ID, Main's `workspaceId`, both worker Thread IDs, both
  Trigger IDs, the light pass's model, the time zone and the setup date. Chat writes it; the
  nightly pass updates it when it changes a schedule.
- `memory/passes/light.md`: the light pass's own state. Only the light pass writes it.
- `memory/passes/nightly.md`: the nightly checkpoint and morning notes. Only the nightly pass writes it.
- `skills/light-pass/SKILL.md`: what this person's light pass watches, from the template below.
  The nightly pass tunes it and logs each change in `skills/light-pass/changes.md`.

## Steps

Creating a Trigger needs full access; without it, leave setup for a later Run that has it. If
`memory/passes/setup.md` already exists, finish from it and reuse what it lists.

1. Find Chat's Thread ID and Main's `workspaceId` with `thread_list` and `query` `Chat`: Chat is
   the Thread titled `Chat`, with no `parentThreadId`, in the one Workspace `project_list` does not
   return. Use the person's time zone from the Opensteer thread context; when it is unknown, use
   the computer's IANA zone (`node -p "Intl.DateTimeFormat().resolvedOptions().timeZone"`).
2. Find the engine's light model reported by `environment_list` for your engine. If it reports
   none, use your own model and a slower light schedule, such as `0 8-22/2 * * *`.
3. Write `skills/light-pass/SKILL.md` from the template and create `memory/inbox/`.
4. Create the workers with `thread_delegate`, `workspaceId` set to Main:
   - title `Light memory pass`, `model` set to the light model (omit it when using your own), task:
     "You are the person's light memory pass. A schedule wakes you with a queued message; each time,
     load opensteer:memory and follow its light-pass reference. Nothing to do now: end this turn
     with no reply text."
   - title `Nightly memory pass`, no `model`, the same task naming the nightly-pass reference.
5. Create one schedule per worker with `trigger_write` action `create`: `name` matching its title,
   `anchorThreadId` the worker's Thread ID, `source` `{ kind: "schedule", cron, timezone }` with
   cron `*/30 8-22 * * *` for the light pass and `0 3 * * *` for the nightly pass, and `program`
   `{ language: "javascript", toolContractVersion: 3, source }` from the program below. Confirm
   each `nextFireAt` with `trigger_read` action `get`.
6. Write `memory/passes/setup.md`, then add the `## Memory` section to `AGENTS.md` with a
   one-line placeholder summary and `Background passes set up <date>; see memory/passes/setup.md.`

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
    message: `Light pass due (${event.source.scheduledFor ?? event.receivedAt}). Load opensteer:memory and follow its light-pass reference.`,
    threadId,
  });
}
```

For the nightly pass, say `Nightly pass due` and name the nightly-pass reference.

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

Sources: Chat, active tasks, `memory/inbox/`, the nightly pass's morning notes, and the mail,
Messages and calendar integrations connected to Main.
```

## Off and on again

To turn the passes off at the person's request, set both Triggers' status with `trigger_write`
action `set_status`: `paused` for a pause, `archived` to delete. Record it in
`memory/passes/setup.md` and in the `## Memory` section. To turn them back on, resume paused
Triggers, or create new ones on the recorded workers (reopen a Done worker with `thread_write`
action `reopen`), and update both records.
