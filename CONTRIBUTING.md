# Contributing

Thanks for contributing to Oversteer OSS.

## Development

This repo uses pnpm for development and CI.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run build
```

## Guidelines

- Keep changes small and focused.
- Add tests for bug fixes or new features.
- Avoid introducing new dependencies without discussion.
- Match the existing code style and TypeScript strictness.

## Pull Requests

Please include:
- TL;DR summary
- Context / motivation
- Changes (bullets)
- Test plan
- Risks or warnings
