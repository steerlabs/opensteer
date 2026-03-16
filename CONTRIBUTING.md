# Contributing

Thanks for contributing to Opensteer.

## Development Setup

1. Install Node.js `>=20`.
2. Install `pnpm` `10.29.3`.
3. Run `pnpm install`.

## Common Commands

- `pnpm build`
- `pnpm typecheck`
- `pnpm test`
- `pnpm check`
- `pnpm format`
- `pnpm run opensteer:local -- <args>` for local rewrite CLI testing in this repo

## Local CLI Workflow

Use `pnpm run opensteer:local -- ...` when testing the rewrite CLI from this workspace.

Do not use bare `opensteer ...` in this repo. That can resolve to a globally installed CLI instead of the source in this checkout.

Examples:

```bash
pnpm run opensteer:local -- open https://example.com --headless true
pnpm run opensteer:local -- snapshot action
pnpm run opensteer:local -- close
```

## Project Rules

- Read [docs/architecture/framework-rewrite-plan.md](docs/architecture/framework-rewrite-plan.md)
  before making structural changes.
- Keep `browser-core` engine-neutral and small.
- Keep public wire schemas in `packages/protocol`.
- Keep product semantics in `packages/opensteer`.
- Do not add backwards-compatibility shims unless the maintainers explicitly ask
  for them.
- Avoid hacks, heuristics, or local stabilizations that are not faithful general
  algorithms.

## Pull Requests

- Prefer small, reviewable pull requests.
- Include tests for behavior changes.
- Update docs when package boundaries, public contracts, or developer workflows
  change.
- Call out assumptions and open questions in the pull request description.
