---
name: electron
description: "Automate Electron desktop apps (Slack, VS Code, Discord, Notion, and other Chromium-based desktop apps) with Opensteer by connecting to a running Chrome DevTools endpoint. Use when tasks require interacting with Electron UI, testing desktop app workflows, extracting structured data from app windows, or capturing Electron screenshots."
---

# Electron App Automation with Opensteer

Use this skill when a task targets an Electron desktop app instead of a normal browser tab.

Read [opensteer-electron-workflow.md](references/opensteer-electron-workflow.md) first for the Opensteer connection model and execution flow.

## Core Workflow

1. Launch the Electron app with `--remote-debugging-port=<port>`.
2. Connect Opensteer with `open --connect-url http://127.0.0.1:<port>`.
3. List windows/webviews with `tabs`, then switch with `tab-switch`.
4. Run `snapshot action`, interact (`click`, `input`, `press`), then re-snapshot.
5. Use `snapshot extraction` and `extract` for structured data.

```bash
# Connect Opensteer to a running Electron app on port 9222
opensteer open --connect-url http://127.0.0.1:9222 --session slack-desktop --name slack-desktop

# Discover available windows/webviews
opensteer tabs --session slack-desktop
opensteer tab-switch 0 --session slack-desktop

# Standard action loop
opensteer snapshot action --session slack-desktop
opensteer click 12 --session slack-desktop
opensteer input 8 "release notes" --pressEnter --session slack-desktop
opensteer snapshot action --session slack-desktop
```

## Launching Electron Apps

If the app is already running, quit it first, then relaunch with the debugging flag.

```bash
# macOS examples
open -a "Slack" --args --remote-debugging-port=9222
open -a "Visual Studio Code" --args --remote-debugging-port=9223
open -a "Discord" --args --remote-debugging-port=9224

# Linux examples
slack --remote-debugging-port=9222
code --remote-debugging-port=9223
discord --remote-debugging-port=9224
```

## Structured Extraction Pattern

```bash
opensteer snapshot extraction --session slack-desktop

opensteer extract '{"channels":[{"name":{"element":21},"unread":{"element":22}}]}' \
  --description "sidebar channels with unread state" \
  --session slack-desktop
```

Use `--description` when possible so selector paths persist for replay.

## Multiple Apps at Once

Use one Opensteer session per app:

```bash
opensteer open --connect-url http://127.0.0.1:9222 --session slack --name slack-electron
opensteer open --connect-url http://127.0.0.1:9223 --session vscode --name vscode-electron

opensteer snapshot action --session slack
opensteer snapshot action --session vscode
```

## Guardrails

- Prefer Opensteer commands over raw Playwright for interaction/extraction.
- Re-snapshot after each navigation or large UI change before reusing counters.
- Keep `--name` stable inside a session for deterministic selector replay.
- Close sessions when done: `opensteer close --session <id>`.

## References

- [opensteer-electron-workflow.md](references/opensteer-electron-workflow.md)
- [opensteer-electron-recipes.md](references/opensteer-electron-recipes.md)
