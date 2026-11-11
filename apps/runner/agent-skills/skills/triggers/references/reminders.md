# Reminders and updates for the person

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
  await opensteer.callTool("thread_send", {
    delivery: "queue",
    message: `Reminder: buy groceries (set for 6:00 PM).`,
    threadId: "home",
  });
}
```

A late reminder is still useful, and Chat's agent can say it is late; do not discard it merely for lateness. Do not `run` a reminder to test it; that sends
it now. Confirm its `nextFireAt` with `trigger_read` and tell the person when it will fire.

A one-shot schedule is finished once a run succeeds after its instant: Opensteer archives it, so it
leaves `trigger_read` action `list` and the person's Automations page, while `get` still reads it
by id. An archived Trigger cannot be changed or resumed; to remind the person again, create a new
reminder.

For a recurring or conditional update, such as a morning summary or a price alert, anchor to Chat
the same way and use the person's zone as a cron `timezone`. Queue to `home` only when there is
something worth telling: compare with the last handled result in code and return without queueing
when nothing changed, because each reply in Chat can notify the person. When the update needs
judgment or real work, have the program call `delegate_task` instead; the task's result returns
to the anchor, Chat, whose agent tells the person. Tell the task to end with no reply when
nothing is worth passing on; an empty final reply returns nothing.

When an automation stops working, because its one-shot run failed or Opensteer paused it after
repeated failures, Opensteer queues a message saying so to its anchor Thread. That Thread's agent
repairs it: inspect the failure, fix the program or delegate the repair, resume it once the fix is
confirmed, and tell the person what happened. Ask the person only for what needs their decision or
access.
