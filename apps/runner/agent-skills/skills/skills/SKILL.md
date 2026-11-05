---
name: skills
description: Maintain standing instructions, skills and scripts in the current Workspace or Project when preferences change or repeated work needs a reusable procedure.
---

# Durable instructions and skills

Read existing instructions and relevant files first. Update the smallest useful source rather
than creating a standard set of empty files. Facts about the person belong in Main's memory
(`opensteer:memory`); this skill covers how work is done. Use ordinary file tools in the current Workspace;
Main can also use a Project path returned by `project_create`. Project agents work only in their
own folder.

- Keep mission, scope and confirmed standing rules in `AGENTS.md`. Link detailed procedures
  rather than duplicating them. Preserve the person's authorization; tool failures do not
  justify permanent approval requirements.
- Put repeatable procedures requiring judgment in `skills/<name>/SKILL.md`. Describe the
  intended outcome, decision criteria and useful recovery paths. Put references beside it.
- Turn repeated parsing, calculations or API work into scripts. Reuse working code; document
  dependencies, inputs and side effects. Agents can write and run ordinary code.
- Keep changing task state apart from standing instructions. Record verified observations about
  the work and their sources; distinguish hypotheses and agent choices from the person's
  requirements.

A skill's lowercase hyphenated local name must match its directory and frontmatter. Loose
Workspace skills use that bare name and cannot contain `:`. Plugin skills are invoked as
`plugin:skill`, including bundled skills such as `opensteer:browser`. Two plugins can export
the same local name; duplicate full names are refused, with no shadowing. Start with YAML frontmatter:

```markdown
---
name: compare-offers
description: Compare offers against saved requirements, including total cost and availability.
---

Read the saved requirements. Compare current evidence on the same basis, record sources and
observation times, and report matches and missing information.
```

The Runner discovers skills at Run start; read a newly written skill directly to use it now.
Read back edited instructions, check linked paths and exercise scripts with representative
inputs. Use fixtures when a test would repeat an external action. Label untested approaches.
Reread shared files before editing so other Threads' work survives.

Do not save credentials or capability tokens. A phone's screen-lock PIN is the sole exception when
the person explicitly asks you to remember it; follow [durable context](references/durable-context.md).
App and website passwords stay in the secure sign-in UI.

Files grant no access and keep no process alive. Use ordinary access Requests for resources;
use `opensteer:triggers` for requested recurring work and verify the returned state. Remove
obsolete instructions when the person's requirements change.

## Package a repeated procedure as a plugin

When repeated work needs skills, scripts or MCP servers together, package it as an Agent Plugins
1.0 folder inside this Workspace: `plugin.json`, `skills/<name>/SKILL.md`, scripts, and an optional
`mcp.json`. Test the scripts on disposable inputs and run the skill's steps before calling
`plugin_install` with the folder's path relative to this Workspace. Symlinks are refused. Its skills
turn on here; connections still need grants, and local MCP servers need the computer owner's launch
approval.

Name plugins specifically (`tapo-camera`, not `camera`). To change one, edit its folder and call
`plugin_install` on it again, never on a renamed copy.

A program server that needs a password, key or token declares it in `plugin.json`, never in
`mcp.json`, files or chat: `"extensions": {"com.opensteer": {"secrets": {"<server>": [{"name":
"CAMERA_PASSWORD", "title": "Camera password", "description": "Where to find it"}]}}}`. The computer's
owner enters each value when approving the server, and the program reads it from that environment
variable. The owner changes values in Settings, Plugins.

## Turn repeated work into a specialist

For repeated, well-understood work, add `specialist.json` and `INSTRUCTIONS.md` to the plugin.
List models in preference order: an exact `{"engine", "model", "options"?}`, or
`{"role": "light"}` (fast, cheap) or `{"role": "deep"}` (strongest), which stand for the person's
own automatic model choices in AI settings. Prefer a role unless the work needs a particular
model. A list never names an account; it runs on the person's eligible accounts. Declare the
access needs and reasons, and use `fallback: "caller"` only when that cost is intended (the
default is `"none"`). Test representative inputs and check the outputs before `plugin_install`.
Ask the person to resolve missing resource grants or specialist bindings; never grant them yourself. Then call `thread_delegate` with
`specialist` set to its registration id or plugin name. Continue it with `threadId` to retain
context. Instructions should name per-task outputs in `PLUGIN_DATA`, shared by this registration.

`plugin_manage` lists, activates/deactivates or removes plugins, updates person-installed ones and
removes specialist registrations within full-access and reach. Activation grants no resource access.

- Read [durable context](references/durable-context.md) when choosing where a correction, fact or task state belongs.
- Read [skills](references/skills.md) when authoring procedures.
- Read [verification](references/verification.md) when checking helpers and edited files.
