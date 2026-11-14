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

For an ongoing monitor, create with `ownTask: true` and use a cron source with the person's time zone. Check in code first; store handled observations under `automations/<trigger-id>/` in Agent home. When a model must check, queue the monitor's task with `freshContext: true`, including the criteria, asking task's ID or email destination, and state path in every wake. Start any child checks from the monitor's task; their results return there automatically. Send real finds to the asking task with `thread_send` delivery `queue`, or email through a connected integration. A `report` never notifies. Briefly record what happened in each background wake, including no change.

When each run should create a new listed task, have the program call `delegate_task` with `standalone: true`. Keep a one-shot reminder in the task where the person asked.

If automation fails or is paused by failure, its anchor receives the failure. Inspect, repair or delegate repair, and resume only after verified repair. Preserve the person's pauses; ask only for missing decisions or access.
