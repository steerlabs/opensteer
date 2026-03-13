# Opensteer Framework Rewrite Plan

This document is the canonical context document for contributors and agents
working on the rewrite.

## Current Status

- `Phase 0` is complete.
- `Phase 1` is complete.
- `Phase 2` is the next active implementation phase.

## Goals

- Build Opensteer for AI agents, not for humans.
- Keep the engine boundary small and replaceable.
- Make the public protocol a first-class package.
- Keep Opensteer product semantics out of the engine contract.
- Avoid hacks, heuristics, local stabilizations, or post-processing bandages
  that are not faithful general algorithms.

## Rewrite Repository Layout

```text
packages/
  browser-core/
  protocol/
  engine-playwright/
  engine-abp/
  opensteer/
apps/
  opensteer-cloud/
```

Inside `packages/opensteer`, organize the product layer like this:

```text
src/
  runtimes/
    dom/
    computer-use/
  requests/
    capture/
    plans/
    execution/
      session-http/
      direct-http/   # later if needed
  registry/
    descriptors/
    request-plans/
  traces/
  artifacts/
  policy/
  sdk/
  cli/
```

Purpose of each area:

- `runtimes/dom`: selector-aware DOM interaction semantics
- `runtimes/computer-use`: coordinate and vision-driven interaction semantics
- `requests/capture`: network evidence collection during interactive runs
- `requests/plans`: request-plan inference, normalization, and validation
- `requests/execution/session-http`: request execution inside the live browser
  session boundary when auth and origin state matter
- `requests/execution/direct-http`: detached execution for reusable plans later
- `registry/descriptors`: deterministic local replay records for actions and
  extraction
- `registry/request-plans`: versioned local registry of reusable API plans
- `traces`: normalized timeline of what happened
- `artifacts`: durable evidence such as screenshots, DOM snapshots, and network
  captures
- `policy`: actionability, retry, timeout, approval, and fallback rules
- `sdk` and `cli`: the agent-facing surfaces over the same Opensteer semantics

## Original Target Architecture

### `packages/browser-core`

Owns only engine-neutral primitives and contracts.

- Identity model: `SessionRef`, `PageRef`, `FrameRef`, `DocumentRef`,
  `DocumentEpoch`, `NodeRef`, plus reserved ids for network and browser
  surfaces
- Metadata model: `PageInfo`, `FrameInfo`
- Geometry model: `Point`, `Size`, `Rect`, `Quad`, `CoordinateSpace`,
  `ViewportMetrics`, `VisualViewport`, `LayoutViewport`, `ScrollOffset`,
  `DevicePixelRatio`, `PageScaleFactor`, `PageZoomFactor`
- Contracts: `BrowserExecutor`, `BrowserInspector`,
  `SessionTransportExecutor`
- Normalized outputs: `StepResult`, `StepEvent`, `HitTestResult`,
  `DomSnapshot`, `HtmlSnapshot`, `NetworkRecord`, `CookieRecord`,
  `StorageSnapshot`
- Capabilities and normalized errors

### `packages/protocol`

Owns the public wire contract, separate from the engine contract.

- MCP schemas
- REST and JSON schemas
- versioned result and error envelopes
- trace and event schemas
- capability descriptors
- public artifact and request-plan schemas when they cross process boundaries

### `packages/engine-playwright`

Owns the reference backend.

- migration backend
- fallback backend
- real-browser and profile-clone backend

### `packages/engine-abp`

Owns the ABP backend.

- ABP for execution
- strictly read-only CDP sidecar for inspection during the transition
- high-performance backend once the abstraction is proven

### `packages/opensteer`

Owns product semantics and developer experience.

- interaction runtimes for DOM and computer-use flows
- request capture, request-plan compilation, and request execution transports
- deterministic local registries for descriptor replay and request plans
- artifacts
- traces
- policy
- CLI
- SDK

### `apps/opensteer-cloud`

Owns the Opensteer control plane and remote transport.

- workers run selected engines
- public APIs stay Opensteer APIs, not raw CDP or raw ABP

## Critical Boundaries

### What belongs in `browser-core`

- session lifecycle
- page, frame, document, and node targeting
- page and frame enumeration metadata
- native actions
- screenshots
- pause, resume, and freeze surface
- normalized browser-surface events
- hit-test
- raw DOM, HTML, text, and attribute reads
- raw structured DOM snapshots
- raw network reads
- read-only cookie and storage inspection
- session-bound raw request execution
- normalized results, capabilities, and errors

### What stays out of `browser-core`

- selector semantics
- extraction schemas
- actionability policy
- retry policy
- cache and replay policy
- coordinate trace policy
- reverse-engineering logic
- request-plan creation

These belong in `packages/opensteer`.

### What stays out of `traces` and `artifacts`

- deterministic local replay lookup
- request-plan version selection
- cache freshness policy
- plan lifecycle metadata

These belong in `packages/opensteer/registry`.

### Additional Rules

- Keep `BrowserExecutor` and `BrowserInspector` separate.
- Do not add a generic `evaluate()` API to `browser-core`.
- `SessionRef` means the auth and storage boundary, not the browser process.
- `PageRef` means the top-level browsing context for tabs, popups, and windows.
- `FrameRef` means the frame-tree slot, not the currently loaded document.
- `DocumentRef` means the concrete loaded document inside a frame.
- `DocumentEpoch` versions node-binding validity inside a `DocumentRef`.
- Keep `NodeRef` validity scoped to `DocumentRef` plus `DocumentEpoch`.
- Use ordered header entries, not plain maps, when header fidelity matters.
- Never expose raw Playwright handles, raw ABP endpoints, or raw CDP concepts in
  `packages/protocol`.

The implemented `Phase 1` browser-core contract now lives in
`packages/browser-core/src/` and is covered by `tests/browser-core/`.

## Why ABP Is A Backend, Not The Architecture

ABP is useful because it is agent-oriented today:

- engine-level execution
- action envelopes with screenshots, timing, and events
- execution pause and resume control
- network capture
- session-bound HTTP requests
- MCP and REST interfaces

ABP is not the architecture because Opensteer must survive changes in execution
backends. If ABP shapes the architecture too early, Opensteer will inherit
ABP-specific assumptions instead of defining its own stable contracts.

## ABP Sidecar Sandbox Rule

The CDP sidecar used by `engine-abp` must be enforced as a real sandbox in
code.

Allowed:

- DOM snapshot
- HTML reads
- hit-test
- layout metrics
- network observation and response-body reads
- accessibility later if needed

Forbidden:

- generic `Runtime.evaluate`
- DOM mutation
- input injection
- navigation
- traffic-changing interception
- behavior-changing emulation

## Phased Implementation Plan

### Phase 0

Create the monorepo scaffold and architecture context.

- root OSS documentation
- workspace manifests and shared tooling
- buildable package and app skeletons
- canonical rewrite plan document

Status: complete.

### Phase 1

Freeze `packages/browser-core`.

- identity model
- page and frame metadata model
- geometry model
- capabilities and normalized errors
- executor and inspector contracts
- session transport contract
- normalized result types
- raw DOM snapshots
- richer network and session-state inspection
- normalized browser-surface events

Status: complete.

### Phase 2

Define `packages/protocol`.

- versioned request and response envelopes
- public schema shapes
- trace and artifact schemas that cross process boundaries

### Phase 3

Define trace, artifact, and registry boundaries early inside `packages/opensteer`.

- `artifacts`
- `traces`
- `registry`

### Phase 4

Implement `packages/engine-playwright` first.

- smallest viable backend
- prove the abstraction before introducing ABP

### Phase 5

Move DOM semantics into `packages/opensteer/src/runtimes/dom`.

- selectors
- refs
- extraction
- DOM-backed actions

### Phase 6

Add the first agent-facing CLI and SDK surfaces through `packages/opensteer`.

### Phase 7

Add `packages/opensteer/src/policy`.

- actionability rules
- settle rules
- retry rules
- timeout tiers
- fallback thresholds

### Phase 8

Implement `packages/engine-abp`.

- ABP execution
- read-only CDP sidecar for inspection

### Phase 9

Add `packages/opensteer/src/runtimes/computer-use`.

- coordinate and vision mode
- hit-test before click
- traces record both DOM target and coordinates

### Phase 10

Add the request workflow system after the interaction runtimes are proven.

- request capture
- request-plan creation and validation
- `session-http` as the browser-session execution transport
- `direct-http` later if detached execution is needed

### Phase 11

Add `apps/opensteer-cloud`.

- workers host engines behind Opensteer contracts

## Phase 0 Done Criteria

Phase 0 is done when:

- the workspace builds cleanly
- typecheck passes cleanly
- test commands run cleanly
- the target architecture and phased plan are documented in this file
- contributors can land in the repository and understand the intended package
  boundaries before runtime code exists

Phase 0 completion notes:

- the workspace builds cleanly
- typecheck passes cleanly
- test and check commands run cleanly
- the root OSS and contributor docs are in place
- the package and app layout is scaffolded for the rewrite
