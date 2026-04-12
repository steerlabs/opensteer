---
name: opensteer
description: "Use when the task needs real browser automation, DOM exploration, browser session state, network capture, or browser-backed request replay with Opensteer. The default pattern is: explore with the CLI first, then write the final code with the SDK."
argument-hint: "[goal]"
---

# Opensteer

Opensteer gives AI agents a real Chromium browser — local or cloud. Use it when normal code is not enough because the task depends on a live browser session.

Default workflow:

1. CLI to explore the site and discover behavior.
2. Save stable targets with `persist`.
3. SDK to write the final reusable TypeScript.

Do not stop at manual exploration if the user needs automation.

## Setup

Install the Opensteer skill so the coding agent can use it:

```bash
opensteer skills install
```

This registers the skill with the agent's tool system. Only needed once per environment.

## When To Use

- Real browser session needed (clicks, forms, DOM extraction, navigation).
- Cookies, localStorage, sessionStorage, or auth state involved.
- Reverse-engineering a site API from real browser traffic.
- Browser-backed `fetch()` instead of plain Node HTTP.
- Coordinate-based interaction (canvas, WebGL, hard-to-target UI).
- Need to reuse a real user's logged-in browser profile.

If the user wants to manually drive a browser and record the flow, use the `recorder` skill instead.

## Core Rules

1. Always use a workspace for stateful commands: `--workspace <id>` or `OPENSTEER_WORKSPACE`.
2. Re-snapshot after navigation or big UI changes before reusing element numbers.
3. CLI to discover, SDK for the final implementation.
4. Use `persist` for stable reusable targets and extraction payloads.
5. Use `exec` for SDK code and API experiments. Use `evaluate` only for page-context JavaScript.
6. If `fetch()` fails with auth errors, inspect `state()`, `cookies()`, and `storage()` before changing transport.
7. Keep output simple. Prefer ordinary TypeScript with `Opensteer`, no extra abstraction.
8. Close the browser when done. Do not leave headed browsers running. Use `opensteer browser delete --workspace <id>` or SDK cleanup when the session does not need to stay open.

## Choose A Path

```
What does the task need?
├─ Click, type, navigate, extract visible data → DOM path
├─ Find or replay a site API → Network path
├─ Analyze, deobfuscate, or sandbox page JavaScript → Scripts analysis
├─ Canvas, WebGL, or hard-to-target UI → Computer-use
├─ Work with multiple tabs or popups → Tab management
├─ Set up browser profile, clone, or attach → Browser sessions
├─ Run browser in the cloud → Cloud mode
├─ Watch what a headless browser is doing → Local view
└─ Unsure → start by capturing network traffic
```

## DOM Path

Use this when the goal is clicking, typing, navigating, or extracting visible data.

### CLI exploration

```bash
opensteer open https://example.com --workspace demo
opensteer snapshot action --workspace demo
opensteer input 5 "laptop" --workspace demo --press-enter --persist "search input"
opensteer click 7 --workspace demo --persist "search button"
opensteer snapshot extraction --workspace demo
opensteer extract '{"items":[{"name":{"element":13},"price":{"element":14}}]}' \
  --workspace demo \
  --persist "search results"
```

Element numbers come from `c="N"` markers in the snapshot HTML.

### SDK implementation

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({ workspace: "demo", rootDir: process.cwd() });

await opensteer.open("https://example.com");
await opensteer.input({ persist: "search input", text: "laptop", pressEnter: true });
await opensteer.click({ persist: "search button" });
const data = await opensteer.extract({ persist: "search results" });
```

Use `selector` in SDK code only when a stable CSS selector is cleaner than `persist`.

## Network Path

Use this when the goal is to find or replay a site API.

### CLI exploration

```bash
opensteer open https://example.com --workspace demo
opensteer goto https://example.com/search --workspace demo --capture-network page-load
opensteer input 5 "laptop" --workspace demo --press-enter --capture-network search
opensteer network query --workspace demo --capture search --json
opensteer network detail rec_123 --workspace demo --probe
```

Use `network detail --probe` to learn which transport works.

### Session state checks

```bash
opensteer state example.com --workspace demo
```

```ts
const cookies = await opensteer.cookies("example.com");
const localStorage = await opensteer.storage("example.com", "local");
const sessionStorage = await opensteer.storage("example.com", "session");
const state = await opensteer.state("example.com");
```

### Prove the request with `exec`

```bash
opensteer exec "
  const response = await this.fetch('https://api.example.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keyword: 'laptop', count: 24 }),
  });
  return { status: response.status, data: await response.json() };
" --workspace demo
```

### SDK implementation

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({ workspace: "demo", rootDir: process.cwd() });

export async function search(keyword: string) {
  const response = await opensteer.fetch("https://api.example.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keyword, count: 24 }),
  });
  return response.json();
}
```

Use ordinary `fetch()` syntax. Only set `transport` explicitly if probing showed you need it.

## Scripts Analysis

Use this when you need to understand what JavaScript a page is running — reverse-engineering obfuscated code, finding hidden API calls, or testing script behavior in isolation.

### Capture scripts from the page

```bash
opensteer scripts capture --workspace demo
opensteer scripts capture --workspace demo --url-filter "api" --external --dynamic
```

Flags: `--inline`, `--external`, `--dynamic`, `--workers` to filter by source type. `--persist` to save as an artifact. `--url-filter <pattern>` to match script URLs.

### Beautify and deobfuscate

```bash
# Format minified code
opensteer scripts beautify <artifactId> --workspace demo --persist

# Deobfuscate packed/obfuscated code
opensteer scripts deobfuscate <artifactId> --workspace demo --persist
```

### Sandbox execution

Run captured JavaScript in isolation with controlled inputs:

```bash
opensteer scripts sandbox <artifactId> --workspace demo \
  --fidelity standard \
  --timeout 5000 \
  --cookies '{"session":"abc123"}' \
  --globals '{"window.API_KEY":"test"}' \
  --ajax-routes '[{"url":"*/api/*","response":{"data":[]}}]'
```

Fidelity levels: `minimal` (fast, no DOM), `standard` (basic DOM), `full` (complete browser emulation).

### Typical workflow

```bash
opensteer scripts capture --workspace demo --persist --external
opensteer artifact read art_abc123 --workspace demo          # inspect raw
opensteer scripts beautify art_abc123 --workspace demo --persist
opensteer scripts deobfuscate art_def456 --workspace demo --persist
opensteer scripts sandbox art_ghi789 --workspace demo
```

## Computer-Use

Use this only when DOM targeting is not enough.

```bash
opensteer computer click 245 380 --workspace demo --capture-network action
opensteer computer type "search query" --workspace demo
opensteer computer key Enter --workspace demo
opensteer computer screenshot --workspace demo
```

```ts
await opensteer.computerExecute({
  action: { type: "click", x: 245, y: 380 },
});
```

After coordinate-based actions, switch back to normal extraction or request analysis as soon as possible.

## Tab Management

Use when handling OAuth popups, multi-page flows, or any task that opens new tabs.

```bash
opensteer tab list --workspace demo              # List all open tabs
opensteer tab new https://example.com --workspace demo   # Open new tab
opensteer tab 2 --workspace demo                 # Switch to tab 2
opensteer tab close 3 --workspace demo           # Close tab 3
opensteer tab close --workspace demo             # Close current tab
```

```ts
const tabs = await opensteer.listPages();
await opensteer.newPage("https://example.com");
await opensteer.activatePage(2);
await opensteer.closePage(3);
```

Re-snapshot after switching tabs — element numbers are per-page.

## Browser Sessions

Each workspace has one browser. Three modes:

| Mode                     | What it does                                    | Data persists?                                                        |
| ------------------------ | ----------------------------------------------- | --------------------------------------------------------------------- |
| **Persistent** (default) | Browser tied to workspace, survives restarts    | Yes — cookies, localStorage, logins, history, extensions all retained |
| **Temporary**            | Headless browser in `/tmp`, cleaned up on close | No                                                                    |
| **Attach**               | Connects to an already-running browser via CDP  | Depends on that browser                                               |

### Headless vs headed

Browsers launch headless by default. Use `--headless false` to see the browser window:

```bash
opensteer open https://example.com --workspace demo --headless false
```

Use headed mode for debugging or when the user wants to watch. For hands-free automation, keep headless and use `opensteer view` if a human needs to observe.

### Persistent sessions

When you `opensteer open` with a workspace, the browser's full Chrome user-data directory lives at `~/.opensteer/workspaces/<id>/browser/user-data/`. Everything Chrome normally persists (cookies, localStorage, IndexedDB, history, extensions) survives between runs.

Re-running `opensteer open --workspace demo` reconnects to the existing browser if it's still alive, or launches a fresh one with the same profile if it died.

### Profile cloning

Clone a real user's Chrome profile to start a workspace with their logins already active:

```bash
# Discover available local browsers and profiles
opensteer browser discover

# Clone a profile into a workspace
opensteer browser clone --workspace demo \
  --source-user-data-dir "$HOME/Library/Application Support/Google/Chrome" \
  --source-profile-directory Default
```

This copies cookies, localStorage, extensions, and settings from the source browser. Caches and lock files are skipped. The source browser does not need to be closed — cloning while running is safe.

### Attach to an existing browser

```bash
opensteer open https://example.com --workspace demo --attach-endpoint http://localhost:9222
```

### Workspace lifecycle

```bash
opensteer browser status --workspace demo    # Check if browser is running
opensteer browser reset --workspace demo     # Wipe browser data, keep workspace
opensteer browser delete --workspace demo    # Delete workspace entirely
```

## Cloud Mode

Run the browser on Opensteer's cloud infrastructure instead of locally. Use cloud mode when you need browsers that run 24/7, or when the local machine should not run Chromium.

### Setup

```bash
export OPENSTEER_API_KEY=osk_your_key_here    # Required
export OPENSTEER_PROVIDER=cloud               # Or use --provider cloud per command
```

### Usage

All CLI commands work the same with `--provider cloud`:

```bash
opensteer open https://example.com --workspace demo --provider cloud
opensteer snapshot action --workspace demo
opensteer click 5 --workspace demo
```

### Export local browser profile to cloud

Sync a local browser's cookies to a cloud browser profile so the cloud session starts logged in:

```bash
# Reads cookies from local Chrome, decrypts them, uploads to cloud
opensteer browser clone --workspace demo \
  --source-user-data-dir "$HOME/Library/Application Support/Google/Chrome" \
  --source-profile-directory Default \
  --provider cloud
```

The cookies are extracted from the local SQLite database, decrypted, packaged into a portable format, and uploaded. The cloud browser then starts with those cookies applied.

## Local View

When Opensteer runs headless, a human cannot see what the browser is doing. Local view streams live screenshots from headless sessions to a browser-based viewer.

```bash
opensteer view                   # Start viewer service, print URL
opensteer view stop              # Stop the viewer service
opensteer view --auto            # Auto-start viewer on every browser launch
opensteer view --no-auto         # Only start viewer when manually requested
```

The viewer is a local web UI that shows:

- Live JPEG stream of the active browser tab
- Tab bar with switching
- Navigation controls (back, forward, reload, URL bar)

Local view is a passive observer — it connects to the browser's existing CDP endpoint. Starting or stopping it has zero impact on running browser sessions.

## Interaction Capture & Replay

Record a trace of browser interactions (clicks, typing, network, DOM changes) and replay them deterministically. Useful for building repeatable test flows or comparing behavior across runs.

```bash
opensteer interaction capture --workspace demo --key "login-flow" --duration 30000
opensteer interaction get <traceId> --workspace demo
opensteer interaction replay <traceId> --workspace demo
opensteer interaction diff <traceA> <traceB> --workspace demo
```

## Artifacts

Commands that use `--persist` save artifacts to the workspace. Read them back with:

```bash
opensteer artifact read <artifactId> --workspace demo
```

Artifacts are created by `extract --persist`, `scripts capture --persist`, `scripts beautify --persist`, and other persist-enabled commands.

## Useful SDK Surface

- `open(url)`, `goto(url, { captureNetwork? })`, `close()`
- `snapshot("action" | "extraction")`
- `click()`, `hover()`, `input()`, `scroll()`
- `extract()`
- `listPages()`, `newPage()`, `activatePage()`, `closePage()`
- `network.query()`, `network.detail()`
- `waitForPage()`
- `cookies()`, `storage()`, `state()`
- `fetch()`
- `evaluate()`, `addInitScript()`
- `route()` — intercept and modify network requests
- `computerExecute()`
- `browser.status()`, `browser.clone()`, `browser.reset()`, `browser.delete()`

## Guardrails

- Snapshot before using element numbers. Snapshot again after UI changes.
- Do not use `evaluate` for API work — use `exec` or `fetch`.
- Do not keep the result as a manual-only workflow if the user needs reusable automation.
- Prefer a small final script over a large framework.
- Close browsers when done. Do not leave headed browser windows open.
- When cloning profiles, verify the source path exists with `opensteer browser discover` first.
