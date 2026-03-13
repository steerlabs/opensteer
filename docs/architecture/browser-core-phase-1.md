# Browser-Core Phase 1 Spec

This document freezes the `Phase 1` contract for `packages/browser-core`.

It is intentionally more precise than the rewrite plan. The goal is to make
`engine-playwright` implementation and fake-engine conformance work possible
without smuggling Opensteer product semantics into the engine boundary.

## Design Constraints

- Keep the engine contract small, engine-neutral, and capability-gated.
- Support raw browser behavior first, higher-level Opensteer semantics later.
- Preserve enough identity, geometry, DOM, network, and browser-surface detail
  to survive Playwright first and ABP later.
- Do not turn `browser-core` into CDP with renamed types.

## Phase 1 Contract Inventory

### Identity Primitives

- `SessionRef`
- `PageRef`
- `FrameRef`
- `DocumentRef`
- `DocumentEpoch`
- `NodeRef`
- Reserved surface and resource ids:
  - `NetworkRequestId`
  - `DownloadRef`
  - `DialogRef`
  - `ChooserRef`
  - `WorkerRef`

### Metadata Shapes

- `PageInfo`
- `FrameInfo`

### Geometry Primitives

- `Point`
- `Size`
- `Rect`
- `Quad`
- `ScrollOffset`
- `CoordinateSpace`
- `LayoutViewport`
- `VisualViewport`
- `ViewportMetrics`
- `DevicePixelRatio`
- `PageScaleFactor`
- `PageZoomFactor`

### Normalized Outputs

- `StepResult`
- `StepEvent`
- `HitTestResult`
- `DomSnapshot`
- `HtmlSnapshot`
- `NetworkRecord`
- `HeaderEntry`
- `BodyPayload`
- `CookieRecord`
- `StorageSnapshot`

### Contracts

- `BrowserExecutor`
- `BrowserInspector`
- `SessionTransportExecutor`

## Identity Semantics

### `SessionRef`

`SessionRef` is the auth and storage boundary.

- It maps to the browser session state boundary, not the browser process.
- For Playwright, this is the `BrowserContext` abstraction.
- Cookies, storage state, permissions, and related inspection APIs are scoped to
  `SessionRef`.

### `PageRef`

`PageRef` is a top-level browsing context.

- It covers tabs, popups, and separate browser windows.
- Do not introduce a separate `TabRef` in `Phase 1`.
- Opener relationships belong in `PageInfo`, not in a second page identity
  system.

### `FrameRef`

`FrameRef` identifies a frame-tree slot.

- It may outlive multiple documents loaded into that slot.
- It ends when the frame is detached or the owning page is closed.
- Parent and child relationships belong in `FrameInfo`.

### `DocumentRef`

`DocumentRef` identifies a concrete loaded document within a frame.

- Cross-document navigation creates a new `DocumentRef`.
- Same-document changes do not automatically require a new `DocumentRef`.
- `DocumentRef` is the identity boundary for DOM snapshots and node refs.

### `DocumentEpoch`

`DocumentEpoch` versions node-binding validity within a `DocumentRef`.

- It is not a generic DOM mutation counter.
- Advance it whenever the engine can no longer guarantee that existing
  `NodeRef`s still resolve against the same document-level node mapping.
- Cross-document navigation must create a new `DocumentRef`, not just a new
  epoch.
- When an epoch advances, stale `NodeRef`s must fail deterministically.

### `NodeRef`

`NodeRef` is valid only within `DocumentRef + DocumentEpoch`.

- A node ref without document identity is invalid by definition.
- Browser-core may preserve node identity across ordinary DOM mutation when the
  engine can prove the mapping is still valid.
- Browser-core must not silently rebind stale node refs to a new epoch.

## Page And Frame Metadata

### `PageInfo`

`PageInfo` exists so enumeration APIs can expose topology without leaking engine
handles.

Phase 1 fields should include:

- `pageRef`
- `sessionRef`
- `openerPageRef`
- `url`
- `title`
- lifecycle state that is stable across engines

### `FrameInfo`

`FrameInfo` exposes the frame tree and current document linkage.

Phase 1 fields should include:

- `frameRef`
- `pageRef`
- `parentFrameRef`
- `documentRef`
- `url`
- `name`

## Geometry Model

### Required Primitives

- `Size` is required for viewport sizes, content sizes, screenshot clips, and
  image metadata.
- `Quad` is required in addition to `Rect` because transformed or clipped
  targets are not faithfully represented by axis-aligned boxes.

### `CoordinateSpace`

`CoordinateSpace` must distinguish at least:

- document CSS pixels
- layout viewport CSS pixels
- visual viewport CSS pixels
- screen or window coordinates
- device pixels

### Viewport And Scale Metrics

`ViewportMetrics` must include:

- layout viewport metrics
- visual viewport metrics
- scroll offsets
- content size
- `devicePixelRatio`
- `pageScaleFactor`
- `pageZoomFactor`

Do not collapse device pixel ratio, visual page scale, and browser zoom into one
value.

## Snapshot Model

### `HtmlSnapshot`

`HtmlSnapshot` is the convenience string view of document markup.

It is not the primary raw DOM representation.

### `DomSnapshot`

`DomSnapshot` is the raw structured DOM view for `browser-core`.

It should be broad enough to represent:

- document, frame, and optional parent linkage
- node records with stable snapshot-local ids
- node type, name, value, and text content
- ordered attributes
- child relationships
- shadow DOM flattening when the engine supports it
- optional layout geometry such as rects or quads
- optional paint or ordering metadata when the engine supports it

`DomSnapshot` must stay raw.

- No selector semantics
- No extraction schema semantics
- No product-level cleaning or heuristics

## Hit Testing

`HitTestResult` should include:

- input point
- coordinate space used for the input
- resolved point after engine normalization
- `pageRef`
- `frameRef`
- `documentRef`
- optional `nodeRef`
- whether the target was obscured
- whether pointer-events caused the direct candidate to be skipped

## Network Model

### `HeaderEntry`

Headers must be represented as ordered `HeaderEntry[]`, not a plain map.

This preserves:

- duplicate headers
- original order when the engine can observe it
- multiple `Set-Cookie` values

### `BodyPayload`

`BodyPayload` is the raw payload envelope.

Phase 1 fields should include:

- raw bytes
- encoding metadata
- MIME type when known
- truncation metadata when a backend captures only part of the body

Do not parse or coerce bodies into structured JSON inside `browser-core`.

### `NetworkRecord`

`NetworkRecord` must be richer than a request and response summary.

Phase 1 fields should include:

- stable request id
- request method and URL
- ordered request headers
- ordered response headers
- response status and status text
- resource type
- redirect linkage
- timing data
- byte counts and transfer sizes when available
- initiator metadata
- navigation flag
- service worker or related source metadata when available
- optional request and response `BodyPayload`

The model should be broad enough to support HTTP immediately and websocket or
event-stream surfaces later without a breaking redesign.

## Session State Inspection

Phase 1 includes read-only session-state inspection.

### `CookieRecord`

`CookieRecord` captures normalized cookie state scoped to `SessionRef`.

### `StorageSnapshot`

`StorageSnapshot` captures read-only storage state scoped to `SessionRef`.

Phase 1 should cover:

- local storage
- session storage when the backend can observe it
- IndexedDB snapshots when the backend can observe it

These reads are inspection surfaces only. They do not imply generic script
evaluation or arbitrary storage mutation APIs in `browser-core`.

## Step And Event Model

`StepResult` must normalize observable browser surfaces that are not DOM nodes.

Phase 1 should expose them through a capability-gated `StepEvent` union, even if
individual backends implement only a subset at first.

### Phase 1 Event Families

Phase 1 reserves normalized event families for:

- page lifecycle events:
  - page created
  - popup opened
  - page closed
- dialog events
- download events
- chooser events, including file choosers and native select popups when the
  backend can observe them
- worker and service worker events
- console events
- page error events
- websocket and event-stream activity when the backend can observe it
- execution state events:
  - paused
  - resumed
  - frozen

These are observable surfaces first, not full control APIs by default.

## Contract Boundaries

### `BrowserExecutor`

Owns mutation and execution surfaces only:

- session lifecycle
- page lifecycle
- navigation
- native input and browser actions
- screenshots
- pause, resume, and freeze

### `BrowserInspector`

Owns read-only inspection surfaces only:

- page and frame enumeration
- DOM and HTML reads
- DOM snapshots
- hit testing
- viewport and layout metrics
- network reads
- cookie and storage inspection

### `SessionTransportExecutor`

Owns session-bound raw HTTP execution only.

It must not grow into request planning, interception, or higher-level product
transport logic.

## Explicit Non-Goals

Phase 1 does not include:

- generic `evaluate()`
- selector semantics
- extraction schemas
- retry or actionability policy
- request-plan logic
- network interception or mutation
- mirroring the full CDP surface

Those belong in later layers, primarily `packages/opensteer`.

## Fake-Engine Conformance Matrix

The fake engine exists to prove the contract shape, not browser fidelity.

Minimum `Phase 1` fake-engine coverage:

| Surface | Fake engine requirement |
| --- | --- |
| Identity | Must model `SessionRef`, `PageRef`, `FrameRef`, `DocumentRef`, `DocumentEpoch`, and deterministic stale `NodeRef` failure. |
| Enumeration | Must return stable `PageInfo` and `FrameInfo` topology, including opener and parent relationships when present. |
| Geometry | Must support `Point`, `Size`, `Rect`, `Quad`, and explicit coordinate spaces in fixtures. |
| DOM | Must return both `HtmlSnapshot` and structured `DomSnapshot` fixtures. |
| Hit test | Must return normalized `HitTestResult` including coordinate space and target refs. |
| Network | Must emit `NetworkRecord` fixtures with ordered headers and optional raw bodies. |
| Session state | Must expose `CookieRecord` and `StorageSnapshot` fixtures. |
| Step events | Must emit capability-gated `StepEvent` fixtures for non-DOM browser surfaces. |

The fake engine does not need to emulate real browser timing, rendering, or full
network stack behavior. It only needs to prove that the contract is coherent and
testable.
