# Set up a specialist Workspace

Use `workspace_list` when the existing target is unclear. Choose reasonable details from the
person's request and available context; ask when a missing answer changes the outcome or
required authority. Update an existing specialist by mounting its Workspace and editing its
instructions in place.

For a new Workspace, use `environment_list` to choose a machine and supported storage backing.
Call `workspace_create` with a user-facing name and an `icon` fitting its purpose. Omit `backing`
for the Deployment default, use `portablefs` for storage every machine can mount, or use
`local-directory` for one machine's disk. With local storage, `environmentId` names the machine;
omit it for the machine this Run is on.

Read the returned Workspace ID and storage status. Provisioning may still be in progress;
report that state and continue independent work without claiming file setup is complete.
Once storage is ready, `workspace_mount` with that confirmed ID returns the active Run's path.
Read or write setup files only through that exact path, never one derived from the backing.

## Durable identity and useful work

Root `AGENTS.md` defines the specialist's mission, scope, the person's standing constraints and
what success looks like. Preserve authorization; do not invent repeated approval requirements
or copy platform workflows into it. Follow `opensteer-specialization` for useful procedures,
knowledge and task state. Create skills or scripts only when they make the intended work
repeatable. Read back the identity and check referenced files before delegating.

Give the first task its concrete objective and expected result, including unfinished setup it
should complete. The child uses the saved identity rather than a copy in the task message.
Verify returned work before calling the specialist ready. When recurring work was requested,
use `opensteer-triggers` to establish and verify the schedule or watch too.

Report the useful outcome, how to find the specialist and any missing account access or
configuration. Include IDs or paths when they help the person access the result. Claim that
integrations, schedules, Threads, skills or files exist only after a successful corresponding
tool or filesystem result. Creation and completed setup are different outcomes.
