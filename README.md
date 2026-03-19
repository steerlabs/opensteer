# Opensteer

Opensteer is an open-source browser-native reverse-engineering and replay toolkit
for AI agents and humans.

This monorepo is organized around three lanes:

- `Interact`: open pages, navigate, evaluate, inspect DOM state, manage pages, use computer actions
- `Observe / Instrument`: capture network, capture scripts, install init scripts, route requests, replace scripts
- `Replay / Execute`: run `direct-http`, `context-http`, and `page-eval-http` requests directly or through plans and recipes

Browser-backed replay is a first-class success case. `direct-http` is an optimization
path when the target really permits it.

## Packages

- `packages/browser-core`: engine-neutral contracts, identity, events, storage, geometry, and test helpers
- `packages/protocol`: public wire contracts and shared schema types
- `packages/engine-playwright`: Playwright-backed browser engine
- `packages/engine-abp`: Agent Browser Protocol backend with CDP inspection support
- `packages/opensteer`: public SDK, CLI, request workflows, traces, registry, and artifacts
- `apps/opensteer-cloud`: cloud entrypoint package for hosted session infrastructure
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

Opensteer writes local runtime state under `<cwd>/.opensteer`. That directory is
for local sessions, traces, and artifacts, and should not be committed.

## Key Documents

- [Documentation index](docs/README.md)
- [Workflow guide](docs/workflows.md)
- [Instrumentation guide](docs/instrumentation.md)
- [Governance](docs/governance.md)

## Community

- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security Policy](SECURITY.md)
- [License](LICENSE)

## Local Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## Public Surface

The current public surface lives in `packages/opensteer`:

- SDK: `new Opensteer({ ... }).open()`, `goto()`, `evaluate()`, `waitForNetwork()`,
  `waitForResponse()`, page lifecycle methods, `snapshot()`, `click()`, `hover()`,
  `input()`, `scroll()`, `extract()`, `queryNetwork()`, `saveNetwork()`,
  `clearNetwork()`, `captureScripts()`, `addInitScript()`, `route()`,
  `interceptScript()`, `rawRequest()`, `inferRequestPlan()`, `writeRequestPlan()`,
  `writeRecipe()`, `runRecipe()`, `request()`, `computerExecute()`, `close()`
- CLI: `opensteer open`, `goto`, `snapshot`, `click`, `hover`, `input`, `scroll`, `extract`,
  `network query`, `network save`, `network clear`, `scripts capture`, `request raw`,
  `plan infer`, `plan write`, `plan get`, `plan list`, `recipe write`, `recipe get`,
  `recipe list`, `recipe run`, `request execute`, `computer`, `close`
- Engine selection: `opensteer open --engine <playwright|abp>` or `OPENSTEER_ENGINE=<engine>`
  chooses the backend for new session services; existing sessions keep the engine they were
  started with
- Session continuity: the CLI now talks to a local per-session service under
  `.opensteer/runtime/sessions/<name>/service.json`
- Reverse engineering: the canonical workflow is browser action, `network query`,
  optional instrumentation (`addInitScript`, `route`, `captureScripts`), `request raw`,
  `plan infer`, then `request execute`
- Snapshot mode: HTML-first action and extraction snapshots with in-memory element counters
- Computer-use mode: pixel-space actions with automatic post-action screenshots and trace data

See [packages/opensteer/README.md](packages/opensteer/README.md) for the public
SDK and CLI usage flow.

## Principles

- Agent-first interfaces over human-first debugging APIs
- Small, engine-neutral contracts
- Public protocol separated from engine implementation details
- Opensteer semantics kept inside `packages/opensteer`
- Deterministic replay artifacts for plans, recipes, and saved evidence
- Browser-backed execution treated as a core path, not a fallback
- No hacks, heuristics, or local bandages in place of real abstractions
