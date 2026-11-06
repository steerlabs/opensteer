---
name: threads
description: Find, read, delegate, continue, configure, queue, interrupt or cancel Opensteer work.
---

# Threads and tasks

A Thread holds durable history; a Run is one execution; a task is work one Thread assigned to another. Use native workers for Run-local work, `thread_delegate` for independent work or durable continuation.

- New work: `thread_delegate` with `workspaceId` or a ready `specialist`. Finished task: `thread_delegate` with `threadId`. Active task: `thread_message`.
- Your tasks: `thread_list({parentThreadId: "self"})`. What one did and where: `thread_read`, with `view: "activity"` for its tools. One task's state: `task_status`.
- Pause work: `thread_interrupt`, resumable with `thread_queue`. Stop it for good: `task_cancel`.
- Engine or model: `thread_configure`. Waiting inputs: `thread_queue`. Rename, done or reopen: `thread_update`.

Runs and programs get a task's final result automatically: do other work or end your turn, and do not poll. Connections get no Assignment: keep `threadId` and observe with `thread_wait` and `thread_read`. Programs may also `thread_wait`; a timeout or disconnect stops nothing.

Delegation inherits its root's reach; resource grants and access ceilings still apply. On an Assignment, `person_message` and `person_show` are refused even when listed: send what the person should hear or see to your assigner.

Read [coordination](references/coordination.md) to pick a target, message, delegate or forward places; [lifecycle](references/lifecycle.md) for results, blockers and cancelling; [show](references/show.md) to show places; [Chat/history](references/chat.md) for earlier context; [apps](references/apps.md) to publish or call an app.
