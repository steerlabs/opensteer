---
name: triggers
description: Create, inspect or repair durable schedules, webhooks and continuous watches, including reminders and recurring checks.
---

# Opensteer Triggers

Use a Trigger when work must happen later or continue durably. Its Node program runs in Agent home with the anchor task's access ceiling; creation does not run a model. Queue or delegate Thread work when judgment or action needs an agent.

Inspect existing Triggers before creating overlapping work. Reuse the owning task, preserve the person's criteria, timing and pauses, and suppress unchanged or non-actionable updates unless requested. Confirm future execution before promising continuation, and verify actual effects before saying the automation works.

Triggers are personal. Timing controls require an anchor access mode no higher than yours; creation, code changes, manual runs and archiving require full access. Delegated work cannot raise that ceiling. Tell the person when creating or changing a Trigger. Opensteer owns the independent background memory jobs: pause or resume them, never archive or reprogram them.

Programs use the same MCP as Runs with the program tool list. `delegate_task` returns the task;
a program or a Run may wait on its `assignmentId` with `thread_wait`, bounded at 100 seconds, or
observe its `threadId`, whose `items` match `thread_read`. `computer`, `sign_in` and person
message/show tools are Run-only. Delegate when agent judgment or a Run-only tool is needed.
Programs cannot approve, grant access, handle sign-in credentials or raise their ceiling.

Manual runs have real side effects and work only for non-archived schedules and webhooks. Avoid duplicate effects while outcomes are unknown. Respect site limits and never bypass a block by changing identity or session.

- Read the [program contract](references/program-contract.md) before authoring code.
- Read [controls](references/controls.md) when creating, updating, running, canceling or repairing a Trigger.
- Read [reminders](references/reminders.md) for reminders and person-facing updates through their task.
- Read [watches](references/watches.md) for continuous programs and their activation/effect proof.
- Read [recovery](references/recovery.md) when arranging retries or handing off unresolved work.
- Read [verification](references/verification.md) when evaluating execution evidence, freshness or model selection.
