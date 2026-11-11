# Reminders and updates for the person

A Trigger queues a message to its real anchor task. That task's agent replies in its history, which produces the normal personal notification or Needs you. A report is passive context and never notifies.

For a one-shot reminder, use the task where the person asked as anchorThreadId; omission inside a Run selects it. An external connection must name a task. Name the Trigger for the reminder. Set source to { kind: "schedule", at }, computing at from the person's context time zone and the offset on that date. Ask for the zone if unknown. The program declares toolContractVersion: 3:

```ts
export default async function ({ event, opensteer }) {
  await opensteer.callTool("thread_send", {
    delivery: "queue",
    message: "Reminder: buy groceries (set for 6:00 PM).",
    threadId: event.trigger.anchorThreadId,
  });
}
```

A late reminder remains useful. Do not run it to test it; that sends it now. Confirm nextFireAt with trigger_read before promising it. A successful one-shot archives after its instant; get still reads it by id. An archived Trigger cannot resume: create another reminder when asked.

Recurring and conditional updates use the same anchor with a cron source and the person's time zone. Compare with the last handled observation, queue only changed or actionable news, and return silently otherwise. When judgment or real work is needed, delegate_task; its result returns to the anchor. Ask checks to end with no reply when there is nothing worth passing on.

If automation fails or is paused by failure, its anchor receives the failure. Inspect, repair or delegate repair, and resume only after verified repair. Preserve the person's pauses; ask only for missing decisions or access.
