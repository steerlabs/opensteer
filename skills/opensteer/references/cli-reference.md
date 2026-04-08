# Opensteer CLI Reference

This covers DOM exploration and browser administration. For request capture workflows, see the [Request Workflow](request-workflow.md) reference.

Use the CLI when you need a fast JSON-first loop against a repo-local workspace browser.

## Sections

- [Quickstart](#quickstart)
- [Snapshot Output — What To Read](#snapshot-output--what-to-read)
- [End-to-End Example](#end-to-end-example)
- [Browser Lifecycle And Profile Cloning](#browser-lifecycle-and-profile-cloning)
- [Browser Modes](#browser-modes)
- [Advanced Semantic Operations](#advanced-semantic-operations)
- [Extraction Schema And Array Auto-Generalization](#extraction-schema-and-array-auto-generalization)

## Quickstart

```bash
opensteer open https://example.com --workspace demo
opensteer snapshot action --workspace demo
# Read the "html" field in the JSON output. Find elements by their c="N" attributes.
# Example: <input c="5" placeholder="Search"> means element 5 is the search input.
# Example: <button c="7">Search</button> means element 7 is the search button.

# Act on elements AND persist their paths with human-readable descriptions
opensteer run dom.input --workspace demo \
  --input-json '{"target":{"kind":"element","element":5},"text":"search term","persistAsDescription":"search input"}'
opensteer run dom.click --workspace demo \
  --input-json '{"target":{"kind":"element","element":7},"persistAsDescription":"search button"}'

# Re-snapshot after navigation, then persist an extraction descriptor
opensteer snapshot extraction --workspace demo
opensteer extract --workspace demo \
  --description "page summary" \
  --schema-json '{"title":{"element":3},"url":{"source":"current_url"}}'

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
- Persisted network history (`network.query`, `network.tag`, and `network.clear`) is SQLite-backed and initializes on first use.
- Generic workspace and browser commands do not require SQLite capability unless they touch network history persistence.

## Snapshot Output — What To Read

`snapshot action` and `snapshot extraction` both return JSON:

```json
{
  "url": "https://example.com/search?q=airpods",
  "title": "Search Results",
  "mode": "extraction",
  "html": "<span c=\"12\">$549.99</span>\n<a c=\"15\" href=\"/p/product-1\">\n  <div c=\"16\">Apple AirPods Max</div>\n</a>\n<a c=\"18\" href=\"/b/apple\">Apple</a>...",
  "counters": [{"element":12,"tagName":"SPAN","pathHint":"span",...}, ...]
}
```

**Read the `html` field.** It is a clean, filtered DOM. Hidden elements, scripts, and styles are already removed. Every element has a `c="N"` attribute.

- `c="N"` in the HTML = `element: N` in commands and extraction schemas
- `snapshot action` keeps interactive elements (buttons, inputs, links) for clicking/typing
- `snapshot extraction` keeps all visible content (text, prices, titles) for data extraction
- Do NOT parse the `counters` array to find elements — it is verbose metadata. Read the HTML string, find the `c="N"` values, and use those numbers.

## End-to-End Example

Goal: go to a site, search for a product, extract all results.

```bash
# 1. Open the page
opensteer open https://example.com --workspace demo

# 2. Snapshot to discover elements
opensteer snapshot action --workspace demo
# Read html field. Find: <input c="5" placeholder="Search"> and <button c="7">Search</button>

# 3. Type search term and persist the element path
opensteer run dom.input --workspace demo \
  --input-json '{"target":{"kind":"element","element":5},"text":"airpods","pressEnter":true,"persistAsDescription":"search input"}'

# 4. Re-snapshot the results page (always re-snapshot after navigation!)
opensteer snapshot extraction --workspace demo
# Read html field. Find product items with their c="N" values:
# <div c="13">Apple AirPods Max</div> <span c="14">$549.99</span>
# <div c="22">Apple AirPods Pro</div> <span c="23">$249.99</span>

# 5. Extract all results — array auto-generalizes from template rows
opensteer extract --workspace demo \
  --description "search results" \
  --schema-json '{"items":[{"name":{"element":13},"price":{"element":14}},{"name":{"element":22},"price":{"element":23}}]}'
# Returns ALL matching rows on the page, not just the 2 templates.

# 6. Close
opensteer close --workspace demo
```

Total: 6 commands.

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
- `temporary`: default without `--workspace`. Browser state is isolated to the current run.
- `attach`: connect to a running Chromium browser with `--attach-endpoint`.

The CLI does not expose a browser-mode flag. `--workspace` determines persistent vs temporary mode, and `--attach-endpoint` switches to attach mode.

```bash
opensteer open https://example.com
opensteer open https://example.com --workspace demo
opensteer browser discover
opensteer browser inspect --attach-endpoint ws://127.0.0.1:9222/devtools/browser/abc
opensteer open https://example.com --workspace demo --attach-endpoint ws://127.0.0.1:9222/devtools/browser/abc
```

Common options:

- `--headless true|false`
- `--executable-path <path>`
- `--arg <value>` repeatable
- `--timeout-ms <ms>`
- `--context-json <json>`
- `--fresh-tab true|false` for attach mode

## Advanced Semantic Operations

The short CLI only special-cases a small set of commands. For advanced operations and fields not exposed by shorthand parsing, use:

```bash
opensteer run <semantic-operation> --workspace <id> --input-json <json>
```

Examples:

```bash
opensteer run dom.click --workspace demo \
  --input-json '{"target":{"kind":"selector","selector":"button.primary"},"persistAsDescription":"primary button","captureNetwork":"load-products"}'

opensteer run page.goto --workspace demo \
  --input-json '{"url":"https://example.com/products","captureNetwork":"page-load"}'

opensteer run network.query --workspace demo \
  --input-json '{"capture":"load-products","includeBodies":true,"limit":20}'

opensteer run request-plan.infer --workspace demo \
  --input-json '{"recordId":"rec_123","key":"products.search","version":"v1"}'

opensteer run request-plan.infer --workspace demo \
  --input-json '{"recordId":"rec_123","key":"products.search.portable","version":"v1","transport":"direct-http"}'

opensteer run request.execute --workspace demo \
  --input-json '{"key":"products.search","query":{"q":"laptop"}}'
```

- Command aliases such as `network query` and `request-plan infer` still exist, but they usually depend on `--input-json` for nontrivial inputs.
- Use `run page.goto` when you need `captureNetwork` on navigation. The short `goto` form only parses the URL positional.
- Use `run dom.click` / `run dom.input` / `run dom.hover` / `run dom.scroll` when you need `persistAsDescription`.

## Extraction Schema

Always run `snapshot extraction` before building a schema — you need the `c="N"` counter values from the HTML.

Schemas are **literal**: each `element` reference points to one specific DOM element, and you get back exactly the values you asked for. The schema is not a prompt or pattern — it is a precise specification.

Flat field bindings:

```bash
opensteer extract --workspace demo \
  --description "page summary" \
  --schema-json '{"title":{"element":3},"price":{"element":7}}'

opensteer extract --workspace demo \
  --description "links" \
  --schema-json '{"url":{"selector":"a.primary","attribute":"href"},"pageUrl":{"source":"current_url"}}'
```

## Array Extraction (Two-Step Process)

Extracting lists of items (product rows, search results, etc.) is a two-step process:

**Step 1 — Teach the pattern (schema + description):**

Provide 2 structurally similar rows as templates. The extractor returns exactly those rows (literal), but behind the scenes consolidates the templates into a generalized selector and saves it as a descriptor.

```bash
opensteer extract --workspace demo \
  --description "product list" \
  --schema-json '{"items":[{"name":{"element":13},"price":{"element":14}},{"name":{"element":22},"price":{"element":23}}]}'
```

Returns exactly 2 rows (the literal template values):
```json
{
  "items": [
    {"name": "Apple AirPods Max", "price": "$549.99"},
    {"name": "Apple AirPods Pro", "price": "$249.99"}
  ]
}
```

**Step 2 — Replay to get all rows (description only, no schema):**

Replay the saved descriptor. The generalized selector finds ALL matching rows on the page:

```bash
opensteer extract --workspace demo --description "product list"
```

Returns all matching rows:
```json
{
  "items": [
    {"name": "Apple AirPods Max", "price": "$549.99"},
    {"name": "Apple AirPods Pro", "price": "$249.99"},
    {"name": "Apple AirPods 4", "price": "$129.99"},
    {"name": "Apple AirPods 4 (ANC)", "price": "$179.99"}
  ]
}
```

This replay is deterministic and works across page updates, pagination, and different page states.

Rules:

- Build the exact JSON shape you want. The extractor does not accept `"string"` or prompt-style schemas.
- Each leaf must be `{ element: N }`, `{ selector: "..." }`, optional `attribute`, or `{ source: "current_url" }`.
- Use `element` fields during CLI exploration with a fresh snapshot. Deterministic scripts use `description`.
- For arrays, provide 2 representative objects from different positions in the list. This gives the consolidator enough structural signal to generalize. Add more when rows have structural variants.
- Nested arrays are not supported.
- Do NOT expect the initial `extract --schema-json` call to return all rows. It returns exactly the template rows. Use description-only replay for the full list.

## What NOT To Do

- Do NOT use `page.evaluate()` to scrape DOM data. Use `extract()` with element-based schemas.
- Do NOT parse the `counters` array to find elements. Read the `html` string and find `c="N"` values.
- Do NOT use CSS selectors in reusable scripts. Use `description` from cached descriptors.
- Do NOT write loops to enumerate list items. Use array extraction: provide 2 template rows in the schema, then replay with description only to get all rows.
- Do NOT expect `extract --schema-json` with array templates to return all rows. It returns exactly the templates. Replay with `--description` alone for the full list.
- Do NOT skip re-snapshot after navigation. Always re-snapshot before targeting new elements.
