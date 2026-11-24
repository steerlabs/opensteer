# Evidence of execution

- “Automation created” means the automation record exists.
- “Test queued” means a manual Occurrence was accepted.
- An occurrence-based automation works only after you inspect a terminal `succeeded` Occurrence.
- “Automation activated” means schedule or webhook ingress is on, or the current watch activation reports `running`.

Never claim an occurrence-based automation works when it has zero Occurrences, when the relevant Occurrence is `pending`, `running`, or `unknown`, when it failed, or when you did not inspect its result. Report exactly what Opensteer returned, including status, error, exit code, stdout, and stderr where relevant.

A manual Occurrence has `event.kind === "manual"` in `OPENSTEER_EVENT`. It tests the runtime and general path, not schedule- or webhook-specific branches. Use `event.scheduledFor` for schedule freshness and `event.firedAt` for webhook freshness. A manual event also has `firedAt`, but no scheduled time or webhook request. Apply the person's freshness requirements, not a universal staleness cutoff.

One firing of an automation runs at a time, and separate automations share Agent home state. Use `event.firingId` (`OPENSTEER_FIRING_ID`) as an idempotency key for external effects, and persist handled observations under `automations/<automation-id>/` to avoid repeated actions or notifications. Verify the chosen task and destination: reminders in the asking task, ongoing monitors in their own task (`ownTask: true`), or new tasks per run through `opensteer_task_create`. For fresh model checks, confirm each queued wake has `freshContext: true` and its criteria, destination and state path. Child checks start from the monitor task; their results return there. A background wake briefly records what happened; real finds use `opensteer_task_send` queue to the asking task or email through a connected integration. A `report` never notifies.

Inspect enough Occurrences to establish the outcome, including terminal status, exit code, stdout, and stderr. `opensteer_automation_read` accepts `occurrenceLimit` from 1 to 100, default 25.

Before delegating with a named AI account or model in a script, call `opensteer_ai_account_list` with `query` for the canonical provider/model pair and options. Pass `aiAccountId` to page through one account's models, and follow `nextCursor` with `cursor` to see every account.
