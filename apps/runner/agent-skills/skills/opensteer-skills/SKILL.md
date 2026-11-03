---
name: opensteer-skills
description: Maintain standing instructions, skills and scripts in the current Workspace or Project when preferences change or repeated work needs a reusable procedure.
---

# Durable instructions and skills

Read existing instructions and relevant files first. Update the smallest useful source rather
than creating a standard set of empty files. Use ordinary file tools in the current Workspace;
Main can also use a Project path returned by `project_create`. Project agents work only in their
own folder.

- Keep mission, scope and confirmed standing rules in `AGENTS.md`. Link detailed procedures
  rather than duplicating them. Preserve the person's authorization; tool failures do not
  justify permanent approval requirements.
- Put repeatable procedures requiring judgment in `skills/<name>/SKILL.md`. Describe the
  intended outcome, decision criteria and useful recovery paths. Put references beside it.
- Turn repeated parsing, calculations or API work into scripts. Reuse working code; document
  dependencies, inputs and side effects. Agents can write and run ordinary code.
- Keep changing task state apart from standing instructions. Record verified observations and
  sources; distinguish hypotheses and agent choices from the person's requirements.

A skill's lowercase hyphenated name must match its directory. The `opensteer-` prefix is
reserved for bundled skills. Start with YAML frontmatter:

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

Do not save credentials or capability tokens. If the person explicitly asks you to remember
a phone's screen-lock PIN, keep it in one private file for that phone outside AGENTS.md and
version control; read it only to unlock that phone.

Files grant no access and keep no process alive. Use ordinary access Requests for resources;
use `opensteer-triggers` for requested recurring work and verify the returned state. Remove
obsolete instructions when the person's requirements change.

## Package a repeated procedure as a plugin

When repeated work needs skills, scripts or MCP servers together, package it as an Agent Plugins
1.0 folder inside this Workspace: `plugin.json`, `skills/<name>/SKILL.md`, scripts, and an optional
`mcp.json`. Test the scripts on disposable inputs and run the skill's steps before calling
`plugin_install` with the folder's path relative to this Workspace. Symlinks are refused. Its skills
turn on here; connections still need grants, and local MCP servers need the computer owner's launch
approval.
