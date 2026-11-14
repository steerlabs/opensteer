---
name: tasks
description: Find, read, create, delegate, continue, configure, queue, interrupt or stop Opensteer tasks.
---

# Tasks and delegation

A task is private durable work with its own history; a Run is one turn. A delegation is work one task or program gives another, whose result returns. Use native workers for Run-local work, `opensteer_task_delegate` for independent work or durable continuation.

- Automations: keep reminders here; use `opensteer_automation_create` with `ownTask: true` for ongoing monitors, or a program calling `opensteer_task_create` for a new listed task per run. Check in code first. State belongs under `automations/<automation-id>/` in Agent home. Start child checks from the monitor task and queue repeated checks with `freshContext: true`, including criteria, destination and state path each time. Briefly say what happened on each background wake; send real finds to the asking task with `opensteer_task_send` queue or email through a connected integration. A `report` never notifies.
- New work: `opensteer_task_delegate`, optionally with a ready `specialist`. Finished task: `opensteer_task_delegate` with `taskId`. Active task: `opensteer_task_send`. A top-level task nothing returns from: `opensteer_task_create`.
- Your delegated tasks: `opensteer_task_list` with `parentTaskId`. What one did and where: `opensteer_task_read`, with `view: "activity"` for its tools. One delegation's state: `opensteer_delegation_status`.
- Pause work: `opensteer_task_interrupt`, resumable with `opensteer_task_resume`. Stop a delegation for good: `opensteer_delegation_cancel`.
- AI account or model: `opensteer_task_configure`. Waiting inputs: `opensteer_task_queue`. Rename, done or reopen: `opensteer_task_update`.

Runs and programs get a delegation's final result automatically unless they read it first through `opensteer_delegation_status` or a settled wait. `opensteer_delegation_wait` takes a `delegationId` and `opensteer_task_wait` a `taskId`; each waits at most 100 seconds. `opensteer_task_delegate` mode `wait` uses the same waiter. An empty result still settles the delegation. Connections get no delegation: wait on `taskId`. Timeout or disconnect stops nothing. `opensteer_ai_account_list` reports AI accounts, models, the access ceiling and enforced budgets.

Delegation preserves the access ceiling. On a delegation, `person_notify` and `person_show` are refused even when listed: send what the person should hear or see to the delegating task.

Read [coordination](references/coordination.md) to pick a target, message, delegate or forward places; [lifecycle](references/lifecycle.md) for results, blockers and cancelling; [show](references/show.md) to show places; use `opensteer_task_read` `query`, `cursor` and `itemId` to search and page earlier context; [apps](references/apps.md) to publish or call an app.
