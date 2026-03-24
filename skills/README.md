# Opensteer Skills

First-party Opensteer skills published from this repository for agents that use the upstream [`skills`](https://skills.sh) ecosystem.

## Install

```bash
opensteer skills install
```

## Available Skills

- `opensteer`: browser automation, structured extraction, and browser-backed API reverse engineering with the Opensteer CLI and SDK

## Repository Layout

```text
skills/
  opensteer/
    SKILL.md
    references/
      cli-reference.md
      sdk-reference.md
      request-workflow.md
```

## Maintainers

- Run `pnpm run skills:check` to verify that the upstream `skills` CLI can discover this repository.
- Keep each skill self-contained under `skills/<name>/` and keep links relative.
