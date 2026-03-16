# Opensteer

Opensteer is an open-source browser automation framework for AI agents.

This repository is a clean-slate rewrite. The goal is not to preserve the old
monolith or maintain backwards compatibility. The goal is to produce a small,
replaceable engine boundary, a first-class public protocol, and a product layer
that owns Opensteer's actual semantics.

## Current Status

`Phase 0`, `Phase 1`, `Phase 2`, `Phase 3`, `Phase 4`, `Phase 5`, `Phase 6`, `Phase 7`, `Phase 8`, `Phase 9`, and `Phase 10` are complete. `Phase 11` is not started.

The repository now has:

- the monorepo layout, OSS docs, and shared tooling are in place
- the `packages/browser-core` Phase 1 contract is implemented and tested
- the `packages/protocol` Phase 2 public wire contract is implemented and tested
- the `packages/opensteer` Phase 3 filesystem root for traces, artifacts, and registries is
  implemented and tested
- the `packages/engine-playwright` Phase 4 Chromium-first backend is implemented and tested
- the `packages/opensteer/src/runtimes/dom` Phase 5 DOM runtime is implemented and tested
- the `packages/opensteer` Phase 6 semantic SDK, HTML-first snapshot compiler, and thin CLI
  service boundary are implemented and tested
- the `packages/opensteer/src/policy` Phase 7 policy layer is implemented and tested
- the `packages/engine-abp` Phase 8 ABP backend is implemented, with ABP execution and a
  read-only CDP inspection sidecar
- the `packages/opensteer/src/runtimes/computer-use` Phase 9 computer-use runtime is
  implemented and tested, with engine-specific adapters for Playwright and ABP
- the `packages/opensteer/src/requests` Phase 10 request workflow system is implemented and tested
- the rewrite architecture and phased rollout plan are documented

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
  sdk/
  cli/
  registry/
  traces/
  artifacts/
```

`registry/` is the home for deterministic local replay records and reusable
request-plan persistence. `traces/` stays a timeline, and `artifacts/` stays the
durable evidence store.

The local Opensteer root created by `packages/opensteer` uses this layout:

```text
opensteer-root.json
artifacts/
  manifests/
  objects/
    sha256/
traces/
  runs/
registry/
  descriptors/
    records/
    indexes/
      by-key/
  request-plans/
    records/
    indexes/
      by-key/
runtime/
  sessions/
```

## Key Documents

- [Rewrite plan and phased roadmap](docs/architecture/framework-rewrite-plan.md)
- [Architecture docs index](docs/architecture/README.md)
- [Documentation index](docs/README.md)

## Local Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## Public Surface

The current public surface lives in `packages/opensteer`:

- SDK: `new Opensteer({ ... }).open()`, `goto()`, `snapshot()`, `click()`, `hover()`, `input()`,
  `scroll()`, `extract()`, `queryNetwork()`, `saveNetwork()`, `clearNetwork()`,
  `rawRequest()`, `inferRequestPlan()`, `writeRequestPlan()`, `getRequestPlan()`,
  `listRequestPlans()`, `request()`, `computerExecute()`, `close()`
- CLI: `opensteer open`, `goto`, `snapshot`, `click`, `hover`, `input`, `scroll`, `extract`,
  `network query`, `network save`, `network clear`, `request raw`, `plan infer`, `plan write`,
  `plan get`, `plan list`, `request execute`, `computer`, `close`
- Engine selection: `opensteer open --engine <playwright|abp>` or `OPENSTEER_ENGINE=<engine>`
  chooses the backend for new session services; existing sessions keep the engine they were
  started with
- Session continuity: the CLI now talks to a local per-session service under
  `.opensteer/runtime/sessions/<name>/service.json`
- Reverse engineering: the canonical workflow is browser action, `network query`, `request raw`,
  `plan infer`, then `request execute`
- Snapshot mode: HTML-first action and extraction snapshots with in-memory element counters
- Computer-use mode: pixel-space actions with automatic post-action screenshots and trace data

See [packages/opensteer/README.md](packages/opensteer/README.md) and
[`examples/phase6-sdk.ts`](examples/phase6-sdk.ts) for the public usage flow.

## Principles

- Agent-first interfaces over human-first debugging APIs
- Small, engine-neutral contracts
- Public protocol separated from engine implementation details
- Opensteer semantics kept inside `packages/opensteer`
- No hacks, heuristics, or local bandages in place of real abstractions
