---
name: "recorder"
description: "Use when the user wants to record a live browser workflow and turn it into a replayable Opensteer script. Prefer this for manual browser capture, multi-tab recording, and record-then-rerun workflows with the Opensteer CLI."
---

# Recorder

Record a real browser flow performed manually by the user and save it as a deterministic replay script. Do not use this when the user wants programmatic browser automation without manual recording — use the `opensteer` skill instead.

## Prerequisites

Verify the CLI is available:

```bash
command -v opensteer >/dev/null 2>&1 && echo "ok" || echo "opensteer not found"
```

For cloud recording, verify environment variables are set:

```bash
test -n "$OPENSTEER_BASE_URL" && test -n "$OPENSTEER_API_KEY" && test -n "$OPENSTEER_CLOUD_APP_BASE_URL" && echo "ok" || echo "missing cloud env vars"
```

## Quick Start

Local recording:

```bash
opensteer record --workspace <id> --url <url>
```

Cloud recording:

```bash
opensteer record --provider cloud --workspace <id> --url <url>
```

## Mode Selection

- Use `provider=local` when the user wants to interact with a local Playwright browser window. Local requires a headed, persistent browser. Do not pass `--headless true`.
- Use `provider=cloud` when the user wants to interact through the cloud browser session UI. Do not force `headless=false` in cloud mode. Cloud does not support `browser.mode="attach"`.

## Workflow

1. Run `opensteer record --workspace <id> --url <url>` (add `--provider cloud` for cloud).
2. If cloud, give the user the browser session URL printed by the CLI.
3. Tell the user to perform the workflow manually.
4. Tell the user exactly how to stop:
   - Local: click the injected **Stop recording** button in the browser page.
   - Cloud: click **Stop recording** in the browser session toolbar UI.
5. Keep the `record` command alive while the user is recording. Do not interrupt it. Do not stop with `Ctrl+C` unless the user explicitly wants to abort.
6. Wait for the CLI process to exit. Do not assume recording is complete just because the browser URL was printed.
7. Verify the output file exists at `.opensteer/workspaces/<id>/recorded-flow.ts` (or the `--output` path if specified).
8. Read and summarize the generated script before editing it.
9. If the user wants verification, replay the script: `npx tsx <path-to-recorded-flow.ts>`.

## Limitations

The recorder captures clicks, text entry, key presses, scrolling, select changes, navigation, and multi-tab operations. It does not fully support:

- Cross-origin iframes (not recorded)
- Shadow DOM selectors (best effort)
- File uploads, drag-and-drop, and canvas interactions
- Browser back/forward detection (may fall back to direct navigation replay)

## Rules

- Recording requires `engine=playwright`.
- Do not use removed timeout flags such as `--record-timeout-ms`.
- If a launch argument value starts with `--`, pass it as `--arg=...`, not `--arg ...`.
- Do not mix in extra agent actions while the user is recording unless they explicitly ask.
- If replay fails, debug and fix the generated script rather than re-recording immediately.

## Troubleshooting

- **Recorder fails to start**: verify the workspace ID is valid and the browser engine is playwright.
- **CLI exits with an error**: read stderr for the error message before retrying.
- **Generated script has errors**: inspect and fix the script rather than re-recording.
- **Output file missing**: check if the user stopped recording correctly (button click, not Ctrl+C).
