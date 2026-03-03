# Contributing

Thanks for helping improve Opensteer.

## Prerequisites

- Node.js `>=20`
- `pnpm` (canonical maintainer workflow via Corepack)
- `npm` or `bun` are also supported for local development

## Local Setup

```bash
corepack enable
pnpm install --frozen-lockfile
```

Alternative setups:

```bash
# npm
npm install

# bun
bun install
```

`pnpm-lock.yaml` is the canonical lockfile used by CI/release workflows.

## Validation Commands

Run these before opening a PR:

```bash
pnpm run typecheck
pnpm run build
pnpm run test
```

Alternative command prefixes:

```bash
# npm
npm run typecheck
npm run build
npm run test

# bun
bun run typecheck
bun run build
bun run test
```

Useful focused suites:

```bash
pnpm run test:unit
pnpm run test:actions
pnpm run test:integration
pnpm run test:e2e
pnpm run test:ai
```

You can swap `pnpm run` with `npm run` or `bun run` for the same script names.

Live web suite is opt-in and requires explicit env setup:

```bash
RUN_LIVE_WEB=1 pnpm run test:live-web
```

## Contribution Guidelines

- Keep PRs focused and scoped to a single problem.
- Add or update tests for behavior changes and bug fixes.
- Update docs when public behavior, env vars, or command usage changes.
- For skill changes, keep content in `skills/<skill-name>/` and ensure linked
  reference docs resolve with relative Markdown paths.
- Do not include unrelated refactors in feature/fix PRs.
- Avoid new dependencies unless there is a clear need.

## Pull Request Template

Include this in your PR description:

1. What changed
2. Why it changed
3. How you validated it
4. Risks, limitations, or follow-up items

## Ownership And Governance

- File ownership is defined in [`.github/CODEOWNERS`](.github/CODEOWNERS).
- Project decision-making and maintainer responsibilities are defined in
  [GOVERNANCE.md](GOVERNANCE.md) and [MAINTAINERS.md](MAINTAINERS.md).

## Reporting Security Issues

Do not open public issues for security vulnerabilities.
Follow [SECURITY.md](SECURITY.md).
