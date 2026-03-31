---
name: opensteer
description: "Handles Opensteer browser automation, structured DOM extraction, and browser-backed request replay with the Opensteer CLI and SDK. Use when the user mentions Opensteer, browser automation, real Chromium sessions, persistent workspace browser state, descriptor-backed DOM actions or extraction, request plans, recipes, or browser-backed API replay."
argument-hint: "[goal]"
---

# Opensteer

## Critical Rules

1. Run `snapshot action` or `snapshot extraction` first. The output is JSON with `{url, title, mode, html, counters}`. **Read the `html` field** — it is a clean filtered DOM with inline `c="N"` attributes marking every element. Do NOT parse the `counters` array for element discovery — it is verbose metadata.
2. Use `element` + `persistAsDescription` to act on elements. Use `extract()` with `description` + `schema` to extract data. Do NOT use `page.evaluate()`, CSS selectors, or raw DOM parsing when `extract()` can express the output.
3. Extraction schemas are **literal**. If you provide 2 template rows, you get exactly 2 rows back. The framework consolidates those templates into a generalized selector behind the scenes and saves it as a descriptor. Replaying with `description` alone (no schema) uses that generalized selector to return **ALL** matching rows.
4. `persistAsDescription` requires the verbose `opensteer run dom.*` syntax. The short CLI commands (`click`, `input`, etc.) do NOT support it.
5. Phase 1 = CLI exploration (snapshot, act, extract with schema). Phase 2 = deterministic replay using `description` alone returns all matching data. No snapshots in Phase 2.

If invoked directly, treat `$ARGUMENTS` as the concrete browser or replay goal. First decide whether the task is primarily DOM automation, request capture/replay, or workspace browser administration.

## Snapshot Output

`snapshot action` and `snapshot extraction` return JSON. Read the `html` field:

```json
{
  "url": "https://example.com/search?q=airpods",
  "title": "Search Results",
  "mode": "extraction",
  "html": "<span c=\"12\">$549.99</span>\n<a c=\"15\" href=\"/p/airpods-max\">\n  <div c=\"16\">Apple AirPods Max</div>\n</a>\n<a c=\"18\" href=\"/b/apple\">Apple</a>\n...",
  "counters": [{"element":12,"tagName":"SPAN",...}, ...]
}
```

`c="N"` in the HTML = `element: N` in commands and extraction schemas. Read the HTML, find the `c` values, use those numbers.

## References

Most DOM tasks use the CLI reference first (exploration), then the SDK reference (final script). Load both.

- [CLI Reference](references/cli-reference.md) — snapshot, act, extract from the terminal
- [SDK Reference](references/sdk-reference.md) — reusable TypeScript code
- [Request Workflow](references/request-workflow.md) — capture and replay HTTP requests

## Startup Checks

- Verify `opensteer` is available in the repo or on `PATH` before planning the workflow.
- If Chromium binaries are missing, install them through Playwright before debugging page behavior.
- Reuse an existing workspace id for the same site or feature when one already exists.

## Mental Model

- `workspace` / `--workspace` is the durable unit of state. Persistent workspaces live under `.opensteer/workspaces/<id>`.
- A workspace stores the browser profile, live browser metadata, artifacts, traces, network history (SQLite-backed, auto-persisted), DOM descriptors, extraction descriptors, request plans, recipes, auth recipes, and reverse-analysis records.
- In the SDK, omitting `workspace` creates a temporary root. In the CLI, stateful commands currently require `--workspace <id>`.
- With a workspace, browser mode defaults to `persistent`. `temporary` creates an isolated browser for the current run. `attach` connects to an already-running Chromium browser.
- `opensteer browser ...` manages the workspace browser itself. `opensteer close` stops the active session/browser without deleting the workspace. `browser reset` clears cloned browser state. `browser delete` removes workspace browser files.
- The short CLI only has special parsing for a few common commands. For advanced semantic operations or fields like `persistAsDescription`, use `opensteer run <semantic-operation> --workspace <id> --input-json <json>`.
- Prefer CLI `snapshot` during exploration so you can inspect the filtered HTML and `c="N"` counters directly. The SDK also exposes `snapshot()`, but this skill uses the CLI-first workflow and expects deterministic scripts to replay cached descriptors via `description`.
- Prefer Opensteer surfaces over raw Playwright so descriptors, extraction payloads, network history, request plans, recipes, traces, and artifacts stay in the workspace.

## Two-Phase Workflow

**Phase 1 — CLI exploration (one-time setup):**

```bash
opensteer open https://example.com --workspace demo
opensteer snapshot action --workspace demo
# → Read html field: <input c="5" placeholder="Search"> <button c="7">Search</button>

opensteer run dom.input --workspace demo \
  --input-json '{"target":{"kind":"element","element":5},"text":"airpods","pressEnter":true,"persistAsDescription":"search input"}'

opensteer snapshot extraction --workspace demo
# → Read html field: <div c="13">Apple AirPods</div> <span c="14">$189.99</span> ...

opensteer extract --workspace demo --description "search results" \
  --schema-json '{"items":[{"name":{"element":13},"price":{"element":14}},{"name":{"element":22},"price":{"element":23}}]}'
# → Returns exactly 2 rows (the literal template values)
# → Behind the scenes: consolidates templates into a generalized selector and saves it as a descriptor

opensteer close --workspace demo
```

**Phase 2 — Deterministic replay (reusable):**

1. Use `description` alone for all interactions — resolves from cached descriptors.
2. Use `description` alone for extraction replay — uses the generalized selector to return **ALL** matching rows.
3. No snapshot calls needed. Just descriptions.

## Shared Rules

- The short CLI commands (`click`, `input`, etc.) accept exactly one of `--element`, `--selector`, or `--description`. Use `opensteer run dom.*` with `--input-json` when you need `persistAsDescription`.
- For extraction, `description + schema` returns literal template values and saves a generalized extraction descriptor. `description` alone replays the descriptor and returns ALL matching rows.
- Extraction schemas are explicit JSON objects and arrays. Each leaf must be `{ element: N }`, `{ selector: "..." }`, optional `attribute`, or `{ source: "current_url" }`.
- Persisted extraction replay is deterministic and snapshot-backed. Do not replace `extract()` with `evaluate()` or custom DOM parsing when the desired output fits the extraction schema.
- Use recipes for deterministic setup work. Use auth recipes for auth refresh/setup specifically. They live in separate registries.
- CSS selectors exist as a low-level escape hatch but are not recommended for reusable scripts. Prefer the descriptor-based workflow.
- Do not reach for removed surfaces such as `--name`, `Opensteer.attach()`, cloud/profile-sync helpers, `local-profile`, legacy snapshot browser modes, or `@opensteer/engine-abp`.

## Common Mistakes

- Parsing the `counters` JSON array instead of reading the `html` string. Read the HTML — find `c="N"` values.
- Using `page.evaluate()` or CSS selectors instead of `extract()`. Use extract with element-based schemas.
- Forgetting to re-snapshot after navigation. Always re-snapshot before targeting new elements.
- Using short CLI (`click`, `input`) when `persistAsDescription` is needed. Use `opensteer run dom.*`.
- Expecting `extract --schema-json` with array templates to return all rows. The schema is literal — you get back exactly the rows you specified. Use description-only replay (`extract --description`) to get all matching rows.
