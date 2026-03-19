# Contributing

Thanks for contributing to Opensteer.

Please review the [Code of Conduct](CODE_OF_CONDUCT.md) and [Security Policy](SECURITY.md)
before participating in issues or pull requests.

## Development Setup

1. Install Node.js `>=24`.
2. Install `pnpm` `10.29.3`.
3. Run `pnpm install`.

## Common Commands

- `pnpm build`
- `pnpm typecheck`
- `pnpm test`
- `pnpm check`
- `pnpm format`
- `pnpm run opensteer:local -- <args>` for local CLI testing in this repo

## Local CLI Workflow

Use `pnpm run opensteer:local -- ...` when testing the CLI from this workspace.

Do not use bare `opensteer ...` in this repo. That can resolve to a globally installed CLI instead of the source in this checkout.

Examples:

```bash
pnpm run opensteer:local -- open https://example.com --headless true
pnpm run opensteer:local -- snapshot action
pnpm run opensteer:local -- close
```

## Project Rules

- Keep `browser-core` engine-neutral and small.
- Keep public wire schemas in `packages/protocol`.
- Keep product semantics in `packages/opensteer`.
- Do not add backwards-compatibility shims unless the maintainers explicitly ask
  for them.
- Avoid hacks, heuristics, or local stabilizations that are not faithful general
  algorithms.

## Repository Hygiene

- Do not commit local runtime state such as `.opensteer/`, browser profiles, or editor metadata.
- Keep one-off investigation scripts and captured third-party payloads out of the repository unless they are part of a maintained developer workflow.
- Put reusable fixtures under `tests/` and durable product documentation under `docs/` or package READMEs.

## Pull Requests

- Prefer small, reviewable pull requests.
- Include tests for behavior changes.
- Update docs when package boundaries, public contracts, or developer workflows
  change.
- Call out assumptions and open questions in the pull request description.
- Do not add a new stable top-level API without:
  - one generic fixture test
  - one documented usage snippet in a README or guide
  - docs that explain capability requirements and failure behavior
