# Trigger controls

- `trigger_read` action `list` accepts optional `systemRole` and `limit`. Action `get` needs `triggerId` and returns current Trigger state, its current Revision, and recent Occurrences.
- `trigger_write` actions are `create`, `update`, `set_status`, `set_next_fire`, `run`, and `cancel`. `create` needs `name`, `anchorThreadId`, `program`, and `source`. `update` needs `triggerId`, a fresh `expectedRevisionId` from `get`, and at least one changed field. `set_status` needs `triggerId` and `status`. `set_next_fire` needs `triggerId` and a future `nextFireAt`; it moves only the next unclaimed run of an active cron schedule, leaving queued and running work untouched. `run` needs a non-archived schedule or webhook `triggerId` and accepts optional `payload`. Watches run continuously and cannot create manual Occurrences. `cancel` needs `triggerId` and optionally one `occurrenceId`; omitting it cancels every pending Occurrence.
- `source` is flat. `kind: "schedule"` takes exactly one of `at` or `cron`; `cron` also needs an IANA `timezone`. `kind: "webhook"` and `kind: "watch"` take none of `at`, `cron`, `timezone`, or `payload`.

`run` creates a real Occurrence with real side effects; it is not a dry run. Use it only when the person asks or the program has no external side effects. Avoid repeating effects while earlier outcomes remain unknown. Cancellation only stops pending work that has not been dispatched; started work keeps running.

Updates require a fresh `expectedRevisionId` from `get`. Pending Occurrences remain pinned to their Revision: decide whether old work should still run, and cancel any no longer wanted. Pause if nothing should run during repair; preserve a person's pause. A non-null `pauseReason` on a paused Trigger indicates an automatic pause. Inspect `activation.lastError` and `activation.stderrTail` for a watch, or the latest Occurrence's `error` and `stderr`, then repair before reactivating.

Activating an `at` schedule after its instant never fires it; `nextFireAt` stays null. Update it to a new future `at`. A failed one-shot remains listed until fixed, rescheduled or archived. A one-shot succeeds after its instant and then archives automatically; archived Triggers cannot be changed or resumed. `list` omits them, while `get` still reads by id. A new reminder needs a new Trigger.

Webhook creation returns its address and secret to the creating task for authorized setup. Keep the
secret out of version control and memory, and use it only with the intended webhook sender.
