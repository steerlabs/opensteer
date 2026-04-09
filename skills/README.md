# Opensteer Skills

First-party Opensteer skills published from this repository. Install them through the upstream [`skills`](https://skills.sh) CLI into Codex, Cursor, Claude Code, and other compatible agents.

## Install

```bash
opensteer skills install
```

Install into Claude Code explicitly:

```bash
opensteer skills install --agent claude-code
```

Install into Codex, Cursor, and Claude Code explicitly:

```bash
opensteer skills install --agent codex --agent cursor --agent claude-code
```

List the packaged skills without installing them:

```bash
opensteer skills install --list
```

## Available Skills

- `opensteer`: browser automation, DOM extraction, session-state inspection, and browser-backed request replay with the Opensteer CLI and SDK

## Repository Layout

```text
skills/
  opensteer/
    SKILL.md
```

## Maintainers

- Run `pnpm run skills:check` to verify that the upstream `skills` CLI can discover this repository.
- Keep each skill self-contained under `skills/<name>/` and keep links relative.
- Codex and Cursor load project skills from `.agents/skills/`; Claude Code loads them from `.claude/skills/`.
