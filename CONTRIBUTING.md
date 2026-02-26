# Contributing

Thanks for helping improve Opensteer.

## Prerequisites

- Node.js `>=20`
- `pnpm` (via Corepack)

## Local Setup

```bash
corepack enable
pnpm install --frozen-lockfile
```

## Validation Commands

Run these before opening a PR:

```bash
pnpm run typecheck
pnpm run build
pnpm run test
```

Useful focused suites:

```bash
pnpm run test:unit
pnpm run test:actions
pnpm run test:integration
pnpm run test:e2e
pnpm run test:ai
```

Live web suite is opt-in and requires explicit env setup:

```bash
RUN_LIVE_WEB=1 pnpm run test:live-web
```

## Contribution Guidelines

- Keep PRs focused and scoped to a single problem.
- Add or update tests for behavior changes and bug fixes.
- Update docs when public behavior, env vars, or command usage changes.
- Do not include unrelated refactors in feature/fix PRs.
- Avoid new dependencies unless there is a clear need.

## Pull Request Template

Include this in your PR description:

1. What changed
2. Why it changed
3. How you validated it
4. Risks, limitations, or follow-up items

## Reporting Security Issues

Do not open public issues for security vulnerabilities.
Follow [SECURITY.md](SECURITY.md).
