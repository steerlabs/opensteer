# Opensteer Electron Recipes

## Launch Commands

Relaunch the app with a debugging port before connecting.

```bash
# macOS
open -a "Slack" --args --remote-debugging-port=9222
open -a "Visual Studio Code" --args --remote-debugging-port=9223
open -a "Discord" --args --remote-debugging-port=9224

# Linux
slack --remote-debugging-port=9222
code --remote-debugging-port=9223
discord --remote-debugging-port=9224

# Windows (PowerShell examples)
"$env:LOCALAPPDATA\slack\slack.exe" --remote-debugging-port=9222
"$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" --remote-debugging-port=9223
```

Optional health check:

```bash
curl -s http://127.0.0.1:9222/json/version
```

## Connect and Select Target

```bash
opensteer open --cdp-url http://127.0.0.1:9222 --session electron --name electron
opensteer tabs --session electron
opensteer tab-switch 0 --session electron
opensteer snapshot action --session electron
```

If the wrong content appears, iterate with `tab-switch` and `snapshot action` until you reach the correct window/webview.

## Navigation and Interaction

```bash
opensteer snapshot action --session electron
opensteer click 11 --description "left sidebar channel" --session electron
opensteer input 7 "deployment notes" --pressEnter --description "search input" --session electron
opensteer press Enter --session electron
opensteer screenshot electron-state.png --session electron
```

## Structured Data Extraction

```bash
# Inspect extraction-focused DOM
opensteer snapshot extraction --session electron

# Build schema from observed counters
opensteer extract '{"items":[{"title":{"element":15},"meta":{"element":16}}]}' \
  --description "visible item list with metadata" \
  --session electron
```

## Multi-App Pattern

```bash
# Slack
opensteer open --cdp-url http://127.0.0.1:9222 --session slack --name slack-electron

# VS Code
opensteer open --cdp-url http://127.0.0.1:9223 --session vscode --name vscode-electron

opensteer snapshot action --session slack
opensteer snapshot action --session vscode
```

## Troubleshooting

- `connection refused`:
  - App was not launched with `--remote-debugging-port`.
  - Port is wrong or blocked by another process.
- Empty or incorrect snapshot:
  - You are in the wrong target window; use `tabs` and `tab-switch`.
  - The app has not finished rendering; wait briefly and snapshot again.
- Counter failures (`element not found`):
  - UI changed and counters are stale; take a fresh `snapshot action`.
- Wrong selectors on replay:
  - `--description` string differs from the original text; use exact wording.
- Connection works but extraction returns empty:
  - The Electron app may render in a webview. Use `opensteer tabs` + `opensteer tab-switch` to find the correct target.
