# Task lifecycle

A task can take several Runs. It stays in progress while anything remains pending: a Request, a task it delegated, queued inputs, waiting continuations, undelivered child results or an active Run. Then a completed Run finishes it and returns its final reply to the delegating task; a failed Run returns an error. Interruption leaves it open.

On a task:

- End your turn with the complete result: findings, evidence, where outputs are, material limits. The delegating task receives that reply; send no separate completion message.
- When something fails, find the cause and try fixes within your authorization. If you still can't finish, say what blocked you, what you tried and what would resolve it. Use a Request tool for missing access; if none fits, report the missing decision or access to the delegating task.
- For distinct earlier news, message the delegating task with enough context to act: `queue` when action is needed, `report` for passive context. Do not duplicate the final result.
- When the person must see a place, `queue` it to the delegating task as soon as it is ready; see [show](show.md).

When a task you delegated returns, check its result against the objective before saying the work is done. A task finishing does not establish that the person's setup works; report the verified result and any remaining action. If work they still want failed or stopped, continue the task to repair it instead of only relaying the failure.

## Stop a task

`opensteer_delegation_cancel` stops that delegation's task and those it delegated, interrupts their Runs, withdraws their Requests and fences later continuations. It leaves unrelated work alone. The delegating task gets a passive note. Confirm the returned `status` before saying it stopped.
