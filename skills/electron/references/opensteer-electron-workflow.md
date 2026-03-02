# Opensteer Electron Workflow

This document describes the Opensteer-native flow for automating Electron apps.

## 1. Connection Model

Electron apps embed Chromium. Opensteer connects through Chrome DevTools Protocol (CDP):

- Launch app with `--remote-debugging-port=<port>`
- Attach with `opensteer open --connect-url http://127.0.0.1:<port>`

Example:

```bash
opensteer open --connect-url http://127.0.0.1:9222 --session electron --name electron
```

`--session` controls runtime routing (which daemon/browser instance handles commands).
`--name` controls selector cache namespace for deterministic replay.

## 2. Window/Webview Targeting

Electron apps often expose multiple targets. After connecting:

```bash
opensteer tabs --session electron
opensteer tab-switch 0 --session electron
opensteer snapshot action --session electron
```

Iterate `tab-switch` + `snapshot action` until you are on the correct app window/webview.

## 3. Action Loop

Use this loop for all interactions:

1. `snapshot action`
2. `click` / `input` / `press`
3. re-run `snapshot action`

Example:

```bash
opensteer snapshot action --session electron
opensteer click 10 --description "navigation item" --session electron
opensteer input 6 "release checklist" --pressEnter --description "search input" --session electron
opensteer snapshot action --session electron
```

## 4. Extraction Loop

For structured data:

1. `snapshot extraction`
2. build schema from element counters
3. `extract <schema-json>`

Example:

```bash
opensteer snapshot extraction --session electron
opensteer extract '{"rows":[{"title":{"element":14},"status":{"element":15}}]}' \
  --description "current visible rows with status" \
  --session electron
```

## 5. Replay Stability

- Keep `--name` stable for the same automation namespace.
- Keep `--description` text exact across runs.
- Re-snapshot after meaningful UI changes before reusing counters.

## 6. Session Cleanup

Close the session when done:

```bash
opensteer close --session electron
```

Or list active sessions:

```bash
opensteer sessions
```
