# Controls

Opensteer creates both passes and owns their schedules: each is a hidden task Thread woken by a
Trigger. Find them with `trigger_read` action `list` and `systemRole` `memory-light` or
`memory-nightly`; each Trigger's `anchorThreadId` is its worker. Never create, archive or
reprogram them; Opensteer refuses.

## Pause and resume

Use `trigger_write` action `set_status` with each `triggerId` and status `paused`, or `active` to
resume. To keep memory but turn the passes off, pause both; they stay paused until the person asks.
A pass already running finishes its turn.

## Stop remembering

1. Replace the whole `## Memory` section with
   `Memory: off at the person's request; deleting memory once both passes stop.`
2. Pause both Triggers, then call `thread_write` action `done` with each worker's `threadId`. Done
   cancels queued wakes and asks a running pass to stop.
3. Call `thread_read` on each worker. Once neither status is `running` or `waiting`, delete
   `memory/` and `skills/light-pass/`, then shorten the line to
   `Memory: off at the person's request.`

If a worker is still stopping, tell the person deletion finishes shortly and finish it on your next
Run instead of waiting. Never say memory is erased before it is.

## Turn back on

Finish any pending deletion first. Start a fresh `## Memory` section, reopen each worker marked
Done with `thread_write` action `reopen`, then resume both Triggers.
