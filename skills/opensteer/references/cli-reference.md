# Opensteer CLI Reference

Use the CLI when you need a fast JSON-first loop against a repo-local workspace browser.

## Sections

- [Quickstart](#quickstart)
- [Browser Lifecycle And Profile Cloning](#browser-lifecycle-and-profile-cloning)
- [Browser Modes](#browser-modes)
- [Advanced Semantic Operations](#advanced-semantic-operations)
- [Extraction Schema Examples](#extraction-schema-examples)

## Quickstart

```bash
opensteer open https://example.com --workspace demo
opensteer snapshot action --workspace demo
# Identify elements from snapshot output (e.g., search input at c=5, search button at c=7)

# Act on elements AND persist their paths with human-readable descriptions
opensteer run dom.input --workspace demo \
  --input-json '{"target":{"kind":"element","element":5},"text":"search term","persistAsDescription":"search input"}'
opensteer run dom.click --workspace demo \
  --input-json '{"target":{"kind":"element","element":7},"persistAsDescription":"search button"}'

# Persist an extraction descriptor
opensteer snapshot extraction --workspace demo
opensteer extract --workspace demo \
  --description "page summary" \
  --schema-json '{"title":{"selector":"title"},"url":{"source":"current_url"}}'

# Replay later with just descriptions — no snapshot needed
opensteer click --workspace demo --description "search button"
opensteer extract --workspace demo --description "page summary"
opensteer close --workspace demo
```

- Stateful CLI commands currently require `--workspace <id>`.
- Use `snapshot action` to discover page elements during exploration.
- Use `opensteer run dom.*` with `persistAsDescription` to cache element paths under descriptions.
- Replay cached actions with `--description` alone — no snapshot needed.
- `extract --description --schema-json` writes a persisted extraction descriptor.
- `extract --description` replays the stored extraction.

## Browser Lifecycle And Profile Cloning

```bash
opensteer browser clone --workspace github-sync \
  --source-user-data-dir "$HOME/Library/Application Support/Google/Chrome" \
  --source-profile-directory Default
opensteer open https://github.com --workspace github-sync
opensteer browser status --workspace github-sync
opensteer close --workspace github-sync
opensteer browser reset --workspace github-sync
opensteer browser delete --workspace github-sync
```

- `browser clone`, `browser reset`, and `browser delete` require a persistent workspace browser.
- `browser clone` copies a local Chromium profile into `.opensteer/workspaces/<id>/browser/user-data`.
- `close` stops the active session/browser but keeps the workspace registry, traces, artifacts, and cloned browser data.

## Browser Modes

- `persistent`: default with `--workspace`. Browser state lives in the workspace.
- `temporary`: isolated browser state for the current run.
- `attach`: connect to a running Chromium browser.

```bash
opensteer open https://example.com --workspace demo --browser temporary
opensteer browser discover
opensteer browser inspect --attach-endpoint ws://127.0.0.1:9222/devtools/browser/abc
opensteer open https://example.com --workspace demo --browser attach --attach-endpoint ws://127.0.0.1:9222/devtools/browser/abc
```

Common options:

- `--headless true|false`
- `--executable-path <path>`
- `--arg <value>` repeatable
- `--timeout-ms <ms>`
- `--context-json <json>`
- `--fresh-tab true|false` for `--browser attach`

## Advanced Semantic Operations

The short CLI only special-cases a small set of commands. For advanced operations and fields not exposed by shorthand parsing, use:

```bash
opensteer run <semantic-operation> --workspace <id> --input-json <json>
```

Examples:

```bash
opensteer run dom.click --workspace demo \
  --input-json '{"target":{"kind":"selector","selector":"button.primary"},"persistAsDescription":"primary button","networkTag":"load-products"}'

opensteer run page.goto --workspace demo \
  --input-json '{"url":"https://example.com/products","networkTag":"page-load"}'

opensteer run network.query --workspace demo \
  --input-json '{"tag":"load-products","includeBodies":true,"limit":20}'

opensteer run request-plan.infer --workspace demo \
  --input-json '{"recordId":"rec_123","key":"products.search","version":"v1"}'

opensteer run request-plan.infer --workspace demo \
  --input-json '{"recordId":"rec_123","key":"products.search.portable","version":"v1","transport":"direct-http"}'

opensteer run request.execute --workspace demo \
  --input-json '{"key":"products.search","query":{"q":"laptop"}}'
```

- Command aliases such as `network query` and `request-plan infer` still exist, but they usually depend on `--input-json` for nontrivial inputs.
- Use `run page.goto` when you need `networkTag` on navigation. The short `goto` form only parses the URL positional.
- Use `run dom.click` / `run dom.input` / `run dom.hover` / `run dom.scroll` when you need `persistAsDescription`.

## Extraction Schema Examples

```bash
opensteer snapshot extraction --workspace demo
```

Explicit field bindings:

```bash
opensteer extract --workspace demo \
  --description "page summary" \
  --schema-json '{"title":{"element":3},"price":{"element":7}}'

opensteer extract --workspace demo \
  --description "links" \
  --schema-json '{"url":{"selector":"a.primary","attribute":"href"},"pageUrl":{"source":"current_url"}}'
```

Arrays with representative rows:

```bash
opensteer extract --workspace demo \
  --description "items" \
  --schema-json '{"items":[{"title":{"selector":"#products li:nth-child(1) .title"},"price":{"selector":"#products li:nth-child(1) .price"}},{"title":{"selector":"#products li:nth-child(2) .title"},"price":{"selector":"#products li:nth-child(2) .price"}}]}'
```

- Build the exact JSON object you want. The extractor does not accept semantic placeholders like `"string"` or prompt-style schemas.
- Use `element` fields only during CLI exploration with counters from a fresh snapshot. Deterministic scripts use `description`.
- For arrays, include one or more representative objects. Add multiple examples when repeated rows have structural variants.
