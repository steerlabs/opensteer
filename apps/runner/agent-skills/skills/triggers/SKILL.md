---
name: triggers
description: Create, inspect or repair durable schedules, webhooks and continuous watches, including reminders and recurring checks.
---

# Opensteer Triggers

Use a Trigger when work must happen later or continue durably. Its Node program runs with the anchor Thread's authority and Workspace; creation does not run a model. Queue or delegate Thread work when judgment or action needs an agent.

Inspect existing Triggers before creating overlapping work. Reuse the owning Thread and Workspace, preserve the person's criteria, timing and pauses, and suppress unchanged or non-actionable updates unless requested. Confirm future execution before promising continuation, and verify actual effects before saying the automation works.

Visibility follows Thread reach. Control actions require an anchor access mode no higher than yours. Creating, updating, manually running or archiving requires full-access within live reach and Workspace authority. Delegated work inherits its root’s reach. Tell the person when creating a Trigger or changing what it runs.

Programs use the same MCP as Runs with the program tool list. They may observe tasks with
`thread_wait`; Runs instead end their turn for continuation. `computer`, `sign_in` and person
message/show tools are Run-only. Delegate when agent judgment or a Run-only tool is needed.
Programs cannot approve, grant access, handle credentials or raise their ceiling.

Manual runs have real side effects and work only for non-archived schedules and webhooks. Avoid duplicate effects while outcomes are unknown. Respect site limits and never bypass a block by changing identity or session.

- Read the [program contract](references/program-contract.md) before authoring code.
- Read [controls](references/controls.md) when creating, updating, running, canceling or repairing a Trigger.
- Read [reminders](references/reminders.md) for reminders and person-facing updates through Chat.
- Read [watches](references/watches.md) for continuous programs and their activation/effect proof.
- Read [recovery](references/recovery.md) when arranging retries or handing off unresolved work.
- Read [verification](references/verification.md) when evaluating execution evidence, freshness or model selection.
