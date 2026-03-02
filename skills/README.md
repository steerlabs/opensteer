# Opensteer Skills

This directory contains Opensteer-maintained skill packs.

## Layout

Use this structure for each skill:

```text
skills/<skill-name>/
  SKILL.md
  references/
    *.md
  templates/
    *
```

## Conventions

- Keep one canonical skill per folder (`<skill-name>`).
- Use `SKILL.md` frontmatter with at least `name` and `description`.
- Put detailed instructions in `references/` and link them from `SKILL.md`.
- Put reusable snippets in `templates/` when needed.
- Use relative Markdown links.

## Built-in Skills

- `opensteer`: [skills/opensteer/SKILL.md](./opensteer/SKILL.md)
- `electron`: [skills/electron/SKILL.md](./electron/SKILL.md)
