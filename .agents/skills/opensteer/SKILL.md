---
name: opensteer
description: "Handles Opensteer browser automation, structured DOM extraction, browser-backed network discovery, and session-aware API replay. Use when the user mentions Opensteer, browser automation, real Chromium sessions, persistent workspace browser state, captureNetwork, replay, or reverse-engineering a site API."
argument-hint: "[goal]"
---

# Opensteer

Opensteer is for the browser tasks normal code cannot replace:

1. Capture real browser traffic from real browser actions.
2. Inspect captured requests in short summaries.
3. Replay requests with browser-grade transports.
4. Read browser cookies, storage, and page state.
5. Turn the result into plain TypeScript with `session.fetch()`.

## Task Triage

**GATE 1:** Is the task about APIs, network traffic, replay, auth headers, GraphQL, or reverse engineering?
**YES** -> Load [Request Workflow](references/request-workflow.md). Start with a real browser action that uses `captureNetwork`.

**GATE 2:** Is the task about visible page content, clicking, typing, forms, or extracting rendered data?
**YES** -> Load [CLI Reference](references/cli-reference.md). Start with `snapshot action` or `snapshot extraction`.

**GATE 3:** Is the task browser or workspace administration?
**YES** -> Load [CLI Reference](references/cli-reference.md) or [SDK Reference](references/sdk-reference.md).

**GATE 4:** Unsure.
Capture first, then inspect with `network query`.

## Deliverables

- **API tasks:** working TypeScript using `session.fetch()` or other SDK primitives.
- **DOM tasks:** a working CLI or SDK flow using persisted targets.
- **Admin tasks:** confirmation that browser or workspace state changed.

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
- `captureNetwork` is opt-in.

## Default Loop

1. Open the page.
2. Trigger the real browser action with `captureNetwork`.
3. Scan with `network query`.
4. Inspect one record with `network detail`.
5. Test it with `replay`.
6. Read `cookies`, `storage`, or `state` if auth or dynamic state matters.
7. Write the final TypeScript.

## References

- [CLI Reference](references/cli-reference.md)
- [SDK Reference](references/sdk-reference.md)
- [Request Workflow](references/request-workflow.md)

## Common Mistakes

- Starting an API task with `snapshot` instead of `captureNetwork`.
- Reaching for raw Playwright before using captured traffic and browser state.
- Forgetting to re-snapshot after navigation before using new element numbers.
- Treating `network query` output like a final artifact instead of the next decision input.
