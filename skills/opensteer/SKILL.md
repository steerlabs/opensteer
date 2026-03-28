---
name: opensteer
description: "Workspace-backed browser automation, structured DOM extraction, and browser-backed request replay with the Opensteer CLI and SDK. Use when a task needs a real Chromium session, persistent browser state in a repo workspace, descriptor-backed DOM actions or extraction, or captured request plans and recipes."
---

# Opensteer

Use this skill when a task needs a real browser workflow, persistent workspace browser state, structured DOM extraction, or browser-backed request replay.

Choose the reference that matches the job:

- CLI exploration and browser admin: [references/cli-reference.md](references/cli-reference.md)
- SDK automation and reusable code: [references/sdk-reference.md](references/sdk-reference.md)
- Request capture, plans, and recipes: [references/request-workflow.md](references/request-workflow.md)

## Mental Model

- `workspace` / `--workspace` is the durable unit of state. Persistent workspaces live under `.opensteer/workspaces/<id>`.
- A workspace stores the browser profile, live browser metadata, artifacts, traces, saved network, DOM descriptors, extraction descriptors, request plans, recipes, auth recipes, and reverse-analysis records.
- In the SDK, omitting `workspace` creates a temporary root. In the CLI, stateful commands currently require `--workspace <id>`.
- With a workspace, browser mode defaults to `persistent`. `temporary` creates an isolated browser for the current run. `attach` connects to an already-running Chromium browser.
- `opensteer browser ...` manages the workspace browser itself. `opensteer close` stops the active session/browser without deleting the workspace. `browser reset` clears cloned browser state. `browser delete` removes workspace browser files.
- The short CLI only has special parsing for a few common commands. For advanced semantic operations or fields like `persistAsDescription`, use `opensteer run <semantic-operation> --workspace <id> --input-json <json>`.
- Prefer Opensteer surfaces over raw Playwright so descriptors, extraction payloads, saved network, request plans, recipes, traces, and artifacts stay in the workspace.

## Workflow Selection

- Choose the DOM workflow when the answer must come from the rendered page or a real browser interaction.
- Choose the request workflow when the durable artifact is an HTTP path, request plan, recipe, or reverse-analysis package.
- Many tasks use both: prove the browser flow first, then capture and promote the underlying request path.

## Shared Rules

- Keep one stable workspace id per site or feature.
- Use `snapshot("action")` or `snapshot action` before counter-based `element` targets.
- Re-snapshot after navigation or DOM-changing actions before reusing element counters.
- In the SDK, `selector + description` or `element + description` persists a DOM action descriptor. `description` alone reuses it later.
- In the CLI, the short `click` / `hover` / `input` / `scroll` forms accept exactly one target. Use `opensteer run dom.* --input-json` when you need `persistAsDescription`.
- For extraction, `description + schema` authors or updates a persisted extraction descriptor. `description` alone replays the stored extraction payload.
- Extraction schemas are explicit JSON objects and arrays. Each leaf must be `{ element: N }`, `{ selector: "..." }`, optional `attribute`, or `{ source: "current_url" }`.
- Persisted extraction replay is deterministic and snapshot-backed. Do not replace `extract()` with `evaluate()` or custom DOM parsing when the desired output fits the extraction schema.
- Use recipes for deterministic setup work. Use auth recipes for auth refresh/setup specifically. They live in separate registries.
- Do not reach for removed surfaces such as `--name`, `Opensteer.attach()`, cloud/profile-sync helpers, `local-profile`, legacy snapshot browser modes, or `@opensteer/engine-abp`.
