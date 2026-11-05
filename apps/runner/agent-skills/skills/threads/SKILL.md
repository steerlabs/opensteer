---
name: threads
description: Find, delegate, continue, configure, queue, interrupt or cancel Opensteer work.
---

# Threads and tasks

A Thread holds durable history; a Run is one execution. Use native workers for Run-local work,
`thread_delegate` for independent work or durable continuation. Give the outcome, context,
constraints and completion criteria. Use `workspaceId` for a new task (or a ready `specialist`),
`threadId` to continue a finished one. Reuse keeps its engine/model.

Runs and programs get an Assignment and its final result automatically. In a Run, do independent
work or end your turn for continuation; `thread_wait` is absent. Connections get no Assignment
or automatic return: keep `thread.id`, observe with `thread_wait` and `thread_read`. Programs
may also use `thread_wait`. A wait timing out or disconnecting never stops the work.

A pending durable Request permits independent work; end your turn when none remains. Never poll, repeat or route around it.

- `thread_message`: report saves passive context; queue asks for a next turn; steer changes a
  compatible active Run. Accepted is not read; cancelled will not execute.
- `thread_read`: inspect execution selectors and queued inputs with their allowed actions.
- `thread_configure`: set an existing Thread's engine/model/options. Discover exact choices
  with `environment_list` when available. Access mode stays; never substitute after refusal.
- `thread_queue`: cancel/move waiting inputs by messageId, steer with
  expectedRunId, or resume. Preserve a person's pause unless told to resume.
- `thread_write` interrupt: stop the current Run and pause a work queue, keeping pending inputs.
- `assignment_cancel`: Run-only permanent cancellation of an Assignment and its descendants,
  including Requests and continuations. Confirm the returned status.

Delegation inherits its root's reach; resource grants and access ceilings still apply. On an
Assignment, `person_message`/`person_show` are refused even when listed. Send distinct earlier
news to the assigner (queue if they should act/tell the person); your final reply returns
automatically.

Read [coordination](references/coordination.md) for selection, discovery and forwarded places;
[lifecycle](references/lifecycle.md) for results and blockers; [show](references/show.md) to show
places; [Chat/history](references/chat.md) for earlier context;
[apps](references/apps.md) to publish or call an app.
