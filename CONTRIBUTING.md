# Contributing

Thanks for helping improve Opensteer.

## Scope

Opensteer should stay generic:

- browser attachment and CDP helpers;
- local snippet execution;
- generic browser interaction skills;
- runtime setup and diagnostics.

Project-specific selectors, workflows, API clients, local databases, credentials,
and agent tools belong in a harness pack, not in Opensteer.

## Development

```bash
uv sync
uv run pytest
uv run ruff check .
```

## Pull Requests

Before opening a PR:

- keep the change focused;
- add or update tests for behavior changes;
- update docs for user-facing changes;
- run tests and lint;
- confirm `git status` does not include local artifacts.

Do not commit `.env`, `.opensteer/`, `.claude/`, browser profiles, cookies,
tokens, logs, virtualenvs, build output, or dependency folders.

## Reporting Issues

Please include:

- Opensteer version;
- operating system;
- browser and version;
- command or code snippet;
- expected behavior;
- actual behavior;
- minimal logs with secrets removed.
