---
name: automations
description: Create, inspect or repair durable schedules, webhooks and continuous watches, including reminders and recurring checks.
---

# Opensteer automations

Use an automation when work must happen later or continue durably. Its Node program runs in Agent home with its task's access ceiling; creation does not run a model. Queue or delegate task work when judgment or action needs an agent.

Check `opensteer_automation_list` before creating overlapping work. Choose where it runs: keep reminders in the asking task; use `opensteer_automation_create` with `ownTask: true` for an ongoing monitor; have a program call `opensteer_task_create` for a new listed task per run. Preserve the person's criteria, timing and pauses.

Check in code first and wake a model when judgment or action needs one. Keep state under `automations/<automation-id>/` in Agent home. Send real finds to the asking task with `opensteer_task_send` delivery `queue` (a `report` never notifies), or email through a connected integration. Start child checks from the monitor's task so their automatic results return there. For repeated checks use `freshContext: true` with queue and include criteria, destination and state path in each wake. On a background wake, briefly say what happened, including when nothing changed. Confirm future execution before promising continuation, and verify actual effects before saying the automation works.

Automations are personal. Timing controls require a task access mode no higher than yours; creation, code changes, manual runs and archiving require full access. Delegated work cannot raise that ceiling. Tell the person when creating or changing an automation. Opensteer owns the independent background memory jobs: pause or resume them, never archive or reprogram them.

Programs use the same MCP as Runs with the program tool list. `opensteer_task_delegate` returns the task;
a program or a Run may wait on its `delegationId` with `opensteer_delegation_wait`, bounded at 100 seconds, or
wait on its `taskId` with `opensteer_task_wait`, whose `items` match `opensteer_task_read`. `computer_use`, the
`*_request` tools and the `person_*` tools are Run-only. Delegate when agent judgment or a Run-only tool is needed.
Programs cannot approve, grant access, handle sign-in credentials or raise their ceiling.

Manual runs have real side effects and work only for non-archived schedules and webhooks. Avoid duplicate effects while outcomes are unknown. Respect site limits and never bypass a block by changing identity or session.

- Read the [program contract](references/program-contract.md) before authoring code.
- Read [controls](references/controls.md) when creating, updating, running, canceling or repairing an automation.
- Read [reminders](references/reminders.md) for reminders and person-facing updates through their task.
- Read [watches](references/watches.md) for continuous programs and their activation/effect proof.
- Read [recovery](references/recovery.md) when arranging retries or handing off unresolved work.
- Read [verification](references/verification.md) when evaluating execution evidence, freshness or model selection.
