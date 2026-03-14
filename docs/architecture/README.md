# Architecture

This directory contains the source-of-truth documents for the rewrite.

Current status: `Phase 0` complete, `Phase 1` complete, `Phase 2` complete,
`Phase 3` complete, `Phase 4` complete, `Phase 5` complete, `Phase 6` complete,
`Phase 7` complete, `Phase 8` complete, `Phase 9` complete, `Phase 10` next.

- [Framework rewrite plan](framework-rewrite-plan.md)
- `packages/browser-core/src/` contains the implemented Phase 1 contract
- `tests/browser-core/` contains the Phase 1 conformance coverage
- `packages/protocol/src/` contains the implemented Phase 2 public contract
- `tests/protocol/` contains the Phase 2 conformance coverage
- `packages/opensteer/src/` contains the implemented Phase 3 filesystem root
  for traces, artifacts, and registries
- `tests/opensteer/` contains the Phase 3 filesystem-root coverage
- `packages/engine-playwright/src/` contains the implemented Phase 4
  Chromium-first Playwright backend
- `tests/engine-playwright/` contains the Phase 4 backend coverage
- `packages/opensteer/src/runtimes/dom/` contains the implemented Phase 5
  deterministic DOM runtime
- `tests/opensteer/dom-runtime.test.ts` contains the Phase 5 DOM runtime
  coverage
- `packages/opensteer/src/sdk/` and `packages/opensteer/src/cli/` contain the
  implemented Phase 6 SDK, HTML-first snapshot runtime, and thin CLI service
  boundary
- `tests/opensteer/phase6-sdk-cli.test.ts` contains the Phase 6 SDK and CLI
  integration coverage
- `packages/opensteer/src/policy/` contains the implemented Phase 7 policy
  layer for actionability, settle, retry, timeout, and fallback rules
- `packages/engine-abp/src/` contains the implemented Phase 8 ABP backend
- `tests/engine-abp/` contains the Phase 8 backend coverage
- `packages/opensteer/src/runtimes/computer-use/` contains the implemented
  Phase 9 computer-use runtime
- `packages/engine-playwright/src/computer-use.ts` and
  `packages/engine-abp/src/computer-use.ts` contain the Phase 9
  engine-specific computer-use adapters
- `tests/opensteer/computer-use.test.ts` contains the Phase 9 runtime coverage

Current Opensteer package direction:

- `runtimes/` owns DOM and computer-use interaction behavior
- `requests/` owns capture, plans, and execution transports
- `registry/` owns deterministic local replay and request-plan persistence
- `traces/` records timelines
- `artifacts/` stores evidence

When package boundaries or public contracts change, update these documents in
the same change.
