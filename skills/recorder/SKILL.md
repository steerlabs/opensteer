---
name: recorder
description: Use when the user wants to record a live browser workflow and turn it into a replayable Opensteer script. Prefer this for manual browser capture, multi-tab recording, and record-then-rerun workflows with the Opensteer CLI.
argument-hint: "[url]"
---

# Recorder

Use the Opensteer recorder when the user wants to perform a real browser flow manually and save it as a deterministic replay script.

## Inputs

- `url`: starting URL to open
- `workspace`: target Opensteer workspace id
- `provider`: `local` or `cloud`
- optional `output`: explicit output path

## Quick Start

Local recording:

```bash
opensteer record --workspace <id> --url <url>
```

Cloud recording:

```bash
opensteer record --provider cloud --workspace <id> --url <url>
```

Cloud recording requires:

- `OPENSTEER_BASE_URL`
- `OPENSTEER_API_KEY`
- `OPENSTEER_CLOUD_APP_BASE_URL`

## Mode Selection

- Use `provider=local` when the user wants to interact with a local Playwright browser window.
- Use `provider=cloud` when the user wants to interact through the cloud browser session UI.
- Keep local recording on the default headed persistent browser flow.
- In cloud mode, do not force `headless=false`. Use the normal cloud launch behavior unless the user explicitly overrides it.

## Workflow

1. Start the recorder with `opensteer record`.
2. If the provider is `cloud`, give the user the browser session URL printed by the CLI.
3. Tell the user to perform the workflow manually.
4. Tell the user exactly how to stop:
   - local: click the injected `Stop recording` button in the browser page
   - cloud: click `Stop recording` in the browser session toolbar UI
5. Wait for the recorder process to finish. Do not assume recording is complete just because the browser URL was printed.
6. Only after the CLI exits, read the generated script from disk and inspect what was captured.
7. If the user wants verification, rerun the generated script instead of only reviewing the file.

## Guardrails

- Recording requires `engine=playwright`.
- Local recording only supports a persistent browser.
- Local recording requires a headed browser. Do not pass `--headless true` in local mode.
- Cloud recording does not support `browser.mode="attach"`.
- Do not stop recording with `Ctrl+C` unless the user explicitly wants to abort the run.
- Do not use removed timeout flags such as `--record-timeout-ms`.
- If a launch argument value starts with `--`, pass it as `--arg=...`, not `--arg ...`.
- If the flow depends on recorder limits such as iframes, file upload, drag-and-drop, or canvas behavior, read the reference file before promising support.

## Output Contract

- Default output path: `.opensteer/workspaces/<id>/recorded-flow.ts`
- The CLI writes the replay script locally after recording completes in both local and cloud modes.
- Generated scripts use the public Opensteer SDK surface. Cloud recordings bootstrap `provider.mode = "cloud"` and local recordings bootstrap the workspace-backed local flow.

## Agent Guidance

- Keep the `record` command alive while the user is recording.
- If the user is actively driving the session, avoid mixing in extra agent actions unless they explicitly ask for help recording a combined flow.
- After recording completes, summarize the captured flow before editing it.
- If replay fails, debug the generated script and rerun it instead of re-recording immediately.

## References

- [Recorder Reference](references/recorder-reference.md)
- [Opensteer Skill](../opensteer/SKILL.md)
