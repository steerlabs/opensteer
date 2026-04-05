---
name: recorder
description: "Records live browser interaction flows and generates deterministic TypeScript replay scripts with the Opensteer SDK. Use when the user wants to record a manual browser session, capture a workflow for replay, or turn browsing into reusable Opensteer code."
argument-hint: "[url]"
---

# Recorder

The recorder opens a headed local Playwright browser, captures DOM-level user actions, and writes a replayable TypeScript script to the workspace.

## When To Use

- Record a real browser flow for later replay.
- Turn a manual QA walkthrough into Opensteer SDK code.
- Capture a multi-tab browsing session as a starting point for automation.

## CLI

```bash
opensteer record --workspace <id> --url <url>
opensteer record --workspace <id> --url <url> --output <path>
```

- Recording requires `provider=local`.
- Recording requires `engine=playwright`.
- Recording always uses a headed persistent browser for the target workspace.
- Stop recording with `Ctrl+C`.

## Output

- Default output path: `.opensteer/workspaces/<id>/recorded-flow.ts`
- The generated script imports `Opensteer` from `opensteer`.
- Replay uses public SDK methods such as `open`, `goto`, `click`, `input`, `scroll`, `newPage`, `closePage`, `activatePage`, and `evaluate`.

## Notes

- v1 records top-frame DOM interactions and tab lifecycle events.
- Some browser-native gestures are approximated in replay when the public SDK does not expose a direct primitive.
- Review and edit the generated script before committing it to a long-lived automation workflow.

## References

- [Recorder Reference](references/recorder-reference.md)
- [Opensteer SDK Reference](../opensteer/references/sdk-reference.md)
