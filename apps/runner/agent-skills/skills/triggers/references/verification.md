# Evidence of execution

- “Trigger created” means the Trigger record exists.
- “Test queued” means a manual Occurrence was accepted.
- An occurrence-based Trigger works only after you inspect a terminal `succeeded` Occurrence.
- “Trigger activated” means schedule or webhook ingress is on, or the current watch activation reports `running`.

Never claim an occurrence-based Trigger works when it has zero Occurrences, when the relevant Occurrence is `pending` or `running`, when it failed, or when you did not inspect its result. Report exactly what Opensteer returned, including status, error, result, stdout, and stderr where relevant.

A manual Occurrence has `event.source.kind === "manual"`. It tests the runtime and general path, not schedule- or webhook-specific branches. Use `event.source.scheduledFor` for schedule freshness and `event.receivedAt` for webhook freshness. A manual event also has `receivedAt`, but no scheduled time or webhook arrival. Apply the person's freshness requirements, not a universal staleness cutoff.

Programs can overlap and share Agent home state. Use `event.id` as an idempotency key for external effects, and do not assume exclusive access. Persist handled observations to avoid repeated actions or notifications.

Inspect enough Occurrences to establish the outcome, including terminal result, stdout and stderr. `trigger_read` action `get` accepts `occurrenceLimit` from 1 to 100, default 25.

Before delegating with a named engine or model in a version 3 program, call `orchestrator_capabilities` with `query` for the canonical provider/model pair and options. Focus `harnessInstanceId` and follow `modelsNextCursor` with `cursor` for more matching models. Follow `harnessesNextCursor` with `harnessCursor` to enumerate the directory.
