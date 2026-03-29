---
name: opensteer
description: "Handles Opensteer browser automation, structured DOM extraction, and browser-backed request replay with the Opensteer CLI and SDK. Use when the user mentions Opensteer, browser automation, real Chromium sessions, persistent workspace browser state, descriptor-backed DOM actions or extraction, request plans, recipes, or browser-backed API replay."
argument-hint: "[goal]"
---

# Opensteer

If invoked directly, treat `$ARGUMENTS` as the concrete browser or replay goal. First decide whether the task is primarily DOM automation, request capture/replay, or workspace browser administration.

Use this skill when a task needs a real browser workflow, persistent workspace browser state, structured DOM extraction, or browser-backed request replay.

Choose the reference that matches the job:

- CLI exploration and browser admin: [references/cli-reference.md](references/cli-reference.md)
- SDK automation and reusable code: [references/sdk-reference.md](references/sdk-reference.md)
- Request capture, plans, and recipes: [references/request-workflow.md](references/request-workflow.md)

## Startup Checks

- Verify `opensteer` is available in the repo or on `PATH` before planning the workflow.
- If Chromium binaries are missing, install them through Playwright before debugging page behavior.
- Reuse an existing workspace id for the same site or feature when one already exists.

## Mental Model

- `workspace` / `--workspace` is the durable unit of state. Persistent workspaces live under `.opensteer/workspaces/<id>`.
- A workspace stores the browser profile, live browser metadata, artifacts, traces, saved network, DOM descriptors, extraction descriptors, request plans, recipes, auth recipes, and reverse-analysis records.
- In the SDK, omitting `workspace` creates a temporary root. In the CLI, stateful commands currently require `--workspace <id>`.
- With a workspace, browser mode defaults to `persistent`. `temporary` creates an isolated browser for the current run. `attach` connects to an already-running Chromium browser.
- `opensteer browser ...` manages the workspace browser itself. `opensteer close` stops the active session/browser without deleting the workspace. `browser reset` clears cloned browser state. `browser delete` removes workspace browser files.
- The short CLI only has special parsing for a few common commands. For advanced semantic operations or fields like `persistAsDescription`, use `opensteer run <semantic-operation> --workspace <id> --input-json <json>`.
- `snapshot` is a CLI exploration tool for discovering page elements. The public SDK does not expose `snapshot()`. Deterministic scripts use cached descriptors via `description`.
- Prefer Opensteer surfaces over raw Playwright so descriptors, extraction payloads, saved network, request plans, recipes, traces, and artifacts stay in the workspace.

## Workflow Selection

- Choose the DOM workflow when the answer must come from the rendered page or a real browser interaction.
- Choose the request workflow when the durable artifact is an HTTP path, request plan, recipe, or reverse-analysis package.
- Many tasks use both: prove the browser flow first, then capture and promote the underlying request path.

## Two-Phase Workflow

**Phase 1 — CLI exploration (one-time setup):**
1. `snapshot action` to discover page elements and their counter values.
2. Act on elements with `opensteer run dom.<action> --input-json` using `element + persistAsDescription` to cache element paths under human-readable names.
3. Re-snapshot after navigation before targeting new elements.
4. Use `extract --description <name> --schema-json <schema>` to persist extraction descriptors.

**Phase 2 — Deterministic script (reusable):**
1. Use `description` alone for all interactions — resolves from cached descriptors.
2. Use `description + schema` for extraction — caches the extraction descriptor.
3. Use bare `description` for extraction replay.
4. No snapshot calls needed in scripts. Just descriptions.

## Shared Rules

- The short CLI commands (`click`, `input`, etc.) accept exactly one of `--element`, `--selector`, or `--description`. Use `opensteer run dom.*` with `--input-json` when you need `persistAsDescription`.
- For extraction, `description + schema` authors or updates a persisted extraction descriptor. `description` alone replays the stored extraction payload.
- Extraction schemas are explicit JSON objects and arrays. Each leaf must be `{ element: N }`, `{ selector: "..." }`, optional `attribute`, or `{ source: "current_url" }`.
- Persisted extraction replay is deterministic and snapshot-backed. Do not replace `extract()` with `evaluate()` or custom DOM parsing when the desired output fits the extraction schema.
- Use recipes for deterministic setup work. Use auth recipes for auth refresh/setup specifically. They live in separate registries.
- CSS selectors exist as a low-level escape hatch but are not recommended for reusable scripts. Prefer the descriptor-based workflow.
- Do not reach for removed surfaces such as `snapshot()` on the SDK, `--name`, `Opensteer.attach()`, cloud/profile-sync helpers, `local-profile`, legacy snapshot browser modes, or `@opensteer/engine-abp`.
