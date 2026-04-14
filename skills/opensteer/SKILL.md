---
name: opensteer
description: "Use when the task needs real browser automation, DOM exploration, browser session state, network capture, or browser-backed request replay with Opensteer. The default pattern is: explore with the CLI first, then write the final code with the SDK."
argument-hint: "[goal]"
---

# Opensteer

Opensteer gives AI agents a real Chromium browser. Use it when the task depends on a live browser session — clicks, forms, extraction, cookies, network capture, or browser-backed fetch.

## Core Workflow

Follow this order. Do not skip steps.

1. **Open** a browser in a workspace.
2. **Snapshot** to see the page and get element numbers.
3. **Interact** using element numbers from the latest snapshot. Every action requires `--persist <key>`.
4. **Re-snapshot** after navigation or UI changes before reusing element numbers.
5. **Extract** data using a template with `--persist <key>`.
6. **Write SDK code** that replays persisted targets — no templates in the SDK, only persist keys.
7. **Close** the browser when done.

```bash
opensteer open https://example.com --workspace demo
opensteer snapshot action --workspace demo
opensteer input 5 "laptop" --workspace demo --press-enter --persist "search input"
opensteer click 7 --workspace demo --persist "search button"
opensteer snapshot extraction --workspace demo
opensteer extract '{"items":[{"title":13,"price":14},{"title":22,"price":23},{"title":31,"price":32}]}' --workspace demo --persist "search results"
```

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({ workspace: "demo", rootDir: process.cwd() });

await opensteer.open("https://example.com");
await opensteer.input({ persist: "search input", text: "laptop", pressEnter: true });
await opensteer.click({ persist: "search button" });
const data = await opensteer.extract({ persist: "search results" });
await opensteer.close();
```

## Setup

```bash
opensteer skills install
```

Only needed once per environment.

## When To Use

- Real browser session needed (clicks, forms, DOM extraction, navigation).
- Cookies, localStorage, sessionStorage, or auth state involved.
- Reverse-engineering a site API from real browser traffic.
- Browser-backed `fetch()` instead of plain Node HTTP.
- Coordinate-based interaction (canvas, WebGL, hard-to-target UI).
- Need to reuse a real user's logged-in browser profile.

If the user wants to manually drive a browser and record the flow, use the `recorder` skill instead.

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

### Persist is required

Every `click`, `hover`, `input`, `scroll`, and `extract` command requires `--persist <key>`. This saves a stable element descriptor so the action is replayable across sessions. Name the key after what the element is:

```bash
opensteer click 7 --workspace demo --persist "search button"
opensteer input 5 "laptop" --workspace demo --press-enter --persist "search input"
opensteer scroll down 500 --workspace demo --persist "page scroll"
```

### Element numbers

Element numbers come from `c="N"` markers in the snapshot HTML. They are only valid for the current snapshot. After navigation or DOM changes, snapshot again to get fresh numbers.

```bash
opensteer snapshot action --workspace demo      # for interactions
opensteer snapshot extraction --workspace demo  # for data extraction
```

Read the full snapshot output. Do not pipe it through `head`, `grep`, or `sed` — filtering destroys the structural context you need to identify which elements belong to the same card.

### Extraction templates

The `extract` command takes a JSON template that describes the fields in one or more items. Opensteer merges the structural pattern across all provided examples and generalizes to every matching item on the page.

**Template format:**

- Bare number: `13` reads text content of element `c="13"`.
- Object with attribute: `{"c": 13, "attr": "href"}` reads an attribute from that element.
- Selector: `{"selector": "#price"}` targets by CSS selector.
- Page source: `{"source": "current_url"}` reads page metadata.

**How many items to include:**

**Lazy — 3 items from 3 different positions (recommended for reusable SDK descriptors).** Give one entry per card for 3 different cards. Opensteer compares the 3 examples, cancels out position noise, and produces a descriptor that matches all similar items. Use this when the goal is a persist key the SDK can replay later.

```bash
opensteer extract '{
  "products": [
    {"title": 47, "price": 51, "url": {"c": 47, "attr": "href"}},
    {"title": 62, "price": 66, "url": {"c": 62, "attr": "href"}},
    {"title": 78, "price": 83, "url": {"c": 78, "attr": "href"}}
  ]
}' --workspace demo --persist "search results"
```

**Eager — all visible items (use when you need the full data immediately).** Include every item visible in the snapshot. This returns all data in one shot from the current session. The descriptor is still saved under `--persist` and can be replayed, but the generalization is weaker than the 3-item approach.

```bash
opensteer extract '{
  "products": [
    {"title": 47, "price": 51, "url": {"c": 47, "attr": "href"}},
    {"title": 62, "price": 66, "url": {"c": 62, "attr": "href"}},
    {"title": 78, "price": 83, "url": {"c": 78, "attr": "href"}},
    ...continue for every visible card...
  ]
}' --workspace demo --persist "search results"
```

**Rule: all fields in each array entry must come from the same card.** Never take a field from card 1 and another field from card 2 within the same entry — that produces a broken descriptor.

Wrong — title from card 1, price from card 2 mixed in the same entry:

```bash
# DO NOT DO THIS — fields across cards in one entry
opensteer extract '{"products":[{"title":47,"price":66}]}' --workspace demo --persist "search results"
```

For non-array fields at the top level, point to the elements directly:

```bash
opensteer extract '{"pageTitle":3,"totalResults":8,"url":{"source":"current_url"}}' \
  --workspace demo --persist "page metadata"
```

### SDK implementation

The SDK `extract()` method replays a previously persisted template. It does not accept inline templates — those belong in the CLI exploration phase.

```ts
const opensteer = new Opensteer({ workspace: "demo", rootDir: process.cwd() });

await opensteer.open("https://example.com");
await opensteer.input({ persist: "search input", text: "laptop", pressEnter: true });
await opensteer.click({ persist: "search button" });
const data = await opensteer.extract({ persist: "search results" });
```

Use `selector` in SDK action code only when a stable CSS selector is cleaner than persist.

## Network Path

Use this when the goal is to find or replay a site API.

### CLI exploration

```bash
opensteer open https://example.com --workspace demo
opensteer goto https://example.com/search --workspace demo --capture-network page-load
opensteer input 5 "laptop" --workspace demo --press-enter --persist "search input" --capture-network search
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
opensteer scripts beautify <artifactId> --workspace demo --persist
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

Use this only when DOM targeting is not enough — canvas, WebGL, or elements that cannot be reached by selector.

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
opensteer tab list --workspace demo
opensteer tab new https://example.com --workspace demo
opensteer tab 2 --workspace demo                 # Switch to tab 2
opensteer tab close 3 --workspace demo
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

| Mode | What it does | Data persists? |
| --- | --- | --- |
| **Persistent** (default) | Browser tied to workspace, survives restarts | Yes |
| **Temporary** | Headless browser in `/tmp`, cleaned up on close | No |
| **Attach** | Connects to an already-running browser via CDP | Depends on that browser |

### Headless vs headed

Browsers launch headless by default. Use `--headless false` to see the browser window:

```bash
opensteer open https://example.com --workspace demo --headless false
```

Use headed mode for debugging or when the user wants to watch. For hands-free automation, keep headless and use `opensteer view` if a human needs to observe.

### Profile cloning

Clone a real user's Chrome profile to start a workspace with their logins already active:

```bash
opensteer browser discover
opensteer browser clone --workspace demo \
  --source-user-data-dir "$HOME/Library/Application Support/Google/Chrome" \
  --source-profile-directory Default
```

This copies cookies, localStorage, extensions, and settings. The source browser does not need to be closed.

### Workspace lifecycle

```bash
opensteer browser status --workspace demo
opensteer browser reset --workspace demo     # Wipe browser data, keep workspace
opensteer browser delete --workspace demo    # Delete workspace entirely
```

## Cloud Mode

Run the browser on Opensteer's cloud infrastructure instead of locally.

```bash
export OPENSTEER_API_KEY=osk_your_key_here
export OPENSTEER_PROVIDER=cloud
```

All CLI commands work the same with `--provider cloud`:

```bash
opensteer open https://example.com --workspace demo --provider cloud
opensteer snapshot action --workspace demo
opensteer click 5 --workspace demo --persist "nav link"
```

Export a local profile to cloud:

```bash
opensteer browser clone --workspace demo \
  --source-user-data-dir "$HOME/Library/Application Support/Google/Chrome" \
  --source-profile-directory Default \
  --provider cloud
```

## Local View

Stream live screenshots from headless sessions to a browser-based viewer.

```bash
opensteer view                   # Start viewer service, print URL
opensteer view stop              # Stop the viewer service
opensteer view --auto            # Auto-start on every browser launch
opensteer view --no-auto         # Only start when manually requested
```

Local view is a passive observer. Starting or stopping it has zero impact on running sessions.

## Interaction Capture & Replay

Record browser interactions and replay them deterministically.

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

## SDK Surface

- `open(url)`, `goto(url, { captureNetwork? })`, `close()`
- `click()`, `hover()`, `input()`, `scroll()`
- `extract({ persist })` — replay-only, no inline templates
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

- Always snapshot before using element numbers. Snapshot again after UI changes.
- Always include `--persist <key>` on click, hover, input, scroll, and extract.
- Extraction templates: use 3 items from 3 different positions for reusable descriptors; use all visible items when you need the full data immediately. All fields in each array entry must come from the same card/row.
- Do not pass templates to the SDK `extract()` — use persist keys only.
- Re-snapshot after navigation before reusing element numbers.
- Do not use `evaluate` for API work — use `exec` or `fetch`.
- If `fetch()` fails with auth errors, check `state()`, `cookies()`, `storage()` first.
- Do not keep the result as a manual-only workflow if the user needs reusable automation.
- Prefer a small final script over a large framework.
- Close browsers when done. Do not leave headed browser windows open.
- When cloning profiles, verify the source path exists with `opensteer browser discover` first.
