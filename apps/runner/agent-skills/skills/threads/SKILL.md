---
name: threads
description: Find, read, delegate, continue, configure, queue, interrupt or cancel Opensteer work.
---

# Threads and tasks

A Thread holds durable history; a Run is one execution; a task is private durable work, optionally assigned by another task. Use native workers for Run-local work, `delegate_task` for independent work or durable continuation.

- Automations: keep reminders here; use `trigger_write` with `ownTask: true` for ongoing monitors, or program `delegate_task` with `standalone: true` for a new listed task per run. Check in code first. State belongs under `automations/<trigger-id>/` in Agent home. Start child checks from the monitor task and queue repeated checks with `freshContext: true`, including criteria, destination and state path each time. Briefly say what happened on each background wake; send real finds to the asking task with `thread_send` queue or email through a connected integration. A `report` never notifies.
- New work: `delegate_task`, optionally with a ready `specialist`. Finished task: `delegate_task` with `threadId`. Active task: `thread_send`.
- Your tasks: `thread_list({parentThreadId: "self"})`. What one did and where: `thread_read`, with `view: "activity"` for its tools. One task's state: `task_status`.
- Pause work: `thread_interrupt`, resumable with `thread_queue`. Stop it for good: `task_cancel`.
- Engine or model: `thread_configure`. Waiting inputs: `thread_queue`. Rename, done or reopen: `thread_update`.

Runs and programs get a task's final result automatically unless the assigner read it through `task_status` or a settled wait first. `thread_wait` accepts an `assignmentId` or conversation `threadId` for a bounded wait of up to 100 seconds. `delegate_task` mode `wait` uses the same waiter. An empty result still settles the task. Connections get no Assignment: wait on `threadId`. Timeout or disconnect stops nothing. `orchestrator_capabilities` reports execution choices, the access ceiling and enforced budgets.

Delegation preserves the access ceiling. On an Assignment, `person_message` and `person_show` are refused even when listed: send what the person should hear or see to your assigner.

Read [coordination](references/coordination.md) to pick a target, message, delegate or forward places; [lifecycle](references/lifecycle.md) for results, blockers and cancelling; [show](references/show.md) to show places; use thread_read query/before/itemId to search and page earlier context; [apps](references/apps.md) to publish or call an app.
