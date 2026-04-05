---
name: opensteer
description: "Handles Opensteer browser automation, structured DOM extraction, and browser-backed request replay with the Opensteer CLI and SDK. Use when the user mentions Opensteer, browser automation, real Chromium sessions, persistent workspace browser state, descriptor-backed DOM actions or extraction, request plans, recipes, or browser-backed API replay. Do NOT use for: generic HTTP client calls (curl/fetch), Playwright without Opensteer, or static file downloads."
argument-hint: "[goal]"
---

# Opensteer

Opensteer controls a real Chromium browser through persistent workspaces. It has three capabilities: (1) DOM automation and structured data extraction from rendered pages, (2) network request capture and replay for reverse-engineering APIs, and (3) browser and workspace administration. Workspaces persist browser state, DOM/extraction descriptors, network history, request plans, recipes, and artifacts under `.opensteer/workspaces/<id>`.

## Task Triage

If invoked directly, treat `$ARGUMENTS` as the goal. **Before taking any action, walk through these gates in order:**

**GATE 1:** Is the deliverable a replayable request plan, custom API endpoint, or lower-overhead API call?
Signals: the user mentions API, endpoint, request, network traffic, reverse-engineer, replay, or the deliverable is a replayable request rather than page content.
**YES** → Load [Request Plan Pipeline](references/request-workflow.md). Start by opening the page with `captureNetwork` on navigation, then query captured traffic. Do NOT start with a DOM snapshot.

**GATE 2:** Is the deliverable structured data from a rendered page, or a browser automation flow?
Signals: the user mentions scraping page content, filling forms, clicking through a flow, extracting visible data, or the deliverable is structured data from the rendered page.
**YES** → Load [CLI Reference](references/cli-reference.md). Start with `snapshot action` or `snapshot extraction`.

**GATE 3:** Is the task browser or workspace administration?
Signals: the user mentions cloning a profile, managing browser state, attaching to a running browser, checking workspace status.
**YES** → Load [CLI Reference](references/cli-reference.md) (Browser Lifecycle) or [SDK Reference](references/sdk-reference.md) (Browser Admin).

**GATE 4:** Unsure. Open the page with `captureNetwork` on `goto`. Query traffic with `queryNetwork()`.
- If relevant JSON APIs appear → go to GATE 1 (request plan path).
- If the data is server-rendered HTML with no backing API → go to GATE 2 (DOM path).

## Deliverables

Each workflow has a specific deliverable. Verify you have produced it before closing the browser.

- **Request Plan Pipeline:** A persisted request plan (`key` + `version`) that returns valid data via `request.execute`. `rawRequest()` is a diagnostic probe used during the pipeline — it is never the deliverable.
- **DOM Extraction:** A persisted extraction descriptor replayable via `extract --description`.
- **Administration:** Confirmation of the browser/workspace state change.

## References

**Load the relevant reference(s) for your task before taking action.**

- [CLI Reference](references/cli-reference.md) — DOM exploration, snapshots, extraction, browser lifecycle, profile cloning
- [SDK Reference](references/sdk-reference.md) — TypeScript code for DOM automation, request capture, and browser admin. Use when the task requires a reusable script.
- [Request Plan Pipeline](references/request-workflow.md) — Gated phases: capture, discover, probe, infer plan, validate auth, annotate parameters, test plan, auth recipes

## Startup Checks

- Verify `opensteer` is available in the repo or on `PATH` before planning the workflow.
- If Chromium binaries are missing, install them through Playwright before debugging page behavior.
- Reuse an existing workspace id for the same site or feature when one already exists.

## Exploration First

Always explore with the CLI before writing automation scripts. Exploration looks different depending on the task:

- **DOM tasks:** use `snapshot action` / `snapshot extraction` to understand the page structure. Read the `html` field — it contains a filtered DOM with inline `c="N"` attributes marking every element. Use those `c` values as `element` numbers in commands and schemas.
- **Request tasks:** use `captureNetwork` on navigation/actions, then `queryNetwork()` to inspect the captured traffic. Probe discovered APIs with `rawRequest()` (diagnostic only), then infer and test plans.
- Only write a reusable SDK script if the user asks for one. CLI exploration is often the entire task.
- Always close the browser when done: `opensteer close --workspace <id>`.

## Request Constraints

- `captureNetwork` is opt-in and is NOT supported on `open()`. Use `open()` to launch the browser, then `goto({ url, captureNetwork })` to navigate with capture.
- `rawRequest` headers must be `[{name, value}]` arrays, not `{key: value}` objects.
- `rawRequest` body must be `{json: {...}}`, `{text: "..."}`, or `{base64: "..."}` — not raw strings.
- After inferring a plan, always validate the auth classification (Phase 5 in the pipeline). Inferred auth metadata is often wrong for public APIs.

## DOM Constraints

- `persistAsDescription` requires the verbose `opensteer run dom.*` syntax. The short CLI commands (`click`, `input`, etc.) do NOT support it.
- Extraction schemas are **literal**: N template rows in → exactly N rows back. Replay with `description` alone (no schema) to get ALL matching rows via the saved generalized selector.
- Prefer Opensteer surfaces (`extract()`, descriptors, `captureNetwork`) over raw Playwright / `page.evaluate()` so data stays in the workspace.

## Common Mistakes

- Parsing the `counters` array instead of reading the `html` string from snapshots. Read the HTML — find `c="N"` values.
- Using `page.evaluate()` or CSS selectors when `extract()` can express the output.
- Forgetting to re-snapshot after navigation. Always re-snapshot before targeting new elements.
- Leaving the browser running after task completion. Always run `opensteer close` when done.
- Do not use removed surfaces: `--name`, `Opensteer.attach()`, cloud/profile-sync helpers, `local-profile`, legacy snapshot browser modes, `@opensteer/engine-abp`.
