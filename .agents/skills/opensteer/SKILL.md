---
name: opensteer
description: "Handles Opensteer browser automation, structured DOM extraction, browser-backed network discovery, and session-aware API replay. Use when the user mentions Opensteer, browser automation, real Chromium sessions, persistent workspace browser state, descriptor-backed DOM actions or extraction, request capture, replay, or reverse-engineering a site API."
argument-hint: "[goal]"
---

# Opensteer

Opensteer gives agents a real browser workspace plus a small set of tools the model cannot replace with ordinary code:

1. Capture real browser traffic from real browser actions.
2. Inspect captured requests in agent-friendly summaries.
3. Replay requests with browser-grade transports.
4. Read browser cookies, storage, and page state.
5. Turn the result into plain TypeScript with `session.fetch()`.

The framework should stay close to what agents already understand: HTTP, JSON, cookies, headers, and code.

## Task Triage

Walk through these gates before acting:

**GATE 1:** Is the task about understanding, reverse-engineering, validating, or calling an API?
Signals: the user mentions API, endpoint, network traffic, reverse engineering, replay, auth headers, GraphQL, cookies, request chains, or lower-overhead access than DOM extraction.
**YES** -> Load [Discovery Workflow](references/request-workflow.md). Start with a browser action that uses `captureNetwork`. Do not start with a DOM snapshot unless the API depends on page state you need to inspect.

**GATE 2:** Is the task about rendered content, page automation, clicking through a flow, or extracting visible data?
Signals: the user wants page content, forms, button clicks, pagination, or structured data from the rendered page.
**YES** -> Load [CLI Reference](references/cli-reference.md). Start with `snapshot action` or `snapshot extraction`.

**GATE 3:** Is the task browser or workspace administration?
Signals: clone/reset/delete browser state, attach, workspace status, browser status, profile setup.
**YES** -> Load [CLI Reference](references/cli-reference.md) or [SDK Reference](references/sdk-reference.md) and use the browser lifecycle tools.

**GATE 4:** Unsure.
Open the page, navigate with `captureNetwork`, and inspect with `network query`.

- If the useful data comes from JSON/API traffic -> follow GATE 1.
- If the useful data is rendered directly in the DOM -> follow GATE 2.

## Deliverables

- **API discovery:** working TypeScript that uses `session.fetch()` or other session primitives. The code is the artifact.
- **DOM extraction / automation:** a working script or descriptor-backed workflow.
- **Administration:** confirmation that the workspace/browser state changed as requested.

Do not treat raw captures, snapshots, or a one-off replay as the final artifact when the user asked for reusable code.

## Core Discovery Tools

These are the main tools for API work:

- `goto`, `click`, `input`, `hover`, `scroll` with `captureNetwork`
- `network query` to scan traffic
- `network detail <recordId>` to inspect one request deeply
- `replay <recordId>` to test the captured request
- `cookies [--domain]`
- `storage [--domain]`
- `state [--domain]`
- `session.fetch()` in SDK code

Use them in this order by default:

1. Capture traffic.
2. `network query`
3. `network detail`
4. `replay`
5. `cookies` / `storage` / `state` when auth or dynamic state matters
6. Write TypeScript with `session.fetch()`

## References

- [CLI Reference](references/cli-reference.md)
- [SDK Reference](references/sdk-reference.md)
- [Discovery Workflow](references/request-workflow.md)

## Startup Checks

- Verify `opensteer` is available in the repo or on `PATH`.
- Reuse the same workspace for the same site or feature when possible.
- Install Chromium through Playwright if the runtime is missing browser binaries.

## Exploration First

Always explore through Opensteer before writing custom browser code.

- **API tasks:** use `captureNetwork`, then `network query` / `network detail` / `replay`.
- **DOM tasks:** use `snapshot action` / `snapshot extraction`, then `click`, `input`, `extract`.
- Prefer Opensteer surfaces over raw Playwright or ad hoc proxies so captured evidence stays in the workspace.
- Close the browser when done: `opensteer close --workspace <id>`.

## Important Constraints

- `captureNetwork` is opt-in. Add it to `goto`, `click`, `input`, `hover`, or `scroll` when you need traffic.
- `browser status` intentionally does not expose the raw browser websocket endpoint.
- `network query` is for scanning. Use `network detail` for full headers/body previews.
- `replay` automatically tries the transport ladder. Read which transport succeeded before hard-coding one.
- `session.fetch()` includes browser cookies by default and can auto-select transport.

## Common Mistakes

- Starting an API task with `snapshot` and concluding the tool is DOM-only.
- Bypassing Opensteer with raw Playwright or a custom proxy instead of using captured traffic and replay.
- Keeping legacy plan/recipe mental models. The deliverable is code, not a registry entry.
- Dumping full raw network JSON into context instead of using the filtered summary/detail views.
- Forgetting to inspect cookies, storage, or hidden fields when a replay returns 401/403.
