---
name: opensteer
description: "Handles Opensteer browser automation, structured DOM extraction, and browser-backed request replay with the Opensteer CLI and SDK. Use when the user mentions Opensteer, browser automation, real Chromium sessions, persistent workspace browser state, descriptor-backed DOM actions or extraction, request plans, recipes, or browser-backed API replay."
argument-hint: "[goal]"
---

# Opensteer

Opensteer controls a real Chromium browser through persistent workspaces. It has three capabilities: (1) DOM automation and structured data extraction from rendered pages, (2) network request capture and replay for reverse-engineering APIs, and (3) browser and workspace administration. Workspaces persist browser state, DOM/extraction descriptors, network history, request plans, recipes, and artifacts under `.opensteer/workspaces/<id>`.

## Task Triage

If invoked directly, treat `$ARGUMENTS` as the goal. **Before taking any action, classify the task:**

**Request capture / API reverse-engineering.** Signals: the user mentions API, endpoint, request, network traffic, reverse-engineer, replay, or the deliverable is a replayable request rather than page content. Load the [Request Workflow](references/request-workflow.md) reference. Start by opening the page with `captureNetwork` on navigation, then query captured traffic with `queryNetwork()`. Do NOT start with a DOM snapshot.

**DOM automation / data extraction.** Signals: the user mentions scraping page content, filling forms, clicking through a flow, extracting visible data, or the deliverable is structured data from the rendered page. Load the [CLI Reference](references/cli-reference.md). Start with `snapshot action` or `snapshot extraction` to understand the page structure before acting.

**Browser / workspace administration.** Signals: the user mentions cloning a profile, managing browser state, attaching to a running browser, checking workspace status. Load the [CLI Reference](references/cli-reference.md) (Browser Lifecycle section) or the [SDK Reference](references/sdk-reference.md) (Browser Admin section).

**When unsure:** Open the page with `captureNetwork` on the `goto` action. Check `queryNetwork()`. If relevant JSON APIs appear, follow the request capture path. If the data is server-rendered HTML with no backing API, follow the DOM extraction path.

## References

**Load the relevant reference(s) for your task before taking action.**

- [CLI Reference](references/cli-reference.md) — DOM exploration, snapshots, extraction, browser lifecycle, profile cloning
- [SDK Reference](references/sdk-reference.md) — TypeScript code for DOM automation, request capture, and browser admin. Use when the task requires a reusable script.
- [Request Workflow](references/request-workflow.md) — `captureNetwork`, `queryNetwork`, transport probing, request plans, auth tokens, recipes

## Startup Checks

- Verify `opensteer` is available in the repo or on `PATH` before planning the workflow.
- If Chromium binaries are missing, install them through Playwright before debugging page behavior.
- Reuse an existing workspace id for the same site or feature when one already exists.

## Exploration First

Always explore with the CLI before writing automation scripts. Exploration looks different depending on the task:

- **DOM tasks:** use `snapshot action` / `snapshot extraction` to understand the page structure. Read the `html` field — it contains a filtered DOM with inline `c="N"` attributes marking every element. Use those `c` values as `element` numbers in commands and schemas.
- **Request tasks:** use `captureNetwork` on navigation/actions, then `queryNetwork()` to inspect the captured traffic. Probe discovered APIs with `rawRequest()`.
- Only write a reusable SDK script if the user asks for one. CLI exploration is often the entire task.
- Always close the browser when done: `opensteer close --workspace <id>`.

## Key Constraints

- `persistAsDescription` requires the verbose `opensteer run dom.*` syntax. The short CLI commands (`click`, `input`, etc.) do NOT support it.
- Extraction schemas are **literal**: N template rows in → exactly N rows back. Replay with `description` alone (no schema) to get ALL matching rows via the saved generalized selector.
- `captureNetwork` is opt-in and is NOT supported on `open()`. Use `open()` to launch the browser, then `goto({ url, captureNetwork })` to navigate with capture.
- Prefer Opensteer surfaces (`extract()`, descriptors, `captureNetwork`) over raw Playwright / `page.evaluate()` so data stays in the workspace.
- Do not use removed surfaces: `--name`, `Opensteer.attach()`, cloud/profile-sync helpers, `local-profile`, legacy snapshot browser modes, `@opensteer/engine-abp`.

## Common Mistakes

- Parsing the `counters` array instead of reading the `html` string from snapshots. Read the HTML — find `c="N"` values.
- Using `page.evaluate()` or CSS selectors when `extract()` can express the output.
- Forgetting to re-snapshot after navigation. Always re-snapshot before targeting new elements.
- Skipping transport probing — always test `direct-http` before assuming browser session is needed.
- `rawRequest` headers must be `[{name, value}]` arrays, not `{key: value}` objects.
- `rawRequest` body must be `{json: {...}}`, `{text: "..."}`, or `{base64: "..."}` — not raw strings.
- Leaving the browser running after task completion. Always run `opensteer close` when done.
