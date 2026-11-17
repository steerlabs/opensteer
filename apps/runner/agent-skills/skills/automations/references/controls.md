# Automation controls

- `opensteer_automation_list` accepts optional `systemRole` and `limit`. `opensteer_automation_read` needs `automationId` and returns current automation state, its current Revision, and recent Occurrences.
- `opensteer_automation_create` needs `name`, `program` and `source`, and takes `taskId` for its task; omitting it inside a Run uses this task.
- `opensteer_automation_update` needs `automationId`, a fresh `expectedRevisionId` from `opensteer_automation_read`, and at least one changed `name`, `program` or `source`.
- `opensteer_automation_control` needs `automationId` and an `action`: `pause`, `resume` or `archive`; `reschedule` with a future `nextFireAt`, which moves only the next unclaimed run of an active cron schedule, leaving queued and running work untouched; `run_now` for a non-archived schedule or webhook, with optional `payload`; `cancel_pending` with optional `occurrenceId`, where omitting it cancels every pending Occurrence. Watches run continuously and cannot create manual Occurrences.
- Choose the task: reminders stay in the asking task; `ownTask: true` gives an ongoing monitor its own linked task. For a new listed task per run, call `opensteer_task_create` from the program.
- `source` is flat. `kind: "schedule"` takes exactly one of `at` or `cron`; `cron` also needs an IANA `timezone`. `kind: "webhook"` and `kind: "watch"` take none of `at`, `cron`, `timezone`, or `payload`.

`run_now` creates a real Occurrence with real side effects; it is not a dry run. Use it only when the person asks or the program has no external side effects. Avoid repeating effects while earlier outcomes remain unknown. Cancellation only stops pending work that has not been dispatched; started work keeps running.

Updates require a fresh `expectedRevisionId`. Pending Occurrences remain pinned to their Revision: decide whether old work should still run, and cancel any no longer wanted. Pause if nothing should run during repair; preserve a person's pause. A non-null `pauseReason` on a paused automation indicates an automatic pause. Inspect `activation.lastError` and `activation.stderrTail` for a watch, or the latest Occurrence's `error` and `stderr`, then repair before reactivating.

Activating an `at` schedule after its instant never fires it; `nextFireAt` stays null. Update it to a new future `at`. A failed one-shot remains listed until fixed, rescheduled or archived. A one-shot succeeds after its instant and then archives automatically; archived automations cannot be changed or resumed. The list omits them, while `opensteer_automation_read` still reads by id. A new reminder needs a new automation.

Webhook creation returns its address and secret to the creating task for authorized setup. Keep the
secret out of version control and memory, and use it only with the intended webhook sender.
