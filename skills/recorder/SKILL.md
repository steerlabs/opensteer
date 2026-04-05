---
name: recorder
description: "Use when the user wants to record a live browser workflow and turn it into a deterministic Opensteer replay script. Prefer this for manual browser capture, multi-tab flow recording, and agent-guided record-and-replay setup with the Opensteer CLI."
argument-hint: "[url]"
---

# Recorder

Use the Opensteer recorder to open a headed local Playwright browser, capture DOM-level actions, and write a replayable TypeScript script.

## When to use

- Record a real browser flow for later replay.
- Turn a manual QA walkthrough into Opensteer SDK code.
- Capture a multi-tab browsing session as a starting point for automation.

## Quick start

```bash
opensteer record --workspace <id> --url <url>
opensteer record --workspace <id> --url <url> --output <path>
```

1. Start recording with `opensteer record --workspace <id> --url <url>`.
2. Perform the workflow in the headed browser.
3. Stop recording with the injected `Stop recording` button in the browser.
4. Wait for the CLI to write the script path and close the browser session.
5. Inspect the generated file before replaying or editing it.

## Guardrails

- Recording requires `provider=local`.
- Recording requires `engine=playwright`.
- Recording always uses a headed persistent browser for the target workspace.
- Stopping is browser-driven. Do not rely on `Ctrl+C` or removed timeout flags.
- If a launch argument value starts with `--`, pass it as `--arg=...`, not `--arg ...`.

## Output

- Default output path: `.opensteer/workspaces/<id>/recorded-flow.ts`
- The generated script imports `Opensteer` from `opensteer`.
- Replay uses public SDK methods such as `open`, `goto`, `click`, `input`, `scroll`, `newPage`, `closePage`, `activatePage`, and `evaluate`.

## Agent workflow

- Use the browser stop button as the primary stop path.
- After recording, read the generated script and summarize what was captured before changing it.
- If the user asks for replay verification, run the generated script instead of only inspecting the file.
- If the flow depends on recorder limits such as iframes or file upload, read the reference file before promising support.

## References

- [Recorder Reference](references/recorder-reference.md)
- [Opensteer SDK Reference](../opensteer/references/sdk-reference.md)
