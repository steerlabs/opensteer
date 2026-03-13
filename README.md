# Opensteer

Opensteer is an open-source browser automation framework for AI agents.

This repository is a clean-slate rewrite. The goal is not to preserve the old
monolith or maintain backwards compatibility. The goal is to produce a small,
replaceable engine boundary, a first-class public protocol, and a product layer
that owns Opensteer's actual semantics.

## Current Status

`Phase 0` is complete.

The repository is now moving into `Phase 1`, which means:

- the monorepo layout, OSS docs, and shared tooling are in place
- package boundaries are scaffolded and build cleanly
- the rewrite architecture and phased rollout plan are documented
- the next active work is defining `packages/browser-core`

## Repository Layout

```text
packages/
  browser-core/
  protocol/
  engine-playwright/
  engine-abp/
  opensteer/
apps/
  opensteer-cloud/
docs/
  architecture/
```

Inside `packages/opensteer`, the current target structure is:

```text
src/
  runtimes/
  requests/
  registry/
  traces/
  artifacts/
  policy/
  sdk/
  cli/
```

`registry/` is the home for deterministic local replay records and reusable
request-plan persistence. `traces/` stays a timeline, and `artifacts/` stays the
durable evidence store.

## Key Documents

- [Rewrite plan and phased roadmap](docs/architecture/framework-rewrite-plan.md)
- [Browser-core Phase 1 spec](docs/architecture/browser-core-phase-1.md)
- [Architecture docs index](docs/architecture/README.md)
- [Documentation index](docs/README.md)

## Local Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## Principles

- Agent-first interfaces over human-first debugging APIs
- Small, engine-neutral contracts
- Public protocol separated from engine implementation details
- Opensteer semantics kept inside `packages/opensteer`
- No hacks, heuristics, or local bandages in place of real abstractions
