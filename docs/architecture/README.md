# Architecture

This directory contains the source-of-truth documents for the rewrite.

Current status: `Phase 0` complete, `Phase 1` next.

- [Framework rewrite plan](framework-rewrite-plan.md)
- [Browser-core Phase 1 spec](browser-core-phase-1.md)

Current Opensteer package direction:

- `runtimes/` owns DOM and computer-use interaction behavior
- `requests/` owns capture, plans, and execution transports
- `registry/` owns deterministic local replay and request-plan persistence
- `traces/` records timelines
- `artifacts/` stores evidence

When package boundaries or public contracts change, update these documents in
the same change.
