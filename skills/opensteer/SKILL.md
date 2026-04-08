---
name: opensteer
description: "Handles Opensteer browser automation, structured DOM extraction, browser-backed network discovery, and session-aware API replay. Use when the user mentions Opensteer, browser automation, real Chromium sessions, persistent workspace browser state, captureNetwork, replay, or reverse-engineering a site API."
argument-hint: "[goal]"
---

# Opensteer

Opensteer is for the small set of browser tasks normal code cannot replace:

1. Capture real browser traffic from real browser actions.
2. Inspect captured requests in short agent-friendly summaries.
3. Replay requests with browser-grade transports.
4. Read browser cookies, storage, and page state.
5. Turn the result into plain TypeScript with `session.fetch()`.

## Task Triage

Walk through these gates before acting:

**GATE 1:** Is the task about understanding, validating, or calling an API?
Signals: API, endpoint, network traffic, reverse engineering, auth headers, GraphQL, replay, cookies, request chains.
**YES** -> Load [Request Workflow](references/request-workflow.md). Start with a real browser action that uses `captureNetwork`.

**GATE 2:** Is the task about rendered content, page automation, or extracting visible data?
Signals: forms, buttons, pagination, visible content, structured page data.
**YES** -> Load [CLI Reference](references/cli-reference.md). Start with `snapshot action` or `snapshot extraction`.

**GATE 3:** Is the task browser or workspace administration?
Signals: clone/reset/delete browser state, attach, workspace status, record flow.
**YES** -> Load [CLI Reference](references/cli-reference.md) or [SDK Reference](references/sdk-reference.md).

**GATE 4:** Unsure.
Capture first, then inspect with `network query`.

- If the useful data is in JSON traffic -> follow GATE 1.
- If the useful data is rendered directly in the DOM -> follow GATE 2.

## Deliverables

- **API tasks:** working TypeScript that uses `session.fetch()` or a small amount of SDK code.
- **DOM tasks:** a working CLI workflow or reusable SDK flow using persisted targets.
- **Admin tasks:** confirmation that the workspace or browser state changed as requested.

Do not treat a snapshot dump or a one-off replay as the final artifact when the user asked for reusable code.

## Core Rules

- Use `--workspace <id>` or `OPENSTEER_WORKSPACE` for stateful commands.
- The CLI is positional and scoped:
  - `click <element>`
  - `input <element> <text>`
  - `scroll <direction> <amount>`
  - `extract <description>`
  - `cookies [domain]`
  - `storage [domain]`
  - `state [domain]`
- Persist DOM action paths with `--persist <name>` on CLI or `persist` in the SDK.
- Use `description` only for extraction descriptors.
- Do not use `opensteer run`, `--input-json`, `--description` target flags, `--schema-json`, or `--name`.
- `captureNetwork` is opt-in. Add it to `goto`, DOM actions, or `computer` actions when you need traffic.

## Default Discovery Loop

1. Open the page.
2. Trigger the real browser action with `captureNetwork`.
3. Scan with `network query`.
4. Inspect one record with `network detail`.
5. Test it with `replay`.
6. Read `cookies`, `storage`, or `state` if auth or dynamic page state matters.
7. Write the final TypeScript.

## References

- [CLI Reference](references/cli-reference.md)
- [SDK Reference](references/sdk-reference.md)
- [Request Workflow](references/request-workflow.md)

## Startup Checks

- Verify `opensteer` is available in the repo or on `PATH`.
- Reuse the same workspace for the same site or feature when possible.
- Install Chromium through Playwright if browser binaries are missing.

## Common Mistakes

- Starting an API task with `snapshot` instead of `captureNetwork`.
- Treating `network query` output like raw logs instead of a shortlist for the next decision.
- Reaching for raw Playwright before using captured traffic and browser state.
- Forgetting to re-snapshot after navigation before using new element numbers.
- Leaving the workspace browser open when the task is done.
