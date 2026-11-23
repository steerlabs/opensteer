---
name: automations
description: Create, inspect or repair durable schedules, webhooks and continuous watches, including reminders and recurring checks.
---

# Opensteer automations

An automation is an ordinary script that runs later, at an address, or continuously. Write a normal file in Agent home (JavaScript, TypeScript, Python, shell, or anything installed on the computer), run it in your shell to test it like any file, then register its text and when it runs with `opensteer_automation_create` (default interpreter: Node; pass `interpreter`, such as `["python3"]` or `["bash"]`, for anything else). To change it, edit the file, test it, and register the updated text with `opensteer_automation_update`.

When you have just done something for the person whose outcome arrives later and they would want to hear it, such as a message to a seller or an application sent, offer once with `ask_person` to watch for it, naming what you would check and how often. Build the watch only on their yes.

Check `opensteer_automation_list` before creating overlapping work. Choose where it runs: keep reminders in the asking task; use `opensteer_automation_create` with `ownTask: true` for an ongoing monitor; have a script call `opensteer_task_create` for a new listed task per run. Preserve the person's criteria, timing and pauses.

Check in code first and wake a model when judgment or action needs one. Keep state under `automations/<automation-id>/` in Agent home. Send real finds to the asking task with `opensteer_task_send` delivery `queue` (a `report` never notifies), or email through a connected integration. Start child checks from the monitor's task so their automatic results return there. For repeated checks use `freshContext: true` with queue and include criteria, destination and state path in each wake. On a background wake, briefly say what happened, including when nothing changed. Confirm future execution before promising continuation, and verify actual effects before saying the automation works.

Automations are personal. Creation, script changes, timing changes, manual runs and archiving require full access; pausing ends what runs. Delegated work cannot raise that ceiling. Tell the person when creating or changing an automation. Opensteer owns the independent background memory jobs: pause or resume them, never archive or reprogram them.

Scripts run on the computer with Agent home as their working directory and their task's authority. They call Opensteer through the `opensteer` CLI on `PATH` (or MCP at `OPENSTEER_MCP_URL` with `OPENSTEER_MCP_TOKEN`) and have the same tool set as a Run—including `computer_use`, `browser_*`, `app_*`, `plugin_*`, `opensteer_task_send`, and `opensteer_task_delegate`—except tools that directly ask or approve on the person's behalf. A script or Run may wait on a `delegationId` with `opensteer_delegation_wait` (bounded at 100 seconds) or on a `taskId` with `opensteer_task_wait`. Scripts cannot approve, grant access, handle sign-in credentials or raise their ceiling.

Manual runs have real side effects and work only for non-archived schedules and webhooks. Failures and watch crash loops tell the task without auto-pausing; pause an automation yourself when nothing should run. Avoid duplicate effects while outcomes are unknown. Respect site limits and never bypass a block by changing identity or session.

- Read [running scripts](references/scripts.md) for the `opensteer` CLI, event file, secrets, exit codes and output bounds.
- Read [controls](references/controls.md) when creating, updating, running, canceling or repairing an automation.
- Read [reminders](references/reminders.md) for reminders and person-facing updates through their task.
- Read [watches](references/watches.md) for continuous scripts and their activation/effect proof.
- Read [recovery](references/recovery.md) when arranging retries or handing off unresolved work.
- Read [verification](references/verification.md) when evaluating execution evidence, freshness or model selection.
