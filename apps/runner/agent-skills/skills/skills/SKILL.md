---
name: skills
description: Maintain standing instructions, skills and scripts in Agent home when preferences change or repeated work needs a reusable procedure.
---

# Durable instructions and skills

Read existing instructions and relevant files first. Update the smallest useful source rather
than creating a standard set of empty files. Work in Agent home with ordinary file tools. Facts about
the person belong in its memory (`opensteer:memory`); this skill covers how work is done.

- Keep confirmed standing rules in `AGENTS.md` where `opensteer:memory` says. Link detailed
  procedures rather than duplicating them. Preserve the person's authorization; tool failures do not
  justify permanent approval requirements.
- Put repeatable procedures requiring judgment in `skills/<name>/SKILL.md`. Describe the
  intended outcome, decision criteria and useful recovery paths. Put references beside it.
- Turn repeated parsing, calculations or API work into scripts. Reuse working code; document
  dependencies, inputs and side effects. Agents can write and run ordinary code.
- Keep changing task state apart from standing instructions. Record verified observations about
  the work and their sources; distinguish hypotheses and agent choices from the person's
  requirements.

A skill's lowercase hyphenated local name must match its directory and frontmatter. Loose
skills in `skills/` use that bare name and cannot contain `:`. Plugin skills are invoked as
`plugin:skill`, including bundled skills such as `opensteer:browser`. Two plugins can export
the same local name; canonical sources load once. Start with YAML frontmatter:

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
Reread shared files before editing so other tasks' work survives.

Do not save credentials or capability tokens. A phone's screen-lock PIN is the sole exception when
the person explicitly asks you to remember it; follow [durable context](references/durable-context.md).
App and website passwords stay in the secure sign-in UI.

Files grant no access and keep no process alive. Use ordinary access Requests for resources;
use `opensteer:automations` for requested recurring work and verify the returned state. Remove
obsolete instructions when the person's requirements change.

## Package service tools as a plugin

A sandboxed service plugin is TypeScript source with an exact apps dependency, a defineApp export,
and optional skills under skills/<name>/SKILL.md. Read opensteer:plugins before writing or changing
one. Deploy a folder in Agent home with opensteer_plugin_install using source:"folder"; include
pluginId for a new version. The folder is a draft, and the deployed version is the truth.

Loose procedures and scripts can remain ordinary Agent home skills. A local MCP server, such as
one for a device, is registered with `local_server_add` and approved by the person on its
computer (opensteer:devices); the sandboxed plugin installer does not run local servers.

## Hand repeated work to a delegated task

For repeated, well-understood work, write a skill and test it on representative inputs. Then
call `opensteer_task_delegate` with a message naming the skill. When the work needs a particular
model, such as a fast one for simple steps, choose `model` and `aiAccountId` from
`opensteer_ai_account_list`. Continue the task with `taskId` to keep its context.

`opensteer_plugin_list` lists deployed service plugins and local tools. Full-access Runs can install, export,
activate an earlier code version or remove one. Only the person changes agent access and links
accounts. Use opensteer:plugins for those tools and their approval behavior.

- Read [durable context](references/durable-context.md) when choosing where a correction, fact or task state belongs.
- Read [skills](references/skills.md) when authoring procedures.
- Read [verification](references/verification.md) when checking helpers and edited files.
