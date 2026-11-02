---
name: opensteer-projects
description: Create or reuse a Project when the person wants a durable area of work kept separate, such as work versus personal or a client.
---

# Projects

A Project has its own chat, tasks, members and standing instructions in a folder inside
Main/Projects/<slug>. Create one for durable separation the person wants. For a one-off task,
delegate in the current Workspace instead. Reuse a suitable existing Project.

1. Use `project_list` if the target is unclear. Create with `project_create`, giving a useful
   name and icon. Projects use Main's storage; there is no storage or computer choice.
2. Use the returned absolute `path`, `id` and immutable `slug`; never guess a folder or call a
   mount tool. Main agents use ordinary file tools on this path. Project agents work in their
   folder and only their folder.
3. Write `AGENTS.md` at the returned path: mission, scope, the person's standing rules and
   success criteria. Read existing instructions first; preserve authorization. Add useful
   skills or scripts following `opensteer-skills` when repeated work warrants them.
4. Read back the instructions and check linked files. Delegate the first concrete task with
   `thread_delegate` using the Project id as `workspaceId`, with context and completion criteria.
5. Verify the task's returned work before calling setup complete. For requested recurring work,
   establish and verify its Trigger with `opensteer-triggers`. Report the useful result and
   remaining blockers; a created Project or queued task alone is not completion.

Project names may change; their slugs and folders do not. Files grant no resource access:
use the ordinary access Requests for missing connections or browser profiles.
