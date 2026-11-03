---
name: opensteer-workspaces
description: Create or update a specialist Workspace with durable instructions and files, or mount a Workspace for setup.
---

# Opensteer Workspaces

A specialist is a durable Workspace with instructions and files. Reuse a suitable Workspace
for an ongoing specialist or distinct project; simple one-off tasks and reminders belong in
their existing context. A Workspace is a Host resource, not an ordinary directory.

Establish its mission, standing constraints and useful working setup before delegating into it.
File setup requires a confirmed Workspace ID, ready storage and the exact path returned by
`workspace_mount`. Never invent a path or treat creation as proof of readiness. While storage
provisions, report its actual state and continue independent work.

Preserve the person's authorization and shared files. Verify the useful result and required
access before calling a specialist ready; a created Workspace or queued task is intermediate
state. Read [setup](references/setup.md) when choosing placement, mounting files, defining the
identity, or verifying initial and recurring work.
