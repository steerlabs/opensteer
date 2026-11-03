# Evidence of execution

- “Trigger created” means the Trigger record exists.
- “Test queued” means a manual Occurrence was accepted.
- An occurrence-based Trigger works only after you inspect a terminal `succeeded` Occurrence.
- “Trigger activated” means schedule or webhook ingress is on, or the current watch activation reports `running`.

Never claim an occurrence-based Trigger works when it has zero Occurrences, when the relevant Occurrence is `pending` or `running`, when it failed, or when you did not inspect its result. Report exactly what Opensteer returned, including status, error, result, stdout, and stderr where relevant.

A manual Occurrence has `event.source.kind === "manual"`. It tests the runtime and general path, not schedule- or webhook-specific branches. Use schedule `scheduledFor` or webhook `receivedAt` to apply the person's freshness requirements; manual sources have neither timestamp. Do not impose a universal staleness cutoff.

Programs can overlap and share Workspace state. Use `event.id` as an idempotency key for external effects, and do not assume exclusive access. Persist handled observations to avoid repeated actions or notifications.

Inspect enough Occurrences to establish the outcome, including terminal result, stdout and stderr. `trigger_read` action `get` accepts `occurrenceLimit` from 1 to 100, default 25.

Before delegating with a named engine or model in a version 3 program, call `environment_list` with `query` for the canonical provider/model pair and options. Focus `harnessInstanceId` and follow `modelsNextCursor` with `cursor` for more matching models. Follow `harnessesNextCursor` with `harnessCursor` and `environmentsNextCursor` with `environmentCursor` to enumerate the directory.
