---
name: opensteer-workspaces
description: For a specialist or durable Workspace (not an ordinary folder), create/find/mount it and establish its AGENTS.md mission, scope and standing constraints.
---

# Opensteer Workspaces

People call a specialized Workspace a specialist. Establish a specialized Workspace's identity
before delegating any work into it.

Reuse a suitable Workspace for an ongoing specialist or distinct durable project. Handle simple
one-off tasks and reminders in their existing context; they do not each need a new Workspace.
Choose reasonable implementation details from the user's request and available context. Ask only
when a missing answer changes the intended outcome or authority needed for it.

1. Call `workspace_list` first only when an existing target is unclear.
2. Use `environment_list` to choose a machine and its supported Workspace backings. For a new specialized Workspace, call `workspace_create` once with its user-facing name and the `icon` that best fits its purpose. Choose where its files live: omit `backing` to take the Deployment's default, pass `backing: "portablefs"` for storage every machine can mount, or `backing: "local-directory"` for one machine's own disk—naming that machine with `environmentId`, or omitting it for the machine this Run is on.
3. Read the returned Workspace ID and storage status. Do not substitute a directory for this result. If provisioning is still in progress, report that state and stop; do not invent a mount path or claim file setup is complete.
4. When storage is ready, call `workspace_mount` with that Workspace ID to get the filesystem path for the active Run. Use the path it returns; do not derive one from the backing you chose.
5. Write `AGENTS.md` at the root of the mounted path with ordinary file tools. It is the specialized agent's durable identity: its mission, its scope, the user's standing constraints, and what a successful result looks like. Preserve the user's authorization; do not invent repeated approval requirements or copy platform workflows into it.
6. Follow `opensteer-specialization` to prepare useful procedures, knowledge, and task state. Create skills or scripts when they make the intended work repeatable; do not manufacture them for a trivial task. Read back `AGENTS.md` and verify that referenced files exist before delegating.
7. Call `thread_delegate` with the concrete first task and expected result. Include any unfinished setup it should complete. The child uses the saved identity rather than depending on a copy in the delegation message.
8. Verify the returned work before calling the specialist ready. If recurring work was requested, use `opensteer-triggers` to establish and verify the schedule or watch as well. A created Workspace or queued child is only an intermediate result.
9. Report the useful outcome, how to find the specialist, and any remaining blocker. Include IDs or filesystem paths when they help the user access the result; do not turn routine setup mechanics into the whole reply.

To change an existing specialized agent, mount its Workspace and edit `AGENTS.md` in place instead of creating another Workspace.

Read or write Workspace files only through the exact path returned by `workspace_mount`. Do not claim that integrations, schedules, Threads, skills, or files exist without the corresponding successful tool or filesystem result.

Distinguish creating the Workspace from completing its setup. If account access or configuration is
still missing, state the remaining step instead of calling the agent ready.
